#!/usr/bin/env python3
"""Validate Zoho account credentials from a URL|username|password dump, using bdg + CloakBrowser.

Input format (one per line):
    https://accounts.zoho.com/signin|user@example.com|password

For each account the script:
  1. Tries session-cookie injection — if a matching cookie bundle exists under
     --cookies-dir (files named *<username>.json with a "cookies" list of
     {domain,name,value} dicts), it injects them and checks whether the browser
     lands on an authenticated Zoho page. If yes -> status "session".
  2. Otherwise (or if the cookies don't authenticate) it performs the standard
     two-step password login on accounts.zoho.com/signin:
       * fill #login_id (email) -> click "Next"
       * fill #password -> click "Sign in"
     and classifies the result:
       * valid          -> redirected away from /signin to an authenticated page
       * invalid        -> "Incorrect password" / "account cannot be found"
       * needs_2fa      -> password accepted but a 2FA / OTP / verification step blocks
       * not_zoho       -> page isn't the Zoho login form
  3. Captures the page HTML after each attempt (--html-dump) so the selectors
     can be refined later.

Passwords are never echoed to stdout (only usernames / the credentials you pass).

Usage examples
--------------
    export CBPM_API_URL=https://clk.mrme.tech
    export CBPM_API_TOKEN=...          # from ~/.cbpm/config.json if unset

    # Single account
    python3 scripts/check_zoho_creds.py \
        --user hr@acelot.in --pass Acelot@05 --profile w

    # Full dump file, with cookie injection + HTML dumps
    python3 scripts/check_zoho_creds.py \
        --file /Volumes/Untitled/cookies/data/0809/zoho_creds.txt \
        --cookies-dir /Volumes/Untitled/cookies/data/0809/zoho \
        --profile w --delay 2.5 \
        --out scripts/logs/zoho_results.csv \
        --html-dump scripts/logs/zoho_ui_refinement
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
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SIGNIN_URL = "https://accounts.zoho.com/signin"
DEFAULT_PROFILE = "w"
DEFAULT_TIMEOUT = 30
SETTLE_SECONDS = 6

# Failure / status markers (lowercased body text)
ACCOUNT_NOT_FOUND = ("account cannot be found", "account not found", "no account",
                     "sign up for a new account", "invalid email")
INCORRECT_PASSWORD = ("incorrect password", "please try again", "wrong password",
                      "the password you entered is incorrect")
MFA_MARKERS = ("verification code", "enter the verification code", "one time password",
               "two-factor authentication", "authenticator app", "trust this device",
               "backup code", "google authenticator")
BOT_MARKERS = ("captcha", "are you human", "security check", "unusual activity",
               "blocked", "robot", "challenge")

# Successful login usually leaves /signin; these are post-auth destination hosts/paths.
AUTH_SUCCESS_FRAGMENTS = ("accounts.zoho.com/home", "accounts.zoho.com/apiauthtoken",
                          "accounts.zoho.com/account/home", "/home.do",
                          "mail.zoho.com", "crm.zoho.com", "books.zoho.com",
                          "inventory.zoho.com", "people.zoho.com", "mailadmin.zoho.com",
                          "zoho.com/crm", "zoho.com/books", "authpt", "saml")
# A signed-in accounts.zoho.com page (not the login form).
SIGNED_IN_TITLE_MARKERS = ("my account", "account settings", "profile", "welcome",
                           "zoho accounts home")


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
            "body: document.body ? document.body.innerText.trim().slice(0, 1200) : '' })")
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
      const btns = Array.from(document.querySelectorAll('button'))
        .filter(b => b.offsetParent !== null && re.test((b.textContent||'').trim()));
      if (btns.length) {{ btns[0].click(); return 'clicked'; }}
      return 'none';
    }})()"""
    return domeval(expr).strip() == "clicked"


