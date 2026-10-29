import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
let ocrServer: HttpServer;
let ocrOrigin = "";
const ocrRequests: Array<{ authorization: string; body: string }> = [];
const providerRequests: Array<{ authorization: string; body: string }> = [];
const sidecarServers: HttpServer[] = [];
const sidecarRequests: Array<{ sidecar: string; method: string; path: string; authorization: string; body: string }> = [];
let sidecarOriginA = "";
let sidecarOriginB = "";

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

async function configureTestProvider(cookie: string, apiKey = "integration-test-secret"): Promise<void> {
	const response = await api(cookie, "/api/settings/providers", {
		method: "PUT",
		body: JSON.stringify({
			providerId: "shared", baseUrl: providerOrigin, apiKey,
			api: "openai-completions", makeDefault: true,
			models: [{ id: "tenant-model", name: "Tenant model", contextWindow: 32_000, maxTokens: 2_000 }],
		}),
	});
	expect(response.status).toBe(200);
}

async function readDurableStream(
	response: Response,
	onPermission?: (input: { sessionId: string; turnId: string; requestId: string }) => Promise<void>,
): Promise<string> {
	if (!response.body) throw new Error("Durable SSE response has no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let streamed = "";
	let pending = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value, { stream: true });
		streamed += chunk;
		pending += chunk;
		const blocks = pending.split("\n\n");
		pending = blocks.pop() ?? "";
		for (const block of blocks) {
			const line = block.split("\n").find((item) => item.startsWith("data: "));
			if (!line || line === "data: [DONE]") continue;
			const envelope = JSON.parse(line.slice(6)) as {
				sessionId: string;
				turnId: string;
				event: { type: string; requestId?: string };
			};
			if (envelope.event.type === "permission_request" && envelope.event.requestId && onPermission) {
				await onPermission({
					sessionId: envelope.sessionId,
					turnId: envelope.turnId,
					requestId: envelope.event.requestId,
				});
			}
		}
	}
	return streamed;
}

async function waitFor(condition: () => boolean | Promise<boolean>, description: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}: ${output.slice(-8_000)}`);
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	}
}

async function startServer(): Promise<void> {
	output = "";
	const port = new URL(origin).port;
	child = spawn(process.execPath, ["--import", "tsx", resolve(root, "apps/inno-agent/src/server.ts")], {
		cwd: root,
		env: {
			...process.env,
			INNO_HOME: home,
			INNO_CONFIG_DIR: join(home, "config"),
			INNO_DATA_DIR: join(home, "data"),
			INNO_SKILLS_DIR: join(home, "skills"),
			INNO_WORKSPACE_DIR: join(home, "workspace"),
			INNO_PORT: port,
			INNO_HOST: "127.0.0.1",
			INNO_AUTH_MODE: "better-auth",
			INNO_MULTI_USER_ENABLED: "true",
			INNO_DURABLE_ENABLED: "true",
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
}

async function startSidecar(sidecar: string): Promise<string> {
	const server = createHttpServer((req, res) => {
		let body = "";
		req.setEncoding("utf-8");
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			sidecarRequests.push({
				sidecar,
				method: req.method ?? "",
				path: req.url ?? "",
				authorization: req.headers.authorization ?? "",
				body,
			});
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("{}");
		});
	});
	sidecarServers.push(server);
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	home = await mkdtemp(join(tmpdir(), "inno-server-auth-"));
	providerServer = createHttpServer((req, res) => {
		let body = "";
		req.setEncoding("utf-8");
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", async () => {
			if (req.method === "GET" && req.url === "/index.json") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ presets: [{ id: "durable-preset", name: "Durable preset" }] }));
				return;
			}
			providerRequests.push({ authorization: req.headers.authorization ?? "", body });
			if (body.includes("请用一句简短的中文短语概括")) {
				const topic = req.headers.authorization === "Bearer durable-topic-a-secret"
					? "租户 A 学习目标"
					: "租户 B 学习目标";
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end([
					`data: ${JSON.stringify({
						id: "tenant-topic", object: "chat.completion.chunk", created: 0, model: "tenant-model",
						choices: [{ index: 0, delta: { role: "assistant", content: topic }, finish_reason: null }],
					})}`,
					"",
					`data: ${JSON.stringify({
						id: "tenant-topic", object: "chat.completion.chunk", created: 0, model: "tenant-model",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					})}`,
					"",
					"data: [DONE]",
					"",
					"",
				].join("\n"));
				return;
			}
			if (body.includes("durable-image-provider-rejection") && body.includes("image_url")) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { message: "unknown variant 'image_url', expected 'text'" } }));
				return;
			}
			if (body.includes("durable-reconnect")) {
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
			}
			if (body.includes("durable-restart-prompt")) {
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
			}
			if (body.includes("durable-workspace-write")) {
				const request = JSON.parse(body) as { messages?: Array<{ role?: string }> };
				const toolResults = request.messages?.filter((message) => message.role === "tool").length ?? 0;
				if (toolResults === 0) {
					res.writeHead(200, { "Content-Type": "text/event-stream" });
					res.end([
						`data: ${JSON.stringify({
							id: "tenant-stub", object: "chat.completion.chunk", created: 0, model: "tenant-model",
							choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{
								index: 0, id: "durable-workspace-write-call", type: "function",
								function: { name: "write", arguments: JSON.stringify({ path: "nested/durable-preview.txt", content: "durable preview content" }) },
							}] }, finish_reason: null }],
						})}`,
						"",
						`data: ${JSON.stringify({
							id: "tenant-stub", object: "chat.completion.chunk", created: 0, model: "tenant-model",
							choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
						})}`,
						"",
						"data: [DONE]",
						"",
						"",
					].join("\n"));
					return;
				}
			}
			const questionPrompt = body.includes("durable-question");
			if (questionPrompt) {
				const request = JSON.parse(body) as { messages?: Array<{ role?: string }> };
				const toolResults = request.messages?.filter((message) => message.role === "tool").length ?? 0;
				if (toolResults === 0) {
					res.writeHead(200, { "Content-Type": "text/event-stream" });
					res.end([
						`data: ${JSON.stringify({
							id: "tenant-stub", object: "chat.completion.chunk", created: 0, model: "tenant-model",
							choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{
								index: 0, id: "durable-question-call", type: "function",
								function: { name: "ask_user_question", arguments: JSON.stringify({ questions: [{
									question: "选择学习难度？", header: "难度",
									options: [{ label: "基础", description: "从基础开始" }, { label: "进阶", description: "加快进度" }],
								}] }) },
							}] }, finish_reason: null }],
						})}`,
						"",
						`data: ${JSON.stringify({
							id: "tenant-stub", object: "chat.completion.chunk", created: 0, model: "tenant-model",
							choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
						})}`,
						"",
						"data: [DONE]",
						"",
						"",
					].join("\n"));
					return;
				}
			}
			const durableHistoryPrompt = /durable-l3-history-(a|b)/.exec(body);
			if (durableHistoryPrompt) {
				const request = JSON.parse(body) as { messages?: Array<{ role?: string }> };
				const toolResults = request.messages?.filter((message) => message.role === "tool").length ?? 0;
				if (toolResults === 0) {
					res.writeHead(200, { "Content-Type": "text/event-stream" });
					res.end([
						`data: ${JSON.stringify({
							id: "tenant-stub", object: "chat.completion.chunk", created: 0, model: "tenant-model",
							choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{
								index: 0, id: `durable-l3-history-call-${durableHistoryPrompt[1]}`, type: "function",
								function: { name: "l3_recall", arguments: JSON.stringify({ query: "durable-topic-first" }) },
							}] }, finish_reason: null }],
						})}`,
						"",
						`data: ${JSON.stringify({
							id: "tenant-stub", object: "chat.completion.chunk", created: 0, model: "tenant-model",
							choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
						})}`,
						"",
						"data: [DONE]",
						"",
						"",
					].join("\n"));
					return;
				}
			}
			const memoryPrompt = /durable-memory-(a|b)/.exec(body);
			if (memoryPrompt) {
				const request = JSON.parse(body) as { messages?: Array<{ role?: string }> };
				const toolResults = request.messages?.filter((message) => message.role === "tool").length ?? 0;
				if (toolResults < 6) {
					const tenant = memoryPrompt[1];
					const toolCalls = [{
						id: `durable-memory-event-${tenant}`,
						name: "record_learning_event",
						arguments: {
							event_type: "concept_explained",
							context: { concept_ids: [`durable-concept-${tenant}`] },
							payload: { topic: `durable-topic-${tenant}` },
						},
					}, {
						id: `durable-memory-archive-${tenant}`,
						name: "l2_archive",
						arguments: {
							title: `durable-archive-${tenant}`,
							content: `durable-content-${tenant}`,
							sourceType: "markdown",
						},
					}, {
						id: `durable-profile-patch-${tenant}`,
						name: "patch_learner_profile",
						arguments: { profile_summary_append: `durable-patch-${tenant}` },
					}, {
						id: `durable-profile-update-${tenant}`,
						name: "update_learner_profile",
						arguments: { profile_summary: `durable-profile-${tenant}` },
					}, {
						id: `durable-ocr-call-${tenant}`,
						name: "ocr_image",
						arguments: { filePath: `https://images.local/durable-ocr-${tenant}.png` },
					}, {
						id: `durable-l3-recall-${tenant}`,
						name: "l3_recall",
						arguments: { query: `durable-topic-${tenant}` },
					}];
					const toolCall = toolCalls[toolResults]!;
					res.writeHead(200, { "Content-Type": "text/event-stream" });
					res.end([
						`data: ${JSON.stringify({
							id: "tenant-stub", object: "chat.completion.chunk", created: 0, model: "tenant-model",
							choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{
								index: 0, id: toolCall.id, type: "function",
								function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
							}] }, finish_reason: null }],
						})}`,
						"",
						`data: ${JSON.stringify({
							id: "tenant-stub", object: "chat.completion.chunk", created: 0, model: "tenant-model",
							choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
						})}`,
						"",
						"data: [DONE]",
						"",
						"",
					].join("\n"));
					return;
				}
			}
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
	ocrServer = createHttpServer((req, res) => {
		let body = "";
		req.setEncoding("utf-8");
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			ocrRequests.push({ authorization: req.headers.authorization ?? "", body });
			const path = new URL(req.url ?? "/", "http://ocr.local").pathname;
			if (req.method === "POST" && path === "/jobs") {
				const tenant = body.includes("durable-ocr-a") ? "a" : "b";
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ data: { jobId: `job-${tenant}` } }));
				return;
			}
			const job = /^\/jobs\/job-(a|b)$/.exec(path);
			if (req.method === "GET" && job) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ data: {
					state: "done",
					resultUrl: { jsonUrl: `${ocrOrigin}/result-${job[1]}` },
				} }));
				return;
			}
			const result = /^\/result-(a|b)$/.exec(path);
			if (req.method === "GET" && result) {
				res.writeHead(200, { "Content-Type": "application/x-ndjson" });
				res.end(`${JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: `durable-ocr-text-${result[1]}` } }] } })}\n`);
				return;
			}
			res.writeHead(404);
			res.end();
		});
	});
	await new Promise<void>((resolveListen) => ocrServer.listen(0, "127.0.0.1", resolveListen));
	ocrOrigin = `http://127.0.0.1:${(ocrServer.address() as AddressInfo).port}`;
	[sidecarOriginA, sidecarOriginB] = await Promise.all([startSidecar("a"), startSidecar("b")]);
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
		contentHub: { type: "bundle", baseUrl: providerOrigin },
	}));
	await migrateAuthDatabase(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth",
		DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: SECRET,
		BETTER_AUTH_URL: origin,
	}));
	await startServer();
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
	if (ocrServer) {
		ocrServer.closeAllConnections();
		await new Promise<void>((resolveClose) => ocrServer.close(() => resolveClose()));
	}
	for (const server of sidecarServers) {
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
	await postgres?.close();
	if (home) await rm(home, { recursive: true, force: true });
});

