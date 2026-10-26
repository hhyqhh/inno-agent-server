# Authentication (stage 1)

Inno Agent defaults to the existing single-user `local` mode. It does not need
PostgreSQL and listens on loopback unless network exposure is explicitly
allowed. Better Auth is an optional account layer for controlled deployments:

```sh
INNO_AUTH_MODE=better-auth \
DATABASE_URL=postgresql://inno:inno@127.0.0.1:5432/inno \
BETTER_AUTH_SECRET='replace-with-at-least-32-random-characters' \
BETTER_AUTH_URL=http://localhost:3000 \
npm run auth:migrate --workspace inno-agent

INNO_AUTH_MODE=better-auth \
DATABASE_URL=postgresql://inno:inno@127.0.0.1:5432/inno \
BETTER_AUTH_SECRET='replace-with-at-least-32-random-characters' \
BETTER_AUTH_URL=http://localhost:3000 \
npm run server
```

Run migrations explicitly before starting the server. The request path and
server startup never create or alter tables. Startup fails if required auth
configuration is missing, PostgreSQL is unavailable, or the auth schema has not
been migrated. The generated Better Auth 1.7.12 schema is reviewed and pinned
at `apps/inno-agent/src/db/better-auth-schema.sql`; `npm run auth:schema
--workspace inno-agent` prints the migration SQL for a configured database.

`INNO_AUTH_ALLOW_SIGNUP=false` disables public email/password registration.
Existing users can still sign in. Cookies are HttpOnly, same-origin browser
credentials; the frontend does not store session tokens in local storage.
Cross-origin browser requests and terminal WebSockets are restricted to
`BETTER_AUTH_URL` and optional comma-separated `INNO_TRUSTED_ORIGINS`.

`/health`, `/api/health`, `/api/auth/*`, and the independently authenticated
`POST /api/bridge/messages` endpoint are public. Other APIs and terminal
WebSockets require a valid session in Better Auth mode.

For local development, `docker compose up postgres` starts PostgreSQL. The
compose application retains the explicit insecure local-mode override because
its port is published; use Better Auth for non-local deployments.

> **Isolation boundary:** account authentication and the current tenant/ownership
> slices do not yet constitute production multi-user approval. Better Auth mode
> disables PI host shell/file tools and PTY terminals, and confines retained
> custom path tools to the owned session workspace. File-backed runtimes are not
> cross-process active-active. `INNO_MULTI_USER_ENABLED=true` deliberately fails
> at startup until the remaining isolation review is complete. Public registration
> additionally requires rate limiting, email verification, and account recovery
> before an internet-facing launch.

## File-backed deployment boundary

The current server is a **single-process, single-replica** runtime even when
Better Auth and PostgreSQL are enabled. PostgreSQL owns account, tenant,
resource-ownership, and job-occurrence claim metadata; it does not make PI
session files, tenant L1/L2/L3 files, workspaces, terminals, in-memory prompt
queues, SSE buffers, or deferred countdowns shareable between processes.

- Run exactly one application process against a data/workspace root. Do not
  mount the same root into active-active replicas or share it through NFS.
- During an upgrade, stop the old process and wait for graceful shutdown before
  starting its replacement against the same files. A rolling two-replica
  deployment is not supported by this runtime.
- The job lease prevents concurrent occurrence claims and permits takeover
  after expiry. It is not a general storage lock, a durable deferred queue, or
  an exactly-once boundary around model calls and channel delivery.
- Multiple accounts may share the process only after the remaining isolation
  review is complete and `INNO_MULTI_USER_ENABLED` is explicitly made available.
  Better Auth alone is not production multi-user approval.

## Personal tenant foundation (stage 2A)

`auth:migrate` also creates personal tenants, owner memberships, and a global
resource-ownership table. Provisioning is transactional and safe under
concurrent first requests. Every resource has at most one owner; ownership is
never inferred from a client-provided tenant or user id.

Existing files are not assigned to the first user who signs in. After creating
the intended owner account and running `auth:migrate`, inspect and then execute
the explicit backfill:

