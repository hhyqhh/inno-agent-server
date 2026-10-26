import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyTenantConfig, saveTenantConfig } from "../tenants/config.js";
import { getCurrentTenant, runInTenantContext } from "../tenants/current.js";
import { ResourceOwnershipError, type TenantContext, type TenantStore } from "../tenants/store.js";
import type { ChatChannel } from "./channel.js";
import type { PersonalChannelDispatcherOptions } from "./personal-dispatcher.js";
import { bridgeChannelResourceId, TenantChannelManager } from "./tenant-channel-manager.js";
import type { IncomingMessage } from "./types.js";
import type { WeChatChannel } from "./wechat/wechat-channel.js";

const tempDirs: string[] = [];
const managers: TenantChannelManager[] = [];
const replies: Array<{ tenantId: string | null; text: string }> = [];
const prompts: Array<{ tenantId: string | null; prompt: string }> = [];
const stoppedChannels: string[] = [];

function context(tenantId: string): TenantContext {
	return { tenantId, userId: `user-${tenantId}`, role: "owner" };
}

function fakeTenantStore() {
	const owners = new Map<string, TenantContext>();
	const store = {
		claimResource: async (owner: TenantContext, _kind: string, id: string) => {
			const existing = owners.get(id);
			if (existing && existing.tenantId !== owner.tenantId) throw new ResourceOwnershipError("channel", id);
			owners.set(id, owner);
		},
		releaseResource: async (owner: TenantContext, _kind: string, id: string) => {
			if (owners.get(id)?.tenantId === owner.tenantId) owners.delete(id);
		},
		ownsResource: async (owner: TenantContext, _kind: string, id: string) => owners.get(id)?.tenantId === owner.tenantId,
		findResourceOwner: async (_kind: string, id: string) => owners.get(id) ?? null,
	};
	return { store: store as TenantStore, owners };
}

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-tenant-channels-"));
	tempDirs.push(dir);
	return dir;
}

function configure(dataDir: string, tenantId: string, token: string, appId: string): void {
	const config = createEmptyTenantConfig();
	config.bridge = { token };
	config.feishu = { appId, appSecret: `${tenantId}-secret` };
	config.channels = { feishu: { enabled: true, personalOnly: true } };
	saveTenantConfig(dataDir, tenantId, config);
}

function message(id: string, text: string): IncomingMessage {
	return { channel: "feishu", messageId: id, chatId: "external-chat", text, raw: {} };
}

function setup() {
	const dataDir = tempDir();
	const sessionDir = join(dataDir, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const { store, owners } = fakeTenantStore();
	const channel: ChatChannel = {
		name: "feishu",
		verify: async () => true,
		parse: async () => null,
		reply: async (_message, text) => { replies.push({ tenantId: getCurrentTenant()?.tenantId ?? null, text }); },
		push: async () => {},
	};
	let sessionSequence = 0;
	const dispatcher: TenantChannelManagerOptionsForTest = {
		runPrompt: async () => { throw new Error("global prompt fallback must not run"); },
		runPromptInSession: async (_path, prompt) => {
			const tenantId = getCurrentTenant()?.tenantId ?? null;
			prompts.push({ tenantId, prompt });
			return `response-${tenantId}`;
		},
		createNewSession: async () => {
			const id = `${getCurrentTenant()?.tenantId ?? "missing"}-${++sessionSequence}.jsonl`;
			writeFileSync(join(sessionDir, id), "");
			return id;
		},
		getCurrentSessionId: () => "wrong-global-session",
		recordSessionChannel: () => {},
		sessionDir,
	};
	const manager = new TenantChannelManager({
		dataDir,
		tenantStore: store,
		dispatcher,
		createChannels: ({ config, registry }) => {
			if (config.channels?.feishu?.enabled) registry.register(channel);
			return { stop: () => { stoppedChannels.push(config.feishu?.appId ?? ""); } };
		},
	});
	managers.push(manager);
	const run = <T>(tenantId: string, operation: () => T): T => runInTenantContext(context(tenantId), store, operation);
	return { dataDir, manager, store, owners, run, channel };
}

type TenantChannelManagerOptionsForTest = Omit<PersonalChannelDispatcherOptions, "channelRegistry" | "channelsDataDir">;

afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(managers.splice(0).map((manager) => manager.close()));
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	replies.length = 0;
	prompts.length = 0;
	stoppedChannels.length = 0;
});

