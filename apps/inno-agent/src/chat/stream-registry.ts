import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import type { ChatAttachments } from "../server/attachments.js";

export type StreamStatus = "queued" | "running" | "completed" | "error" | "aborted";

export type ChatStreamEvent = Record<string, unknown> & { type: string };

export interface StreamEventEnvelope {
	eventId: number;
	sessionId: string;
	turnId: string;
	clientRequestId: string;
	/** Stable per-turn trace identity used by the UI sidecar and reconnects. */
	traceId: string;
	occurredAt: string;
	event: ChatStreamEvent;
}

export interface StreamInputSnapshot {
	prompt: string;
	submittedAt: string;
	images: Array<{ mimeType: string; workspacePath: string; previewUrl?: string }>;
	/** Structured attachments accepted with this turn (bubble bindings + loose files). */
	attachments?: ChatAttachments;
}

export interface ActiveStreamTool {
	toolCallId: string;
	toolName: string;
	args?: unknown;
	/** Latest partial result emitted while the tool is still running. */
	partialResult?: unknown;
	startedAt: string;
}

export interface CompletedStreamTool extends ActiveStreamTool {
	result?: unknown;
	isError: boolean;
	finishedAt: string;
}

export interface PendingQuestionSnapshot {
	questionId: string;
	params: unknown;
	createdAt: string;
}

export interface StreamPersistence {
	persisted: boolean;
	finalMessageCount?: number;
	finalSessionRevision?: string;
}

export function hasCompleteTurnAfterBaseline(
	messages: ReadonlyArray<{ role: string }>,
	baselineMessageCount: number,
): boolean {
	const tail = messages.slice(baselineMessageCount);
	let latestUserIndex = -1;
	for (let index = tail.length - 1; index >= 0; index--) {
		if (tail[index]?.role === "user") {
			latestUserIndex = index;
			break;
		}
	}
	return latestUserIndex >= 0 &&
		tail.slice(latestUserIndex + 1).some((message) => message.role === "assistant");
}

export interface SessionStreamState {
	sessionId: string;
	turnId: string;
	clientRequestId: string;
	workspaceId: string;
	/** Server-only; omitted from public snapshots. */
	workspaceRoot: string;
	status: StreamStatus;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	inputSnapshot: StreamInputSnapshot;
	activeTools: ActiveStreamTool[];
	completedTools: CompletedStreamTool[];
	pendingQuestion?: PendingQuestionSnapshot;
	lastEventId: number;
	history: StreamEventEnvelope[];
	subscribers: Set<(event: StreamEventEnvelope) => void>;
	cancelRequested: boolean;
	terminalEventPublished: boolean;
	terminalReason?: string;
	baselineMessageCount: number;
	baselineSessionRevision: string;
	persisted: boolean;
	finalMessageCount?: number;
	finalSessionRevision?: string;
}

export interface CreateTurnInput {
	sessionId: string;
	clientRequestId: string;
	workspaceId: string;
	workspaceRoot: string;
	inputSnapshot: StreamInputSnapshot;
	baselineMessageCount: number;
	baselineSessionRevision: string;
}

export type StreamStateSnapshot = Omit<SessionStreamState, "history" | "subscribers">;

export function snapshotStreamState(state: SessionStreamState): StreamStateSnapshot {
	const { history: _history, subscribers: _subscribers, ...snapshot } = state;
	return snapshot;
}

const TERMINAL_TYPES = new Set(["done", "error", "aborted"]);
const ACTIVE_STATUSES = new Set<StreamStatus>(["queued", "running"]);
const MAX_TEXT = 256_000;
const MAX_PAYLOAD = 64_000;

