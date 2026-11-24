# Z-Evo-Editor

A self-hosted, dependency-free runtime for an OpenAI-compatible coding-agent workspace.

`Z-Evo-Editor` pairs the existing PHP chat UI with a Node.js control plane. The Node process owns provider routing, SQLite persistence, MCP sessions, tool execution, request metrics, and the admin surface. PHP serves the browser UI and proxies its API contract to Node.

> Status: working local prototype. Local file execution has been verified with Ollama. Chat has been verified with InfiniteEarningZone and NVIDIA. Gemini and several other connected providers are not yet execution-verified.

## Why this exists

Most chat UIs stop at text. A coding workspace needs a single authority for:

- project and working-directory boundaries
- provider/model selection without leaking credentials
- tool execution with read/write policy
- conversation and run metrics that survive restarts
- MCP servers that can be added, connected, and disabled without changing code
- an admin surface that shows the truth instead of a demo

Z-Evo-Editor is that authority.

## Architecture

```text
Browser
  |
  |  existing PHP UI contract
  v
PHP front controller            php/app/index.php        :8788
  |
  |  /frontend/action, /frontend/stream
  v
Node runtime                    php/server/server.js     :8787
  |
  +-- node:sqlite               php/data/zc.sqlite
  +-- OpenAI-compatible HTTP    Ollama / InfiniteEarningZone / NVIDIA / ...
  +-- MCP JSON-RPC              external MCP servers
  +-- admin HTML + API          php/server/admin.js
```

No npm dependencies. Node 24 or newer provides `node:sqlite`, `fetch`, and `AbortSignal`.

## What works

| Area | State |
|---|---|
| Env loader + `.env` | Loaded before paths/credentials; process env wins |
| System identity | Stored in SQLite and injected into prompts/headers |
| Provider gateway | Built-in and custom OpenAI-compatible providers |
| InfiniteEarningZone | 10 models; `mission` chat verified |
| NVIDIA API Catalog | 32 models; `meta/muse-glimmer-30b` chat verified |
| Local Ollama | Chat + tool calls + real file write verified |
| MCP client | Initialize, tools/list, tools/call, sessions |
| Live MCP endpoint | `https://api.infiniteearningzone.com/mcp`, 101 tools |
| SQLite metrics | Session metrics, request log, env snapshot |
| Admin UI | Providers, tools, MCP, projects, agent task, sessions, metrics, logs |
| Project workspaces | Create from UI, set working directory, run a real task |
| Admin token | `ADMIN_TOKEN_ENABLED=true/false`, verified both ways |
| PHP → Node parameters | Project, CSRF, conversation, identity verified |

## Requirements

- Node.js 24+
- PHP 8.3+ with `curl` (tested on 8.4)
- Optional: Ollama for local tool execution
- Optional: `edge-tts` only if you generate narration locally

## Quick start

```bash
git clone https://github.com/azurebluezone/Z-Evo-Editor.git
cd Z-Evo-Editor

cp php/server/.env.example php/server/.env
# edit php/server/.env and add provider keys

cd php/server
node server.js
```

Expected startup:

```json
{"level":"INFO","event":"listening","url":"http://127.0.0.1:8787","storage":"sqlite"}
{"level":"INFO","event":"php_started","ready":true,"url":"http://127.0.0.1:8788/index.php"}
```

Open:

- Admin: `http://127.0.0.1:8787/admin`
- Frontend: `http://127.0.0.1:8788/index.php`
- Health: `http://127.0.0.1:8787/health`

The first start creates `php/data/zc.sqlite` with tables, seeds, and provider models. If `php/server/.env` is absent, the runtime still starts with defaults, but remote providers need keys.

## Environment

The loader reads `php/server/.env` and `php/.env`; a real process environment always wins. Never commit `.env`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Node port |
| `HOST` | `127.0.0.1` | Node bind address |
| `PHP_PORT` | `8788` | PHP built-in server port |
| `DATA_DIR` | `php/data` | SQLite and runtime logs |
| `ZC_WORKSPACE` | repository root | Project boundary |
| `ZC_PROJECTS_DIR` | `<workspace>/php/workspaces` | Default new-project folder |
| `ADMIN_TOKEN_ENABLED` | `false` | `false`: no token check; `true`: require `ADMIN_TOKEN` |
| `ADMIN_TOKEN` | empty | Admin API token when enabled |
| `IEZ_BASE_URL` | `https://api.infiniteearningzone.com/v1` | InfiniteEarningZone API |
| `IEZ_MCP_URL` | `https://api.infiniteearningzone.com/mcp` | MCP endpoint |
| `IEZ_MCP_ENABLED` | `false` | Enable the 101 MCP tools for agents |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | NVIDIA API Catalog |
| `NVIDIA_API_KEY` | empty | NVIDIA key |
| `ZC_IDENTITY_*` | ZombieCoder defaults | Name, version, owner, branding, contact |

