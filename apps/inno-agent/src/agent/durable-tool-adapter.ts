import type { JsonValue } from "@earendil-works/chord";
import type { ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";

export interface DurableExecutableToolResult {
	content: ToolResultMessage["content"];
	details?: unknown;
	structuredContent?: unknown;
	isError?: boolean;
	usage?: Usage;
	terminate?: boolean;
}

/** Structural contract for replay-safe Inno tools adapted from the legacy
 * five-argument execution ABI. Durable itself does not import that runtime. */
export interface DurableExecutableTool {
	name: string;
	description: string;
	parameters: ToolRegistration["parameters"];
	executionMode?: ToolRegistration["executionMode"];
	prepareArguments?: ToolRegistration["prepareArguments"];
	outputSchema?: ToolRegistration["structuredOutputSchema"];
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: { content: Array<{ type: string; text?: string }>; details?: unknown }) => void) | undefined,
		// The legacy extension context stays opaque at this adapter boundary.
		context: any,
	): Promise<DurableExecutableToolResult>;
}

/** Adapt an Inno tool whose replay contract has been made durable-safe. The
 * stable durable call ID and abort signal are preserved across reopen. */
export function createDurableToolRegistrations(
	tools: DurableExecutableTool[],
	legacyContext: { cwd: string },
): ToolRegistration[] {
	return tools.map((tool) => defineTool({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		replay: "safe",
		executionMode: tool.executionMode,
		...(tool.prepareArguments ? { prepareArguments: tool.prepareArguments } : {}),
		...(tool.outputSchema ? { structuredOutputSchema: tool.outputSchema } : {}),
		async execute(args, api, context) {
			const onUpdate = (partial: { content: { type: string; text?: string }[]; details?: unknown }): void => {
				for (const block of partial.content) {
					if (block.type === "text" && block.text) api.output(block.text);
				}
				if (partial.details !== undefined) {
					void api.details(partial.details as JsonValue, context).catch(() => undefined);
				}
			};
			const toolContext = {
				...legacyContext,
				model: undefined,
				modelRegistry: undefined,
			};
			const result = await tool.execute(api.callId, args, context.abortSignal, onUpdate, toolContext);
			return {
				output: result.content,
				...(result.details !== undefined ? { details: result.details as JsonValue } : {}),
				...(tool.outputSchema && result.structuredContent !== undefined
					? { structuredOutput: result.structuredContent as JsonValue }
					: {}),
				...(result.isError !== undefined ? { isError: result.isError } : {}),
				...(result.usage ? { usage: result.usage } : {}),
				...(result.terminate ? { control: { terminate: true } } : {}),
			};
		},
	}));
}