function compact(value: unknown, limit = MAX_PAYLOAD): unknown {
	if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}…[truncated]` : value;
	try {
		const json = JSON.stringify(value);
		if (json.length <= limit) return value;
		return { truncated: true, preview: json.slice(0, limit) };
	} catch {
		return String(value).slice(0, limit);
	}
}

function compactEvent(event: ChatStreamEvent): ChatStreamEvent {
	const next = { ...event };
	if (typeof next.delta === "string") next.delta = compact(next.delta, MAX_TEXT);
	if (typeof next.fullText === "string") next.fullText = compact(next.fullText, MAX_TEXT);
	if ("args" in next) next.args = compact(next.args);
	if ("result" in next) next.result = compact(next.result);
	if ("partialResult" in next) next.partialResult = compact(next.partialResult, 16_000);
	if ("params" in next) next.params = compact(next.params);
	if (Array.isArray(next.changes)) {
		const changes: unknown[] = [];
		let size = 2;
		for (const change of next.changes) {
			const item = compact(change, 8_000);
			const itemSize = (JSON.stringify(item) ?? "").length + 1;
			if (size + itemSize > MAX_PAYLOAD) break;
			changes.push(item);
			size += itemSize;
		}
		if (changes.length < next.changes.length) next.truncated = true;
		next.changes = changes;
	} else if ("changes" in next) {
		next.changes = compact(next.changes);
	}
	if ("preview" in next) next.preview = compact(next.preview);
	if ("content" in next) next.content = compact(next.content);
	if ("detail" in next) next.detail = compact(next.detail);
	if ("skills" in next) next.skills = compact(next.skills);
	return next;
}

function notifySubscriber(
	state: SessionStreamState,
	subscriber: (event: StreamEventEnvelope) => void,
	envelope: StreamEventEnvelope,
): boolean {
	try {
		subscriber(envelope);
		return true;
	} catch (error) {
		state.subscribers.delete(subscriber);
		try {
			logger.warn({ error, sessionId: state.sessionId, turnId: state.turnId }, "chat stream subscriber failed");
		} catch {
			// Observability must never break stream delivery or finalization.
		}
		return false;
	}
}

function reduceStreamState(state: SessionStreamState, event: ChatStreamEvent, occurredAt = new Date().toISOString()): void {
	if (event.type === "stream_state") {
		const status = event.status;
		if (status === "running" && state.status === "queued") {
			state.status = "running";
			state.startedAt = occurredAt;
		}
		return;
	}
	if (event.type === "tool_start") {
		const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
		if (!toolCallId) return;
		const tool: ActiveStreamTool = {
			toolCallId,
			toolName: typeof event.toolName === "string" ? event.toolName : "tool",
			args: event.args,
			startedAt: occurredAt,
		};
		state.activeTools = [...state.activeTools.filter((item) => item.toolCallId !== toolCallId), tool];
		return;
	}
	if (event.type === "tool_update") {
		const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
		if (!toolCallId) return;
		const active = state.activeTools.find((item) => item.toolCallId === toolCallId);
		if (active) {
			state.activeTools = state.activeTools.map((item) => item.toolCallId === toolCallId
				? {
					...item,
					...(typeof event.toolName === "string" && event.toolName ? { toolName: event.toolName } : {}),
					...(event.args !== undefined ? { args: event.args } : {}),
					...(event.partialResult !== undefined ? { partialResult: event.partialResult } : {}),
				}
				: item);
		} else {
			// Be tolerant of a reconnect that starts at an update event.
			state.activeTools = [...state.activeTools, {
				toolCallId,
				toolName: typeof event.toolName === "string" && event.toolName ? event.toolName : "tool",
				...(event.args !== undefined ? { args: event.args } : {}),
				...(event.partialResult !== undefined ? { partialResult: event.partialResult } : {}),
				startedAt: occurredAt,
			}];
		}
		return;
	}
	if (event.type === "tool_end") {
		const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
		if (!toolCallId) return;
		const active = state.activeTools.find((item) => item.toolCallId === toolCallId);
		state.activeTools = state.activeTools.filter((item) => item.toolCallId !== toolCallId);
		const completed: CompletedStreamTool = {
			...(active ?? {
				toolCallId,
				toolName: typeof event.toolName === "string" ? event.toolName : "tool",
				startedAt: occurredAt,
			}),
			result: event.result,
			isError: event.isError === true,
			finishedAt: occurredAt,
		};
		state.completedTools = [...state.completedTools.filter((item) => item.toolCallId !== toolCallId), completed];
		return;
	}
	if (event.type === "question") {
		if (typeof event.questionId === "string") {
			state.pendingQuestion = {
				questionId: event.questionId,
				params: event.params,
				createdAt: occurredAt,
			};
		}
		return;
	}
	if (event.type === "question_resolved" && state.pendingQuestion?.questionId === event.questionId) {
		state.pendingQuestion = undefined;
	}
}

export class StreamRegistry {
	private readonly streamsByTurn = new Map<string, SessionStreamState>();
	private readonly latestTurnBySession = new Map<string, string>();

	createTurn(input: CreateTurnInput): SessionStreamState {
		const existing = this.getLatest(input.sessionId);
		if (existing && ACTIVE_STATUSES.has(existing.status)) throw new Error("active_turn_exists");
		const now = new Date().toISOString();
		const state: SessionStreamState = {
			...input,
			turnId: randomUUID(),
			status: "queued",
			createdAt: now,
			activeTools: [],
			completedTools: [],
			lastEventId: 0,
			history: [],
			subscribers: new Set(),
			cancelRequested: false,
			terminalEventPublished: false,
			persisted: false,
		};
		this.streamsByTurn.set(state.turnId, state);
		this.latestTurnBySession.set(state.sessionId, state.turnId);
		return state;
	}

	getByTurn(turnId: string): SessionStreamState | undefined { return this.streamsByTurn.get(turnId); }

	discardTurn(state: SessionStreamState): void {
		if (state.history.length > 0 || state.subscribers.size > 0 || state.status !== "queued") {
			throw new Error("Only an unpublished queued turn can be discarded");
		}
		this.streamsByTurn.delete(state.turnId);
		if (this.latestTurnBySession.get(state.sessionId) === state.turnId) {
			this.latestTurnBySession.delete(state.sessionId);
		}
	}

	/** Rehydrate an application-journaled durable turn without changing its
	 * identity or event IDs. A live in-memory turn always wins over disk. */
	restoreTurn(
		snapshot: StreamStateSnapshot,
		history: StreamEventEnvelope[],
		cancelRequested = false,
	): SessionStreamState {
		const existing = this.getByTurn(snapshot.turnId);
		if (existing) return existing;
		const state: SessionStreamState = {
			...snapshot,
			status: "queued",
			startedAt: undefined,
			finishedAt: undefined,
			activeTools: [],
			completedTools: [],
			pendingQuestion: undefined,
			lastEventId: 0,
			history: [],
			subscribers: new Set(),
			cancelRequested,
			terminalEventPublished: false,
			terminalReason: undefined,
			persisted: false,
			finalMessageCount: undefined,
			finalSessionRevision: undefined,
		};
		for (const envelope of history) {
			if (envelope.turnId !== state.turnId || envelope.sessionId !== state.sessionId
				|| envelope.eventId !== state.lastEventId + 1) {
				throw new Error("Invalid durable stream journal event sequence");
			}
			state.history.push(envelope);
			state.lastEventId = envelope.eventId;
			if (TERMINAL_TYPES.has(envelope.event.type)) {
				state.status = envelope.event.type === "done" ? "completed" : envelope.event.type as "error" | "aborted";
				state.finishedAt = envelope.occurredAt;
				state.terminalReason = typeof envelope.event.message === "string" ? envelope.event.message : undefined;
				state.persisted = envelope.event.persisted === true;
				state.finalMessageCount = typeof envelope.event.finalMessageCount === "number" ? envelope.event.finalMessageCount : undefined;
				state.finalSessionRevision = typeof envelope.event.finalSessionRevision === "string" ? envelope.event.finalSessionRevision : undefined;
				state.pendingQuestion = undefined;
				state.terminalEventPublished = true;
			} else {
				if (state.terminalEventPublished) throw new Error("Durable stream journal contains events after its terminal event");
				reduceStreamState(state, envelope.event, envelope.occurredAt);
			}
		}
		this.streamsByTurn.set(state.turnId, state);
		const latest = this.getLatest(state.sessionId);
		if (!latest || Date.parse(latest.createdAt) <= Date.parse(state.createdAt)) {
			this.latestTurnBySession.set(state.sessionId, state.turnId);
		}
		return state;
	}

	getLatest(sessionId: string): SessionStreamState | undefined {
		const turnId = this.latestTurnBySession.get(sessionId);
		return turnId ? this.streamsByTurn.get(turnId) : undefined;
	}

	getActiveForSession(sessionId: string): SessionStreamState | undefined {
		const state = this.getLatest(sessionId);
		return state && ACTIVE_STATUSES.has(state.status) ? state : undefined;
	}

	getActiveForWorkspace(workspaceId: string): SessionStreamState | undefined {
		for (const state of this.streamsByTurn.values()) {
			if (state.workspaceId === workspaceId && ACTIVE_STATUSES.has(state.status)) return state;
		}
		return undefined;
	}

	publishStreamEvent(state: SessionStreamState, event: ChatStreamEvent): StreamEventEnvelope {
		if (TERMINAL_TYPES.has(event.type)) throw new Error(`terminal event ${event.type} must use finishTurn()`);
		if (state.terminalEventPublished) throw new Error("cannot publish after terminal event");
		if (event.type === "stream_state") {
			const nextStatus = event.status;
			const alreadyPublishedQueued = state.history.some((item) => item.event.type === "stream_state" && item.event.status === "queued");
			if (nextStatus === "queued" && state.status === "queued" && !alreadyPublishedQueued) {
				// Initial state announcement; createTurn already owns the queued state.
			} else if (nextStatus === "running" && state.status === "queued") {
				// The only non-terminal state transition.
			} else {
				throw new Error(`invalid stream transition ${state.status} -> ${String(nextStatus)}`);
			}
		} else if (state.status !== "running") {
			throw new Error(`cannot publish ${event.type} while stream is ${state.status}`);
		}
		const compacted = compactEvent(event);
		reduceStreamState(state, compacted);
		const envelope: StreamEventEnvelope = {
			eventId: ++state.lastEventId,
			sessionId: state.sessionId,
			turnId: state.turnId,
			clientRequestId: state.clientRequestId,
			traceId: state.turnId,
			occurredAt: new Date().toISOString(),
			event: compacted,
		};
		state.history.push(envelope);
		for (const subscriber of [...state.subscribers]) notifySubscriber(state, subscriber, envelope);
		return envelope;
	}

	finishTurn(
		state: SessionStreamState,
		status: Exclude<StreamStatus, "queued" | "running">,
		event: ChatStreamEvent,
		persistence: StreamPersistence,
	): StreamEventEnvelope | undefined {
		if (state.terminalEventPublished) return undefined;
		const validTransition = state.status === "queued"
			? status === "aborted"
			: state.status === "running" && (status === "completed" || status === "error" || status === "aborted");
		if (!validTransition) throw new Error(`invalid stream transition ${state.status} -> ${status}`);
		const expectedType = status === "completed" ? "done" : status;
		if (event.type !== expectedType) throw new Error(`terminal status ${status} requires ${expectedType} event`);
		state.terminalEventPublished = true;
		state.status = status;
		state.finishedAt = new Date().toISOString();
		state.terminalReason = typeof event.message === "string" ? event.message : undefined;
		state.persisted = persistence.persisted;
		state.finalMessageCount = persistence.finalMessageCount;
		state.finalSessionRevision = persistence.finalSessionRevision;
		state.pendingQuestion = undefined;
		const terminalEvent = compactEvent({ ...event, ...persistence });
		const envelope: StreamEventEnvelope = {
			eventId: ++state.lastEventId,
			sessionId: state.sessionId,
			turnId: state.turnId,
			clientRequestId: state.clientRequestId,
			traceId: state.turnId,
			occurredAt: new Date().toISOString(),
			event: terminalEvent,
		};
		state.history.push(envelope);
		for (const subscriber of [...state.subscribers]) notifySubscriber(state, subscriber, envelope);
		state.subscribers.clear();
		return envelope;
	}

	subscribe(state: SessionStreamState, after: number, subscriber: (event: StreamEventEnvelope) => void): () => void {
		// JS execution is single-threaded: replay and registration are atomic with
		// respect to publishStreamEvent(), so no event can fall into a gap here.
		let healthy = true;
		for (const event of state.history) {
			if (event.eventId > after && !notifySubscriber(state, subscriber, event)) {
				healthy = false;
				break;
			}
		}
		if (healthy && !state.terminalEventPublished) state.subscribers.add(subscriber);
		return () => state.subscribers.delete(subscriber);
	}

	requestCancel(state: SessionStreamState): boolean {
		if (!ACTIVE_STATUSES.has(state.status)) return false;
		state.cancelRequested = true;
		return true;
	}

	toPublicSnapshot(state: SessionStreamState) {
		const { workspaceRoot: _workspaceRoot, history: _history, subscribers: _subscribers, ...snapshot } = state;
		return {
			...snapshot,
			inputSnapshot: {
				...snapshot.inputSnapshot,
				images: snapshot.inputSnapshot.images.map((image) => ({
					...image,
					previewUrl: `/api/workspace/raw?workspaceId=${encodeURIComponent(snapshot.workspaceId)}&path=${encodeURIComponent(image.workspacePath)}`,
				})),
			},
		};
	}

	cleanupExpiredTurns(now = Date.now(), ttlMs = 300_000): number {
		let removed = 0;
		for (const [turnId, state] of this.streamsByTurn) {
			if (ACTIVE_STATUSES.has(state.status)) continue;
			const finishedAt = Date.parse(state.finishedAt ?? "");
			if (!Number.isFinite(finishedAt) || now - finishedAt < ttlMs) continue;
			this.streamsByTurn.delete(turnId);
			if (this.latestTurnBySession.get(state.sessionId) === turnId) this.latestTurnBySession.delete(state.sessionId);
			removed++;
		}
		return removed;
	}
}

export const streamRegistry = new StreamRegistry();
