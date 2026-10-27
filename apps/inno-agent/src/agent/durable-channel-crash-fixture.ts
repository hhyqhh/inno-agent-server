import { readFileSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChannelRegistry } from "../channels/channel.js";
import { DurableSessionRuntime } from "./durable-runtime.js";

const [storagePath, outboxDir, workspaceDir] = process.argv.slice(2);
if (!storagePath || !outboxDir || !workspaceDir) {
	throw new Error("storage path, outbox directory and workspace are required");
}

const channelRegistry = new ChannelRegistry();
channelRegistry.register({
	name: "feishu",
	verify: async () => true,
	parse: async () => null,
	reply: async () => {},
	push: async () => {},
	sendFile: async (_target, filePath) => {
		console.log(`file-sent-before-outbox-commit:${readFileSync(filePath, "utf-8")}`);
		process.kill(process.pid, "SIGKILL");
	},
});
channelRegistry.setDefaultTarget({ channel: "feishu", chatId: "crash-chat" });

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("send_file_to_channel", {
		filePath: "report.txt",
		channel: "feishu",
	}, { id: "crash-channel-call" }), { stopReason: "toolUse" }),
]);
const runtime = await DurableSessionRuntime.open({
	storagePath,
	models,
	model: { provider: faux.provider.id, modelId: faux.getModel().id },
	workspaceDir,
	channels: {
		sessionId: "durable-crash-channel",
		outboxDir,
		workspaceDir,
		channelRegistry,
	},
});
const submission = await runtime.submit("send before crashing", "channel-crash-request");
console.log(`submission:${submission.id}`);
await runtime.waitForSubmission(submission.id);
