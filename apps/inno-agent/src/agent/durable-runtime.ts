import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	Harness,
	watchEvents,
	type AgentEvent,
	type AgentEventStream,
	type Conversation,
	type ModelRef,
	type Registry,
	type SettledSubmissionRecord,
	type SnapshotEvent,
	type SubmissionId,
	type ToolRegistration,
	type UserInput,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { pruneCompletedChannelOutboxForIdleSession } from "../channels/channel-outbox.js";
import { logger } from "../logger.js";
import { WorkspaceReadOnlyEnv } from "./durable-env.js";
import { withNativeImageFallback } from "./native-image-fallback.js";
import { createDurableChannelRegistrations, type DurableChannelToolOptions } from "./durable-channels.js";
import { createDurableMemoryRegistrations, type DurableMemoryToolOptions } from "./durable-memory.js";
import { createDurableOcrRegistrations, type DurableOcrToolOptions } from "./durable-ocr.js";
import {
	createDurableQuestionRegistrations,
	type DurableQuestionBinding,
	type DurableQuestionStore,
	type DurableQuestionToolOptions,
} from "./durable-questions.js";

const READ_ONLY_EXTENSION_NAME = "inno.read-only";
const MEMORY_EXTENSION_NAME = "inno.memory";
const OCR_EXTENSION_NAME = "inno.ocr";
const CHANNEL_EXTENSION_NAME = "inno.channels";
const QUESTION_EXTENSION_NAME = "inno.questions";
export const DURABLE_RECOVERY_RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Durable SQLite is single-owner. This guard covers accidental double-open in
 * one process; deployment routing must still prevent cross-process owners. */
const openStoragePaths = new Set<string>();

export class DurableStorageOwnerError extends Error {
	constructor(readonly storagePath: string) {
		super(`Durable storage already has an open owner: ${storagePath}`);
		this.name = "DurableStorageOwnerError";
	}
}

export interface DurableSessionRuntimeOptions {
	storagePath: string;
	models: Models;
	model: ModelRef;
	instructions?: string;
	workspaceDir?: string;
	/** The only optional built-in tool in this slice. No shell or mutations. */
	readOnlyTools?: boolean;
	/** Tenant-local, replay-safe L1/L2 tools. Workspace writes remain disabled. */
	memory?: DurableMemoryToolOptions;
	/** Remote OCR recovery checkpoints; submission remains at-least-once. */
	ocr?: DurableOcrToolOptions;
	/** Persistent file-delivery outbox; external sends remain at-least-once. */
	channels?: DurableChannelToolOptions;
	/** Restart-safe web questions; accepted answers persist before resumption. */
	questions?: DurableQuestionToolOptions;
	/** Completed recovery-record retention; cleanup runs only with no live work. */
	recoveryRetentionMs?: number;
	registry?: Registry;
}

export interface DurableSubmission {
	id: SubmissionId;
}

export type DurableSubmissionResult = {
	id: SubmissionId;
	status: "done";
	answer: AssistantMessage;
	text: string;
} | {
	id: SubmissionId;
	status: "unanswered";
	reason: string;
	detail?: SettledSubmissionRecord["detail"];
};

