import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readAuthRuntimeConfig } from "../auth/config.js";
import { migrateAuthDatabase } from "../auth/migration.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../db/test-postgres.js";
import { closeL3Memory, ScopedL3Memory } from "../memory/l3/l3-tools.js";
import { enterTenantContext } from "./current.js";
import { TenantStore, type TenantContext } from "./store.js";

let postgres: TemporaryPostgres;
let pool: Pool;
let store: TenantStore;
let dataDir: string;
let sessionDir: string;
let tenantA: TenantContext;
let tenantB: TenantContext;

function writeSession(id: string, text: string): void {
	writeFileSync(join(sessionDir, `${id}.jsonl`), JSON.stringify({
		type: "message",
		timestamp: "2026-10-25T10:00:00Z",
		message: { role: "user", content: [{ type: "text", text }] },
	}) + "\n");
}

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	await migrateAuthDatabase(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth",
		DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: "memory-integration-secret-at-least-32-characters",
		BETTER_AUTH_URL: "http://127.0.0.1",
	}));
	pool = new Pool({ connectionString: postgres.databaseUrl });
	store = new TenantStore(pool);
	for (const id of ["memory-user-a", "memory-user-b"]) {
		await pool.query(
			`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
			 VALUES ($1, $2, $3, false, NOW(), NOW())`,
			[id, id, `${id}@example.com`],
		);
	}
	tenantA = await store.ensurePersonalTenant("memory-user-a");
	tenantB = await store.ensurePersonalTenant("memory-user-b");
	await store.claimResource(tenantA, "session", "session-a");
	await store.claimResource(tenantB, "session", "session-b");
	dataDir = mkdtempSync(join(tmpdir(), "inno-tenant-l3-"));
	sessionDir = join(dataDir, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	writeSession("session-a", "机器学习 tenant-a-private-memory");
	writeSession("session-b", "烹饪食谱 tenant-b-private-memory");
	writeSession("legacy-unowned", "机器学习 legacy-unowned-memory");
});

afterAll(async () => {
	if (dataDir) {
		closeL3Memory(join(dataDir, "tenants", tenantA.tenantId, "l3"));
		closeL3Memory(join(dataDir, "tenants", tenantB.tenantId, "l3"));
		rmSync(dataDir, { recursive: true, force: true });
	}
	await pool?.end();
	await postgres?.close();
});

describe("agent-scoped L3 memory", () => {
	it("indexes only owned sessions and revokes visibility after ownership release", async () => {
		const memory = new ScopedL3Memory(dataDir, sessionDir);
		enterTenantContext(tenantA, store);
		const resultsA = await memory.recall("机器学习");
		expect(resultsA.map((result) => result.sessionId)).toEqual(["session-a.jsonl"]);
		expect(resultsA[0].text).toContain("tenant-a-private-memory");

		enterTenantContext(tenantB, store);
		expect(await memory.recall("机器学习")).toEqual([]);
		const resultsB = await memory.recall("烹饪食谱");
		expect(resultsB.map((result) => result.sessionId)).toEqual(["session-b.jsonl"]);

		await store.releaseResource(tenantA, "session", "session-a");
		enterTenantContext(tenantA, store);
		expect(await memory.recall("机器学习")).toEqual([]);
	});
});
