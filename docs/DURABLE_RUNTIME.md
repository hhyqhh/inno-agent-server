# Durable runtime migration

## Current stage: static tenant-owner routing (3U)

`@earendil-works/pi-durable` is pinned to `1.4.0` together with the backend PI
packages. Node.js **22.19.0 or newer** is required. The isolated host lives in
`apps/inno-agent/src/agent/durable-runtime.ts`; the application catalog and
runtime leases live in `durable-session-service.ts`.

Durable execution is disabled by default. Set `INNO_DURABLE_ENABLED=true` to
make the Web UI default new sessions to durable. The explicit HTTP
creation contract is:

```http
POST /api/sessions
Content-Type: application/json

{"runtime":"durable"}
```

An owned existing `workspaceId` may be supplied. The authenticated temporary
workspace fallback and `newWorkspace` (temporary or named) are also supported.
`presetId` instantiates or reuses the preset's stable tenant-owned workspace.
Omitting `runtime`, or passing `"legacy"`, keeps the
existing PI `SessionManager` JSONL behavior. Historical JSONL is never migrated
or opened as durable storage.

Durable IDs have the form `durable-<uuid>` and never pass through legacy
`.jsonl` filename helpers. Each tenant has its own application catalog and
SQLite root:

- local: `<dataDir>/durable/`
- authenticated: `<dataDir>/tenants/<verifiedTenantId>/durable/`

### Optional static tenant-owner routing

Multiple workers can use independent data roots when every worker is configured
with the same static shard map and its own local ID:

```sh
INNO_DURABLE_SHARD_ID=worker-a
INNO_DURABLE_SHARD_URLS='{"worker-a":"http://worker-a:3000","worker-b":"http://worker-b:3000"}'
```

Sharding requires Better Auth, `INNO_MULTI_USER_ENABLED=true`, and
`INNO_DURABLE_ENABLED=true`. After cookie authentication and personal-tenant
provisioning, the server hashes the verified tenant ID onto the sorted shard IDs.
A non-owner forwards the untouched request, including JSON bodies and SSE, to
that owner before lazy agent bootstrap. The owner authenticates the forwarded
cookie again. Clients cannot select a tenant or shard through headers.

This colocates a tenant's catalog, workspaces, configuration, and durable SQLite
files on one worker. Each worker must have its own RWO data volume; the map does
not make a shared filesystem active-active safe. It is static routing, not
dynamic service discovery, ordered migration, failover, or network-partition
fencing. `/api/auth/*`, `/api/session`, and health checks remain local. The
bearer-authenticated public bridge callback does not yet have tenant-owner
forwarding, so sharded channel ingress remains pending.

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
  guard, application-level idle leases, and an authenticated PostgreSQL advisory
  lock held for each open runtime's lifetime;
- durable admission, submission reacquisition, and `resume()` on reopen;
- concurrent independent sessions without the legacy global prompt queue;
- preset instantiation into stable tenant-owned workspaces, including `agent.md`
  and private skills, with repeated opens reusing the preset workspace;
- committed snapshots and existing Inno history/SSE event shapes;
- tenant-local application SSE journals with exact numeric event replay and
  original-submission recovery after a process restart;
- workspace-contained `read`, `write`, and exact-replacement `edit` tools,
  including automatic parent creation and canonical symlink containment;
  streaming turns emit `workspace_change` events and persist tenant-local file
  activity so the existing workspace UI refreshes written files;
- replay-safe, tenant-local L1 context/event/evidence tools, direct profile
  patch/update mutations, and L2 archive, query, and lint tools;
- tenant-local L1 profile/recent-event context in durable instructions;
- explicit `l3_recall` and threshold-gated automatic recall over
  ownership-filtered legacy and committed durable history, with verified tenant
  ALS restored when durable work resumes outside the HTTP request;
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
  same-submission OCR fallback when a provider rejects a native payload;
  workspace previews restore through the same deduplicated sidecar;
- first-message fallback topics, automatic richer upgrades after six messages,
  and explicit `POST /api/sessions/:id/generate-topic`, all using the durable
  session's pinned provider/model and isolated tenant credentials;
- graceful shutdown of open durable runtimes;
- 30-day retention of completed channel/question recovery records, cleaned only
  after the owning session is proved idle, plus outbox removal on session delete;
