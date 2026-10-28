import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
	forwardDurableTenantRequest,
	readDurableShardConfig,
	selectDurableShard,
	type DurableShardConfig,
} from "./durable-tenant-router.js";

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => {
		server.closeAllConnections();
		server.close(() => resolveClose());
	})));
});

async function listen(server: Server): Promise<string> {
	servers.push(server);
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test server address");
	return `http://127.0.0.1:${address.port}`;
}

function shardConfig(localShardId: string, workerA: string, workerB: string): DurableShardConfig {
	return { localShardId, targets: { "worker-a": workerA, "worker-b": workerB } };
}

describe("durable tenant router", () => {
	it("is disabled without explicit shard configuration and validates the multi-user gate", () => {
		expect(readDurableShardConfig({})).toBeNull();
		expect(() => readDurableShardConfig({ INNO_DURABLE_SHARD_ID: "worker-a" })).toThrow(/must be configured together|requires Better Auth/);
		expect(() => readDurableShardConfig({
			INNO_AUTH_MODE: "better-auth",
			INNO_MULTI_USER_ENABLED: "true",
			INNO_DURABLE_ENABLED: "true",
			INNO_DURABLE_SHARD_ID: "worker-a",
			INNO_DURABLE_SHARD_URLS: JSON.stringify({ "worker-a": "http://127.0.0.1:3000" }),
		})).not.toThrow();
	});

	it("selects a stable sorted shard from the verified tenant ID", () => {
		const config = shardConfig("worker-a", "http://a.local", "http://b.local");
		const reversed = { ...config, targets: { "worker-b": "http://b.local", "worker-a": "http://a.local" } };
		const assignments = Array.from({ length: 40 }, (_, index) => `tenant-${index}`);
		expect(assignments.map((tenantId) => selectDurableShard(tenantId, config)))
			.toEqual(assignments.map((tenantId) => selectDurableShard(tenantId, reversed)));
		expect(new Set(assignments.map((tenantId) => selectDurableShard(tenantId, config)))).toEqual(new Set(["worker-a", "worker-b"]));
	});

	it("forwards the untouched body and cookie to the verified tenant owner", async () => {
		let received: { body: string; cookie?: string; forwarded?: string; url?: string } | undefined;
		const owner = createServer((req, res) => {
			let body = "";
			req.setEncoding("utf-8");
			req.on("data", (chunk) => { body += chunk; });
			req.on("end", () => {
				received = {
					body,
					cookie: req.headers.cookie,
					forwarded: req.headers["x-inno-durable-forwarded"] as string | undefined,
					url: req.url,
				};
				res.writeHead(201, { "Content-Type": "application/json", "x-owner": "worker-b" });
				res.end(JSON.stringify({ accepted: true }));
			});
		});
		const ownerOrigin = await listen(owner);
		const tenantId = Array.from({ length: 100 }, (_, index) => `tenant-${index}`)
			.find((id) => selectDurableShard(id, shardConfig("worker-a", "http://a.local", "http://b.local")) === "worker-b")!;
		let sourceOrigin = "";
		const source = createServer((req, res) => {
			const handled = forwardDurableTenantRequest(req, res, {
				tenantId, userId: "verified-user", role: "owner",
			}, shardConfig("worker-a", sourceOrigin, ownerOrigin));
			if (!handled) {
				res.writeHead(500);
				res.end();
			}
		});
		sourceOrigin = await listen(source);
		const response = await fetch(`${sourceOrigin}/api/chat/stream?turn=1`, {
			method: "POST",
			headers: { Cookie: "session_token=verified", "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "durable work" }),
		});
		expect(response.status).toBe(201);
		expect(response.headers.get("x-inno-durable-shard")).toBe("worker-b");
		expect(response.headers.get("x-owner")).toBe("worker-b");
		expect(await response.json()).toEqual({ accepted: true });
		expect(received).toEqual({
			body: JSON.stringify({ prompt: "durable work" }),
			cookie: "session_token=verified",
			forwarded: "1",
			url: "/api/chat/stream?turn=1",
		});
	});
});
