# Authentication and tenant isolation

Inno Agent defaults to single-user `local` mode. Local mode needs no PostgreSQL and listens on loopback unless network exposure is explicitly allowed. Better Auth adds cookie-based accounts for controlled server deployments; `INNO_MULTI_USER_ENABLED=true` enables the restricted multi-tenant runtime and requires Durable execution.

For the architecture and verification scope, see [MULTI_USER_DURABLE.md](./MULTI_USER_DURABLE.md).

## Configure Better Auth

Prepare PostgreSQL and run migrations explicitly:

```sh
export INNO_AUTH_MODE=better-auth
export DATABASE_URL=postgresql://inno:inno@127.0.0.1:5432/inno
export BETTER_AUTH_SECRET='replace-with-at-least-32-random-characters'
export BETTER_AUTH_URL=http://127.0.0.1:3000

npm run auth:migrate --workspace inno-agent
```

The request path and normal server startup never create or alter tables. Startup fails if required auth configuration is missing, PostgreSQL is unavailable, or the schema has not been migrated. The reviewed Better Auth schema is pinned at `apps/inno-agent/src/db/better-auth-schema.sql`; `npm run auth:schema --workspace inno-agent` prints migration SQL for the configured database.

For local development, `docker compose up postgres` starts PostgreSQL. Do not reuse the example password or secret in a real deployment.

## Start the restricted multi-user runtime

```sh
export INNO_AUTH_MODE=better-auth
export INNO_MULTI_USER_ENABLED=true
export INNO_DURABLE_ENABLED=true
export DATABASE_URL=postgresql://inno:inno@127.0.0.1:5432/inno
export BETTER_AUTH_SECRET='replace-with-at-least-32-random-characters'
export BETTER_AUTH_URL=http://127.0.0.1:3000

npm run build
npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

Startup rejects incompatible flag combinations. In this mode:

- new sessions and agent jobs default to Durable;
- explicit legacy execution returns `409 durable_required`;
- channel inbound, manual agent jobs, and cron/deferred runs execute only through Durable;
- owned legacy JSONL history remains readable/manageable and is never executed or migrated implicitly.

Better Auth without `INNO_MULTI_USER_ENABLED` retains the authenticated compatibility runtime, including the legacy singleton queue unless a durable session is explicitly selected.

## Account and browser boundary

`INNO_AUTH_ALLOW_SIGNUP=false` disables public email/password registration while allowing existing users to sign in. Cookies are HttpOnly, same-origin browser credentials; the frontend does not store session tokens in local storage.

Cross-origin browser requests and terminal WebSockets are restricted to `BETTER_AUTH_URL` and optional comma-separated `INNO_TRUSTED_ORIGINS`.

`/health`, `/api/health`, `/api/auth/*`, and the independently bearer-authenticated `POST /api/bridge/messages` endpoint are public. Other APIs and terminal WebSockets require a valid session in Better Auth mode. Anonymous API access returns 401.

> Public registration is not internet-launch-ready by itself. Rate limiting, email verification, account recovery, and a production security review remain deployment work.

## Personal tenants and ownership

`auth:migrate` creates personal tenants, owner memberships, resource ownership, external-channel ownership, and job occurrence claims. Provisioning is transactional and safe under concurrent first requests.

Each account has one personal tenant. Tenant identity comes only from a verified server session/membership or PostgreSQL ownership; clients cannot select a tenant through a header or body field. Every resource has at most one owner. Owned-resource misses and cross-tenant access return 404 rather than disclosing existence.

Authenticated state uses tenant-local roots such as:

```text
<dataDir>/tenants/<verifiedTenantId>/
├── config/
├── durable/
├── learner/
├── l2/
├── l3/
├── ocr/
├── channels/
├── jobs/
└── sessions/
```

Provider/default-model settings, memory flags, OCR credentials, channels, workspaces, L1/L2/L3 state, scheduler state, and Durable catalogs do not fall back to legacy global tenant data. Process-global read-only skill and preset catalogs are shared deliberately; authenticated shared-skill mutation is disabled, while owned workspace-private skills remain available.

## Explicit legacy-owner migration

Existing files are never assigned to the first user who signs in. After creating the intended owner account and running `auth:migrate`, inspect and then execute the backfill:

```sh
INNO_LEGACY_OWNER_EMAIL=owner@example.com \
INNO_AUTH_MODE=better-auth DATABASE_URL=... \
BETTER_AUTH_SECRET=... BETTER_AUTH_URL=http://127.0.0.1:3000 \
npm run tenants:legacy --workspace inno-agent -- --dry-run

# Review the report, then repeat with --execute.
```

Repeats are idempotent. Resources already owned by another tenant are reported as conflicts. Unassigned legacy resources remain hidden in authenticated mode.

The legacy shared `tmp` workspace is deliberately excluded because it has no safe single owner. Each tenant receives a separate temporary workspace instead. Durable adoption does not rewrite historical JSONL into SQLite.

## Authenticated capability restrictions

Authenticated turns remove PI host `bash`, general host file tools, and PTY terminal access. Terminal creation/upgrades fail closed and the Web UI hides those controls. Retained custom path tools enforce canonical workspace containment and symlink checks. This is an application capability reduction, not a claim that arbitrary host execution is tenant-confined.

MCP, subagents, web-access, codemode, and computer-use are disabled in authenticated mode until their runtime/configuration can be tenant-scoped. Permission policy is managed `default`; tenants cannot switch a process-global `auto`/`yolo` policy. Durable workspace `write`/`edit` has its own replay-safe approval records.

Channel registries, targets, dedupe, logs, sessions, and delivery state are tenant-local. Public bridge callbacks recover the tenant from the bearer token's PostgreSQL ownership record, never from request-supplied tenant identity.

## Storage and worker boundary

PostgreSQL stores account, tenant, ownership, and occurrence-claim metadata; it does not make file-backed state shareable.

- One durable storage has one owner at a time. Never use active-active SQLite/JSONL/NFS replicas.
- Authenticated durable opens hold a per-session PostgreSQL advisory lock to reject accidental double-open. This is not network-partition-proof fencing.
- Legacy JSONL and the singleton legacy runtime retain their original single-process boundary.
- Optional static tenant-owner routing forwards authenticated JSON/SSE and verified public bridge callbacks to a worker with an independent data root. Every worker must use its own RWO storage.
- Ordered migration, automatic failover, and network-partition fencing are not implemented.
- A job occurrence lease is not a storage lock and does not make model calls or external channel delivery exactly-once.

See [DURABLE_RUNTIME.md](./DURABLE_RUNTIME.md) for the storage/recovery contract and static sharding configuration.

## Tests

`npm test` remains PostgreSQL-free. `npm run test:integration` requires a real PostgreSQL installation (`initdb` and `postgres`) and starts an isolated temporary instance. In CI or an existing development environment, set `INNO_TEST_DATABASE_URL` to an administrative connection URL; the suite creates and drops its own temporary database. Missing or unusable PostgreSQL fails the suite explicitly rather than skipping it.
