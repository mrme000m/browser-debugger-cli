# Google Session Cookie Reference

**Session:** `bs00mrme00@gmail.com` (exported 2026-08-03 from CloakBrowser `proxy-tz-demo`)
**Source file:** `/tmp/google_sess_cookies.json` (raw `Network.getAllCookies` shape)
**Contents:** 34 cookies = the complete cookie set of a signed-in Google/Gmail session.

This document explains every cookie in the jar: what it is, its scope, and its
role in authenticating the session. It is reference documentation for the
session-cookie tooling (`package_session.mjs`, `import_session.mjs`,
`find_full_google_session.mjs`).

---

## Quick reference

| # | Cookie | Domain | Primary role |
|---|--------|--------|--------------|
| 1 | `__Host-GAPS` | accounts.google.com | Primary account auth (1st-party) |
| 2 | `__Secure-1PSID` | .google.com | Primary signed-in identity (1st-party) |
| 3 | `GMAIL_AT` | mail.google.com | Gmail auth token (session) |
| 4 | `__Secure-3PSID` | .google.com | Third-party/embedded identity |
| 5 | `ACCOUNT_CHOOSER` | accounts.google.com | Active-account / profile picker |
| 6 | `__Host-GMAIL_SCH_GMS` | mail.google.com | Gmail inbox state flag |
| 7 | `SEARCH_SAMESITE` | .google.com | Search same-site marker |
| 8 | `__Secure-OSID` | mail.google.com | OAuth-issued session id |
| 9 | `__Secure-1PSIDCC` | .google.com | Auth-challenge ("consent") token |
| 10 | `__Secure-1PAPISID` | .google.com | 1st-party identity, API |
| 11 | `APISID` | .google.com | Primary API identity |
| 12 | `LSID` | accounts.google.com | Per-service login state |
| 13 | `__Host-GMAIL_SCH_GMN` | mail.google.com | Gmail Gmail-notifications flag |
| 14 | `__Host-3PLSID` | accounts.google.com | 3rd-party login state |
| 15 | `SIDCC` | .google.com | Auth-challenge (consent) token |
| 16 | `OTZ` | contacts.google.com | Session–timestamp telemetry |
| 17 | `__Secure-3PAPISID` | .google.com | 3rd-party identity, API |
| 18 | `__Secure-1PSIDTS` | .google.com | 1st-party ID timestamp salt |
| 19 | `__Host-1PLSID` | accounts.google.com | 1st-party login state |
| 20 | `SID` | .google.com | Primary signed-in identity |
| 21 | `__Secure-3PSIDCC` | .google.com | Auth-challenge (consent) token |
| 22 | `HSID` | .google.com | Member-identifier (idempotent) |
| 23 | `COMPASS` | mail.google.com | Gmail inner-session token(s) |
| 24 | `SAPISID` | .google.com | Member-identifier, API |
| 25 | `OTZ` | ogs.google.com | Session–timestamp telemetry |
| 26 | `__Host-GMAIL_SCH_GML` | mail.google.com | Gmail Gmail-links flag |
| 27 | `COMPASS` | mail.google.com | Gmail inner-session token(path /u/0) |
| 28 | `SSID` | .google.com | Secondary SID |
| 29 | `__Secure-3PSIDTS` | .google.com | 3rd-party ID timestamp salt |
| 30 | `OTZ` | accounts.google.com | Session–timestamp telemetry |
| 31 | `OSID` | mail.google.com | OAuth-identity service id |
| 32 | `__Secure-STRP` | google.com | Short-term risk/profile token |
| 33 | `NID` | google.com | Non-auth identifier/Prefs |
| 34 | `__Host-GMAIL_SCH` | mail.google.com | Gmail zone/state (session) |

> Note: `COMPASS` (rows 23 & 27) and `OTZ` (rows 16, 25, 30) appear more than
> once because the same name exists on different **domains/paths** — this is why
> the "34 cookies" is really **33 unique `(name, domain)` pairs**.

