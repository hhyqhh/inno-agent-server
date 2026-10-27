import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { InnoConfig } from "../config.js";
import { readJson, writeJson } from "../storage/file-store.js";
import { resolveCurrentTenantConfig } from "../tenants/config.js";
import { resolveRequestTenantDataRoot } from "../tenants/paths.js";
import type { SessionSummary } from "../server/session-model.js";
import { createConfiguredDurableModels } from "./durable-models.js";
import { buildDurableInstructions } from "./durable-memory.js";
import { durableEntriesToMessages } from "./durable-projection.js";
import { DurableSessionRuntime } from "./durable-runtime.js";
import { INNO_SYSTEM_PROMPT } from "./system-prompt.js";

const DURABLE_ID_PATTERN = /^durable-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface DurableSessionRecord {
	id: string;
	workspaceId: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	preview: string;
	provider: string;
	modelId: string;
	archived: boolean;
}

export interface DurableSessionSummary extends SessionSummary {
	runtime: "durable";
	archived: boolean;
}

export interface DurableSessionLease {
	runtime: DurableSessionRuntime;
	release(): Promise<void>;
}

interface RuntimeEntry {
	runtime: DurableSessionRuntime;
	references: number;
}

export interface DurableSessionServiceOptions {
	dataDir: string;
	getLocalConfig: () => InnoConfig;
	enabled: boolean;
	resolveWorkspaceDir: (sessionId: string, fallbackWorkspaceId: string) => string | undefined;
	openRuntime?: typeof DurableSessionRuntime.open;
}

export class DurableRuntimeDisabledError extends Error {
	constructor() {
		super("Durable sessions are disabled. Set INNO_DURABLE_ENABLED=true to enable explicit opt-in.");
		this.name = "DurableRuntimeDisabledError";
	}
}

export class DurableSessionBusyError extends Error {
	constructor() {
		super("Durable session still has an active operation");
		this.name = "DurableSessionBusyError";
	}
}

function isRecord(value: unknown): value is DurableSessionRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<DurableSessionRecord>;
	return typeof record.id === "string" && DURABLE_ID_PATTERN.test(record.id)
		&& typeof record.workspaceId === "string" && typeof record.name === "string"
		&& typeof record.createdAt === "string" && typeof record.updatedAt === "string"
		&& typeof record.messageCount === "number" && typeof record.preview === "string"
		&& typeof record.provider === "string" && typeof record.modelId === "string"
		&& typeof record.archived === "boolean";
}

function toSummary(record: DurableSessionRecord): DurableSessionSummary {
	return {
		id: record.id,
		name: record.name,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		messageCount: record.messageCount,
		preview: record.preview,
		channels: ["web"],
		origin: "web",
		hasTopic: record.name !== "新对话",
		runtime: "durable",
		archived: record.archived,
	};
}

/** Application catalog and owner for opt-in durable Web sessions. The catalog is
 * tenant-rooted metadata; committed conversation history stays in pi-durable
 * SQLite and is never represented as a legacy SessionManager JSONL file. */
export class DurableSessionService {
	private readonly runtimes = new Map<string, RuntimeEntry>();
	private readonly openings = new Map<string, Promise<DurableSessionRuntime>>();
	private readonly openRuntime: typeof DurableSessionRuntime.open;
	private closing = false;

	constructor(private readonly options: DurableSessionServiceOptions) {
		this.openRuntime = options.openRuntime ?? DurableSessionRuntime.open;
	}

	get enabled(): boolean { return this.options.enabled; }

	private root(req: IncomingMessage): string {
		return join(resolveRequestTenantDataRoot(req, this.options.dataDir), "durable");
	}

	private catalogPath(req: IncomingMessage): string {
		return join(this.root(req), "sessions.json");
	}

	private storagePath(req: IncomingMessage, id: string): string {
		return join(this.root(req), "storage", id, "session.sqlite");
	}

	private runtimeKey(req: IncomingMessage, id: string): string {
		return join(this.root(req), "storage", id);
	}

	private catalog(req: IncomingMessage): DurableSessionRecord[] {
		const value = readJson<unknown>(this.catalogPath(req), []);
		return Array.isArray(value) ? value.filter(isRecord) : [];
	}

	private writeCatalog(req: IncomingMessage, records: DurableSessionRecord[]): void {
		writeJson(this.catalogPath(req), records);
	}

	get(req: IncomingMessage, id: string): DurableSessionRecord | undefined {
		if (!DURABLE_ID_PATTERN.test(id)) return undefined;
		return this.catalog(req).find((record) => record.id === id);
	}

	list(req: IncomingMessage): DurableSessionSummary[] {
		return this.catalog(req).map(toSummary)
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
	}

	create(req: IncomingMessage, input: { workspaceId: string }): DurableSessionSummary {
		if (!this.options.enabled) throw new DurableRuntimeDisabledError();
		if (this.closing) throw new Error("Durable session service is shutting down");
		const config = resolveCurrentTenantConfig(this.options.dataDir, this.options.getLocalConfig());
		if (!config.defaultProvider || !config.defaultModel) {
			throw new Error("Configure a provider and default model before creating a durable session");
		}
		// Validate the selected model now, without opening a network connection.
		const provider = config.providers[config.defaultProvider];
		if (!provider?.models.some((model) => model.id === config.defaultModel)) {
			throw new Error(`Configured durable model not found: ${config.defaultProvider}/${config.defaultModel}`);
		}
		const now = new Date().toISOString();
		const record: DurableSessionRecord = {
			id: `durable-${randomUUID()}`,
			workspaceId: input.workspaceId,
			name: "新对话",
			createdAt: now,
			updatedAt: now,
			messageCount: 0,
			preview: "",
			provider: config.defaultProvider,
			modelId: config.defaultModel,
			archived: false,
		};
		this.writeCatalog(req, [...this.catalog(req), record]);
		return toSummary(record);
	}

