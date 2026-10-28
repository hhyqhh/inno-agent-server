import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ChannelRegistry } from "../../channels/channel.js";
import type { JobStore } from "../../scheduler/job-store.js";
import type { ScheduledJob } from "../../scheduler/types.js";
import { executeJob, type CreatedJobSession, type DurableJobExecution, type JobRunResult, type JobSessionTarget } from "../../scheduler/job-runner.js";
import { validateCron } from "../../scheduler/cron-utils.js";
import { json, matchRoute, readBody } from "../http-helpers.js";
import { isLearningJob, type CheckInStore } from "../../checkins/check-in-store.js";
import { logger } from "../../logger.js";
import { questionBridge } from "../../agent/question-bridge.js";
import { permissionBridge } from "../../agent/permission-bridge.js";
import { cancelDeferredRun, isDeferredExecuting } from "../../scheduler/deferred-runs.js";
import { claimOccurrenceForExecution } from "../../scheduler/execution-claims.js";
import type { JobRunClaim, TenantStore } from "../../tenants/store.js";
import { claimRequestResource, getRequestTenant, ownsRequestResource, releaseRequestResource } from "../../tenants/http.js";

type JobRunStreamEvent =
	| { type: "job_state"; status: "queued" | "running" }
	| { type: "text_start"; contentIndex?: number }
	| { type: "text_delta"; delta: string; contentIndex?: number }
	| { type: "text_end"; contentIndex?: number }
	| { type: "thinking_start"; contentIndex?: number }
	| { type: "thinking_delta"; delta: string; contentIndex?: number }
	| { type: "thinking_end"; contentIndex?: number }
	| { type: "tool_start"; toolCallId: string; toolName: string; args?: unknown }
	| { type: "tool_update"; toolCallId: string; toolName: string; args?: unknown; partialResult?: unknown }
	| { type: "tool_end"; toolCallId: string; toolName: string; result?: unknown; isError?: boolean }
	| { type: "question"; questionId: string; params: unknown; turnId?: string; toolCallId?: string }
	| { type: "question_resolved"; questionId: string; cancelled?: boolean; error?: string }
	| { type: "job_result"; result: JobRunResult }
	| { type: "error"; message: string };

const MAX_TOOL_PAYLOAD = 8_000;

/** Tool args/results can be huge (file reads, command output); keep the SSE frame small. */
function compactToolPayload(value: unknown): unknown {
	if (typeof value === "string") {
		return value.length > MAX_TOOL_PAYLOAD ? `${value.slice(0, MAX_TOOL_PAYLOAD)}…[truncated]` : value;
	}
	if (value === undefined || value === null) return undefined;
	try {
		const json = JSON.stringify(value);
		if (typeof json === "string" && json.length > MAX_TOOL_PAYLOAD) {
			return { truncated: true, preview: json.slice(0, MAX_TOOL_PAYLOAD) };
		}
	} catch {
		return String(value).slice(0, MAX_TOOL_PAYLOAD);
	}
	return value;
}

/**
 * Map a raw pi AgentSessionEvent to the job-run SSE vocabulary. Returns null
 * for events the job chat bubble does not render. Exported for tests.
 */
