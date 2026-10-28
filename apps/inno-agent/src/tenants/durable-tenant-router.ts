import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { TenantContext } from "./store.js";
import { json } from "../server/http-helpers.js";
import { logger } from "../logger.js";

export interface DurableShardConfig {
	localShardId: string;
	targets: Readonly<Record<string, string>>;
}

const FORWARDED_HEADER = "x-inno-durable-forwarded";

function enabled(value: string | undefined): boolean {
	return /^(1|true)$/i.test(value?.trim() ?? "");
}

/** Static worker discovery. Tenant identity is never read from this config or
 * from a request header; callers pass only the verified PostgreSQL tenant. */
export function readDurableShardConfig(env: NodeJS.ProcessEnv): DurableShardConfig | null {
	const localShardId = env.INNO_DURABLE_SHARD_ID?.trim() ?? "";
	const rawTargets = env.INNO_DURABLE_SHARD_URLS?.trim() ?? "";
	if (!localShardId && !rawTargets) return null;
	if (env.INNO_AUTH_MODE?.trim() !== "better-auth"
		|| !enabled(env.INNO_MULTI_USER_ENABLED)
		|| !enabled(env.INNO_DURABLE_ENABLED)) {
		throw new Error("Durable sharding requires Better Auth, INNO_MULTI_USER_ENABLED=true and INNO_DURABLE_ENABLED=true");
	}
	if (!localShardId || !rawTargets) {
		throw new Error("INNO_DURABLE_SHARD_ID and INNO_DURABLE_SHARD_URLS must be configured together");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawTargets);
	} catch {
		throw new Error("INNO_DURABLE_SHARD_URLS must be a JSON object of shard IDs to origin URLs");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("INNO_DURABLE_SHARD_URLS must be a JSON object of shard IDs to origin URLs");
	}
	const targets: Record<string, string> = {};
	for (const [shardId, rawUrl] of Object.entries(parsed)) {
		if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(shardId) || typeof rawUrl !== "string") {
			throw new Error(`Invalid durable shard entry: ${shardId}`);
		}
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			throw new Error(`Invalid durable shard URL for ${shardId}`);
		}
		if ((url.protocol !== "http:" && url.protocol !== "https:")
			|| url.username || url.password || (url.pathname !== "/" && url.pathname !== "")
			|| url.search || url.hash) {
			throw new Error(`Durable shard URL must be an http(s) origin without credentials or paths: ${shardId}`);
		}
		targets[shardId] = url.origin;
	}
	if (!targets[localShardId]) throw new Error(`Local durable shard ${localShardId} is missing from INNO_DURABLE_SHARD_URLS`);
	return { localShardId, targets };
}

export function selectDurableShard(tenantId: string, config: DurableShardConfig): string {
	const shardIds = Object.keys(config.targets).sort();
	if (shardIds.length === 0) throw new Error("No durable shards configured");
	const digest = createHash("sha256").update(`tenant\0${tenantId}`).digest();
	return shardIds[Number(digest.readUInt32BE(0) % shardIds.length)];
}

/** Forward after cookie authentication and personal-tenant provisioning, before
 * the request body or local agent runtime is touched. The target authenticates
 * the forwarded cookie again; no client-supplied tenant or shard is trusted. */
export function forwardDurableTenantRequest(
	req: IncomingMessage,
	res: ServerResponse,
	tenant: TenantContext,
	config: DurableShardConfig,
): boolean {
	const targetShard = selectDurableShard(tenant.tenantId, config);
	if (targetShard === config.localShardId) return false;
	if (req.headers[FORWARDED_HEADER]) {
		json(res, 503, { error: "Durable shard forwarding loop detected", code: "durable_shard_loop" });
		return true;
	}
	const target = new URL(req.url ?? "/", config.targets[targetShard]);
	const transportRequest = target.protocol === "https:" ? httpsRequest : httpRequest;
	const headers = { ...req.headers, host: target.host, [FORWARDED_HEADER]: "1" };
	res.setHeader("x-inno-durable-shard", targetShard);
	const upstream = transportRequest(target, { method: req.method, headers }, (upstreamResponse) => {
		res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
		upstreamResponse.pipe(res);
	});
	upstream.on("error", (error) => {
		logger.error({ err: error, tenantId: tenant.tenantId, targetShard }, "durable tenant shard forwarding failed");
		if (res.headersSent) {
			res.end();
		} else {
			json(res, 502, { error: "Durable shard owner unavailable", code: "durable_shard_unavailable" });
		}
	});
	res.once("close", () => {
		if (!res.writableFinished) upstream.destroy();
	});
	req.pipe(upstream);
	return true;
}
