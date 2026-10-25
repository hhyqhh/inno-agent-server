import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readAuthRuntimeConfig } from "./config.js";
import { createAuthRuntime, type AuthRuntime } from "./runtime.js";
import { requireSession } from "./http.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../db/test-postgres.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SECRET = "integration-secret-with-at-least-32-characters";
let postgres: TemporaryPostgres;
let auth: AuthRuntime;
let server: Server;
let origin: string;

function migrate(databaseUrl: string): Promise<void> {
	return new Promise((resolveMigrate, reject) => {
		const child = spawn(process.execPath, [
			"--import", "tsx", resolve(root, "apps/inno-agent/src/auth/migrate.ts"),
		], {
			cwd: root,
			env: {
				...process.env,
				INNO_AUTH_MODE: "better-auth",
				DATABASE_URL: databaseUrl,
				BETTER_AUTH_SECRET: SECRET,
				BETTER_AUTH_URL: "http://127.0.0.1:3000",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk; });
		child.stderr.on("data", (chunk) => { output += chunk; });
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolveMigrate() : reject(new Error(output)));
	});
}

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	await migrate(postgres.databaseUrl);
	auth = createAuthRuntime(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth",
		DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: SECRET,
		BETTER_AUTH_URL: "http://127.0.0.1",
	}));
	await auth.checkConnection();
	server = createServer((req, res) => {
		void (async () => {
			const path = req.url?.split("?")[0] ?? "/";
			if (path.startsWith("/api/auth/")) {
				await auth.handle(req, res);
				return;
			}
			const session = await requireSession(req, res, auth);
			if (!session) return;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(session.principal));
		})().catch((err) => {
			res.writeHead(500).end(String(err));
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test server port");
	origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	if (server) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	await auth?.close();
	await postgres?.close();
});

describe("Better Auth PostgreSQL integration", () => {
	it("migrates, registers, authenticates cookies, signs in and signs out", async () => {
		const pool = new Pool({ connectionString: postgres.databaseUrl });
		const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
		expect(tables.rows.map((row) => row.tablename)).toEqual(expect.arrayContaining(["user", "session", "account", "verification"]));
		await pool.end();

		const anonymous = await fetch(`${origin}/api/sessions`);
		expect(anonymous.status).toBe(401);

		const credentials = { name: "Integration User", email: "integration@example.com", password: "correct-horse-123" };
		const registered = await fetch(`${origin}/api/auth/sign-up/email`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: origin },
			body: JSON.stringify(credentials),
		});
		expect(registered.status).toBe(200);
		const registeredCookie = registered.headers.get("set-cookie")?.split(";", 1)[0];
		expect(registeredCookie).toContain("session_token");

		const authenticated = await fetch(`${origin}/api/sessions`, { headers: { Cookie: registeredCookie! } });
		expect(authenticated.status).toBe(200);
		expect(await authenticated.json()).toMatchObject({ email: credentials.email, name: credentials.name });

		const signedOut = await fetch(`${origin}/api/auth/sign-out`, {
			method: "POST", headers: { Cookie: registeredCookie!, Origin: origin },
		});
		expect(signedOut.status).toBe(200);
		expect((await fetch(`${origin}/api/sessions`, { headers: { Cookie: registeredCookie! } })).status).toBe(401);

		const signedIn = await fetch(`${origin}/api/auth/sign-in/email`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: origin },
			body: JSON.stringify(credentials),
		});
		expect(signedIn.status).toBe(200);
		const signInCookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0];
		expect((await fetch(`${origin}/api/sessions`, { headers: { Cookie: signInCookie! } })).status).toBe(200);
	});
});