describe("server authentication boundary", () => {
	it("protects HTTP and terminal WebSocket without blocking health or bridge auth", async () => {
		expect((await fetch(`${origin}/health`)).status).toBe(200);
		const sessionProbe = await (await fetch(`${origin}/api/session`)).json() as { durableEnabled?: boolean; durableRequired?: boolean };
		expect(sessionProbe.durableEnabled).toBe(true);
		expect(sessionProbe.durableRequired).toBe(true);
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
		await configureTestProvider(cookie, "server-boundary-secret");
		// Bridge has its own bearer-token/tenant-ownership check; it must not
		// become a cookie-auth route or fall back to the legacy global channel.
		expect((await fetch(`${origin}/api/bridge/messages`, { method: "POST" })).status).toBe(401);

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
		expect(terminal.status).toBe(409);
		const wsPath = "/api/terminal/sessions/host-terminal-disabled/ws";

		const anonymousStatus = await new Promise<number>((resolveStatus, reject) => {
			const ws = new WebSocket(`${origin.replace("http", "ws")}${wsPath}`, { headers: { Origin: origin } });
			ws.once("unexpected-response", (_req, res) => resolveStatus(res.statusCode!));
			ws.once("open", () => { ws.terminate(); reject(new Error("Anonymous WebSocket connected")); });
			ws.once("error", () => {});
		});
		expect(anonymousStatus).toBe(401);

		const authenticatedStatus = await new Promise<number>((resolveStatus, reject) => {
			const ws = new WebSocket(`${origin.replace("http", "ws")}${wsPath}`, {
				headers: { Cookie: cookie, Origin: origin },
			});
			ws.once("unexpected-response", (_req, res) => resolveStatus(res.statusCode!));
			ws.once("open", () => { ws.terminate(); reject(new Error("Authenticated host WebSocket connected")); });
			ws.once("error", () => {});
		});
		expect(authenticatedStatus).toBe(409);

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

describe("multi-user durable execution boundary", () => {
	it("defaults new work to durable and keeps owned legacy history read-only", async () => {
		const cookie = await registerUser("durable-required@example.com");
		expect((await api(cookie, "/api/sessions")).status).toBe(200);
		await configureTestProvider(cookie, "durable-required-secret");
		const created = await api(cookie, "/api/sessions", {
			method: "POST", body: JSON.stringify({ newWorkspace: { isTemp: true } }),
		});
		expect(created.status, await created.clone().text()).toBe(201);
		expect(await created.json()).toMatchObject({ runtime: "durable" });
		expect((await api(cookie, "/api/sessions", {
			method: "POST", body: JSON.stringify({ runtime: "legacy" }),
		})).status).toBe(409);

		const jobResponse = await api(cookie, "/api/jobs", {
			method: "POST",
			body: JSON.stringify({ name: "default durable", cron: "0 9 * * *", taskType: "custom_prompt", prompt: "test" }),
		});
		expect(jobResponse.status).toBe(201);
		const job = await jobResponse.json() as { id: string; runtime: string };
		expect(job.runtime).toBe("durable");
		expect((await api(cookie, "/api/jobs", {
			method: "POST",
			body: JSON.stringify({ name: "legacy job", cron: "0 9 * * *", taskType: "custom_prompt", prompt: "test", runtime: "legacy" }),
		})).status).toBe(409);

		const pool = new Pool({ connectionString: postgres.databaseUrl });
		try {
			const tenant = await pool.query<{ id: string }>(
				'SELECT tenant.id FROM tenants tenant JOIN "user" account ON account.id = tenant.owner_user_id WHERE account.email = $1',
				["durable-required@example.com"],
			);
			await pool.query(
				"INSERT INTO resource_ownership (tenant_id, resource_type, resource_id) VALUES ($1, 'session', 'legacy-read-only.jsonl')",
				[tenant.rows[0].id],
			);
		} finally {
			await pool.end();
		}
		await writeFile(join(home, "data", "sessions", "legacy-read-only.jsonl"), `${JSON.stringify({
			type: "session", version: 3, id: "legacy-read-only", timestamp: "2026-10-27T00:00:00.000Z", cwd: home,
		})}\n`);
		expect((await api(cookie, "/api/sessions/legacy-read-only.jsonl")).status).toBe(200);
		for (const [path, body] of [
			["/api/chat", { sessionId: "legacy-read-only.jsonl", prompt: "must not run" }],
			["/api/chat/stream", { sessionId: "legacy-read-only.jsonl", prompt: "must not run", clientRequestId: "legacy-read-only" }],
			["/api/btw/bring-back", { sessionId: "legacy-read-only.jsonl", question: "q", answer: "a" }],
			[`/api/jobs/${job.id}/run`, { sessionId: "legacy-read-only.jsonl" }],
			[`/api/jobs/${job.id}/run/stream`, { sessionId: "legacy-read-only.jsonl" }],
		] as const) {
			const response = await api(cookie, path, { method: "POST", body: JSON.stringify(body) });
			expect(response.status, path).toBe(409);
			expect(await response.json()).toMatchObject({ code: "durable_required" });
		}
		expect((await api(cookie, "/api/sessions/legacy-read-only.jsonl/activate", { method: "POST" })).status).toBe(409);
	}, 30_000);
});

describe("session sidecar and showcase tenant isolation", () => {
	it("scopes expired questions, BTW geometry and showcase exports without legacy profile leakage", async () => {
		const [cookieA, cookieB] = await Promise.all([
			registerUser("sidecars-a@example.com"),
			registerUser("sidecars-b@example.com"),
		]);
		const sessionA = "legacy-sidecar-a.jsonl";
		const sessionB = "legacy-sidecar-b.jsonl";
		expect((await api(cookieA, "/api/sessions")).status).toBe(200);
		expect((await api(cookieB, "/api/sessions")).status).toBe(200);
		const pool = new Pool({ connectionString: postgres.databaseUrl });
		let tenantA: string;
		let tenantB: string;
		try {
			const tenantRows = await pool.query<{ id: string; email: string }>(
				`SELECT tenant.id, account.email FROM tenants tenant JOIN "user" account ON account.id = tenant.owner_user_id
				 WHERE account.email IN ('sidecars-a@example.com', 'sidecars-b@example.com')`,
			);
			tenantA = tenantRows.rows.find((row) => row.email === "sidecars-a@example.com")!.id;
			tenantB = tenantRows.rows.find((row) => row.email === "sidecars-b@example.com")!.id;
			const timestamp = "2026-10-27T00:00:00.000Z";
			for (const [sessionId, tenantId] of [[sessionA, tenantA], [sessionB, tenantB]] as const) {
				await writeFile(join(home, "data", "sessions", sessionId), `${JSON.stringify({
					type: "session", version: 3, id: sessionId, timestamp, cwd: home,
				})}\n`);
				await pool.query(
					"INSERT INTO resource_ownership (tenant_id, resource_type, resource_id) VALUES ($1, 'session', $2)",
					[tenantId, sessionId],
				);
			}
		} finally {
			await pool.end();
		}

		const stateA = await (await api(cookieA, `/api/btw/state/${sessionA}`)).json() as Record<string, unknown>;
		const stateB = await (await api(cookieB, `/api/btw/state/${sessionB}`)).json() as Record<string, unknown>;
		expect((await api(cookieA, `/api/btw/state/${sessionA}`, {
			method: "PUT",
			body: JSON.stringify({ ...stateA, window: { x: 11, y: 12, width: 520, height: 420 }, windowInitialized: true, minimized: true }),
		})).status).toBe(200);
		expect((await api(cookieB, `/api/btw/state/${sessionB}`, {
			method: "PUT",
			body: JSON.stringify({ ...stateB, window: { x: 21, y: 22, width: 620, height: 480 }, windowInitialized: true, minimized: false }),
		})).status).toBe(200);
		expect(await (await api(cookieA, `/api/btw/state/${sessionA}`)).json()).toMatchObject({
			window: { x: 11, y: 12, width: 520, height: 420 }, minimized: true,
		});
		expect(await (await api(cookieB, `/api/btw/state/${sessionB}`)).json()).toMatchObject({
			window: { x: 21, y: 22, width: 620, height: 480 }, minimized: false,
		});
		expect(existsSync(join(home, "data", "sessions", "btw.json"))).toBe(false);
		expect(existsSync(join(home, "data", "tenants", tenantA, "sessions", "btw.json"))).toBe(true);
		expect(existsSync(join(home, "data", "tenants", tenantB, "sessions", "btw.json"))).toBe(true);

		const questionsPath = join(home, "data", "sessions", "questions.json");
		const questionFixture = {
			[sessionA]: { questionId: "victim-question", sessionId: sessionA, turnId: "victim-turn", params: {}, createdAt: new Date().toISOString() },
			[sessionB]: { questionId: "other-question", sessionId: sessionB, turnId: "other-turn", params: {}, createdAt: new Date().toISOString() },
		};
		await writeFile(questionsPath, JSON.stringify(questionFixture));
		const expiredResponse = (sessionId: string, turnId: string, questionId: string) => api(cookieB, "/api/chat/question-response", {
			method: "POST",
			body: JSON.stringify({ sessionId, turnId, questionId, result: { answers: [], cancelled: true } }),
		});
		expect((await expiredResponse(sessionB, "victim-turn", "victim-question")).status).toBe(409);
		expect(JSON.parse(await readFile(questionsPath, "utf-8"))).toEqual(questionFixture);
		expect((await api(cookieA, "/api/chat/question-response", {
			method: "POST",
			body: JSON.stringify({ sessionId: sessionA, turnId: "victim-turn", questionId: "victim-question", result: { answers: [], cancelled: true } }),
		})).status).toBe(409);
		expect(JSON.parse(await readFile(questionsPath, "utf-8"))).toEqual(questionFixture);

		const probePath = join(home, "data", "sessions", "gate-probe.json");
		await writeFile(probePath, "do-not-overwrite");
		expect((await api(cookieA, `/api/sessions/${sessionA}/showcase-export`, {
			method: "POST", body: JSON.stringify({ id: "../../sessions/gate-probe" }),
		})).status).toBe(400);
		expect((await api(cookieA, `/api/sessions/${sessionA}/showcase-export`, {
			method: "POST", body: JSON.stringify({ id: "index" }),
		})).status).toBe(400);
		expect(await readFile(probePath, "utf-8")).toBe("do-not-overwrite");

		await mkdir(join(home, "data", "learner"), { recursive: true });
		await mkdir(join(home, "data", "tenants", tenantA, "learner"), { recursive: true });
		await writeFile(join(home, "data", "learner", "profile.json"), JSON.stringify({ profile_summary: "legacy-global-secret" }));
		await writeFile(join(home, "data", "tenants", tenantA, "learner", "profile.json"), JSON.stringify({ profile_summary: "tenant-a-profile-secret" }));
		await appendFile(join(home, "data", "sessions", sessionA), `${JSON.stringify({
			type: "message",
			timestamp: "2026-10-27T00:00:00.000Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "learning-call", name: "record_learning_event", arguments: { payload: { topic: "private milestone" } } }],
				stopReason: "stop",
			},
		})}\n`);
		for (const [cookie, sessionId, title] of [[cookieA, sessionA, "Tenant A case"], [cookieB, sessionB, "Tenant B case"]] as const) {
			const response = await api(cookie, `/api/sessions/${sessionId}/showcase-export`, {
				method: "POST", body: JSON.stringify({ id: "shared-case", title }),
			});
			expect(response.status).toBe(200);
		}
		const casesA = join(home, "data", "tenants", tenantA, "showcase-exports", "cases");
		const casesB = join(home, "data", "tenants", tenantB, "showcase-exports", "cases");
		const exportedA = await readFile(join(casesA, "shared-case.json"), "utf-8");
		const exportedB = await readFile(join(casesB, "shared-case.json"), "utf-8");
		expect(exportedA).toContain("Tenant A case");
		expect(exportedA).toContain("tenant-a-profile-secret");
		expect(exportedA).not.toContain("legacy-global-secret");
		expect(exportedB).toContain("Tenant B case");
		expect(exportedB).not.toContain("Tenant A case");
		expect(await readFile(join(casesA, "index.json"), "utf-8")).toContain("Tenant A case");
		expect(await readFile(join(casesB, "index.json"), "utf-8")).toContain("Tenant B case");
		expect(existsSync(join(home, "data", "showcase-exports", "cases"))).toBe(false);
	}, 30_000);
});

describe("session and workspace tenant isolation", () => {
	it("hides legacy resources and rejects cross-tenant reads and mutations", async () => {
		const [cookieA, cookieB] = await Promise.all([
			registerUser("tenant-a@example.com"),
			registerUser("tenant-b@example.com"),
		]);
		await Promise.all([
			configureTestProvider(cookieA, "tenant-a-secret"),
			configureTestProvider(cookieB, "tenant-b-secret"),
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
		expect(terminalResponse.status).toBe(409);
		expect((await api(cookieB, "/api/terminal/sessions", {
			method: "POST", body: JSON.stringify({ sessionId: sessionA.id }),
		})).status).toBe(409);
		expect((await api(cookieB, `/api/runs?sessionId=${sessionA.id}`)).status).toBe(404);
		const authenticatedWsStatus = await new Promise<number>((resolveStatus, reject) => {
			const ws = new WebSocket(`${origin.replace("http", "ws")}/api/terminal/sessions/host-terminal-disabled/ws`, {
				headers: { Cookie: cookieB, Origin: origin },
			});
			ws.once("unexpected-response", (_req, res) => resolveStatus(res.statusCode!));
			ws.once("open", () => { ws.terminate(); reject(new Error("Authenticated host WebSocket connected")); });
			ws.once("error", () => {});
		});
		expect(authenticatedWsStatus).toBe(409);
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
		await configureTestProvider(cookieB, "jobs-b-secret");
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
		const requestsBeforeUnconfigured = providerRequests.length;
		expect((await api(unconfiguredCookie, "/api/sessions", {
			method: "POST", body: JSON.stringify({ newWorkspace: { isTemp: true } }),
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
		expect((await api(cookieA, "/api/skills")).status).toBe(200);
		expect((await api(cookieA, "/api/skills/reload", { method: "POST" })).status).toBe(409);
		expect((await api(cookieA, "/api/skills/upload", {
			method: "POST", body: JSON.stringify({ fileName: "tenant.md", dataBase64: Buffer.from("---\nname: tenant\n---\n").toString("base64") }),
		})).status).toBe(409);

		await configureProvider(cookieB, "tenant-b-secondary", "extra", "extra-model");
		expect((await api(cookieB, "/api/settings/providers/shared", { method: "DELETE" })).status).toBe(200);
		expect((await (await api(cookieA, "/api/settings")).json() as { defaultModel: string }).defaultModel).toBe("tenant-model");
		expect(await readFile(join(home, "config", "config.json"), "utf-8")).toBe(globalConfigBefore);
	}, 90_000);
});

describe("channel runtime isolation", () => {
	it("isolates bridge identities, inbound delivery, workspaces and manual job pushes", async () => {
		const [cookieA, cookieB] = await Promise.all([
			registerUser("channels-a@example.com"),
			registerUser("channels-b@example.com"),
		]);
		const globalConfigBefore = await readFile(join(home, "config", "config.json"), "utf-8");
		const configureProvider = async (cookie: string, apiKey: string) => {
			const response = await api(cookie, "/api/settings/providers", {
				method: "PUT",
				body: JSON.stringify({
					providerId: "shared",
					baseUrl: providerOrigin,
					apiKey,
					api: "openai-completions",
					makeDefault: true,
					models: [{ id: "tenant-model", name: "Tenant stub", input: ["text", "image"] }],
				}),
			});
			expect(response.status).toBe(200);
		};
		await Promise.all([
			configureProvider(cookieA, "channel-a-secret"),
			configureProvider(cookieB, "channel-b-secret"),
		]);
		const configureChannels = (cookie: string, token: string, sidecarBaseUrl: string) => api(cookie, "/api/settings/channels", {
			method: "PUT",
			body: JSON.stringify({
				bridge: { token },
				channels: { qq: { enabled: true, mode: "bridge", sidecarBaseUrl } },
			}),
		});

		expect((await configureChannels(cookieA, "channel-token-a", sidecarOriginA)).status).toBe(200);
		expect((await configureChannels(cookieB, "channel-token-a", sidecarOriginB)).status).toBe(404);
		expect(await (await api(cookieB, "/api/settings")).json() as { bridge?: unknown }).not.toHaveProperty("bridge");
		expect((await configureChannels(cookieB, "channel-token-b", sidecarOriginB)).status).toBe(200);
		for (const cookie of [cookieA, cookieB]) {
			const channels = await (await api(cookie, "/api/channels")).json() as Array<{ name: string; mode: string }>;
			expect(channels).toEqual([{ name: "qq", mode: "bridge", enabled: true, hasDefaultTarget: false }]);
		}
		expect((await api(cookieA, "/api/channels/qq/default-target", {
			method: "POST", body: JSON.stringify({ chatId: "chat-a" }),
		})).status).toBe(200);
		expect((await api(cookieB, "/api/channels/qq/default-target", {
			method: "POST", body: JSON.stringify({ chatId: "chat-b" }),
		})).status).toBe(200);
		expect((await api(cookieA, "/api/channels/qq/test", {
			method: "POST", body: JSON.stringify({ text: "push-only-a" }),
		})).status).toBe(200);
		await waitFor(() => sidecarRequests.some((request) => request.path === "/push" && request.body.includes("push-only-a")), "tenant A test push");
		const pushA = sidecarRequests.find((request) => request.path === "/push" && request.body.includes("push-only-a"));
		expect(pushA).toMatchObject({ sidecar: "a", authorization: "Bearer channel-token-a" });
		expect(pushA?.body).toContain("chat-a");
		expect(sidecarRequests.some((request) => request.sidecar === "b" && request.body.includes("push-only-a"))).toBe(false);

		const bridgeMessage = (token: string, body: Record<string, unknown>) => fetch(`${origin}/api/bridge/messages`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const providerCountBeforeRejected = providerRequests.length;
		expect((await bridgeMessage("channel-token-a", {
			channel: "qq", messageId: "missing-chat", text: "must-not-run",
		})).status).toBe(400);
		expect((await bridgeMessage("wrong-token", {
			channel: "qq", messageId: "wrong-token", chatId: "chat-a", text: "must-not-run",
		})).status).toBe(401);
		expect(providerRequests).toHaveLength(providerCountBeforeRejected);

		const inboundResponses = await Promise.all([
			bridgeMessage("channel-token-a", {
				channel: "qq", messageId: "inbound-a", chatId: "chat-a", text: "channel-a-inbound",
				attachments: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
			}),
			bridgeMessage("channel-token-b", {
				channel: "qq", messageId: "inbound-b", chatId: "chat-b", text: "channel-b-inbound",
			}),
		]);
		expect(inboundResponses.map((response) => response.status)).toEqual([200, 200]);
		await waitFor(() => ["channel-a-inbound", "channel-b-inbound"].every((prompt) =>
			providerRequests.some((request) => request.body.includes(prompt)),
		), "tenant inbound model prompts");
		await waitFor(() => ["inbound-a", "inbound-b"].every((messageId) =>
			sidecarRequests.some((request) => request.path === "/reply" && request.body.includes(messageId)),
		), "tenant bridge replies");
		const channelProviderBodyA = providerRequests.find((request) => request.body.includes("channel-a-inbound"))?.body ?? "";
		expect(channelProviderBodyA).toContain("image_url");
		expect(channelProviderBodyA).toContain("aW1hZ2U=");
		expect(providerRequests.find((request) => request.body.includes("channel-a-inbound"))?.authorization).toBe("Bearer channel-a-secret");
		expect(providerRequests.find((request) => request.body.includes("channel-b-inbound"))?.authorization).toBe("Bearer channel-b-secret");
		const replyA = sidecarRequests.find((request) => request.path === "/reply" && request.body.includes("inbound-a"));
		const replyB = sidecarRequests.find((request) => request.path === "/reply" && request.body.includes("inbound-b"));
		expect(replyA).toMatchObject({ sidecar: "a", authorization: "Bearer channel-token-a" });
		expect(replyB).toMatchObject({ sidecar: "b", authorization: "Bearer channel-token-b" });
		expect(replyA?.body).toContain("chat-a");
		expect(replyB?.body).toContain("chat-b");
		const runsA = await (await api(cookieA, "/api/channels/runs")).json() as Array<{ messageId: string; status: string }>;
		const runsB = await (await api(cookieB, "/api/channels/runs")).json() as Array<{ messageId: string; status: string }>;
		expect(runsA.map((run) => run.messageId)).toEqual(["inbound-a"]);
		expect(runsB.map((run) => run.messageId)).toEqual(["inbound-b"]);

		const pool = new Pool({ connectionString: postgres.databaseUrl });
		const tenantRows = await pool.query<{ id: string; email: string }>(
			`SELECT tenant.id, account.email FROM tenants tenant JOIN "user" account ON account.id = tenant.owner_user_id
			 WHERE account.email IN ('channels-a@example.com', 'channels-b@example.com')`,
		);
		await pool.end();
		const tenantA = tenantRows.rows.find((row) => row.email === "channels-a@example.com")!.id;
		const tenantB = tenantRows.rows.find((row) => row.email === "channels-b@example.com")!.id;
		const chatMapA = await readFile(join(home, "data", "tenants", tenantA, "channels", "chat-sessions.json"), "utf-8");
		const chatMapB = await readFile(join(home, "data", "tenants", tenantB, "channels", "chat-sessions.json"), "utf-8");
		expect(chatMapA).toContain("qq:chat-a");
		expect(chatMapA).not.toContain("chat-b");
		expect(chatMapB).toContain("qq:chat-b");
		expect(chatMapB).not.toContain("chat-a");
		const channelSessionA = JSON.parse(chatMapA)["qq:chat-a"] as string;
		const channelSessionB = JSON.parse(chatMapB)["qq:chat-b"] as string;
		expect(channelSessionA).toMatch(/^durable-/);
		expect(channelSessionB).toMatch(/^durable-/);
		const channelDetailA = await (await api(cookieA, `/api/sessions/${channelSessionA}`)).json() as {
			runtime: string;
			messages: Array<{ role: string; content: string; images?: Array<{ previewUrl: string }> }>;
		};
		expect(channelDetailA.runtime).toBe("durable");
		const channelMessageA = channelDetailA.messages.find((message) => message.content.includes("channel-a-inbound"));
		expect(channelMessageA, JSON.stringify(channelDetailA.messages)).toBeDefined();
		const channelImage = channelMessageA?.images?.[0];
		expect(channelImage, JSON.stringify(channelMessageA)).toBeDefined();
		expect((await api(cookieA, channelImage!.previewUrl)).status).toBe(200);
		expect(await (await api(cookieB, `/api/sessions/${channelSessionB}`)).json()).toMatchObject({ runtime: "durable" });
		expect(existsSync(join(home, "data", "channels", "chat-sessions.json"))).toBe(false);
		const workspacesA = await (await api(cookieA, "/api/workspaces")).json() as Array<{ id: string }>;
		const workspacesB = await (await api(cookieB, "/api/workspaces")).json() as Array<{ id: string }>;
		expect(workspacesA.map((workspace) => workspace.id)).toContain(`channel-qq-${tenantA}`);
		expect(workspacesA.map((workspace) => workspace.id)).not.toContain(`channel-qq-${tenantB}`);
		expect(workspacesB.map((workspace) => workspace.id)).toContain(`channel-qq-${tenantB}`);

		const sessionResponse = await api(cookieA, "/api/sessions", {
			method: "POST", body: JSON.stringify({ runtime: "durable" }),
		});
		expect(sessionResponse.status).toBe(201);
		const ownedSession = await sessionResponse.json() as { id: string };
		const jobResponse = await api(cookieA, "/api/jobs", {
			method: "POST",
			body: JSON.stringify({
				name: "channel job A", cron: "0 9 * * *", timezone: "UTC", enabled: true,
				taskType: "custom_prompt", prompt: "channel-job-a", channel: "qq", runtime: "durable",
				target: { channel: "qq", chatId: "chat-a" },
			}),
		});
		expect(jobResponse.status).toBe(201);
		const job = await jobResponse.json() as { id: string };
		expect((await api(cookieB, `/api/jobs/${job.id}`)).status).toBe(404);
		const runResponse = await api(cookieA, `/api/jobs/${job.id}/run`, {
			method: "POST", body: JSON.stringify({ sessionId: ownedSession.id }),
		});
		expect(runResponse.status).toBe(200);
		expect(await runResponse.json()).toMatchObject({ success: true, pushedToChannel: "qq" });
		expect(await (await api(cookieA, `/api/sessions/${ownedSession.id}`)).json()).toMatchObject({
			runtime: "durable", origin: "scheduler",
		});
		await waitFor(() => sidecarRequests.some((request) => request.path === "/push" && request.body.includes("tenant stub response") && request.body.includes("chat-a")), "manual tenant job push");
		expect(providerRequests.find((request) => request.body.includes("channel-job-a"))?.authorization).toBe("Bearer channel-a-secret");
		expect(sidecarRequests.some((request) => request.sidecar === "b" && request.body.includes("channel-job-a"))).toBe(false);
		expect(await readFile(join(home, "config", "config.json"), "utf-8")).toBe(globalConfigBefore);
	}, 90_000);
});

describe("tenant background execution", () => {
	it("restores tenant model, session, workspace and channel context for deferred jobs", async () => {
		const [cookieA, cookieB] = await Promise.all([
			registerUser("background-a@example.com"),
			registerUser("background-b@example.com"),
		]);
		const globalConfigBefore = await readFile(join(home, "config", "config.json"), "utf-8");
		const configure = async (cookie: string, apiKey: string, token: string, sidecarBaseUrl: string, chatId: string) => {
			expect((await api(cookie, "/api/settings/providers", {
				method: "PUT",
				body: JSON.stringify({
					providerId: "shared", baseUrl: providerOrigin, apiKey, api: "openai-completions",
					makeDefault: true, models: [{ id: "tenant-model", name: "Tenant stub" }],
				}),
			})).status).toBe(200);
			expect((await api(cookie, "/api/settings/channels", {
				method: "PUT",
				body: JSON.stringify({
					bridge: { token },
					channels: { qq: { enabled: true, mode: "bridge", sidecarBaseUrl } },
				}),
			})).status).toBe(200);
			expect((await api(cookie, "/api/channels/qq/default-target", {
				method: "POST", body: JSON.stringify({ chatId }),
			})).status).toBe(200);
		};
		await Promise.all([
			configure(cookieA, "background-a-secret", "background-token-a", sidecarOriginA, "background-chat-a"),
			configure(cookieB, "background-b-secret", "background-token-b", sidecarOriginB, "background-chat-b"),
		]);
		const createJob = async (cookie: string, name: string, prompt: string, runtime?: "legacy" | "durable") => {
			// Use the next UTC minute, not every minute. The test still exercises the
			// real cron/deferred path without arming another slot during its cleanup.
			const scheduled = new Date(Date.now() + 60_000);
			const response = await api(cookie, "/api/jobs", {
				method: "POST",
				body: JSON.stringify({
					name, cron: `${scheduled.getUTCMinutes()} ${scheduled.getUTCHours()} * * *`, timezone: "UTC", enabled: true,
					taskType: "custom_prompt", prompt, channel: "qq", runtime,
				}),
			});
			expect(response.status).toBe(201);
			return response.json() as Promise<{ id: string }>;
		};
		const [jobA, jobB] = await Promise.all([
			createJob(cookieA, "background A", "background-a-prompt", "durable"),
			createJob(cookieB, "background B", "background-b-prompt"),
		]);
		await waitFor(() => ["background-a-prompt", "background-b-prompt"].every((prompt) =>
			providerRequests.some((request) => request.body.includes(prompt)),
		), "deferred tenant model executions", 75_000);
		expect(providerRequests.find((request) => request.body.includes("background-a-prompt"))?.authorization).toBe("Bearer background-a-secret");
		expect(providerRequests.find((request) => request.body.includes("background-b-prompt"))?.authorization).toBe("Bearer background-b-secret");
		expect((await api(cookieA, `/api/jobs/${jobA.id}`, {
			method: "PATCH", body: JSON.stringify({ enabled: false }),
		})).status).toBe(200);
		expect((await api(cookieB, `/api/jobs/${jobB.id}`, {
			method: "PATCH", body: JSON.stringify({ enabled: false }),
		})).status).toBe(200);
		await waitFor(async () => {
			for (const [cookie, jobId] of [[cookieA, jobA.id], [cookieB, jobB.id]] as const) {
				const runs = await (await api(cookie, "/api/jobs/runs")).json() as Array<{ jobId: string; status: string }>;
				if (!runs.some((run) => run.jobId === jobId && run.status === "success")) return false;
			}
			return true;
		}, "tenant background run ledgers");
		await waitFor(() => ["background-chat-a", "background-chat-b"].every((chatId) =>
			sidecarRequests.some((request) => request.path === "/push" && request.body.includes(chatId) && request.body.includes("tenant stub response")),
		), "tenant background channel delivery");
		const pushA = sidecarRequests.find((request) => request.path === "/push" && request.body.includes("background-chat-a") && request.body.includes("tenant stub response"));
		const pushB = sidecarRequests.find((request) => request.path === "/push" && request.body.includes("background-chat-b") && request.body.includes("tenant stub response"));
		expect(pushA).toMatchObject({ sidecar: "a", authorization: "Bearer background-token-a" });
		expect(pushB).toMatchObject({ sidecar: "b", authorization: "Bearer background-token-b" });

		const sessionsA = await (await api(cookieA, "/api/sessions")).json() as Array<{ id: string; runtime?: string; origin?: string }>;
		const sessionsB = await (await api(cookieB, "/api/sessions")).json() as Array<{ id: string; runtime?: string; origin?: string }>;
		expect(sessionsA).toHaveLength(1);
		expect(sessionsB).toHaveLength(1);
		expect(sessionsA[0]).toMatchObject({ runtime: "durable", origin: "scheduler" });
		expect(sessionsA[0].id).toMatch(/^durable-/);
		expect(sessionsB[0]).toMatchObject({ runtime: "durable", origin: "scheduler" });
		expect(sessionsB[0].id).toMatch(/^durable-/);
		expect(sessionsA[0].id).not.toBe(sessionsB[0].id);
		expect((await api(cookieB, `/api/sessions/${sessionsA[0].id}`)).status).toBe(404);

		const pool = new Pool({ connectionString: postgres.databaseUrl });
		try {
			const tenantRows = await pool.query<{ id: string; email: string }>(
				`SELECT tenant.id, account.email FROM tenants tenant JOIN "user" account ON account.id = tenant.owner_user_id
				 WHERE account.email IN ('background-a@example.com', 'background-b@example.com')`,
			);
			const tenantA = tenantRows.rows.find((row) => row.email === "background-a@example.com")!.id;
			const tenantB = tenantRows.rows.find((row) => row.email === "background-b@example.com")!.id;
			const workspacesA = await (await api(cookieA, "/api/workspaces")).json() as Array<{ id: string }>;
			const workspacesB = await (await api(cookieB, "/api/workspaces")).json() as Array<{ id: string }>;
			expect(workspacesA.map((workspace) => workspace.id)).toContain(`channel-scheduler-${tenantA}`);
			expect(workspacesB.map((workspace) => workspace.id)).toContain(`channel-scheduler-${tenantB}`);
			try {
				await waitFor(async () => {
					const claims = await pool.query<{ count: number }>(
						"SELECT COUNT(*)::int AS count FROM job_run_claims WHERE job_id = ANY($1)",
						[[jobA.id, jobB.id]],
					);
					return claims.rows[0].count === 0;
				}, "background claim cleanup");
			} catch (error) {
				const claims = await pool.query(
					"SELECT occurrence_id, job_id, expires_at FROM job_run_claims WHERE job_id = ANY($1)",
					[[jobA.id, jobB.id]],
				);
				const pendingA = await (await api(cookieA, "/api/checkins/pending-runs")).json();
				const pendingB = await (await api(cookieB, "/api/checkins/pending-runs")).json();
				const runsA = await (await api(cookieA, "/api/jobs/runs")).json();
				const runsB = await (await api(cookieB, "/api/jobs/runs")).json();
				throw new Error(`${(error as Error).message}; claims=${JSON.stringify(claims.rows)}; pending=${JSON.stringify([pendingA, pendingB])}; runs=${JSON.stringify([runsA, runsB])}`);
			}
		} finally {
			await pool.end();
		}
		expect(await readFile(join(home, "config", "config.json"), "utf-8")).toBe(globalConfigBefore);
	}, 120_000);
});

describe("durable session HTTP boundary", () => {
	it("isolates tenants, deduplicates request IDs, and replays SSE after disconnect", async () => {
		const [cookieA, cookieB] = await Promise.all([
			registerUser("durable-a@example.com"),
			registerUser("durable-b@example.com"),
		]);
		const configure = async (cookie: string, apiKey: string) => {
			const response = await api(cookie, "/api/settings/providers", {
				method: "PUT",
				body: JSON.stringify({
					providerId: "shared",
					baseUrl: providerOrigin,
					apiKey,
					api: "openai-completions",
					models: [{ id: "tenant-model", name: "Tenant model", contextWindow: 32_000, maxTokens: 2_000 }],
				}),
			});
			expect(response.status).toBe(200);
		};
		await Promise.all([configure(cookieA, "durable-a-secret"), configure(cookieB, "durable-b-secret")]);
		const createDurable = async (cookie: string) => {
			const response = await api(cookie, "/api/sessions", {
				method: "POST",
				body: JSON.stringify({ runtime: "durable", newWorkspace: { isTemp: true } }),
			});
			expect(response.status).toBe(201);
			return response.json() as Promise<{ id: string; runtime: string; workspaceId: string }>;
		};
		const [sessionA, sessionB] = await Promise.all([createDurable(cookieA), createDurable(cookieB)]);
		expect(sessionA.id).toMatch(/^durable-/);
		expect(sessionB.id).toMatch(/^durable-/);
		expect(sessionA.runtime).toBe("durable");
		expect((await api(cookieB, `/api/sessions/${sessionA.id}`)).status).toBe(404);
		expect((await api(cookieB, "/api/chat/stream", {
			method: "POST",
			body: JSON.stringify({ sessionId: sessionA.id, prompt: "cross-tenant-durable", clientRequestId: "denied" }),
		})).status).toBe(404);

		const stream = async (cookie: string, sessionId: string, prompt: string, clientRequestId: string) => {
			const response = await api(cookie, "/api/chat/stream", {
				method: "POST",
				body: JSON.stringify({ sessionId, prompt, clientRequestId }),
			});
			expect(response.status).toBe(200);
			const text = await response.text();
			expect(text).toContain('"type":"done"');
			expect(text).toContain('"persisted":true');
			return text;
		};
		await Promise.all([
			stream(cookieA, sessionA.id, "durable-a-main-prompt", "durable-a-request"),
			stream(cookieB, sessionB.id, "durable-b-main-prompt", "durable-b-request"),
		]);
		expect(providerRequests.find((request) => request.body.includes("durable-a-main-prompt"))?.authorization).toBe("Bearer durable-a-secret");
		expect(providerRequests.find((request) => request.body.includes("durable-b-main-prompt"))?.authorization).toBe("Bearer durable-b-secret");
		const countA = providerRequests.filter((request) => request.body.includes("durable-a-main-prompt")).length;
		await stream(cookieA, sessionA.id, "durable-a-main-prompt", "durable-a-request");
		expect(providerRequests.filter((request) => request.body.includes("durable-a-main-prompt"))).toHaveLength(countA);

		const detailA = await (await api(cookieA, `/api/sessions/${sessionA.id}`)).json() as {
			runtime: string;
			messages: Array<{ role: string; content: string }>;
		};
		expect(detailA.runtime).toBe("durable");
		expect(detailA.messages.filter((message) => message.role === "user" && message.content === "durable-a-main-prompt")).toHaveLength(1);
		const listB = await (await api(cookieB, "/api/sessions")).json() as Array<{ id: string }>;
		expect(listB.some((session) => session.id === sessionA.id)).toBe(false);
		expect(existsSync(join(home, "data", "sessions", `${sessionA.id}.jsonl`))).toBe(false);

		const disconnected = await api(cookieA, "/api/chat/stream", {
			method: "POST",
			body: JSON.stringify({ sessionId: sessionA.id, prompt: "durable-reconnect", clientRequestId: "durable-reconnect-request" }),
		});
		expect(disconnected.status).toBe(200);
		const reader = disconnected.body!.getReader();
		const decoder = new TextDecoder();
		let initial = "";
		while (!initial.includes('"status":"running"')) {
			const chunk = await reader.read();
			if (chunk.done) break;
			initial += decoder.decode(chunk.value, { stream: true });
		}
		expect(initial).toContain('"status":"running"');
		await reader.cancel();
		const status = await (await api(cookieA, `/api/chat/status/${sessionA.id}`)).json() as {
			stream: { turnId: string; clientRequestId: string };
		};
		expect(status.stream.clientRequestId).toBe("durable-reconnect-request");
		const replay = await api(cookieA, `/api/chat/events/${sessionA.id}?turnId=${status.stream.turnId}&after=0`);
		expect(replay.status).toBe(200);
		const replayText = await replay.text();
		expect(replayText).toContain('"type":"done"');
		expect(replayText).toContain('"persisted":true');
		const recovered = await (await api(cookieA, `/api/sessions/${sessionA.id}`)).json() as {
			messages: Array<{ role: string; content: string }>;
		};
		expect(recovered.messages.some((message) => message.role === "user" && message.content === "durable-reconnect")).toBe(true);
		expect(recovered.messages.some((message) => message.role === "assistant" && message.content === "tenant stub response")).toBe(true);
	}, 60_000);

	it("emits workspace changes and records file activity for durable writes", async () => {
		const [cookie, cookieB] = await Promise.all([
			registerUser("durable-workspace-write@example.com"),
			registerUser("durable-workspace-write-other@example.com"),
		]);
		expect((await api(cookie, "/api/settings/providers", {
			method: "PUT",
			body: JSON.stringify({
				providerId: "shared", baseUrl: providerOrigin, apiKey: "durable-workspace-write-secret",
				api: "openai-completions", makeDefault: true,
				models: [{ id: "tenant-model", name: "Tenant model", contextWindow: 32_000, maxTokens: 2_000 }],
			}),
		})).status).toBe(200);
		const created = await api(cookie, "/api/sessions", {
			method: "POST", body: JSON.stringify({ runtime: "durable", newWorkspace: { isTemp: true } }),
		});
		expect(created.status).toBe(201);
		const session = await created.json() as { id: string; workspaceId: string };
		const response = await api(cookie, "/api/chat/stream", {
			method: "POST",
			body: JSON.stringify({
				sessionId: session.id,
				prompt: "durable-workspace-write",
				clientRequestId: "durable-workspace-write-request",
			}),
		});
		expect(response.status).toBe(200);
		let permissionRequestId = "";
		const streamed = await readDurableStream(response, async (permission) => {
			permissionRequestId = permission.requestId;
			expect((await api(cookie, "/api/chat/permission-response", {
				method: "POST",
				body: JSON.stringify({ ...permission, turnId: "stale-turn", decision: "allow_once" }),
			})).status).toBe(409);
			expect((await api(cookieB, "/api/chat/permission-response", {
				method: "POST",
				body: JSON.stringify({ ...permission, decision: "allow_once" }),
			})).status).toBe(404);
			const approved = await api(cookie, "/api/chat/permission-response", {
				method: "POST",
				body: JSON.stringify({ ...permission, decision: "allow_once" }),
			});
			expect(approved.status).toBe(200);
			expect(await approved.json()).toMatchObject({ accepted: true, resumed: true });
		});
		expect(permissionRequestId).toMatch(/^durable-permission-/);
		expect(streamed).toContain('"type":"permission_resolved"');
		expect(streamed).toContain('"type":"workspace_change"');
		expect(streamed).toContain('"toolName":"write"');
		expect(streamed).toContain('"path":"nested/durable-preview.txt"');
		expect(streamed).toContain(`"workspaceId":"${session.workspaceId}"`);
		expect(streamed).toContain('"type":"done"');
		const file = await api(cookie, `/api/workspace/file?path=${encodeURIComponent("nested/durable-preview.txt")}&workspaceId=${encodeURIComponent(session.workspaceId)}`);
		expect(file.status).toBe(200);
		expect(await file.json()).toMatchObject({ path: "nested/durable-preview.txt", content: "durable preview content" });

		const tenantIds = await readdir(join(home, "data", "tenants"));
		const activityFiles = await Promise.all(tenantIds.map(async (tenantId) => {
			try {
				return await readFile(join(home, "data", "tenants", tenantId, "sessions", "workspace-activity.json"), "utf-8");
			} catch {
				return "";
			}
		}));
		const activity = activityFiles.find((content) => content.includes(session.id)) ?? "";
		expect(activity).toContain("nested/durable-preview.txt");

		const noUiCreated = await api(cookie, "/api/sessions", {
			method: "POST", body: JSON.stringify({ runtime: "durable", newWorkspace: { isTemp: false, name: "Durable no UI" } }),
		});
		const noUiSession = await noUiCreated.json() as { id: string; workspaceId: string };
		expect(noUiCreated.status).toBe(201);
		expect(noUiSession.workspaceId).not.toBe(session.workspaceId);
		const noUi = await api(cookie, "/api/chat", {
			method: "POST",
			body: JSON.stringify({
				sessionId: noUiSession.id,
				prompt: "durable-workspace-write",
				clientRequestId: "durable-workspace-no-ui-request",
			}),
		});
		expect(noUi.status).toBe(200);
		const noUiDetail = await (await api(cookie, `/api/sessions/${noUiSession.id}`)).json() as {
			pendingPermission?: unknown;
			messages: Array<{ tools?: Array<{ toolName: string; isError: boolean; result: unknown }> }>;
		};
		expect(noUiDetail.pendingPermission).toBeUndefined();
		const deniedWrite = noUiDetail.messages.flatMap((message) => message.tools ?? [])
			.find((tool) => tool.toolName === "write");
		expect(deniedWrite).toMatchObject({ isError: true });
		expect(JSON.stringify(deniedWrite?.result)).toContain("no streaming web UI");
		const noUiFile = await api(cookie, `/api/workspace/file?path=${encodeURIComponent("nested/durable-preview.txt")}&workspaceId=${encodeURIComponent(noUiSession.workspaceId)}`);
		expect(noUiFile.status, await noUiFile.text()).toBe(404);
	}, 60_000);

	it("instantiates preset workspaces for durable sessions with tenant ownership", async () => {
		const presetDir = join(home, "data", "preset-cache", "durable-preset");
		await mkdir(presetDir, { recursive: true });
		await writeFile(join(presetDir, "preset.json"), JSON.stringify({ id: "durable-preset", name: "Durable preset" }));
		await writeFile(join(presetDir, "agent.md"), "durable preset workspace instructions");
		const [cookieA, cookieB] = await Promise.all([
			registerUser("durable-preset-a@example.com"),
			registerUser("durable-preset-b@example.com"),
		]);
		expect((await api(cookieA, "/api/settings/providers", {
			method: "PUT",
			body: JSON.stringify({
				providerId: "shared", baseUrl: providerOrigin, apiKey: "durable-preset-secret",
				api: "openai-completions", makeDefault: true,
				models: [{ id: "tenant-model", name: "Tenant model", contextWindow: 32_000, maxTokens: 2_000 }],
			}),
		})).status).toBe(200);
		const createPreset = () => api(cookieA, "/api/sessions", {
			method: "POST", body: JSON.stringify({ runtime: "durable", presetId: "durable-preset" }),
		});
		const first = await createPreset();
		expect(first.status).toBe(201);
		const session = await first.json() as { id: string; runtime: string; workspaceId: string };
		expect(session.runtime).toBe("durable");
		expect(session.workspaceId).toMatch(/^preset-durable-preset-/);
		const instructions = await api(cookieA, `/api/workspace/file?path=agent.md&workspaceId=${encodeURIComponent(session.workspaceId)}`);
		expect(instructions.status).toBe(200);
		expect(await instructions.json()).toMatchObject({ content: "durable preset workspace instructions" });
		const second = await createPreset();
		expect(second.status).toBe(201);
		expect(await second.json()).toMatchObject({ runtime: "durable", workspaceId: session.workspaceId });
		expect((await api(cookieB, `/api/sessions/${session.id}`)).status).toBe(404);
		expect((await api(cookieB, `/api/workspace/file?path=agent.md&workspaceId=${encodeURIComponent(session.workspaceId)}`)).status).toBe(404);
	}, 60_000);

	it("streams manual durable jobs and validates explicit runtime selection", async () => {
		const cookie = await registerUser("durable-job-stream@example.com");
		expect((await api(cookie, "/api/settings/providers", {
			method: "PUT",
			body: JSON.stringify({
				providerId: "shared", baseUrl: providerOrigin, apiKey: "durable-job-stream-secret",
				api: "openai-completions", makeDefault: true,
				models: [{ id: "tenant-model", name: "Tenant model", contextWindow: 32_000, maxTokens: 2_000 }],
			}),
		})).status).toBe(200);
		expect((await api(cookie, "/api/jobs", {
			method: "POST",
			body: JSON.stringify({ name: "bad runtime", cron: "0 9 * * *", taskType: "custom_prompt", prompt: "no", runtime: "other" }),
		})).status).toBe(400);
		expect((await api(cookie, "/api/jobs", {
			method: "POST",
			body: JSON.stringify({ name: "bad reminder", cron: "0 9 * * *", taskType: "push_reminder", prompt: "no", runtime: "durable" }),
		})).status).toBe(400);
		const sessionResponse = await api(cookie, "/api/sessions", {
			method: "POST", body: JSON.stringify({ runtime: "durable" }),
		});
		expect(sessionResponse.status).toBe(201);
		const session = await sessionResponse.json() as { id: string };
		const jobResponse = await api(cookie, "/api/jobs", {
			method: "POST",
			body: JSON.stringify({
				name: "durable stream job", cron: "0 9 * * *", timezone: "UTC", enabled: false,
				taskType: "custom_prompt", prompt: "durable-job-stream-prompt", runtime: "durable",
			}),
		});
		expect(jobResponse.status).toBe(201);
		const job = await jobResponse.json() as { id: string; runtime: string };
		expect(job.runtime).toBe("durable");
		const runResponse = await api(cookie, `/api/jobs/${job.id}/run/stream`, {
			method: "POST", body: JSON.stringify({ sessionId: session.id }),
		});
		expect(runResponse.status).toBe(200);
		const streamText = await runResponse.text();
		expect(streamText).toContain("tenant stub response");
		expect(streamText).toContain("job_result");
		expect(streamText).toContain('"success":true');
		expect(providerRequests.find((request) => request.body.includes("durable-job-stream-prompt"))?.authorization)
			.toBe("Bearer durable-job-stream-secret");
		const detail = await (await api(cookie, `/api/sessions/${session.id}`)).json() as {
			runtime: string; origin: string; messages: Array<{ role: string; content: string }>;
		};
		expect(detail).toMatchObject({ runtime: "durable", origin: "scheduler" });
		expect(detail.messages).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "user", content: "durable-job-stream-prompt" }),
			expect.objectContaining({ role: "assistant", content: "tenant stub response" }),
		]));
		const runs = await (await api(cookie, `/api/jobs/${job.id}/runs`)).json() as Array<{ status: string }>;
		expect(runs[0]?.status).toBe("success");
	}, 45_000);

	it("generates durable topics with tenant credentials and the session's pinned model", async () => {
		const [cookieA, cookieB] = await Promise.all([
			registerUser("durable-topic-a@example.com"),
			registerUser("durable-topic-b@example.com"),
		]);
		const configure = async (cookie: string, apiKey: string) => {
			expect((await api(cookie, "/api/settings/providers", {
				method: "PUT",
				body: JSON.stringify({
					providerId: "shared",
					baseUrl: providerOrigin,
					apiKey,
					api: "openai-completions",
					models: [
						{ id: "tenant-model", name: "Tenant model", contextWindow: 32_000, maxTokens: 2_000 },
						{ id: "other-model", name: "Other model", contextWindow: 32_000, maxTokens: 2_000 },
					],
				}),
			})).status).toBe(200);
		};
		await Promise.all([configure(cookieA, "durable-topic-a-secret"), configure(cookieB, "durable-topic-b-secret")]);
		const createDurable = async (cookie: string) => {
			const response = await api(cookie, "/api/sessions", {
				method: "POST", body: JSON.stringify({ runtime: "durable" }),
			});
			expect(response.status).toBe(201);
			return response.json() as Promise<{ id: string }>;
		};
		const [sessionA, sessionB] = await Promise.all([createDurable(cookieA), createDurable(cookieB)]);
		expect((await api(cookieA, "/api/settings/model", {
			method: "POST", body: JSON.stringify({ provider: "shared", model: "other-model" }),
		})).status).toBe(200);
		const turn = async (cookie: string, sessionId: string, prompt: string, requestId: string) => {
			const response = await api(cookie, "/api/chat", {
				method: "POST", body: JSON.stringify({ sessionId, prompt, clientRequestId: requestId }),
			});
			expect(response.status).toBe(200);
		};
		for (const [index, prompt] of ["durable-topic-first", "durable-topic-second", "durable-topic-third"].entries()) {
			await Promise.all([
				turn(cookieA, sessionA.id, `${prompt}-a`, `durable-topic-a-${index}`),
				turn(cookieB, sessionB.id, `${prompt}-b`, `durable-topic-b-${index}`),
			]);
		}
		const topicName = async (cookie: string, sessionId: string) => {
			const response = await api(cookie, `/api/sessions/${sessionId}`);
			const detail = await response.json() as { name?: string };
			return detail.name;
		};
		await waitFor(async () => await topicName(cookieA, sessionA.id) === "租户 A 学习目标"
			&& await topicName(cookieB, sessionB.id) === "租户 B 学习目标", "durable automatic topics");
		const automaticTopics = providerRequests.filter((request) => request.body.includes("请用一句简短的中文短语概括"));
		const topicA = automaticTopics.filter((request) => request.authorization === "Bearer durable-topic-a-secret");
		const topicB = automaticTopics.filter((request) => request.authorization === "Bearer durable-topic-b-secret");
		expect(topicA).toHaveLength(1);
		expect(topicB).toHaveLength(1);
		expect((JSON.parse(topicA[0]!.body) as { model: string }).model).toBe("tenant-model");
		expect((JSON.parse(topicB[0]!.body) as { model: string }).model).toBe("tenant-model");
		expect(topicA[0]?.body).toContain("durable-topic-first-a");
		expect(topicA[0]?.body).toContain("durable-topic-third-a");
		expect(topicB[0]?.body).not.toContain("durable-topic-first-a");

		expect((await api(cookieB, `/api/sessions/${sessionA.id}/generate-topic`, { method: "POST" })).status).toBe(404);
		const regenerated = await api(cookieA, `/api/sessions/${sessionA.id}/generate-topic`, { method: "POST" });
		expect(regenerated.status).toBe(200);
		expect(await regenerated.json()).toMatchObject({ name: "租户 A 学习目标", runtime: "durable", topicPendingUpgrade: false });
		expect(providerRequests.filter((request) => request.authorization === "Bearer durable-topic-a-secret"
			&& request.body.includes("请用一句简短的中文短语概括"))).toHaveLength(2);
	}, 60_000);

	it("indexes and automatically injects durable history for tenant-scoped L3 recall", async () => {
		const [cookieA, cookieB] = await Promise.all([
			registerUser("durable-l3-index-a@example.com"),
			registerUser("durable-l3-index-b@example.com"),
		]);
		const configure = async (cookie: string, apiKey: string) => {
			expect((await api(cookie, "/api/settings/providers", {
				method: "PUT",
				body: JSON.stringify({
					providerId: "shared", baseUrl: providerOrigin, apiKey, api: "openai-completions",
					models: [{ id: "tenant-model", name: "Tenant model", contextWindow: 32_000, maxTokens: 2_000 }],
				}),
			})).status).toBe(200);
		};
		await Promise.all([configure(cookieA, "durable-l3-index-a-secret"), configure(cookieB, "durable-l3-index-b-secret")]);
		const createDurable = async (cookie: string) => {
			const response = await api(cookie, "/api/sessions", { method: "POST", body: JSON.stringify({ runtime: "durable" }) });
			expect(response.status).toBe(201);
			return response.json() as Promise<{ id: string }>;
		};
		const chat = async (cookie: string, sessionId: string, prompt: string, requestId: string) => {
			const response = await api(cookie, "/api/chat", {
				method: "POST", body: JSON.stringify({ sessionId, prompt, clientRequestId: requestId }),
			});
			expect(response.status).toBe(200);
		};
		const [historyA, historyB, recallA, recallB, autoA] = await Promise.all([
			createDurable(cookieA), createDurable(cookieB), createDurable(cookieA), createDurable(cookieB), createDurable(cookieA),
		]);
		await Promise.all([
			chat(cookieA, historyA.id, "durable-topic-first-a", "durable-l3-history-source-a"),
			chat(cookieB, historyB.id, "durable-topic-first-b", "durable-l3-history-source-b"),
		]);
		await Promise.all([
			chat(cookieA, recallA.id, "durable-l3-history-a", "durable-l3-history-request-a"),
			chat(cookieB, recallB.id, "durable-l3-history-b", "durable-l3-history-request-b"),
		]);
		const finalA = providerRequests.find((request) => request.authorization === "Bearer durable-l3-index-a-secret"
			&& request.body.includes("durable-l3-history-a") && request.body.includes("durable-topic-first-a"));
		const finalB = providerRequests.find((request) => request.authorization === "Bearer durable-l3-index-b-secret"
			&& request.body.includes("durable-l3-history-b") && request.body.includes("durable-topic-first-b"));
		expect(finalA).toBeDefined();
		expect(finalB).toBeDefined();
		expect(finalA?.body).not.toContain("durable-topic-first-b");
		expect(finalB?.body).not.toContain("durable-topic-first-a");

		await chat(cookieA, autoA.id, "durable-topic-first followup", "durable-l3-auto-request");
		const autoRequest = providerRequests.find((request) => request.authorization === "Bearer durable-l3-index-a-secret"
			&& request.body.includes("durable-topic-first followup"));
		expect(autoRequest?.body).toContain("# 相关历史对话");
		expect(autoRequest?.body).toContain("durable-topic-first-a");
		expect(autoRequest?.body).not.toContain("durable-topic-first-b");
		const autoDetail = await (await api(cookieA, `/api/sessions/${autoA.id}`)).json() as {
			messages: Array<{ role: string; content: string }>;
		};
		expect(autoDetail.messages.find((message) => message.role === "user")?.content).toBe("durable-topic-first followup");
		expect(autoDetail.messages.find((message) => message.role === "user")?.content).not.toContain("# 相关历史对话");
	}, 60_000);

	it("passes validated attachments and inline images without exposing model-only context as user text", async () => {
		const cookieA = await registerUser("durable-attachments@example.com");
		expect((await api(cookieA, "/api/settings/providers", {
			method: "PUT",
			body: JSON.stringify({
				providerId: "shared",
				baseUrl: providerOrigin,
				apiKey: "durable-attachments-secret",
				api: "openai-completions",
				models: [{ id: "tenant-model", name: "Tenant model", contextWindow: 32_000, maxTokens: 2_000 }],
			}),
		})).status).toBe(200);
		const workspace = await (await api(cookieA, "/api/workspaces", {
			method: "POST", body: JSON.stringify({ name: "Durable attachments" }),
		})).json() as { id: string };
		expect((await api(cookieA, "/api/workspace/create", {
			method: "POST", body: JSON.stringify({ workspaceId: workspace.id, path: "notes.txt", type: "file" }),
		})).status, "create attachment file").toBe(201);
		const workspaceFile = await api(cookieA, "/api/workspace/file", {
			method: "PUT", body: JSON.stringify({ workspaceId: workspace.id, path: "notes.txt", content: "workspace attachment" }),
		});
		expect(workspaceFile.status, "write attachment file").toBe(200);
		const sessionResponse = await api(cookieA, "/api/sessions", {
			method: "POST", body: JSON.stringify({ runtime: "durable", workspaceId: workspace.id }),
		});
		expect(sessionResponse.status, "create durable session in existing workspace").toBe(201);
		const session = await sessionResponse.json() as { id: string };
		const attachments = {
			bindings: [{ word: "资料", wordIndex: 0, files: [{ path: "notes.txt", kind: "file", source: "workspace" }] }],
			loose: [
				{ path: "notes.txt", kind: "file", source: "workspace" },
				{ path: "../outside.txt", kind: "file", source: "workspace" },
			],
		};
		const streamed = await api(cookieA, "/api/chat/stream", {
			method: "POST",
			body: JSON.stringify({ sessionId: session.id, prompt: "总结资料", clientRequestId: "durable-attachments-request", attachments }),
		});
		expect(streamed.status).toBe(200);
		expect(await streamed.text()).toContain('"persisted":true');
		const providerBody = providerRequests.find((request) => request.body.includes("总结资料"))?.body ?? "";
		expect(providerBody).toContain("用户本轮附带文件");
		expect(providerBody).toContain("第1个「资料」→ notes.txt");
		expect(providerBody).not.toContain("outside.txt");
		const detail = await (await api(cookieA, `/api/sessions/${session.id}`)).json() as {
			messages: Array<{ role: string; content: string; attachments?: typeof attachments }>;
		};
		const user = detail.messages.find((message) => message.role === "user");
		expect(user?.content).toBe("总结资料");
		expect(user?.attachments).toEqual({
			bindings: attachments.bindings,
			loose: [attachments.loose[0]],
		});

		const nonStreaming = await api(cookieA, "/api/chat", {
			method: "POST",
			body: JSON.stringify({
				sessionId: session.id,
				prompt: "durable-nonstream-attachment",
				clientRequestId: "durable-nonstream-attachment-request",
				attachments: { bindings: [], loose: [attachments.loose[0]] },
			}),
		});
		expect(nonStreaming.status).toBe(200);
		expect(providerRequests.find((request) => request.body.includes("durable-nonstream-attachment"))?.body).toContain("普通附件");
		const nativeImage = await api(cookieA, "/api/chat/stream", {
			method: "POST",
			body: JSON.stringify({
				sessionId: session.id,
				prompt: "durable-native-inline-image",
				clientRequestId: "durable-native-inline-image-request",
				images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
			}),
		});
		expect(nativeImage.status).toBe(200);
		expect(await nativeImage.text()).toContain('"persisted":true');
		const nativeProviderBody = providerRequests.find((request) => request.body.includes("durable-native-inline-image"))?.body ?? "";
		expect(nativeProviderBody).toContain("image_url");
		expect(nativeProviderBody).toContain("aW1hZ2U=");
		expect(nativeProviderBody).not.toContain("用户本轮上传了");
		const nativeRetry = await api(cookieA, "/api/chat/stream", {
			method: "POST",
			body: JSON.stringify({
				sessionId: session.id,
				prompt: "durable-native-inline-image",
				clientRequestId: "durable-native-inline-image-request",
				images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
			}),
		});
		expect(nativeRetry.status).toBe(200);
		expect(await nativeRetry.text()).toContain('"persisted":true');
		expect(providerRequests.filter((request) => request.body.includes("durable-native-inline-image")
			&& !request.body.includes("请用一句简短的中文短语概括"))).toHaveLength(1);
		const nativeDetail = await (await api(cookieA, `/api/sessions/${session.id}`)).json() as {
			messages: Array<{ role: string; content: string; images?: Array<{ previewUrl: string; mimeType: string }> }>;
		};
		expect(nativeDetail.messages.filter((message) => message.content === "durable-native-inline-image")).toHaveLength(1);
		const nativeUser = nativeDetail.messages.find((message) => message.content === "durable-native-inline-image");
		expect(nativeUser?.images).toHaveLength(1);
		expect(nativeUser?.images?.[0].previewUrl).toContain("/api/workspace/raw?");
		expect((await api(cookieA, nativeUser!.images![0].previewUrl)).status).toBe(200);

		const rejectedNative = await api(cookieA, "/api/chat/stream", {
			method: "POST",
			body: JSON.stringify({
				sessionId: session.id,
				prompt: "durable-image-provider-rejection",
				clientRequestId: "durable-image-provider-rejection-request",
				images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
			}),
		});
		expect(rejectedNative.status).toBe(200);
		expect(await rejectedNative.text()).toContain('"persisted":true');
		const rejectionRequests = providerRequests.filter((request) =>
			request.body.includes("durable-image-provider-rejection"));
		expect(rejectionRequests).toHaveLength(2);
		expect(rejectionRequests[0].body).toContain("image_url");
		expect(rejectionRequests[0].body).not.toContain("用户本轮上传了");
		expect(rejectionRequests[1].body).not.toContain("image_url");
		expect(rejectionRequests[1].body).toContain("用户本轮上传了 1 张图片");
		expect(rejectionRequests[1].body).toContain(".chat-images/");
		const rejectedRetry = await api(cookieA, "/api/chat/stream", {
			method: "POST",
			body: JSON.stringify({
				sessionId: session.id,
				prompt: "durable-image-provider-rejection",
				clientRequestId: "durable-image-provider-rejection-request",
				images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
			}),
		});
		expect(await rejectedRetry.text()).toContain('"persisted":true');
		expect(providerRequests.filter((request) =>
			request.body.includes("durable-image-provider-rejection"))).toHaveLength(2);
		const rejectedDetail = await (await api(cookieA, `/api/sessions/${session.id}`)).json() as {
			messages: Array<{ role: string; content: string }>;
		};
		expect(rejectedDetail.messages.filter((message) =>
			message.content === "durable-image-provider-rejection")).toHaveLength(1);
		expect(rejectedDetail.messages.find((message) =>
			message.content === "durable-image-provider-rejection")?.content).not.toContain("用户本轮上传了");

		expect((await api(cookieA, "/api/settings/providers", {
			method: "PUT",
			body: JSON.stringify({
				providerId: "text-only",
				baseUrl: providerOrigin,
				apiKey: "durable-text-only-secret",
				api: "openai-completions",
				models: [{ id: "text-model", name: "Text model", input: ["text"], contextWindow: 32_000, maxTokens: 2_000 }],
			}),
		})).status).toBe(200);
		expect((await api(cookieA, "/api/settings/model", {
			method: "POST", body: JSON.stringify({ provider: "text-only", model: "text-model" }),
		})).status).toBe(200);
		const textSession = await (await api(cookieA, "/api/sessions", {
			method: "POST", body: JSON.stringify({ runtime: "durable" }),
		})).json() as { id: string };
		const textOnly = await api(cookieA, "/api/chat", {
			method: "POST",
			body: JSON.stringify({
				sessionId: textSession.id,
				prompt: "durable-text-only-inline-image",
				clientRequestId: "durable-text-only-inline-image-request",
				images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
			}),
		});
		expect(textOnly.status).toBe(200);
		const textProviderBody = providerRequests.find((request) => request.body.includes("durable-text-only-inline-image"))?.body ?? "";
		expect(textProviderBody).not.toContain("image_url");
		expect(textProviderBody).toContain("用户本轮上传了 1 张图片");
		expect(textProviderBody).toContain(".chat-images/");
		const textDetail = await (await api(cookieA, `/api/sessions/${textSession.id}`)).json() as {
			messages: Array<{ role: string; content: string; images?: unknown[] }>;
		};
		const textUser = textDetail.messages.find((message) => message.role === "user");
		expect(textUser?.content).toBe("durable-text-only-inline-image");
		expect(textUser?.images).toHaveLength(1);
	}, 60_000);

	it("resumes the original durable run from an authenticated question answer", async () => {
		const [cookieA, cookieB] = await Promise.all([
			registerUser("durable-question-a@example.com"),
			registerUser("durable-question-b@example.com"),
		]);
		const configured = await api(cookieA, "/api/settings/providers", {
			method: "PUT",
			body: JSON.stringify({
				providerId: "shared",
				baseUrl: providerOrigin,
				apiKey: "durable-question-secret",
				api: "openai-completions",
				models: [{ id: "tenant-model", name: "Tenant model", contextWindow: 32_000, maxTokens: 2_000 }],
			}),
		});
		expect(configured.status).toBe(200);
		const created = await api(cookieA, "/api/sessions", {
			method: "POST", body: JSON.stringify({ runtime: "durable" }),
		});
		expect(created.status).toBe(201);
		const session = await created.json() as { id: string };
		const stream = await api(cookieA, "/api/chat/stream", {
			method: "POST",
			body: JSON.stringify({ sessionId: session.id, prompt: "durable-question", clientRequestId: "durable-question-request" }),
		});
		expect(stream.status).toBe(200);
		const reader = stream.body!.getReader();
		const decoder = new TextDecoder();
		let events = "";
		while (!events.includes('"type":"question"')) {
			const chunk = await reader.read();
			if (chunk.done) break;
			events += decoder.decode(chunk.value, { stream: true });
		}
		const questionId = /"questionId":"([^"]+)"/.exec(events)?.[1];
		expect(questionId).toBeTruthy();
		const status = await (await api(cookieA, `/api/chat/status/${session.id}`)).json() as {
			stream: { turnId: string };
		};
		const answer = {
			answers: [{ questionIndex: 0, question: "选择学习难度？", kind: "option", answer: "基础" }],
			cancelled: false,
		};
		expect((await api(cookieB, "/api/chat/question-response", {
			method: "POST",
			body: JSON.stringify({ sessionId: session.id, turnId: status.stream.turnId, questionId, result: answer }),
		})).status).toBe(404);
		expect((await api(cookieA, "/api/chat/question-response", {
			method: "POST",
			body: JSON.stringify({ sessionId: session.id, turnId: "wrong-turn", questionId, result: answer }),
		})).status).toBe(409);
		const answered = await api(cookieA, "/api/chat/question-response", {
			method: "POST",
			body: JSON.stringify({ sessionId: session.id, turnId: status.stream.turnId, questionId, result: answer }),
		});
		expect(answered.status).toBe(200);
		expect(await answered.json()).toMatchObject({ accepted: true, resumed: true, sessionId: session.id });
		while (!events.includes('"type":"done"')) {
			const chunk = await reader.read();
			if (chunk.done) break;
			events += decoder.decode(chunk.value, { stream: true });
		}
		expect(events).toContain('"type":"done"');
		expect(events).toContain('"persisted":true');
		const detail = await (await api(cookieA, `/api/sessions/${session.id}`)).json() as {
			messages: Array<{ role: string; content: string; tools?: unknown[] }>;
			pendingQuestion?: unknown;
		};
		expect(detail.pendingQuestion).toBeUndefined();
		expect(detail.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(JSON.stringify(detail.messages)).toContain("选择学习难度？");
		expect(JSON.stringify(detail.messages)).toContain("基础");

		const noUiSession = await (await api(cookieA, "/api/sessions", {
			method: "POST", body: JSON.stringify({ runtime: "durable" }),
		})).json() as { id: string };
		const noUi = await api(cookieA, "/api/chat", {
			method: "POST",
			body: JSON.stringify({ sessionId: noUiSession.id, prompt: "durable-question", clientRequestId: "durable-question-no-ui" }),
		});
		expect(noUi.status).toBe(200);
		expect(await noUi.json()).toMatchObject({ response: "tenant stub response" });
		const noUiDetail = await (await api(cookieA, `/api/sessions/${noUiSession.id}`)).json() as {
			messages: unknown[];
			pendingQuestion?: unknown;
		};
		expect(noUiDetail.pendingQuestion).toBeUndefined();
		expect(JSON.stringify(noUiDetail.messages)).toContain("User declined to answer questions");
	}, 60_000);

	it("cancels a durable question turn without allowing cross-tenant aborts", async () => {
		const [cookieA, cookieB] = await Promise.all([
			registerUser("durable-abort-a@example.com"),
			registerUser("durable-abort-b@example.com"),
		]);
		expect((await api(cookieA, "/api/settings/providers", {
			method: "PUT",
			body: JSON.stringify({
				providerId: "shared",
				baseUrl: providerOrigin,
				apiKey: "durable-abort-secret",
				api: "openai-completions",
				models: [{ id: "tenant-model", name: "Tenant model", contextWindow: 32_000, maxTokens: 2_000 }],
			}),
		})).status).toBe(200);
		const session = await (await api(cookieA, "/api/sessions", {
			method: "POST", body: JSON.stringify({ runtime: "durable" }),
		})).json() as { id: string };
		const stream = await api(cookieA, "/api/chat/stream", {
			method: "POST",
			body: JSON.stringify({ sessionId: session.id, prompt: "durable-question", clientRequestId: "durable-abort-request" }),
		});
		expect(stream.status).toBe(200);
		const reader = stream.body!.getReader();
		const decoder = new TextDecoder();
		let events = "";
		while (!events.includes('"type":"question"')) {
			const chunk = await reader.read();
			if (chunk.done) break;
			events += decoder.decode(chunk.value, { stream: true });
		}
		const status = await (await api(cookieA, `/api/chat/status/${session.id}`)).json() as {
			stream: { turnId: string; cancelRequested: boolean };
		};
		const abortPath = `/api/chat/${session.id}/${status.stream.turnId}/abort`;
		expect((await api(cookieB, abortPath, { method: "POST" })).status).toBe(404);
		expect((await api(cookieA, abortPath, { method: "POST" })).status).toBe(202);
		while (!events.includes('"type":"aborted"')) {
			const chunk = await reader.read();
			if (chunk.done) break;
			events += decoder.decode(chunk.value, { stream: true });
		}
		expect(events).toContain('"type":"question_resolved"');
		expect(events).toContain('"cancelled":true');
		expect(events).toContain('"type":"aborted"');
		expect(events).not.toContain("tenant stub response");
		expect((await api(cookieA, abortPath, { method: "POST" })).status).toBe(200);
		const detail = await (await api(cookieA, `/api/sessions/${session.id}`)).json() as {
			messages: Array<{ role: string }>;
			pendingQuestion?: unknown;
		};
		expect(detail.pendingQuestion).toBeUndefined();
		expect(detail.messages.filter((message) => message.role === "user")).toHaveLength(1);
	}, 60_000);

	it("writes durable L1/L2/OCR state only to the authenticated tenant roots", async () => {
		const [cookieA, cookieB] = await Promise.all([
			registerUser("durable-memory-a@example.com"),
			registerUser("durable-memory-b@example.com"),
		]);
		const configure = async (cookie: string, tenant: string) => {
			const response = await api(cookie, "/api/settings/providers", {
				method: "PUT",
				body: JSON.stringify({
					providerId: "shared",
					baseUrl: providerOrigin,
					apiKey: "durable-memory-secret",
					api: "openai-completions",
					models: [{ id: "tenant-model", name: "Tenant model", contextWindow: 32_000, maxTokens: 2_000 }],
				}),
			});
			expect(response.status).toBe(200);
			const ocr = await api(cookie, "/api/settings/ocr", {
				method: "PUT",
				body: JSON.stringify({ token: `durable-ocr-secret-${tenant}`, baseUrl: `${ocrOrigin}/jobs` }),
			});
			expect(ocr.status).toBe(200);
		};
		await Promise.all([configure(cookieA, "a"), configure(cookieB, "b")]);
		const runMemoryTurn = async (cookie: string, prompt: string) => {
			const created = await api(cookie, "/api/sessions", {
				method: "POST",
				body: JSON.stringify({ runtime: "durable" }),
			});
			expect(created.status).toBe(201);
			const session = await created.json() as { id: string };
			const response = await api(cookie, "/api/chat/stream", {
				method: "POST",
				body: JSON.stringify({ sessionId: session.id, prompt, clientRequestId: `${prompt}-request` }),
			});
			expect(response.status).toBe(200);
			const text = await response.text();
			expect(text).toContain('"type":"done"');
			expect(text).toContain('"persisted":true');
		};
		await Promise.all([
			runMemoryTurn(cookieA, "durable-memory-a"),
			runMemoryTurn(cookieB, "durable-memory-b"),
		]);

		const pool = new Pool({ connectionString: postgres.databaseUrl });
		let tenantA: string;
		let tenantB: string;
		try {
			const result = await pool.query<{ id: string; email: string }>(
				`SELECT tenant.id, account.email FROM tenants tenant JOIN "user" account ON account.id = tenant.owner_user_id
				 WHERE account.email = ANY($1)`, [["durable-memory-a@example.com", "durable-memory-b@example.com"]],
			);
			tenantA = result.rows.find((row) => row.email === "durable-memory-a@example.com")!.id;
			tenantB = result.rows.find((row) => row.email === "durable-memory-b@example.com")!.id;
		} finally {
			await pool.end();
		}
		const rootA = join(home, "data", "tenants", tenantA);
		const rootB = join(home, "data", "tenants", tenantB);
		const [eventsA, eventsB, manifestA, manifestB, profileA, profileB] = await Promise.all([
			readFile(join(rootA, "learner", "events.jsonl"), "utf-8"),
			readFile(join(rootB, "learner", "events.jsonl"), "utf-8"),
			readFile(join(rootA, "l2", "manifest.jsonl"), "utf-8"),
			readFile(join(rootB, "l2", "manifest.jsonl"), "utf-8"),
			readFile(join(rootA, "learner", "profile.json"), "utf-8"),
			readFile(join(rootB, "learner", "profile.json"), "utf-8"),
		]);
		expect(eventsA).toContain("durable-concept-a");
		expect(eventsA).not.toContain("durable-concept-b");
		expect(eventsB).toContain("durable-concept-b");
		expect(eventsB).not.toContain("durable-concept-a");
		expect(manifestA).toContain("durable-archive-a");
		expect(manifestA).not.toContain("durable-archive-b");
		expect(manifestB).toContain("durable-archive-b");
		expect(manifestB).not.toContain("durable-archive-a");
		expect(profileA).toContain("record_learning_event:");
		expect(profileA).toContain("patch_learner_profile:");
		expect(profileA).toContain("update_learner_profile:");
		expect(profileA).toContain("durable-profile-a");
		expect(profileA).not.toContain("durable-profile-b");
		expect(profileB).toContain("durable-profile-b");
		expect(profileB).not.toContain("durable-profile-a");
		const readOcrCheckpoints = async (tenantRoot: string) => {
			const directory = join(tenantRoot, "ocr");
			const files = await readdir(directory);
			expect(files).toHaveLength(1);
			return (await Promise.all(files.map((file) => readFile(join(directory, file), "utf-8")))).join("\n");
		};
		const [ocrA, ocrB] = await Promise.all([readOcrCheckpoints(rootA), readOcrCheckpoints(rootB)]);
		expect(ocrA).toContain("durable-ocr-text-a");
		expect(ocrA).not.toContain("durable-ocr-text-b");
		expect(ocrB).toContain("durable-ocr-text-b");
		expect(ocrB).not.toContain("durable-ocr-text-a");
		expect(ocrRequests.find((request) => request.body.includes("durable-ocr-a"))?.authorization).toBe("bearer durable-ocr-secret-a");
		expect(ocrRequests.find((request) => request.body.includes("durable-ocr-b"))?.authorization).toBe("bearer durable-ocr-secret-b");
		expect(existsSync(join(home, "data", "learner", "events.jsonl"))).toBe(false);
		expect(existsSync(join(home, "data", "ocr"))).toBe(false);
	}, 60_000);

	it("replays and completes an admitted durable SSE turn after SIGKILL and restart", async () => {
		const cookie = await registerUser("durable-restart@example.com");
		expect((await api(cookie, "/api/settings/providers", {
			method: "PUT",
			body: JSON.stringify({
				providerId: "shared",
				baseUrl: providerOrigin,
				apiKey: "durable-restart-secret",
				api: "openai-completions",
				models: [{ id: "tenant-model", name: "Tenant model", contextWindow: 32_000, maxTokens: 2_000 }],
			}),
		})).status).toBe(200);
		const session = await (await api(cookie, "/api/sessions", {
			method: "POST", body: JSON.stringify({ runtime: "durable" }),
		})).json() as { id: string };
		const stream = await api(cookie, "/api/chat/stream", {
			method: "POST",
			body: JSON.stringify({ sessionId: session.id, prompt: "durable-restart-prompt", clientRequestId: "durable-restart-request" }),
		});
		expect(stream.status).toBe(200);
		const reader = stream.body!.getReader();
		const decoder = new TextDecoder();
		let initial = "";
		while (!initial.includes('"status":"running"')) {
			const chunk = await reader.read();
			if (chunk.done) break;
			initial += decoder.decode(chunk.value, { stream: true });
		}
		const turnId = /"turnId":"([^"]+)"/.exec(initial)?.[1];
		expect(turnId).toBeTruthy();
		await waitFor(() => providerRequests.some((request) => request.body.includes("durable-restart-prompt")), "durable restart provider admission");
		await reader.cancel().catch(() => undefined);
		child.kill("SIGKILL");
		await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
		await startServer();

		const status = await (await api(cookie, `/api/chat/status/${session.id}`)).json() as {
			found: boolean;
			stream: { turnId: string; status: string };
		};
		expect(status).toMatchObject({ found: true, stream: { turnId, status: "running" } });
		const replay = await api(cookie, `/api/chat/events/${session.id}?turnId=${turnId}&after=1`);
		expect(replay.status).toBe(200);
		const replayText = await replay.text();
		const envelopes = replayText.split("\n")
			.filter((line) => line.startsWith("data: {"))
			.map((line) => JSON.parse(line.slice(6)) as { eventId: number; event: { type: string; persisted?: boolean } });
		expect(envelopes.length).toBeGreaterThanOrEqual(2);
		expect(envelopes[0]?.eventId).toBe(2);
		expect(envelopes.map((envelope) => envelope.eventId)).toEqual(envelopes.map((_, index) => index + 2));
		expect(envelopes.at(-1)?.event).toMatchObject({ type: "done", persisted: true });
		const detail = await (await api(cookie, `/api/sessions/${session.id}`)).json() as {
			messages: Array<{ role: string; content: string }>;
		};
		expect(detail.messages.filter((message) => message.role === "user" && message.content === "durable-restart-prompt")).toHaveLength(1);
		expect(detail.messages.some((message) => message.role === "assistant" && message.content === "tenant stub response")).toBe(true);
		expect(providerRequests.filter((request) => request.body.includes("durable-restart-prompt"))).toHaveLength(2);
	}, 60_000);
});