- explicit durable agent-job execution through the existing manual, cron, and
  deferred scheduler paths, with owned scheduler sessions/workspaces and the
  existing occurrence, check-in, run-ledger, and channel behavior.

Shell, append/truncate, delete, rename, and other workspace mutations, MCP,
subagents, codemode, and computer-use remain disabled. Durable permissions,
branching/editing, and showcase export are not implemented on this path yet;
unsupported operations fail explicitly rather than falling back to legacy execution.
Workspace-private skills are injected as prompt resources; they do not alter the
process-global PI resource loader or enable otherwise unsupported durable tools.

## Recovery and delivery semantics

Durable uses SQLite WAL with `synchronous = NORMAL`. Committed work survives a
process crash; the newest commits may be lost on host or power failure. This is
not an exactly-once guarantee for paid model calls or external side effects.

Workspace file writes are also outside the SQLite transaction. A crash after
the OS write but before the tool-result commit can replay the operation:
`write` repeats the same content, while an `edit` retry can report that its
`oldText` no longer matches. The current file tools therefore do not claim
exactly-once mutation recovery.

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

Durable L3 recall reuses the tenant-scoped session index and excludes the
active durable session. Every committed durable snapshot incrementally indexes
its projected user/assistant text into the same tenant-local L3 store, gated by
the last committed entry revision. Repeating a revision is a no-op; a newer
snapshot replaces that session's derived chunks. Hidden attachment/OCR context,
thinking, and tool payloads do not enter the index. Snapshots are indexed when
history is read or a turn completes; recall does **not** bulk-open every durable
runtime, which could otherwise resume unrelated unfinished work. Authenticated
indexing and recall re-enter the verified tenant context and check session
ownership. Index updates are idempotent derived state and continue while recall
is disabled, so re-enabling L3 has no indexing gap. Before each HTTP submission,
the same threshold-gated recall and formatting used by legacy runs produces a
separate model-only text block. The raw prompt remains the first user block;
history projection and L3 indexing hide the injected recall section. The block
is committed with the durable input, so recovery reuses the original context
without another recall or a synthetic user turn. Recall failure is best-effort
and leaves the prompt unchanged.

Durable topics share the legacy excerpt, cleaning, and fallback helpers. The
first submission records a generated first-message preview; a completed turn
with at least six messages triggers one background richer upgrade. Generation
uses a stateless `ModelRuntime.completeSimple()` call built from the verified
tenant configuration captured at launch and the catalog's pinned
provider/model, not the legacy active session or a later default-model change.
It does not append to durable history. Per-tenant/session promises deduplicate
concurrent generation, and automatic writes recheck the catalog so a manual
rename wins even when a completion is already in flight. Manual generation is
available through the existing generate-topic endpoint. Generated/upgraded
markers live in the tenant-local durable catalog; older records without those
markers are treated as final and are not automatically overwritten.

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
**at-least-once**, not exactly-once. Completed outbox records and payload
snapshots are retained for 30 days by default. Cleanup runs before `resume()`
only when `Harness.inspect()` reports no live tasks or unsettled submissions,
and only for the opening session's operation-ID prefix. Pending sends and other
sessions are never age-pruned; stale temporary/orphan payloads can be removed.
Deleting a durable session removes all of its outbox records immediately.

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
workspace paths and OCR hint as a separate hidden context block. Native attempts
hide that committed hint. If the provider rejects the image payload, the model
stream wrapper retries the same generation with every image block removed and
the OCR hints restored; it does not create another durable submission, request
ID, or visible user message. A capability rejection is cached for the current
runtime, while malformed payloads do not permanently disable native images.
The cache is in memory, so recovery after a restart can make one new native
attempt before falling back again. Both modes merge workspace preview URLs into
user history through the request-ID-deduplicated sidecar. Provider calls remain
at-least-once across crashes; the fallback does not claim exactly-once billing.

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
question/answer records are retained for 30 days by default and pruned under the
same proven-idle rule as channel completions. Pending questions are never
age-pruned, because they may still be needed by the original run.

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

## Scheduler execution

