import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { unavailableContextUsage } from "../agent/context-usage.js";
import type { UserInput } from "@earendil-works/pi-durable";
import { DurableRuntimeDisabledError, DurableSessionBusyError, type DurableSessionService, type PreparedDurableAttachments } from "../agent/durable-session-service.js";
import { DurableSseProjector } from "../agent/durable-projection.js";
import type { QuestionBridgeResult } from "../agent/question-bridge.js";
import { hasCompleteTurnAfterBaseline, streamRegistry, type SessionStreamState } from "../chat/stream-registry.js";
import { logger } from "../logger.js";
import { releaseRequestResource } from "../tenants/http.js";
import type { TenantStore } from "../tenants/store.js";
import type { WorkspaceRegistry } from "../workspace/workspace-registry.js";
import { json, matchRoute, readBody } from "./http-helpers.js";

export interface DurableHttpContext {
	service: DurableSessionService;
	workspaceRegistry: WorkspaceRegistry;
	tenantStore?: TenantStore | null;
}

function errorStatus(error: unknown): number {
	return error instanceof DurableRuntimeDisabledError ? 503 : 500;
}

/** Handle only subresources whose semantics have a durable implementation.
 * Workspace subroutes return false so the existing workspace handler can run. */
export async function handleDurableSessionResourceRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	id: string,
	ctx: DurableHttpContext,
): Promise<boolean> {
	if (url.includes("/workspace")) return false;
	if (matchRoute("GET", method, url, "/api/sessions/:id/context-usage")) {
		json(res, 200, unavailableContextUsage(id, "unavailable"));
		return true;
	}
	if (matchRoute("GET", method, url, "/api/sessions/:id")) {
		try {
			const detail = await ctx.service.snapshot(req, id);
			json(res, 200, {
				...detail.summary,
				messages: detail.messages,
				messageCount: detail.messages.length,
				sessionRevision: detail.revision,
				...(detail.pendingQuestion ? { pendingQuestion: detail.pendingQuestion } : {}),
			});
		} catch (error) {
			json(res, errorStatus(error), { error: error instanceof Error ? error.message : String(error) });
		}
		return true;
	}
	if (matchRoute("PATCH", method, url, "/api/sessions/:id")) {
		const body = await readBody(req) as Record<string, unknown>;
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!name) { json(res, 400, { error: "Missing session topic" }); return true; }
		json(res, 200, ctx.service.rename(req, id, name.slice(0, 120)));
		return true;
	}
	if (matchRoute("POST", method, url, "/api/sessions/:id/activate")) {
		// Durable sessions do not switch the legacy process-global AgentSession.
		json(res, 200, { id, active: true });
		return true;
	}
	if (matchRoute("DELETE", method, url, "/api/sessions/:id")) {
		if (streamRegistry.getActiveForSession(id)) {
			json(res, 409, { error: "Cannot delete a session with an active chat turn" });
			return true;
		}
		try {
			await ctx.service.delete(req, id);
		} catch (error) {
			if (error instanceof DurableSessionBusyError) {
				json(res, 409, { error: error.message });
				return true;
			}
			throw error;
		}
		ctx.workspaceRegistry.unbindSession(id);
		await releaseRequestResource(req, ctx.tenantStore, "session", id);
		json(res, 200, { id, deleted: true });
		return true;
	}
	if (matchRoute("POST", method, url, "/api/sessions/:id/archive")) {
		json(res, 200, ctx.service.setArchived(req, id, true));
		return true;
	}
	if (matchRoute("POST", method, url, "/api/sessions/:id/unarchive")) {
		json(res, 200, ctx.service.setArchived(req, id, false));
		return true;
	}
	json(res, 400, { error: "This legacy session operation is not supported for durable sessions" });
	return true;
}

function startSse(res: ServerResponse): void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		"Connection": "keep-alive",
		"X-Accel-Buffering": "no",
	});
}

