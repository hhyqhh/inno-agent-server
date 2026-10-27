# Durable runtime migration

## Current stage: persistent channel outbox (3E)

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
- replay-safe, tenant-local L1 context/event/evidence tools and L2 archive,
  query, and lint tools;
- tenant-local L1 profile/recent-event context in durable instructions;
- `ocr_image` with tenant credentials, canonical workspace file checks,
  persisted job-ID checkpoints, and cached final markdown;
- `send_file_to_channel` with a tenant-local persistent outbox, payload
  snapshots, original-target recovery, and cached completion results;
- graceful shutdown of open durable runtimes.

Shell, workspace mutations, MCP, subagents, codemode, and computer-use remain
disabled. Direct `patch_learner_profile` and `update_learner_profile` mutations
are not exposed on the durable path yet. Attachments, durable
questions/permissions, branching/editing, showcase export, generated topics,
and turn cancellation are not implemented on this path yet; unsupported
operations fail explicitly rather than falling back to legacy execution. The
workspace `agent.md` and private-skill prompt context are not injected yet.

## Recovery and delivery semantics

Durable uses SQLite WAL with `synchronous = NORMAL`. Committed work survives a
process crash; the newest commits may be lost on host or power failure. This is
not an exactly-once guarantee for paid model calls or external side effects.

A repeated `requestId` returns the original submission in the same conversation.
After restart, `Harness.open()` followed by `resume()` continues unfinished
work, and `harness.submission(id)` reacquires its receipt. Memory tools are
registered as replay-safe; an interrupted committed tool intent therefore
re-executes with the same provider tool-call ID after reopen.

Replay safety requires application-level idempotency. Durable L1 event and
evidence operations use IDs namespaced by session and tool call. The event is
appended first; all derived profile changes and an `applied_operation_ids`
marker are then committed together through the existing atomic profile write.
A retry with the marker returns the persisted result without reapplying it. A
crash between the event append and profile commit instead reuses the persisted
event and applies its signals once. This closes the event/profile crash gap
within the single-process/single-owner boundary; it is not a general
exactly-once guarantee for model calls or external effects.

Durable L2 archive uses deterministic conversion and page generation, disabling
nested summarization/rich-page model calls. Existing content-hash deduplication
and manifest records resume incomplete archives. Durable query skips the legacy
append-only query log. L1/L2 feature gates and tenant data roots are preserved;
memory writes never use the legacy global tenant root in authenticated mode.

Durable OCR stores checkpoints under the tenant-local `ocr/` directory, keyed
by a hash of the session/tool-call operation ID. It writes the remote `jobId`
immediately after submission, resumes polling that job after reopen, and caches
the final markdown so a completed tool retry performs no remote calls. Secrets
are not written to checkpoints. The OCR API has no idempotency key: a crash
after the remote service accepts a submission but before the local `jobId`
commit can still duplicate that one remote job. Recovery is therefore
exactly-once only after the job ID is persisted, not for external submission.

Durable channel file sends snapshot the payload and persist the channel, chat
ID, original path, and optional file name under the tenant-local
`channels/outbox/` directory before external delivery. Recovery uses that
snapshot and original target even if the workspace file disappears or the
tenant's default target changes. A successful send commits a completion marker;
a completed retry returns the cached result before channel lookup or another
send. Authenticated registry lookups re-enter the verified tenant context when
durable work resumes outside the original HTTP request's async context. Channel
APIs have no common idempotency key, so a crash after external delivery but
before the completion commit can send the file again: delivery is
**at-least-once**, not exactly-once. Outbox snapshots and completion records are
currently retained; retention/cleanup policy is still pending.

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
workspace/symlink containment, read-only fail-closed behavior, replay-safe
L1/L2 execution, L1 event/profile crash-gap recovery, deterministic L2 archive,
OCR completion caching and job-ID resume, channel payload/completion caching,
verified tenant channel rebinding, and recovery after real child processes are
killed with `SIGKILL` during a delayed model response, during an interrupted
memory tool, while a submitted OCR job is still running, and after a channel
send but before its outbox completion commit. No paid model endpoint or real
external channel is used.

The real-PostgreSQL integration suite additionally covers explicit HTTP
creation, concurrent authenticated durable sessions, per-tenant provider and
OCR Authorization headers, cross-tenant 404s, completed request-ID retries,
lack of legacy JSONL creation, SSE disconnect/reconnect replay, and tenant-local
L1/L2/OCR writes through the authenticated HTTP boundary.

Still pending: application-persisted SSE replay after restart, durable
questions/permissions/cancellation, workspace prompt context and attachments,
direct durable profile patch/update, outbox retention/cleanup, scheduler
integration, and sharded single-owner deployment.
