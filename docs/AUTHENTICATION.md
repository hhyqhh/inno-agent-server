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
> slices do not yet make all application data tenant-safe. Background memory
> access and execution, channels, settings, permissions, and the singleton agent runtime
> are still shared until each domain's authorization migration lands. `INNO_MULTI_USER_ENABLED=true`
> deliberately fails at startup until resource ownership and cross-tenant
> isolation are implemented. Do not treat this stage as a safe multi-user
> production deployment. Public registration additionally requires rate
> limiting, email verification, and account recovery before an internet-facing
> launch.

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
Channel-backed tenant jobs are rejected until channel registries and delivery
are tenant-scoped. These are deliberate fail-closed limitations, not a claim
that background execution is ready for multi-user deployment. Legacy global job
files remain hidden and are not copied implicitly.

Channels, settings, permissions, background execution, and the singleton agent
runtime still have remaining migration work. `INNO_MULTI_USER_ENABLED` remains
unavailable.


## Tests

`npm test` remains PostgreSQL-free. `npm run test:integration` requires a real
PostgreSQL installation (`initdb` and `postgres`) and starts an isolated
temporary instance. In CI or an existing development environment, set
`INNO_TEST_DATABASE_URL` to an administrative connection URL; the suite creates
and drops its own temporary database. Missing or unusable PostgreSQL fails the
suite explicitly rather than skipping it.
