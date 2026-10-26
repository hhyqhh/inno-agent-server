import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelRegistry } from "../channels/channel.js";
import { CheckInStore } from "../checkins/check-in-store.js";
import { getCurrentTenant, runInTenantContext } from "../tenants/current.js";
import type { JobRunClaim, TenantContext, TenantStore } from "../tenants/store.js";
import { executeJob } from "./job-runner.js";
import { ScopedJobStore } from "./scoped-job-store.js";
import { TenantCronScheduler } from "./tenant-cron-scheduler.js";

vi.mock("./job-runner.js", () => ({
	executeJob: vi.fn(),
	pushThroughDefaultChannel: vi.fn(async () => undefined),
}));

const tenantA: TenantContext = { tenantId: "tenant-a", userId: "user-a", role: "owner" };
const tenantB: TenantContext = { tenantId: "tenant-b", userId: "user-b", role: "owner" };
const tempDirs: string[] = [];
const schedulers: TenantCronScheduler[] = [];

beforeEach(() => {
	vi.mocked(executeJob).mockImplementation(async (job) => ({
		jobId: job.id, runId: `run-${job.id}`, success: true, output: "done",
	}));
});

afterEach(() => {
	for (const scheduler of schedulers.splice(0)) scheduler.stop();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.clearAllMocks();
});

describe("TenantCronScheduler", () => {
	it("restores each job owner's ALS and creates an explicit session", async () => {
		const dir = mkdtempSync(join(tmpdir(), "inno-tenant-scheduler-"));
		tempDirs.push(dir);
		const jobs = new ScopedJobStore(dir, join(dir, "legacy"), "UTC");
		const claims: Array<{ tenantId: string; jobId: string; claim: JobRunClaim }> = [];
		const tenantStore = {
			listResourceOwners: vi.fn(async () => [tenantA, tenantB]),
			claimJobRun: vi.fn(async (context: TenantContext, jobId: string, occurrenceId: string) => {
				const claim: JobRunClaim = { occurrenceId, release: vi.fn(async () => {}) };
				claims.push({ tenantId: context.tenantId, jobId, claim });
				return claim;
			}),
		} as unknown as TenantStore;
		const run = <T>(context: TenantContext, operation: () => T): T => runInTenantContext(context, tenantStore, operation);
		const jobA = run(tenantA, () => jobs.create({
			name: "A reminder", cron: "* * * * *", timezone: "UTC", enabled: true,
			taskType: "push_reminder", prompt: "private-a",
		}));
		const jobB = run(tenantB, () => jobs.create({
			name: "B reminder", cron: "* * * * *", timezone: "UTC", enabled: true,
			taskType: "push_reminder", prompt: "private-b",
		}));
		jobs.create({
			name: "legacy", cron: "* * * * *", timezone: "UTC", enabled: true,
			taskType: "push_reminder", prompt: "must-not-run",
		});
		const sessions: Array<{ tenantId: string | null; path: string }> = [];
		const scheduler = new TenantCronScheduler(tenantStore, jobs, new ChannelRegistry(), new CheckInStore(join(dir, "checkins"), "UTC", jobs), {
			createSession: async () => {
				const tenantId = getCurrentTenant()?.tenantId ?? null;
				const path = join(dir, `${tenantId}.jsonl`);
				sessions.push({ tenantId, path });
				return path;
			},
		});
		schedulers.push(scheduler);

		await scheduler.tick();
		await vi.waitFor(() => expect(vi.mocked(executeJob)).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(claims.every((entry) => vi.mocked(entry.claim.release).mock.calls.length === 1)).toBe(true));

		expect(claims.map((entry) => [entry.tenantId, entry.jobId]).sort()).toEqual([
			["tenant-a", jobA.id], ["tenant-b", jobB.id],
		].sort());
		expect(sessions.map((entry) => entry.tenantId).sort()).toEqual(["tenant-a", "tenant-b"]);
		for (const call of vi.mocked(executeJob).mock.calls) {
			const options = call[5];
			expect(options?.sessionPath).toMatch(/tenant-[ab]\.jsonl$/);
			expect(options?.allowSessionChannelInference).toBe(false);
			expect(options?.occurrenceId).toContain(`${call[0].id}:`);
		}
		expect(vi.mocked(executeJob).mock.calls.some((call) => call[0].prompt === "must-not-run")).toBe(false);
	});
});
