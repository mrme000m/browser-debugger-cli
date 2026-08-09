# Session packaging & import scripts

Standalone `.mjs` helpers for moving a **complete browser session** between
profiles as a single file. They bridge the on-disk Netscape cookie dump format
(`Cookies/*.txt`) and the bdg session store that `bdg session import/validate`
already understands.

> Boundary: these scripts **serialize to/from disk and inject cookies**. They do
> not themselves authenticate anyone. Use them with your own/authorised
> sessions — a cookie jar is only valid for the account(s) it was captured from.

## Pipeline

```
profile folder (Netscape)         ──package──▶  one JSON session file
(full session: 34 Google pairs)                            │
                                                            ▼
   injected live browser  ◀──import──  (bdg cdp Network.setCookies)
```

## `scripts/find_full_google_session.mjs` — find valid profiles

Reports which profile folders contain a **complete** Google session (all
`33 (name, domain)` pairs = the 34 cookies; `COMPASS` appears twice).

```
node scripts/find_full_google_session.mjs <dumpRoot>
node scripts/find_full_google_session.mjs <dumpRoot> --country <CC>
node scripts/find_full_google_session.mjs <dumpRoot> --json
```

- Recursively walks the tree, checks every folder with a `Cookies/` subdir.
- FULL = all 33 reference pairs present; PARTIAL lists coverage and missing keys.
- `--country <CC>` filters to profiles whose 2-letter code directly after ` - `
  matches (e.g. `--country MA` for Morocco).
- The FULL list shows the 5 most-recent paths (by folder timestamp); `--json` returns all.
## `scripts/package_session.mjs` — pack one profile to a file

```
node scripts/package_session.mjs "<profileDir>" <name> [-o outfile] [--force]
```

- Reads `Cookies/*.txt` (Netscape), dedupes by `domain|path|name`, tags
  Google-scoped cookies `httpOnly`/`secure`.
- Folds a `GoogleAccounts/*.txt` token into an `accountToken` field.
- Default outfile `~/.bdg/sessions/<name>.json` (honours `BDG_SESSION_DIR`),
  refuses overwrite unless `--force`.
- Output is the bdg `StoredSession` shape, drop-in for `bdg session import`.

## `scripts/import_session.mjs` — inject a packaged file into current profile

```
node scripts/import_session.mjs <session.json> [--url <url>]
```

- Reads a `StoredSession` JSON (file path, not store name).
- Injects cookies via `bdg cdp Network.setCookies` (the same tested IPC path as
  `bdg session import`), chunked to keep the shell arg small.
- Optional `--url` navigates and reads `document.title` to confirm the session
  holds (e.g. `--url https://mail.google.com`).

## Equivalent bdg built-ins

```
bdg session list | validate | import <name>    # store-based
bdg session scan <dir>                          # loose dump scan
bdg session load-from <dir> --profile <sub>     # inject a profile's jar
```

The standalone scripts are convenient when you want to point directly at a file
path / dump folder without using the named store.

---

## Workflow

```bash
# 1. Find a complete session
node scripts/find_full_google_session.mjs "/Volumes/Untitled/cookies/data/0802"

# 2. Package one profile to a single file
node scripts/package_session.mjs \
  "/Volumes/.../RU[I4O1Y1WO-...][2026-05-31T23_58_30]" myacct -o /tmp/myacct.json

# 3. (optional) sanity-check the file
python3 -c "import json;s=json.load(open('/tmp/myacct.json'));print(len(s['cookies']),'cookies')"

# 4. On a geo/proxy-matched profile, inject
node scripts/import_session.mjs /tmp/myacct.json --url https://mail.google.com
```

## Boundary

Injection + navigation on a live profile establishes authenticated access as
the jar's owner. Only do step 4 for domains/accounts you're authorised to act
for. The scripts themselves are passive tooling.