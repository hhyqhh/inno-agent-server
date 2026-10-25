import { Pool } from "pg";
import { readAuthRuntimeConfig } from "../auth/config.js";
import { resolveRuntimePaths } from "../runtime.js";
import { discoverLegacyResources } from "./legacy.js";
import { TenantStore } from "./store.js";

const dryRun = process.argv.includes("--dry-run");
const execute = process.argv.includes("--execute");
if (dryRun === execute) {
	throw new Error("Choose exactly one migration mode: --dry-run or --execute");
}
const ownerEmail = process.env.INNO_LEGACY_OWNER_EMAIL?.trim();
if (!ownerEmail) throw new Error("INNO_LEGACY_OWNER_EMAIL is required; legacy data is never assigned implicitly");

const config = readAuthRuntimeConfig(process.env);
if (config.mode !== "better-auth") throw new Error("Legacy ownership migration requires Better Auth mode");
const pool = new Pool({ connectionString: config.databaseUrl });
try {
	const owner = await pool.query<{ id: string }>("SELECT id FROM \"user\" WHERE lower(email) = lower($1)", [ownerEmail]);
	if (owner.rowCount !== 1) throw new Error(`No unique Better Auth user found for ${ownerEmail}`);
	const paths = resolveRuntimePaths();
	const resources = discoverLegacyResources(paths);
	const report = await new TenantStore(pool).migrateLegacyResources(owner.rows[0].id, resources, dryRun);
	console.log(JSON.stringify({ ...report, discovered: {
		sessions: resources.sessions.length,
		workspaces: resources.workspaces.length,
	} }, null, 2));
} finally {
	await pool.end();
}