`POST/PATCH /api/jobs` accepts `runtime: "legacy" | "durable"`; omitted runtime
keeps legacy behavior. The selector applies to agent tasks. Reminder tasks are
rejected for durable execution rather than writing an assistant notification
into legacy JSONL. Manual runs follow the target session's actual runtime, so a
legacy job can explicitly run in a durable session and vice versa. A local
non-streaming durable manual run without a session creates its own durable
scheduler session.

Automatic and deferred runs use the job's runtime when creating their owned
scheduler session/workspace. Durable sessions record `origin: "scheduler"`;
manual runs apply the same badge to an existing durable target. Background
service scopes derive tenant identity only from the scheduler's verified ALS,
never from job payloads or tenant headers. Headless runs bind durable questions
as `no_ui`; manual streaming reuses the persisted question bridge and cancels an
unanswered card if its only live view disconnects. The existing job-stop route
can abort the active durable job turn.

`agent/durable-job-runner.ts` owns durable admission, hidden automatic L3
context, live event projection, and final snapshot persistence. The shared
`executeJob` boundary still owns run ledgers, check-in reconciliation, channel
push, and completion/failure notices. PostgreSQL `durableClaims` occurrence
leases are distinct from pi-durable execution and are unchanged. A durable job
never falls back to the legacy global prompt queue or a synthetic `.jsonl` path.
Crash recovery remains at-least-once at the occurrence/model/external-delivery
boundaries; this stage does not make deferred countdowns or scheduler ledgers
cross-process durable queues.

One durable storage has **one owner at a time**. In authenticated mode,
`TenantStore.acquireDurableStorageLock()` additionally holds a session-level
PostgreSQL advisory lock on a dedicated connection before opening SQLite. A
second process cannot acquire that session until the first runtime closes and
unlocks it; process death releases the lock when PostgreSQL drops the connection.
A lock-connection error invalidates and closes the old runtime instead of leaving
it active without its ownership guard. Local mode retains the process-local
double-open guard and remains single-process.

The advisory lock has no expiry-based takeover: a paused old owner must not lose
its lock merely because a timer elapsed. It prevents accidental concurrent opens
while PostgreSQL connectivity is healthy, but it is **not storage-level fencing
against every network partition**. It does not provide tenant routing, automatic
failover, or permission to mount one SQLite database into active-active workers
or through NFS. Sharded deployment still requires a unique conversation owner,
per-shard RWO storage, ordered old-owner shutdown, and an explicitly fenced
failure-takeover procedure.

## SSE is an application projection

`watchEvents()` supplies a current snapshot and live coding-agent-like events.
Overflow can replace pending batches with a snapshot, and a new watcher starts
from current state. It is therefore not an exact historical event feed. Raw
watch events are never presented as Inno's replay log.

Durable `message_update` events contain `changes`, not legacy PI's
`assistantMessageEvent`. `durable-projection.ts` handles those deltas, tool
updates, committed history, and retry events separately from the legacy event
adapter. The existing `StreamRegistry` supplies numeric event IDs and exact
`after=<eventId>` replay. Disconnecting the HTTP response does not cancel
admitted durable work.

`agent/durable-stream-store.ts` adds a tenant-local JSONL journal per streaming
turn under `durable/streams/<sessionId>/`. The initial mode-`0600` record stores
the turn snapshot and exact `UserInput` before admission. Later records append
compacted Inno envelopes, the durable submission ID, and cancellation. A crash
between SQLite admission and the ID append is recovered by submitting the same
stored input and `requestId`, which reacquires rather than duplicates the original
submission. No synthetic user message is created.

Status, event replay, question response, abort, and new-chat conflict checks
restore the journal before consulting the process-local registry. Event replay
also restarts one per-turn projection that reopens the runtime, rebinds question
cards, watches new events, waits for the original submission, and writes the
terminal persistence result. A completed journal is retained for five minutes,
matching the existing in-memory reconnect window; active journals are not
age-pruned, and session deletion removes the session's journals. Legacy JSONL
chat remains process-local and does not use this journal. Journal appends and
SQLite commits are not a distributed transaction, and host/power loss can lose
recent appends just as it can lose recent WAL commits; the recovery guarantee is
for process crash/restart with an intact journal within the single-owner
deployment boundary.

## Capacity baseline