function durableUserInput(prompt: string, attachments: PreparedDurableAttachments | null): UserInput {
	if (!attachments) return prompt;
	// The model receives both blocks. The first preserves the visible/raw user
	// prompt; the second carries validated workspace attachment relationships.
	return [
		{ type: "text", text: prompt },
		{ type: "text", text: attachments.context },
	];
}

async function streamDurableTurn(
	req: HttpReq,
	state: SessionStreamState,
	prompt: string,
	service: DurableSessionService,
	attachments: PreparedDurableAttachments | null,
): Promise<void> {
	const projector = new DurableSseProjector();
	let lease: Awaited<ReturnType<DurableSessionService["lease"]>> | undefined;
	let stream: { stop(): Promise<unknown> } | undefined;
	try {
		lease = await service.lease(req, state.sessionId);
		lease.runtime.bindQuestionTurn({
			turnId: state.turnId,
			emit: (event) => streamRegistry.publishStreamEvent(state, event),
		});
		const activeStream = await lease.runtime.watch(async (events) => {
			if (state.terminalEventPublished) return;
			for (const event of events) {
				for (const projected of projector.project(event)) {
					// A watch snapshot is useful to native durable consumers but is not
					// an Inno historical replay event. Canonical history is reloaded on done.
					if (projected.type === "durable_snapshot") continue;
					if (!state.terminalEventPublished) streamRegistry.publishStreamEvent(state, projected);
				}
			}
		});
		stream = activeStream;
		streamRegistry.publishStreamEvent(state, { type: "stream_state", status: "running" });
		if (state.cancelRequested) {
			await lease.runtime.abort();
			streamRegistry.finishTurn(state, "aborted", {
				type: "aborted", message: "Stopped",
			}, { persisted: false });
			return;
		}
		const submission = await lease.runtime.submit(durableUserInput(prompt, attachments), state.clientRequestId);
		service.noteSubmission(req, state.sessionId, prompt);
		// Cancellation can race durable admission. Re-apply the abort after the
		// submission commits so an admitted queued input cannot escape it.
		if (state.cancelRequested) await lease.runtime.abort();
		const result = await lease.runtime.waitForSubmission(submission.id);
		await activeStream.stop();
		stream = undefined;
		await lease.release();
		lease = undefined;
		const detail = await service.snapshot(req, state.sessionId);
		const hasNewCompleteTurn = hasCompleteTurnAfterBaseline(
			detail.messages,
			state.baselineMessageCount,
		);
		// A retry with the same requestId resolves the original submission. It
		// legitimately appends no second user/assistant pair after the baseline.
		const hasCommittedAnswer = result.status === "done" && detail.messages.some((message) =>
			message.role === "assistant" && message.content === result.text,
		);
		const persisted = result.status === "done" && (hasNewCompleteTurn || hasCommittedAnswer);
		const persistence = {
			persisted,
			finalMessageCount: detail.messages.length,
			finalSessionRevision: detail.revision,
		};
		if (result.status === "done" && persisted && !state.cancelRequested) {
			streamRegistry.finishTurn(state, "completed", { type: "done", fullText: result.text }, persistence);
		} else if (state.cancelRequested) {
			streamRegistry.finishTurn(state, "aborted", {
				type: "aborted", message: "Stopped",
			}, persistence);
		} else if (result.status === "unanswered") {
			streamRegistry.finishTurn(state, "error", {
				type: "error",
				message: `Durable submission was unanswered: ${result.reason}`,
				code: "durable_unanswered",
			}, persistence);
		} else {
			streamRegistry.finishTurn(state, "error", {
				type: "error",
				message: "Final durable history could not be confirmed.",
				code: "persistence_confirmation_failed",
			}, persistence);
		}
	} catch (error) {
		logger.error({ err: error, sessionId: state.sessionId, turnId: state.turnId }, "durable SSE chat turn failed");
		if (!state.terminalEventPublished) {
			const persistence = { persisted: false };
			if (state.cancelRequested) {
				streamRegistry.finishTurn(state, "aborted", {
					type: "aborted", message: "Stopped",
				}, persistence);
			} else if (state.status === "queued") {
				streamRegistry.finishTurn(state, "aborted", {
					type: "aborted",
					message: error instanceof Error ? error.message : String(error),
				}, persistence);
			} else {
				streamRegistry.finishTurn(state, "error", {
					type: "error",
					message: error instanceof Error ? error.message : String(error),
				}, persistence);
			}
		}
	} finally {
		if (stream) await stream.stop().catch(() => undefined);
		if (lease) {
			lease.runtime.unbindQuestionTurn(state.turnId);
			await lease.release().catch(() => undefined);
		}
	}
}

