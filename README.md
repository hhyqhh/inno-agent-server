# Inno Agent Server

> **The multi-user server edition of [Inno Agent](https://github.com/hhyqhh/inno-agent).** It adds Better Auth + PostgreSQL personal tenants, independent Durable session concurrency, crash recovery, tenant-scoped state, and optional static worker routing.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen.svg)](https://nodejs.org)
[![Release](https://img.shields.io/github/v/release/hhyqhh/inno-agent-server.svg)](https://github.com/hhyqhh/inno-agent-server/releases)

**English** | [简体中文](./README.zh-CN.md)

For the original project's personal-learning goals, layered-memory design, desktop app, research report, and screenshots, see **[Inno Agent](https://github.com/hhyqhh/inno-agent)**. This repository focuses on the server runtime and does not duplicate that introduction.

Start with the [multi-user Durable guide](./docs/MULTI_USER_DURABLE.md) for the refactor architecture, real-service acceptance results, and production limitations.

## Runtime boundaries

Inno Agent now supports two explicit execution paths:

- **Legacy compatibility** — CLI, Desktop, and local server keep the original singleton `AgentSession`, JSONL history, host tools, and serialized prompt queue by default. This remains the simplest personal runtime.
- **Durable execution** — `INNO_DURABLE_ENABLED=true` enables independent per-session SQLite runtimes. Multi-user mode requires Durable; new work never falls back to the shared legacy queue. Durable supports concurrent sessions, request-ID deduplication, crash resume, exact application SSE replay, workspace-contained file tools, replay-safe question/permission cards, tenant-local memory/OCR/channel state, and durable scheduler/channel execution.
- **Verified tenant isolation** — Better Auth + PostgreSQL provides personal tenants and resource ownership. Provider credentials, memory, workspaces, channels, and jobs use verified tenant roots; unauthenticated requests return 401 and cross-tenant resources return 404. Host shell/file tools and PTY terminals are disabled in authenticated mode.
- **Single-owner storage** — one durable storage has one owner. Optional static tenant-owner routing uses workers with independent RWO data roots; shared active-active SQLite/NFS, automatic failover, and network-partition fencing are not supported.
- **Honest recovery semantics** — committed state and application checkpoints recover work, but model calls, initial remote OCR submission, channel delivery, and some file mutations retain documented at-least-once crash windows.

- **Durable capacity harness.** `npm run benchmark:durable` measures independent-session concurrency, admission/turn/snapshot latency, SQLite probes, RSS, event-loop delay, and SIGKILL/reopen recovery using faux providers only. See [docs/DURABLE_CAPACITY.md](./docs/DURABLE_CAPACITY.md); it is not a production sizing guarantee.
- **Legacy backpressure remains explicit.** The legacy queue returns `409 session_busy` when blocked; Durable sessions do not share that queue. See the original [issue #124](https://github.com/hhyqhh/inno-agent/issues/124) for the backpressure design discussion.

See the [multi-user Durable guide](./docs/MULTI_USER_DURABLE.md) and [runtime contract](./docs/DURABLE_RUNTIME.md) for supported capabilities, configuration, verification, and production limitations.

## Features

- 👥 **Multi-user Durable server**
  - Better Auth + PostgreSQL personal tenants, independent session concurrency, tenant-scoped credentials and storage, crash recovery, SSE replay, and optional static worker routing. [Architecture and limits](./docs/MULTI_USER_DURABLE.md).
- 🧠 **Three-layer memory**
  - **L1 learner profile** — goals, knowledge states, misconceptions, preferences; summarized into a context pack injected each turn.
  - **L2 native wiki** — human-readable, agent-queryable pages with hybrid retrieval (lexical BM25 + knowledge graph), LLM-assisted summarization, and PDF/Office/image ingestion.
  - **L3 session recall** — session history indexed into SQLite (FTS5) with threshold-gated cross-conversation retrieval.
- ⏰ **Proactive scheduler** — cron jobs created in natural language, runnable from the agent, the UI, or the daemon.
- 💬 **Personal IM channels** — Feishu (native) plus WeChat (iLink QR login or bridge mode), with a unified dispatcher for reminders.
- 🧪 **Practice Lab** — workspace-scoped web terminal (xterm.js over WebSocket) with run records the agent can read. The web terminal remains available in local and Desktop server mode; host execution and its controls are disabled in Better Auth mode.
- 🎯 **Simple Mode + presets** — one-click preset workspaces (lesson plan, PPT creation, scenario explain) for non-technical users.
- 🧩 **Skill system + content hub** — browse and import skills/presets from a remote hub (GitHub repo or self-hosted bundle service).
- ✏️ **Conversation branch editing** — edit a previously sent plain-text Web message and regenerate from that point without keeping the abandoned branch in the active model context.
- 🔌 **Pluggable providers** — any `openai-completions` or `anthropic-messages` endpoint (Anthropic, OpenAI, DeepSeek, Ollama, local models); switch models live in the UI.
- 🌍 **i18n & themes** — Chinese/English UI, four themes.
- 🎬 **Session replay showcase** — export any real session (button or CLI) and replay it in a standalone site built from the real product UI, with streaming messages, workspace/notebook/profile panels, and generated artifacts.
- 🛡️ **Optional OS-level sandbox** — gate bash/file operations via [pi-sandbox](https://github.com/carderne/pi-sandbox); optional subagents via `pi-subagents`.
- 🖥️ **Computer use (desktop)** — the desktop app can observe and control the local screen (accessibility-tree-first) via [`pi-computer-use`](https://github.com/injaneity/pi-computer-use); off by default on server deployments. See [Computer Use](#computer-use).

## Quick Start

### Option A — From source

```bash
git clone https://github.com/hhyqhh/inno-agent-server.git
cd inno-agent-server

npm install      # pulls the Pi SDK from npm
npm run build    # compiles backend + web

mkdir -p runtime/config runtime/data runtime/skills workspace
cp config.example.json runtime/config/config.json
# Edit runtime/config/config.json and set providers[*].apiKey

npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

Open **http://localhost:3000**. See **[QUICKSTART.md](./QUICKSTART.md)** (中文) for a 5-minute walkthrough with provider examples.

### Option B — Docker

```bash
docker compose up -d   # serves on :3000, mounts runtime/ and workspace/
```

## Run Modes

```bash
npm run server          # Web UI (API + built frontend on :3000)
npm run start           # CLI (terminal agent, no HTTP)
npm run electron        # Desktop app locally
npm run server:sandbox  # Web UI with OS-level sandbox (requires ripgrep)

# Dev: backend on :3000 + Vite HMR on :5173
npm run dev:server & npm run web:dev
```

`restart-dev.sh` orchestrates the dev lifecycle (build, start, stop, status, logs, smoke-test) — run `bash restart-dev.sh --help`.

### Multi-user Durable server

```bash
export INNO_AUTH_MODE=better-auth
export INNO_MULTI_USER_ENABLED=true
export INNO_DURABLE_ENABLED=true
export DATABASE_URL=postgresql://inno:inno@127.0.0.1:5432/inno
export BETTER_AUTH_SECRET='replace-with-at-least-32-random-characters'
export BETTER_AUTH_URL=http://127.0.0.1:3000

npm run auth:migrate --workspace inno-agent
npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

Each account configures its own provider/model in Settings. This is a restricted controlled-deployment runtime, not an internet-facing account-security or production-capacity sign-off. See [Authentication](./docs/AUTHENTICATION.md) and the [multi-user Durable guide](./docs/MULTI_USER_DURABLE.md).

## Configuration

`runtime/config/config.json` (template: [`config.example.json`](./config.example.json)):

```json
{
  "defaultProvider": "innospark",
  "defaultModel": "claude-sonnet-4-6",
  "providers": {
    "innospark": {
      "baseUrl": "https://api.example.com",
      "api": "anthropic-messages",
      "apiKey": "replace-me",
      "models": [{ "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6" }]
    }
  },
  "server": { "port": 3000 },
  "channels": {
    "feishu": { "enabled": false },
    "wechat": { "enabled": false, "mode": "ilink" }
  },
  "memory": { "l1Enabled": true, "l2Enabled": true, "l3Enabled": true },
  "ui": { "theme": "light", "closeBehavior": "ask" }
}
```

Each provider declares a `baseUrl`, an `api` (`openai-completions` or `anthropic-messages`), an `apiKey`, and a `models[]` list. The server hot-rewrites this file when you switch models in the UI.

### Runtime paths

Both CLI and server resolve paths through `apps/inno-agent/src/runtime.ts`. Precedence: **CLI flag > env var > `~/.inno-agent/...`**.

| CLI flag | Env var | Default |
|---|---|---|
| `--home` | `INNO_HOME` | `~/.inno-agent` |
| `--config-dir` | `INNO_CONFIG_DIR` | `<home>/config` |
| `--data` | `INNO_DATA_DIR` | `<home>/data` |
| `--skills` | `INNO_SKILLS_DIR` | `<home>/skills` |
| `--workspace` | `INNO_WORKSPACE_DIR` | invocation CWD |
| `--port` | `INNO_PORT` | `3000` |

### Permissions & Sandbox

Two independent guardrails control what the agent's tools can do. The **permission layer** (pi-permission-system, on by default) gates tool calls with allow/ask/deny rules — `ask` pops an approval card in the web UI (allow once / allow for session / deny). Three policy modes — `default` (asks on non-allowlisted bash), `auto` (approves bash), `yolo` (approves everything) — switchable from the shield button in the composer toolbar, persisted as `plugins.permissionSystem.mode`, effective immediately without restart. A hard-deny floor (destructive commands, `~/.ssh/*`, `*.env`, …) applies in every mode. Durable sessions use a separate replay-safe approval store for workspace `write`/`edit`: streaming turns show the same approval card, non-streaming/headless turns deny with `no_ui`, and the legacy policy-mode switch does not bypass this boundary. The **sandbox layer** (pi-sandbox, opt-in via `--sandbox`) enforces filesystem/network limits at the OS level (sandbox-exec on macOS, bubblewrap on Linux) — a permission approval never overrides it. Full details and configuration: [docs/PERMISSIONS_AND_SANDBOX.md](./docs/PERMISSIONS_AND_SANDBOX.md).

### Computer Use

The desktop app ships with GUI computer control (via [`@injaneity/pi-computer-use`](https://github.com/injaneity/pi-computer-use)): the agent observes windows through the OS accessibility tree and acts — click, type, scroll, or drive a browser. Passive observation tools stay allowed; every side-effecting action (`act_ui`, browser launch/navigation/evaluate) pops an approval card first. On macOS, first use installs a signed helper at `~/Applications/pi-computer-use.app` and needs **Accessibility** + **Screen Recording** grants in System Settings → Privacy & Security (if a fresh grant isn't picked up, restart the helper with `pkill -f pi-computer-use.app`).

**Enable / disable:**

- **Desktop app** — on by default. Toggle in **Settings → General → Computer use**, then restart the app (tools register at session start, so the change applies on restart).
- **Local server / CLI** — off by default. Start with the desktop flag to enable:

  ```bash
  INNO_DESKTOP=1 npm run server -- --home ./runtime --workspace ./workspace --port 3000
  ```

  To turn it back off, restart the service **without** `INNO_DESKTOP`.
- **Explicit override** (wins over the env default in both directions) in `config.json`:

  ```json
  "plugins": { "computerUse": { "enabled": true } }
  ```

- **Online deployments** — leave it unset (no `INNO_DESKTOP`) and the feature stays off.

### Content Hub

The skill library and Simple Mode presets are fetched from a remote **content hub** — by default the public GitHub repo [`Chloris-Blaxk/inno-agent-hub`](https://github.com/Chloris-Blaxk/inno-agent-hub). Point `contentHub` in `config.json` (or **Settings → Content Hub**) at a private GitHub repo (`"type": "github"`) or a self-hosted bundle service (`"type": "bundle"`) — a zero-dependency bundle server lives in [`scripts/content-hub-server/`](./scripts/content-hub-server/). Presets are cached locally; bundled templates serve as an offline fallback.

## Architecture

Four layers: **user interfaces → authenticated application services → legacy or Durable agent runtime → tenant-scoped memory.**

```text
User Interfaces      CLI · Web UI (React) · Desktop · Feishu · WeChat
        ↓
Application Layer    Better Auth · personal tenants · ownership · HTTP/SSE
                     Channels · scheduler · workspaces · Practice Lab (local)
        ↓
Agent Runtime        Legacy PI AgentSession ──or── pi-durable session runtimes
(PI SDK, unmodified) Shared native tools; legacy-only reverse adapter
        ↓
Layered Memory       L1 learner profile · L2 native wiki · L3 session recall
                     Global in local mode; verified tenant roots in multi-user mode
```

- **Agent core** — legacy uses `@earendil-works/pi-coding-agent` and [`inno-extension.ts`](./apps/inno-agent/src/agent/inno-extension.ts); Durable uses isolated `pi-durable` runtimes without the legacy global prompt queue. Memory/OCR/channel tools use the native `(params, api, context)` ABI, with a legacy-only reverse adapter for compatibility. The PI SDK kernel is not modified.
- **Multi-user and recovery** — Better Auth + PostgreSQL verifies identity and ownership. Durable adds per-session SQLite, request-ID deduplication, application SSE journals, replay-safe question/permission recovery, and independent session concurrency. See [docs/MULTI_USER_DURABLE.md](./docs/MULTI_USER_DURABLE.md).
- **Memory** — L1 (`src/memory/learner/`): evidence-driven profile + event log. L2 (`src/memory/l2/`): structured wiki with graph, summarizer, ingestion, and hybrid retrieval; exposed via agent tools and `/api/wiki/*`. L3 (`src/memory/l3/`): a tenant-scoped SQLite FTS5 index over owned legacy JSONL and committed Durable history.
- **Scheduler** (`src/scheduler/`) — cron jobs persisted to `jobs.json` + `runs.jsonl`.
- **Channels** (`src/channels/`) — `ChannelRegistry` with Feishu, WeChat (iLink / bridge), and QQ (bridge).
- **HTTP server** (`src/server.ts`) — plain Node `http.createServer` with SSE chat streaming and a WebSocket terminal; route table in [`apps/inno-agent/README.md`](./apps/inno-agent/README.md).
- **Web UI** (`web/src/`) — React 19 + Tailwind 4. Framework-agnostic `EventEmitter` stores in `web/src/stores/`; REST/SSE calls in `web/src/api/`.

## Repository Layout

```text
apps/inno-agent/           Backend (CLI + HTTP server), TypeScript → dist/
apps/inno-agent/web/       Frontend (React 19 + Tailwind 4 + Vite)
apps/inno-agent/presets/   Bundled preset workspaces (offline fallback)
apps/showcase/             Session replay showcase site (real product UI + recorded cases)
electron/                  Electron main process (desktop app)
scripts/content-hub-server/  Self-hosted Content Hub bundle service
runtime/                   Local runtime state (config, data, skills) — gitignored
workspace/                 Default agent working directory — gitignored
```

## Deployment

Typical production layout, separating code, config, data, and workspace:

```bash
INNO_CONFIG_DIR=/etc/inno-agent \
INNO_DATA_DIR=/var/lib/inno-agent/data \
INNO_SKILLS_DIR=/var/lib/inno-agent/skills \
INNO_WORKSPACE_DIR=/srv/inno-workspace \
INNO_PORT=3000 \
npm run server
```

A [`Dockerfile`](./Dockerfile) and [`docker-compose.yml`](./docker-compose.yml) are provided as starting points; see [`docs/SYSTEM_DEPENDENCIES.md`](./docs/SYSTEM_DEPENDENCIES.md) for the full dependency reference. Better Auth + PostgreSQL setup, tenant isolation, and public-account limitations are in [`docs/AUTHENTICATION.md`](./docs/AUTHENTICATION.md). The Durable architecture, static worker routing, verification results, and single-owner deployment boundary are in [`docs/MULTI_USER_DURABLE.md`](./docs/MULTI_USER_DURABLE.md). Desktop packaging notes are in [`ELECTRON_BUILD.md`](./ELECTRON_BUILD.md).

## Showcase — Session Replay Site

[`apps/showcase/`](./apps/showcase) is a standalone site that replays recorded Inno Agent sessions through the **real product UI** (via a Vite alias into `apps/inno-agent/web/src`) — no backend, no model calls. A replay reproduces the streaming chat turn by turn and keeps the right-hand panels in sync: workspace files appear as tools write them (including bash-generated artifacts like HTML/PDF/PPTX), wiki notes accumulate in the notebook, and the learner profile lights up as learning events are recorded.

**Export a real session** from inside the product (hover a session in the sidebar → clapperboard icon) or from the CLI:

```bash
npm run showcase:export -- --session <substring>   # pick one recorded session
npm run showcase:view                              # build + serve + open the replay site
```

Exported cases land in `runtime/data/showcase-exports/cases/` in local/CLI mode, or `runtime/data/tenants/<tenantId>/showcase-exports/cases/` in Better Auth mode, with automatic path/username/secret sanitization. Case IDs are restricted to safe single path components, and authenticated exports read only the current tenant's L1 profile. The local viewer overlays local exports on top of the published cases without a rebuild; use `--cases <dir>` to view another export directory.

- [apps/showcase/README.md](./apps/showcase/README.md) — architecture, mock backend, and the constraints for keeping the replay UI in sync with product code.
- [apps/showcase/EXPORTING.md](./apps/showcase/EXPORTING.md) — full export handbook (中文): button flow, CLI reference, sanitization rules, troubleshooting.

## Use Cases & Docs

- [Multi-user Durable architecture and verification](./docs/MULTI_USER_DURABLE.md) — refactor overview, tenant boundaries, recovery semantics, real-service acceptance, and production gaps.
- [Durable runtime contract](./docs/DURABLE_RUNTIME.md) — detailed storage, replay, tool, scheduler, and channel behavior.
- [Authentication and tenant isolation](./docs/AUTHENTICATION.md) — Better Auth setup, explicit legacy-owner migration, and account-security limits.
- [Skill Tutorial — Building a Workspace Agent](./docs/use-cases/skill-tutorial.md) — use `agent.md` and `.skills/` to build a custom learning agent scoped to a workspace.
- [QUICKSTART.md](./QUICKSTART.md) — 5-minute setup guide (中文).
- [apps/inno-agent/README.md](./apps/inno-agent/README.md) — backend API route table (中文).

## Contributing

Issues and PRs are welcome. Before opening a PR, run `npm test` and `npm run build`. Changes touching authentication, tenant ownership, or Durable recovery should also run `npm run test:integration` against real PostgreSQL. Keep changes focused, match the existing code style, and update docs when behavior changes.

## Community

Join the WeChat user group to ask questions, share use cases, and follow updates:

<p align="center">
  <img src="./docs/assets/wechat-community-qr-2026-10-24.jpg" alt="Inno Agent WeChat community group QR code" width="240" />
</p>

## License

[MIT](./LICENSE). This project depends on the Pi SDK (`@earendil-works/pi-*` packages by Mario Zechner), also MIT-licensed and consumed via npm.

## Citation

```bibtex
@misc{hao2026innoagent,
  author       = {Hao Hao, Ye Lu, Ruotong Yang, Yongheng Guo and Aimin Zhou},
  title        = {Inno Agent: An Open-Source Personal Learning Agent with Layered Memory, Educational Post-Training, and Local Deployment},
  year         = {2026},
  publisher    = {GitHub},
  journal      = {GitHub repository},
  howpublished = {\url{https://github.com/hhyqhh/inno-agent-server}}
}
```
