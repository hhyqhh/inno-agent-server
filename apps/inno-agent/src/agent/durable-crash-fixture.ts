import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { DurableSessionRuntime } from "./durable-runtime.js";

const storagePath = process.argv[2];
if (!storagePath) throw new Error("storage path is required");

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([async () => {
	console.log("model-started");
	await new Promise<void>(() => undefined);
	return fauxAssistantMessage("unreachable");
}]);

const runtime = await DurableSessionRuntime.open({
	storagePath,
	models,
	model: { provider: faux.provider.id, modelId: faux.getModel().id },
});
const submission = await runtime.submit("persist this before the crash", "crash-request");
console.log(`submission:${submission.id}`);
await runtime.waitForSubmission(submission.id);
