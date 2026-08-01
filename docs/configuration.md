# bdg configuration

bdg works with no configuration for the common case (launch a local Chrome and
collect telemetry). This page covers the **optional** configuration that lets
you persist defaults — primarily for the attach-to-existing-Chrome path
(`bdg <url> --chrome-ws-url=... --cdp-headers=...`), so you don't have to pass
those flags every time.

> For the CloakBrowser Manager integration, see
> [cloak-integration.md](./cloak-integration.md). `bdg cloak` uses its own
> shared config (`~/.cbpm/config.json`) and `bdg cloak connect` derives its
> auth header from that token automatically — you usually **don't** need this
> file for CBM. This file is for the generic `bdg <url>` attach path.

## Config file

Location (first found):

1. `$BDG_CONFIG_FILE` — explicit path override
2. `$XDG_CONFIG_HOME/bdg/config.json` (default `~/.config/bdg/config.json`)

### Fields

| Field | Type | Maps to | Description |
|---|---|---|---|
| `chromeWsUrl` | string | `--chrome-ws-url` | Default CDP WebSocket URL of an existing Chrome/CDP endpoint to attach to. |
| `cdpHeaders` | object | `--cdp-headers` | Default HTTP headers sent on the CDP WebSocket upgrade (e.g. `{"Authorization":"Bearer <token>"}`). |

Unknown fields are ignored.

### Example

`~/.config/bdg/config.json`:

```json
{
  "chromeWsUrl": "wss://cloak.example.com/api/profiles/912925dd/cdp/devtools/page/abc",
  "cdpHeaders": { "Authorization": "Bearer my-secret-token" }
}
```

With that in place:

```bash
bdg https://example.com           # attaches to chromeWsUrl, sends cdpHeaders
```

is equivalent to:

```bash
bdg https://example.com \
  --chrome-ws-url=wss://cloak.example.com/api/profiles/912925dd/cdp/devtools/page/abc \
  --cdp-headers='{"Authorization":"Bearer my-secret-token"}'
```

## Environment variables

Env vars override the config file. CLI flags override both.

| Variable | Maps to | Format |
|---|---|---|
| `BDG_CHROME_WS_URL` | `--chrome-ws-url` | WebSocket URL string |
| `BDG_CDP_HEADERS` | `--cdp-headers` | JSON object string, e.g. `'{"Authorization":"Bearer X"}'` |
| `BDG_CONFIG_FILE` | config file path | Absolute or relative path |
| `BDG_CHROME_FLAGS` | `--chrome-flags` | Space-separated Chrome flags (pre-existing) |

```bash
export BDG_CHROME_WS_URL=wss://cloak.example.com/api/profiles/912925dd/cdp/devtools/page/abc
export BDG_CDP_HEADERS='{"Authorization":"Bearer my-secret-token"}'
bdg https://example.com
```

## Precedence

For each value:

```
CLI flag  >  environment variable  >  config file  >  default (undefined)
```

Each field is resolved **independently**, so you can mix sources — e.g. a WS
URL from an env var and headers from the config file.

## Use case: CloakBrowser Manager over a Cloudflare tunnel

This is the generic attach path — use it when you connect to a CBM profile's
CDP endpoint manually (rather than via the recommended `bdg cloak connect`).

1. Expose CBM over a tunnel (`cloak.yourdomain.com` → `http://127.0.0.1:8080`),
   with a strong `AUTH_TOKEN`.
2. From `/api/profiles/<id>/cdp/json/list`, grab the page target's
   `webSocketDebuggerUrl` — it's rewritten to
   `wss://cloak.yourdomain.com/api/profiles/<id>/cdp/devtools/page/<guid>`.
3. Bake the auth header into the config file (the page `<guid>` changes per
   session, so you'll usually still pass `--chrome-ws-url` per invocation):

```json
{
  "cdpHeaders": { "Authorization": "Bearer <your CLOAK_AUTH_TOKEN>" }
}
```

```bash
bdg https://example.com \
  --chrome-ws-url=wss://cloak.yourdomain.com/api/profiles/<id>/cdp/devtools/page/<guid>
```

For the all-in-one CBM flow (launch + discover + attach with auto-injected
auth, over the tunnel), prefer `bdg cloak connect <id>` — see
[cloak-integration.md](./cloak-integration.md).

## Security

- `cdpHeaders` typically holds a bearer token. Treat the config file as a
  secret: restrict its permissions (`chmod 600 ~/.config/bdg/config.json`)
  and don't commit it.
- CDP grants full browser control. Only point bdg at endpoints you trust, and
  expose them publicly only behind a strong token (and ideally a network
  policy). See the security notes in [cloak-integration.md](./cloak-integration.md).
