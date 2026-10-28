import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { writeJson } from "../storage/file-store.js";
import type {
	AuthorizerVerdict,
	PermissionDecision,
	PermissionResponseStatus,
} from "./permission-bridge.js";

export interface DurablePermissionBinding {
	turnId: string;
	emit?: (event: Record<string, unknown> & { type: string }) => void;
	/** Non-streaming and headless callers deny mutations instead of parking. */
	noUi?: boolean;
}

export interface DurablePermissionAsk {
	toolName: string;
	path: string;
	preview?: string;
}

interface DurablePermissionRecord extends DurablePermissionAsk {
	operationId: string;
	toolCallId: string;
	requestId: string;
	sessionId: string;
	turnId: string;
	approvalKey: string;
	createdAt: string;
	result?: {
		decision: PermissionDecision;
		reason?: string;
	};
}

interface PermissionWaiter {
	resolve: (verdict: AuthorizerVerdict) => void;
}

export interface PendingDurablePermission {
	requestId: string;
	sessionId: string;
	turnId: string;
	toolName: string;
	path: string;
	preview?: string;
	createdAt: string;
}

const NO_UI_REASON =
	"Permission prompt unavailable (no streaming web UI). The workspace mutation was denied; " +
	"explain what you wanted to do and ask the user to retry in a streaming session.";

function operationHash(operationId: string): string {
	return createHash("sha256").update(operationId).digest("hex");
}

function approvalKey(toolName: string, path: string): string {
	return `${toolName}\0${path}`;
}

function verdict(record: DurablePermissionRecord): AuthorizerVerdict {
	if (record.result?.decision !== "deny") return { kind: "allow" };
	return {
		kind: "deny",
		reason: record.result.reason?.trim() || "Denied by the user. Do not retry this operation.",
	};
}

/** Tenant/session-local, replay-safe approvals. A response is committed before
 * the waiter or SSE resolved event is released. Session-wide approvals remain
 * process-local, while the decision for the original tool call survives reopen. */
export class DurablePermissionStore {
	private binding: DurablePermissionBinding | null = null;
	private readonly waiters = new Map<string, PermissionWaiter>();
	private readonly presented = new Set<string>();
	private readonly sessionApprovals = new Set<string>();

	constructor(
		readonly sessionId: string,
		readonly permissionDir: string,
	) {}

	private path(operationId: string): string {
		return join(this.permissionDir, `${operationHash(operationId)}.json`);
	}

	private load(operationId: string): DurablePermissionRecord | undefined {
		const path = this.path(operationId);
		if (!existsSync(path)) return undefined;
		const record = JSON.parse(readFileSync(path, "utf-8")) as DurablePermissionRecord;
		if (record.operationId !== operationId || record.sessionId !== this.sessionId
			|| record.requestId !== `durable-permission-${operationHash(operationId)}`
			|| !record.turnId || !record.createdAt || !record.toolCallId
			|| record.approvalKey !== approvalKey(record.toolName, record.path)) {
			throw new Error("Durable permission record does not match the tool call");
		}
		return record;
	}

	private records(): DurablePermissionRecord[] {
		if (!existsSync(this.permissionDir)) return [];
		return readdirSync(this.permissionDir)
			.filter((file) => file.endsWith(".json"))
			.sort()
			.map((file) => {
				const record = JSON.parse(readFileSync(join(this.permissionDir, file), "utf-8")) as DurablePermissionRecord;
				if (record.sessionId !== this.sessionId || !record.operationId
					|| record.requestId !== `durable-permission-${operationHash(record.operationId)}`
					|| record.approvalKey !== approvalKey(record.toolName, record.path)) {
					throw new Error("Invalid durable permission record");
				}
				return record;
			});
	}

	private save(record: DurablePermissionRecord): void {
		writeJson(this.path(record.operationId), record, { mode: 0o600 });
	}