```sh
INNO_LEGACY_OWNER_EMAIL=owner@example.com \
INNO_AUTH_MODE=better-auth DATABASE_URL=... \
BETTER_AUTH_SECRET=... BETTER_AUTH_URL=http://localhost:3000 \
npm run tenants:legacy --workspace inno-agent -- --dry-run

# Review the report, then repeat with --execute. Repeats are idempotent and
# resources already owned by another tenant are reported as conflicts.
```

The dry run creates neither tenants nor ownership rows. This commit establishes
the persistence/migration layer; HTTP domain enforcement is added separately.
The legacy shared `tmp` workspace is deliberately excluded: its directory has
no safe single owner. In Better Auth mode, each tenant receives a separate
`tmp-<tenantId>` workspace and directory instead. Files left in the legacy
shared `.tmp` directory are not exposed by the tenant-aware workspace API.

## Session/workspace isolation (stage 2B)

The verified Better Auth session now provisions the request's personal tenant;
clients cannot select a tenant through a header or body field. Session and
workspace listings contain only owned resources. Session detail/export/edit/
activate/delete, chat and SSE replay, side questions, workspace CRUD/import,
file operations, and session/workspace rebinding reject cross-tenant IDs with
404. New resources are claimed at creation and deleted resources release their
ownership rows. Resources without an explicit legacy ownership assignment are
hidden in Better Auth mode. Local mode retains the existing shared `tmp`
behavior.

This is still partial application isolation: background jobs/channels and their
memory access, settings, permissions, and the singleton agent runtime
have their own remaining migration work.
`INNO_MULTI_USER_ENABLED` therefore remains unavailable.

## L1/L2/L3 tenant storage (stage 2C)

Authenticated `/api/learner/*`, `/api/wiki/*`, and `/api/l2/raw/upload` requests
use `<dataDir>/tenants/<tenantId>/learner` and `.../l2`. Each tenant has separate
profile/event files, wiki files, manifest, and L2 index. Legacy global memory is
not visible through these HTTP APIs and is not copied implicitly. Local mode
continues using the original global directories.

Authenticated web agent execution resolves L1/L2/L3 storage through the same
request tenant context. L3 uses a separate SQLite database per tenant, indexes
only owned sessions, and rechecks ownership when returning recall results.
Background jobs/channels still use legacy global services until their own
migration; they must not be treated as tenant-safe.

Jobs, channels, settings, permissions, and the singleton agent runtime
still have remaining migration work. `INNO_MULTI_USER_ENABLED` therefore remains
unavailable.

## Terminal and run isolation (stage 2D)

Terminal creation checks both session and workspace ownership. Terminal close
and WebSocket upgrades check the terminal claim and its parent session; a
cross-tenant WebSocket receives 404 after cookie authentication. Run listings,
details, and archive operations also require ownership of the parent session.
Run records live under `<dataDir>/tenants/<tenantId>/runs`, and run archives use
that tenant's L2 root. Local mode keeps the original shared run directory.

Background jobs/channels, settings, permissions, and the singleton agent runtime
still have remaining migration work. `INNO_MULTI_USER_ENABLED` remains
unavailable.

## Job and check-in isolation (stage 2E)

Authenticated job and check-in storage uses `<dataDir>/tenants/<tenantId>/jobs`
and `.../checkins`. HTTP and agent-tool list/update/delete/run-history views are
resolved at execution time, so legacy global jobs and other tenants' jobs are
not visible. New jobs receive ownership metadata and deletion releases it.
Manual run/stream/stop operations require an owned target session; authenticated
API runs must specify that session explicitly. Agent-initiated unscoped runs are
temporarily rejected rather than falling back to the global active session.

Automatic cron and deferred execution currently start only in local mode.
At this stage channel-backed tenant jobs are rejected pending tenant-scoped
channel registries and delivery; stage 2H later enables request-scoped manual
channel delivery. Legacy global job files remain hidden and are not copied
implicitly.

Channels, settings, global permission policy, background execution, and the singleton agent
runtime still have remaining migration work at this stage.
`INNO_MULTI_USER_ENABLED` remains unavailable.

