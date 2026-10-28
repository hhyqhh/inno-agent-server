import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readAuthRuntimeConfig } from "../auth/config.js";
import { migrateAuthDatabase } from "../auth/migration.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../db/test-postgres.js";
import { selectDurableShard, type DurableShardConfig } from "./durable-tenant-router.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SECRET = "durable-shard-integration-secret-at-least-32-characters";
type WorkerId = "worker-a" | "worker-b";
interface Worker {
	id: WorkerId;
	home: string;
	origin: string;
	child?: ChildProcess;
	output: string;
}

let postgres: TemporaryPostgres;
let provider: HttpServer;
let sidecar: HttpServer;
let providerOrigin = "";
let sidecarOrigin = "";
let publicOrigin = "";
let shardConfig: DurableShardConfig;
const workers: Record<WorkerId, Worker> = {
	"worker-a": { id: "worker-a", home: "", origin: "", output: "" },
	"worker-b": { id: "worker-b", home: "", origin: "", output: "" },
};

async function freePort(): Promise<number> {
	const listener = createServer();
	await new Promise<void>((resolveListen, reject) => listener.listen(0, "127.0.0.1", resolveListen).once("error", reject));
	const address = listener.address();
	if (!address || typeof address === "string") throw new Error("Missing free port");
	const port = address.port;
	await new Promise<void>((resolveClose) => listener.close(() => resolveClose()));
	return port;
}

async function startWorker(worker: Worker): Promise<void> {
	worker.output = "";
	worker.child = spawn(process.execPath, ["--import", "tsx", resolve(root, "apps/inno-agent/src/server.ts")], {
		cwd: root,
		env: {
			...process.env,
			INNO_HOME: worker.home,
			INNO_CONFIG_DIR: join(worker.home, "config"),
			INNO_DATA_DIR: join(worker.home, "data"),
			INNO_SKILLS_DIR: join(worker.home, "skills"),
			INNO_WORKSPACE_DIR: join(worker.home, "workspace"),
			INNO_PORT: new URL(worker.origin).port,
			INNO_HOST: "127.0.0.1",
			INNO_AUTH_MODE: "better-auth",
			INNO_MULTI_USER_ENABLED: "true",
			INNO_DURABLE_ENABLED: "true",
			INNO_DURABLE_SHARD_ID: worker.id,
			INNO_DURABLE_SHARD_URLS: JSON.stringify(shardConfig.targets),
			DATABASE_URL: postgres.databaseUrl,
			BETTER_AUTH_SECRET: SECRET,
			BETTER_AUTH_URL: publicOrigin,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	worker.child.stdout?.on("data", (chunk) => { worker.output += chunk; });
	worker.child.stderr?.on("data", (chunk) => { worker.output += chunk; });
	const deadline = Date.now() + 20_000;
	while (true) {
		if (worker.child.exitCode !== null) throw new Error(`${worker.id} exited during startup: ${worker.output}`);
		try {
			if ((await fetch(`${worker.origin}/health`)).ok) return;
		} catch {}
		if (Date.now() > deadline) throw new Error(`${worker.id} startup timed out: ${worker.output}`);
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
}

async function api(worker: Worker, cookie: string, path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${worker.origin}${path}`, {
		...init,
		headers: {
			Cookie: cookie,
			Origin: publicOrigin,
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...init.headers,
		},
	});
}

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	provider = createHttpServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end([
				`data: ${JSON.stringify({ id: "shard-stub", object: "chat.completion.chunk", created: 0, model: "tenant-model", choices: [{ index: 0, delta: { role: "assistant", content: "shard response" }, finish_reason: null }] })}`,
				"",
				`data: ${JSON.stringify({ id: "shard-stub", object: "chat.completion.chunk", created: 0, model: "tenant-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
				"",
				"data: [DONE]",
				"",
				"",
			].join("\n"));
		});
	});
	await new Promise<void>((resolveListen) => provider.listen(0, "127.0.0.1", resolveListen));
	providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
	sidecar = createHttpServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	await new Promise<void>((resolveListen) => sidecar.listen(0, "127.0.0.1", resolveListen));
	sidecarOrigin = `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`;
	const [portA, portB] = await Promise.all([freePort(), freePort()]);
	workers["worker-a"].origin = `http://127.0.0.1:${portA}`;
	workers["worker-b"].origin = `http://127.0.0.1:${portB}`;
	publicOrigin = workers["worker-a"].origin;
	shardConfig = {
		localShardId: "worker-a",
		targets: { "worker-a": workers["worker-a"].origin, "worker-b": workers["worker-b"].origin },
	};
	for (const worker of Object.values(workers)) {
		worker.home = await mkdtemp(join(tmpdir(), `inno-${worker.id}-`));
		await mkdir(join(worker.home, "config"), { recursive: true });
		await writeFile(join(worker.home, "config", "config.json"), JSON.stringify({
			defaultProvider: "dummy",
			defaultModel: "dummy-model",
			providers: { dummy: { baseUrl: "http://127.0.0.1:9", apiKey: "unused", api: "openai-completions", models: [{ id: "dummy-model" }] } },
		}));
	}
	await migrateAuthDatabase(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth",
		DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: SECRET,
		BETTER_AUTH_URL: publicOrigin,
	}));
	await Promise.all(Object.values(workers).map(startWorker));
});

