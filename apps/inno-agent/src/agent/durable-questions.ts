import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { writeJson } from "../storage/file-store.js";
import type { PersistedQuestion, QuestionBridgeResult, QuestionResponseStatus } from "./question-bridge.js";
import { resolvePluginFile } from "./permission-system-config.js";

export interface DurableQuestionBinding {
	turnId: string;
	emit?: (event: Record<string, unknown> & { type: string }) => void;
	/** Non-streaming callers have no question UI and resolve new asks as no_ui. */
	noUi?: boolean;
}

interface DurableQuestionRecord extends PersistedQuestion {
	operationId: string;
	toolCallId: string;
	result?: QuestionBridgeResult;
}

interface QuestionWaiter {
	resolve: (result: QuestionBridgeResult) => void;
}

function operationHash(operationId: string): string {
	return createHash("sha256").update(operationId).digest("hex");
}

/** Tenant/session-local question state. Answers are committed before the
 * in-memory waiter is released, so a crash cannot lose an accepted response. */
export class DurableQuestionStore {
	private binding: DurableQuestionBinding | null = null;
	private readonly waiters = new Map<string, QuestionWaiter>();
	private readonly presented = new Set<string>();

	constructor(
		readonly sessionId: string,
		readonly questionDir: string,
	) {}

	private path(operationId: string): string {
		return join(this.questionDir, `${operationHash(operationId)}.json`);
	}

	private load(operationId: string): DurableQuestionRecord | undefined {
		const path = this.path(operationId);
		if (!existsSync(path)) return undefined;
		const record = JSON.parse(readFileSync(path, "utf-8")) as DurableQuestionRecord;
		if (record.operationId !== operationId || record.sessionId !== this.sessionId
			|| record.questionId !== `durable-question-${operationHash(operationId)}`
			|| !record.turnId || !record.createdAt || !record.toolCallId) {
			throw new Error("Durable question record does not match the tool call");
		}
		return record;
	}

	private records(): DurableQuestionRecord[] {
		if (!existsSync(this.questionDir)) return [];
		return readdirSync(this.questionDir)
			.filter((file) => file.endsWith(".json"))
			.sort()
			.map((file) => {
				const record = JSON.parse(readFileSync(join(this.questionDir, file), "utf-8")) as DurableQuestionRecord;
				if (record.sessionId !== this.sessionId || !record.operationId
					|| record.questionId !== `durable-question-${operationHash(record.operationId)}`) {
					throw new Error("Invalid durable question record");
				}
				return record;
			});
	}

	private save(record: DurableQuestionRecord): void {
		writeJson(this.path(record.operationId), record, { mode: 0o600 });
	}

	private present(record: DurableQuestionRecord): void {
		const binding = this.binding;
		if (!binding || binding.noUi || !binding.emit) return;
		if (record.turnId !== binding.turnId) {
			record = { ...record, turnId: binding.turnId };
			this.save(record);
		}
		const key = `${binding.turnId}:${record.operationId}`;
		if (this.presented.has(key)) return;
		this.presented.add(key);
		binding.emit({
			type: "question",
			questionId: record.questionId,
			params: record.params,
			toolCallId: record.toolCallId,
		});
	}

	bindTurn(binding: DurableQuestionBinding): void {
		this.binding = binding;
		if (!binding.noUi) {
			for (const record of this.records()) {
				if (!record.result) this.present(record);
			}
		}
	}

	unbindTurn(turnId?: string): void {
		if (turnId && this.binding?.turnId !== turnId) return;
		this.binding = null;
	}

	async ask(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal,
	): Promise<QuestionBridgeResult> {
		const operationId = `ask_user_question:${this.sessionId}:${toolCallId}`;
		const hash = operationHash(operationId);
		let record = this.load(operationId);
		if (record && JSON.stringify(record.params) !== JSON.stringify(params)) {
			throw new Error("Durable question arguments changed for the same tool call");
		}
		record ??= {
			operationId,
			toolCallId,
			questionId: `durable-question-${hash}`,
			sessionId: this.sessionId,
			turnId: this.binding?.turnId ?? `durable-turn-${hash.slice(0, 24)}`,
			params,
			createdAt: new Date().toISOString(),
		};
		if (record.result) return record.result;
		if (this.binding?.noUi) {
			const result: QuestionBridgeResult = { answers: [], cancelled: true, error: "no_ui" };
			this.save({ ...record, result });
			return result;
		}
		this.save(record);
		if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Question wait aborted");
		return new Promise<QuestionBridgeResult>((resolve, reject) => {
			this.waiters.set(operationId, { resolve });
			signal.addEventListener("abort", () => {
				if (!this.waiters.delete(operationId)) return;
				reject(signal.reason instanceof Error ? signal.reason : new Error("Question wait aborted"));
			}, { once: true });
			// Register the waiter before exposing the card so even a synchronous
			// response resolves this execution instead of stranding it.
			this.present(record);
		});
	}