`npm run benchmark:durable` exercises minimal durable runtimes with faux delayed
providers, independent-session concurrency, RSS/event-loop/SQLite measurements,
and a real SIGKILL/reopen check. See [DURABLE_CAPACITY.md](./DURABLE_CAPACITY.md)
for the recorded local baseline and metric boundaries. It does not include the
HTTP/tenant/tool stack and is not sufficient to choose production shard sizes.

## Verification

The PostgreSQL-free suite uses only `fauxProvider()` and temporary directories.
It covers concurrent session/tenant roots, isolated configured model/auth
runtimes, request deduplication across idle close/reopen, stable committed
revisions, busy-delete rejection, legacy JSONL non-interference,
workspace/symlink containment for reads and writes, lexical/canonical workspace
aliases, disabled shell/delete/rename/append behavior, workspace
`agent.md`/private-skill injection and reload, attachment-context history
projection, inline-image retry path stability, provider-rejection OCR fallback
in the same submission with capability caching and request-ID dedup,
tenant-scoped attachment/image sidecar caching and request-ID dedup,
replay-safe L1/L2 execution, explicit L3 recall, revision-idempotent durable-history
indexing with current-session exclusion and hidden automatic-recall projection,
direct profile patch/update retry dedup,
durable topic upgrade dedup, pinned-model selection, and manual-rename protection,
L1 event/profile crash-gap recovery, deterministic L2 archive,
OCR completion caching and job-ID resume, channel payload/completion caching,
verified tenant channel rebinding, proven-idle 30-day outbox/question retention
with live-recovery preservation and session-delete outbox cleanup, legacy/durable
scheduler routing with fail-closed unwired execution, local legacy cron
compatibility, durable headless `no_ui` and streaming projection, exact SSE journal
restore with submission intent and truncated-final-append handling, and recovery after real child processes are
killed with `SIGKILL` during a delayed model response, during an interrupted
memory tool, while a submitted OCR job is still running, after a channel send
but before its outbox completion commit, and after a question answer is
persisted but before its tool result commits. Recovered question answers do not
produce a second question event. Cancellation tests verify persisted abort
marks across close/reopen, no duplicate model call, a usable following turn,
and cancelled questions that stay resolved. No paid model endpoint or real
external channel is used.

The real-PostgreSQL integration suite additionally covers explicit HTTP
creation, a two-worker static-routing topology where a non-owner forwards the
verified tenant's configuration, session creation, and SSE chat while durable
SQLite storage appears only on the selected owner, concurrent authenticated durable sessions, tenant-owned durable preset
instantiation and stable workspace reuse, durable workspace writes with
SSE `workspace_change` events and tenant-local file activity, PostgreSQL advisory-lock
contention/release and runtime invalidation on lock loss, per-tenant provider and
OCR Authorization headers, cross-tenant 404s, completed request-ID retries,
lack of legacy JSONL creation, SSE disconnect/reconnect replay, HTTP SIGKILL/restart
recovery of an admitted SSE turn with contiguous event IDs and no duplicate user
history, tenant-local
L1/L2/OCR writes, replay-safe direct profile patch/update, and tenant-scoped L3
recall through the authenticated HTTP boundary, tenant-isolated explicit and
automatic recall of previously committed durable sessions without exposing
injected context as user history, automatic and manual durable
topic generation with per-tenant credentials and pinned-model selection,
original-run question
answers with cross-tenant 404 and stale-turn 409 responses, non-streaming
`no_ui` question resolution, streaming/non-streaming validated workspace
attachments with raw-text history and out-of-workspace path rejection, native
vision and text-only inline-image requests with workspace previews and retry
dedup, provider-rejection native-image fallback without duplicate user history,
and scoped cancellation with cross-tenant abort denial and pending-card
cleanup. Scheduler coverage includes manual durable streaming/non-streaming runs,
runtime validation, scheduler-origin history, tenant channel delivery, and mixed
durable/legacy deferred execution with per-tenant credentials, owned workspaces,
run ledgers, and claim cleanup.

Still pending: durable permissions, sharded public bridge ingress, per-shard RWO
deployment manifests, and ordered/fenced failure takeover. Static tenant-owner
routing is implemented and covered by a real two-worker integration test.
