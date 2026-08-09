#!/usr/bin/env python3
"""Check which SFTP credentials from a valid-creds file also allow SSH shell access.

Reads a protocol-creds TSV/CSV (columns: protocol://host:port, user, password),
attempts SSH command execution for every SFTP row, and writes two files:
- <out_prefix>_with_ssh.txt   : creds that authed + accepted an SSH channel/command
- <out_prefix>_sftp_only.txt  : creds that authed but rejected the SSH channel
Usage:
    python3 check_sftp_ssh_overlap.py /path/to/valid_creds.txt
    python3 check_sftp_ssh_overlap.py valid.csv --out-prefix sftp_results --concurrency 10
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import socket
import sys
import threading
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

try:
    import socks
except ImportError:
    socks = None  # type: ignore[assignment]

try:
    import paramiko
except ImportError:
    paramiko = None  # type: ignore[assignment]

warnings.filterwarnings("ignore", category=DeprecationWarning)
warnings.filterwarnings("ignore", category=UserWarning)

DEFAULT_SOCKS5 = os.environ.get(
    "SOCKS5_PROXY",
    "socks5://aFZPGm3WgPg4:MGQoj7uVjDrw@nyc.socks.ipvanish.com:1080",
)
DEFAULT_TIMEOUT = 15
URL_RE = re.compile(r"^(?P<proto>\w+)://(?P<host>[^:]+):(?P<port>\d+)$")


def configure_proxy(proxy_url: str | None):
    if not proxy_url:
        return
    from urllib.parse import urlparse

    parsed = urlparse(proxy_url)
    if parsed.scheme not in ("socks5", "socks5h"):
        return
    if socks is None:
        raise RuntimeError("PySocks required: pip install pysocks")
    socks.set_default_proxy(
        socks.SOCKS5,
        parsed.hostname,
        parsed.port or 1080,
        rdns=True,
        username=parsed.username or None,
        password=parsed.password or None,
    )
    socket.socket = socks.socksocket  # type: ignore[misc]


def parse_url_row(row: list[str]) -> dict | None:
    """Parse the legacy TSV format: protocol://host:port  user  password."""
    if len(row) < 3:
        return None
    url, user, password = row[0].strip(), row[1].strip(), row[2].strip()
    if url.startswith("#") or not user or not password:
        return None
    m = URL_RE.match(url)
    if not m:
        return None
    return {
        "protocol": m.group("proto").lower(),
        "host": m.group("host"),
        "port": int(m.group("port")),
        "user": user,
        "password": password,
        "url": url,
    }


def parse_csv_row(row: dict) -> dict | None:
    """Parse the CSV format: protocol,host,port,user,password,..."""
    proto = (row.get("protocol") or "").strip().lower()
    host = (row.get("host") or "").strip()
    port = (row.get("port") or "").strip()
    user = (row.get("user") or "").strip()
    password = (row.get("password") or "").strip()
    if proto not in ("sftp", "ssh") or not host or not port or not user or not password:
        return None
    return {
        "protocol": proto,
        "host": host,
        "port": int(port),
        "user": user,
        "password": password,
        "url": f"{proto}://{host}:{port}",
    }


def probe_ssh(cred: dict, timeout: int) -> str:
    """Return 'ssh' if SSH command exec works, 'sftp_only' if auth works but no shell,
    or raise on failure.
    """
    if not paramiko:
        raise RuntimeError("paramiko not installed")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            cred["host"],
            port=cred["port"],
            username=cred["user"],
            password=cred["password"],
            timeout=timeout,
            banner_timeout=timeout,
            auth_timeout=timeout,
            look_for_keys=False,
            allow_agent=False,
        )
        try:
            # If exec_command succeeds, the server accepted an SSH channel.
            stdin, stdout, stderr = client.exec_command("echo sftp-ssh-check-ok")
            stdout.channel.settimeout(timeout)
            try:
                out = stdout.read(1024).decode("utf-8", "ignore").strip()
            except Exception:
                out = ""
            if not out or "sftp-ssh-check-ok" in out:
                return "ssh"
            return "ssh"
        except Exception as exc:
            err = str(exc).lower()
            # Common messages when an SFTP-only account authed but has no shell.
            if any(
                s in err
                for s in [
                    "no session",
                    "no shell",
                    "subsystem",
                    "sftp",
                    "channel",
                    "connection reset",
                ]
            ):
                return "sftp_only"
            raise
    finally:
        try:
            client.close()
        except Exception:
            pass


