#!/usr/bin/env python3
"""
Automate PIA client sign-in through a CBM-managed browser profile,
fetch the subscription overview from the authenticated session, and save it.

Usage:
    pia-verify.py <username> <password> [profile]

Outputs:
    pia-subscription-overview-<username>.json
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

LOGIN_URL = "https://www.privateinternetaccess.com/account/client-sign-in"
OVERVIEW_API = "/api/client-control-panel/subscription-overview?coupon=official-site"


def run_bdg(args: list[str], *, json_output: bool = False, check: bool = True) -> dict | str:
    cmd = ["bdg", *args]
    if json_output:
        cmd.append("--json")
    result = subprocess.run(cmd, capture_output=True, text=True, check=check)
    if json_output:
        return json.loads(result.stdout)
    return result.stdout


def stop_existing_session() -> None:
    subprocess.run(["bdg", "stop"], capture_output=True, text=True)
    subprocess.run(["bdg", "cleanup", "--force"], capture_output=True, text=True)


def wait_for_element(selector: str, *, timeout: float = 20.0, poll: float = 0.5) -> bool:
    """Poll bdg dom query until an element appears."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            data = run_bdg(["dom", "query", selector], json_output=True)
            count = data.get("data", {}).get("count", 0)
            if count and count > 0:
                return True
        except Exception:
            pass
        time.sleep(poll)
    return False


def fill_field(selector: str, value: str) -> None:
    """Fill a form field using the native setter to bypass React clearing."""
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
            json.dumps({"expression": expr, "awaitPromise": False, "returnByValue": True}),
        ],
        json_output=False,
        check=True,
    )
    actual = json.loads(raw)["data"]["result"]["result"]["value"]
    if actual != value:
        raise RuntimeError(f"Field {selector} did not accept value (got: {actual})")


def current_url() -> str:
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
    return json.loads(raw)["data"]["result"]["result"]["value"]


def fetch_overview() -> dict:
    """Fetch the PIA subscription overview inside the authenticated browser session."""
    fetch_expr = f"""
fetch({json.dumps(OVERVIEW_API)}, {{
  credentials: 'include',
  headers: {{ 'Accept': 'application/json' }}
}}).then(r => r.text())
"""
    raw = run_bdg(
        [
            "cdp",
            "Runtime.evaluate",
            "--params",
            json.dumps({"expression": fetch_expr, "awaitPromise": True, "timeout": 30000}),
        ],
        json_output=False,
        check=True,
    )
    return json.loads(raw)["data"]["result"]["result"]["value"]


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify PIA login via bdg and CBM")
    parser.add_argument("username", help="PIA username")
    parser.add_argument("password", help="PIA password")
    parser.add_argument("profile", nargs="?", default="proxy-tz-demo", help="CBM profile (default: proxy-tz-demo)")
    parser.add_argument("--quiet", action="store_true", help="Only print the output path/errors")
    args = parser.parse_args()

    log = lambda msg: None if args.quiet else print(msg)

    log("Stopping any stale bdg session...")
    stop_existing_session()

    log(f"Attaching bdg to CBM profile: {args.profile}")
    run_bdg(["cloak", "connect", args.profile, LOGIN_URL], check=True)

    log("Waiting for login form...")
    if not wait_for_element("input.username", timeout=20):
        print("Timed out waiting for PIA username field", file=sys.stderr)
        return 1

    log("Filling credentials...")
    fill_field("input.username", args.username)
    fill_field("input.password", args.password)

    log("Submitting login...")
    run_bdg(["dom", "click", "button.green_btn.submit"], check=True)
    time.sleep(5)

    url = current_url()
    log(f"Current URL: {url}")

    log("Fetching subscription overview from the browser session...")
    try:
        text = fetch_overview()
        data = json.loads(text)
    except Exception as exc:
        print(f"Login or API fetch failed: {exc}", file=sys.stderr)
        print(f"Current URL: {current_url()}", file=sys.stderr)
        return 1

    if not isinstance(data, dict) or ("subscription" not in data and "subscriptionData" not in data):
        print("Unexpected response shape; login may have failed.", file=sys.stderr)
        out_path = Path(f"pia-overview-raw-{args.username}.json")
        out_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        print(f"Raw response saved to {out_path}", file=sys.stderr)
        return 1

    out_path = Path(f"pia-subscription-overview-{args.username}.json")
    out_path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    subscription = data.get("subscription") or data.get("subscriptionData", {})
    plan = subscription.get("plan_name", subscription.get("plan", "unknown"))
    status = "active" if subscription.get("active") else subscription.get("status", "unknown")
    renewal = subscription.get("next_renewal_date", subscription.get("expirationDate", "unknown"))

    print(out_path)
    log(f"Plan: {plan}")
    log(f"Status: {status}")
    log(f"Next renewal: {renewal}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
