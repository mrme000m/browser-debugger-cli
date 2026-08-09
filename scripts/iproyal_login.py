#!/usr/bin/env python3
"""
Decode an IPRoyal credential token and log in through IPRoyal's dashboard
via bdg + CloakBrowser Manager so the resulting session cookies can be reused.

The token is expected to contain an email/password pair, e.g.:
  ...,email@example.com,password,False,,,...:email@example.com:password

Usage:
    python scripts/iproyal_login.py <token> [profile]

Examples:
    python scripts/iproyal_login.py '...iproyal...:user@example.com:pass'
    python scripts/iproyal_login.py '...iproyal...:user@example.com:pass' proxy-rotating
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import sys
import time
from pathlib import Path

LOGIN_URL = "https://dashboard.iproyal.com/login/"
DASHBOARD_URL = "https://dashboard.iproyal.com/"


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
    """Best-effort base64url/base64 decode of a token segment."""
    raw = part.split("@", 1)[0] if "@" in part else part
    raw = raw.replace("-", "+").replace("_", "/")
    padding = 4 - len(raw) % 4
    if padding != 4:
        raw += "=" * padding
    return base64.b64decode(raw)


def extract_credentials(token: str) -> tuple[str, str]:
    """Pull email and password out of the token string."""
    parts = token.rsplit(":", 2)
    if len(parts) >= 3:
        email, password = parts[-2], parts[-1]
        if "@" in email:
            return email, password

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
    # Match base64-ish segments followed by an Android or iOS package name.
    base64_segments = re.findall(r"([A-Za-z0-9_-]+={0,2})@(?:com\.[a-z0-9._]+\.[a-z]+)", token)
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


def is_challenge_page(signals: dict) -> tuple[bool, str]:
    """Detect hCaptcha / Cloudflare / bot challenge pages."""
    url = signals.get("url", "").lower()
    title = signals.get("title", "").lower()
    text = signals.get("text", "").lower()

    if any(s in url for s in ("captcha", "challenge", "cloudflare", "hcaptcha", "turnstile")):
        return True, f"URL indicates challenge: {url[:120]}"
    if any(t in title for t in ("attention required", "just a moment", "checking your browser", "captcha", "hcaptcha")):
        return True, f"Title indicates challenge: {title[:120]}"
    if any(s in text for s in ("captcha", "hcaptcha", "verify you are human", "challenge")):
        return True, "Page body contains challenge / CAPTCHA markers"
    return False, ""


def save_session(email: str) -> Path:
    try:
        data = run_bdg(["network", "getCookies"], json_output=True)
        cookies = data.get("data", []) if isinstance(data.get("data"), list) else []
    except Exception:
        cookies = []

    session_cookies = {
        c["name"]: c["value"]
        for c in cookies
        if c.get("name") in ("session", "token", "auth", "refresh", "ipr_session", "XSRF-TOKEN", "csrftoken")
        or "iproyal" in c.get("domain", "").lower()
        or "dashboard" in c.get("domain", "").lower()
    }

    out_dir = Path.home() / "bin"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"iproyal-session-{email}.json"
    out_path.write_text(json.dumps({"email": email, "cookies": session_cookies}, indent=2), encoding="utf-8")
    return out_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Decode an IPRoyal token and log in via bdg")
    parser.add_argument("token", help="IPRoyal credential token (wrap in quotes)")
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

    print(f"\nConnecting to CBM profile '{args.profile}' and loading IPRoyal login...")
    stop_existing_session()
    run_bdg(["cloak", "connect", args.profile, LOGIN_URL], check=True)

    time.sleep(3)
    summary = page_summary()
    bot, reason = is_challenge_page(summary)
    if bot:
        print(f"ABORT: bot/CAPTCHA challenge detected ({reason})", file=sys.stderr)
        print(f"Final URL: {summary['url']}", file=sys.stderr)
        return 1

    if not wait_for_element('input[type="email"]', timeout=20):
        print("Timed out waiting for IPRoyal email field", file=sys.stderr)
        print(f"Current URL: {current_url()}", file=sys.stderr)
        return 1

    print("Filling credentials...")
    fill_field('input[type="email"]', email)
    fill_field('input[type="password"]', password)

    print("Submitting login...")
    run_bdg(["dom", "click", 'button[type="submit"]'], check=True)

    time.sleep(6)
    summary = page_summary()
    bot, reason = is_challenge_page(summary)
    if bot:
        print(f"ABORT: bot/CAPTCHA challenge after submit ({reason})", file=sys.stderr)
        print(f"Final URL: {summary['url']}", file=sys.stderr)
        return 1

    print(f"Final URL: {summary['url']}")
    print(f"Title: {summary['title']}")

    # hCaptcha leaves an empty h-captcha-response textarea when not solved.
    hcaptcha_state = run_bdg(
        ["cdp", "Runtime.evaluate", "--params", json.dumps({
            "expression": "(() => { const el = document.querySelector('textarea[name=\\\"h-captcha-response\\\"]'); const sk = document.querySelector('[data-sitekey]'); return { present: !!el, valueLength: el ? el.value.length : 0, sitekey: sk ? sk.dataset.sitekey : null }; })()",
            "awaitPromise": False,
            "returnByValue": True,
        })],
        json_output=False,
        check=False,
    )
    try:
        hc = json.loads(hcaptcha_state)["data"]["result"]["result"]["value"]
    except Exception:
        hc = {"present": False, "valueLength": 0, "sitekey": None}

    if "/login" not in summary["url"] and ("dashboard" in summary["url"] or "iproyal" in summary["url"]):
        out_path = save_session(email)
        print(f"\n>>> Login succeeded for {email}")
        print(f"Session saved to: {out_path}")
        return 0

    if hc.get("present") and hc.get("valueLength", 0) == 0:
        print("\nABORT: IPRoyal requires hCaptcha.")
        if hc.get("sitekey"):
            print(f"Sitekey: {hc['sitekey']}")
        print("Solve the captcha in the visible browser (if any) or use a captcha-solving service, then retry.")
        return 1

    # Still on login page — capture any visible error text.
    print("\nLogin failed, still on the login flow.")
    error_text = summary["text"]
    for line in error_text.splitlines():
        if any(k in line.lower() for k in ("invalid", "incorrect", "wrong", "error", "failed", "try again")):
            print(f"Error text: {line.strip()}")
            break
    return 1


if __name__ == "__main__":
    sys.exit(main())
