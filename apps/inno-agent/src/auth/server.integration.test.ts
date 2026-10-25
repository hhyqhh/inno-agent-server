import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Pool } from "pg";
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

async function registerUser(email: string): Promise<string> {
	const response = await fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: origin },
		body: JSON.stringify({ name: email, email, password: "tenant-test-password-123" }),
	});
	expect(response.status).toBe(200);
	const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
	expect(cookie).toContain("session_token");
	return cookie!;
}

async function api(cookie: string, path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${origin}${path}`, {
		...init,
		headers: {
			Cookie: cookie,
			Origin: origin,
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...init.headers,
		},
	});
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

		const terminalSessionResponse = await api(cookie, "/api/sessions", {
			method: "POST", body: JSON.stringify({ newWorkspace: { isTemp: true } }),
		});
		expect(terminalSessionResponse.status).toBe(201);
		const terminalSession = await terminalSessionResponse.json() as { id: string };
		const terminal = await fetch(`${origin}/api/terminal/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie, Origin: origin },
			body: JSON.stringify({ sessionId: terminalSession.id }),
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

describe("session and workspace tenant isolation", () => {
	it("hides legacy resources and rejects cross-tenant reads and mutations", async () => {
		const [cookieA, cookieB] = await Promise.all([
			registerUser("tenant-a@example.com"),
			registerUser("tenant-b@example.com"),
		]);
		const workspaceResponse = await api(cookieA, "/api/workspaces", {
			method: "POST", body: JSON.stringify({ name: "Tenant A private" }),
		});
		expect(workspaceResponse.status).toBe(201);
		const workspaceA = await workspaceResponse.json() as { id: string };
		const sessionResponse = await api(cookieA, "/api/sessions", {
			method: "POST", body: JSON.stringify({ workspaceId: workspaceA.id }),
		});
		expect(sessionResponse.status).toBe(201);
		const sessionA = await sessionResponse.json() as { id: string };
		const sessionsA = await (await api(cookieA, "/api/sessions")).json() as Array<{ id: string }>;
		expect(sessionsA.map((session) => session.id)).toContain(sessionA.id);
		const otherSessionResponse = await api(cookieB, "/api/sessions", {
			method: "POST", body: JSON.stringify({ newWorkspace: { isTemp: true } }),
		});
		expect(otherSessionResponse.status).toBe(201);
		const sessionB = await otherSessionResponse.json() as { id: string; workspaceId: string };
		expect(sessionB.workspaceId).not.toBe("tmp");
		expect(sessionB.workspaceId.startsWith("tmp-")).toBe(true);

		expect((await api(cookieA, "/api/workspace/create", {
			method: "POST", body: JSON.stringify({ workspaceId: workspaceA.id, path: "private.txt", type: "file" }),
		})).status).toBe(201);
		expect((await api(cookieA, "/api/workspace/file", {
			method: "PUT", body: JSON.stringify({ workspaceId: workspaceA.id, path: "private.txt", content: "tenant-a-secret" }),
		})).status).toBe(200);
		const ownFile = await api(cookieA, `/api/workspace/file?workspaceId=${workspaceA.id}&path=private.txt`);
		expect(ownFile.status).toBe(200);
		expect(await ownFile.json()).toMatchObject({ content: "tenant-a-secret" });

		const sessionsB = await (await api(cookieB, "/api/sessions")).json() as Array<{ id: string }>;
		expect(sessionsB.map((session) => session.id)).not.toContain(sessionA.id);
		const workspacesB = await (await api(cookieB, "/api/workspaces")).json() as Array<{ id: string; sessionIds: string[] }>;
		expect(workspacesB.map((workspace) => workspace.id)).not.toContain(workspaceA.id);
		expect(workspacesB.flatMap((workspace) => workspace.sessionIds)).not.toContain(sessionA.id);

		for (const [path, init] of [
			[`/api/sessions/${sessionA.id}`, {}],
			[`/api/sessions/${sessionA.id}`, { method: "PATCH", body: JSON.stringify({ name: "stolen" }) }],
			[`/api/sessions/${sessionA.id}`, { method: "DELETE" }],
			[`/api/sessions/${sessionA.id}/activate`, { method: "POST" }],
			[`/api/sessions/${sessionA.id}/export.md`, {}],
			[`/api/sessions/${sessionA.id}/workspace`, {}],
			[`/api/chat/status/${sessionA.id}`, {}],
			[`/api/chat/events/${sessionA.id}`, {}],
			[`/api/btw/state/${sessionA.id}`, {}],
		] as Array<[string, RequestInit]>) {
			expect((await api(cookieB, path, init)).status, path).toBe(404);
		}
		expect((await api(cookieB, "/api/chat/stream", {
			method: "POST",
			body: JSON.stringify({ sessionId: sessionA.id, prompt: "no model call", clientRequestId: "cross-tenant-test" }),
		})).status).toBe(404);

		const terminalResponse = await api(cookieA, "/api/terminal/sessions", {
			method: "POST", body: JSON.stringify({ sessionId: sessionA.id }),
		});
		expect(terminalResponse.status).toBe(201);
		const terminalA = await terminalResponse.json() as { id: string };
		expect((await api(cookieB, "/api/terminal/sessions", {
			method: "POST", body: JSON.stringify({ sessionId: sessionA.id }),
		})).status).toBe(404);
		expect((await api(cookieB, `/api/terminal/sessions/${terminalA.id}/close`, { method: "POST" })).status).toBe(404);
		expect((await api(cookieB, `/api/runs?sessionId=${sessionA.id}`)).status).toBe(404);
		const crossTenantWsStatus = await new Promise<number>((resolveStatus, reject) => {
			const ws = new WebSocket(`${origin.replace("http", "ws")}/api/terminal/sessions/${terminalA.id}/ws`, {
				headers: { Cookie: cookieB, Origin: origin },
			});
			ws.once("unexpected-response", (_req, res) => resolveStatus(res.statusCode!));
			ws.once("open", () => { ws.terminate(); reject(new Error("Cross-tenant WebSocket connected")); });
			ws.once("error", () => {});
		});
		expect(crossTenantWsStatus).toBe(404);
		expect((await api(cookieA, `/api/terminal/sessions/${terminalA.id}/close`, { method: "POST" })).status).toBe(200);
		expect((await api(cookieB, `/api/workspace/file?workspaceId=${workspaceA.id}&path=private.txt`)).status).toBe(404);
		expect((await api(cookieB, "/api/workspace/file", {
			method: "PUT", body: JSON.stringify({ workspaceId: workspaceA.id, path: "private.txt", content: "stolen" }),
		})).status).toBe(404);
		expect((await api(cookieB, `/api/sessions/${sessionB.id}/workspace`, {
			method: "PUT", body: JSON.stringify({ workspaceId: workspaceA.id }),
		})).status).toBe(404);

		const tempA = await (await api(cookieA, "/api/workspaces", {
			method: "POST", body: JSON.stringify({ isTemp: true }),
		})).json() as { id: string };
		const tempB = await (await api(cookieB, "/api/workspaces", {
			method: "POST", body: JSON.stringify({ isTemp: true }),
		})).json() as { id: string };
		expect(tempA.id).not.toBe(tempB.id);
		const treeA = await (await api(cookieA, `/api/workspace/tree?workspaceId=${tempA.id}`)).json() as { root: string };
		const treeB = await (await api(cookieB, `/api/workspace/tree?workspaceId=${tempB.id}`)).json() as { root: string };
		expect(treeA.root).not.toBe(treeB.root);

		// An existing file without an explicit legacy-owner assignment is hidden
		// even from the authenticated user who originally created it.
		const pool = new Pool({ connectionString: postgres.databaseUrl });
		try {
			await pool.query("DELETE FROM resource_ownership WHERE resource_type = 'session' AND resource_id = $1", [sessionA.id]);
		} finally {
			await pool.end();
		}
		expect((await api(cookieA, `/api/sessions/${sessionA.id}`)).status).toBe(404);
		const afterUnclaim = await (await api(cookieA, "/api/sessions")).json() as Array<{ id: string }>;
		expect(afterUnclaim.map((session) => session.id)).not.toContain(sessionA.id);
	});
});

