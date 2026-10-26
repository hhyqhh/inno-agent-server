# Durable runtime migration

## Current stage: isolated core (3A)

`@earendil-works/pi-durable` is pinned to `1.4.0` together with the backend PI
packages. Node.js **22.19.0 or newer** is required. The first runtime boundary
lives in `apps/inno-agent/src/agent/durable-runtime.ts`.

This stage is deliberately **not connected to the default HTTP chat path**.
Existing CLI, Desktop, local sessions, and legacy PI `SessionManager` JSONL
files keep their current behavior. A later opt-in route will create durable
sessions explicitly; historical JSONL will not be migrated or opened as durable
storage.

The implemented core provides:

- one SQLite database per durable session, with a process-local double-open
  guard;
- durable admission through `requestId`, submission reacquisition by ID, and
  `resume()` on reopen;
- committed snapshots and a separate projection into Inno's existing chat event
  shapes;
- an optional workspace-read-only tool environment. Shell and all mutation
  methods fail closed even if an unintended tool is registered later.

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
from current state. It is therefore not an exact historical event feed. Inno's
existing `after=<eventId>` behavior must remain an application-level projection;
raw durable watch events must not be presented as that replay log.

Durable `message_update` events contain `changes`, not legacy PI's
`assistantMessageEvent`. `durable-projection.ts` handles those deltas, tool
updates, committed history, and retry events separately from the legacy event
adapter.

## Verification

The PostgreSQL-free suite uses only `fauxProvider()` and temporary directories.
It covers concurrent session isolation, request deduplication, close/reopen,
legacy JSONL non-interference, workspace/symlink containment, read-only
fail-closed behavior, and recovery after a real child process is killed with
`SIGKILL` during a delayed model response. No paid model endpoint is used.

Still pending: explicit new-session HTTP opt-in, tenant-derived durable roots,
real configured-provider wiring, application-persisted SSE replay after restart,
durable questions/permissions, idempotent L1/L2 writes, channel outbox,
scheduler integration, and sharded single-owner deployment.