	private present(record: DurablePermissionRecord): void {
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
			type: "permission_request",
			requestId: record.requestId,
			source: "tool_call",
			surface: record.toolName,
			value: record.path,
			toolName: record.toolName,
			path: record.path,
			preview: record.preview ?? null,
			turnId: record.turnId,
		});
	}

	bindTurn(binding: DurablePermissionBinding): void {
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

	async authorize(
		toolCallId: string,
		ask: DurablePermissionAsk,
		signal: AbortSignal,
	): Promise<AuthorizerVerdict> {
		const operationId = `workspace_permission:${this.sessionId}:${toolCallId}`;
		const key = approvalKey(ask.toolName, ask.path);
		let record = this.load(operationId);
		if (record && (record.toolName !== ask.toolName || record.path !== ask.path
			|| record.preview !== ask.preview)) {
			throw new Error("Durable permission arguments changed for the same tool call");
		}
		if (record?.result) return verdict(record);
		if (!this.binding?.noUi && this.sessionApprovals.has(key)) return { kind: "allow" };
		record ??= {
			operationId,
			toolCallId,
			requestId: `durable-permission-${operationHash(operationId)}`,
			sessionId: this.sessionId,
			turnId: this.binding?.turnId ?? `durable-turn-${operationHash(operationId).slice(0, 24)}`,
			toolName: ask.toolName,
			path: ask.path,
			...(ask.preview !== undefined ? { preview: ask.preview } : {}),
			approvalKey: key,
			createdAt: new Date().toISOString(),
		};
		if (this.binding?.noUi) {
			const completed = {
				...record,
				result: { decision: "deny" as const, reason: NO_UI_REASON },
			};
			this.save(completed);
			return verdict(completed);
		}
		this.save(record);
		if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Permission wait aborted");
		return new Promise<AuthorizerVerdict>((resolve, reject) => {
			this.waiters.set(operationId, { resolve });
			signal.addEventListener("abort", () => {
				if (!this.waiters.delete(operationId)) return;
				reject(signal.reason instanceof Error ? signal.reason : new Error("Permission wait aborted"));
			}, { once: true });
			// Register the waiter before exposing the card so an immediate response
			// resolves this execution instead of stranding it.
			this.present(record);
		});
	}

	respond(input: {
		turnId: string;
		requestId: string;
		decision: PermissionDecision;
		reason?: string;
	}): PermissionResponseStatus {
		const record = this.records().find((item) => item.requestId === input.requestId);
		if (!record) return "not_found";
		if (record.turnId !== input.turnId) return "scope_mismatch";
		if (record.result) return "already_resolved";
		const completed = {
			...record,
			result: {
				decision: input.decision,
				...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
			},
		};
		// Persistence precedes waiter release and the SSE resolved event.
		this.save(completed);
		if (input.decision === "allow_session") this.sessionApprovals.add(record.approvalKey);
		const resolved = verdict(completed);
		this.binding?.emit?.({
			type: "permission_resolved",
			requestId: record.requestId,
			decision: input.decision,
			allowed: resolved.kind === "allow",
		});
		const waiter = this.waiters.get(record.operationId);
		if (waiter) {
			this.waiters.delete(record.operationId);
			waiter.resolve(resolved);
		}
		return "accepted";
	}

	pendingPermission(): PendingDurablePermission | undefined {
		const record = this.records().find((item) => !item.result);
		if (!record) return undefined;
		return {
			requestId: record.requestId,
			sessionId: record.sessionId,
			turnId: record.turnId,
			toolName: record.toolName,
			path: record.path,
			...(record.preview !== undefined ? { preview: record.preview } : {}),
			createdAt: record.createdAt,
		};
	}

	/** Cancellation is a persisted deny, so reopening cannot resurrect the card. */
	cancelTurn(turnId: string): number {
		let cancelled = 0;
		for (const record of this.records()) {
			if (record.result || record.turnId !== turnId) continue;
			if (this.respond({
				turnId,
				requestId: record.requestId,
				decision: "deny",
				reason: "Permission prompt closed (cancelled). The operation was denied.",
			}) === "accepted") cancelled += 1;
		}
		return cancelled;
	}

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
}

/** Wrap only workspace mutations. Reads stay silent; unsupported shell/delete/
 * rename capabilities remain absent rather than becoming approvable. */
export function withDurableWorkspacePermission(
	tool: ToolRegistration,
	store: DurablePermissionStore,
): ToolRegistration {
	return {
		...tool,
		// The approval wait must resume after reopen. As with other durable file
		// mutations, a crash after the write but before its result commit remains
		// an at-least-once side-effect window.
		replay: "safe",
		async execute(args, api, context) {
			const input = args as { path?: unknown };
			const path = typeof input.path === "string" ? input.path : "";
			const decision = await store.authorize(api.callId, {
				toolName: tool.name,
				path,
				preview: JSON.stringify(args).slice(0, 4_000),
			}, context.abortSignal ?? new AbortController().signal);
			if (decision.kind === "deny") {
				return {
					output: [{ type: "text", text: decision.reason ?? "Workspace mutation denied." }],
					isError: true,
				};
			}
			return tool.execute(args, api, context);
		},
	};
}