describe("job and check-in tenant isolation", () => {
	it("separates job storage and rejects cross-tenant runs and occurrence control", async () => {
		const [cookieA, cookieB] = await Promise.all([
			registerUser("jobs-a@example.com"),
			registerUser("jobs-b@example.com"),
		]);
		await mkdir(join(home, "data", "jobs"), { recursive: true });
		await writeFile(join(home, "data", "jobs", "jobs.json"), JSON.stringify([{
			id: "job_legacy", name: "legacy global", cron: "0 9 * * *", timezone: "UTC", enabled: true,
			taskType: "custom_prompt", prompt: "must stay hidden",
		}]));
		const created = await api(cookieA, "/api/jobs", {
			method: "POST", body: JSON.stringify({
				name: "tenant a review", cron: "0 9 * * *", timezone: "Asia/Shanghai", enabled: true,
				taskType: "daily_review", prompt: "review private notes",
			}),
		});
		expect(created.status).toBe(201);
		const jobA = await created.json() as { id: string };
		const jobsA = await (await api(cookieA, "/api/jobs")).json() as Array<{ id: string }>;
		expect(jobsA.map((job) => job.id)).toEqual([jobA.id]);
		const jobsB = await (await api(cookieB, "/api/jobs")).json() as Array<{ id: string }>;
		expect(jobsB).toEqual([]);
		expect(await (await api(cookieB, "/api/jobs/status")).json()).toMatchObject({ total: 0 });
		expect(await (await api(cookieB, "/api/jobs/runs")).json()).toEqual([]);

		for (const [path, init] of [
			[`/api/jobs/${jobA.id}/runs`, {}],
			[`/api/jobs/${jobA.id}`, { method: "PATCH", body: JSON.stringify({ name: "stolen" }) }],
			[`/api/jobs/${jobA.id}`, { method: "DELETE" }],
			[`/api/jobs/${jobA.id}/run`, { method: "POST", body: JSON.stringify({}) }],
			[`/api/jobs/${jobA.id}/run/stream`, { method: "POST", body: JSON.stringify({ sessionId: "anything" }) }],
		] as Array<[string, RequestInit]>) {
			expect((await api(cookieB, path, init)).status, path).toBe(404);
		}
		expect((await api(cookieA, "/api/jobs", {
			method: "POST", body: JSON.stringify({
				name: "unsafe push", cron: "0 9 * * *", taskType: "push_reminder", prompt: "secret", channel: "feishu",
			}),
		})).status).toBe(400);

		const sessionResponse = await api(cookieB, "/api/sessions", {
			method: "POST", body: JSON.stringify({ newWorkspace: { isTemp: true } }),
		});
		const sessionB = await sessionResponse.json() as { id: string };
		expect((await api(cookieA, `/api/jobs/${jobA.id}/run`, {
			method: "POST", body: JSON.stringify({}),
		})).status).toBe(400);
		expect((await api(cookieA, `/api/jobs/${jobA.id}/run`, {
			method: "POST", body: JSON.stringify({ sessionId: sessionB.id }),
		})).status).toBe(404);
		expect((await api(cookieA, "/api/jobs/run/stop", {
			method: "POST", body: JSON.stringify({ sessionId: sessionB.id }),
		})).status).toBe(404);

		const planA = await (await api(cookieA, "/api/checkins/today")).json() as {
			jobs: Array<{ jobId: string; occurrences: Array<{ occurrenceId: string }> }>;
		};
		const occurrenceId = planA.jobs.find((job) => job.jobId === jobA.id)?.occurrences[0]?.occurrenceId;
		expect(occurrenceId).toBeDefined();
		expect(await (await api(cookieB, "/api/checkins/today")).json()).toMatchObject({ dayStatus: "no_tasks", jobs: [] });
		expect((await api(cookieB, "/api/checkins/claim", {
			method: "POST", body: JSON.stringify({ occurrenceId }),
		})).status).toBe(404);
		expect((await api(cookieB, "/api/checkins/skip", {
			method: "POST", body: JSON.stringify({ occurrenceId }),
		})).status).toBe(404);

		expect((await api(cookieA, `/api/jobs/${jobA.id}`, { method: "DELETE" })).status).toBe(204);
		expect((await api(cookieA, `/api/jobs/${jobA.id}`, { method: "DELETE" })).status).toBe(404);
	});
});

