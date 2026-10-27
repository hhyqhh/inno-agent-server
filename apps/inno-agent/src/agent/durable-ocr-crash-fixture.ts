import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DurableSessionRuntime } from "./durable-runtime.js";

const [storagePath, checkpointDir, workspaceDir, baseUrl] = process.argv.slice(2);
if (!storagePath || !checkpointDir || !workspaceDir || !baseUrl) {
	throw new Error("storage path, checkpoint directory, workspace and OCR URL are required");
}

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("ocr_image", { filePath: "note.png" }, { id: "crash-ocr-call" }), { stopReason: "toolUse" }),
]);
const runtime = await DurableSessionRuntime.open({
	storagePath,
	models,
	model: { provider: faux.provider.id, modelId: faux.getModel().id },
	workspaceDir,
	ocr: {
		sessionId: "durable-crash-ocr",
		checkpointDir,
		workspaceDir,
		ocrApi: { token: "fixture-token", baseUrl },
	},
});
const submission = await runtime.submit("recognize before crashing", "ocr-crash-request");
console.log(`submission:${submission.id}`);
await runtime.waitForSubmission(submission.id);
