import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Pool } from "pg";
import type { AuthRuntimeConfig } from "./config.js";
import { authOptions } from "./runtime.js";

export async function migrateAuthDatabase(config: AuthRuntimeConfig, print = false): Promise<void> {
	if (config.mode !== "better-auth") {
		throw new Error("Auth migrations require INNO_AUTH_MODE=better-auth");
	}
	const pool = new Pool({ connectionString: config.databaseUrl });
	try {
		const auth = betterAuth({
			...authOptions,
			database: pool,
			secret: config.secret,
			baseURL: config.baseUrl,
			trustedOrigins: config.trustedOrigins,
			// The pre-migration schema check is expected on a new database; the
			// migration result itself is reported by the explicit CLI command.
			logger: { disabled: true },
		});
		const migrations = await getMigrations(auth.options);
		if (print) console.log(await migrations.compileMigrations());
		else await migrations.runMigrations();
	} finally {
		await pool.end();
	}
}
