import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelRegistry } from "../channels/channel.js";
import type { CheckInStore } from "../checkins/check-in-store.js";
import { getCurrentTenant, runInTenantContext } from "../tenants/current.js";
import type { JobRunClaim, TenantContext, TenantStore } from "../tenants/store.js";
import { cancelDeferredRun, closeDeferredRuns, configureDeferredRuns, deferScheduledRun, listDeferredRuns } from "./deferred-runs.js";
import { executeJob } from "./job-runner.js";
import type { JobStore } from "./job-store.js";
import type { ScheduledJob } from "./types.js";

vi.mock("./job-runner.js", () => ({
	executeJob: vi.fn(),
	pushThroughDefaultChannel: vi.fn(async () => undefined),
}));

const tenantA: TenantContext = { tenantId: "tenant-a", userId: "user-a", role: "owner" };
const tenantB: TenantContext = { tenantId: "tenant-b", userId: "user-b", role: "owner" };
const claims: Array<{ tenantId: string; claim: JobRunClaim }> = [];
const tenantStore = {
	claimJobRun: vi.fn(async (context: TenantContext, _jobId: string, occurrenceId: string) => {
		const claim: JobRunClaim = { occurrenceId, release: vi.fn(async () => {}) };
		claims.push({ tenantId: context.tenantId, claim });
		return claim;
	}),
} as unknown as TenantStore;
const checkInStore = {
	isOccurrenceClaimed: () => false,
	getOccurrence: () => undefined,
	releaseOccurrenceClaim: vi.fn(),
} as unknown as CheckInStore;
const job: ScheduledJob = {
	id: "shared-job", name: "learning", cron: "* * * * *", timezone: "UTC", enabled: true,
	taskType: "daily_review", prompt: "review", runCount: 0, failureCount: 0,
	createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const scheduledAt = "2026-10-26T01:00:00.000Z";
const occurrenceId = `${job.id}:${scheduledAt}`;

beforeEach(() => {
	configureDeferredRuns({
		jobStore: {} as JobStore,
		channelRegistry: new ChannelRegistry(),
		checkInStore,
		createSession: async () => "/tmp/owned-session.jsonl",
		durableClaims: true,
	});
	vi.mocked(executeJob).mockImplementation(async (current) => ({
		jobId: current.id, runId: "run-deferred", success: true, output: "done",
	}));
});

afterEach(async () => {
	await closeDeferredRuns();
	vi.useRealTimers();
	vi.clearAllMocks();
	claims.length = 0;
});

describe("tenant deferred runs", () => {
	it("scopes equal occurrence ids and releases only the cancelled tenant's lease", async () => {
		await runInTenantContext(tenantA, tenantStore, () => deferScheduledRun(job, scheduledAt, occurrenceId));
		await runInTenantContext(tenantB, tenantStore, () => deferScheduledRun(job, scheduledAt, occurrenceId));
		expect(runInTenantContext(tenantA, tenantStore, () => listDeferredRuns())).toHaveLength(1);
		expect(runInTenantContext(tenantB, tenantStore, () => listDeferredRuns())).toHaveLength(1);
		expect(listDeferredRuns()).toEqual([]);

		const cancelled = await runInTenantContext(tenantA, tenantStore, () => cancelDeferredRun(occurrenceId));
		expect(cancelled?.jobId).toBe(job.id);
		expect(vi.mocked(claims[0].claim.release)).toHaveBeenCalledOnce();
		expect(vi.mocked(claims[1].claim.release)).not.toHaveBeenCalled();
		expect(runInTenantContext(tenantA, tenantStore, () => listDeferredRuns())).toEqual([]);
		expect(runInTenantContext(tenantB, tenantStore, () => listDeferredRuns())).toHaveLength(1);
	});

	it("restores the captured tenant when the countdown auto-executes", async () => {
		vi.useFakeTimers();
		const sessions: Array<string | null> = [];
		const executionTenants: Array<string | null> = [];
		configureDeferredRuns({
			jobStore: {} as JobStore,
			channelRegistry: new ChannelRegistry(),
			checkInStore,
			createSession: async () => {
				sessions.push(getCurrentTenant()?.tenantId ?? null);
				return "/tmp/owned-session.jsonl";
			},
			durableClaims: true,
		});
		vi.mocked(executeJob).mockImplementation(async (current) => {
			executionTenants.push(getCurrentTenant()?.tenantId ?? null);
			return { jobId: current.id, runId: "run-deferred", success: true, output: "done" };
		});
		await runInTenantContext(tenantA, tenantStore, () => deferScheduledRun(job, scheduledAt, occurrenceId));
		await vi.advanceTimersByTimeAsync(15_000);
		expect(sessions).toEqual(["tenant-a"]);
		expect(executionTenants).toEqual(["tenant-a"]);
		expect(vi.mocked(executeJob).mock.calls[0][5]).toMatchObject({
			sessionPath: "/tmp/owned-session.jsonl",
			allowSessionChannelInference: false,
		});
		expect(vi.mocked(claims[0].claim.release)).toHaveBeenCalledOnce();
	});
});
