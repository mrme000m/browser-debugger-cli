# gtoken — Google OAuth refresh-token probes

Tools for probing what a compromised `GoogleAccounts/*.txt` / `GgAts/*.txt` refresh token (Chrome sync client `77185425430`) can access.

## Token file format

`{"refresh_token": "1//...", "gaia": "...", "source": "..."}` — see the scanner output or construct from the dump line (`1//<token>:<gaia>`).

## Usage

All scripts take the token JSON as `argv[2]`, defaulting to `/tmp/cc_alive.json` (Kartik) or `/tmp/alive_google_token.json` (Pratham) where relevant.

```bash
node scope_probe.mjs <token.json>   # maps which OAuth scopes the account granted (MINTABLE vs restricted_client)
node identify.cjs <token.json>      # account identity: email, name, verified
node api_probe.mjs <token.json>     # live API smoke test: Drive, Calendar, Contacts, Tasks, Docs, Classroom
node drive_probe.mjs <token.json>   # Drive inventory: file listing, sizes, types, read-content test
node gmail_check.mjs                # both tokens: mail.google.com / gmail.readonly / gmail.modify mint status
node gmail_api.mjs                  # both tokens: Gmail API profile + inbox sample
node gmail_api2.mjs <token.json>    # single token: tokeninfo scopes + Gmail API error detail
node pratham_probe.mjs <token.json> # scope map for a single token (Pratham-style)
node mint_scope.cjs <token.json>    # mint one scope from argv (SCOPE env) and print result
```

## Known results (2026-08)

- Mintable: drive, drive.file, calendar, contacts, tasks, keep, documents, classroom.courses.readonly, webhistory, gmail.modify, chromesync, userinfo.email/profile, accounts/OAuthLogin
- restricted_client: mail.google.com, gmail.readonly, drive.appdata, youtube, photos, drive.metadata.readonly, books, fitness, forms, profile-plus, wallet
- Gmail API: 403 `SERVICE_DISABLED` in project `77185425430` (Google's own Chrome-client project — cannot enable)
- Chrome sync endpoint (`clients4.google.com/chrome-sync`): 403 client-gate regardless of token

## Related

- Scanner: `../check_google_tokens.mjs` (bulk `1//` sweeper, scans `GoogleAccounts/` + `GgAts/`)
- Sync endpoint probe: `../chromesync_probe.mjs`
