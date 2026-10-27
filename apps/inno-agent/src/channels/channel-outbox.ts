import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, writeJson } from "../storage/file-store.js";
import type { ChannelName } from "./types.js";

export interface ChannelOutboxCompletion {
	text: string;
	details: Record<string, unknown>;
}

export interface ChannelOutboxRecord {
	operationId: string;
	channel: ChannelName;
	chatId: string;
	filePath: string;
	fileName?: string;
	completion?: ChannelOutboxCompletion;
}

function basePath(outboxDir: string, operationId: string): string {
	return join(outboxDir, createHash("sha256").update(operationId).digest("hex"));
}

export function channelOutboxPayloadPath(outboxDir: string, operationId: string): string {
	return `${basePath(outboxDir, operationId)}.payload`;
}

export function loadChannelOutbox(outboxDir: string, operationId: string): ChannelOutboxRecord | undefined {
	const path = `${basePath(outboxDir, operationId)}.json`;
	if (!existsSync(path)) return undefined;
	const record = JSON.parse(readFileSync(path, "utf-8")) as ChannelOutboxRecord;
	if (record.operationId !== operationId || !record.channel || !record.chatId || !record.filePath) {
		throw new Error("Channel outbox record does not match the durable tool call");
	}
	return record;
}

/** Snapshot the payload before committing the send intent. Recovery therefore
 * never depends on the original workspace file remaining unchanged. */
export function prepareChannelOutbox(
	outboxDir: string,
	record: ChannelOutboxRecord,
	sourceFilePath: string,
): string {
	ensureDir(outboxDir);
	const payloadPath = channelOutboxPayloadPath(outboxDir, record.operationId);
	const temporaryPayload = `${payloadPath}.tmp`;
	copyFileSync(sourceFilePath, temporaryPayload);
	renameSync(temporaryPayload, payloadPath);
	writeJson(`${basePath(outboxDir, record.operationId)}.json`, record);
	return payloadPath;
}

export function completeChannelOutbox(
	outboxDir: string,
	record: ChannelOutboxRecord,
	completion: ChannelOutboxCompletion,
): void {
	writeJson(`${basePath(outboxDir, record.operationId)}.json`, { ...record, completion });
}

function removeOutboxFiles(outboxDir: string, operationId: string): void {
	// Payload first: a crash can leave the completion JSON behind, but a completed
	// retry reads that JSON before touching the payload. A later cleanup retries it.
	rmSync(channelOutboxPayloadPath(outboxDir, operationId), { force: true });
	rmSync(`${basePath(outboxDir, operationId)}.json`, { force: true });
}

/** Delete this session's expired completions only after its durable runtime has
 * proved there is no live work that could replay the corresponding tool call. */
export function pruneCompletedChannelOutboxForIdleSession(
	outboxDir: string,
	sessionId: string,
	completedBefore: number,
): number {
	if (!existsSync(outboxDir)) return 0;
	const prefix = `send_file_to_channel:${sessionId}:`;
	let removed = 0;
	for (const file of readdirSync(outboxDir)) {
		const path = join(outboxDir, file);
		try {
			if (!file.endsWith(".json")) {
				// A crash can leave a temporary/orphan payload without a record. Pending
				// operations always have their JSON and are never treated as orphans.
				const recordPath = file.endsWith(".payload") ? `${path.slice(0, -".payload".length)}.json` : "";
				if ((file.endsWith(".tmp") || recordPath && !existsSync(recordPath)) && statSync(path).mtimeMs <= completedBefore) {
					rmSync(path, { force: true });
				}
				continue;
			}
			const record = JSON.parse(readFileSync(path, "utf-8")) as ChannelOutboxRecord;
			if (!record.completion || !record.operationId.startsWith(prefix) || statSync(path).mtimeMs > completedBefore) continue;
			removeOutboxFiles(outboxDir, record.operationId);
			removed += 1;
		} catch {
			// Retention is best-effort. Keep unreadable records for recovery/inspection.
		}
	}
	return removed;
}

/** Session deletion destroys the only conversation that could replay these
 * operations, so all of its outbox state can be removed regardless of status. */
export function deleteChannelOutboxForSession(outboxDir: string, sessionId: string): number {
	if (!existsSync(outboxDir)) return 0;
	const prefix = `send_file_to_channel:${sessionId}:`;
	let removed = 0;
	for (const file of readdirSync(outboxDir)) {
		if (!file.endsWith(".json")) continue;
		try {
			const record = JSON.parse(readFileSync(join(outboxDir, file), "utf-8")) as ChannelOutboxRecord;
			if (!record.operationId.startsWith(prefix)) continue;
			removeOutboxFiles(outboxDir, record.operationId);
			removed += 1;
		} catch {
			// Unknown/malformed files are not attributed to a session by filename.
		}
	}
	return removed;
}