export function jobStreamEventFromAgent(event: unknown): JobRunStreamEvent | null {
	if (!event || typeof event !== "object") return null;
	const record = event as Record<string, unknown>;
	if (typeof record.toolCallId === "string" && record.toolCallId) {
		const toolName = typeof record.toolName === "string" && record.toolName ? record.toolName : "tool";
		if (record.type === "tool_execution_start") {
			const args = compactToolPayload(record.args);
			return { type: "tool_start", toolCallId: record.toolCallId, toolName, ...(args === undefined ? {} : { args }) };
		}
		if (record.type === "tool_execution_update") {
			const args = compactToolPayload(record.args);
			const partialResult = compactToolPayload(record.partialResult);
			return {
				type: "tool_update",
				toolCallId: record.toolCallId,
				toolName,
				...(args === undefined ? {} : { args }),
				...(partialResult === undefined ? {} : { partialResult }),
			};
		}
		if (record.type === "tool_execution_end") {
			const result = compactToolPayload(record.result);
			return {
				type: "tool_end",
				toolCallId: record.toolCallId,
				toolName,
				...(result === undefined ? {} : { result }),
				isError: record.isError === true,
			};
		}
	}
	// Durable already projects coding-agent-like top-level events. Normalize its
	// tool payloads here too, then share the text/thinking mapping below.
	if (record.type === "tool_start" || record.type === "tool_update" || record.type === "tool_end") {
		const toolName = typeof record.toolName === "string" && record.toolName ? record.toolName : "tool";
		const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : "";
		if (!toolCallId) return null;
		if (record.type === "tool_start") {
			const args = compactToolPayload(record.args);
			return { type: "tool_start", toolCallId, toolName, ...(args === undefined ? {} : { args }) };
		}
		if (record.type === "tool_update") {
			const partialResult = compactToolPayload(record.partialResult);
			return { type: "tool_update", toolCallId, toolName, ...(partialResult === undefined ? {} : { partialResult }) };
		}
		const result = compactToolPayload(record.result);
		return {
			type: "tool_end", toolCallId, toolName,
			...(result === undefined ? {} : { result }), isError: record.isError === true,
		};
	}
	if (record.type === "question" && typeof record.questionId === "string") {
		return {
			type: "question", questionId: record.questionId, params: record.params,
			...(typeof record.turnId === "string" ? { turnId: record.turnId } : {}),
			...(typeof record.toolCallId === "string" ? { toolCallId: record.toolCallId } : {}),
		};
	}
	if (record.type === "question_resolved" && typeof record.questionId === "string") {
		return {
			type: "question_resolved", questionId: record.questionId,
			cancelled: record.cancelled === true,
			...(typeof record.error === "string" ? { error: record.error } : {}),
		};
	}
	if (record.type === "text_start" || record.type === "text_end"
		|| record.type === "thinking_start" || record.type === "thinking_end") {
		return { type: record.type, ...(typeof record.contentIndex === "number" ? { contentIndex: record.contentIndex } : {}) };
	}
	if (record.type === "text_delta" || record.type === "thinking_delta") {
		return typeof record.delta === "string"
			? { type: record.type, delta: record.delta, ...(typeof record.contentIndex === "number" ? { contentIndex: record.contentIndex } : {}) }
			: null;
	}
	const assistantMessageEvent = record.assistantMessageEvent as {
		type?: unknown;
		delta?: unknown;
		contentIndex?: unknown;
	} | undefined;
	if (record.type !== "message_update" || !assistantMessageEvent) return null;
	const assistant = assistantMessageEvent;
	const contentIndex = typeof assistant.contentIndex === "number" ? assistant.contentIndex : undefined;
	switch (assistant.type) {
		case "text_start":
			return { type: "text_start", ...(contentIndex === undefined ? {} : { contentIndex }) };
		case "text_delta":
			return typeof assistant.delta === "string"
				? { type: "text_delta", delta: assistant.delta, ...(contentIndex === undefined ? {} : { contentIndex }) }
				: null;
		case "text_end":
			return { type: "text_end", ...(contentIndex === undefined ? {} : { contentIndex }) };
		case "thinking_start":
			return { type: "thinking_start", ...(contentIndex === undefined ? {} : { contentIndex }) };
		case "thinking_delta":
			return typeof assistant.delta === "string"
				? { type: "thinking_delta", delta: assistant.delta, ...(contentIndex === undefined ? {} : { contentIndex }) }
				: null;
		case "thinking_end":
			return { type: "thinking_end", ...(contentIndex === undefined ? {} : { contentIndex }) };
		default:
			return null;
	}
}

function writeJobStreamEvent(res: ServerResponse, event: JobRunStreamEvent): boolean {
	if (res.writableEnded || res.destroyed) return false;
	try {
		res.write(`data: ${JSON.stringify(event)}\n\n`);
		return true;
	} catch {
		return false;
	}
}

