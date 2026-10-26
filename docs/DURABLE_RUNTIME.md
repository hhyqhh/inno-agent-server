# Durable runtime migration

## Current stage: explicit HTTP opt-in (3B)

`@earendil-works/pi-durable` is pinned to `1.4.0` together with the backend PI
packages. Node.js **22.19.0 or newer** is required. The isolated host lives in
`apps/inno-agent/src/agent/durable-runtime.ts`; the application catalog and
runtime leases live in `durable-session-service.ts`.

Durable execution is disabled by default. Set `INNO_DURABLE_ENABLED=true`, then
create a session explicitly:

```http
POST /api/sessions
Content-Type: application/json

{"runtime":"durable"}
```

An owned existing `workspaceId` may be supplied. The authenticated temporary
workspace fallback is also supported. `presetId` and `newWorkspace` are not yet
supported on this creation path. Omitting `runtime`, or passing `"legacy"`,
keeps the existing PI `SessionManager` JSONL behavior. Historical JSONL is never
migrated or opened as durable storage.

Durable IDs have the form `durable-<uuid>` and never pass through legacy
`.jsonl` filename helpers. Each tenant has its own application catalog and
SQLite root:

- local: `<dataDir>/durable/`
- authenticated: `<dataDir>/tenants/<verifiedTenantId>/durable/`

Tenant identity comes only from the verified request context. PostgreSQL
resource ownership is claimed for every authenticated durable session and is
checked before catalog, detail, chat, status, or replay access. Cross-tenant
resource access returns 404.

`POST /api/chat/stream` and `POST /api/chat` accept durable IDs through their
existing contracts. `clientRequestId` becomes the conversation-scoped durable
`requestId`; a completed retry resolves the original submission without another
model call. Session list/detail, rename, archive, activate, workspace lookup,
and deletion have durable implementations. Activate does not switch the legacy
singleton runtime.

Each open builds an isolated `ModelRuntime` from the resolved local/tenant
config with an in-memory credential store. It does not read the shared legacy
`models.json` or `auth.json`. Provider credentials are not copied between
sessions or tenants. Idle runtimes close; the next operation reopens and resumes
the SQLite storage, rebuilding model/auth configuration at execution time.

## Supported and deliberately unsupported

The current durable slice supports:

- one SQLite database per durable session, with a process-local double-open
  guard and application-level idle leases;
- durable admission, submission reacquisition, and `resume()` on reopen;
- concurrent independent sessions without the legacy global prompt queue;
- committed snapshots and existing Inno history/SSE event shapes;
- the workspace-read-only `read` tool, including canonical symlink containment;
- graceful shutdown of open durable runtimes.

Shell, mutations, MCP, subagents, codemode, and computer-use remain disabled.
Attachments, L1/L2 tools, durable questions/permissions, branching/editing,
showcase export, generated topics, and turn cancellation are not implemented on
this path yet; unsupported operations fail explicitly rather than falling back
to legacy execution. The workspace `agent.md` and private-skill prompt context
are not injected yet.

## Recovery and delivery semantics

Durable uses SQLite WAL with `synchronous = NORMAL`. Committed work survives a
process crash; the newest commits may be lost on host or power failure. This is
not an exactly-once guarantee for paid model calls or external side effects.

A repeated `requestId` returns the original submission in the same conversation.
After restart, `Harness.open()` followed by `resume()` continues unfinished
work, and `harness.submission(id)` reacquires its receipt. Tool recovery depends
on each tool's replay policy; the initial slice does not enable side-effecting
tools.

One durable storage has **one owner at a time**. The in-process guard does not
replace deployment routing, lease/fencing, or an ordered old-owner shutdown.
Never mount the same SQLite database into active-active workers or share it
through NFS.

## SSE is an application projection

`watchEvents()` supplies a current snapshot and live coding-agent-like events.
Overflow can replace pending batches with a snapshot, and a new watcher starts
from current state. It is therefore not an exact historical event feed. Raw
watch events are never presented as Inno's replay log.

Durable `message_update` events contain `changes`, not legacy PI's
`assistantMessageEvent`. `durable-projection.ts` handles those deltas, tool
updates, committed history, and retry events separately from the legacy event
adapter. The existing `StreamRegistry` supplies numeric event IDs and exact
`after=<eventId>` replay **within the current process**. Disconnecting the HTTP
response does not cancel admitted durable work. Application replay state is
still lost on process restart; committed conversation history remains readable,
but cross-restart SSE replay is not claimed yet.

## Verification

The PostgreSQL-free suite uses only `fauxProvider()` and temporary directories.
It covers concurrent session/tenant roots, isolated configured model/auth
runtimes, request deduplication across idle close/reopen, stable committed
revisions, busy-delete rejection, legacy JSONL non-interference,
workspace/symlink containment, read-only fail-closed behavior, and recovery
after a real child process is killed with `SIGKILL` during a delayed model
response. No paid model endpoint is used.

The real-PostgreSQL integration suite additionally covers explicit HTTP
creation, concurrent authenticated durable sessions, per-tenant provider
Authorization headers, cross-tenant 404s, completed request-ID retries, lack of
legacy JSONL creation, and SSE disconnect/reconnect replay.

Still pending: application-persisted SSE replay after restart, durable
questions/permissions/cancellation, workspace prompt context and attachments,
idempotent L1/L2 writes, channel outbox, scheduler integration, and sharded
single-owner deployment.
