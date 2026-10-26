import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedulerTools } from "./scheduler-tools.js";
import { ScopedJobStore } from "./scoped-job-store.js";
import { runInTenantContext } from "../tenants/current.js";
import type { TenantContext, TenantStore } from "../tenants/store.js";
import { ChannelRegistry } from "../channels/channel.js";

let dir: string;
let jobs: ScopedJobStore;
let tenantStore: TenantStore;
const tenantA: TenantContext = { tenantId: "a", userId: "a", role: "owner" };
const tenantB: TenantContext = { tenantId: "b", userId: "b", role: "owner" };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "inno-scheduler-tools-"));
	jobs = new ScopedJobStore(dir, join(dir, "legacy"));
	tenantStore = {
		claimResource: vi.fn().mockResolvedValue(undefined),
		releaseResource: vi.fn().mockResolvedValue(undefined),
	} as unknown as TenantStore;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function execute(toolIndex: number, params: Record<string, unknown>, channelRegistry?: ChannelRegistry) {
	const tool = createSchedulerTools(jobs, channelRegistry)[toolIndex];
	return (tool.execute as (...args: any[]) => Promise<any>)("call", params, undefined, undefined, {});
}

describe("tenant-scoped scheduler tools", () => {
	it("claims new jobs, hides them from other tenants, and blocks unscoped execution", async () => {
		const created = await runInTenantContext(tenantA, tenantStore, () => execute(0, {
			name: "private", cron: "0 9 * * *", taskType: "daily_review", prompt: "review",
		}));
		const jobId = created.details.jobId as string;
		expect(tenantStore.claimResource).toHaveBeenCalledWith(tenantA, "job", jobId);

		const listB = await runInTenantContext(tenantB, tenantStore, () => execute(1, {}));
		expect(listB.content[0].text).toContain("当前没有定时任务");
		const updateB = await runInTenantContext(tenantB, tenantStore, () => execute(2, { id: jobId, name: "stolen" }));
		expect(updateB.content[0].text).toContain("未找到任务");
		const deleteB = await runInTenantContext(tenantB, tenantStore, () => execute(3, { id: jobId }));
		expect(deleteB.content[0].text).toContain("未找到任务");
		expect(tenantStore.releaseResource).not.toHaveBeenCalled();

		const runA = await runInTenantContext(tenantA, tenantStore, () => execute(4, { id: jobId }));
		expect(runA.details.error).toBe("scoped_runtime_unavailable");
		const deleteA = await runInTenantContext(tenantA, tenantStore, () => execute(3, { id: jobId }));
		expect(deleteA.content[0].text).toContain("已删除");
		expect(tenantStore.releaseResource).toHaveBeenCalledWith(tenantA, "job", jobId);
	});

	it("claims channel-backed jobs with the current tenant's default target", async () => {
		const channels = new ChannelRegistry();
		channels.register({
			name: "feishu", verify: async () => true, parse: async () => null,
			reply: async () => {}, push: async () => {},
		});
		channels.setDefaultTarget({ channel: "feishu", chatId: "tenant-chat" });
		const result = await runInTenantContext(tenantA, tenantStore, () => execute(0, {
			name: "push", cron: "0 9 * * *", taskType: "push_reminder", prompt: "secret", channel: "feishu",
		}, channels));
		const job = runInTenantContext(tenantA, tenantStore, () => jobs.list().at(0));
		expect(result.details.error).toBeUndefined();
		expect(job?.target).toEqual({ channel: "feishu", chatId: "tenant-chat" });
		expect(tenantStore.claimResource).toHaveBeenCalledWith(tenantA, "job", job?.id);
	});
});
