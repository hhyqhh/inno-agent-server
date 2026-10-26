import type { ChannelRegistry } from "../channels/channel.js";
import type { CheckInStore } from "../checkins/check-in-store.js";
import { logger } from "../logger.js";
import { getCurrentTenant, getCurrentTenantStore, runInTenantContext } from "../tenants/current.js";
import type { JobRunClaim, TenantContext, TenantStore } from "../tenants/store.js";
import { executeJob, pushThroughDefaultChannel } from "./job-runner.js";
import { claimTenantJobRun } from "./execution-claims.js";
import type { JobStore } from "./job-store.js";
import type { ScheduledJob } from "./types.js";

/** Grace period between the scheduled fire time and auto-execution. */
const AUTO_EXECUTE_DELAY_MS = 15_000;

export interface DeferredRun {
	jobId: string;
	jobName: string;
	occurrenceId: string;
	scheduledAt: string;
	/** ISO instant after which the run auto-executes in a new conversation. */
	deadline: string;
}

export interface DeferredRunWiring {
	jobStore: JobStore;
	channelRegistry: ChannelRegistry;
	checkInStore?: CheckInStore;
	/** Create the conversation the auto-executed run will live in. */
	createSession: () => Promise<string | null>;
	/** Enable PostgreSQL leases in authenticated mode. */
	durableClaims?: boolean;
}

interface PendingDeferredRun extends DeferredRun {
	timer: NodeJS.Timeout;
	job: ScheduledJob;
	scopeKey: string;
	context?: TenantContext;
	store?: TenantStore;
	claim?: JobRunClaim;
}

const wiring: { current: DeferredRunWiring | null } = { current: null };
const pending = new Map<string, PendingDeferredRun>();
const executing = new Set<string>();

export function configureDeferredRuns(next: DeferredRunWiring): void {
	wiring.current = next;
}

/** Cancel visible countdowns and release their leases during graceful shutdown. */
export async function closeDeferredRuns(): Promise<void> {
	const runs = [...pending.values()];
	pending.clear();
	for (const run of runs) clearTimeout(run.timer);
	const releases = await Promise.allSettled(runs.map((run) => run.claim?.release()));
	for (const result of releases) {
		if (result.status === "rejected") logger.error({ err: result.reason }, "deferred claim release failed during shutdown");
	}
	wiring.current = null;
}

function currentScopeKey(): string {
	return getCurrentTenant()?.tenantId ?? "local";
}

function currentScope(): { key: string; context?: TenantContext; store?: TenantStore } {
	const tenant = getCurrentTenant();
	return tenant
		? { key: tenant.tenantId, context: tenant, store: getCurrentTenantStore() ?? undefined }
		: { key: "local" };
}

function scopedOccurrenceKey(occurrenceId: string): string {
	return `${currentScopeKey()}:${occurrenceId}`;
}

function runWithCapturedContext<T>(run: PendingDeferredRun, operation: () => T): T {
	if (run.context && run.store) return runInTenantContext(run.context, run.store, operation);
	return operation();
}

export function listDeferredRuns(): DeferredRun[] {
	const scopeKey = currentScopeKey();
	return [...pending.values()]
		.filter((run) => run.scopeKey === scopeKey)
		.map(({ timer: _timer, job: _job, scopeKey: _scope, context: _context, store: _store, claim: _claim, ...run }) => run);
}

export function isDeferredExecuting(occurrenceId: string): boolean {
	return executing.has(scopedOccurrenceKey(occurrenceId));
}

export async function cancelDeferredRun(occurrenceId: string): Promise<DeferredRun | undefined> {
	const key = scopedOccurrenceKey(occurrenceId);
	const run = pending.get(key);
	if (!run) return undefined;
	pending.delete(key);
	clearTimeout(run.timer);
	await run.claim?.release();
	logger.info({ jobId: run.jobId, occurrenceId }, "Deferred scheduled run cancelled");
	const { timer: _timer, job: _job, scopeKey: _scope, context: _context, store: _store, claim: _claim, ...result } = run;
	return result;
}

/** Arm the visible grace period and, in tenant mode, its durable occurrence lease. */
export async function deferScheduledRun(job: ScheduledJob, scheduledAt: string, occurrenceId: string): Promise<void> {
	const cfg = wiring.current;
	if (!cfg) return;
	if (cfg.checkInStore?.isOccurrenceClaimed(occurrenceId)) return;
	const scope = currentScope();
	const key = `${scope.key}:${occurrenceId}`;
	if (pending.has(key) || executing.has(key)) return;
	const claim = (cfg.durableClaims ? await claimTenantJobRun(job, occurrenceId, scheduledAt) : undefined) ?? undefined;
	if (cfg.durableClaims && !claim) return;
	if (pending.has(key) || executing.has(key)) {
		await claim?.release();
		return;
	}
	let run: PendingDeferredRun;
	const timer = setTimeout(() => {
		pending.delete(key);
		void runWithCapturedContext(run, () => autoExecute(run)).catch((error) => {
			logger.error({ err: error, jobId: job.id, occurrenceId }, "deferred execution cleanup failed");
		});
	}, AUTO_EXECUTE_DELAY_MS);
	timer.unref();
	run = {
		jobId: job.id,
		jobName: job.name,
		occurrenceId,
		scheduledAt,
		deadline: new Date(Date.now() + AUTO_EXECUTE_DELAY_MS).toISOString(),
		timer,
		job,
		scopeKey: scope.key,
		context: scope.context,
		store: scope.store,
		claim,
	};
	pending.set(key, run);
	void pushThroughDefaultChannel(
		cfg.channelRegistry,
		`🔔 定时任务「${job.name}」已就绪，${AUTO_EXECUTE_DELAY_MS / 1000} 秒后自动开始（打开应用可立即执行或跳过）`,
		{ jobId: job.id, runId: occurrenceId },
	);
	logger.info({ jobId: job.id, occurrenceId, deadline: run.deadline }, "Deferred scheduled run armed");
}

async function autoExecute(run: PendingDeferredRun): Promise<void> {
	const cfg = wiring.current;
	if (!cfg) {
		await run.claim?.release();
		return;
	}
	const { job, scheduledAt, occurrenceId, scopeKey } = run;
	const key = `${scopeKey}:${occurrenceId}`;
	try {
		if (cfg.checkInStore) {
			const occurrence = cfg.checkInStore.getOccurrence(job.id, occurrenceId);
			if (occurrence && (occurrence.status === "success" || occurrence.status === "skipped")) {
				logger.info({ jobId: job.id, occurrenceId, status: occurrence.status }, "Deferred run obsolete: slot already settled");
				return;
			}
		}
		executing.add(key);
		const sessionPath = await cfg.createSession();
		if (!sessionPath) throw new Error("Deferred run could not create an owned session");
		const result = await executeJob(job, cfg.jobStore, cfg.channelRegistry, "scheduled", cfg.checkInStore, {
			sessionPath,
			scheduledAt,
			occurrenceId,
			allowSessionChannelInference: !cfg.durableClaims,
		});
		logger.info({ jobId: job.id, occurrenceId, runId: result.runId, success: result.success }, "Deferred scheduled run auto-executed");
		if (!result.success) cfg.checkInStore?.releaseOccurrenceClaim(occurrenceId);
	} catch (err) {
		logger.error({ err, jobId: job.id, occurrenceId }, "Deferred scheduled run failed");
		cfg.checkInStore?.releaseOccurrenceClaim(occurrenceId);
	} finally {
		executing.delete(key);
		await run.claim?.release();
	}
}
