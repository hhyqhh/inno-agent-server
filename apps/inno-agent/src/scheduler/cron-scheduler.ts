import type { JobStore } from "./job-store.js";
import type { ChannelRegistry } from "../channels/channel.js";
import { executeJob, type CreatedJobSession, type DurableJobExecutor } from "./job-runner.js";
import { getCronDueAt } from "./cron-utils.js";
import { deferScheduledRun } from "./deferred-runs.js";
import { claimTenantJobRun } from "./execution-claims.js";
import { isLearningJob, occurrenceIdFor, type CheckInStore } from "../checkins/check-in-store.js";
import { logger } from "../logger.js";
import type { ScheduledJob } from "./types.js";

export interface CronSchedulerOptions {
	/** Authenticated runs use PostgreSQL occurrence leases and explicit sessions. */
	durableClaims?: boolean;
	createSession?: (job: ScheduledJob) => Promise<CreatedJobSession | null>;
	durableExecutor?: DurableJobExecutor;
}

/** In-process cron loop; tenant enumeration and durable leases are injectable. */
export class CronScheduler {
	private interval: ReturnType<typeof setInterval> | null = null;
	private initialTimer: ReturnType<typeof setTimeout> | null = null;
	private running = new Set<string>();
	private ticking = false;

	constructor(
		private jobStore: JobStore,
		private channelRegistry: ChannelRegistry,
		private checkInStore?: CheckInStore,
		private options: CronSchedulerOptions = {},
	) {}

	start(): void {
		this.initialTimer = setTimeout(() => { void this.tick(); }, 2_000);
		this.initialTimer.unref();
		this.interval = setInterval(() => { void this.tick(); }, 5_000);
		this.interval.unref();
		logger.info("[scheduler] started, checking jobs every 5s");
	}

	stop(): void {
		if (this.initialTimer) clearTimeout(this.initialTimer);
		this.initialTimer = null;
		if (this.interval) clearInterval(this.interval);
		this.interval = null;
	}

	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const jobs = this.jobStore.list();
			const now = new Date();
			for (const job of jobs) {
				if (!job.enabled || this.running.has(job.id)) continue;
				const scheduledAt = getCronDueAt(job.cron, job.timezone, job.lastRunAt, now);
				if (!scheduledAt) continue;
				const occurrenceId = occurrenceIdFor(job.id, scheduledAt);
				try {
					if (this.checkInStore && isLearningJob(job)) {
						const slot = this.checkInStore.getOccurrence(job.id, occurrenceId, now);
						if (slot && (slot.status === "success" || slot.status === "skipped")) {
							this.runJob(job, scheduledAt, occurrenceId, false);
							continue;
						}
						logger.info({ jobId: job.id, jobName: job.name }, "scheduler deferring learning job for user start");
						await deferScheduledRun(job, scheduledAt, occurrenceId);
						continue;
					}
					this.runJob(job, scheduledAt, occurrenceId, true);
				} catch (error) {
					logger.error({ err: error, jobId: job.id, occurrenceId }, "scheduler could not prepare job");
				}
			}
		} finally {
			this.ticking = false;
		}
	}

	private runJob(job: ScheduledJob, scheduledAt: string, occurrenceId: string, createSession: boolean): void {
		this.running.add(job.id);
		void (async () => {
			if (this.options.durableClaims && createSession && !this.options.createSession) {
				throw new Error("Tenant scheduled execution requires an owned-session factory");
			}
			const claim = this.options.durableClaims
				? await claimTenantJobRun(job, occurrenceId, scheduledAt)
				: undefined;
			if (this.options.durableClaims && !claim) return;
			try {
				logger.info({ jobId: job.id, jobName: job.name }, "scheduler executing job");
				const createdSession = createSession && this.options.createSession
					? await this.options.createSession(job)
					: undefined;
				const sessionPath = typeof createdSession === "string" ? createdSession : createdSession?.path;
				const sessionId = createdSession && typeof createdSession === "object" ? createdSession.id : undefined;
				const sessionRuntime = createdSession && typeof createdSession === "object" ? createdSession.runtime : undefined;
				if (createSession && this.options.createSession && !createdSession
					&& (this.options.durableClaims || job.runtime === "durable")) {
					throw new Error("Scheduled run could not create an owned session");
				}
				if (job.runtime === "durable" && createSession && sessionRuntime !== "durable") {
					throw new Error("Durable scheduled job did not create a durable session");
				}
				const result = await executeJob(job, this.jobStore, this.channelRegistry, "scheduled", this.checkInStore, {
					sessionPath,
					sessionId,
					sessionRuntime,
					durableExecutor: this.options.durableExecutor,
					scheduledAt,
					occurrenceId: this.checkInStore || this.options.durableClaims ? occurrenceId : undefined,
					allowSessionChannelInference: !this.options.durableClaims,
				});
				if (result.success) logger.info({ jobId: job.id, pushedToChannel: result.pushedToChannel }, "scheduler job completed");
				else logger.error({ jobId: job.id, error: result.error }, "scheduler job failed");
			} finally {
				await claim?.release();
			}
		})().catch((err) => {
			logger.error({ err, jobId: job.id }, "scheduler job error");
		}).finally(() => {
			this.running.delete(job.id);
		});
	}
}
