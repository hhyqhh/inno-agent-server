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

> **Isolation boundary:** this stage provides identity, not tenant isolation.
> Existing sessions, workspaces, memory, jobs, and tools are still shared.
> `INNO_MULTI_USER_ENABLED=true` deliberately fails at startup until resource
> ownership and cross-tenant isolation are implemented. Do not treat this stage
> as a safe multi-user production deployment. Public registration additionally
> requires rate limiting, email verification, and account recovery before an
> internet-facing launch.

## Tests

`npm test` remains PostgreSQL-free. `npm run test:integration` requires a real
PostgreSQL installation (`initdb` and `postgres`) and starts an isolated
temporary instance. In CI or an existing development environment, set
`INNO_TEST_DATABASE_URL` to an administrative connection URL; the suite creates
and drops its own temporary database. Missing or unusable PostgreSQL fails the
suite explicitly rather than skipping it.
