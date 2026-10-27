import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelRegistry } from "../channels/channel.js";
import {
	appendAssistantNotification,
	runPromptInSession,
	runPromptSerialized,
	runPromptStreamingInSession,
} from "../agent/pi-runner.js";
import { executeJob } from "./job-runner.js";
import { JobStore } from "./job-store.js";
import type { ScheduledJob } from "./types.js";

vi.mock("../agent/pi-runner.js", () => ({
	appendAssistantNotification: vi.fn(),
	appendAssistantNotificationInSession: vi.fn(async () => undefined),
	getCurrentSessionChannelHint: vi.fn(() => undefined),
	runPromptInSession: vi.fn(async () => "legacy session output"),
	runPromptStreamingInSession: vi.fn(async () => "legacy stream output"),
	runPromptSerialized: vi.fn(async () => "legacy global output"),
}));

const dirs: string[] = [];
let store: JobStore;
let channels: ChannelRegistry;

function createJob(patch: Partial<ScheduledJob> = {}): ScheduledJob {
	return store.create({
		name: "runtime test", cron: "0 9 * * *", timezone: "UTC", enabled: true,
		taskType: "custom_prompt", prompt: "job prompt", ...patch,
	});
}

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "inno-job-runner-"));
	dirs.push(dir);
	store = new JobStore(dir, "UTC");
	channels = new ChannelRegistry();
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.clearAllMocks();
});

describe("job execution runtime routing", () => {
	it("keeps legacy global and explicit-session defaults unchanged", async () => {
		const globalJob = createJob();
		await expect(executeJob(globalJob, store, channels)).resolves.toMatchObject({
			success: true, output: "legacy global output",
		});
		expect(runPromptSerialized).toHaveBeenCalledWith("job prompt");

		const sessionJob = createJob();
		const onEvent = vi.fn();
		await expect(executeJob(sessionJob, store, channels, "api", undefined, {
			sessionPath: "/tmp/legacy.jsonl", onEvent,
		})).resolves.toMatchObject({ success: true, output: "legacy stream output" });
		expect(runPromptStreamingInSession).toHaveBeenCalledWith("/tmp/legacy.jsonl", "job prompt", onEvent);
		expect(runPromptInSession).not.toHaveBeenCalled();
	});

	it("uses the injected durable executor with scoped request and turn IDs", async () => {
		const job = createJob({ runtime: "durable" });
		const onEvent = vi.fn();
		const durableExecutor = vi.fn(async () => "durable output");
		const result = await executeJob(job, store, channels, "api", undefined, {
			sessionId: "durable-session",
			sessionRuntime: "durable",
			durableExecutor,
			requestId: "job-request",
			turnId: "job-turn",
			onEvent,
		});
		expect(result).toMatchObject({ success: true, output: "durable output" });
		expect(durableExecutor).toHaveBeenCalledWith({
			sessionId: "durable-session", prompt: "job prompt", requestId: "job-request",
			turnId: "job-turn", onEvent,
		});
		expect(runPromptSerialized).not.toHaveBeenCalled();
		expect(runPromptInSession).not.toHaveBeenCalled();
		expect(runPromptStreamingInSession).not.toHaveBeenCalled();
		expect(store.listRuns(job.id)[0]).toMatchObject({ status: "success", outputPreview: "durable output" });
	});

	it("fails closed instead of falling back when durable execution is unwired", async () => {
		const job = createJob({ runtime: "durable" });
		const result = await executeJob(job, store, channels);
		expect(result).toMatchObject({ success: false });
		expect(result.error).toContain("owned durable session and executor");
		expect(runPromptSerialized).not.toHaveBeenCalled();
		expect(store.listRuns(job.id)[0]).toMatchObject({ status: "error" });
	});

	it("never writes a durable reminder through the legacy notification path", async () => {
		const job = createJob({ runtime: "durable", taskType: "push_reminder" });
		const result = await executeJob(job, store, channels, "manual", undefined, {
			sessionId: "durable-session", sessionRuntime: "durable", durableExecutor: vi.fn(),
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain("does not support reminder tasks");
		expect(appendAssistantNotification).not.toHaveBeenCalled();
	});
});
