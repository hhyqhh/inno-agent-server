import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DurableQuestionStore } from "./durable-questions.js";
import { DurableSessionRuntime } from "./durable-runtime.js";

const [storagePath, questionDir, workspaceDir] = process.argv.slice(2);
if (!storagePath || !questionDir || !workspaceDir) {
	throw new Error("storage path, question directory and workspace are required");
}

const store = new DurableQuestionStore("durable-crash-question", questionDir);
store.bindTurn({
	turnId: "crash-question-turn",
	emit: (event) => {
		if (event.type !== "question") return;
		const status = store.respond({
			turnId: "crash-question-turn",
			questionId: String(event.questionId),
			result: {
				answers: [{ questionIndex: 0, question: "继续学习吗？", kind: "option", answer: "继续" }],
				cancelled: false,
			},
		});
		console.log(`question-answer-persisted:${status}:${String(event.questionId)}`);
		// The answer is durable, but the tool result has not committed yet.
		process.kill(process.pid, "SIGKILL");
	},
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("ask_user_question", {
		questions: [{
			question: "继续学习吗？",
			header: "下一步",
			options: [{ label: "继续", description: "继续当前课程" }, { label: "暂停", description: "稍后再学" }],
		}],
	}, { id: "crash-question-call" }), { stopReason: "toolUse" }),
]);

const runtime = await DurableSessionRuntime.open({
	storagePath,
	models,
	model: { provider: faux.provider.id, modelId: faux.getModel().id },
	workspaceDir,
	questions: { store, workspaceDir },
});
const submission = await runtime.submit("ask before crashing", "question-crash-request");
console.log(`submission:${submission.id}`);
await runtime.waitForSubmission(submission.id);
