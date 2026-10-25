import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAuthRuntimeConfig } from "../auth/config.js";
import { migrateAuthDatabase } from "../auth/migration.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../db/test-postgres.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
let postgres: TemporaryPostgres;
let pool: Pool;
let home: string;

function migrateLegacy(mode: "--dry-run" | "--execute"): Promise<{ code: number | null; output: string }> {
	return new Promise((resolveRun, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", resolve(root, "apps/inno-agent/src/tenants/migrate-legacy.ts"), mode], {
			cwd: root,
			env: {
				...process.env,
				INNO_HOME: home,
				INNO_DATA_DIR: join(home, "data"),
				INNO_WORKSPACE_DIR: join(home, "workspace"),
				INNO_AUTH_MODE: "better-auth",
				DATABASE_URL: postgres.databaseUrl,
				BETTER_AUTH_SECRET: "legacy-integration-secret-at-least-32-characters",
				BETTER_AUTH_URL: "http://127.0.0.1",
				INNO_LEGACY_OWNER_EMAIL: "legacy-owner@example.com",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout?.on("data", (chunk) => { output += chunk; });
		child.stderr?.on("data", (chunk) => { output += chunk; });
		child.once("error", reject);
		child.once("exit", (code) => resolveRun({ code, output }));
	});
}

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	await migrateAuthDatabase(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth",
		DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: "legacy-integration-secret-at-least-32-characters",
		BETTER_AUTH_URL: "http://127.0.0.1",
	}));
	pool = new Pool({ connectionString: postgres.databaseUrl });
	await pool.query(
		`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
		 VALUES ('legacy-owner', 'Legacy Owner', 'legacy-owner@example.com', false, NOW(), NOW())`,
	);
	home = await mkdtemp(join(tmpdir(), "inno-legacy-owner-"));
	await mkdir(join(home, "data", "sessions"), { recursive: true });
	await mkdir(join(home, "data", "workspaces"), { recursive: true });
	await writeFile(join(home, "data", "sessions", "legacy-session.jsonl"), "");
	await writeFile(join(home, "data", "workspaces", "registry.json"), JSON.stringify({
		workspaces: [{ id: "tmp" }, { id: "legacy-workspace" }],
	}));
});

afterAll(async () => {
	await pool?.end();
	await postgres?.close();
	if (home) await rm(home, { recursive: true, force: true });
});

describe("legacy owner migration command", () => {
	it("keeps dry-run read-only and executes idempotently for an explicit owner", async () => {
		const dry = await migrateLegacy("--dry-run");
		expect(dry).toMatchObject({ code: 0 });
		expect(dry.output).toContain('"assigned": 2');
		expect((await pool.query("SELECT COUNT(*)::int AS count FROM resource_ownership")).rows[0].count).toBe(0);
		expect((await pool.query("SELECT COUNT(*)::int AS count FROM tenants")).rows[0].count).toBe(0);

		const executed = await migrateLegacy("--execute");
		expect(executed).toMatchObject({ code: 0 });
		expect(executed.output).toContain('"assigned": 2');
		expect((await pool.query("SELECT COUNT(*)::int AS count FROM resource_ownership")).rows[0].count).toBe(2);

		const repeated = await migrateLegacy("--execute");
		expect(repeated).toMatchObject({ code: 0 });
		expect(repeated.output).toContain('"alreadyOwned": 2');
		expect((await pool.query("SELECT COUNT(*)::int AS count FROM resource_ownership")).rows[0].count).toBe(2);
	});
});