---

## The four auth families

Google splits its session cookies into these groups. A *working* login needs
the whole set — an incomplete set is why sessions sometimes "don't hold".

### 1. Primary auth (`SID` / `SSID` / `LSID` …)
The core login. `SID` + `SSID` (+ a few encrypted salts) prove who you are.
`1PSID`/`3PSID` are the modern secure (`__Secure-`/`__Host-`) replacements.

### 2. API identity (`SAPISID` / `APISID` / `HSID` / `1PAPISID` / `3PAPISID`)
Identifiers used by Google's AJAX/API endpoints. `HSID` is a stable per-account
member id; the `*APISID` values are often identical across 1P/3P.

### 3. Consent / challenge (`*PSIDCC`, `*PSIDTS`)
`CC` = "challenge/consent cookie". `TS` carries an
embedded timestamp. These fine-tune how much the account is trusted.

### 4. Service & telemetry (`OSID` / `LSID` / `GAPS` / `OTZ` / `NID`)
Per-service login (`LSID`), OAauth identity (`OSID`/`__Secure-OSID`),
per-application account (`GAPS`), and non-session preference/telemetry
(`NID`, `OTZ`).

---

## Cookie-by-cookie detail

### Core authentication

**`__Host-GAPS`** (accounts.google.com, `/`, httpOnly+secure) — Primary
per-account auth token. The `__Host-` prefix (must be Secure, HostOnly, path `/`)
is the modern hardened single-token replacement for the older `SID` family.
Without it the account isn't signed in at the accounts layer.

**`SID`** (.google.com, not httpOnly, not secure) — The classic logged-in
token for the **`.google.com`** cookie scope. Alongside `HSID`/`SSID` forms the
legacy auth trio still used by many Google services.

**`SSID`** (.google.com, httpOnly, secure) — The rotated session variant of
`SID`. Present whenever an account is signed in; a mismatched/absent `SSID`
forces re-login.

**`__Secure-1PSID`** (.google.com, httpOnly, secure) — First-party signed-in
identity, hardened. This + `__Secure-3PSID` are the modern primary auth.

**`__Secure-3PSID`** (.google.com, httpOnly, secure, `SameSite=None`) — the
third-party (embedded/embedded-or-embedded) signed-in identity. `SameSite=None`
so it's sent on cross-site frames (e.g. YouTube embeds, Google-Fonts).

**`__Host-1PLSID` / `__Host-3PLSID`** (both accounts.google.com, httpOnly,
secure) — First/third-party *login-state* variants tied to service scopes
(here: `o.mail.google.com|s.BD|s.youtube`).

### Identity for API calls

**`HSID`** (.google.com, httpOnly) — stable per-account member identifier,
used across most Google JSON APIs. Shorter value than `SID`.

**`SAPISID` / `APISID`** (.google.com) — the * authenticated* API identifiers
sent on `gws_rd` / the OAuth-ish endpoints. `SAPISID` is the newer one; `APISID`
its legacy pair. Values match `__Secure-1PAPISID`/`__Secure-3PAPISID`
(just scoped for first/third party).

**`__Secure-1PAPISID` / `__Secure-3PAPISID`** (.google.com, secure) — Same
identity as `SAPISID`, split into 1P/3P hardened variants.

### Consent / challenge cookies

**`SIDCC` / `__Secure-1PSIDCC` / `__Secure-3PSIDCC`** — "consent / challenge" tokens

**`__Secure-1PSIDTS` / `__Secure-3PSIDTS`** — timestamp salt that the auth
server checks to validate the *PSID. Rotates on each login.

### Service / OAuth identity

**`__Secure-OSID`** (mail.google.com, httpOnly, secure, SameSite=None) —
OAuth service identity for Google's token endpoints on Gmail.

**`OSID`** (mail.google.com, httpOnly, secure) — the matching (non-secure-cookie
path) OAuth service id, used alongside its `__Secure-` twin.

