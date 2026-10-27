# Durable runtime migration

## Current stage: replay-safe direct learner profile mutations (3K)

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
- replay-safe, tenant-local L1 context/event/evidence tools, direct profile
  patch/update mutations, and L2 archive, query, and lint tools;
- tenant-local L1 profile/recent-event context in durable instructions;
- the same workspace `agent.md` and `.skills/` prompt sections as legacy,
  reloaded whenever the durable runtime opens;
- `ocr_image` with tenant credentials, canonical workspace file checks,
  persisted job-ID checkpoints, and cached final markdown;
- `send_file_to_channel` with a tenant-local persistent outbox, payload
  snapshots, original-target recovery, and cached completion results;
- `ask_user_question` with stable question identity, tenant-local persisted
  answers, SSE turn rebinding, and original-run recovery after restart;
- scoped active-turn cancellation through the existing chat abort endpoint,
  including pending-question cleanup and persisted pi-durable abort marks;
- structured workspace attachments on streaming and non-streaming chat, with
  canonical path validation and request-ID-deduplicated UI sidecar metadata;
- inline images persisted under `.chat-images/`, native image blocks for
  vision-capable models, OCR path hints for explicitly text-only models, and
  workspace preview restoration through the same deduplicated sidecar;
- graceful shutdown of open durable runtimes.

Shell, workspace mutations, MCP, subagents, codemode, and computer-use remain
disabled. Automatic fallback after a provider rejects a native image payload, durable permissions, branching/editing, showcase
export, and generated topics are not implemented on this path yet; unsupported
operations fail explicitly rather than falling back to legacy execution.
Workspace-private skills are injected as prompt resources; they do not alter the
process-global PI resource loader or enable otherwise unsupported durable tools.

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

Direct `patch_learner_profile` and `update_learner_profile` use operation IDs
namespaced by tool, session, and stable tool-call ID. Their pure profile mutation
and `applied_operation_ids` marker are committed by the same atomic profile write,
so replay cannot repeat append/delta operations or increment the version twice.
Legacy callers retain the original non-durable mutation path.

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

Durable structured attachments accept the existing `body.attachments` bindings
and loose-file shape on both chat endpoints. Every path is resolved against the
session workspace with canonical/symlink containment; missing or out-of-workspace
paths are dropped. The durable user input preserves the raw visible prompt as its
first text block and appends validated attachment relationships as a separate
model-only text block. History hides only that context block, then merges the
validated attachment metadata back into the matching user message for the UI.
Sidecar caches are scoped by tenant data root and `clientRequestId` deduplicates
retried metadata writes. Sidecar and SQLite commits are not a distributed
transaction; unmatched sidecar entries remain inert.

Inline `body.images` follows the same raw-prompt/model-context separation. Images
are persisted before submission under the session workspace's `.chat-images/`
directory. Durable filenames hash the request ID, image index, and bytes, so an
identical retry reuses the path while a conflicting retry cannot overwrite the
original file. Models whose resolved tenant config includes `input: ["image"]`
receive native image blocks; explicitly text-only models instead receive the
workspace paths and OCR hint as a separate hidden context block. Both modes merge
workspace preview URLs into user history through the request-ID-deduplicated
sidecar. Automatic retry without image blocks after a provider rejects a native
payload is not implemented yet.

Durable questions use the stable operation ID
`ask_user_question:<sessionId>:<toolCallId>`. Records live under the
tenant-local `durable/questions/<sessionId>/` directory, use mode `0600`, and
bind the question ID to a hash of that operation ID. An accepted answer is
persisted before its waiter is released or `question_resolved` is emitted.
Replay-safe tool re-entry returns a completed answer from disk without showing
another card; an interrupted wait remains pending and can be rebound to a new
SSE turn. A restored answer resumes the original durable run, not a synthetic
user message. Non-streaming `POST /api/chat` has no question UI: it rejects an
already-pending question with 409 and resolves new asks as `no_ui`. Accepted
question/answer records are currently retained for crash recovery;
retention/cleanup policy is still pending.

`POST /api/chat/:sessionId/:turnId/abort` now supports active durable SSE turns
after the same ownership check as other session operations. It marks the stream
cancellation, persists any current question as cancelled, and calls
`Conversation.abort()`, which commits abort marks and waits for the ordinary
run/tool scope to become idle. The SSE terminal event is `aborted`, not a
`durable_unanswered` error. Cancellation is rechecked after durable submission
admission to close the queued-input race. Once the abort has completed, reopen
does not resume that submission and a later turn can use the session normally.
Question records and pi-durable SQLite are separate commits, not a distributed
transaction; if the process dies before an abort is acknowledged, the caller
must retry/recheck rather than assuming both writes completed.

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
workspace/symlink containment, read-only fail-closed behavior, workspace
`agent.md`/private-skill injection and reload, attachment-context history
projection, inline-image retry path stability and OCR hint construction,
tenant-scoped attachment/image sidecar caching and request-ID dedup,
replay-safe L1/L2 execution, direct profile patch/update retry dedup,
L1 event/profile crash-gap recovery, deterministic L2 archive,
OCR completion caching and job-ID resume, channel payload/completion caching,
verified tenant channel rebinding, and recovery after real child processes are
killed with `SIGKILL` during a delayed model response, during an interrupted
memory tool, while a submitted OCR job is still running, after a channel send
but before its outbox completion commit, and after a question answer is
persisted but before its tool result commits. Recovered question answers do not
produce a second question event. Cancellation tests verify persisted abort
marks across close/reopen, no duplicate model call, a usable following turn,
and cancelled questions that stay resolved. No paid model endpoint or real
external channel is used.

The real-PostgreSQL integration suite additionally covers explicit HTTP
creation, concurrent authenticated durable sessions, per-tenant provider and
OCR Authorization headers, cross-tenant 404s, completed request-ID retries,
lack of legacy JSONL creation, SSE disconnect/reconnect replay, tenant-local
L1/L2/OCR writes and replay-safe direct profile patch/update through the
authenticated HTTP boundary, original-run question
answers with cross-tenant 404 and stale-turn 409 responses, non-streaming
`no_ui` question resolution, streaming/non-streaming validated workspace
attachments with raw-text history and out-of-workspace path rejection, native
vision and text-only inline-image requests with workspace previews and retry
dedup, and scoped cancellation with cross-tenant abort denial and pending-card
cleanup.

Still pending: application-persisted SSE replay after restart, durable
permissions, provider-rejection image fallback, outbox and
question retention/cleanup, scheduler integration, and sharded single-owner
deployment.