	respond(input: {
		turnId: string;
		questionId: string;
		result: QuestionBridgeResult;
	}): QuestionResponseStatus {
		const record = this.records().find((item) => item.questionId === input.questionId);
		if (!record) return "not_found";
		if (record.turnId !== input.turnId) return "scope_mismatch";
		if (record.result) return "already_resolved";
		const completed = { ...record, result: input.result };
		// Persistence precedes waiter release and the SSE resolved event.
		this.save(completed);
		this.binding?.emit?.({
			type: "question_resolved",
			questionId: record.questionId,
			cancelled: input.result.cancelled,
			...(input.result.error ? { error: input.result.error } : {}),
		});
		const waiter = this.waiters.get(record.operationId);
		if (waiter) {
			this.waiters.delete(record.operationId);
			waiter.resolve(input.result);
		}
		return "accepted";
	}

	pendingQuestion(): PersistedQuestion | undefined {
		const record = this.records().find((item) => !item.result);
		if (!record) return undefined;
		return {
			questionId: record.questionId,
			sessionId: record.sessionId,
			turnId: record.turnId,
			params: record.params,
			createdAt: record.createdAt,
		};
	}

	/** Delete completed answers only after the durable runtime proves this session
	 * has no live work that could replay the original ask_user_question call. */
	pruneCompletedForIdleSession(completedBefore: number): number {
		let removed = 0;
		for (const record of this.records()) {
			if (!record.result) continue;
			const path = this.path(record.operationId);
			if (statSync(path).mtimeMs > completedBefore) continue;
			rmSync(path, { force: true });
			removed += 1;
		}
		return removed;
	}

	/** Cancellation is an explicit terminal answer, not an abandoned wait: a
	 * later reopen must not resurrect a card for the aborted turn. */
	cancelTurn(turnId: string): number {
		let cancelled = 0;
		for (const record of this.records()) {
			if (record.result || record.turnId !== turnId) continue;
			if (this.respond({
				turnId,
				questionId: record.questionId,
				result: { answers: [], cancelled: true },
			}) === "accepted") cancelled += 1;
		}
		return cancelled;
	}
}

export interface DurableQuestionToolOptions {
	store: DurableQuestionStore;
	workspaceDir: string;
}

interface QuestionnaireSupport {
	parameters: ToolRegistration["parameters"];
	validate: (params: unknown) => { ok: boolean; error?: string; message?: string };
	buildResponse: (result: QuestionBridgeResult, params: unknown) => {
		content: Array<{ type: "text"; text: string }>;
		details: Record<string, unknown>;
	};
	buildError: (text: string, details: QuestionBridgeResult) => {
		content: Array<{ type: "text"; text: string }>;
		details: Record<string, unknown>;
	};
}

async function loadQuestionnaireSupport(): Promise<QuestionnaireSupport> {
	const { createJiti } = await import("jiti/static");
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const typesPath = resolvePluginFile(import.meta.url, "@juicesharp/rpiv-ask-user-question", "tool/types.ts");
	const envelopePath = resolvePluginFile(import.meta.url, "@juicesharp/rpiv-ask-user-question", "tool/response-envelope.ts");
	const validationPath = resolvePluginFile(import.meta.url, "@juicesharp/rpiv-ask-user-question", "tool/validate-questionnaire.ts");
	const types = await jiti.import(typesPath) as Record<string, unknown>;
	const envelope = await jiti.import(envelopePath) as Record<string, unknown>;
	const validation = await jiti.import(validationPath) as Record<string, unknown>;
	return {
		parameters: types.QuestionParamsSchema as ToolRegistration["parameters"],
		validate: validation.validateQuestionnaire as QuestionnaireSupport["validate"],
		buildResponse: envelope.buildQuestionnaireResponse as QuestionnaireSupport["buildResponse"],
		buildError: envelope.buildToolResult as QuestionnaireSupport["buildError"],
	};
}

/** Replay-safe re-entry presents the same persisted question after reopen. A
 * completed response returns from disk without waiting for another answer. */
export async function createDurableQuestionRegistrations(
	options: DurableQuestionToolOptions,
): Promise<ToolRegistration[]> {
	const support = await loadQuestionnaireSupport();
	const tool = defineTool({
		name: "ask_user_question",
		description: "Ask the user one or more questions with predefined options. Supports single-select, multi-select, free text input, and option previews.",
		parameters: support.parameters,
		executionMode: "sequential",
		replay: "safe",
		async execute(params, api, context) {
			const validation = support.validate(params);
			if (!validation.ok) {
				const result = support.buildError(validation.message ?? "Invalid questionnaire", {
					answers: [], cancelled: true, ...(validation.error ? { error: validation.error } : {}),
				});
				return { output: result.content, details: result.details as JsonValue };
			}
			const answer = await options.store.ask(api.callId, params, context.abortSignal ?? new AbortController().signal);
			const result = support.buildResponse(answer, params);
			return { output: result.content, details: result.details as JsonValue };
		},
	});
	return [tool];
}
