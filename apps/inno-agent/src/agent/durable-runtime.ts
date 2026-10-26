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
	type UserInput,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { WorkspaceReadOnlyEnv } from "./durable-env.js";

const READ_ONLY_EXTENSION_NAME = "inno.read-only";

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

function createSessionRegistry(readOnlyTools: boolean): Registry {
	const registry = createRegistry();
	if (readOnlyTools) {
		registry.install(defineExtension({
			name: READ_ONLY_EXTENSION_NAME,
			tools: [createReadTool()],
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
			const registry = options.registry ?? createSessionRegistry(readOnlyTools);
			const harness = await Harness.open(
				await openNodeSqliteStorage(storagePath),
				{
					models: options.models,
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
						...(readOnlyTools ? { tools: [createReadTool()] } : { tools: [] }),
					},
				});
				harness.resume();
				return new DurableSessionRuntime(storagePath, harness, rootConversation, storagePath);
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
			await this.harness.close(BACKGROUND_CONTEXT);
		} finally {
			openStoragePaths.delete(this.ownsStoragePath);
		}
	}
}
