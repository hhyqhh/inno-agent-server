import type { ChannelRegistry } from "../channels/channel.js";
import type { CheckInStore } from "../checkins/check-in-store.js";
import { logger } from "../logger.js";
import { runInTenantContext } from "../tenants/current.js";
import type { TenantContext, TenantStore } from "../tenants/store.js";
import { CronScheduler, type CronSchedulerOptions } from "./cron-scheduler.js";
import type { JobStore } from "./job-store.js";

/** One timer enumerates owned jobs; each tenant gets an isolated cron executor. */
export class TenantCronScheduler {
	private readonly schedulers = new Map<string, CronScheduler>();
	private interval: NodeJS.Timeout | null = null;
	private initialTimer: NodeJS.Timeout | null = null;
	private ticking = false;

	constructor(
		private readonly tenantStore: TenantStore,
		private readonly jobStore: JobStore,
		private readonly channelRegistry: ChannelRegistry,
		private readonly checkInStore: CheckInStore,
		private readonly options: Pick<CronSchedulerOptions, "createSession">,
	) {}

	start(): void {
		this.initialTimer = setTimeout(() => { void this.tick(); }, 2_000);
		this.initialTimer.unref();
		this.interval = setInterval(() => { void this.tick(); }, 5_000);
		this.interval.unref();
		logger.info("[scheduler] tenant-aware scheduler started, checking owned jobs every 5s");
	}

	stop(): void {
		if (this.initialTimer) clearTimeout(this.initialTimer);
		this.initialTimer = null;
		if (this.interval) clearInterval(this.interval);
		this.interval = null;
		for (const scheduler of this.schedulers.values()) scheduler.stop();
		this.schedulers.clear();
	}

	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const owners = await this.tenantStore.listResourceOwners("job");
			const active = new Set(owners.map((owner) => owner.tenantId));
			for (const [tenantId, scheduler] of this.schedulers) {
				if (!active.has(tenantId)) {
					scheduler.stop();
					this.schedulers.delete(tenantId);
				}
			}
			await Promise.all(owners.map((context) => this.tickTenant(context)));
		} finally {
			this.ticking = false;
		}
	}

	private async tickTenant(context: TenantContext): Promise<void> {
		try {
			await runInTenantContext(context, this.tenantStore, async () => {
				let scheduler = this.schedulers.get(context.tenantId);
				if (!scheduler) {
					scheduler = new CronScheduler(this.jobStore, this.channelRegistry, this.checkInStore, {
						durableClaims: true,
						createSession: this.options.createSession,
					});
					this.schedulers.set(context.tenantId, scheduler);
				}
				await scheduler.tick();
			});
		} catch (error) {
			logger.error({ err: error, tenantId: context.tenantId }, "tenant scheduler tick failed");
		}
	}
}
