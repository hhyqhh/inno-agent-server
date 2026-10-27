import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/chord";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { createLearnerTools } from "../memory/learner/learner-tools.js";
import { buildContextPack, formatContextPackForPrompt } from "../memory/learner/context-pack.js";
import { isProfileEmpty, loadProfile, loadRecentEvents } from "../memory/learner/profile-store.js";
import { createL2Tools } from "../memory/l2/l2-tools.js";
import { ONBOARDING_GUIDE } from "./system-prompt.js";

export interface DurableMemoryToolOptions {
	sessionId: string;
	learnerDataDir: string;
	l2DataDir: string;
	workspaceDir: string;
	l1Enabled: boolean;
	l2Enabled: boolean;
}

const DURABLE_L1_TOOLS = new Set([
	"get_learner_context",
	"record_learning_event",
	"record_learning_evidence",
	"assess_learning_prerequisites",
	"review_learner_profile",
]);

export function buildDurableInstructions(
	baseInstructions: string,
	options: Pick<DurableMemoryToolOptions, "learnerDataDir" | "l1Enabled">,
): string {
	if (!options.l1Enabled) return baseInstructions;
	const profile = loadProfile(options.learnerDataDir);
	const sections = [baseInstructions];
	if (isProfileEmpty(profile)) sections.push(ONBOARDING_GUIDE);
	const context = buildContextPack(profile, loadRecentEvents(options.learnerDataDir, 8));
	sections.push(formatContextPackForPrompt(context));
	return sections.join("\n\n");
}

/** Memory surface for opt-in durable sessions. Event/evidence writes use the
 * stable durable tool-call identity; L2 archive resumes by content hash and
 * manifest without nested model calls. Direct profile patch/update tools stay
 * unavailable until they have the same crash-recovery contract. */
export function createDurableMemoryTools(options: DurableMemoryToolOptions): ToolDefinition[] {
	const learnerTools = createLearnerTools(
		options.learnerDataDir,
		"default",
		() => options.l1Enabled,
		options.l2DataDir,
		() => options.l2Enabled,
		(toolCallId) => `${options.sessionId}:${toolCallId}`,
	).filter((tool) => DURABLE_L1_TOOLS.has(tool.name));
	const l2Tools = createL2Tools(
		options.l2DataDir,
		() => options.l2Enabled,
		undefined,
		() => options.workspaceDir,
		true,
		true,
	);
	return [...learnerTools, ...l2Tools];
}

/** Adapt only the memory tools above; their durable mode does not use the
 * legacy extension context's model registry or nested executeTool surface. */
export function createDurableMemoryRegistrations(
	options: DurableMemoryToolOptions,
): ToolRegistration[] {
	return createDurableMemoryTools(options).map((tool) => defineTool({
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
			const legacyContext = { model: undefined, modelRegistry: undefined } as unknown as ExtensionToolContext;
			const result = await tool.execute(api.callId, args, context.abortSignal, onUpdate, legacyContext);
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
