import type { AgentEvent, EntryRecord, SnapshotEvent } from "@earendil-works/pi-durable";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ChatStreamEvent } from "../chat/stream-registry.js";
import type { SessionMessageSummary, SessionSummary } from "../server/session-model.js";
import { isChatAttachmentContext } from "../server/attachments.js";
import { isImagePathsHint } from "../server/inline-images.js";

function textContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function userTextContent(message: Extract<Message, { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	const textBlocks = message.content.filter((block) => block.type === "text");
	return textBlocks
		.filter((block, index) => index === 0 || !isChatAttachmentContext(block.text) && !isImagePathsHint(block.text))
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function thinkingContent(message: AssistantMessage): string | undefined {
	const thinking = message.content
		.filter((block) => block.type === "thinking")
		.map((block) => block.thinking)
		.join("\n")
		.trim();
	return thinking || undefined;
}

/** Convert committed durable entries to the same visible history shape used by
 * legacy JSONL sessions. Tool results are folded into their assistant call. */
export function durableEntriesToMessages(entries: readonly EntryRecord[]): SessionMessageSummary[] {
	const messages: SessionMessageSummary[] = [];
	const toolCalls = new Map<string, NonNullable<SessionMessageSummary["tools"]>[number]>();
	for (const entry of entries) {
		const message = entry.model?.[0];
		if (!message) continue;
		if (message.role === "user") {
			messages.push({
				role: "user",
				content: userTextContent(message),
				timestamp: message.timestamp,
				entryId: String(entry.id),
			});
			continue;
		}
		if (message.role === "assistant") {
			const thinking = thinkingContent(message);
			const tools = message.content
				.filter((block) => block.type === "toolCall")
				.map((block) => ({
					toolCallId: block.id,
					toolName: block.name,
					args: block.arguments,
				}));
			for (const tool of tools) toolCalls.set(tool.toolCallId, tool);
			messages.push({
				role: "assistant",
				content: textContent(message),
				timestamp: message.timestamp,
				entryId: String(entry.id),
				...(thinking ? { thinking } : {}),
				stopReason: message.stopReason,
				...(tools.length > 0 ? { tools } : {}),
			});
			continue;
		}
		if (message.role === "toolResult") {
			const tool = toolCalls.get(message.toolCallId);
			if (tool) {
				tool.result = message.content;
				tool.isError = message.isError;
			}
		}
	}
	return messages;
}

export function durableSnapshotSummary(id: string, snapshot: SnapshotEvent): SessionSummary {
	const messages = durableEntriesToMessages(snapshot.entries);
	const timestamps = messages.map((message) => message.timestamp).filter(Number.isFinite);
	const created = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
	const updated = timestamps.length > 0 ? Math.max(...timestamps) : created;
	return {
		id,
		name: "新对话",
		createdAt: new Date(created).toISOString(),
		updatedAt: new Date(updated).toISOString(),
		messageCount: messages.length,
		preview: messages.find((message) => message.role === "user")?.content ?? "",
		channels: ["web"],
		origin: "web",
	};
}

function systemEvent(event: AgentEvent, eventType = `durable:${event.type}`): ChatStreamEvent {
	return {
		type: "system_event",
		eventType,
		phase: event.type,
		detail: {
			...("toolName" in event ? { toolName: event.toolName } : {}),
			...("kind" in event ? { kind: event.kind } : {}),
			...("message" in event && typeof event.message === "string" ? { message: event.message } : {}),
		},
	};
}

/** Stateful only for stream cosmetics (content-index/tool-ID and retained tool
 * output). Durable storage, not this projector, remains the execution truth. */
export class DurableSseProjector {
	private readonly toolCalls = new Map<number, { id: string; name: string }>();
	private readonly toolOutput = new Map<string, string>();

	project(event: AgentEvent): ChatStreamEvent[] {
		switch (event.type) {
			case "snapshot":
				return [{ type: "durable_snapshot", messages: durableEntriesToMessages(event.entries) }];
			case "message_update":
				return event.changes.flatMap((change) => this.projectMessageChange(change));
			case "message_end":
				if (event.entry.model?.[0]?.role === "assistant") {
					for (const [index, block] of event.entry.model[0].content.entries()) {
						if (block.type === "toolCall") this.toolCalls.set(index, { id: block.id, name: block.name });
					}
				}
				return [systemEvent(event)];
			case "tool_execution_start":
				this.toolOutput.set(event.toolCallId, "");
				return [{
					type: "tool_start",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				}];
			case "tool_execution_update": {
				let output = this.toolOutput.get(event.toolCallId) ?? "";
				if (event.output && "set" in event.output) output = event.output.set;
				else if (event.output) {
					output = output.slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
				}
				this.toolOutput.set(event.toolCallId, output);
				return [{
					type: "tool_update",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					...(event.output ? { partialResult: output } : {}),
					...(event.details !== undefined ? { details: event.details } : {}),
				}];
			}
			case "tool_execution_end": {
				this.toolOutput.delete(event.toolCallId);
				const message = event.entry?.model?.[0];
				const toolResult: ToolResultMessage | undefined = message?.role === "toolResult" ? message : undefined;
				return [{
					type: "tool_end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					result: toolResult?.content ?? event.result?.structuredOutput,
					isError: toolResult?.isError === true,
				}];
			}
			case "auto_retry_start":
			case "auto_retry_end":
				return [{ ...event }];
			case "run_start":
			case "run_end":
			case "turn_start":
			case "turn_end":
			case "message_start":
			case "inbox_update":
			case "submission":
			case "entry_appended":
			case "agent_changed":
			case "usage_changed":
			case "deferred_poll":
				return [];
			default:
				return [systemEvent(event)];
		}
	}

	private projectMessageChange(change: Extract<AgentEvent, { type: "message_update" }>["changes"][number]): ChatStreamEvent[] {
		switch (change.type) {
			case "text_start":
			case "thinking_start":
				return [{ type: change.type, contentIndex: change.contentIndex }];
			case "text_delta":
			case "thinking_delta":
				return [{ type: change.type, delta: change.delta, contentIndex: change.contentIndex }];
			case "toolcall_start": {
				if (change.block.type !== "toolCall") return [];
				this.toolCalls.set(change.contentIndex, { id: change.block.id, name: change.block.name });
				return [{
					type: "tool_call_start",
					toolCallId: change.block.id,
					toolName: change.block.name,
					contentIndex: change.contentIndex,
				}];
			}
			case "toolcall_delta": {
				const call = this.toolCalls.get(change.contentIndex);
				return [{
					type: "tool_call_delta",
					...(call
						? { toolCallId: call.id, toolName: call.name }
						: { toolCallId: `content-${change.contentIndex}`, toolName: "" }),
					contentIndex: change.contentIndex,
					argsDelta: change.delta,
				}];
			}
			case "block": {
				if (change.block.type !== "toolCall") return [];
				const call = this.toolCalls.get(change.contentIndex);
				return [{
					type: "tool_call_end",
					toolCallId: call?.id ?? change.block.id,
					toolName: call?.name ?? change.block.name,
					contentIndex: change.contentIndex,
					args: change.block.arguments,
				}];
			}
			case "message":
				// Deltas already projected the visible stream; the full message is a
				// committed checkpoint, not another batch of user-visible deltas.
				return [];
		}
	}
}
