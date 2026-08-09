#!/usr/bin/env python3
"""
Decode a TunnelBear credential token and log in through TunnelBear's web UI
via bdg + CloakBrowser Manager so the resulting session cookies can be reused.

The token is expected to contain an email/password pair, e.g.:
  ...@com.tunnelbear.android/,,email@example.com,password,False,,,...:email@example.com:password

Usage:
    python scripts/tunnelbear_login.py <token> [profile]

Examples:
    python scripts/tunnelbear_login.py '...tunnelbear...:user@example.com:pass'
    python scripts/tunnelbear_login.py '...tunnelbear...:user@example.com:pass' proxy-rotating
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

LOGIN_URL = "https://www.tunnelbear.com/account/login"
OVERVIEW_URL = "https://www.tunnelbear.com/account/overview"


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


def decode_base64_part(part: str) -> bytes:
    """Best-effort base64url/base64 decode of a TunnelBear token segment."""
    raw = part.split("@", 1)[0] if "@" in part else part
    raw = raw.replace("-", "+").replace("_", "/")
    padding = 4 - len(raw) % 4
    if padding != 4:
        raw += "=" * padding
    return base64.b64decode(raw)


def extract_credentials(token: str) -> tuple[str, str]:
    """Pull email and password out of the token string."""
    # Try the trailing ':email:password' form first.
    parts = token.rsplit(":", 2)
    if len(parts) >= 3:
        email, password = parts[-2], parts[-1]
        if "@" in email:
            return email, password

    # Fall back to CSV-style fields.
    for delimiter in (",,", ","):
        fields = token.split(delimiter)
        for i, field in enumerate(fields):
            if re.match(r"[^\s:,]+@[^\s:,]+\.[^\s:,]+", field):
                email = field
                password = fields[i + 1] if i + 1 < len(fields) else ""
                return email, password

    raise ValueError("Could not locate email/password in the provided token")


def parse_token(token: str) -> dict:
    """Return a structured view of the token without exposing secrets."""
    email, password = extract_credentials(token)
    base64_segments = re.findall(r"([A-Za-z0-9_-]+={0,2})@(?:com\.tunnelbear\.[a-z]+)", token)
    decoded_segments = []
    for seg in base64_segments:
        try:
            data = decode_base64_part(seg)
            decoded_segments.append({
                "length": len(data),
                "hex_preview": data[:32].hex(),
                "is_printable": all(32 <= b < 127 for b in data[:64]),
            })
        except Exception:
            decoded_segments.append({"error": "not valid base64"})

    return {
        "email": email,
        "password_length": len(password),
        "base64_segments_decoded": decoded_segments,
    }


def wait_for_element(selector: str, *, timeout: float = 20.0, poll: float = 0.5) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            data = run_bdg(["dom", "query", selector], json_output=True)
            if data.get("data", {}).get("count", 0):
                return True
        except Exception:
            pass
        time.sleep(poll)
    return False


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


def wait_for_url_change(initial_url: str, timeout: float = 10.0, poll: float = 0.5) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        current = current_url()
        if current != initial_url:
            return current
        time.sleep(poll)
    return current_url()


def current_url() -> str:
    raw = run_bdg(
        ["cdp", "Runtime.evaluate", "--params", json.dumps({"expression": "window.location.href", "awaitPromise": False, "returnByValue": True})],
        json_output=False,
    )
    return json.loads(raw)["data"]["result"]["result"]["value"]


def page_summary() -> dict:
    raw = run_bdg(
        ["cdp", "Runtime.evaluate", "--params", json.dumps({
            "expression": "({ url: window.location.href, title: document.title, text: document.body ? document.body.innerText.trim().slice(0, 500) : '' })",
            "awaitPromise": False,
            "returnByValue": True,
        })],
        json_output=False,
    )
    return json.loads(raw)["data"]["result"]["result"]["value"]


def get_cookies() -> list[dict]:
    try:
        data = run_bdg(["network", "getCookies"], json_output=True)
        cookies = data.get("data", [])
        return cookies if isinstance(cookies, list) else []
    except Exception:
        return []


def save_session(email: str) -> Path:
    cookies = get_cookies()
    session_cookies = {}
    xsrf_token = ""
    session_id = ""
    for cookie in cookies:
        name = cookie.get("name", "")
        if name in ("PLAY_SESSION", "XSRF-TOKEN", "TB_SESSION"):
            session_cookies[name] = cookie.get("value", "")
        if name == "XSRF-TOKEN":
            xsrf_token = cookie.get("value", "")
        if name == "PLAY_SESSION":
            # PLAY_SESSION looks like: sig-___AT=<token>&tbcsrf=<token>&...&sessionid=<id>
            m = re.search(r"sessionid=([^&]+)", cookie.get("value", ""))
            if m:
                session_id = urllib.parse.unquote(m.group(1))

    out = {
        "email": email,
        "cookies": session_cookies,
        "xsrf_token": xsrf_token,
        "session_id": session_id,
    }
    out_dir = Path.home() / "bin"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"tunnelbear-session-{email}.json"
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    return out_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Decode a TunnelBear token and log in via bdg")
    parser.add_argument("token", help="TunnelBear credential token (wrap in quotes)")
    parser.add_argument("profile", nargs="?", default="proxy-rotating", help="CBM profile (default: proxy-rotating)")
    args = parser.parse_args()

    try:
        parsed = parse_token(args.token)
    except ValueError as exc:
        print(f"Token parse error: {exc}", file=sys.stderr)
        return 1

    email = parsed["email"]
    password = args.token.rsplit(":", 1)[-1]

    print(f"Parsed email: {email}")
    print(f"Base64 segments decoded: {len(parsed['base64_segments_decoded'])}")
    for idx, seg in enumerate(parsed["base64_segments_decoded"], start=1):
        print(f"  segment {idx}: {seg}")

    print(f"\nConnecting to CBM profile '{args.profile}' and loading TunnelBear login...")
    stop_existing_session()
    run_bdg(["cloak", "connect", args.profile, LOGIN_URL], check=True)

    current = current_url()
    if "/account/overview" in current or "/account" in current:
        print("Already logged in (profile has an active TunnelBear session).")
    elif not wait_for_element("#email", timeout=20):
        print("Timed out waiting for TunnelBear login form", file=sys.stderr)
        return 1
    else:
        print("Filling credentials...")
        fill_field("#email", email)
        fill_field("#password", password)

        print("Submitting login...")
        run_bdg(["dom", "click", ".submit-btn"], check=True)

        time.sleep(6)
        initial = LOGIN_URL
        wait_for_url_change(initial, timeout=10)

    summary = page_summary()
    print(f"Final URL: {summary['url']}")
    print(f"Title: {summary['title']}")

    if "/account/overview" in summary["url"] or "/account" in summary["url"]:
        out_path = save_session(email)
        print(f"\n>>> Login succeeded for {email}")
        print(f"Session saved to: {out_path}")
        # Print a short usage snippet from the page text
        for line in summary["text"].splitlines():
            if "MB" in line or "GB" in line or "remaining" in line.lower():
                print(f"Account status: {line.strip()}")
                break
        return 0

    print("\nLogin failed or additional challenge required.")
    print(f"Page text: {summary['text'][:300]}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
