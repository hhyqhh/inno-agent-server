import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEvents, loadProfile } from "../memory/learner/profile-store.js";
import { createDurableMemoryRegistrations, createDurableMemoryTools, buildDurableInstructions } from "./durable-memory.js";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "inno-durable-memory-"));
	roots.push(value);
	return value;
}

function options(base: string, sessionId: string) {
	return {
		sessionId,
		learnerDataDir: join(base, "learner"),
		l2DataDir: join(base, "l2"),
		workspaceDir: base,
		l1Enabled: true,
		l2Enabled: true,
	};
}

function executeTool(
	tool: ReturnType<typeof createDurableMemoryTools>[number],
	callId: string,
	params: Record<string, unknown>,
) {
	return (tool.execute as (...args: any[]) => Promise<any>)(
		params,
		{ callId },
		{ abortSignal: undefined },
	);
}

async function recordGoal(base: string, sessionId: string) {
	const tools = createDurableMemoryTools(options(base, sessionId));
	const tool = tools.find((item) => item.name === "record_learning_event")!;
	return executeTool(tool, "shared-tool-call", {
		event_type: "goal_declared",
		context: { goal_id: "goal-rust" },
		payload: { goal_description: "学习 Rust", action: "active" },
	});
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("durable memory tools", () => {
	it("scopes idempotency by durable session and stable tool-call ID", async () => {
		const base = root();
		const first = await recordGoal(base, "durable-a");
		const retry = await recordGoal(base, "durable-a");
		const otherSession = await recordGoal(base, "durable-b");
		const learnerDir = join(base, "learner");

		expect(first.details.duplicate).toBe(false);
		expect(retry.details.duplicate).toBe(true);
		expect(otherSession.details.duplicate).toBe(false);
		expect(loadEvents(learnerDir)).toHaveLength(2);
		expect(loadProfile(learnerDir).applied_operation_ids).toEqual([
			"record_learning_event:durable-a:shared-tool-call",
			"record_learning_event:durable-b:shared-tool-call",
		]);
	});

	it("exposes replay-safe event and direct profile mutation tools", () => {
		const base = root();
		const tools = createDurableMemoryRegistrations(options(base, "durable-a"));
		const names = tools.map((tool) => tool.name);
		expect(names).toEqual(expect.arrayContaining([
			"get_learner_context",
			"record_learning_event",
			"record_learning_evidence",
			"assess_learning_prerequisites",
			"review_learner_profile",
			"patch_learner_profile",
			"update_learner_profile",
			"l2_archive",
			"l2_query",
			"l2_lint",
		]));
		expect(tools.every((tool) => tool.replay === "safe")).toBe(true);
	});

	it("applies direct profile patch and update once across stable-call retries", async () => {
		const base = root();
		const tools = createDurableMemoryTools(options(base, "durable-a"));
		const execute = (name: string, params: Record<string, unknown>) => {
			const tool = tools.find((item) => item.name === name)!;
			return executeTool(tool, "shared-profile-call", params);
		};
		const patch = {
			concept_id: "rust.ownership",
			mastery_delta: 0.1,
			profile_summary_append: "需要更多练习",
		};
		const patched = await execute("patch_learner_profile", patch);
		const patchRetry = await execute("patch_learner_profile", patch);
		expect(patched.details.duplicate).toBe(false);
		expect(patchRetry.details.duplicate).toBe(true);
		expect(patchRetry.details.version).toBe(patched.details.version);
		let profile = loadProfile(join(base, "learner"));
		expect(profile.profile_summary).toBe("需要更多练习");
		expect(profile.knowledge_states[0].mastery).toBeCloseTo(0.15);

		const update = { profile_summary: "用户明确修正后的画像" };
		await execute("update_learner_profile", update);
		const updateRetry = await execute("update_learner_profile", update);
		expect(updateRetry.details.duplicate).toBe(true);
		profile = loadProfile(join(base, "learner"));
		expect(profile.profile_summary).toBe("用户明确修正后的画像");
		expect(profile.applied_operation_ids).toEqual([
			"patch_learner_profile:durable-a:shared-profile-call",
			"update_learner_profile:durable-a:shared-profile-call",
		]);
	});

	it("exposes tenant-scoped L3 recall with the durable session excluded", async () => {
		const base = root();
		const calls: Array<{ query: string; exclude?: string }> = [];
		const tools = createDurableMemoryTools({
			...options(base, "durable-current"),
			l3: {
				enabled: true,
				memory: {
					recall: async (query, exclude) => {
						calls.push({ query, exclude });
						return [{ sessionId: "legacy-owned", role: "user" as const, text: "之前的机器学习计划", ts: 1, score: 1 }];
					},
				},
			},
		});
		const tool = tools.find((item) => item.name === "l3_recall")!;
		const result = await executeTool(tool, "l3-call", { query: "机器学习" });
		expect(calls).toEqual([{ query: "机器学习", exclude: "durable-current" }]);
		expect(result.output[0].text).toContain("之前的机器学习计划");
		expect(result.details).toEqual({ results: 1 });
	});

	it("adds tenant-local learner context to durable instructions", async () => {
		const base = root();
		await recordGoal(base, "durable-a");
		const memory = options(base, "durable-a");
		const instructions = buildDurableInstructions("BASE", memory);

		expect(instructions).toContain("BASE");
		expect(instructions).toContain("学习者上下文");
		expect(instructions).toContain("goal_declared");
		expect(buildDurableInstructions("BASE", { ...memory, l1Enabled: false })).toBe("BASE");
	});
});
