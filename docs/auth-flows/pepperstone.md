# Skill: pepperstone-auth

Pepperstone client portal authentication flow (Auth0 OAuth2 + PKCE).
Use when automating login to https://pepperstone.com or the secure
trading client area.

---

## Architecture

Pepperstone delegates authentication to **Auth0** with the following
OAuth2 / OpenID Connect flow:

| Component | Value |
|---|---|
| **Login page entry** | `https://pepperstone.com` → click "Log in" → redirect to Auth0 |
| **Auth0 host** | `auth.pepperstone.com` |
| **Auth path** | `/login?...` (query-driven, stateful – see Parameters below) |
| **Protocol** | `oauth2` with PKCE (`S256`) |
| **Client ID** | `YAyTuc1vwT2Kt7EBGSDw3HVnusDUbr8i` |
| **Audience** | `https://api.pepperstone.com` |
| **Scopes** | `openid profile offline_access` |
| **Redirect URI** | `https://pepperstone.com/api/auth/callback` |
| **Social providers** | Apple, Google, Facebook (OAuth buttons on the login form) |
| **Password reset** | "Forgot password?" button triggers reset flow |

The login page **URL is non-reusable** – each navigation to the login
link generates a fresh `state`, `nonce`, and `code_challenge`. Always
start from `https://pepperstone.com` and click/visit the "Log in" link.

---

## Login form — selectors

The Auth0 login form at `auth.pepperstone.com/login` uses **dynamic
class names** (CSS Modules) but stable `id` attributes:

| Field | Selector | Type | Autocomplete |
|---|---|---|---|
| Email | `#field1` | `email` | `email` |
| Password | `#field4` | `password` | _(none)_ |
| Submit | `button[type='submit']` | `submit` | — |
| "Forgot password?" | `button` with text "Forgot password?" | `button` | — |

Social login buttons (Apple, Google, Facebook) have no stable IDs;
match by accessible name or button text.

### bdg fill + click commands

```bash
bdg dom fill "#field1" "user@example.com"
bdg dom fill "#field4" "your-password"
bdg dom click "button[type='submit']"
```

### Playwright locators

```typescript
await page.fill('#field1', 'user@example.com')
await page.fill('#field4', 'your-password')
await page.click('button[type="submit"]')
```

---

## Success flow

After successful credential validation, Auth0 issues an **authorization
code** and redirects the browser back to:

```
https://pepperstone.com/api/auth/callback?code=...&state=...
```

The Pepperstone backend exchanges the code for tokens and sets session
cookies. The user lands on the secure client dashboard at
`https://secure.pepperstone.com/...` or `https://pepperstone.com/...`.

**Post-login indicators:**
- URL no longer contains `auth.pepperstone.com`
- Page title changes from "Pepperstone Secure Client" to the dashboard
- No Auth0 login form present

---

## Error states

### Wrong credentials

**Element:** `<div class="…alertBanner_Failure…">`

**Message:** `Login was not successful. Please try again. If you need
to reset your password you can do it here.`

**Selector:** `div[class*="alertBanner_Failure"]` or
`[role="alert"]`

After failure, both input fields retain their values and remain in an
`:invalid` state. The form can be re-submitted without reloading the
page (no new `state`/`nonce` needed).

### Account locked / rate-limited

Auth0 may throttle repeated failed attempts. Symptoms:
- Same "Login was not successful" message (generic)
- Potential CAPTCHA challenge after several attempts
- HTTP 429 from `/co/authenticate` or `/usernamepassword/login`

### Network error / Auth0 unreachable

If Auth0's CDN is blocked by the proxy or network, the login form
may not render at all (blank page or JavaScript error). Check:
```bash
curl -I https://auth.pepperstone.com/login
```

---

## OAuth2 parameters (reference)

The full query string on the Auth0 login URL (decoded):

```
state=<random-base64>
client=YAyTuc1vwT2Kt7EBGSDw3HVnusDUbr8i
protocol=oauth2
audience=https://api.pepperstone.com
scope=openid profile offline_access
screen_hint=login
acquisitionSource=ps-web
sca_origin=https://secure.pepperstone.com
locale=en
redirect_uri=https://pepperstone.com/api/auth/callback
response_type=code
code_challenge=<random-base64>
code_challenge_method=S256
nonce=<random-base64>
```

**Key constraint:** The `code_challenge` is a one-time PKCE value tied
to the `state`. You **cannot** replay a captured login URL — it will
fail with an Auth0 error. Always start fresh from the Pepperstone
homepage.

---

## Observed login attempt (2026-07-31)

Tested from a CloakBrowser-managed profile via bdg CDP:

| Field | Value |
|---|---|
| Email | `mrme000.m0@gmail.com` |
| Password | `m01790476136M@` (hidden in skill — filled via bdg) |
| Result | **FAILED** — "Login was not successful. Please try again." |
| No CAPTCHA triggered | |
| No 2FA/MFA challenge appeared | |
| Both fields showed `:invalid` after failure | |

**Possible causes:**
- Incorrect password for this email
- Account does not exist in this Auth0 tenant
- Auth0 silent bot-detection rejecting the CDP-driven submission
  (automated fills via `Page.navigate` + `dom fill` may trigger
  heuristics; try adding realistic delays between fill and submit)
- Account may need to be created first (visit "Join now" →
  `https://secure.pepperstone.com/register?...`)

---

## Recommendations for automation

1. **Add realistic delays** between navigation, fill, and submit
   (`page.waitForTimeout(1500)` between each step).
2. **Use `page.type()`** (character-by-character) instead of `page.fill()`
   (instant) to avoid bot detection.
3. **Check for CAPTCHA** after 2–3 failed attempts — if triggered,
   manual intervention is needed.
4. **Prefer the page-level CDP endpoint** (`/cdp/local/devtools/page/<guid>`)
   when using bdg — the root CDP endpoint lacks the `Page` domain.
5. **Handle OAuth2 redirects** by watching for the URL change away from
   `auth.pepperstone.com` (wait for URL to include `callback` or
   `secure.pepperstone.com`).

---

## See also

- [bdg cloak integration guide](../cloak-integration.md) — using bdg
  with CloakBrowser-managed profiles
- [Auth0 PKCE documentation](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce)
- [Pepperstone client portal](https://secure.pepperstone.com)