export interface JobsRouteContext {
	jobStore: JobStore;
	channelRegistry: ChannelRegistry;
	checkInStore?: CheckInStore;
	resolveSessionPath?: (sessionId: string) => string | null;
	resolveSession?: (sessionId: string) => JobSessionTarget | null;
	createSession?: (req: HttpReq, job: ScheduledJob) => Promise<CreatedJobSession | null>;
	durableExecutor?: (req: HttpReq, execution: DurableJobExecution) => Promise<string>;
	/** Tag the target session as scheduler-born so the sidebar badges it. */
	recordJobRunSession?: (sessionId: string, req: HttpReq) => void;
	/** Abort the in-flight manual job run streaming into this session. */
	abortJobRun?: (sessionId: string) => Promise<boolean>;
	/** Release a durable question waiter when its only live view disconnects. */
	disconnectJobRun?: (sessionId: string, turnId: string) => void;
	/** Agent jobs always execute in durable sessions in multi-user mode. */
	durableRequired?: boolean;
	tenantStore: TenantStore | null;
}

/**
 * /api/jobs* route domain. Returns true when the request was handled.
 * Extracted verbatim from server.ts during the P2 route split (blocks were
 * originally at two sites in the giant handler; relative order within the
 * domain is preserved) — behavior unchanged.
 */