Environment values are mirrored into SQLite at startup. Secret values are stored as `set`/empty in `env_import`; actual provider keys live only in the `providers` table and the local `.env`.

## Admin surface

- **Overview** — identity, project, env sync, counters
- **Projects & Agent** — create a project, set its working directory, activate it, and run an agent task
- **Metrics** — run totals, provider totals, session runs, request log
- **Identity & Prompt** — edit identity metadata and the active system prompt
- **Providers** — add/update/test/chat/delete providers; mark tool support
- **Tools** — enable or disable built-in and MCP tools; run one directly
- **MCP** — add, connect, enable/disable, refresh, delete
- **Sessions** — inspect conversations and messages
- **Logs** — runtime events

`write_file`, `edit_file`, `replace_in_file`, and `bash` are disabled by default. Enable them deliberately from the Tools tab.

## Data model

| Table | Purpose |
|---|---|
| `identities` | Runtime identity and branding |
| `system_prompts` | Prompt history and active prompt |
| `providers` | Built-in/custom providers, models, key presence, tool support |
| `tools` | Built-in and MCP tools with `enabled`/`read_only` |
| `mcp_servers` | URL, auth, status, protocol, tools |
| `mcp_sessions` | MCP session per server/conversation |
| `projects` | Name, path, boundary, active/closed state |
| `sessions` / `conversations` | Session metadata and conversation state |
| `messages` | Full role/tool history, usage, diffs |
| `session_metrics` | Iterations, tool calls/errors, tokens, duration, status |
| `request_log` | Method, route, action, status, latency, IP, bytes |
| `env_import` | Redacted environment snapshot |
| `snapshots` | Pre-write file snapshots for diff/restore |
| `runtime_log` | Runtime events |

## API surface

Frontend compatibility is kept through `index.live.php?act=ai&ai_php_api=...`:

- bootstrap: `status`, `providers`, `settings_load`, `project_info`, `projects_list`
- project: `projects_create`, `projects_close`, `projects_delete`
- session: `conversations`, `conversation`, `new_session`, `start`, `set_mode`
- messages: `clear`, `compact`, `undo`, `redo`, `regenerate`, `fork`, `abort`
- files: `file_tree`, `read_file`, `resolve_file`, `changes`, `diff`, `restore`, `shell`
- stream: `POST /frontend/stream` with `iteration-start`, `text-delta`, `tool-call`, `tool-result`, `usage`, `done`, `error`

Admin API lives under `/api/admin/*`. With `ADMIN_TOKEN_ENABLED=true`, send `X-Admin-Token` or `Authorization: Bearer`.

## Verification

The current verification is in [`php/VERIFICATION.md`](php/VERIFICATION.md). Raw results:

- `php/verification/runtime-ui-result.json`
- `php/verification/runtime-checks.json`
- `php/verification/11`–`17` screenshots

Verified with real calls, not mocks:

- InfiniteEarningZone `mission` → `PONG`
- NVIDIA `meta/muse-glimmer-30b` → `PONG`
- MCP `initialize` + `tools/list` → 101 tools
- Admin token on/off → 401/200 and 200
- PHP bootstrap → project, CSRF, identity, branding
- Admin-created project + Ollama `qwen2.5:1.5b` → `RUNTIME.md` written, 2 iterations, 1 tool call, 0 errors

## Known limitations

- **Provider execution matrix is incomplete.** Chat is verified for InfiniteEarningZone and NVIDIA; real file-writing is verified only with Ollama.
- **Gemini does not currently write files through this runtime.** It is connected, but a real tool-call/file-write path has not been proven. This is a next-session priority.
- **InfiniteEarningZone aliases are agent endpoints.** `/providers/chat` works, but the full runtime prompt + stream path did not finish within 90 seconds; tools are disabled for that provider.
- **MCP tool set is large.** The live MCP endpoint exposes 101 tools; they are disabled by default to protect small-model context.
- **Single-workspace assumption.** Multiple browser clients share the active project/conversation settings.
- **Admin auth is optional.** `ADMIN_TOKEN_ENABLED=false` is safe only on loopback or a trusted network.
- **No multi-tenant isolation.** One SQLite database, one process, one owner.

## Next session

Read [`php/RUNBOOK.md`](php/RUNBOOK.md) first. The short version:

1. Build a provider capability matrix (`chat`, `tools`, `file_write`, `stream`).
2. Add a real execution adapter/fallback for Gemini and other non-tool models.
3. Improve the admin and frontend UI/UX.
4. Add intent-based tool policy instead of exposing every enabled tool.
5. Isolate sessions/projects per client.

## Ownership

ZombieCoder runtime identity:

- Owner: Sahon Srabon
- Organization: Developer Zone
- Location: Dhaka, Bangladesh
- Website: https://zombiecoder.my.id/

This repository contains no provider secrets, SQLite data, or local `.env` file.