describe("L1 and L2 tenant storage", () => {
	it("uses separate profile and wiki roots and hides legacy global memory", async () => {
		const [cookieA, cookieB] = await Promise.all([
			registerUser("memory-a@example.com"),
			registerUser("memory-b@example.com"),
		]);
		await mkdir(join(home, "data", "l2"), { recursive: true });
		await writeFile(join(home, "data", "l2", "legacy.md"), "legacy global memory");

		expect((await api(cookieA, "/api/learner/profile", {
			method: "PATCH", body: JSON.stringify({ profile_summary: "tenant-a-profile" }),
		})).status).toBe(200);
		const profileB = await (await api(cookieB, "/api/learner/profile")).json() as { profile_summary?: string };
		expect(profileB.profile_summary).not.toBe("tenant-a-profile");
		expect((await api(cookieB, "/api/learner/profile/goals/goal_missing", {
			method: "PATCH", body: JSON.stringify({ title: "missing" }),
		})).status).toBe(404);

		expect((await api(cookieA, "/api/wiki/page", {
			method: "PUT", body: JSON.stringify({ path: "private.md", content: "tenant-a-wiki" }),
		})).status).toBe(200);
		const ownPage = await api(cookieA, "/api/wiki/page?path=private.md");
		expect(ownPage.status).toBe(200);
		expect(await ownPage.json()).toMatchObject({ content: "tenant-a-wiki" });
		expect((await api(cookieB, "/api/wiki/page?path=private.md")).status).toBe(404);
		expect((await api(cookieB, "/api/wiki/page?path=legacy.md")).status).toBe(404);
		const pagesB = await (await api(cookieB, "/api/wiki/pages")).json() as Array<{ path: string }>;
		expect(pagesB.map((page) => page.path)).not.toContain("private.md");

		expect((await api(cookieB, "/api/wiki/page", {
			method: "PUT", body: JSON.stringify({ path: "private.md", content: "tenant-b-wiki" }),
		})).status).toBe(200);
		expect((await api(cookieB, "/api/wiki/page?path=private.md", { method: "DELETE" })).status).toBe(200);
		expect(await (await api(cookieA, "/api/wiki/page?path=private.md")).json()).toMatchObject({ content: "tenant-a-wiki" });
	});
});
