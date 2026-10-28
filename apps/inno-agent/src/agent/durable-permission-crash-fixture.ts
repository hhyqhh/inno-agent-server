import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DurablePermissionStore } from "./durable-permissions.js";
import { DurableSessionRuntime } from "./durable-runtime.js";

const [storagePath, permissionDir, workspaceDir] = process.argv.slice(2);
if (!storagePath || !permissionDir || !workspaceDir) {
	throw new Error("storage path, permission directory and workspace are required");
}

const store = new DurablePermissionStore("durable-crash-permission", permissionDir);
store.bindTurn({
	turnId: "crash-permission-turn",
	emit: (event) => {
		if (event.type !== "permission_request") return;
		const status = store.respond({
			turnId: "crash-permission-turn",
			requestId: String(event.requestId),
			decision: "allow_once",
		});
		console.log(`permission-decision-persisted:${status}:${String(event.requestId)}`);
		// The approval is durable, but neither the write nor its tool result has
		// committed yet. Recovery must resume this exact call without a new card.
		process.kill(process.pid, "SIGKILL");
	},
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("write", {
		path: "recovered.txt",
		content: "written after recovered approval",
	}, { id: "crash-permission-call" }), { stopReason: "toolUse" }),
]);

const runtime = await DurableSessionRuntime.open({
	storagePath,
	models,
	model: { provider: faux.provider.id, modelId: faux.getModel().id },
	workspaceDir,
	workspaceTools: true,
	permissions: store,
});
const submission = await runtime.submit("write after approval", "permission-crash-request");
console.log(`submission:${submission.id}`);
await runtime.waitForSubmission(submission.id);
