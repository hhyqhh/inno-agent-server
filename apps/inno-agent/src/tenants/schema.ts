import type { Pool, PoolClient } from "pg";

export const TENANT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tenants (
	id text PRIMARY KEY,
	kind text NOT NULL DEFAULT 'personal' CHECK (kind = 'personal'),
	owner_user_id text NOT NULL UNIQUE REFERENCES "user" (id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tenant_memberships (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
	role text NOT NULL CHECK (role = 'owner'),
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, user_id),
	UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS resource_ownership (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	resource_type text NOT NULL,
	resource_id text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, resource_type, resource_id),
	UNIQUE (resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS resource_ownership_tenant_type_idx
	ON resource_ownership (tenant_id, resource_type);

CREATE TABLE IF NOT EXISTS job_run_claims (
	occurrence_id text PRIMARY KEY,
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	job_id text NOT NULL,
	scheduled_at timestamptz NOT NULL,
	owner_token text NOT NULL,
	claimed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS job_run_claims_tenant_job_idx
	ON job_run_claims (tenant_id, job_id);
`;

export async function migrateTenantDatabase(pool: Pool): Promise<void> {
	await pool.query(TENANT_SCHEMA_SQL);
}

export async function withTenantTransaction<T>(
	client: PoolClient,
	operation: () => Promise<T>,
): Promise<T> {
	await client.query("BEGIN");
	try {
		const result = await operation();
		await client.query("COMMIT");
		return result;
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	}
}