**`LSID` / `__Host-*LSID`** (accounts.google.com, httpOnly, secure) —
"login session id" scoped per service (`o.mail.google.com|s.BD|s.youtube`).
the typical value for an account authenticated into mail + YouTube.

### Applications (Gmail / mail)

**`GMAIL_AT`** (mail.google.com `/mail/u/0`, `session=true`, secure, not
httpOnly) — Gmail's authorization token, stored for the concrete `u/0` mailbox.

**`COMPASS`** (mail.google.com `/` and `/mail/u/0`, httpOnly, secure,
SameSite=None) — a compact binary blob (`appsfrontendserver=`, `gmail_ps=`) that
tracks Gmail's internal session state (which UI variant, server session id).
Appears **twice** — once per server type/path — the reason your "34" is
actually 33 unique pairs.

**`__Host-GMAIL_SCH`** (`mail.google.com`, `/`, session) — Gmail "session cached
hash".  Value `nsl` = "no service lock". Session-lived.

**`__Host-GMAIL_SCH_GML` / `_GMN` / `_GMS`** (mail.google.com, httpOnly,
secure) — sub-flag cookies for GMAIL_SCH (Lax = links, MN = notifications,
S = ? ). All `1`.

### Non-session / telemetry

**`SEARCH_SAMESITE`** (.google.com, not secure, `Strict`) — marker that the
search intra-same-site framing is consistent. Trivial.

**`NID`** (.google.com, httpOnly, secure, SameSiteNone) — a long-lived
non-auth identifier/preferences cookie (language, safe-search) used by
`*.google.com` search/ads. Big value (679 B).

**`OTZ`** (accounts / contacts / ogs, all secure) — session-telemetry /
timestamp cookie Google uses to watermark the browser/session. Not auth.

**`ACCOUNT_CHOOSER`** (accounts.google.com, httpOnly, secure) — remembers the
currently-selected profile in the account picker so you auto-resume the right
account without re-choosing.

**`__Secure-STRP`** (.google.com, sameSite=Strict, not httpOnly) — short-lived
"session/risk" token (anti-account-takeover hardening). Note its strict
Single.

---

## What makes a session "hold"?

For **`import_session.mjs` to land a logged-in state** (page title = your
inbox), these cookies are required:

- **Primary auth:** `SID`, `SSID`, `__Secure-1PSID`, `__Secure-3PSID`
- **Thresholded**: `HSID`, `SAPISID`, `APISID`
- **Service**: `__Secure-OSID`, `OSID`, `LSID`, `__Host-GAPS`
- **Gmail**: `GMAIL_AT`, `COMPASS`

If all four families are injected with correct `domain`/`path`/`httpOnly`/
`secure`, Google treats the browser as the logged-in account.

---

## Implementation notes

- The **34 vs 33** wrinkle: `COMPASS` and `OTZ` are multi-path/multi-domain,
  so a `(name, domain)` key is what the scripts compare — both the scanner
  (`find_full_google_session.mjs`) and the importer (`import_session.mjs`)
  embed the **33-pair** reference for this exact reason.
- `package_session.mjs` already flags Google-scoped cookies `httpOnly`/
  `secure` — this matches the real cookie attributes above.
- `GMAIL_AT` and `__Host-GMAIL_SCH` are `session`-lived (`expires=-1`). They
  survive a CDP `Network.setCookies` import (CDP only skips `-1` when
  constructing the params), but a browser restart on Chrome will drop them —
  the durable auth is carried by the `SID`/`1PSID` family which carry expiry.

---

## Security

- This is **one signed-in account's cookie jar** — treat it like a credential.
- A session is bound to the account + (loosely) device/IP. Importing it from
  a different exit region than it was captured on can trigger Google's
  "Verify your info" / re-auth challenge (Google salts the ID tokens).
- Only perform the `--url` confirm step (landing on the account) for accounts
  you are authorised to act for.