/** Streaming and non-streaming chat entry points for an already authorized,
 * known durable session. Legacy sessions never enter this module. */
export async function handleDurableChatRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: DurableHttpContext,
	parsedBody?: Record<string, unknown>,
): Promise<boolean> {
	if (method === "POST" && url === "/api/chat/question-response") {
		const body = parsedBody ?? await readBody(req) as Record<string, unknown>;
		const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
		const turnId = typeof body.turnId === "string" ? body.turnId : "";
		const questionId = typeof body.questionId === "string" ? body.questionId : "";
		const result = body.result as QuestionBridgeResult | undefined;
		if (!sessionId || !turnId || !questionId || !result
			|| !Array.isArray(result.answers) || typeof result.cancelled !== "boolean") {
			json(res, 400, { error: "Missing or invalid sessionId, turnId, questionId or result" });
			return true;
		}
		const status = ctx.service.respondQuestion(req, sessionId, { turnId, questionId, result });
		let resumed = false;
		if (status === "accepted") {
			const live = streamRegistry.getByTurn(turnId);
			if (live?.sessionId === sessionId && (live.status === "queued" || live.status === "running")) {
				// The existing SSE holds the runtime lease until the final response.
				resumed = true;
			} else {
				try {
					await ctx.service.resumeAfterQuestion(req, sessionId);
					resumed = true;
				} catch (error) {
					// The answer is already durable. A later session open can retry the
					// recovered run; do not turn an accepted answer into a failed POST.
					logger.error({ err: error, sessionId, questionId }, "failed to resume durable question");
				}
			}
		}
		json(res, status === "accepted" ? 200 : status === "scope_mismatch" || status === "already_resolved" ? 409 : 404, {
			accepted: status === "accepted",
			...(status === "accepted" ? { resumed, sessionId } : {}),
		});
		return true;
	}

	if (method === "POST" && url === "/api/chat") {
		const body = parsedBody ?? await readBody(req) as Record<string, unknown>;
		const prompt = typeof body.prompt === "string" ? body.prompt : "";
		const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
		if (!prompt || !sessionId) { json(res, 400, { error: "Missing prompt or sessionId" }); return true; }
		if (Array.isArray(body.images) && body.images.length > 0) {
			json(res, 400, { error: "Durable inline images are not enabled in this migration slice" });
			return true;
		}
		if (streamRegistry.getActiveForSession(sessionId)) {
			json(res, 409, { error: "Session already has an active chat turn" });
			return true;
		}
		if (ctx.service.pendingQuestion(req, sessionId)) {
			json(res, 409, { error: "This session has a pending question; answer it through the streaming UI" });
			return true;
		}
		const attachments = ctx.service.prepareAttachments(req, sessionId, body.attachments);
		let lease: Awaited<ReturnType<DurableSessionService["lease"]>> | undefined;
		try {
			lease = await ctx.service.lease(req, sessionId);
			const requestId = typeof body.clientRequestId === "string" && body.clientRequestId.trim()
				? body.clientRequestId
				: `http-${crypto.randomUUID()}`;
			lease.runtime.bindQuestionTurn({ turnId: requestId, noUi: true });
			if (attachments) ctx.service.recordAttachments(req, sessionId, attachments, prompt, requestId);
			const submission = await lease.runtime.submit(durableUserInput(prompt, attachments), requestId);
			ctx.service.noteSubmission(req, sessionId, prompt);
			const result = await lease.runtime.waitForSubmission(submission.id);
			if (result.status !== "done") throw new Error(`Durable submission was unanswered: ${result.reason}`);
			await ctx.service.snapshot(req, sessionId);
			json(res, 200, { response: result.text });
		} catch (error) {
			json(res, errorStatus(error), { error: error instanceof Error ? error.message : String(error) });
		} finally {
			lease?.runtime.unbindQuestionTurn();
			await lease?.release().catch(() => undefined);
		}
		return true;
	}

	if (method !== "POST" || url !== "/api/chat/stream") return false;
	const body = parsedBody ?? await readBody(req) as Record<string, unknown>;
	const prompt = typeof body.prompt === "string" ? body.prompt : "";
	const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
	const clientRequestId = typeof body.clientRequestId === "string" ? body.clientRequestId : "";
	if (!prompt || !sessionId || !clientRequestId) {
		json(res, 400, { error: "Missing prompt, sessionId or clientRequestId" });
		return true;
	}
	if (Array.isArray(body.images) && body.images.length > 0) {
		json(res, 400, { error: "Durable inline images are not enabled in this migration slice" });
		return true;
	}
	if (streamRegistry.getActiveForSession(sessionId)) {
		json(res, 409, { error: "Session already has an active chat turn" });
		return true;
	}
	const workspaceId = ctx.workspaceRegistry.getSessionWorkspaceId(sessionId);
	const workspaceRoot = ctx.workspaceRegistry.resolveWorkspaceDir(workspaceId);
	if (!workspaceRoot) { json(res, 404, { error: "Session workspace not found" }); return true; }
	const attachments = ctx.service.prepareAttachments(req, sessionId, body.attachments);
	let baseline: Awaited<ReturnType<DurableSessionService["snapshot"]>>;
	try {
		baseline = await ctx.service.snapshot(req, sessionId);
	} catch (error) {
		json(res, errorStatus(error), { error: error instanceof Error ? error.message : String(error) });
		return true;
	}
	let state: SessionStreamState;
	try {
		state = streamRegistry.createTurn({
			sessionId,
			clientRequestId,
			workspaceId,
			workspaceRoot,
			inputSnapshot: { prompt, submittedAt: new Date().toISOString(), images: [], ...(attachments ? { attachments: attachments.attachments } : {}) },
			baselineMessageCount: baseline.messages.length,
			baselineSessionRevision: baseline.revision,
		});
	} catch {
		json(res, 409, { error: "Session already has an active chat turn" });
		return true;
	}
	if (attachments) ctx.service.recordAttachments(req, sessionId, attachments, prompt, clientRequestId);
	streamRegistry.publishStreamEvent(state, { type: "stream_state", status: "queued" });
	startSse(res);
	let ended = false;
	const heartbeat = setInterval(() => { if (!ended) res.write(": heartbeat\n\n"); }, 15_000);
	const finish = () => {
		if (ended) return;
		ended = true;
		clearInterval(heartbeat);
		res.write("data: [DONE]\n\n");
		res.end();
	};
	const unsubscribe = streamRegistry.subscribe(state, 0, (envelope) => {
		if (ended) return;
		res.write(`data: ${JSON.stringify(envelope)}\n\n`);
		if (["done", "error", "aborted"].includes(envelope.event.type)) finish();
	});
	res.on("close", () => {
		ended = true;
		clearInterval(heartbeat);
		unsubscribe();
	});
	await streamDurableTurn(req, state, prompt, ctx.service, attachments);
	finish();
	streamRegistry.cleanupExpiredTurns();
	return true;
}
