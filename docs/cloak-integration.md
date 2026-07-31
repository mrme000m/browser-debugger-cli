# Using bdg with CloakBrowser Profile Manager (CBM)

`bdg cloak` is a native command group in browser-debugger-cli that integrates
with [CloakBrowser Manager](https://github.com/CloakHQ/CloakBrowser-Manager) —
a self-hosted browser-fleet orchestrator with per-profile fingerprints, proxy
routing, and VNC access.

With `bdg cloak` you can **list, launch, stop, and connect** to CBM-managed
browser profiles directly from the bdg CLI, then use bdg's full inspection
toolkit (DOM, network, console, raw CDP) against those profiles.

---

## Prerequisites

| Requirement | Details |
|---|---|
| **CBM server** | Running and reachable (default `http://127.0.0.1:8080`) |
| **ALLOW_LOCAL_CDP** | Must be `true` on the CBM server to use `connect` (see below) |
| **bdg ≥ 0.7.2** | Includes the `cloak` command group |
| **Auth token** | If the CBM server has `AUTH_TOKEN` set, you'll need it |

## Configuration

`bdg cloak` shares its configuration with the [cbpm CLI](https://github.com/CloakHQ/CloakBrowser-Manager/tree/main/cli).
Configure once, use from both tools.

### Method 1 — environment variables (highest precedence)

```bash
export CBPM_API_URL=http://127.0.0.1:8080
export CBPM_API_TOKEN=your-auth-token
```

### Method 2 — config file (shared with cbpm)

```
~/.cbpm/config.json
```

```json
{
  "api_url": "http://127.0.0.1:8080",
  "token": "your-auth-token"
}
```

Set with the cbpm CLI:

```bash
cbpm auth login <token>
```

### Defaults

If neither env vars nor config file are set, `bdg cloak` falls back to:

- `api_url` = `http://127.0.0.1:8080`
- `token` = _(empty — no auth header sent)_

---

## Enabling ALLOW_LOCAL_CDP (required for `bdg cloak connect`)

bdg's CDP WebSocket client sends **no authentication headers**, so the
CBM server must trust loopback connections. Add this to your CBM
environment:

```yaml
# docker-compose.yml or .env
environment:
  ALLOW_LOCAL_CDP: "true"
```

Then restart the CBM container:

```bash
docker compose up -d --force-recreate cloakbrowser-manager
```

**Verify the bypass works:**

```bash
# Should return 200 without an Authorization header
curl -s -o /dev/null -w "%{http_code}\n" \
  http://127.0.0.1:8080/api/profiles/<id>/cdp/local/json/list
```

> **Security note:** Only enable `ALLOW_LOCAL_CDP` when bdg (or another local
> tool) runs on the same machine as the CBM server. It skips authentication
> for requests from `127.0.0.1` / `::1`.

---

## Command reference

### `bdg cloak status`

Show the CBM server status: running profiles, version, and aggregate
resource usage (CPU / memory) when profiles are active.

```bash
$ bdg cloak status
CBM Server Status
  Version:     146.0.7680.177.5
  Profiles:    2 total, 1 running
  CPU:         0%
  Memory:      906.8 MB
```

`--json` returns the raw API response in the standard bdg envelope:

```bash
$ bdg cloak status --json
```

### `bdg cloak profiles`

List managed profiles with status, tags, VNC port, and per-profile
resource usage (CPU, memory, uptime) for running profiles.

```bash
$ bdg cloak profiles
2 profile(s):
  ▶ 912925dd…  proxy-tz-demo  running VNC:6100  CPU 0% · 906.8MB · 15m 3s
  ■ 3f57ea63…  visible-demo  stopped
```

**Filters:**

```bash
bdg cloak profiles --tag production        # filter by tag
bdg cloak profiles --status running        # only running profiles
bdg cloak profiles --status stopped        # only stopped profiles
bdg cloak profiles --json                  # machine-readable output
```

### `bdg cloak launch <id>` / `bdg cloak stop <id>`

Start and stop a profile's browser.

```bash
# Launch
$ bdg cloak launch 912925dd-a2fc-48db-b364-0259330952cd
Profile launched: 912925dd-a2fc-48db-b364-0259330952cd
  Status:    running
  Display:   :100
  VNC port:  6100
  CDP:       ws://127.0.0.1:8080/api/profiles/912925dd-…/cdp

# Stop
$ bdg cloak stop 912925dd-a2fc-48db-b364-0259330952cd
Profile stopped.
```

### `bdg cloak connect <id> [url]`

**The bridge** — attaches bdg's inspection session to a CBM-managed browser
profile. This is the primary integration touchpoint.

```bash
# Connect to a running profile (keeps current page)
bdg cloak connect 912925dd-a2fc-48db-b364-0259330952cd

# Connect AND navigate to a specific URL
bdg cloak connect 912925dd-a2fc-48db-b364-0259330952cd https://example.com
```

**What happens:**
1. Resolves the profile by ID (launches it automatically if stopped).
2. Fetches the page-level CDP WebSocket URL via `/json/list`.
3. Starts the bdg daemon and attaches it to the page.
4. Navigates to `[url]` (or the current page URL if omitted — a
   same-URL reload, non-disruptive).
5. Prints the bdg landing page with available commands.

After `connect`, all bdg commands work against the managed browser:

```bash
bdg dom eval "document.title"
bdg dom screenshot output.png
bdg network har session.har
bdg console
bdg cdp Page.captureScreenshot --params '{"format":"png"}'
```

### Typical workflow — start to finish

```bash
# 1. See what profiles exist
bdg cloak profiles

# 2. Launch one (if stopped) or skip if already running
bdg cloak launch 912925dd…

# 3. Attach bdg and navigate to a site
bdg cloak connect 912925dd… https://pepperstone.com

# 4. Inspect the page
bdg dom eval "document.title"
# → "Australia's leading online forex and CFD broker | Pepperstone"

bdg dom query "h1"
bdg network getCookies
bdg console --level error

# 5. Take a screenshot
bdg dom screenshot page.png

# 6. When done, detach
bdg stop

# 7. Stop the profile (optional — keeps running for VNC / other tools)
bdg cloak stop 912925dd…
```

---

## Per-profile resource monitoring

The `bdg cloak profiles` output includes live resource stats for each
**running** profile — no extra round-trip needed.

| Column | Example | Source |
|---|---|---|
| `CPU` | `0%` | `psutil` sum across Chromium process tree |
| `MEM` | `906.8MB` | RSS from `psutil` across process tree |
| `uptime` | `15m 3s` | Time since `launch` |

Stopped profiles (or older CBM servers that don't report resources)
omit the stats line silently.

The same data flows through:
- `bdg cloak profiles` (human — per-profile)
- `bdg cloak profiles --json` (machine-readable)
- The CBM web dashboard at `https://clk.mrme.tech` (if using the tunnel)
- The `cbpm` CLI (`cbpm profiles list`)

---

## Connecting to a profile by name

`bdg cloak connect` accepts either a profile **ID** or **name**:

```bash
bdg cloak connect proxy-tz-demo https://example.com
```

If multiple profiles share the same name, the first match is used.
Use the ID for precision.

---

## Caveats & troubleshooting

### `ALLOW_LOCAL_CDP` is `false` (default)

**Symptom:** `bdg cloak connect` prints:

```
Error: Daemon error: Worker process exited before sending ready signal
…
WebSocket closed: 1006
```

**Fix:** Set `ALLOW_LOCAL_CDP=true` in the CBM environment and restart
the container. The REST portion of `connect` (profile resolution,
target discovery) works without it; only the WebSocket attach needs it.

### bdg daemon already has an active session

**Symptom:** `connect` fails because a session is already attached to
a different browser.

**Fix:** Run `bdg stop` first to end the previous session, then retry.

### `bfg cloak profiles` shows no resources

**Cause:** The CBM server doesn't have `psutil` installed, or the
profile is stopped.

- Running profiles on a **baked image** (≥ `20260731` tag) always
  have `psutil` and report resources.
- Older images need `pip install psutil` inside the container.
- Stopped profiles always show no resources (expected).

### `Page.enable` error

**Symptom:** When using `cbpm profiles connect --exec-bdg`, the bdg
worker crashes with `Fatal error: 'Page.enable' wasn't found`.

**Cause:** `cbpm profiles connect --exec-bdg` passes the **root** CDP
endpoint, which doesn't support the `Page` domain. Use `bdg cloak
connect` instead — it attaches to a specific page target.

---

## Reference — command summary

| Command | Description |
|---|---|
| `bdg cloak status` | CBM server health, running count, version, aggregate resources |
| `bdg cloak profiles` | List profiles with status, tags, VNC port, resources column |
| `bdg cloak launch <id>` | Start a profile's browser |
| `bdg cloak stop <id>` | Stop a running profile |
| `bdg cloak connect <id> [url]` | Attach bdg session to a profile and optionally navigate |

All commands support `--json` for machine-readable output and `--help`
for inline documentation.

---

## See also

- [CloakBrowser Manager](https://github.com/CloakHQ/CloakBrowser-Manager) — CBM backend + frontend
- [cbpm CLI](https://github.com/CloakHQ/CloakBrowser-Manager/tree/main/cli) — the complementary TypeScript CLI for profile management
- [bdg CLI reference](./CLI_REFERENCE.md) — full bdg command catalog
- [bdg architecture](./architecture/) — daemon, worker, and session model
