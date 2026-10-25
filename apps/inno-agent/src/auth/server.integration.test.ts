import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAuthRuntimeConfig } from "./config.js";
import { migrateAuthDatabase } from "./migration.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../db/test-postgres.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SECRET = "server-integration-secret-at-least-32-characters";
let postgres: TemporaryPostgres;
let child: ChildProcess;
let home: string;
let origin: string;
let output = "";

async function freePort(): Promise<number> {
	const listener = createServer();
	await new Promise<void>((resolveListen, reject) => listener.listen(0, "127.0.0.1", resolveListen).once("error", reject));
	const address = listener.address();
	if (!address || typeof address === "string") throw new Error("Missing free port");
	const port = address.port;
	await new Promise<void>((resolveClose) => listener.close(() => resolveClose()));
	return port;
}

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	home = await mkdtemp(join(tmpdir(), "inno-server-auth-"));
	const port = await freePort();
	origin = `http://127.0.0.1:${port}`;
	await mkdir(join(home, "config"), { recursive: true });
	await writeFile(join(home, "config", "config.json"), JSON.stringify({
		defaultProvider: "dummy",
		defaultModel: "dummy-model",
		providers: {
			dummy: {
				baseUrl: "http://127.0.0.1:9",
				apiKey: "integration-only-no-model-call",
				api: "openai-completions",
				models: [{ id: "dummy-model" }],
			},
		},
	}));
	await migrateAuthDatabase(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth",
		DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: SECRET,
		BETTER_AUTH_URL: origin,
	}));
	child = spawn(process.execPath, ["--import", "tsx", resolve(root, "apps/inno-agent/src/server.ts")], {
		cwd: root,
		env: {
			...process.env,
			INNO_HOME: home,
			INNO_CONFIG_DIR: join(home, "config"),
			INNO_DATA_DIR: join(home, "data"),
			INNO_SKILLS_DIR: join(home, "skills"),
			INNO_WORKSPACE_DIR: join(home, "workspace"),
			INNO_PORT: String(port),
			INNO_HOST: "127.0.0.1",
			INNO_AUTH_MODE: "better-auth",
			DATABASE_URL: postgres.databaseUrl,
			BETTER_AUTH_SECRET: SECRET,
			BETTER_AUTH_URL: origin,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout?.on("data", (chunk) => { output += chunk; });
	child.stderr?.on("data", (chunk) => { output += chunk; });
	const deadline = Date.now() + 20_000;
	while (true) {
		if (child.exitCode !== null) throw new Error(`Server exited during startup: ${output}`);
		try {
			if ((await fetch(`${origin}/health`)).ok) break;
		} catch {}
		if (Date.now() > deadline) throw new Error(`Server startup timed out: ${output}`);
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
});

afterAll(async () => {
	if (child?.exitCode === null) {
		child.kill("SIGTERM");
		await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
	}
	await postgres?.close();
	if (home) await rm(home, { recursive: true, force: true });
});

describe("server authentication boundary", () => {
	it("protects HTTP and terminal WebSocket without blocking health or bridge auth", async () => {
		expect((await fetch(`${origin}/health`)).status).toBe(200);
		expect((await fetch(`${origin}/api/session`)).status).toBe(200);
		expect((await fetch(`${origin}/api/sessions`)).status).toBe(401);

		const registered = await fetch(`${origin}/api/auth/sign-up/email`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: origin },
			body: JSON.stringify({ name: "Server User", email: "server@example.com", password: "server-password-123" }),
		});
		expect(registered.status).toBe(200);
		const cookie = registered.headers.get("set-cookie")?.split(";", 1)[0]!;
		expect(cookie).toContain("session_token");
		expect((await fetch(`${origin}/api/sessions`, { headers: { Cookie: cookie } })).status).toBe(200);
		// Bridge has its own bearer-token check; it must not become a cookie-auth
		// route or a blanket channel bypass.
		expect((await fetch(`${origin}/api/bridge/messages`, { method: "POST" })).status).toBe(404);

		const terminal = await fetch(`${origin}/api/terminal/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie, Origin: origin },
			body: JSON.stringify({ sessionId: "auth-integration" }),
		});
		expect(terminal.status).toBe(201);
		const terminalBody = await terminal.json() as { id: string };
		const wsPath = `/api/terminal/sessions/${terminalBody.id}/ws`;

		const anonymousStatus = await new Promise<number>((resolveStatus, reject) => {
			const ws = new WebSocket(`${origin.replace("http", "ws")}${wsPath}`, { headers: { Origin: origin } });
			ws.once("unexpected-response", (_req, res) => resolveStatus(res.statusCode!));
			ws.once("open", () => { ws.terminate(); reject(new Error("Anonymous WebSocket connected")); });
			ws.once("error", () => {});
		});
		expect(anonymousStatus).toBe(401);

		const ready = await new Promise<Record<string, unknown>>((resolveReady, reject) => {
			const ws = new WebSocket(`${origin.replace("http", "ws")}${wsPath}`, {
				headers: { Cookie: cookie, Origin: origin },
			});
			ws.once("message", (data) => {
				const event = JSON.parse(data.toString()) as Record<string, unknown>;
				ws.close();
				resolveReady(event);
			});
			ws.once("error", reject);
		});
		expect(ready.type).toBe("ready");

		const crossOriginStatus = await new Promise<number>((resolveStatus) => {
			const ws = new WebSocket(`${origin.replace("http", "ws")}${wsPath}`, {
				headers: { Cookie: cookie, Origin: "https://untrusted.example.com" },
			});
			ws.once("unexpected-response", (_req, res) => resolveStatus(res.statusCode!));
			ws.once("error", () => {});
		});
		expect(crossOriginStatus).toBe(403);
	});
});