function textFromAssistant(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function createSessionRegistry(
	readOnlyTools: boolean,
	memory?: DurableMemoryToolOptions,
	ocr?: DurableOcrToolOptions,
	channels?: DurableChannelToolOptions,
	questionTools: ToolRegistration[] = [],
): Registry {
	const registry = createRegistry();
	if (readOnlyTools) {
		registry.install(defineExtension({
			name: READ_ONLY_EXTENSION_NAME,
			tools: [createReadTool()],
		}));
	}
	if (memory) {
		registry.install(defineExtension({
			name: MEMORY_EXTENSION_NAME,
			tools: createDurableMemoryRegistrations(memory),
		}));
	}
	if (ocr) {
		registry.install(defineExtension({
			name: OCR_EXTENSION_NAME,
			tools: createDurableOcrRegistrations(ocr),
		}));
	}
	if (channels) {
		registry.install(defineExtension({
			name: CHANNEL_EXTENSION_NAME,
			tools: createDurableChannelRegistrations(channels),
		}));
	}
	if (questionTools.length > 0) {
		registry.install(defineExtension({
			name: QUESTION_EXTENSION_NAME,
			tools: questionTools,
		}));
	}
	return registry;
}

/**
 * Narrow pi-durable host used by new opt-in sessions. It deliberately does not
 * implement or imitate PI SessionManager JSONL storage.
 */
export class DurableSessionRuntime {
	private constructor(
		readonly storagePath: string,
		private readonly harness: Harness,
		private readonly rootConversation: Conversation,
		private readonly ownsStoragePath: string,
		private readonly questions?: DurableQuestionStore,
	) {}

	static async open(options: DurableSessionRuntimeOptions): Promise<DurableSessionRuntime> {
		const requestedPath = resolve(options.storagePath);
		await mkdir(dirname(requestedPath), { recursive: true });
		const storagePath = await realpath(requestedPath).catch(async () =>
			join(await realpath(dirname(requestedPath)), basename(requestedPath)));
		if (openStoragePaths.has(storagePath)) throw new DurableStorageOwnerError(storagePath);
		openStoragePaths.add(storagePath);
		try {
			const readOnlyTools = options.readOnlyTools === true;
			const questionTools = options.questions
				? await createDurableQuestionRegistrations(options.questions)
				: [];
			const registry = options.registry ?? createSessionRegistry(readOnlyTools, options.memory, options.ocr, options.channels, questionTools);
			const memoryTools = options.memory ? createDurableMemoryRegistrations(options.memory) : [];
			const ocrTools = options.ocr ? createDurableOcrRegistrations(options.ocr) : [];
			const channelTools = options.channels ? createDurableChannelRegistrations(options.channels) : [];
			const tools = [...memoryTools, ...ocrTools, ...channelTools, ...questionTools];
			const harness = await Harness.open(
				await openNodeSqliteStorage(storagePath),
				{
					models: withNativeImageFallback(options.models),
					registry,
					env: options.workspaceDir
						? () => new WorkspaceReadOnlyEnv(options.workspaceDir!)
						: undefined,
				},
				BACKGROUND_CONTEXT,
			);
			try {
				const rootConversation = await harness.root(BACKGROUND_CONTEXT, {
					agent: {
						model: options.model,
						instructions: options.instructions,
						cwd: options.workspaceDir,
						...(readOnlyTools ? { tools: [createReadTool(), ...tools] } : { tools }),
					},
				});
				const inspection = await harness.inspect(BACKGROUND_CONTEXT);
				if (inspection.tasks.length === 0 && inspection.submissions.length === 0) {
					const retentionMs = Math.max(0, options.recoveryRetentionMs ?? DURABLE_RECOVERY_RECORD_RETENTION_MS);
					const completedBefore = Date.now() - retentionMs;
					try {
						if (options.channels) {
							pruneCompletedChannelOutboxForIdleSession(options.channels.outboxDir, options.channels.sessionId, completedBefore);
						}
						options.questions?.store.pruneCompletedForIdleSession(completedBefore);
					} catch (error) {
						// Cleanup must never prevent an otherwise recoverable session opening.
						logger.warn({ err: error, storagePath }, "durable recovery-record retention failed (non-fatal)");
					}
				}
				harness.resume();
				return new DurableSessionRuntime(storagePath, harness, rootConversation, storagePath, options.questions?.store);
			} catch (error) {
				await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
				throw error;
			}
		} catch (error) {
			openStoragePaths.delete(storagePath);
			throw error;
		}
	}

	/** Admission is committed before this resolves. Reusing requestId in the same
	 * conversation returns the original durable submission. */
	async submit(content: UserInput, requestId: string): Promise<DurableSubmission> {
		if (!requestId.trim()) throw new Error("A durable requestId is required");
		const submission = await this.rootConversation.submit({
			type: "input",
			content,
			requestId,
		}, BACKGROUND_CONTEXT);
		return { id: submission.id };
	}

	async waitForSubmission(id: SubmissionId, context: Context = BACKGROUND_CONTEXT): Promise<DurableSubmissionResult> {
		const submission = await this.harness.submission(id, context);
		if (!submission) throw new Error(`Durable submission not found: ${id}`);
		const settled = await submission.wait(context);
		if (settled.status === "unanswered") {
			return {
				id,
				status: "unanswered",
				reason: settled.reason,
				...(settled.detail !== undefined ? { detail: settled.detail } : {}),
			};
		}
		if (settled.type !== "input") throw new Error(`Unexpected durable submission type: ${settled.type}`);
		const entry = await this.rootConversation.commit(
			(tx) => tx.entry(AssistantEntry, settled.answer),
			context,
		);
		const answer = entry?.model?.[0];
		if (!answer || answer.role !== "assistant") {
			throw new Error(`Durable answer entry is missing its assistant message: ${settled.answer}`);
		}
		return { id, status: "done", answer, text: textFromAssistant(answer) };
	}

	bindQuestionTurn(binding: DurableQuestionBinding): void {
		this.questions?.bindTurn(binding);
	}

	unbindQuestionTurn(turnId?: string): void {
		this.questions?.unbindTurn(turnId);
	}

	async waitForIdle(context: Context = BACKGROUND_CONTEXT): Promise<void> {
		await this.rootConversation.waitForIdle(context);
	}

	/** Persist the abort marks and wait for the ordinary run/tool scope to become
	 * idle. Reopening the storage will not resume this aborted submission. */
	async abort(context: Context = BACKGROUND_CONTEXT): Promise<void> {
		await this.rootConversation.abort(context);
	}

	async snapshot(): Promise<SnapshotEvent> {
		const stream = await watchEvents(this.harness, this.rootConversation.id, BACKGROUND_CONTEXT);
		try {
			return stream.snapshot;
		} finally {
			await stream.stop();
		}
	}

	async watch(listener: (events: readonly AgentEvent[]) => Promise<void>): Promise<AgentEventStream> {
		const stream = await watchEvents(this.harness, this.rootConversation.id, BACKGROUND_CONTEXT);
		stream.start(async (events) => listener(events));
		return stream;
	}

	async close(): Promise<void> {
		try {
			this.questions?.unbindTurn();
			await this.harness.close(BACKGROUND_CONTEXT);
		} finally {
			openStoragePaths.delete(this.ownsStoragePath);
		}
	}
}