afterAll(async () => {
	await Promise.all(Object.values(workers).map(async (worker) => {
		if (worker.child?.exitCode === null) {
			worker.child.kill("SIGTERM");
			await new Promise<void>((resolveExit) => worker.child!.once("exit", () => resolveExit()));
		}
		if (worker.home) await rm(worker.home, { recursive: true, force: true });
	}));
	if (provider) {
		provider.closeAllConnections();
		await new Promise<void>((resolveClose) => provider.close(() => resolveClose()));
	}
	if (sidecar) {
		sidecar.closeAllConnections();
		await new Promise<void>((resolveClose) => sidecar.close(() => resolveClose()));
	}
	await postgres?.close();
});

it("routes a verified tenant and its durable stream to one owning worker", async () => {
	const email = "durable-shard@example.com";
	const registered = await fetch(`${publicOrigin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: publicOrigin },
		body: JSON.stringify({ name: "Durable shard", email, password: "durable-shard-password-123" }),
	});
	expect(registered.status).toBe(200);
	const cookie = registered.headers.get("set-cookie")?.split(";", 1)[0]!;
	// Personal tenants are provisioned on the first authenticated application
	// request, not by Better Auth's account endpoint itself.
	expect((await api(workers["worker-a"], cookie, "/api/sessions")).status).toBe(200);
	const pool = new Pool({ connectionString: postgres.databaseUrl });
	let tenantId: string;
	try {
		const result = await pool.query<{ id: string }>(
			'SELECT tenant.id FROM tenants tenant JOIN "user" account ON account.id = tenant.owner_user_id WHERE account.email = $1',
			[email],
		);
		tenantId = result.rows[0].id;
	} finally {
		await pool.end();
	}
	const ownerId = selectDurableShard(tenantId, shardConfig) as WorkerId;
	const nonOwnerId: WorkerId = ownerId === "worker-a" ? "worker-b" : "worker-a";
	const owner = workers[ownerId];
	const nonOwner = workers[nonOwnerId];

	const configured = await api(nonOwner, cookie, "/api/settings/providers", {
		method: "PUT",
		body: JSON.stringify({
			providerId: "shared", baseUrl: providerOrigin, apiKey: "durable-shard-secret",
			api: "openai-completions", makeDefault: true,
			models: [{ id: "tenant-model", name: "Tenant model", contextWindow: 32_000, maxTokens: 2_000 }],
		}),
	});
	expect(configured.status).toBe(200);
	expect(configured.headers.get("x-inno-durable-shard")).toBe(ownerId);
	const created = await api(nonOwner, cookie, "/api/sessions", {
		method: "POST", body: JSON.stringify({ runtime: "durable", newWorkspace: { isTemp: true } }),
	});
	expect(created.status).toBe(201);
	expect(created.headers.get("x-inno-durable-shard")).toBe(ownerId);
	const session = await created.json() as { id: string; workspaceId: string };
	const tenantStorage = (worker: Worker) => join(worker.home, "data", "tenants", tenantId, "durable", "storage", session.id, "session.sqlite");
	expect(existsSync(tenantStorage(nonOwner))).toBe(false);

	const streamed = await api(nonOwner, cookie, "/api/chat/stream", {
		method: "POST",
		body: JSON.stringify({ sessionId: session.id, prompt: "durable shard prompt", clientRequestId: "durable-shard-request" }),
	});
	expect(streamed.status).toBe(200);
	expect(streamed.headers.get("x-inno-durable-shard")).toBe(ownerId);
	const text = await streamed.text();
	expect(text).toContain("shard response");
	expect(text).toContain('"type":"done"');
	expect(existsSync(tenantStorage(owner))).toBe(true);
	const detail = await api(nonOwner, cookie, `/api/sessions/${session.id}`);
	expect(detail.status).toBe(200);
	expect(await detail.json()).toMatchObject({ id: session.id, runtime: "durable" });
	expect(existsSync(tenantStorage(nonOwner))).toBe(false);

	const bridgeToken = "durable-shard-bridge-token";
	const channels = await api(nonOwner, cookie, "/api/settings/channels", {
		method: "PUT",
		body: JSON.stringify({
			bridge: { token: bridgeToken },
			channels: { qq: { enabled: true, mode: "bridge", sidecarBaseUrl: sidecarOrigin } },
		}),
	});
	expect(channels.status).toBe(200);
	expect(channels.headers.get("x-inno-durable-shard")).toBe(ownerId);
	const callback = await fetch(`${nonOwner.origin}/api/bridge/messages`, {
		method: "POST",
		headers: { Authorization: `Bearer ${bridgeToken}`, "Content-Type": "application/json" },
		body: JSON.stringify({ channel: "qq", messageId: "shard-inbound", chatId: "shard-chat", text: "bridge shard prompt" }),
	});
	expect(callback.status).toBe(200);
	expect(callback.headers.get("x-inno-durable-shard")).toBe(ownerId);
	let runs: Array<{ messageId: string; status: string }> = [];
	const deadline = Date.now() + 15_000;
	while (!runs.some((run) => run.messageId === "shard-inbound" && run.status === "success")) {
		const response = await api(nonOwner, cookie, "/api/channels/runs");
		expect(response.status).toBe(200);
		runs = await response.json() as Array<{ messageId: string; status: string }>;
		if (Date.now() > deadline) throw new Error(`Bridge callback did not finish on its owner: ${JSON.stringify(runs)}`);
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	const runLog = (worker: Worker) => join(worker.home, "data", "tenants", tenantId, "channels", "runs.jsonl");
	expect(existsSync(runLog(owner))).toBe(true);
	expect(existsSync(runLog(nonOwner))).toBe(false);
}, 60_000);