def capture_html(dump_dir, username, tag):
    """Save the current page HTML to dump_dir for later UI refinement.

    Captures a bounded slice of the page HTML (the login form / visible
    structure is what we need to refine selectors), because the bdg CLI
    truncates very large DOM strings and would otherwise break JSON parsing.
    """
    if not dump_dir:
        return ""
    try:
        expr = "(() => { const h = document.documentElement ? document.documentElement.outerHTML : ''; return h.slice(0, 6000); })()"
        raw = run_bdg(["dom", "eval", expr], check=False)
        if raw.startswith("(node:"):
            raw = raw[raw.find("\n") + 1:]
        html = json.loads(raw) if raw.strip() else ""
    except Exception:
        html = ""
    if not html:
        return ""
    os.makedirs(dump_dir, exist_ok=True)
    safe_user = re.sub(r"[^A-Za-z0-9._@-]", "_", username)[:40]
    fname = f"zoho__{safe_user}__{tag}.html"
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
    # Prefer exact suffix match on the username in the filename.
    for f in sorted(glob.glob(os.path.join(cookies_dir, "*.json"))):
        fn = os.path.basename(f).lower()
        base_fn = fn[:-5]  # strip .json
        # Cookie files are named like  <something>_<username>.json
        if base_fn.endswith("_" + base) or base in fn:
            try:
                d = json.load(open(f))
                if d.get("credential", {}).get("username", "").lower() == username.lower():
                    return f
            except Exception:
                continue
    return None


def load_cookies(cookies_dir, username):
    """Return (cookie_list, source_file) for the account, or (None, None)."""
    f = find_cookie_file(cookies_dir, username)
    if not f:
        return None, None
    try:
        d = json.load(open(f))
        cookies = d.get("cookies", [])
        return cookies, f
    except Exception:
        return None, None


def inject_cookies(cookies):
    """Set cookies via CDP. Returns True on success."""
    if not cookies:
        return False
    try:
        run_bdg(["cdp", "Network.setCookies", "--params",
                 json.dumps({"cookies": cookies})], check=False)
        return True
    except Exception:
        return False


def is_authenticated(signals):
    """Return True if the current page indicates a signed-in Zoho session.

    Covers the distinct post-login destinations observed across Zoho's regional
    datacenters (.zoho.com, .zoho.in, ...) and post-login announcement pages:
      * accounts.zoho.<tld>/home[#profile/...]
      * accounts.zoho.<tld>/u/h...
      * accounts.zoho.<tld>/announcement/<something>
      * mailadmin / mail / crm / ... home pages
      * any signed-in page that shows a Sign-Out menu and no login form
    """
    url = (signals.get("url") or "").lower()
    title = (signals.get("title") or "").lower()
    body = (signals.get("body") or "").lower()

    # A login page is definitely not authenticated (check BEFORE success markers).
    if "/signin" in url or "sign in to access" in body:
        return False

    # Regional accounts host: accounts.zoho.com / accounts.zoho.in / ...
    if re.search(r"accounts\.zoho\.[a-z]{2,3}/(home|u/|announcement/|account/)", url):
        return True
    if "/announcement/" in url:
        return True

    if any(m in url for m in AUTH_SUCCESS_FRAGMENTS):
        return True
    if any(m in title for m in SIGNED_IN_TITLE_MARKERS):
        return True
    # Signed-in home pages have a "Sign Out" / user menu rather than a login form.
    if ("sign out" in body or "log out" in body) and "sign in" not in body[:200]:
        return True
    # Org mail / admin home.
    if url.endswith("/home.do") or "/cpanel/home.do" in url:
        return True
    return False


def session_check(username, cookies_dir):
    """Try cookie injection; return (status, detail) or (None, None) if no cookies."""
    cookies, src = load_cookies(cookies_dir, username)
    if cookies is None:
        return None, None
    clear_session()
    inject_cookies(cookies)
    # Navigate to the Zoho accounts home to see if the session holds.
    navigate("https://accounts.zoho.com/", settle=7)
    sig = current_page_signals()
    if is_authenticated(sig):
        return "session", {"cookie_file": os.path.basename(src)}
    return "cookie_fail", {"cookie_file": os.path.basename(src)}


# ---------------------------------------------------------------------------
# Password login
# ---------------------------------------------------------------------------
def has_otp_input():
    """Return True if a visible OTP / verification code input field is present."""
    expr = """(() => {
      const inputs = Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent !== null);
      const otpIds = ['otp_input','verifycode','verification_code','totp','otpcode','vcode','smscode',
                      'emailcheck','backupcode','verifycaptcha'];
      for (const i of inputs) {
        const id = (i.id||'').toLowerCase();
        const name = (i.name||'').toLowerCase();
        const ph = (i.placeholder||'').toLowerCase();
        if (otpIds.includes(id) || /otp|verification|verify code|one.?time|authenticator|backup code/.test(id+' '+name+' '+ph)) return 'yes';
      }
      return 'no';
    })()"""
    return domeval(expr).strip() == "yes"


