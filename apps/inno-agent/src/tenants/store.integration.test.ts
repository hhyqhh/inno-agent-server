import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateAuthDatabase } from "../auth/migration.js";
import { readAuthRuntimeConfig } from "../auth/config.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../db/test-postgres.js";
import { ResourceOwnershipError, TenantStore } from "./store.js";

let postgres: TemporaryPostgres;
let pool: Pool;
let store: TenantStore;

async function createUser(id: string): Promise<void> {
	await pool.query(
		`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
		 VALUES ($1, $2, $3, false, NOW(), NOW())`,
		[id, `User ${id}`, `${id}@example.com`],
	);
}

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	await migrateAuthDatabase(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth",
		DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: "tenant-integration-secret-at-least-32-characters",
		BETTER_AUTH_URL: "http://127.0.0.1",
	}));
	pool = new Pool({ connectionString: postgres.databaseUrl });
	store = new TenantStore(pool);
	await Promise.all(["user-a", "user-b", "user-c", "user-d"].map(createUser));
});

afterAll(async () => {
	await pool?.end();
	await postgres?.close();
});

describe("personal tenant store", () => {
	it("provisions one tenant and membership under concurrent first requests", async () => {
		const contexts = await Promise.all(Array.from({ length: 12 }, () => store.ensurePersonalTenant("user-a")));
		expect(new Set(contexts.map((context) => context.tenantId)).size).toBe(1);
		expect((await pool.query("SELECT COUNT(*)::int AS count FROM tenants WHERE owner_user_id = 'user-a'")).rows[0].count).toBe(1);
		expect((await pool.query("SELECT COUNT(*)::int AS count FROM tenant_memberships WHERE user_id = 'user-a'")).rows[0].count).toBe(1);
	});

	it("enforces global resource ownership and hides other tenants' resources", async () => {
		const a = await store.ensurePersonalTenant("user-a");
		const b = await store.ensurePersonalTenant("user-b");
		await store.claimResource(a, "session", "session-a");
		await store.claimResource(a, "workspace", "workspace-a");
		expect(await store.ownsResource(a, "session", "session-a")).toBe(true);
		expect(await store.ownsResource(b, "session", "session-a")).toBe(false);
		expect(await store.listResourceIds(a, "workspace")).toEqual(new Set(["workspace-a"]));
		await expect(store.claimResource(b, "session", "session-a")).rejects.toBeInstanceOf(ResourceOwnershipError);
		await store.releaseResource(a, "session", "session-a");
		await store.claimResource(b, "session", "session-a");
		expect(await store.ownsResource(b, "session", "session-a")).toBe(true);
	});

	it("resolves external channel identities only through persisted ownership", async () => {
		const a = await store.ensurePersonalTenant("user-a");
		const b = await store.ensurePersonalTenant("user-b");
		await store.claimResource(a, "channel", "bridge:test-token-hash");
		expect(await store.findResourceOwner("channel", "bridge:test-token-hash")).toEqual(a);
		expect(await store.findResourceOwner("channel", "bridge:missing")).toBeNull();
		await expect(store.claimResource(b, "channel", "bridge:test-token-hash")).rejects.toBeInstanceOf(ResourceOwnershipError);
		await store.releaseResource(a, "channel", "bridge:test-token-hash");
		expect(await store.findResourceOwner("channel", "bridge:test-token-hash")).toBeNull();
		await store.claimResource(b, "channel", "bridge:test-token-hash");
		expect(await store.findResourceOwner("channel", "bridge:test-token-hash")).toEqual(b);
	});

	it("atomically fences scheduled occurrence claims and recovers expired leases", async () => {
		const a = await store.ensurePersonalTenant("user-a");
		const b = await store.ensurePersonalTenant("user-b");
		await store.claimResource(a, "job", "background-job-a");
		await store.claimResource(b, "job", "background-job-b");
		expect((await store.listResourceOwners("job")).map((owner) => owner.tenantId).sort()).toEqual([a.tenantId, b.tenantId].sort());

		const first = await store.claimJobRun(a, "background-job-a", "background-job-a:slot-1", "2026-10-26T01:00:00.000Z");
		expect(first).not.toBeNull();
		const competitors = await Promise.all(Array.from({ length: 8 }, () =>
			store.claimJobRun(a, "background-job-a", "background-job-a:slot-1", "2026-10-26T01:00:00.000Z"),
		));
		expect(competitors.every((claim) => claim === null)).toBe(true);
		expect(await store.claimJobRun(b, "background-job-a", "background-job-a:other-slot", "2026-10-26T01:00:00.000Z")).toBeNull();

		await pool.query("UPDATE job_run_claims SET expires_at = NOW() - INTERVAL '1 second' WHERE occurrence_id = 'background-job-a:slot-1'");
		const recovered = await store.claimJobRun(a, "background-job-a", "background-job-a:slot-1", "2026-10-26T01:00:00.000Z");
		expect(recovered).not.toBeNull();
		await first!.release();
		expect(await store.claimJobRun(a, "background-job-a", "background-job-a:slot-1", "2026-10-26T01:00:00.000Z")).toBeNull();
		await recovered!.release();
		const afterRelease = await store.claimJobRun(a, "background-job-a", "background-job-a:slot-1", "2026-10-26T01:00:00.000Z");
		expect(afterRelease).not.toBeNull();
		await afterRelease!.release();
	});

	it("supports non-writing dry runs, idempotent backfill and ownership conflicts", async () => {
		const resources = { sessions: ["legacy-session"], workspaces: ["legacy-workspace"] };
		const dry = await store.migrateLegacyResources("user-c", resources, true);
		expect(dry).toMatchObject({ tenantId: null, assigned: 2, alreadyOwned: 0, conflicts: [] });
		expect((await pool.query("SELECT COUNT(*)::int AS count FROM tenants WHERE owner_user_id = 'user-c'")).rows[0].count).toBe(0);
		expect((await pool.query("SELECT COUNT(*)::int AS count FROM resource_ownership WHERE resource_id LIKE 'legacy-%'")).rows[0].count).toBe(0);

		const executed = await store.migrateLegacyResources("user-c", resources, false);
		expect(executed).toMatchObject({ assigned: 2, alreadyOwned: 0, conflicts: [] });
		const repeated = await store.migrateLegacyResources("user-c", resources, false);
		expect(repeated).toMatchObject({ assigned: 0, alreadyOwned: 2, conflicts: [] });
		const conflict = await store.migrateLegacyResources("user-d", resources, false);
		expect(conflict.assigned).toBe(0);
		expect(conflict.conflicts).toHaveLength(2);
	});
});
