import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
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
let providerServer: HttpServer;
let providerOrigin = "";
const providerRequests: Array<{ authorization: string; body: string }> = [];

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
	providerServer = createHttpServer((req, res) => {
		let body = "";
		req.setEncoding("utf-8");
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			providerRequests.push({ authorization: req.headers.authorization ?? "", body });
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end([
				`data: ${JSON.stringify({
					id: "tenant-stub", object: "chat.completion.chunk", created: 0, model: "tenant-model",
					choices: [{ index: 0, delta: { role: "assistant", content: "tenant stub response" }, finish_reason: null }],
				})}`,
				"",
				`data: ${JSON.stringify({
					id: "tenant-stub", object: "chat.completion.chunk", created: 0, model: "tenant-model",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				})}`,
				"",
				"data: [DONE]",
				"",
				"",
			].join("\n"));
		});
	});
	await new Promise<void>((resolveListen) => providerServer.listen(0, "127.0.0.1", resolveListen));
	providerOrigin = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}`;
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
	if (providerServer) {
		providerServer.closeAllConnections();
		await new Promise<void>((resolveClose) => providerServer.close(() => resolveClose()));
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

describe("settings and model credential isolation", () => {
	it("uses tenant-local config and credentials for prompts and side-channel completions", async () => {
		const [cookieA, cookieB] = await Promise.all([
			registerUser("settings-a@example.com"),
			registerUser("settings-b@example.com"),
		]);
		const globalConfigBefore = await readFile(join(home, "config", "config.json"), "utf-8");

		const initial = await (await api(cookieA, "/api/settings")).json() as {
			providers: Record<string, unknown>;
			defaultProvider: string;
			availableModels: unknown[];
		};
		expect(initial.providers).toEqual({});
		expect(initial.defaultProvider).toBe("");
		expect(initial.availableModels).toEqual([]);

		const configureProvider = async (cookie: string, apiKey: string, providerId = "shared", modelId = "tenant-model") => {
			const response = await api(cookie, "/api/settings/providers", {
				method: "PUT",
				body: JSON.stringify({
					providerId,
					baseUrl: providerOrigin,
					apiKey,
					api: "openai-completions",
					makeDefault: true,
					models: [{ id: modelId, name: "Tenant stub" }],
				}),
			});
			expect(response.status).toBe(200);
			return response.json() as Promise<{ providers: Record<string, { apiKey: string }> }>;
		};
		const settingsA = await configureProvider(cookieA, "tenant-a-secret");
		expect(settingsA.providers.shared.apiKey).toBe("****cret");
		expect((await (await api(cookieB, "/api/settings")).json() as { providers: Record<string, unknown> }).providers).toEqual({});
		const settingsB = await configureProvider(cookieB, "tenant-b-secret");
		expect(settingsB.providers.shared.apiKey).toBe("****cret");

		expect((await api(cookieB, "/api/settings/memory", {
			method: "PUT", body: JSON.stringify({ l1Enabled: false, l2Enabled: false }),
		})).status).toBe(200);
		expect((await api(cookieB, "/api/settings/theme", {
			method: "PUT", body: JSON.stringify({ theme: "ocean" }),
		})).status).toBe(200);
		const independentA = await (await api(cookieA, "/api/settings")).json() as {
			memory: { l1Enabled: boolean; l2Enabled: boolean };
			ui: { theme: string };
			providers: Record<string, { apiKey: string }>;
		};
		expect(independentA.memory).toMatchObject({ l1Enabled: true, l2Enabled: true });
		expect(independentA.ui.theme).toBe("light");
		expect(independentA.providers.shared.apiKey).toBe("****cret");
		expect(await readFile(join(home, "config", "config.json"), "utf-8")).toBe(globalConfigBefore);

		const createSession = async (cookie: string) => {
			const response = await api(cookie, "/api/sessions", {
				method: "POST", body: JSON.stringify({ newWorkspace: { isTemp: true } }),
			});
			expect(response.status).toBe(201);
			return (await response.json() as { id: string }).id;
		};
		const [sessionA, sessionB] = await Promise.all([createSession(cookieA), createSession(cookieB)]);
		const unconfiguredCookie = await registerUser("settings-unconfigured@example.com");
		const unconfiguredSession = await createSession(unconfiguredCookie);
		const requestsBeforeUnconfigured = providerRequests.length;
		expect((await api(unconfiguredCookie, "/api/chat", {
			method: "POST", body: JSON.stringify({ sessionId: unconfiguredSession, prompt: "must not inherit the global key" }),
		})).status).toBe(500);
		expect(providerRequests).toHaveLength(requestsBeforeUnconfigured);

		for (const [cookie, sessionId, prompt] of [
			[cookieA, sessionA, "tenant-a-main-prompt"],
			[cookieB, sessionB, "tenant-b-main-prompt"],
		] as const) {
			const response = await api(cookie, "/api/chat", {
				method: "POST", body: JSON.stringify({ sessionId, prompt }),
			});
			const responseBody = await response.json();
			expect(response.status, JSON.stringify({ responseBody, serverLog: output.slice(-12_000) })).toBe(200);
			expect(responseBody).toMatchObject({ response: "tenant stub response" });
		}
		expect(providerRequests.find((request) => request.body.includes("tenant-a-main-prompt"))?.authorization).toBe("Bearer tenant-a-secret");
		expect(providerRequests.find((request) => request.body.includes("tenant-b-main-prompt"))?.authorization).toBe("Bearer tenant-b-secret");

		const sideQuestions = await Promise.all([
			api(cookieA, "/api/btw/ask", {
				method: "POST", body: JSON.stringify({ sessionId: sessionA, question: "tenant-a-side-question", thread: [] }),
			}),
			api(cookieB, "/api/btw/ask", {
				method: "POST", body: JSON.stringify({ sessionId: sessionB, question: "tenant-b-side-question", thread: [] }),
			}),
		]);
		for (const response of sideQuestions) {
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ answer: "tenant stub response" });
		}
		expect(providerRequests.find((request) => request.body.includes("tenant-a-side-question"))?.authorization).toBe("Bearer tenant-a-secret");
		expect(providerRequests.find((request) => request.body.includes("tenant-b-side-question"))?.authorization).toBe("Bearer tenant-b-secret");

		for (const [path, body] of [
			["/api/settings/permissions", { mode: "yolo" }],
			["/api/settings/channels", { channels: { feishu: { enabled: true } } }],
			["/api/settings/mcp", { enabled: true }],
			["/api/settings/computer-use", { enabled: true }],
			["/api/settings/codemode", { enabled: true }],
			["/api/settings/web-access", { values: { tavily: "must-not-be-shared" } }],
			["/api/settings/content-hub", { token: "must-not-be-shared" }],
			["/api/settings/github", { token: "must-not-be-shared" }],
			["/api/mcp/servers/shared", { command: "node", args: ["server.js"] }],
		] as const) {
			const response = await api(cookieA, path, { method: "PUT", body: JSON.stringify(body) });
			expect(response.status, path).toBe(409);
		}
		expect((await api(cookieA, "/api/mcp")).status).toBe(200);
		expect(await (await api(cookieA, "/api/mcp")).json()).toMatchObject({ enabled: false, adapterLoaded: false, servers: [] });

		await configureProvider(cookieB, "tenant-b-secondary", "extra", "extra-model");
		expect((await api(cookieB, "/api/settings/providers/shared", { method: "DELETE" })).status).toBe(200);
		expect((await (await api(cookieA, "/api/settings")).json() as { defaultModel: string }).defaultModel).toBe("tenant-model");
		expect(await readFile(join(home, "config", "config.json"), "utf-8")).toBe(globalConfigBefore);
	}, 90_000);
});