describe("TenantChannelManager", () => {
	it("keeps registries, targets, sessions and run logs in their owning tenant", async () => {
		const { dataDir, manager, run } = setup();
		configure(dataDir, "tenant-a", "token-a", "app-a");
		configure(dataDir, "tenant-b", "token-b", "app-b");
		expect(() => manager.all()).toThrow("verified tenant");

		await run("tenant-a", () => manager.handle(manager.get("feishu")!, message("a-1", "hello-a")));
		await run("tenant-b", () => manager.handle(manager.get("feishu")!, message("b-1", "hello-b")));
		await run("tenant-a", () => manager.handle(manager.get("feishu")!, message("a-1", "duplicate")));

		expect(prompts.map((entry) => entry.tenantId)).toEqual(["tenant-a", "tenant-b"]);
		expect(replies.map((entry) => entry.tenantId)).toEqual(["tenant-a", "tenant-b"]);
		expect(run("tenant-a", () => manager.getDefaultTarget("feishu")?.chatId)).toBe("external-chat");
		expect(run("tenant-a", () => manager.getRunLog().list())).toHaveLength(1);
		expect(run("tenant-b", () => manager.getRunLog().list())).toHaveLength(1);
		expect(readFileSync(join(dataDir, "tenants", "tenant-a", "channels", "chat-sessions.json"), "utf-8")).toContain("tenant-a-1.jsonl");
		expect(readFileSync(join(dataDir, "tenants", "tenant-b", "channels", "chat-sessions.json"), "utf-8")).toContain("tenant-b-2.jsonl");
	});

	it("claims external identities and recovers bridge context only from ownership", async () => {
		const { dataDir, manager, store, owners, run } = setup();
		configure(dataDir, "tenant-a", "shared-token", "shared-app");
		configure(dataDir, "tenant-b", "shared-token", "shared-app");
		const previous = createEmptyTenantConfig();
		const next = createEmptyTenantConfig();
		next.bridge = { token: "shared-token" };
		next.feishu = { appId: "shared-app", appSecret: "secret" };
		await run("tenant-a", () => manager.syncOwnership(previous, next));
		await expect(run("tenant-b", () => manager.syncOwnership(previous, next))).rejects.toBeInstanceOf(ResourceOwnershipError);
		expect(owners.get(bridgeChannelResourceId("shared-token"))?.tenantId).toBe("tenant-a");
		expect(owners.has("feishu:shared-app")).toBe(true);

		const resolved = await manager.runWithBridgeToken("shared-token", () => manager.get("feishu")?.name);
		expect(resolved).toBe("feishu");
		await manager.runWithBridgeToken("shared-token", () => manager.handle(manager.get("feishu")!, message("bridge-1", "bridge-message")));
		expect(prompts.at(-1)?.tenantId).toBe("tenant-a");
		expect(replies.at(-1)?.tenantId).toBe("tenant-a");
		expect(await manager.runWithBridgeToken("missing", () => "not-found")).toBeNull();
		await run("tenant-a", () => manager.syncOwnership(next, previous));
		expect(await store.findResourceOwner("channel", bridgeChannelResourceId("shared-token"))).toBeNull();
		await run("tenant-b", () => manager.syncOwnership(previous, next));
		expect(owners.get("feishu:shared-app")?.tenantId).toBe("tenant-b");
	});

	it("never falls back to a global prompt without an owned channel session", async () => {
		const { dataDir, manager, run } = setup();
		configure(dataDir, "tenant-a", "token-a", "app-a");
		await run("tenant-a", () => manager.handle(manager.get("feishu")!, {
			...message("no-chat", "must-not-run"), chatId: undefined,
		}));
		expect(prompts).toEqual([]);
		expect(run("tenant-a", () => manager.getRunLog().list())).toMatchObject([{ status: "error" }]);
		expect(replies.at(-1)?.text).toContain("处理失败");
	});

	it("rebinds QR-created WeChat callbacks and stops them on reload", async () => {
		const { dataDir, manager, run } = setup();
		configure(dataDir, "tenant-a", "token-a", "app-a");
		let receive: ((message: IncomingMessage) => void) | undefined;
		const start = vi.fn();
		const stop = vi.fn(async () => {});
		const native = {
			name: "wechat",
			verify: async () => true,
			parse: async () => null,
			reply: async (_message: IncomingMessage, text: string) => {
				replies.push({ tenantId: getCurrentTenant()?.tenantId ?? null, text });
			},
			push: async () => {},
			onMessage: (callback: (message: IncomingMessage) => void) => { receive = callback; },
			start,
			stop,
		} as unknown as WeChatChannel;
		run("tenant-a", () => {
			manager.register(native);
			manager.setWechatChannel(native);
			manager.startWechatChannel(native);
		});
		expect(start).toHaveBeenCalledOnce();
		receive!({ ...message("wechat-after-qr", "hello"), channel: "wechat" });
		await vi.waitFor(() => expect(replies).toHaveLength(1));
		expect(prompts).toEqual([{ tenantId: "tenant-a", prompt: expect.stringContaining("hello") }]);
		expect(replies[0]?.tenantId).toBe("tenant-a");
		await run("tenant-a", () => manager.reloadCurrent());
		expect(stop).toHaveBeenCalledOnce();
	});

	it("reloads only the current tenant runtime", async () => {
		const { dataDir, manager, run } = setup();
		configure(dataDir, "tenant-a", "token-a", "app-a");
		configure(dataDir, "tenant-b", "token-b", "app-b");
		run("tenant-a", () => manager.all());
		const channelB = run("tenant-b", () => manager.get("feishu"));
		await run("tenant-a", () => manager.reloadCurrent());
		expect(stoppedChannels).toEqual(["app-a"]);
		expect(run("tenant-b", () => manager.get("feishu"))).toBe(channelB);
	});

	it("prevents another tenant from polling a Feishu device flow", async () => {
		const { manager, run } = setup();
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			const action = new URLSearchParams(String(init?.body)).get("action");
			return new Response(JSON.stringify(action === "begin" ? {
				device_code: "device-a", verification_uri: "https://example.invalid/qr", expires_in: 600,
			} : { error: "authorization_pending" }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const begun = await run("tenant-a", () => manager.beginFeishuRegistration());
		expect(begun.deviceCode).toBe("device-a");
		await expect(run("tenant-b", () => manager.pollFeishuRegistration("device-a"))).rejects.toMatchObject({ statusCode: 404 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await run("tenant-a", () => manager.pollFeishuRegistration("device-a"))).toMatchObject({ status: "pending" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("binds WeChat QR confirmation and bot ownership to the initiating tenant", async () => {
		const { manager, owners, run } = setup();
		run("tenant-a", () => manager.trackWechatQr("qr-a"));
		expect(() => run("tenant-b", () => manager.assertWechatQr("qr-a"))).toThrow("not found");
		let confirmed = false;
		await run("tenant-a", () => manager.confirmWechatLogin("qr-a", "bot-a", () => { confirmed = true; }));
		expect(confirmed).toBe(true);
		expect(owners.get("wechat:bot-a")?.tenantId).toBe("tenant-a");
		expect(() => run("tenant-a", () => manager.assertWechatQr("qr-a"))).toThrow("not found");
		await expect(run("tenant-b", () => manager.claimWechatBot("bot-a"))).rejects.toBeInstanceOf(ResourceOwnershipError);
	});
});
