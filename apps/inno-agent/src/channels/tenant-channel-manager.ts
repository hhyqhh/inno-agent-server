import { createHash } from "node:crypto";
import { join } from "node:path";
import type { InnoConfig } from "../config.js";
import { logger } from "../logger.js";
import { ensureDir } from "../storage/file-store.js";
import { loadTenantConfig } from "../tenants/config.js";
import { getCurrentTenant, getCurrentTenantStore, runInTenantContext } from "../tenants/current.js";
import type { TenantContext, TenantStore } from "../tenants/store.js";
import { feishuRegistrationBegin, feishuRegistrationPoll } from "./feishu/feishu-registration.js";
import { ChannelRegistry, type ChatChannel } from "./channel.js";
import { PersonalChannelDispatcher, type PersonalChannelDispatcherOptions } from "./personal-dispatcher.js";
import type { ChannelRunLog } from "./run-log.js";
import type { IncomingMessage } from "./types.js";
import type { WeChatChannel } from "./wechat/wechat-channel.js";

export interface TenantChannelRegistration {
	wechatChannel?: WeChatChannel;
	stop?: () => Promise<void> | void;
}

export interface TenantChannelFactoryOptions {
	config: InnoConfig;
	channelsDataDir: string;
	registry: ChannelRegistry;
	dispatch: (channel: ChatChannel, message: IncomingMessage) => void;
}

interface TenantChannelRuntime {
	context: TenantContext;
	registry: ChannelRegistry;
	dispatcher: PersonalChannelDispatcher;
	wechatChannel: WeChatChannel | null;
	stop?: () => Promise<void> | void;
}

export interface TenantChannelManagerOptions {
	dataDir: string;
	tenantStore: TenantStore;
	dispatcher: Omit<PersonalChannelDispatcherOptions, "channelRegistry" | "channelsDataDir">;
	createChannels: (options: TenantChannelFactoryOptions) => TenantChannelRegistration;
}

export function bridgeChannelResourceId(token: string): string {
	return `bridge:${createHash("sha256").update(token).digest("hex")}`;
}

export function feishuChannelResourceId(appId: string): string {
	return `feishu:${appId}`;
}

export function wechatChannelResourceId(botId: string): string {
	return `wechat:${botId}`;
}

function configuredChannelResourceIds(config: InnoConfig): Set<string> {
	const ids = new Set<string>();
	if (config.feishu?.appId) ids.add(feishuChannelResourceId(config.feishu.appId));
	if (config.bridge?.token) ids.add(bridgeChannelResourceId(config.bridge.token));
	return ids;
}

/**
 * Authenticated channel facade. Every operation resolves the verified ALS
 * tenant at execution time; no legacy/global registry is available as a fallback.
 */
export class TenantChannelManager extends ChannelRegistry {
	private readonly runtimes = new Map<string, TenantChannelRuntime>();
	private readonly feishuDevices = new Map<string, { tenantId: string; expiresAt: number }>();
	private readonly wechatQrs = new Map<string, { tenantId: string; expiresAt: number }>();

	constructor(private readonly options: TenantChannelManagerOptions) {
		super();
	}

	override register(channel: ChatChannel): void {
		this.runtime().registry.register(channel);
	}

	override unregister(name: string): void {
		this.runtime().registry.unregister(name);
	}

	override get(name: string): ChatChannel | undefined {
		return this.runtime().registry.get(name);
	}

	override all(): ChatChannel[] {
		return this.runtime().registry.all();
	}

	override setDefaultTarget(target: Parameters<ChannelRegistry["setDefaultTarget"]>[0]): void {
		this.runtime().registry.setDefaultTarget(target);
	}

	override getDefaultTarget(channelName: string): ReturnType<ChannelRegistry["getDefaultTarget"]> {
		return this.runtime().registry.getDefaultTarget(channelName);
	}

	async handle(channel: ChatChannel, message: IncomingMessage): Promise<void> {
		await this.runtime().dispatcher.handle(channel, message);
	}

	getRunLog(): ChannelRunLog {
		return this.runtime().dispatcher.getRunLog();
	}

	getWechatChannel(): WeChatChannel | null {
		return this.runtime().wechatChannel;
	}

	setWechatChannel(channel: WeChatChannel): void {
		this.runtime().wechatChannel = channel;
	}

	/** QR-created channels need the same ALS rebinding as boot-time native channels. */
	startWechatChannel(channel: WeChatChannel): void {
		const runtime = this.runtime();
		if (runtime.wechatChannel !== channel) throw new Error("WeChat channel is not registered for this tenant");
		channel.onMessage((message) => this.dispatch(runtime, channel, message));
		channel.start();
	}

	/** Claim newly configured external identities before their config becomes active. */
	async syncOwnership(previous: InnoConfig, next: InnoConfig): Promise<void> {
		const tenant = this.tenant();
		const before = configuredChannelResourceIds(previous);
		const after = configuredChannelResourceIds(next);
		const added = [...after].filter((id) => !before.has(id));
		const claimed: string[] = [];
		try {
			for (const id of added) {
				await tenant.store.claimResource(tenant.context, "channel", id);
				claimed.push(id);
			}
		} catch (error) {
			await Promise.all(claimed.map((id) => tenant.store.releaseResource(tenant.context, "channel", id)));
			throw error;
		}
		for (const id of before) {
			if (!after.has(id)) await tenant.store.releaseResource(tenant.context, "channel", id);
		}
	}

	async claimWechatBot(botId: string): Promise<void> {
		const tenant = this.tenant();
		if (!botId) throw new Error("WeChat login did not return a bot id");
		await tenant.store.claimResource(tenant.context, "channel", wechatChannelResourceId(botId));
	}

