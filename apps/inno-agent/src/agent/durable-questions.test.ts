import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableQuestionStore } from "./durable-questions.js";

const roots: string[] = [];

function questionDir(): string {
	const root = mkdtempSync(join(tmpdir(), "inno-durable-questions-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const params = {
	questions: [{
		question: "选择难度？",
		header: "难度",
		options: [{ label: "基础", description: "从基础开始" }, { label: "进阶", description: "加快进度" }],
	}],
};

describe("DurableQuestionStore", () => {
	it("rebinds the same question and returns a persisted answer after reopen", async () => {
		const directory = questionDir();
		const first = new DurableQuestionStore("durable-session", directory);
		const controller = new AbortController();
		const firstEvents: Array<Record<string, unknown>> = [];
		first.bindTurn({ turnId: "turn-one", emit: (event) => firstEvents.push(event) });
		const waiting = first.ask("stable-call", params, controller.signal);
		const questionId = first.pendingQuestion()!.questionId;
		expect(firstEvents[0]).toMatchObject({ type: "question", questionId, toolCallId: "stable-call" });
		controller.abort();
		await expect(waiting).rejects.toThrow();
		expect(first.pendingQuestion()).toMatchObject({ questionId, turnId: "turn-one" });

		const reopened = new DurableQuestionStore("durable-session", directory);
		const recoveredEvents: Array<Record<string, unknown>> = [];
		reopened.bindTurn({ turnId: "turn-two", emit: (event) => recoveredEvents.push(event) });
		expect(recoveredEvents[0]).toMatchObject({ type: "question", questionId, toolCallId: "stable-call" });
		expect(reopened.pendingQuestion()).toMatchObject({ questionId, turnId: "turn-two" });
		const result = {
			answers: [{ questionIndex: 0, question: "选择难度？", kind: "option" as const, answer: "基础" }],
			cancelled: false,
		};
		expect(reopened.respond({ turnId: "turn-one", questionId, result })).toBe("scope_mismatch");
		expect(reopened.respond({ turnId: "turn-two", questionId, result })).toBe("accepted");
		expect(reopened.respond({ turnId: "turn-two", questionId, result })).toBe("already_resolved");
		expect(reopened.pendingQuestion()).toBeUndefined();

		const completed = new DurableQuestionStore("durable-session", directory);
		await expect(completed.ask("stable-call", params, new AbortController().signal)).resolves.toEqual(result);
	});

	it("does not create a pending card for a non-streaming no-UI call", async () => {
		const store = new DurableQuestionStore("durable-session", questionDir());
		store.bindTurn({ turnId: "http-once", noUi: true });
		await expect(store.ask("no-ui-call", params, new AbortController().signal)).resolves.toMatchObject({
			cancelled: true,
			error: "no_ui",
		});
		expect(store.pendingQuestion()).toBeUndefined();
	});
});