## Permission approval isolation (stage 2F)

`allow_session` permission approvals are cached by tenant, session, agent run,
and normalized command/path. Cached approvals require a currently bound turn;
they never authorize a headless/no-UI request. Changing any tenant, session, or
run requires a new approval. Pending responses remain bound to the exact
session/turn/request, and chat permission-response routes retain their session
ownership checks. Authenticated mode now forces the managed default permission
policy rather than allowing tenants to change process-global `auto`/`yolo`
settings; see stage 2G.

## Settings and model credential isolation (stage 2G)

Authenticated settings use `<dataDir>/tenants/<tenantId>/config/config.json`.
New accounts start with no providers and do not inherit provider, OCR, Tavily,
or integration credentials from the legacy/global config. The local global
configuration still requires at least one provider, and local/CLI/Desktop
behavior is unchanged.

Providers/default model, L1/L2/L3 memory flags, OCR/Tavily, smart input, and UI
preferences persist per tenant. Provider IDs are tenant-local namespaces: the
main prompt path refreshes and binds the current tenant's endpoint and model
inside the serialized prompt queue, so equal provider IDs in two accounts do
not share credentials. Accounts without a configured model fail before making
a provider request. Side questions and automatic-title completions bypass the
shared queue and therefore construct their model/auth target directly from the
current tenant config instead of reading another tenant's registry state.
`model_select` persistence likewise targets the current tenant file.

Authenticated mode disables MCP, subagents, pi-web-access, codemode, and
computer-use because those extensions still load process-global configuration.
Their settings writes, content-hub credentials/settings, and permission-policy
overrides return 409 rather than pretending to be isolated. Permission policy
is always managed `default`, preserving the deny floor; process-global
`bypassProxy` is rejected for tenant providers.

At this stage channels, automatic/deferred background execution, and remaining
singleton runtime state still require migration. `INNO_MULTI_USER_ENABLED`
remains unavailable.

## Channel runtime isolation (stage 2H)

Authenticated channels resolve through `TenantChannelManager`, which lazily
creates a separate registry, dispatcher, and channel data directory under
`<dataDir>/tenants/<tenantId>/channels`. Default targets, dedupe state, run logs,
and channel-to-chat session mappings are therefore tenant-local. Channel-created
sessions and workspaces receive ownership claims before their binding or prompt
is used; persisted session bindings are reauthorized before reuse. Channel and
topic session metadata also use the current tenant's session data root.

External identities are claimed in PostgreSQL as `channel` resources: bridge
credentials use `bridge:<sha256(token)>`, Feishu uses `feishu:<appId>`, and
WeChat iLink uses `wechat:<botId>`. A second tenant cannot take over an owned
connection. Public bridge callbacks recover tenant context only from the token's
persisted ownership, never from a request body or custom tenant header; unknown
tokens return 401 and tenant bridge messages must include a real `chatId`.
Native callbacks explicitly restore their runtime's tenant context. Feishu
device flows and WeChat QR confirmation are bound to the initiating tenant, and
channel reload/shutdown stops tenant-owned polling and cleanup timers.

Channel settings persist to the current tenant config, with ownership claimed
before activation and rolled back best-effort if persistence fails. Local mode
retains the original global registry, config, and directories. Authenticated
agent file sends cannot fall back to the deployment workspace and reject
symlink escapes from the resolved session workspace.

Channel-backed jobs may use the current tenant's default target for explicit,
request-scoped manual runs into an owned session. At this stage automatic cron/
deferred execution remains local-only; stage 2I later adds tenant background
execution. Agent-initiated job execution without an explicit session still
returns `scoped_runtime_unavailable`. `INNO_MULTI_USER_ENABLED` remains
unavailable.

## Tenant background execution (stage 2I)

`auth:migrate` now also creates `job_run_claims`. Authenticated scheduling uses
`TenantCronScheduler` to enumerate job owners from PostgreSQL and restore each
owner's tenant context for storage, model, memory, and channel access. Legacy
global jobs remain invisible, and every automatic run creates and claims an
explicit scheduler session and workspace instead of using the shared active
session or inferring a channel from it.

