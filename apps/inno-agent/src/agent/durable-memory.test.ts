import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEvents, loadProfile } from "../memory/learner/profile-store.js";
import { createDurableMemoryTools, buildDurableInstructions } from "./durable-memory.js";

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

async function recordGoal(base: string, sessionId: string) {
	const tools = createDurableMemoryTools(options(base, sessionId));
	const tool = tools.find((item) => item.name === "record_learning_event")!;
	return (tool.execute as (...args: any[]) => Promise<any>)("shared-tool-call", {
		event_type: "goal_declared",
		context: { goal_id: "goal-rust" },
		payload: { goal_description: "学习 Rust", action: "active" },
	}, undefined, undefined, {});
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

	it("exposes recovery-safe memory tools without direct profile mutations", () => {
		const base = root();
		const names = createDurableMemoryTools(options(base, "durable-a")).map((tool) => tool.name);
		expect(names).toEqual(expect.arrayContaining([
			"get_learner_context",
			"record_learning_event",
			"record_learning_evidence",
			"assess_learning_prerequisites",
			"review_learner_profile",
			"l2_archive",
			"l2_query",
			"l2_lint",
		]));
		expect(names).not.toContain("patch_learner_profile");
		expect(names).not.toContain("update_learner_profile");
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
