# Using bdg with CloakBrowser Profile Manager (CBM)

`bdg cloak` is a native command group in browser-debugger-cli that integrates
with [CloakBrowser Manager](https://github.com/CloakHQ/CloakBrowser-Manager) —
a self-hosted browser-fleet orchestrator with per-profile fingerprints, proxy
routing, and VNC access.

With `bdg cloak` you can **fully manage** CBM profiles — list, get, create,
update, delete, and clone — plus **launch, stop, and connect** to them, then
use bdg's full inspection toolkit (DOM, network, console, raw CDP) against the
live browser. Everything works locally or over a public Cloudflare-tunnel URI.

---

## Prerequisites

| Requirement | Details |
|---|---|
| **CBM server** | Running and reachable (default `http://127.0.0.1:8080`) |
| **ALLOW_LOCAL_CDP** | Only needed for **tokenless, loopback** `connect`. With a token set, `connect` uses the authenticated `/cdp` path (see below) |
| **bdg ≥ 0.7.2** | Includes the `cloak` command group (`connect` auto-injects the Bearer token on the CDP WS) |
| **Auth token** | Required for `connect` over a tunnel/remote host (and recommended generally). Set `CBPM_API_TOKEN`. |

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

> **Generic `bdg <url>` attach path:** the `--chrome-ws-url` / `--cdp-headers`
> defaults live in a separate config file (`~/.config/bdg/config.json`) — see
> [configuration.md](./configuration.md). `bdg cloak connect` derives its auth
> header from the cbpm `token` above, so you usually don't need that for CBM.

---

## Connecting to a profile

`bdg cloak connect` attaches bdg's CDP WebSocket client to a managed profile:

- **With `CBPM_API_TOKEN` set (recommended):** `connect` launches the
  profile, fetches the page target from the authenticated `/cdp/json/list`
  endpoint, and injects `Authorization: Bearer <token>` on the CDP WebSocket
  upgrade. Works **locally and over a remote / Cloudflare-tunnel host** — no
  special server config beyond a strong `AUTH_TOKEN`.
- **Without a token (loopback only):** `connect` falls back to the `/cdp/local`
  path, which needs `ALLOW_LOCAL_CDP=true` and bdg on the same machine as the
  CBM server (see the `ALLOW_LOCAL_CDP` block below).

### Tokenless loopback mode (`ALLOW_LOCAL_CDP`)

Only needed when you have no token configured and bdg runs on the same
machine as the CBM server. Add this to your CBM environment:

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

### Connecting over a Cloudflare tunnel (with a token)

Expose CBM publicly and drive it from a remote machine. With a token set,
`bdg cloak connect` uses the authenticated `/cdp` path and sends
`Authorization: Bearer` on the WebSocket upgrade, so the tunnel just needs to
forward it.

```bash
# On the client machine:
export CBPM_API_URL=https://cloak.yourdomain.com
export CBPM_API_TOKEN=<your CLOAK_AUTH_TOKEN>

bdg cloak status                              # REST management works over the tunnel
bdg cloak profiles
bdg cloak get <profile-id>                    # full profile details over the tunnel
bdg cloak create --name remote-profile --tag tunnel
bdg cloak connect <profile-id> https://example.com   # authenticated WSS CDP attach
```

Tunnel ingress (`cloudflared`) — point the hostname at the CBM port:

```yaml
ingress:
  - hostname: cloak.yourdomain.com
    service: http://127.0.0.1:8080
```

Notes:

- bdg's CDP WebSocket client sends no `Origin`, so the CBM server's
  cross-origin WebSocket guard allows it.
- Don't put **Cloudflare Access** on this hostname (it would intercept before
  the origin). If you must, pass the CF Access service-token headers via the
  generic `bdg <url> --cdp-headers=...` path (see
  [configuration.md](./configuration.md)).
- CDP is full browser control — treat `CLOAK_AUTH_TOKEN` like a root
  credential.

### Connecting over an SSH tunnel (with a token)

If CBM is running on a remote host bound to `127.0.0.1:8080` (the Docker
Compose default), forward the port to your local machine over SSH:

```bash
ssh -L 8080:127.0.0.1:8080 user@remote-host
```

Or bake the tunnel into `~/.ssh/config`:

```ssh
Host cloak-tunnel
    HostName remote-host
    User user
    LocalForward 8080 127.0.0.1:8080
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

Then aim `bdg cloak` at the local endpoint:

```bash
export CBPM_API_URL=http://127.0.0.1:8080
export CBPM_API_TOKEN=<your CLOAK_AUTH_TOKEN>

