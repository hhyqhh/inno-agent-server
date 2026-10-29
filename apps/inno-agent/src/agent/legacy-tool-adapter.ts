import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { InnoToolExecutionApi, InnoToolRegistration } from "./inno-tool.js";

/** Legacy-only boundary for native Inno tools. The durable runtime imports the
 * native definitions directly and never loads this adapter. */
export function createLegacyToolDefinitions(tools: InnoToolRegistration[]): ToolDefinition[] {
	return tools.map((tool) => defineTool({
		name: tool.name,
		label: tool.label ?? tool.name,
		description: tool.description,
		parameters: tool.parameters,
		executionMode: tool.executionMode,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			let progressText = "";
			const api = {
				callId: toolCallId,
				innoLegacy: {
					cwd: ctx.cwd,
					model: ctx.model,
					modelRegistry: ctx.modelRegistry,
					sessionId: ctx.sessionManager.getSessionFile?.(),
				},
				output(chunk: string | Uint8Array) {
					progressText = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
					onUpdate?.({ content: [{ type: "text", text: progressText }], details: {} });
				},
				async details(value: JsonValue) {
					onUpdate?.({
						content: progressText ? [{ type: "text", text: progressText }] : [],
						details: value,
					});
				},
			} as unknown as InnoToolExecutionApi;
			const context = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
			const result = await tool.execute(params, api, context);
			return {
				content: result.output ?? [],
				details: result.details ?? {},
				...(result.structuredOutput !== undefined ? { structuredContent: result.structuredOutput } : {}),
				...(result.isError !== undefined ? { isError: result.isError } : {}),
				...(result.usage ? { usage: result.usage } : {}),
				...(result.control?.terminate ? { terminate: true } : {}),
			};
		},
	}));
}
