import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeConfig } from "../config.js";
import { runInTenantContext, runWithoutTenantContext } from "../tenants/current.js";
import { saveTenantConfig } from "../tenants/config.js";
import { setRequestTenant } from "../tenants/http.js";
import type { TenantContext, TenantStore } from "../tenants/store.js";
import { DurableRuntimeDisabledError, DurableSessionService } from "./durable-session-service.js";
import { DurableSessionRuntime, type DurableSessionRuntimeOptions } from "./durable-runtime.js";

const roots: string[] = [];
const services: DurableSessionService[] = [];
const tenantStore = {} as TenantStore;

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "inno-durable-service-"));
	roots.push(value);
	return value;
}

function config(apiKey: string) {
	return normalizeConfig({
		defaultProvider: "faux-configured",
		defaultModel: "faux-model",
		providers: {
			"faux-configured": {
				baseUrl: "http://faux.invalid/v1",
				apiKey,
				models: [{ id: "faux-model", name: "Faux", reasoning: false, input: ["text"], contextWindow: 8_000, maxTokens: 1_000 }],
			},
		},
	});
}

function tenant(id: string): TenantContext {
	return { tenantId: id, userId: `user-${id}`, role: "owner" };
}

function inTenant<T>(context: TenantContext, operation: (req: IncomingMessage) => T): T {
	const req = { headers: {} } as IncomingMessage;
	return runWithoutTenantContext(() => {
		setRequestTenant(req, context, tenantStore);
		return runInTenantContext(context, tenantStore, () => operation(req));
	});
}

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("DurableSessionService", () => {
	it("derives isolated catalog/storage roots and runs concurrent tenant sessions", async () => {
		const base = root();
		const workspace = join(base, "workspace");
		mkdirSync(workspace, { recursive: true });
		const localConfig = config("local-key");
		saveTenantConfig(base, "tenant-a", config("key-a"));
		saveTenantConfig(base, "tenant-b", config("key-b"));
		const providers = new Map<string, FauxProviderHandle>();
		const service = new DurableSessionService({
			dataDir: base,
			getLocalConfig: () => localConfig,
			enabled: true,
			resolveWorkspaceDir: () => workspace,
			openRuntime: async (options: DurableSessionRuntimeOptions) => {
				let faux = providers.get(options.storagePath);
				if (!faux) {
					faux = fauxProvider();
					faux.setResponses([fauxAssistantMessage(options.storagePath.includes("tenant-a") ? "answer A" : "answer B")]);
					providers.set(options.storagePath, faux);
				}
				const models = createModels();
				models.setProvider(faux.provider);
				return DurableSessionRuntime.open({
					...options,
					models,
					model: { provider: faux.provider.id, modelId: faux.getModel().id },
				});
			},
		});
		services.push(service);
		const a = tenant("tenant-a");
		const b = tenant("tenant-b");
		const boundA = inTenant(a, (req) => ({ req, summary: service.create(req, { workspaceId: "workspace-a" }) }));
		const boundB = inTenant(b, (req) => ({ req, summary: service.create(req, { workspaceId: "workspace-b" }) }));
		expect(boundA.summary.id).not.toBe(boundB.summary.id);
		const [answerA, answerB] = await Promise.all([
			inTenant(a, async () => {
				const lease = await service.lease(boundA.req, boundA.summary.id);
				try {
					const submission = await lease.runtime.submit("question A", "shared-request");
					const result = await lease.runtime.waitForSubmission(submission.id);
					return result;
				} finally { await lease.release(); }
			}),
			inTenant(b, async () => {
				const lease = await service.lease(boundB.req, boundB.summary.id);
				try {
					const submission = await lease.runtime.submit("question B", "shared-request");
					const result = await lease.runtime.waitForSubmission(submission.id);
					return result;
				} finally { await lease.release(); }
			}),
		]);
		expect(answerA).toMatchObject({ status: "done", text: "answer A" });
		expect(answerB).toMatchObject({ status: "done", text: "answer B" });
		expect(inTenant(a, () => service.list(boundA.req)).map((item) => item.id)).toEqual([boundA.summary.id]);
		expect(inTenant(b, () => service.list(boundB.req)).map((item) => item.id)).toEqual([boundB.summary.id]);
		expect(readFileSync(join(base, "tenants", "tenant-a", "durable", "sessions.json"), "utf-8")).toContain(boundA.summary.id);
		expect(readFileSync(join(base, "tenants", "tenant-b", "durable", "sessions.json"), "utf-8")).not.toContain(boundA.summary.id);
	});

	it("keeps request deduplication across idle runtime close/reopen", async () => {
		await runWithoutTenantContext(async () => {
		const base = root();
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("one committed answer")]);
		const service = new DurableSessionService({
			dataDir: base,
			getLocalConfig: () => config("local"),
			enabled: true,
			resolveWorkspaceDir: () => base,
			openRuntime: async (options) => {
				const models = createModels();
				models.setProvider(faux.provider);
				return DurableSessionRuntime.open({ ...options, models, model: { provider: faux.provider.id, modelId: faux.getModel().id } });
			},
		});
		services.push(service);
		const req = { headers: {} } as IncomingMessage;
		const session = service.create(req, { workspaceId: "workspace" });
		const submit = async () => {
			const lease = await service.lease(req, session.id);
			try {
				const submission = await lease.runtime.submit("same question", "stable-request");
				return { id: submission.id, result: await lease.runtime.waitForSubmission(submission.id) };
			} finally { await lease.release(); }
		};
		const first = await submit();
		const duplicate = await submit();
		expect(duplicate.id).toBe(first.id);
		expect(duplicate.result).toMatchObject({ status: "done", text: "one committed answer" });
		expect(faux.state.callCount).toBe(1);
		const held = await service.lease(req, session.id);
		await expect(service.delete(req, session.id)).rejects.toThrow("active operation");
		await held.release();
		const detail = await service.snapshot(req, session.id);
		expect(detail.messages.filter((message) => message.role === "user")).toHaveLength(1);
		const reread = await service.snapshot(req, session.id);
		expect(reread.revision).toBe(detail.revision);
		expect(reread.summary.updatedAt).toBe(detail.summary.updatedAt);
		});
	});

	it("requires the explicit runtime gate and leaves legacy JSONL untouched", async () => {
		const base = root();
		const service = new DurableSessionService({
			dataDir: base,
			getLocalConfig: () => config("local"),
			enabled: false,
			resolveWorkspaceDir: () => base,
		});
		services.push(service);
		const req = { headers: {} } as IncomingMessage;
		expect(() => service.create(req, { workspaceId: "workspace" })).toThrow(DurableRuntimeDisabledError);
		const legacy = join(base, "sessions", "legacy.jsonl");
		mkdirSync(join(base, "sessions"), { recursive: true });
		writeFileSync(legacy, "{\"type\":\"session\"}\n");
		expect(readFileSync(legacy, "utf-8")).toBe("{\"type\":\"session\"}\n");
	});
});
