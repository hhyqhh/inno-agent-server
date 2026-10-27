import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SubmissionId, UserInput } from "@earendil-works/pi-durable";
import {
	snapshotStreamState,
	type SessionStreamState,
	type StreamEventEnvelope,
	type StreamStateSnapshot,
} from "../chat/stream-registry.js";
import { logger } from "../logger.js";

const DURABLE_ID_PATTERN = /^durable-[0-9a-f-]{36}$/;
const TURN_ID_PATTERN = /^[0-9a-f-]{36}$/;
const TERMINAL_TYPES = new Set(["done", "error", "aborted"]);
const TERMINAL_RETENTION_MS = 300_000;

interface TurnRecord {
	kind: "turn";
	state: StreamStateSnapshot;
	input: UserInput;
}

interface EventRecord {
	kind: "event";
	envelope: StreamEventEnvelope;
}

interface AdmittedRecord {
	kind: "admitted";
	submissionId: SubmissionId;
}

interface CancelledRecord {
	kind: "cancelled";
}

type JournalRecord = TurnRecord | EventRecord | AdmittedRecord | CancelledRecord;

export interface RestoredDurableStream {
	snapshot: StreamStateSnapshot;
	history: StreamEventEnvelope[];
	input: UserInput;
	submissionId?: SubmissionId;
	cancelRequested: boolean;
	terminal: boolean;
}

function validIds(sessionId: string, turnId?: string): boolean {
	return DURABLE_ID_PATTERN.test(sessionId) && (!turnId || TURN_ID_PATTERN.test(turnId));
}

/** Tenant-local application event journal. pi-durable owns execution recovery;
 * this log owns Inno's numeric SSE envelopes and original submission intent. */
export class DurableStreamStore {
	constructor(private readonly root: string) {}

	private sessionDir(sessionId: string): string {
		if (!validIds(sessionId)) throw new Error("Invalid durable session ID");
		return join(this.root, sessionId);
	}

	private path(sessionId: string, turnId: string): string {
		if (!validIds(sessionId, turnId)) throw new Error("Invalid durable stream identity");
		return join(this.sessionDir(sessionId), `${turnId}.jsonl`);
	}

	create(state: SessionStreamState, input: UserInput): void {
		const path = this.path(state.sessionId, state.turnId);
		mkdirSync(this.sessionDir(state.sessionId), { recursive: true, mode: 0o700 });
		const header: TurnRecord = { kind: "turn", state: snapshotStreamState(state), input };
		// wx prevents a client-supplied turn identity from ever overwriting a log.
		writeFileSync(path, `${JSON.stringify(header)}\n`, { encoding: "utf-8", flag: "wx", mode: 0o600 });
	}

	append(envelope: StreamEventEnvelope): void {
		const record: EventRecord = { kind: "event", envelope };
		this.appendRecord(envelope.sessionId, envelope.turnId, record, false);
	}

	markAdmitted(sessionId: string, turnId: string, submissionId: SubmissionId): void {
		this.appendRecord(sessionId, turnId, { kind: "admitted", submissionId }, true);
	}

	markCancelled(sessionId: string, turnId: string): void {
		this.appendRecord(sessionId, turnId, { kind: "cancelled" }, true);
	}

	private appendRecord(sessionId: string, turnId: string, record: JournalRecord, required: boolean): void {
		try {
			appendFileSync(this.path(sessionId, turnId), `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
		} catch (error) {
			if (required) throw error;
			// Observability/disk failures must not turn an otherwise healthy model
			// run into a failed chat response. Such a journal may not be restorable.
			logger.error({ err: error, sessionId, turnId }, "durable SSE journal append failed");
		}
	}

	load(sessionId: string, turnId: string): RestoredDurableStream | undefined {
		if (!validIds(sessionId, turnId)) return undefined;
		return this.read(this.path(sessionId, turnId));
	}

	latest(sessionId: string): RestoredDurableStream | undefined {
		if (!validIds(sessionId)) return undefined;
		let names: string[];
		try {
			names = readdirSync(this.sessionDir(sessionId));
		} catch {
			return undefined;
		}
		const streams = names
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => this.load(sessionId, name.slice(0, -6)))
			.filter((stream): stream is RestoredDurableStream => Boolean(stream))
			.sort((a, b) => Date.parse(b.snapshot.createdAt) - Date.parse(a.snapshot.createdAt));
		return streams[0];
	}

	deleteSession(sessionId: string): void {
		rmSync(this.sessionDir(sessionId), { recursive: true, force: true });
	}

	private read(path: string): RestoredDurableStream | undefined {
		let text: string;
		try {
			text = readFileSync(path, "utf-8");
		} catch {
			return undefined;
		}
		const lines = text.split("\n");
		// A process crash may leave only the final append partially visible.
		// Earlier committed records remain usable; an earlier malformed line is not.
		if (lines.at(-1) === "") lines.pop();
		let header: TurnRecord | undefined;
		const history: StreamEventEnvelope[] = [];
		let submissionId: SubmissionId | undefined;
		let cancelRequested = false;
		let terminal = false;
		for (let index = 0; index < lines.length; index++) {
			let record: JournalRecord;
			try {
				record = JSON.parse(lines[index]!) as JournalRecord;
			} catch (error) {
				if (index === lines.length - 1) break;
				logger.error({ err: error, path, line: index + 1 }, "invalid durable SSE journal record");
				return undefined;
			}
			if (index === 0) {
				if (record.kind !== "turn") return undefined;
				header = record;
				continue;
			}
			if (!header) return undefined;
			if (record.kind === "event") {
				history.push(record.envelope);
				if (TERMINAL_TYPES.has(record.envelope.event.type)) terminal = true;
			} else if (record.kind === "admitted" && typeof record.submissionId === "number") {
				submissionId = record.submissionId;
			} else if (record.kind === "cancelled") {
				cancelRequested = true;
			}
		}
		if (!header) return undefined;
		if (terminal) {
			const finishedAt = Date.parse(history.at(-1)?.occurredAt ?? "");
			if (Number.isFinite(finishedAt) && Date.now() - finishedAt >= TERMINAL_RETENTION_MS) {
				rmSync(path, { force: true });
				return undefined;
			}
		}
		return {
			snapshot: header.state,
			history,
			input: header.input,
			...(submissionId !== undefined ? { submissionId } : {}),
			cancelRequested,
			terminal,
		};
	}
}