	private update(req: IncomingMessage, id: string, update: Partial<DurableSessionRecord>): DurableSessionRecord {
		const records = this.catalog(req);
		const index = records.findIndex((record) => record.id === id);
		if (index < 0) throw new Error("Durable session not found");
		const next = { ...records[index]!, ...update };
		records[index] = next;
		this.writeCatalog(req, records);
		return next;
	}

	rename(req: IncomingMessage, id: string, name: string): DurableSessionSummary {
		return toSummary(this.update(req, id, { name, updatedAt: new Date().toISOString() }));
	}

	setArchived(req: IncomingMessage, id: string, archived: boolean): DurableSessionSummary {
		return toSummary(this.update(req, id, { archived, updatedAt: new Date().toISOString() }));
	}

	noteSubmission(req: IncomingMessage, id: string, prompt: string): void {
		const record = this.get(req, id);
		if (!record) throw new Error("Durable session not found");
		this.update(req, id, {
			preview: prompt.trim().slice(0, 200),
			name: record.name === "新对话" ? prompt.trim().slice(0, 80) || record.name : record.name,
			updatedAt: new Date().toISOString(),
		});
	}

	async snapshot(req: IncomingMessage, id: string): Promise<{ summary: DurableSessionSummary; messages: ReturnType<typeof durableEntriesToMessages>; revision: string }> {
		const lease = await this.lease(req, id);
		try {
			const snapshot = await lease.runtime.snapshot();
			const messages = durableEntriesToMessages(snapshot.entries);
			const record = this.get(req, id);
			if (!record) throw new Error("Durable session not found");
			const lastMessageAt = messages.at(-1)?.timestamp;
			const updatedAt = lastMessageAt && lastMessageAt > Date.parse(record.updatedAt)
				? new Date(lastMessageAt).toISOString()
				: record.updatedAt;
			const next = this.update(req, id, { messageCount: messages.length, updatedAt });
			const lastEntryId = snapshot.entries.at(-1)?.id ?? 0;
			return { summary: toSummary(next), messages, revision: `durable:${lastEntryId}` };
		} finally {
			await lease.release();
		}
	}

	async lease(req: IncomingMessage, id: string): Promise<DurableSessionLease> {
		if (!this.options.enabled) throw new DurableRuntimeDisabledError();
		if (this.closing) throw new Error("Durable session service is shutting down");
		const record = this.get(req, id);
		if (!record) throw new Error("Durable session not found");
		const key = this.runtimeKey(req, id);
		let entry = this.runtimes.get(key);
		if (!entry) {
			let opening = this.openings.get(key);
			if (!opening) {
				opening = (async () => {
					const config = resolveCurrentTenantConfig(this.options.dataDir, this.options.getLocalConfig());
					const selection = await createConfiguredDurableModels(config, {
						provider: record.provider,
						modelId: record.modelId,
					});
					const workspaceDir = this.options.resolveWorkspaceDir(id, record.workspaceId);
					if (!workspaceDir) throw new Error(`Durable session workspace not found: ${record.workspaceId}`);
					const tenantDataRoot = resolveRequestTenantDataRoot(req, this.options.dataDir);
					const memory = {
						sessionId: id,
						learnerDataDir: join(tenantDataRoot, "learner"),
						l2DataDir: join(tenantDataRoot, "l2"),
						workspaceDir,
						l1Enabled: config.memory?.l1Enabled !== false,
						l2Enabled: config.memory?.l2Enabled !== false,
					};
					return this.openRuntime({
						storagePath: this.storagePath(req, id),
						...selection,
						instructions: buildDurableInstructions(INNO_SYSTEM_PROMPT, memory),
						workspaceDir,
						readOnlyTools: true,
						memory,
					});
				})();
				this.openings.set(key, opening);
			}
			try {
				const runtime = await opening;
				entry = this.runtimes.get(key) ?? { runtime, references: 0 };
				this.runtimes.set(key, entry);
			} finally {
				this.openings.delete(key);
			}
		}
		entry.references += 1;
		let released = false;
		return {
			runtime: entry.runtime,
			release: async () => {
				if (released) return;
				released = true;
				const current = this.runtimes.get(key);
				if (!current) return;
				current.references -= 1;
				if (current.references <= 0) {
					this.runtimes.delete(key);
					await current.runtime.close();
				}
			},
		};
	}

	async delete(req: IncomingMessage, id: string): Promise<void> {
		const key = this.runtimeKey(req, id);
		if (this.openings.has(key) || (this.runtimes.get(key)?.references ?? 0) > 0) {
			throw new DurableSessionBusyError();
		}
		const entry = this.runtimes.get(key);
		if (entry) {
			this.runtimes.delete(key);
			await entry.runtime.close();
		}
		this.writeCatalog(req, this.catalog(req).filter((record) => record.id !== id));
		await rm(join(this.root(req), "storage", id), { recursive: true, force: true });
	}

	async close(): Promise<void> {
		this.closing = true;
		await Promise.all([...this.openings.values()].map((opening) => opening.catch(() => undefined)));
		const entries = [...this.runtimes.values()];
		this.runtimes.clear();
		this.openings.clear();
		await Promise.all(entries.map((entry) => entry.runtime.close().catch(() => undefined)));
	}
}