bdg cloak connect proxy-tz-demo https://example.com
```

`connect` uses the authenticated `/cdp` path, so the WebSocket upgrade goes
through the tunnel with the `Authorization: Bearer` header injected
automatically.

For the generic `bdg <url>` attach path (manual `--chrome-ws-url` +
`--cdp-headers`), those flags can also be baked into a config file — see
[configuration.md](./configuration.md).

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

### `bdg cloak get <id>`

Show a single profile's full details — every configured field, tags, the CDP
endpoint, and live runtime resources. Accepts a profile **ID or name**.

```bash
$ bdg cloak get proxy-tz-demo
proxy-tz-demo    (running)
  id:              912925dd-a2fc-48db-b364-0259330952cd
  platform:        windows
  fingerprint_seed: 36775
  proxy:            —
  timezone/locale:  Australia/Sydney / en-AU
  screen:           1920x1080
  humanize:         yes (default)  geoip: true  headless: false
  auto_launch:      false  restart_on_crash: false (max 5)
  tags:             demo, au
  cdp_endpoint:     ws://127.0.0.1:8080/api/profiles/912925dd-…/cdp
  resources:        CPU 0% · 919.4MB · 2h 1m
```

`--json` returns the full `CbmProfile` object.

### `bdg cloak create` — self-explaining profile creation

Create a profile. The full option surface is generated from the backend
`ProfileCreate` model and is **self-explaining** — no need to leave the CLI:

```bash
# Discover every field, its type, and its default (no API call):
bdg cloak create --list-fields

# Describe one field, with a worked example (no API call):
bdg cloak create --describe timezone

# Create (only --name is required):
bdg cloak create --name shop-us-1 \
  --timezone America/New_York --locale en-US \
  --humanize --platform macos \
  --proxy "socks5://user:pass@host:1080" \
  --tag production --tag "us:blue" \
  --launch-arg "--disable-features=Foo" \
  --notes "shop account #3"
```

> **Flag fidelity:** bdg derives each option key from its flag (e.g. `--tag` →
> the `tags` field), so `--tag`, `--proxy-credential`, `--proxy-group`, and
> `--launch-arg` apply correctly. (cbpm has a latent name/flag mismatch that
> silently ignores those four — bdg does not share that bug.) Tags use an
> optional `tag:color` form (`--tag us:blue`).

### `bdg cloak update <id>`

Partially update a profile — **only the flags you pass are sent** (the server
applies `exclude_unset`, so omitted fields are left untouched). Accepts a
profile ID or name and reuses the same flags as `create`.

```bash
bdg cloak update shop-us-1 --notes "updated" --geoip
bdg cloak update 912925dd… --no-clipboard-sync
```

> **Tags are replaced, not appended** — passing `--tag` sets the whole tag set;
> omit it to leave tags unchanged. With no flags at all, `update` errors
> (exit `81`) and points you to `--list-fields`.

### `bdg cloak delete <id>`

Delete a profile and its browser data (stops the browser first if running).
Accepts a profile ID or name. There is no confirmation prompt — this keeps the
command scriptable for automation.

```bash
bdg cloak delete shop-us-1
```

### `bdg cloak clone <id>`

Clone a profile — the clone gets a **new random fingerprint seed** (a fresh
device identity) and copies fingerprint/network/hardware/behavior fields,
tags, and proxy links. Accepts a profile ID or name.

```bash
bdg cloak clone shop-us-1 --name shop-us-2
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

# Stop any existing bdg session and reconnect with a fresh target
bdg cloak connect 912925dd-a2fc-48db-b364-0259330952cd --force
```

If the profile relaunches (crash-restart, stop + launch, or the browser
closing), bdg **auto-recovers**: it re-resolves the current page target and
reconnects, so you don't lose the session. See
[Reliability & recovery](#reliability--recovery).

**What happens:**
1. Resolves the profile by ID (launches it automatically if stopped).
2. Fetches the page-level CDP WebSocket URL via `/json/list` (and threads that
   endpoint to the worker so it can auto-recover after a relaunch).
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
- The CBM web dashboard at `https://<your-cbm-host>` (if using the tunnel)
- The `cbpm` CLI (`cbpm profiles list`)

---

## Profile IDs and names