def worker(
    cred: dict,
    timeout: int,
    with_ssh_lock: threading.Lock,
    sftp_only_lock: threading.Lock,
    with_ssh_handle,
    sftp_only_handle,
    stats: dict,
    stats_lock: threading.Lock,
) -> None:
    try:
        result = probe_ssh(cred, timeout)
    except Exception as exc:
        result = "error"
        err_name = type(exc).__name__
    else:
        err_name = ""

    line = f"{cred['url']}\t{cred['user']}\t{cred['password']}\n"
    if result == "ssh":
        with with_ssh_lock:
            with_ssh_handle.write(line)
            with_ssh_handle.flush()
        print(f"SSH      {cred['host']}:{cred['port']} {cred['user']}")
    elif result == "sftp_only":
        with sftp_only_lock:
            sftp_only_handle.write(line)
            sftp_only_handle.flush()
        print(f"SFTP-ONLY {cred['host']}:{cred['port']} {cred['user']}")
    else:
        print(f"ERROR    {cred['host']}:{cred['port']} {cred['user']} ({err_name})")

    with stats_lock:
        stats[result] = stats.get(result, 0) + 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Check SFTP creds for overlapping SSH access.")
    ap.add_argument("input", type=Path, help="Valid creds TSV/CSV")
    ap.add_argument("--out-prefix", type=Path, default=None)
    ap.add_argument("--out-dir", type=Path, default=None)
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    ap.add_argument("--proxy", default=DEFAULT_SOCKS5, help="SOCKS5 proxy URL")
    ap.add_argument("--no-proxy", action="store_true", help="Connect directly")
    args = ap.parse_args()

    if paramiko is None:
        print("Error: paramiko is required: pip install paramiko", file=sys.stderr)
        return 2

    if not args.input.is_file():
        print(f"Error: file not found: {args.input}", file=sys.stderr)
        return 2

    if not args.no_proxy:
        configure_proxy(args.proxy)

    out_dir = args.out_dir or args.input.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    if args.out_prefix:
        stem = args.out_prefix.name
    else:
        stem = f"{args.input.stem}_ssh_check"

    with_ssh_path = out_dir / f"{stem}_with_ssh.txt"
    sftp_only_path = out_dir / f"{stem}_sftp_only.txt"

    sftp_rows: list[dict] = []
    with args.input.open("r", encoding="utf-8", errors="ignore", newline="") as f:
        sample = f.read(2048)
        f.seek(0)
        delimiter = "\t" if ("\t" in sample and "," not in sample) else ","

    with args.input.open("r", encoding="utf-8", errors="ignore", newline="") as f:
        reader = csv.reader(f, delimiter=delimiter)
        header = reader.__next__()
        if header and header[0].strip().lower() == "protocol":
            # CSV with separate columns and a header row.
            f.seek(0)
            dict_reader = csv.DictReader(f, delimiter=delimiter)
            for row in dict_reader:
                c = parse_csv_row(row)
                if c:
                    sftp_rows.append(c)
        else:
            f.seek(0)
            reader = csv.reader(f, delimiter=delimiter)
            for row in reader:
                c = parse_url_row(row)
                if c and c["protocol"] in ("sftp", "ssh"):
                    sftp_rows.append(c)

    print(f"SFTP/SSH rows to probe: {len(sftp_rows)}", file=sys.stderr)

    with_ssh = with_ssh_path.open("w", encoding="utf-8")
    sftp_only = sftp_only_path.open("w", encoding="utf-8")
    with_ssh.write("# protocol://host:port\tuser\tpassword\n")
    sftp_only.write("# protocol://host:port\tuser\tpassword\n")

    with_ssh_lock = threading.Lock()
    sftp_only_lock = threading.Lock()
    stats: dict[str, int] = {}
    stats_lock = threading.Lock()

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = [
            pool.submit(
                worker,
                c,
                args.timeout,
                with_ssh_lock,
                sftp_only_lock,
                with_ssh,
                sftp_only,
                stats,
                stats_lock,
            )
            for c in sftp_rows
        ]
        for _ in as_completed(futures):
            pass

    with_ssh.close()
    sftp_only.close()

    print("\n--- summary ---", file=sys.stderr)
    print(f"Probed:     {len(sftp_rows)}", file=sys.stderr)
    print(f"SSH access: {stats.get('ssh', 0)}", file=sys.stderr)
    print(f"SFTP only:  {stats.get('sftp_only', 0)}", file=sys.stderr)
    print(f"Errors:     {stats.get('error', 0)}", file=sys.stderr)
    print(f"SSH:    {with_ssh_path}", file=sys.stderr)
    print(f"SFTP-only: {sftp_only_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