export async function handleJobsRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: JobsRouteContext,
): Promise<boolean> {
	const { jobStore, channelRegistry, tenantStore } = ctx;
	let occurrenceClaim: JobRunClaim | undefined;
	const rejectLegacyExecution = () => {
		if (!ctx.durableRequired) return false;
		json(res, 409, {
			error: "Legacy sessions are read-only in multi-user mode; select a durable session instead",
			code: "durable_required",
		});
		return true;
	};
	const requireSessionOwnership = async (sessionId: string): Promise<boolean> => {
		if (await ownsRequestResource(req, tenantStore, "session", sessionId)) return true;
		json(res, 404, { error: "Session not found" });
		return false;
	};
	const resolveSession = (sessionId: string): JobSessionTarget | null => {
		if (ctx.resolveSession) return ctx.resolveSession(sessionId);
		const path = ctx.resolveSessionPath?.(sessionId);
		return path ? { id: sessionId, path, runtime: "legacy" } : null;
	};
	const durableExecutor = (execution: DurableJobExecution) => {
		if (!ctx.durableExecutor) throw new Error("Durable job execution is unavailable");
		return ctx.durableExecutor(req, execution);
	};

	if (method === "GET" && url === "/api/jobs") {
		json(res, 200, jobStore.list());
		return true;
	}

	if (method === "GET" && url === "/api/jobs/status") {
		json(res, 200, jobStore.getStatus());
		return true;
	}

	if (method === "GET" && url === "/api/jobs/runs") {
		json(res, 200, jobStore.listRuns());
		return true;
	}

	if (method === "POST" && url === "/api/jobs") {
		const body = await readBody(req) as Record<string, unknown> & Parameters<JobStore["create"]>[0];
		if (typeof body.cron !== "string") {
			json(res, 400, { error: "cron is required" });
			return true;
		}
		const cronCheck = validateCron(body.cron, typeof body.timezone === "string" ? body.timezone : undefined);
		if (!cronCheck.ok) {
			json(res, 400, { error: `Invalid cron: ${cronCheck.error}` });
			return true;
		}
		if (body.channel && !channelRegistry.get(body.channel)) {
			json(res, 400, { error: `Channel not registered: ${body.channel}. Enable it in settings first.` });
			return true;
		}
		if (body.runtime !== undefined && body.runtime !== "legacy" && body.runtime !== "durable") {
			json(res, 400, { error: "runtime must be legacy or durable" });
			return true;
		}
		if (ctx.durableRequired && body.runtime === "legacy") return rejectLegacyExecution();
		const isReminder = body.taskType === "push_reminder" || body.taskType === "check_in_reminder";
		if (ctx.durableRequired && body.runtime === undefined && !isReminder) body.runtime = "durable";
		if (body.runtime === "durable" && isReminder) {
			json(res, 400, { error: "Durable jobs support agent tasks, not reminder tasks" });
			return true;
		}
		const job = jobStore.create(body);
		try {
			await claimRequestResource(req, tenantStore, "job", job.id);
		} catch (err) {
			jobStore.delete(job.id);
			throw err;
		}
		json(res, 201, job);
		return true;
	}

	const runsMatch = matchRoute("GET", method, url, "/api/jobs/:id/runs");
	if (runsMatch) {
		if (getRequestTenant(req) && !jobStore.get(runsMatch.id)) {
			json(res, 404, { error: "Job not found" });
			return true;
		}
		json(res, 200, jobStore.listRuns(runsMatch.id));
		return true;
	}

	const stopMatch = matchRoute("POST", method, url, "/api/jobs/run/stop");
	if (stopMatch) {
		const body = await readBody(req) as Record<string, unknown>;
		const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
		if (!sessionId) {
			json(res, 400, { error: "sessionId is required" });
			return true;
		}
		if (!await requireSessionOwnership(sessionId)) return true;
		const stopped = ctx.abortJobRun ? await ctx.abortJobRun(sessionId) : false;
		if (stopped) logger.info({ sessionId }, "Manual job run stop requested");
		else logger.warn({ sessionId }, "Job stop request not applied: no matching in-flight run");
		json(res, 200, { stopped });
		return true;
	}

	const runStreamMatch = matchRoute("POST", method, url, "/api/jobs/:id/run/stream");
	if (runStreamMatch) {
		const job = jobStore.get(runStreamMatch.id);
		if (!job) {
			json(res, 404, { error: "Job not found" });
			return true;
		}
		const body = await readBody(req) as Record<string, unknown>;
		const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
		if (!sessionId) {
			json(res, 400, { error: "sessionId is required for streaming job runs" });
			return true;
		}
		if (!await requireSessionOwnership(sessionId)) return true;
		const occurrenceId = typeof body.occurrenceId === "string" ? body.occurrenceId.trim() : "";
		// Resolve the target session BEFORE claiming the slot: a 404 here must
		// not leak the claim, which would wedge the occurrence (auto-exec is
		// blocked by isOccurrenceClaimed, manual retries 409) until restart.
		const session = resolveSession(sessionId);
		if (!session) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		if (session.runtime === "legacy" && rejectLegacyExecution()) return true;
		const sessionPath = session.path;
		if (occurrenceId) {
			// A manual run takes over a fired-but-waiting slot: cancel its
			// deferred auto-execution and reserve the slot so cron re-fires
			// or another start cannot double-run it.
			await cancelDeferredRun(occurrenceId);
			if (isDeferredExecuting(occurrenceId)) {
				json(res, 409, { error: "This slot's auto-execution already started." });
				return true;
			}
			if (isLearningJob(job) && ctx.checkInStore) {
				const occurrence = ctx.checkInStore.resolveOccurrence(job.id, occurrenceId);
				if (!occurrence) {
					json(res, 409, { error: "Learning schedule slot is no longer pending." });
					return true;
				}
				occurrenceClaim = (await claimOccurrenceForExecution(ctx.checkInStore, job, occurrenceId, occurrence.scheduledAt)) ?? undefined;
				if (!occurrenceClaim) {
					json(res, 409, { error: "This slot is already being handled." });
					return true;
				}
			}
		}
		ctx.recordJobRunSession?.(sessionId, req);

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no",
		});
		let disconnected = false;
		let responseEnded = false;
		const heartbeat = setInterval(() => {
			if (disconnected || responseEnded) return;
			try {
				res.write(": heartbeat\n\n");
			} catch {
				disconnected = true;
			}
		}, 15_000);
		const finish = () => {
			if (responseEnded) return;
			responseEnded = true;
			clearInterval(heartbeat);
			if (!disconnected && !res.writableEnded) {
				res.write("data: [DONE]\n\n");
				res.end();
			}
		};
		writeJobStreamEvent(res, { type: "job_state", status: "queued" });
		writeJobStreamEvent(res, { type: "job_state", status: "running" });
		logger.info({ jobId: job.id, sessionId }, "Manual job run stream opened");
		// The run's agent may call ask_user_question; binding the bridge lets the
		// tool park and wait for an answer instead of failing with "no_ui".
		const runTurnId = randomUUID();
		if (session.runtime === "legacy") {
			questionBridge.bindTurn({
				sessionId,
				turnId: runTurnId,
				timeoutMs: 30 * 60_000,
				emit: (event) => {
					const forwarded = event.type === "question" ? { ...event, turnId: runTurnId } : event;
					writeJobStreamEvent(res, forwarded as JobRunStreamEvent);
				},
			});
			permissionBridge.bindTurn({
				sessionId,
				turnId: runTurnId,
				tenantId: getRequestTenant(req)?.tenantId,
				runId: sessionPath,
				timeoutMs: 30 * 60_000,
				emit: (event) => {
					const forwarded = event.type === "permission_request" ? { ...event, turnId: runTurnId } : event;
					writeJobStreamEvent(res, forwarded as JobRunStreamEvent);
				},
			});
		}
		res.on("close", () => {
			disconnected = true;
			clearInterval(heartbeat);
			// The run itself keeps going server-side; only the live view is lost.
			logger.info({ jobId: job.id, sessionId }, "Manual job run stream disconnected");
			// Nobody can answer a question with the stream gone — release the tool.
			if (session.runtime === "durable") {
				ctx.disconnectJobRun?.(sessionId, runTurnId);
			} else {
				questionBridge.unbindTurn({ sessionId, turnId: runTurnId, reason: "client_disconnected" });
				permissionBridge.unbindTurn({ sessionId, turnId: runTurnId, reason: "client_disconnected" });
			}
		});
		try {
			const result = await executeJob(
				job,
				jobStore,
				channelRegistry,
				"api",
				ctx.checkInStore,
				{
					sessionPath,
					sessionId,
					sessionRuntime: session.runtime,
					durableExecutor,
					turnId: runTurnId,
					occurrenceId: occurrenceId || undefined,
					onEvent: (event) => {
						const normalized = jobStreamEventFromAgent(event);
						if (normalized && !writeJobStreamEvent(res, normalized)) disconnected = true;
					},
				},
			);
			logger.info({ jobId: job.id, sessionId, runId: result.runId, success: result.success }, "Manual job run stream finished");
			// Tenant leases end with the attempt; local success retains its legacy claim.
			if (occurrenceId && (!result.success || getRequestTenant(req))) await occurrenceClaim?.release();
			if (!disconnected) writeJobStreamEvent(res, { type: "job_result", result });
		} catch (err) {
			logger.error({ err, jobId: job.id, sessionId }, "Manual job run stream failed");
			if (occurrenceId) await occurrenceClaim?.release();
			if (!disconnected) {
				writeJobStreamEvent(res, { type: "error", message: err instanceof Error ? err.message : String(err) });
			}
		} finally {
			if (session.runtime === "legacy") {
				questionBridge.unbindTurn({ sessionId, turnId: runTurnId, reason: "finished" });
				permissionBridge.unbindTurn({ sessionId, turnId: runTurnId, reason: "finished" });
			}
			finish();
		}
		return true;
	}

	const runMatch = matchRoute("POST", method, url, "/api/jobs/:id/run");
	if (runMatch) {
		const job = jobStore.get(runMatch.id);
		if (!job) {
			json(res, 404, { error: "Job not found" });
			return true;
		}
		const body = await readBody(req) as Record<string, unknown>;
		const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
		const occurrenceId = typeof body.occurrenceId === "string" ? body.occurrenceId.trim() : "";
		if (getRequestTenant(req) && !sessionId) {
			json(res, 400, { error: "sessionId is required for authenticated manual job runs" });
			return true;
		}
		if (sessionId && !await requireSessionOwnership(sessionId)) return true;
		let session = sessionId ? resolveSession(sessionId) : null;
		if (sessionId && !session) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		if (session?.runtime === "legacy" && rejectLegacyExecution()) return true;
		if (!session && (job.runtime === "durable" || ctx.durableRequired)) {
			if (!ctx.createSession) {
				json(res, 503, { error: "Durable job session creation is unavailable" });
				return true;
			}
			const created = await ctx.createSession(req, job);
			if (!created || typeof created === "string" || created.runtime !== "durable") {
				json(res, 503, { error: "Durable job session creation failed" });
				return true;
			}
			session = created;
		}
		const sessionPath = session?.path;
		const targetSessionId = session?.id ?? "";
		if (targetSessionId) ctx.recordJobRunSession?.(targetSessionId, req);
		if (occurrenceId) {
			await cancelDeferredRun(occurrenceId);
			if (isDeferredExecuting(occurrenceId)) {
				json(res, 409, { error: "This slot's auto-execution already started." });
				return true;
			}
		}
		if (occurrenceId && isLearningJob(job) && ctx.checkInStore) {
			const occurrence = ctx.checkInStore.resolveOccurrence(job.id, occurrenceId);
			if (!occurrence) {
				json(res, 409, { error: "Learning schedule slot is no longer pending." });
				return true;
			}
			occurrenceClaim = (await claimOccurrenceForExecution(ctx.checkInStore, job, occurrenceId, occurrence.scheduledAt)) ?? undefined;
			if (!occurrenceClaim) {
				json(res, 409, { error: "This slot is already being handled." });
				return true;
			}
		}
		try {
			const result = await executeJob(
				job,
				jobStore,
				channelRegistry,
				"api",
				ctx.checkInStore,
				session || occurrenceId ? {
					sessionPath,
					sessionId: targetSessionId || undefined,
					sessionRuntime: session?.runtime,
					durableExecutor,
					occurrenceId: occurrenceId || undefined,
				} : undefined,
			);
			if (occurrenceId && (!result.success || getRequestTenant(req))) await occurrenceClaim?.release();
			json(res, 200, result);
		} catch (error) {
			if (occurrenceId) await occurrenceClaim?.release();
			throw error;
		}
		return true;
	}

	const patchMatch = matchRoute("PATCH", method, url, "/api/jobs/:id");
	if (patchMatch) {
		const body = await readBody(req) as Partial<ScheduledJob>;
		if (typeof body.cron === "string") {
			const cronCheck = validateCron(body.cron, body.timezone);
			if (!cronCheck.ok) {
				json(res, 400, { error: `Invalid cron: ${cronCheck.error}` });
				return true;
			}
		}
		if (body.channel && !channelRegistry.get(body.channel)) {
			json(res, 400, { error: `Channel not registered: ${body.channel}. Enable it in settings first.` });
			return true;
		}
		if (body.runtime !== undefined && body.runtime !== "legacy" && body.runtime !== "durable") {
			json(res, 400, { error: "runtime must be legacy or durable" });
			return true;
		}
		if (ctx.durableRequired && body.runtime === "legacy") return rejectLegacyExecution();
		const current = jobStore.get(patchMatch.id);
		const effectiveTaskType = body.taskType ?? current?.taskType;
		if (ctx.durableRequired && body.runtime === undefined && effectiveTaskType !== "push_reminder" && effectiveTaskType !== "check_in_reminder") {
			body.runtime = "durable";
		}
		if (body.runtime === "durable" && (effectiveTaskType === "push_reminder" || effectiveTaskType === "check_in_reminder")) {
			json(res, 400, { error: "Durable jobs support agent tasks, not reminder tasks" });
			return true;
		}
		if ((body.taskType === "push_reminder" || body.taskType === "check_in_reminder") && current?.runtime === "durable") {
			json(res, 400, { error: "Durable jobs support agent tasks, not reminder tasks" });
			return true;
		}
		const updated = jobStore.update(patchMatch.id, body);
		if (!updated) {
			json(res, 404, { error: "Job not found" });
			return true;
		}
		json(res, 200, updated);
		return true;
	}

	const deleteMatch = matchRoute("DELETE", method, url, "/api/jobs/:id");
	if (deleteMatch) {
		const deleted = jobStore.delete(deleteMatch.id);
		if (!deleted) {
			json(res, 404, { error: "Job not found" });
			return true;
		}
		await releaseRequestResource(req, tenantStore, "job", deleteMatch.id);
		json(res, 204, null);
		return true;
	}

	return false;
}
