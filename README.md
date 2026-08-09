# Browser Debugger CLI

[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/szymdzum/browser-debugger-cli/pulls)
[![CI](https://github.com/szymdzum/browser-debugger-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/szymdzum/browser-debugger-cli/actions/workflows/ci.yml)
[![Security](https://github.com/szymdzum/browser-debugger-cli/actions/workflows/security.yml/badge.svg)](https://github.com/szymdzum/browser-debugger-cli/actions/workflows/security.yml)
[![npm downloads](https://img.shields.io/npm/dt/browser-debugger-cli?color=blue)](https://www.npmjs.com/package/browser-debugger-cli)

Chrome DevTools Protocol in your terminal. Opens a persistent connection to Chrome where commands can be executed sequentially via Unix pipes. **Designed for AI agents** and developers who want direct browser control without framework overhead.

## Why bdg?

- **Raw CDP access** - All [644 protocol methods](https://chromedevtools.github.io/devtools-protocol/) available directly
- **Token efficient** - No overhead from MCP tool definitions; progressive discovery loads only what's needed
- **Self-correcting** - Errors clearly exposed with semantic exit codes and suggestions
- **Composable** - Unix philosophy: pipes, jq, shell scripts work naturally

**When to use alternatives:**
- **Puppeteer/Playwright**: Complex multi-step scripts, mature testing ecosystem
- **Chrome DevTools MCP**: Already invested in MCP infrastructure

**Built for agents:** Self-discovery (`--list`, `--search`), semantic exit codes, structured errors, case-insensitive commands, token-efficient output.

## Benchmark: CLI vs MCP for AI Agents

We benchmarked bdg against Chrome DevTools MCP Server on real developer debugging tasks.


**[Full benchmark analysis →](docs/benchmarks/ARTICLE_MCP_VS_CLI_FOR_AGENTS.md)**

**Key findings:** CLI provided 33% better token efficiency through selective queries vs full accessibility tree dumps, plus capabilities MCP doesn't expose (memory profiling, HAR export, batch JS execution).


## Install

```bash
npm install -g browser-debugger-cli@alpha
```

**Platform Support:**
- ✅ macOS and Linux
- ✅ Windows via WSL
- ❌ PowerShell/Git Bash (not yet)

## Quick Start

```bash
bdg example.com                    # Start session
bdg https://localhost:5173 --chrome-flags="--ignore-certificate-errors"  # Self-signed certs
bdg https://localhost:5173 --chrome-flags="--disable-web-security"       # Disable CORS
bdg cdp --search cookie            # Discover commands
bdg cdp Network.getCookies         # Run any CDP method
bdg dom query "button"             # High-level helpers
bdg stop                           # End session
```

## CloakBrowser Manager integration

`bdg cloak` manages and connects to [CloakBrowser Manager](https://github.com/CloakHQ/CloakBrowser-Manager) profiles. Build organic, detector-resistant fingerprints with curated device personas, then verify them live:

```bash
bdg cloak personas                           # list coherent device bundles
bdg cloak create --name us-shop --persona win11-rtx3070-desktop --geoip
bdg cloak get us-shop --fingerprint         # inspect the organic fields
bdg cloak analyze us-shop                    # live actual-vs-expected verification

# Rotate identity / proxy / timezone / UA
bdg cloak profile rotate-identity us-shop   # new seed + re-apply persona bundle
bdg cloak profile reseed us-shop
bdg cloak profile proxy us-shop --location us-nyc
bdg cloak profile timezone us-shop --timezone Europe/Berlin
bdg cloak profile reset-ua us-shop
```

See [`docs/cloak-integration.md`](docs/cloak-integration.md) for setup, tunnel usage, organic-fingerprint guidance, and the full command reference.

## Current State

**Raw CDP access is complete.** All 644 protocol methods (53 domains) work now. High-level wrappers (`bdg dom`, `bdg network`) are being added for common operations. See [Commands](https://github.com/szymdzum/browser-debugger-cli/wiki/Commands) for full reference.

The `bdg cloak` command group is available for CloakBrowser Manager profile orchestration.

## Agent Discovery Pattern

```bash
# Agent explores what's possible (no docs needed)
bdg cdp --list                              # 53 domains
bdg cdp Network --list                      # 39 methods
bdg cdp Network.getCookies --describe       # Full schema + examples
bdg cdp Network.getCookies                  # Execute

# Search across all domains
bdg cdp --search screenshot                 # Find relevant methods
bdg cdp --search cookie                     # 14 results
```

## Documentation

📖 **[CLI Reference](docs/CLI_REFERENCE.md)** - Complete command catalog, including `bdg cloak`  
🔌 **[CloakBrowser Manager Integration](docs/cloak-integration.md)** - Manage and inspect CBM profiles  
🤖 **[CLAUDE.md](CLAUDE.md)** - Agent development guide and common patterns  

📖 **[Wiki](https://github.com/szymdzum/browser-debugger-cli/wiki)** - Additional guides and recipes

- [Getting Started](https://github.com/szymdzum/browser-debugger-cli/wiki/Getting-Started)
- [Commands](https://github.com/szymdzum/browser-debugger-cli/wiki/Commands)
- [For AI Agents](https://github.com/szymdzum/browser-debugger-cli/wiki/For-AI-Agents)
- [Recipes](https://github.com/szymdzum/browser-debugger-cli/wiki/Recipes)
- [Quick Reference](https://github.com/szymdzum/browser-debugger-cli/wiki/Quick-Reference)
- [Architecture](https://github.com/szymdzum/browser-debugger-cli/wiki/Architecture)
- [Troubleshooting](https://github.com/szymdzum/browser-debugger-cli/wiki/Troubleshooting)

## Design Principles

This tool implements [Agent-Friendly Tools](docs/principles/AGENT_FRIENDLY_TOOLS.md):

- **Self-documenting** - Tools teach themselves via `--list`, `--describe`
- **Semantic exit codes** - Machine-parseable error handling
- **Structured output** - JSON by default, human-readable optional
- **Progressive disclosure** - Simple commands, deep capabilities

## Contributing

[Issues](https://github.com/szymdzum/browser-debugger-cli/issues) for bugs, [Discussions](https://github.com/szymdzum/browser-debugger-cli/discussions) for ideas. PRs welcome.

See `docs/` for architecture and contributor guides.

## License

MIT
