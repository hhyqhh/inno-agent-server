import type { IncomingMessage } from "node:http";
import type { UserInput } from "@earendil-works/pi-durable";
import { DurableSseProjector } from "./durable-projection.js";
import type { DurableSessionService } from "./durable-session-service.js";

export interface DurableJobPromptOptions {
	requestId: string;
	turnId: string;
	onEvent?: (event: any) => void;
}

/** Execute one scheduler prompt without passing through legacy JSONL or the
 * process-global prompt queue. Occurrence leases and run ledgers stay in the
 * scheduler layer; this function owns only durable submission and projection. */
export async function runDurableJobPrompt(
	req: IncomingMessage,
	service: DurableSessionService,
	sessionId: string,
	prompt: string,
	options: DurableJobPromptOptions,
): Promise<string> {
	if (!options.onEvent && service.pendingQuestion(req, sessionId)) {
		throw new Error("This session has a pending question; answer it through the streaming UI");
	}
	if (!options.onEvent && service.pendingPermission(req, sessionId)) {
		throw new Error("This session has a pending permission request; answer it through the streaming UI");
	}
	const recallContext = await service.prepareRecallContext(req, sessionId, prompt);
	let lease: Awaited<ReturnType<DurableSessionService["lease"]>> | undefined;
	let stream: { stop(): Promise<unknown> } | undefined;
	try {
		lease = await service.lease(req, sessionId);
		lease.runtime.bindQuestionTurn(options.onEvent
			? { turnId: options.turnId, emit: options.onEvent }
			: { turnId: options.turnId, noUi: true });
		lease.runtime.bindPermissionTurn(options.onEvent
			? { turnId: options.turnId, emit: options.onEvent }
			: { turnId: options.turnId, noUi: true });
		if (options.onEvent) {
			const projector = new DurableSseProjector();
			stream = await lease.runtime.watch(async (events) => {
				for (const event of events) {
					for (const projected of projector.project(event)) {
						if (projected.type !== "durable_snapshot") options.onEvent!(projected);
					}
				}
			});
		}
		const input: UserInput = recallContext
			? [{ type: "text", text: prompt }, { type: "text", text: recallContext }]
			: prompt;
		const submission = await lease.runtime.submit(input, options.requestId);
		service.noteSubmission(req, sessionId, prompt);
		const result = await lease.runtime.waitForSubmission(submission.id);
		if (result.status !== "done") throw new Error(`Durable submission was unanswered: ${result.reason}`);
		if (stream) {
			await stream.stop();
			stream = undefined;
		}
		await service.snapshot(req, sessionId);
		void service.maybeAutoGenerateTopic(req, sessionId);
		return result.text;
	} finally {
		if (stream) await stream.stop().catch(() => undefined);
		if (lease) {
			lease.runtime.unbindPermissionTurn(options.turnId);
			lease.runtime.unbindQuestionTurn(options.turnId);
			await lease.release();
		}
	}
}
