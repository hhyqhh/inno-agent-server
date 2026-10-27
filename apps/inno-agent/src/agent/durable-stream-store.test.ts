import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { DurableStreamStore } from "./durable-stream-store.js";
import { StreamRegistry, snapshotStreamState } from "../chat/stream-registry.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "inno-durable-stream-journal-"));
	dirs.push(dir);
	const registry = new StreamRegistry();
	const state = registry.createTurn({
		sessionId: "durable-123e4567-e89b-42d3-a456-426614174000",
		clientRequestId: "request-1",
		workspaceId: "workspace-1",
		workspaceRoot: dir,
		inputSnapshot: { prompt: "raw prompt", submittedAt: new Date().toISOString(), images: [] },
		baselineMessageCount: 0,
		baselineSessionRevision: "durable:0",
	});
	const store = new DurableStreamStore(join(dir, "streams"));
	return { registry, state, store, journalPath: join(dir, "streams", state.sessionId, `${state.turnId}.jsonl`) };
}

describe("DurableStreamStore", () => {
	it("restores exact event IDs, submission intent and cancellation into a fresh registry", () => {
		const { registry, state, store } = setup();
		const input = [{ type: "text" as const, text: "raw prompt" }, { type: "text" as const, text: "hidden recall" }];
		store.create(state, input);
		store.append(registry.publishStreamEvent(state, { type: "stream_state", status: "queued" }));
		store.append(registry.publishStreamEvent(state, { type: "stream_state", status: "running" }));
		store.append(registry.publishStreamEvent(state, { type: "text_delta", delta: "partial", contentIndex: 0 }));
		store.markAdmitted(state.sessionId, state.turnId, 42 as SubmissionId);
		store.markCancelled(state.sessionId, state.turnId);

		const restored = store.load(state.sessionId, state.turnId)!;
		expect(restored.input).toEqual(input);
		expect(restored.submissionId).toBe(42);
		const fresh = new StreamRegistry();
		const recovered = fresh.restoreTurn(restored.snapshot, restored.history, restored.cancelRequested);
		expect(recovered.turnId).toBe(state.turnId);
		expect(recovered.status).toBe("running");
		expect(recovered.cancelRequested).toBe(true);
		expect(recovered.history.map((event) => event.eventId)).toEqual([1, 2, 3]);
		expect(fresh.getLatest(state.sessionId)?.turnId).toBe(state.turnId);
		expect(snapshotStreamState(recovered).baselineSessionRevision).toBe("durable:0");
	});

	it("replays a terminal turn and tolerates only a partial final append", () => {
		const { registry, state, store, journalPath } = setup();
		store.create(state, "prompt");
		store.append(registry.publishStreamEvent(state, { type: "stream_state", status: "queued" }));
		store.append(registry.publishStreamEvent(state, { type: "stream_state", status: "running" }));
		store.append(registry.finishTurn(state, "completed", { type: "done", fullText: "answer" }, {
			persisted: true, finalMessageCount: 2, finalSessionRevision: "durable:2",
		})!);
		appendFileSync(journalPath, '{"kind":"event"', "utf-8");

		const restored = store.latest(state.sessionId)!;
		const recovered = new StreamRegistry().restoreTurn(restored.snapshot, restored.history);
		expect(recovered.status).toBe("completed");
		expect(recovered.terminalEventPublished).toBe(true);
		expect(recovered.persisted).toBe(true);
		expect(recovered.finalSessionRevision).toBe("durable:2");
		expect(recovered.history.at(-1)?.event.type).toBe("done");
	});
});