`bdg cloak connect`, `get`, `update`, `delete`, and `clone` all accept either a
profile **ID** or **name**. A bare ID is used directly; if it doesn't match,
bdg resolves it as a name via the profile list and retries.

```bash
bdg cloak connect proxy-tz-demo https://example.com
bdg cloak get proxy-tz-demo
bdg cloak update proxy-tz-demo --notes "tweaked"
bdg cloak clone proxy-tz-demo --name proxy-tz-demo-2
```

If multiple profiles share the same name, the first match is used.
Use the ID for precision.

---

## Reliability & recovery

When a CBM profile's browser **relaunches** — a crash with `restart_on_crash`, a
manual `bdg cloak stop` + `launch`, or the browser closing — Chrome mints a
**fresh per-launch page-target GUID** and CBM rotates the CDP debug port. The
page-level `webSocketDebuggerUrl` bdg attached to at `connect` time is now
**stale**, and CBM closes the old WebSocket. This is why bdg used to "lose the
profile" the moment a profile restarted, while the CBM web UI (which reconnects
to a stable, server-re-resolved path on each click) kept working.

### Automatic recovery

`bdg cloak connect` threads the live `/json/list` endpoint (`cdpTargetListUrl`)
and the auth headers to the worker. When the CDP WebSocket drops, instead of
exiting, the worker:

1. Re-queries the live `/json/list` endpoint (with the Bearer token) for the
   **current** page targets.
2. Picks the current page target (fresh GUID).
3. Reconnects the same CDP session to the new `webSocketDebuggerUrl`.
4. Re-enables telemetry domains and re-navigates to the session URL.

The loop backs off exponentially (1s → 2s → 4s … capped at 30s) and is bounded
so it rides out the relaunch window where the profile is briefly `stopped`
(the list endpoint returns 404/empty). When the profile comes back up — whether
it auto-restarted or you relaunched it — bdg re-attaches automatically. The
general `bdg <url>` attach path (no `cdpTargetListUrl`) keeps the legacy
behavior (exit on loss); recovery only applies to `bdg cloak connect`.

Tune the bounds with env vars (optional):

| Env var | Default | Meaning |
|---|---|---|
| `BDG_CDP_RECOVERY_MAX_ATTEMPTS` | `30` | Max recovery attempts before giving up |
| `BDG_CDP_RECOVERY_MAX_SECONDS` | `300` | Max total recovery duration (5 min) |

On exhaustion (the profile stays down past the cap), the worker falls back to
the legacy cleanup-and-exit; just run `bdg cloak connect <id>` again once the
profile is back.

### Manual reconnect (`--force`)

To tear down an existing bdg session and re-attach with a freshly resolved
target in one step — e.g. if a session is wedged or you want a clean attach:

```bash
bdg cloak connect <id> --force
```

`--force` stops any active bdg session (restarting the daemon) and then runs
the normal connect flow with a fresh target resolution. It is the atomic
equivalent of `bdg stop && bdg cloak connect <id>`.

### Observing recovery

`bdg status` shows the recovery state — after a successful auto-recovery it
reports the **new** target id / `webSocketDebuggerUrl` plus a recovery summary:

```
Recovery
  Recoveries:      2
  Last Recovered:  35s ago
  Last Reason:     no targets (profile stopped/relaunching)
```

`bdg status --json` includes the same data in the `recovery` field.

### No CBM server changes required

CBM already exposes everything bdg needs: `/api/profiles/<id>/cdp[/local]/json/list`
is **always live** (re-fetched from the current Chrome on every call), and
`/api/profiles/<id>/status` reports `running`/`stopped`. bdg's recovery mirrors
the CBM web UI's pattern (re-query the live target, reconnect) — no backend
change is needed.

---

## Caveats & troubleshooting

### bdg daemon running old code after an update

**Symptom:** After upgrading bdg, `bdg cloak connect` fails with a WebSocket
`1006` error even though the token and URL are correct. The worker may log
that the CDP headers are missing.

**Fix:** The daemon keeps running until the last session stops. Run
`bdg cleanup --force` (or `bdg stop` if a session is active) to terminate it,
then retry the command. The new build's IPC logic then passes the
`cdpHeaders` through correctly.

### `ALLOW_LOCAL_CDP` is `false` (default) and no token is set

**Symptom:** `bdg cloak connect` prints:

```
Error: Daemon error: Worker process exited before sending ready signal
…
WebSocket closed: 1006
```