	trackWechatQr(qrId: string): void {
		const tenant = this.tenant();
		if (!qrId) throw new Error("WeChat QR login did not return a qr id");
		this.wechatQrs.set(qrId, { tenantId: tenant.context.tenantId, expiresAt: Date.now() + 15 * 60_000 });
	}

	assertWechatQr(qrId: string): void {
		const tenant = this.tenant();
		const pending = this.wechatQrs.get(qrId);
		if (!pending || pending.tenantId !== tenant.context.tenantId || pending.expiresAt <= Date.now()) {
			const error = new Error("WeChat QR login not found") as Error & { statusCode: number };
			error.statusCode = 404;
			throw error;
		}
	}

	async confirmWechatLogin(qrId: string, botId: string, confirm: () => void): Promise<void> {
		const tenant = this.tenant();
		this.assertWechatQr(qrId);
		const previousBotId = this.runtime().wechatChannel?.botId || "";
		await this.claimWechatBot(botId);
		try {
			confirm();
		} catch (error) {
			if (previousBotId !== botId) {
				await tenant.store.releaseResource(tenant.context, "channel", wechatChannelResourceId(botId));
			}
			throw error;
		}
		if (previousBotId && previousBotId !== botId) {
			await tenant.store.releaseResource(tenant.context, "channel", wechatChannelResourceId(previousBotId));
		}
		this.wechatQrs.delete(qrId);
	}

	/** Public bridge callbacks recover tenant context from persisted token ownership. */
	async runWithBridgeToken<T>(token: string, operation: () => T): Promise<T | null> {
		if (!token) return null;
		const context = await this.options.tenantStore.findResourceOwner("channel", bridgeChannelResourceId(token));
		if (!context) return null;
		return runInTenantContext(context, this.options.tenantStore, operation);
	}

	async beginFeishuRegistration(): ReturnType<typeof feishuRegistrationBegin> {
		const tenant = this.tenant();
		const now = Date.now();
		for (const [code, pending] of this.feishuDevices) {
			if (pending.expiresAt <= now) this.feishuDevices.delete(code);
		}
		const result = await feishuRegistrationBegin();
		this.feishuDevices.set(result.deviceCode, {
			tenantId: tenant.context.tenantId,
			expiresAt: now + result.expiresIn * 1000,
		});
		return result;
	}

	async pollFeishuRegistration(deviceCode: string): ReturnType<typeof feishuRegistrationPoll> {
		const tenant = this.tenant();
		const pending = this.feishuDevices.get(deviceCode);
		if (!pending || pending.tenantId !== tenant.context.tenantId || pending.expiresAt <= Date.now()) {
			const error = new Error("Feishu registration not found") as Error & { statusCode: number };
			error.statusCode = 404;
			throw error;
		}
		const result = await feishuRegistrationPoll(deviceCode);
		if (result.status === "confirmed" || result.status === "expired") this.feishuDevices.delete(deviceCode);
		return result;
	}

	async reloadCurrent(): Promise<void> {
		const tenant = this.tenant();
		const existing = this.runtimes.get(tenant.context.tenantId);
		this.runtimes.delete(tenant.context.tenantId);
		await existing?.stop?.();
		this.runtime();
	}

	async close(): Promise<void> {
		const runtimes = [...this.runtimes.values()];
		this.runtimes.clear();
		for (const runtime of runtimes) await runtime.stop?.();
	}

	private tenant(): { context: TenantContext; store: TenantStore } {
		const context = getCurrentTenant();
		const store = getCurrentTenantStore();
		if (!context || !store) throw new Error("Authenticated channel access requires a verified tenant context");
		return { context, store };
	}

	private runtime(): TenantChannelRuntime {
		const tenant = this.tenant();
		const existing = this.runtimes.get(tenant.context.tenantId);
		if (existing) return existing;

		const channelsDataDir = join(this.options.dataDir, "tenants", tenant.context.tenantId, "channels");
		ensureDir(channelsDataDir);
		const registry = new ChannelRegistry(join(channelsDataDir, "default-targets.json"));
		const dispatcher = new PersonalChannelDispatcher({
			...this.options.dispatcher,
			onSessionCreated: async (sessionId, channel) => {
				await tenant.store.claimResource(tenant.context, "session", sessionId);
				await this.options.dispatcher.onSessionCreated?.(sessionId, channel);
			},
			authorizeSession: (sessionId) => tenant.store.ownsResource(tenant.context, "session", sessionId),
			allowGlobalSessionFallback: false,
			channelRegistry: registry,
			channelsDataDir,
		});
		const runtime: TenantChannelRuntime = {
			context: tenant.context,
			registry,
			dispatcher,
			wechatChannel: null,
		};
		const dispatch = (channel: ChatChannel, message: IncomingMessage): void => {
			this.dispatch(runtime, channel, message);
		};
		const registration = this.options.createChannels({
			config: loadTenantConfig(this.options.dataDir, tenant.context.tenantId),
			channelsDataDir,
			registry,
			dispatch,
		});
		runtime.wechatChannel = registration.wechatChannel ?? null;
		runtime.stop = async () => {
			dispatcher.dispose();
			await registration.stop?.();
			await runtime.wechatChannel?.stop();
		};
		this.runtimes.set(tenant.context.tenantId, runtime);
		return runtime;
	}

	private dispatch(runtime: TenantChannelRuntime, channel: ChatChannel, message: IncomingMessage): void {
		void runInTenantContext(runtime.context, this.options.tenantStore, () => runtime.dispatcher.handle(channel, message))
			.catch((error) => logger.error({ err: error, tenantId: runtime.context.tenantId }, "tenant channel dispatch failed"));
	}
}
