import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { applyLearningEventToProfile } from "../memory/learner/auto-profile.js";
import { recordEventAndApplyProfileOnce } from "../memory/learner/profile-store.js";
import { createLearningEvent, type LearningEventType } from "../memory/learner/types.js";
import { DurableSessionRuntime } from "./durable-runtime.js";

const storagePath = process.argv[2];
const dataRoot = process.argv[3];
if (!storagePath || !dataRoot) throw new Error("storage path and data root are required");

const learnerDataDir = join(dataRoot, "learner");
const sessionId = "durable-crash-memory";
const crashingRecordTool = defineTool({
	name: "record_learning_event",
	description: "Crash fixture for the committed event/profile boundary",
	parameters: Type.Object({
		event_type: Type.String(),
		context: Type.Record(Type.String(), Type.Unknown()),
		payload: Type.Record(Type.String(), Type.Unknown()),
	}),
	replay: "safe",
	async execute(args, api) {
		const event = createLearningEvent(
			"default",
			args.event_type as LearningEventType,
			args.context,
			args.payload,
		);
		event.dedupe_key = `record_learning_event:${sessionId}:${api.callId}`;
		recordEventAndApplyProfileOnce(learnerDataDir, event, (profile, persisted) => {
			applyLearningEventToProfile(profile, persisted);
			console.log("event-applied-before-profile-commit");
			process.kill(process.pid, "SIGKILL");
		});
		return { output: [{ type: "text", text: "unreachable" }] };
	},
});
const registry = createRegistry();
registry.install(defineExtension({ name: "inno.memory", tools: [crashingRecordTool] }));

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("record_learning_event", {
		event_type: "concept_explained",
		context: { concept_ids: ["physics.force_decomposition"] },
		payload: { topic: "力的分解" },
	}, { id: "crash-memory-event" }), { stopReason: "toolUse" }),
]);

const memory = {
	sessionId,
	learnerDataDir,
	l2DataDir: join(dataRoot, "l2"),
	workspaceDir: dataRoot,
	l1Enabled: true,
	l2Enabled: true,
};
const runtime = await DurableSessionRuntime.open({
	storagePath,
	models,
	model: { provider: faux.provider.id, modelId: faux.getModel().id },
	registry,
	memory,
});
const submission = await runtime.submit("record before crashing", "memory-crash-request");
console.log(`submission:${submission.id}`);
await runtime.waitForSubmission(submission.id);
