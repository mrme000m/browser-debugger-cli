#!/usr/bin/env python3
"""
Automate Yahoo Mail login through a CloakBrowser-managed US proxy profile.

This script drives bdg (browser-debugger-cli) to:
1. Attach to a CBM profile that routes through a US proxy.
2. Load https://mail.yahoo.com/.
3. Enter the username, proceed to the password step, enter password, and sign in.
4. Print the final URL so the caller can verify success.

Usage:
    python scripts/yahoo_login.py <username> <password> [profile]

Examples:
    python scripts/yahoo_login.py karenkhansen@yahoo.com 'MyP@ssw0rd!'
    python scripts/yahoo_login.py karenkhansen@yahoo.com 'MyP@ssw0rd!' proxy-tz-demo

The CBM profile is expected to be already configured (see docs/cloak-integration.md)
and usually defaults to a profile named `proxy-tz-demo` with US proxy routing.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time

BDG = "bdg"
DEFAULT_PROFILE = "proxy-rotating"  # IPVanish Dallas, US (timezone America/New_York)
MAIL_URL = "https://mail.yahoo.com/"


def run_bdg(args: list[str], *, json_output: bool = False, check: bool = True) -> dict | str:
    """Run a bdg CLI command and return either parsed JSON or plain text."""
    cmd = [BDG, *args]
    if json_output:
        cmd.append("--json")

    result = subprocess.run(cmd, capture_output=True, text=True, check=check)
    if json_output:
        return json.loads(result.stdout)
    return result.stdout


def stop_existing_session() -> None:
    """Best-effort cleanup so we can start a fresh session."""
    subprocess.run([BDG, "stop"], capture_output=True, text=True)
    subprocess.run([BDG, "cleanup", "--force"], capture_output=True, text=True)


def wait_for_element(selector: str, *, timeout: float = 30.0, poll: float = 0.5) -> bool:
    """Poll bdg dom query until an element appears."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            data = run_bdg(["dom", "query", selector], json_output=True)
            count = data.get("data", {}).get("count", 0)
            if count and count > 0:
                return True
        except Exception:
            # The page may be mid-navigation; retry silently
            pass
        time.sleep(poll)
    return False


def fill_field(selector: str, value: str) -> None:
    """Fill a React/controlled form field using the native setter to bypass clearing."""
    expr = f"""
(() => {{
  const el = document.querySelector({json.dumps(selector)});
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
    raw = run_bdg(
        [
            "cdp",
            "Runtime.evaluate",
            "--params",
            json.dumps({
                "expression": expr,
                "awaitPromise": False,
                "returnByValue": True,
            }),
        ],
        json_output=False,
        check=True,
    )
    actual = json.loads(raw)["data"]["result"]["result"]["value"]
    if actual != value:
        raise RuntimeError(f"Field {selector} did not accept value (got: {actual})")


def current_url() -> str:
    """Return the current page URL from the browser session."""
    raw = run_bdg(
        [
            "cdp",
            "Runtime.evaluate",
            "--params",
            json.dumps({
                "expression": "window.location.href",
                "awaitPromise": False,
                "returnByValue": True,
            }),
        ],
        json_output=False,
    )
    data = json.loads(raw)
    return data.get("data", {}).get("result", {}).get("result", {}).get("value", "")


def page_error_text() -> str:
    """Return the most prominent error text on the current page."""
    raw = run_bdg(
        [
            "cdp",
            "Runtime.evaluate",
            "--params",
            json.dumps({
                "expression": "document.body ? document.body.innerText.trim().slice(0, 300) : ''",
                "awaitPromise": False,
                "returnByValue": True,
            }),
        ],
        json_output=False,
        check=False,
    )
    try:
        return json.loads(raw)["data"]["result"]["result"]["value"]
    except Exception:
        return ""


def login_yahoo(username: str, password: str, profile: str) -> None:
    """Run the full Yahoo Mail login flow."""
    print("Stopping any stale bdg session...")
    stop_existing_session()

    print(f"Connecting to CBM profile '{profile}' and loading {MAIL_URL}...")
    # cloak connect starts the bdg session and navigates to the URL.
    run_bdg(["cloak", "connect", profile, MAIL_URL], check=True)
    time.sleep(5)

    if wait_for_element("a[href*='login.yahoo.com']", timeout=10):
        print("Landing page detected; clicking Sign in...")
        run_bdg(["dom", "click", "a[href*='login.yahoo.com']"], check=True)
        time.sleep(2)

    if not wait_for_element("#username", timeout=15):
        raise RuntimeError("Yahoo username field did not appear")

    print("Filling username...")
    fill_field("#username", username)

    print("Proceeding to password step...")
    run_bdg(["dom", "click", 'button[type="submit"]'], check=True)

    # Yahoo briefly shows a spinner on the Next button while it validates
    # the username / looks up the account. Wait for the password form.
    print("Waiting for password form...")
    time.sleep(2)
    if not wait_for_element("#login-passwd", timeout=30):
        raise RuntimeError("Yahoo password field did not appear")

    print("Filling password...")
    fill_field("#login-passwd", password)

    print("Submitting login...")
    run_bdg(["dom", "click", 'button[type="submit"]'], check=True)

    # Wait for the password validate XHR to finish and the redirect to settle.
    print("Waiting for Yahoo login response...")
    time.sleep(6)

    url = current_url()
    print(f"Final URL: {url}")

    # Network-level debug of the password validate API.
    print("Inspecting network response for /account/challenge/password/validate ...")
    try:
        net_list = run_bdg(["network", "list"], json_output=True)
        reqs = net_list.get("data", []) if isinstance(net_list.get("data"), list) else net_list.get("data", {}).get("requests", [])
        validate_req = next(
            (r for r in reqs if r.get("method") == "POST" and "/account/challenge/password/validate" in r.get("url", "")),
            None,
        )
        if validate_req:
            detail = run_bdg(["details", "network", validate_req["requestId"]], json_output=True)
            body = detail.get("data", {}).get("item", {}).get("responseBody", "")
            print(f"Validate response body: {body}")
        else:
            print("No password validate request found in network log.")
    except Exception as exc:
        print(f"Could not extract network response: {exc}")

    print("Page error text:")
    print(page_error_text() or "(none)")

    if "mail.yahoo.com/n/" in url:
        print("Login appears successful.")
        return
    if "login.yahoo.com" in url:
        print("Login failed or requires additional challenge — still on Yahoo login flow.", file=sys.stderr)
        sys.exit(1)

    print("Unexpected final URL; session is still active for manual inspection.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Automate Yahoo Mail login via bdg with a US proxy profile")
    parser.add_argument("username", help="Yahoo username/email")
    parser.add_argument("password", help="Yahoo password")
    parser.add_argument("profile", nargs="?", default=DEFAULT_PROFILE, help=f"CBM profile to use (default: {DEFAULT_PROFILE})")
    args = parser.parse_args()

    try:
        login_yahoo(args.username, args.password, args.profile)
        return 0
    except subprocess.CalledProcessError as exc:
        print(f"bdg command failed: {exc}", file=sys.stderr)
        print(exc.stderr or exc.stdout, file=sys.stderr)
        return exc.returncode
    except RuntimeError as exc:
        print(f"Automation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
