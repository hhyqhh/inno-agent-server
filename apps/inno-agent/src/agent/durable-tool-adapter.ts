import type { JsonValue } from "@earendil-works/chord";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";

/** Adapt an Inno tool whose replay contract has been made durable-safe. The
 * stable durable call ID and abort signal are preserved across reopen. */
export function createDurableToolRegistrations(
	tools: ToolDefinition[],
	legacyContext: Pick<ExtensionToolContext, "cwd">,
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
			} as unknown as ExtensionToolContext;
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