def classify_result(sig):
    """Classify the post-submit page after attempting a Zoho password login."""
    url = (sig.get("url") or "").lower()
    title = (sig.get("title") or "").lower()
    body = (sig.get("body") or "").lower()

    if is_authenticated(sig):
        return "valid", None

    # Incorrect password / unknown account take precedence (deterministic).
    if any(m in body for m in INCORRECT_PASSWORD):
        return "invalid", "incorrect-password"
    if any(m in body for m in ACCOUNT_NOT_FOUND):
        return "invalid", "account-not-found"

    # MFA / 2FA / OTP: only when an actual verification input is on screen.
    if has_otp_input():
        return "needs_2fa", None

    if any(m in body for m in BOT_MARKERS):
        return "bot", "anti-bot/captcha"

    return "invalid", "unknown"


def password_login(username, password, timeout):
    """Two-step Zoho password login. Returns (status, detail)."""
    clear_session()
    navigate(SIGNIN_URL, settle=5)

    # Step 1: fill email and click Next.
    if not domeval("(() => { const el = document.querySelector('#login_id'); return el ? 'yes' : 'no'; })()").strip() == "yes":
        return "not_zoho", "no login_id field"
    fill_field("#login_id", username)
    time.sleep(1)
    if not click_button(r"^(next|continue)$"):
        # Some pages auto-advance; try pressing Enter as a fallback.
        try:
            run_bdg(["dom", "pressKey", "#login_id", "Enter"], check=False)
        except Exception:
            pass
    time.sleep(4)

    # Step 2: wait for password field and submit.
    deadline = time.time() + timeout
    pass_ready = False
    while time.time() < deadline:
        if domeval("(() => { const p = document.querySelector('#password'); return p && p.offsetParent !== null ? 'yes' : 'no'; })()").strip() == "yes":
            pass_ready = True
            break
        time.sleep(0.8)

    # If the account can't be found, we'll still be on the email step with an error.
    sig_early = current_page_signals()
    if not pass_ready:
        if any(m in (sig_early.get("body") or "").lower() for m in ACCOUNT_NOT_FOUND):
            return "invalid", "account-not-found"
        return "not_zoho", "no password field appeared"

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
    """Load URL|username|password lines."""
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
        description="Validate Zoho account creds via CloakBrowser (cookies first, then password login)"
    )
    parser.add_argument("--user", help="Zoho username (email)")
    parser.add_argument("--pass", dest="password", help="Zoho password")
    parser.add_argument("--file", type=str, help="Dump file of URL|username|password lines")
    parser.add_argument("--cookies-dir", default="", help="Dir with per-account cookie JSON bundles")
    parser.add_argument("--profile", default=DEFAULT_PROFILE, help="CBM profile (default: %(default)s)")
    parser.add_argument("--out", default="", help="Write results to this CSV file")
    parser.add_argument("--html-dump", default="", help="Dir to save each page HTML for later refinement")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="Per-attempt timeout")
    parser.add_argument("--delay", type=float, default=2.0, help="Seconds between credentials")
    parser.add_argument("--no-cookies", action="store_true", help="Skip cookie injection entirely")
    args = parser.parse_args()

    if args.user and args.password:
        creds = [(SIGNIN_URL, args.user, args.password)]
    elif args.file:
        creds = load_creds_file(args.file)
    else:
        parser.error("Provide --user/--pass OR --file")

    if not creds:
        print("No credentials to check.", file=sys.stderr)
        return 1

    print(f"Checking {len(creds)} Zoho account(s) via profile '{args.profile}' ...")

    try:
        run_bdg(["cloak", "connect", args.profile, "about:blank"], json_output=False, check=True)
    except subprocess.CalledProcessError as exc:
        print(f"Could not connect to profile '{args.profile}': {exc}", file=sys.stderr)
        return 1
    time.sleep(4)

    results = []
    for i, (url, username, password) in enumerate(creds, start=1):
        print(f"[{i}/{len(creds)}] {username} ...", flush=True)

        status, detail = None, None
        # 1) Try cookie injection first (unless disabled / no cookies dir).
        if not args.no_cookies and args.cookies_dir:
            status, detail = session_check(username, args.cookies_dir)
            if status == "session":
                capture_html(args.html_dump, username, "session")
                print(f"    -> session (cookies)")
                results.append((username, "session", "cookie-session"))
                time.sleep(args.delay)
                continue
            # cookie_fail / no cookies -> fall through to password login.
            if status == "cookie_fail":
                print(f"    cookies present but session invalid (auth tokens likely truncated)")

        # 2) Password login.
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
        print(f"{status.upper():12} {username}" + (f"  ({reason})" if reason else ""))

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
