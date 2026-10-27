import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync } from "node:fs";
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