Cron, deferred auto-execution, and manual learning-occurrence runs use an atomic
occurrence lease. The lease has a random owner token, a five-minute expiry, and
heartbeat renewal; release and renewal are fenced by that token. Concurrent
claims have one winner, another tenant cannot claim the job, and an expired lease
can be taken over after a crash. Claims are released after an attempt, while the
job and check-in ledgers persist completion. This is at-least-once recovery, not
exactly-once model execution or channel delivery: a crash between an external
side effect and the ledger update can repeat that side effect.

Deferred countdown state is keyed by tenant and captures its verified context
for the timer callback. Cancellation, manual takeover, and graceful shutdown
release pending claims. The visible countdown list remains process-local rather
than a cross-process durable queue; after a crash, cron re-arms work from the
persistent job/check-in state once the old lease expires. Local mode retains its
original in-memory occurrence claims and scheduler behavior.

Agent-initiated runs without an explicit session remain rejected. The shared
runtime audit and remaining host-execution boundary are covered by stage 2J;
`INNO_MULTI_USER_ENABLED` remains unavailable.

## Shared-runtime audit (stage 2J)

The process-global skill directory is now admin-managed and read-only in Better
Auth mode. Authenticated uploads, imports, edits, enable/disable, deletion, and
reload requests return 409 before touching shared files or the PI resource
loader. The shared catalog remains readable, and workspace-private `.skills`
continue through the owned workspace routes. Local mode retains full skill
management.

The remaining singleton `AgentSession` is an intentional serialized runtime,
not a per-tenant session pool. Authenticated prompts must name an owned session;
session switching, prompt execution, tenant provider/model binding, and prompt
finalization occupy the same queue slot. Side-channel completions derive their
model credentials directly from the current tenant config instead of reading
the mutable registry. Question and permission waits are bound to the exact
session/turn, stream replay requires session ownership, and the bundled todo
tool partitions live state by PI session id. Process-global read-only skill and
preset catalogs are shared deliberately.

Stage 2K adds the restricted host-execution boundary. Public sign-up still
requires rate limiting, verification, and recovery for an internet-facing launch.
`INNO_MULTI_USER_ENABLED` remains unavailable, and the single-process file-backed
deployment boundary above still applies.

## Restricted host execution (stage 2K)

Better Auth mode no longer exposes the server process's shell and general host
filesystem to agent turns. Every authenticated turn removes PI's `bash`, `read`,
`write`, `edit`, `grep`, `find`, and `ls` tools from the active tool list, with a
second dispatch-time deny guard for stale calls. Terminal creation returns 409
before spawning node-pty, and terminal WebSocket upgrades return 409 after cookie
authentication; anonymous upgrades still return 401 and untrusted origins 403.
The frontend hides the Practice Lab drawer, terminal toggle, file Run buttons,
and code-block run actions, and its terminal store refuses direct connect/run
calls while this capability is disabled.

Retained custom tools use canonical workspace checks in authenticated mode.
`parse_document`, file-based `l2_archive`, local-file `ocr_image`, and
`create_practice_lab` reject parent traversal, outside absolute paths, and
existing symlink escapes before parsing, uploading, or writing content. HTTP(S)
OCR URLs remain a separate remote-input path. Owned workspace file APIs and
workspace-private skills remain available. Local server, CLI, and Desktop keep
their existing host tools, PTY terminal, and path behavior.

This is a deliberate capability reduction, not an OS-level tenant sandbox or a
claim that arbitrary host execution is confined. `INNO_MULTI_USER_ENABLED`
remains unavailable pending the final isolation review; public registration and
single-process deployment requirements are unchanged.

## Tests

`npm test` remains PostgreSQL-free. `npm run test:integration` requires a real
PostgreSQL installation (`initdb` and `postgres`) and starts an isolated
temporary instance. In CI or an existing development environment, set
`INNO_TEST_DATABASE_URL` to an administrative connection URL; the suite creates
and drops its own temporary database. Missing or unusable PostgreSQL fails the
suite explicitly rather than skipping it.
