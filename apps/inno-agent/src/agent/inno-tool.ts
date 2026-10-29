import type { Context, JsonValue } from "@earendil-works/chord";
import type { Api, Model, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Static, TSchema } from "typebox";

/** Optional services available only when a native Inno tool runs through the
 * legacy extension adapter. Durable execution never supplies this context. */
export interface InnoLegacyToolContext {
	cwd: string;
	model?: Model<Api>;
	// The legacy registry remains opaque at this neutral execution boundary.
	modelRegistry?: any;
	sessionId?: string;
}

export type InnoToolExecutionApi = ToolExecutionApi & {
	readonly innoLegacy?: InnoLegacyToolContext;
};

export type InnoToolRegistration<TParameters extends TSchema = TSchema> = ToolRegistration<TParameters> & {
	readonly label?: string;
};

export interface InnoToolResult {
	content: ToolResultMessage["content"];
	details?: unknown;
	structuredContent?: unknown;
	isError?: boolean;
	usage?: Usage;
	terminate?: boolean;
}

/** Define a pi-durable-native tool while keeping Inno's existing result shape.
 * The execution ABI is always (params, api, context); no legacy tool context or
 * five-argument callback crosses into durable execution. */
export function defineInnoTool<TParameters extends TSchema>(
	definition: Omit<InnoToolRegistration<TParameters>, "execute"> & {
		execute(
			params: Static<TParameters>,
			api: InnoToolExecutionApi,
			context: Context,
		): Promise<InnoToolResult>;
	},
): InnoToolRegistration<TParameters> {
	const { execute, ...registration } = definition;
	return defineTool({
		...registration,
		async execute(params, api, context) {
			const result = await execute(params, api, context);
			return {
				output: result.content,
				...(result.details !== undefined ? { details: result.details as JsonValue } : {}),
				...(registration.structuredOutputSchema && result.structuredContent !== undefined
					? { structuredOutput: result.structuredContent as JsonValue }
					: {}),
				...(result.isError !== undefined ? { isError: result.isError } : {}),
				...(result.usage ? { usage: result.usage } : {}),
				...(result.terminate ? { control: { terminate: true } } : {}),
			};
		},
	});
}
