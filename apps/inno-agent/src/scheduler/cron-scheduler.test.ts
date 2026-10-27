import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelRegistry } from "../channels/channel.js";
import { CronScheduler } from "./cron-scheduler.js";
import { executeJob } from "./job-runner.js";
import { JobStore } from "./job-store.js";
import type { ScheduledJob } from "./types.js";

vi.mock("./job-runner.js", () => ({
	executeJob: vi.fn(async (job: ScheduledJob) => ({ jobId: job.id, runId: `run-${job.id}`, success: true, output: "done" })),
	pushThroughDefaultChannel: vi.fn(async () => undefined),
}));

const dirs: string[] = [];
const schedulers: CronScheduler[] = [];

afterEach(() => {
	for (const scheduler of schedulers.splice(0)) scheduler.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.clearAllMocks();
});

describe("CronScheduler runtime targets", () => {
	it("preserves local legacy execution while passing durable targets and executor", async () => {
		const dir = mkdtempSync(join(tmpdir(), "inno-cron-runtime-"));
		dirs.push(dir);
		const store = new JobStore(dir, "UTC");
		const legacy = store.create({
			name: "legacy", cron: "* * * * *", timezone: "UTC", enabled: true,
			taskType: "custom_prompt", prompt: "legacy prompt",
		});
		const durable = store.create({
			name: "durable", cron: "* * * * *", timezone: "UTC", enabled: true,
			taskType: "custom_prompt", prompt: "durable prompt", runtime: "durable",
		});
		const durableExecutor = vi.fn(async () => "durable done");
		const scheduler = new CronScheduler(store, new ChannelRegistry(), undefined, {
			createSession: async (job) => job.runtime === "durable"
				? { id: "durable-scheduled", runtime: "durable" }
				: null,
			durableExecutor,
		});
		schedulers.push(scheduler);
		await scheduler.tick();
		await vi.waitFor(() => expect(vi.mocked(executeJob)).toHaveBeenCalledTimes(2));
		const legacyCall = vi.mocked(executeJob).mock.calls.find((call) => call[0].id === legacy.id);
		const durableCall = vi.mocked(executeJob).mock.calls.find((call) => call[0].id === durable.id);
		expect(legacyCall?.[5]).toMatchObject({ sessionPath: undefined, sessionId: undefined, sessionRuntime: undefined });
		expect(durableCall?.[5]).toMatchObject({
			sessionPath: undefined, sessionId: "durable-scheduled", sessionRuntime: "durable", durableExecutor,
		});
	});
});
