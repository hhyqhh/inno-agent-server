import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { buildAttachmentContext } from "../server/attachments.js";
import { durableEntriesToMessages, DurableSseProjector } from "./durable-projection.js";

function event(value: Record<string, unknown>): AgentEvent {
	return value as unknown as AgentEvent;
}

describe("DurableSseProjector", () => {
	it("maps durable message changes instead of legacy assistantMessageEvent", () => {
		const projector = new DurableSseProjector();
		const events = projector.project(event({
			type: "message_update",
			changes: [
				{ type: "text_start", contentIndex: 0 },
				{ type: "text_delta", contentIndex: 0, delta: "hello" },
				{ type: "thinking_delta", contentIndex: 1, delta: "reasoning" },
			],
		}));
		expect(events).toEqual([
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "hello" },
			{ type: "thinking_delta", contentIndex: 1, delta: "reasoning" },
		]);
	});

	it("tracks tool-call IDs and retained output across delta events", () => {
		const projector = new DurableSseProjector();
		expect(projector.project(event({
			type: "message_update",
			changes: [{
				type: "toolcall_start",
				contentIndex: 0,
				block: { type: "toolCall", id: "call-1", name: "read", arguments: {} },
			}],
		}))).toEqual([{ type: "tool_call_start", toolCallId: "call-1", toolName: "read", contentIndex: 0 }]);
		expect(projector.project(event({
			type: "message_update",
			changes: [{ type: "toolcall_delta", contentIndex: 0, path: ["arguments"], delta: "{}" }],
		}))).toEqual([{ type: "tool_call_delta", toolCallId: "call-1", toolName: "read", contentIndex: 0, argsDelta: "{}" }]);

		projector.project(event({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} }));
		expect(projector.project(event({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "read",
			output: { set: "abcdef" },
		}))[0]).toMatchObject({ partialResult: "abcdef" });
		expect(projector.project(event({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "read",
			output: { trimStart: 2, append: "!" },
		}))[0]).toMatchObject({ partialResult: "cdef!" });
	});

	it("does not duplicate full-message checkpoints after streamed deltas", () => {
		const projector = new DurableSseProjector();
		expect(projector.project(event({
			type: "message_update",
			changes: [{ type: "message", message: { role: "assistant", content: [] } }],
		}))).toEqual([]);
	});

	it("hides the durable attachment context while preserving the raw prompt", () => {
		const context = buildAttachmentContext({
			bindings: [{ word: "资料", wordIndex: 0, files: [{ path: "notes.pdf", kind: "pdf", source: "workspace" }] }],
			loose: [],
		});
		const entries = [{
			id: 1,
			model: [{
				role: "user",
				content: [{ type: "text", text: "总结资料" }, { type: "text", text: context }],
				timestamp: 1,
			}],
		}] as unknown as EntryRecord[];
		expect(durableEntriesToMessages(entries)).toEqual([
			{ role: "user", content: "总结资料", timestamp: 1, entryId: "1" },
		]);
	});
});
