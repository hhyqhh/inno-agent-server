import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeConfig } from "../config.js";
import { runInTenantContext, runWithoutTenantContext, getCurrentTenant } from "../tenants/current.js";
import { saveTenantConfig } from "../tenants/config.js";
import { loadEvents } from "../memory/learner/profile-store.js";
import { closeL3Memory, ScopedL3Memory } from "../memory/l3/l3-tools.js";
import { ChannelRegistry } from "../channels/channel.js";
import { setRequestTenant } from "../tenants/http.js";
import type { DurableStorageLock, TenantContext, TenantStore } from "../tenants/store.js";
import { DurableRuntimeDisabledError, DurableSessionService } from "./durable-session-service.js";
import { DurableSessionRuntime, type DurableSessionRuntimeOptions } from "./durable-runtime.js";

const roots: string[] = [];
const l3Dirs: string[] = [];
const services: DurableSessionService[] = [];
const tenantStore = {
	acquireDurableStorageLock: async () => ({
		lost: false,
		onLost: () => {},
		release: async () => {},
	}),
} as unknown as TenantStore;

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

function inTenant<T>(context: TenantContext, operation: (req: IncomingMessage) => T, store: TenantStore = tenantStore): T {
	const req = { headers: {} } as IncomingMessage;
	return runWithoutTenantContext(() => {
		setRequestTenant(req, context, store);
		return runInTenantContext(context, store, () => operation(req));
	});
}

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	for (const path of l3Dirs.splice(0)) closeL3Memory(path);
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
		writeFileSync(join(workspace, "shared.txt"), "tenant channel payload");
		const channelSends: Array<{ tenantId: string; chatId: string }> = [];
		const channelFor = (tenantId: string) => ({
			name: "feishu",
			verify: async () => true,
			parse: async () => null,
			reply: async () => {},
			push: async () => {},
			sendFile: async (target: { chatId: string }) => { channelSends.push({ tenantId, chatId: target.chatId }); },
		});
		const scopedChannelRegistry = {
			all: () => {
				const tenantId = getCurrentTenant()?.tenantId;
				if (!tenantId) throw new Error("Missing tenant during channel lookup");
				return [channelFor(tenantId)];
			},
			get: () => {
				const tenantId = getCurrentTenant()?.tenantId;
				if (!tenantId) throw new Error("Missing tenant during channel lookup");
				return channelFor(tenantId);
			},
			getDefaultTarget: () => {
				const tenantId = getCurrentTenant()?.tenantId;
				if (!tenantId) throw new Error("Missing tenant during target lookup");
				return { channel: "feishu", chatId: `chat-${tenantId}` };
			},
		} as unknown as ChannelRegistry;
		const service = new DurableSessionService({
			dataDir: base,
			getLocalConfig: () => localConfig,
			enabled: true,
			resolveWorkspaceDir: () => workspace,
			getChannelRegistry: () => scopedChannelRegistry,
			tenantStore,
			openRuntime: async (options: DurableSessionRuntimeOptions) => {
				let faux = providers.get(options.storagePath);
				if (!faux) {
					faux = fauxProvider();
					const tenantConcept = options.storagePath.includes("tenant-a") ? "concept-a" : "concept-b";
					faux.setResponses([
						fauxAssistantMessage(fauxToolCall("record_learning_event", {
							event_type: "concept_explained",
							context: { concept_ids: [tenantConcept] },
							payload: { topic: tenantConcept },
						}, { id: `event-${tenantConcept}` }), { stopReason: "toolUse" }),
						fauxAssistantMessage(fauxToolCall("send_file_to_channel", {
							filePath: "shared.txt",
							channel: "feishu",
						}, { id: `channel-${tenantConcept}` }), { stopReason: "toolUse" }),
						fauxAssistantMessage(options.storagePath.includes("tenant-a") ? "answer A" : "answer B"),
					]);
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
		const eventsA = loadEvents(join(base, "tenants", "tenant-a", "learner"));
		const eventsB = loadEvents(join(base, "tenants", "tenant-b", "learner"));
		expect(eventsA).toHaveLength(1);
		expect(eventsB).toHaveLength(1);
		expect(eventsA[0]!.context.concept_ids).toEqual(["concept-a"]);
		expect(eventsB[0]!.context.concept_ids).toEqual(["concept-b"]);
		expect(channelSends).toEqual(expect.arrayContaining([
			{ tenantId: "tenant-a", chatId: "chat-tenant-a" },
			{ tenantId: "tenant-b", chatId: "chat-tenant-b" },
		]));
		expect(channelSends).toHaveLength(2);
		expect(readdirSync(join(base, "tenants", "tenant-a", "channels", "outbox"))).toHaveLength(2);
		expect(readdirSync(join(base, "tenants", "tenant-b", "channels", "outbox"))).toHaveLength(2);
		await inTenant(a, () => service.delete(boundA.req, boundA.summary.id));
		expect(readdirSync(join(base, "tenants", "tenant-a", "channels", "outbox"))).toHaveLength(0);
		expect(readdirSync(join(base, "tenants", "tenant-b", "channels", "outbox"))).toHaveLength(2);
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

	it("loads workspace agent and private-skill context afresh on reopen", async () => {
		const base = root();
		const workspace = join(base, "workspace");
		mkdirSync(join(workspace, ".skills", "helper"), { recursive: true });
		writeFileSync(join(workspace, "agent.md"), "先使用工作区术语表。 ");
		writeFileSync(join(workspace, ".skills", "helper", "SKILL.md"), [
			"---",
			"name: durable-helper",
			"description: 工作区专用技能",
			"---",
			"",
			"# Helper",
			"遵循本工作区的特殊工作流程。",
		].join("\n"));
		const faux = fauxProvider();
		const instructionSnapshots: string[] = [];
		const service = new DurableSessionService({
			dataDir: base,
			getLocalConfig: () => config("local"),
			enabled: true,
			resolveWorkspaceDir: () => workspace,
			openRuntime: async (options) => {
				instructionSnapshots.push(options.instructions ?? "");
				const models = createModels();
				models.setProvider(faux.provider);
				return DurableSessionRuntime.open({ ...options, models, model: { provider: faux.provider.id, modelId: faux.getModel().id } });
			},
		});
		services.push(service);
		await runWithoutTenantContext(async () => {
			const req = { headers: {} } as IncomingMessage;
			const session = service.create(req, { workspaceId: "workspace" });
			const reopen = async () => {
				const lease = await service.lease(req, session.id);
				await lease.release();
			};
			await reopen();
			expect(instructionSnapshots[0]).toContain("# 工作区上下文 (agent.md)");
			expect(instructionSnapshots[0]).toContain("先使用工作区术语表。");
			expect(instructionSnapshots[0]).toContain("# 本工作区私有技能");
			expect(instructionSnapshots[0]).toContain("durable-helper");
			expect(instructionSnapshots[0]).toContain("工作区专用技能");

			writeFileSync(join(workspace, "agent.md"), "使用更新后的工作区规则。");
			await reopen();
			expect(instructionSnapshots[1]).toContain("使用更新后的工作区规则。");
			expect(instructionSnapshots[1]).not.toContain("先使用工作区术语表。");
		});
	});

	it("indexes durable snapshots and prepares recall outside the current session", async () => {
		await runWithoutTenantContext(async () => {
			const base = root();
			l3Dirs.push(join(base, "l3"));
			const faux = fauxProvider();
			faux.setResponses([fauxAssistantMessage("复习监督学习和梯度下降")]);
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
			const lease = await service.lease(req, session.id);
			try {
				const submission = await lease.runtime.submit("之前学习了机器学习的基本概念", "durable-l3-index");
				await lease.runtime.waitForSubmission(submission.id);
			} finally { await lease.release(); }
			await service.snapshot(req, session.id);
			const memory = new ScopedL3Memory(base, join(base, "sessions"));
			const recalled = await memory.recall("机器学习", "durable-current");
			expect(recalled.some((result) => result.sessionId === session.id)).toBe(true);
			expect(await memory.recall("机器学习", session.id)).toEqual([]);
			const next = service.create(req, { workspaceId: "workspace" });
			const context = await service.prepareRecallContext(req, next.id, "机器学习");
			expect(context).toContain("# 相关历史对话");
			expect(context).toContain("之前学习了机器学习");
			expect(await service.prepareRecallContext(req, session.id, "机器学习")).toBe("");
		});
	});

	it("upgrades automatic topics with the pinned model and preserves manual renames", async () => {
		await runWithoutTenantContext(async () => {
			const base = root();
			const faux = fauxProvider();
			faux.setResponses([
				fauxAssistantMessage("answer 1"),
				fauxAssistantMessage("answer 2"),
				fauxAssistantMessage("answer 3"),
				fauxAssistantMessage("answer 4"),
			]);
			let currentConfig = config("local");
			const completions: Array<{ provider: string; modelId: string; prompt: string }> = [];
			const service = new DurableSessionService({
				dataDir: base,
				getLocalConfig: () => currentConfig,
				enabled: true,
				resolveWorkspaceDir: () => base,
				openRuntime: async (options) => {
					const models = createModels();
					models.setProvider(faux.provider);
					return DurableSessionRuntime.open({ ...options, models, model: { provider: faux.provider.id, modelId: faux.getModel().id } });
				},
				completeTopic: async (_config, selection, prompt) => {
					completions.push({ ...selection, prompt });
					return "标题：Rust 所有权入门";
				},
			});
			services.push(service);
			const req = { headers: {} } as IncomingMessage;
			const session = service.create(req, { workspaceId: "workspace" });
			currentConfig = normalizeConfig({
				...currentConfig,
				defaultProvider: "other-provider",
				defaultModel: "other-model",
				providers: {
					...currentConfig.providers,
					"other-provider": {
						baseUrl: "http://other.invalid/v1",
						apiKey: "other-key",
						models: [{ id: "other-model", name: "Other", reasoning: false, input: ["text"], contextWindow: 8_000, maxTokens: 1_000 }],
					},
				},
			});
			const turn = async (prompt: string, requestId: string) => {
				const lease = await service.lease(req, session.id);
				try {
					const submission = await lease.runtime.submit(prompt, requestId);
					expect((await lease.runtime.waitForSubmission(submission.id)).status).toBe("done");
				} finally { await lease.release(); }
				service.noteSubmission(req, session.id, prompt);
				await service.snapshot(req, session.id);
			};
			await turn("学习 Rust 所有权", "topic-1");
			await turn("理解借用检查器", "topic-2");
			expect(service.list(req)[0]?.topicPendingUpgrade).toBe(false);
			await turn("练习生命周期标注", "topic-3");
			await Promise.all([
				service.maybeAutoGenerateTopic(req, session.id),
				service.maybeAutoGenerateTopic(req, session.id),
			]);
			expect(completions).toHaveLength(1);
			expect(completions[0]).toMatchObject({ provider: "faux-configured", modelId: "faux-model" });
			expect(completions[0]?.prompt).toContain("学习 Rust 所有权");
			expect(completions[0]?.prompt).toContain("练习生命周期标注");
			expect(service.list(req)[0]).toMatchObject({ name: "Rust 所有权入门", topicPendingUpgrade: false });

			service.rename(req, session.id, "我的手动标题");
			await turn("继续练习", "topic-4");
			await service.maybeAutoGenerateTopic(req, session.id);
			expect(completions).toHaveLength(1);
			expect(service.list(req)[0]?.name).toBe("我的手动标题");
		});
	});

	it("does not let an in-flight automatic topic overwrite a manual rename", async () => {
		await runWithoutTenantContext(async () => {
			const base = root();
			const faux = fauxProvider();
			faux.setResponses([fauxAssistantMessage("answer 1"), fauxAssistantMessage("answer 2"), fauxAssistantMessage("answer 3")]);
			let finishTopic!: (value: string) => void;
			let topicStarted = false;
			const completion = new Promise<string>((resolve) => { finishTopic = resolve; });
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
				completeTopic: async () => {
					topicStarted = true;
					return completion;
				},
			});
			services.push(service);
			const req = { headers: {} } as IncomingMessage;
			const session = service.create(req, { workspaceId: "workspace" });
			for (const [index, prompt] of ["first", "second", "third"].entries()) {
				const lease = await service.lease(req, session.id);
				try {
					const submission = await lease.runtime.submit(prompt, `rename-topic-${index}`);
					await lease.runtime.waitForSubmission(submission.id);
				} finally { await lease.release(); }
				service.noteSubmission(req, session.id, prompt);
				await service.snapshot(req, session.id);
			}
			const generation = service.maybeAutoGenerateTopic(req, session.id);
			for (let attempt = 0; attempt < 50 && !topicStarted; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(topicStarted).toBe(true);
			service.rename(req, session.id, "手动保留");
			finishTopic!("不应覆盖");
			await generation;
			expect(service.list(req)[0]).toMatchObject({ name: "手动保留", topicPendingUpgrade: false });
		});
	});

	it("invalidates a runtime when its cross-process storage lock is lost", async () => {
		const base = root();
		const context = tenant("tenant-a");
		saveTenantConfig(base, context.tenantId, config("key-a"));
		let acquisitions = 0;
		let releases = 0;
		let closes = 0;
		const losses: Array<() => void> = [];
		const store = {
			acquireDurableStorageLock: async (): Promise<DurableStorageLock> => {
				acquisitions += 1;
				let listener: (() => void) | undefined;
				const lock: DurableStorageLock = {
					lost: false,
					onLost: (callback) => { listener = callback; },
					release: async () => { releases += 1; },
				};
				losses.push(() => {
					(lock as { lost: boolean }).lost = true;
					listener?.();
				});
				return lock;
			},
		} as unknown as TenantStore;
		const service = new DurableSessionService({
			dataDir: base,
			getLocalConfig: () => config("local"),
			enabled: true,
			resolveWorkspaceDir: () => base,
			tenantStore: store,
			openRuntime: async () => ({
				close: async () => { closes += 1; },
			}) as unknown as DurableSessionRuntime,
		});
		services.push(service);
		const bound = inTenant(context, (req) => ({ req, session: service.create(req, { workspaceId: "workspace" }) }));
		const lease = async () => inTenant(context, () => service.lease(bound.req, bound.session.id));
		const first = await lease();
		expect(acquisitions).toBe(1);
		losses[0]!();
		await first.release();
		expect({ closes, releases }).toEqual({ closes: 1, releases: 1 });
		const second = await lease();
		expect(acquisitions).toBe(2);
		await second.release();
		expect({ closes, releases }).toEqual({ closes: 2, releases: 2 });
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
