import { readJson, writeJson } from "../storage/file-store.js";
import type { ChatAttachments } from "./attachments.js";
import type { SessionMessageSummary } from "./session-model.js";

/**
 * Sidecar persistence for chat attachment metadata.
 *
 * The PI SDK owns the session JSONL and only stores the user's raw prompt, so
 * bubble bindings / loose attachments are kept in a sidecar JSON keyed by
 * session file. Entries are recorded when a chat turn is accepted and merged
 * back into the message list served by GET /api/sessions/:id, matched FIFO by
 * prompt content (the SDK persists the prompt verbatim, so content equality is
 * a stable join key; repeated identical prompts consume entries in order).
 */

export interface SessionAttachmentEntry {
	promptContent: string;
	attachments?: ChatAttachments;
	/** Durable inline images restored as workspace previews, including for
	 * text-only models whose committed model input omits native image blocks. */
	images?: Array<{ mimeType: string; workspacePath: string }>;
	timestamp: number;
	/** Workspace that contained the attached files when the turn was accepted. */
	workspaceId?: string;
	/** Durable request ID deduplicates sidecar metadata on HTTP retries. */
	requestId?: string;
}

export type SessionAttachmentsMetadata = Record<string, SessionAttachmentEntry[]>;

// In-memory cache is scoped by tenant/local data root. Keeping only the
// metadata would let one tenant's sidecar satisfy another tenant's reads.
let cache: { dataDir: string; metadata: SessionAttachmentsMetadata } | null = null;

function read(dataDir: string): SessionAttachmentsMetadata {
	if (!cache || cache.dataDir !== dataDir) {
		cache = { dataDir, metadata: readJson<SessionAttachmentsMetadata>(attachmentsMetadataPath(dataDir), {}) };
	}
	return cache.metadata;
}

function write(dataDir: string, meta: SessionAttachmentsMetadata): void {
	cache = { dataDir, metadata: meta };
	writeJson(attachmentsMetadataPath(dataDir), meta);
}

export function attachmentsMetadataPath(dataDir: string): string {
	return `${dataDir}/sessions/attachments.json`.replaceAll("\\", "/");
}

export function resetAttachmentsStoreForTests(): void {
	cache = null;
}

/** Record the attachment metadata for one accepted chat turn. */
export function recordSessionAttachments(
	dataDir: string,
	sessionId: string,
	entry: SessionAttachmentEntry,
): void {
	const meta = { ...read(dataDir) };
	const existing = meta[sessionId] ?? [];
	if (entry.requestId && existing.some((candidate) => candidate.requestId === entry.requestId)) return;
	meta[sessionId] = [...existing, entry];
	write(dataDir, meta);
}

/** Drop all attachment metadata for a deleted session. */
export function clearSessionAttachments(dataDir: string, sessionId: string): void {
	const meta = read(dataDir);
	if (!(sessionId in meta)) return;
	const next = { ...meta };
	delete next[sessionId];
	write(dataDir, next);
}

/**
 * Merge recorded attachment metadata into a session's user messages. Each
 * pending entry attaches to the first not-yet-matched user message whose
 * content equals the recorded prompt. Messages without a match pass through
 * untouched, so sessions without attachments are zero-cost.
 */
export function mergeSessionAttachments(
	dataDir: string,
	sessionId: string,
	messages: SessionMessageSummary[],
): SessionMessageSummary[] {
	const entries = read(dataDir)[sessionId];
	if (!entries || entries.length === 0) return messages;
	const pending = [...entries];
	return messages.map((message) => {
		if (message.role !== "user" || pending.length === 0) return message;
		const index = pending.findIndex((entry) => entry.promptContent === message.content);
		if (index === -1) return message;
		const [entry] = pending.splice(index, 1);
		return {
			...message,
			...(entry.attachments ? { attachments: entry.attachments } : {}),
			...(entry.images?.length && entry.workspaceId ? {
				images: entry.images.map((image) => ({
					mimeType: image.mimeType,
					previewUrl: `/api/workspace/raw?workspaceId=${encodeURIComponent(entry.workspaceId!)}&path=${encodeURIComponent(image.workspacePath)}`,
				})),
			} : {}),
		};
	});
}