**Fix (recommended):** Set `CBPM_API_TOKEN` to your CBM `AUTH_TOKEN`. `connect`
then uses the authenticated `/cdp` path (no `ALLOW_LOCAL_CDP` needed, works
over a tunnel too).

**Fix (tokenless, loopback only):** Set `ALLOW_LOCAL_CDP=true` in the CBM
environment and restart the container. The REST portion of `connect`
(profile resolution, target discovery) works without it; only the
WebSocket attach needs it.

### bdg daemon already has an active session

**Symptom:** `connect` fails because a session is already attached to
a different browser.

**Fix:** Run `bdg stop` first to end the previous session, then retry — or do it
in one step with `bdg cloak connect <id> --force` (see
[Reliability & recovery](#reliability--recovery)).

### `bdg cloak profiles` shows no resources

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

## Common workflows

### Change a profile's proxy and timezone

`bdg cloak profile` provides shortcuts for the tweaks you do most often.
Each command accepts a profile ID or name.

```bash
# Assign an IPVanish proxy by location code (no UUID hunting)
bdg cloak profile proxy proxy-tz-demo --location us-nyc

# Or assign by saved credential UUID / rotation group UUID / inline URL
bdg cloak profile proxy proxy-tz-demo --credential <uuid>
bdg cloak profile proxy proxy-tz-demo --group <uuid>
bdg cloak profile proxy proxy-tz-demo --url socks5://u:p@host:1080

# Remove the proxy entirely
bdg cloak profile proxy proxy-tz-demo --none

# Change timezone
bdg cloak profile timezone proxy-tz-demo --timezone Europe/Berlin

# List available saved credentials with their location codes
bdg cloak proxy-credentials
```

### Reseed fingerprint or reset User-Agent

```bash
# Generate a new random fingerprint seed (takes effect on next launch)
bdg cloak profile reseed proxy-tz-demo

# Clear an explicit User-Agent so CBM regenerates it on next launch
bdg cloak profile reset-ua proxy-tz-demo
```

All profile field changes (proxy, timezone, fingerprint seed, User-Agent) are
persisted to the CBM database and take effect the next time the profile is
launched. Restart the profile with `bdg cloak stop <id>` followed by
`bdg cloak launch <id>` if it is currently running.

### Full-field updates still work

For surgery on any profile field (`--name`, `--platform`, `--humanize`, etc.),
use `bdg cloak update <id>`.

```bash
bdg cloak update proxy-tz-demo --user-agent "Mozilla/5.0 custom" --timezone America/Los_Angeles
```

## Reference — command summary

| Command | Description |
|---|---|
| `bdg cloak status` | CBM server health, running count, version, aggregate resources |
| `bdg cloak profiles` | List profiles with status, tags, VNC port, resources column |
| `bdg cloak get <id>` | Show a profile's full details (ID or name) |
| `bdg cloak create` | Create a profile — `--list-fields` / `--describe` are self-explaining |
| `bdg cloak update <id>` | Partially update a profile (only provided fields change; ID or name) |
| `bdg cloak delete <id>` | Delete a profile and its browser data (ID or name) |
| `bdg cloak clone <id>` | Clone a profile with a new fingerprint seed (ID or name) |
| `bdg cloak profile proxy <id>` | Change a profile's proxy (location, credential, group, URL, or none) |
| `bdg cloak profile timezone <id>` | Set a profile's timezone |
| `bdg cloak profile reseed <id>` | Generate a new random fingerprint seed |
| `bdg cloak profile reset-ua <id>` | Clear explicit User-Agent |
| `bdg cloak proxy-credentials` | List saved proxy credentials |
| `bdg cloak launch <id>` | Start a profile's browser |
| `bdg cloak stop <id>` | Stop a running profile |
| `bdg cloak connect <id> [url]` | Attach bdg session to a profile; `--force` resets first; auto-recovers on relaunch |

All commands support `--json` for machine-readable output and `--help`
for inline documentation.

---

## See also

- [CloakBrowser Manager](https://github.com/CloakHQ/CloakBrowser-Manager) — CBM backend + frontend
- [cbpm CLI](https://github.com/CloakHQ/CloakBrowser-Manager/tree/main/cli) — the complementary TypeScript CLI for profile management
- [bdg CLI reference](./CLI_REFERENCE.md) — full bdg command catalog
- [bdg architecture](./architecture/) — daemon, worker, and session model
