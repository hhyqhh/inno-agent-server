/**
 * Bridges pi-permission-system `ask` verdicts to the web UI.
 *
 * Mirrors question-bridge.ts: the plugin's `inno-web` authorizer link calls
 * `authorize(details)`, which parks a promise while an approval card is
 * streamed to the bound chat turn; the web UI answers via
 * `POST /api/chat/permission-response`, which lands in `respond()`.
 *
 * Fail-closed by design (the user-approved policy): no bound turn, timeout,
 * abort, or turn end all resolve to `deny` with a teaching reason the agent
 * can read and self-correct from.
 *
 * `allow_session` answers are cached in-process by (tenant, session, agent run,
 * surface, value) so a repeat ask in the same owned runtime can be approved
 * without a second card. A cached verdict is never used without a bound turn.
 * The cache is deliberately not persisted — a restart re-prompts, which matches
 * the plugin's own session-approval semantics.
 */

import { randomUUID } from "node:crypto";

export type PermissionDecision = "allow_once" | "allow_session" | "deny";

/** The fields of the plugin's PromptPermissionDetails the bridge consumes.
 *  Structurally typed so the bridge does not import the plugin (which loads
 *  through jiti). */
export interface PermissionAskDetails {
	requestId?: string;
	source?: string;
	toolName?: string;
	skillName?: string;
	path?: string;
	command?: string;
	target?: string;
	surface?: string | null;
	value?: string | null;
	agentName?: string | null;
	toolInputPreview?: string;
	forwarding?: { requesterAgentName?: string | null } | null;
}

export type AuthorizerVerdict =
	| { kind: "allow" }
	| { kind: "deny"; reason?: string }
	| { kind: "defer" };

interface TurnBinding {
	sessionId: string;
	turnId: string;
	tenantId?: string;
	/** Stable agent runtime identity, normally the owned session file path. */
	runId?: string;
	emit: (event: Record<string, unknown> & { type: string }) => void;
	timeoutMs: number;
}

interface PendingAsk {
	requestId: string;
	sessionId: string;
	turnId: string;
	approvalKey: string | null;
	resolve: (verdict: AuthorizerVerdict) => void;
	timer: ReturnType<typeof setTimeout>;
}

export type PermissionResponseStatus = "accepted" | "not_found" | "scope_mismatch" | "already_resolved";

const NO_UI_REASON =
	"Permission prompt unavailable (no active web session). The operation was denied; " +
	"explain to the user what you wanted to do and let them retry or adjust permissions.";

export class PermissionBridge {
	private binding: TurnBinding | null = null;
	private pending: PendingAsk | null = null;
	private lastResolved: Pick<PendingAsk, "requestId" | "sessionId" | "turnId"> | null = null;
	/** (tenant, session, run, surface, value) pairs approved in this process. */
	private sessionApprovals = new Set<string>();

	bindTurn(binding: TurnBinding): void {
		if (this.binding && (this.binding.sessionId !== binding.sessionId || this.binding.turnId !== binding.turnId)) {
			this.unbindTurn({ ...this.binding, reason: "superseded" });
		}
		this.binding = binding;
	}

	/** Called by the plugin's authorizer link. Never throws — every failure
	 *  mode resolves to a deny verdict so the agent loop always continues. */
	authorize(details: PermissionAskDetails): Promise<AuthorizerVerdict> {
		const binding = this.binding;
		if (!binding) return Promise.resolve({ kind: "deny", reason: NO_UI_REASON });
		const approvalKey = sessionApprovalKey(binding, details);
		if (approvalKey && this.sessionApprovals.has(approvalKey)) {
			return Promise.resolve({ kind: "allow" });
		}
		if (this.pending) this.resolvePending({ kind: "deny", reason: "Superseded by a newer permission request." }, false);

		const requestId = typeof details.requestId === "string" && details.requestId ? details.requestId : randomUUID();
		return new Promise<AuthorizerVerdict>((resolve) => {
			const timer = setTimeout(() => {
				if (this.pending?.requestId !== requestId) return;
				this.resolvePending({
					kind: "deny",
					reason: "Permission prompt timed out waiting for the user. The operation was denied; do not retry it without asking the user first.",
				}, true);
			}, binding.timeoutMs);
			this.pending = { requestId, sessionId: binding.sessionId, turnId: binding.turnId, approvalKey, resolve, timer };
			binding.emit({
				type: "permission_request",
				requestId,
				source: details.source ?? "tool_call",
				surface: details.surface ?? details.toolName ?? null,
				value: details.value ?? details.command ?? details.path ?? details.target ?? details.skillName ?? null,
				toolName: details.toolName ?? null,
				command: details.command ?? null,
				path: details.path ?? null,
				agentName: details.agentName ?? null,
				forwardedFrom: details.forwarding?.requesterAgentName ?? null,
				preview: details.toolInputPreview ?? null,
			});
		});
	}

	/** Info about the currently parked ask, if a turn is waiting on one. */
	pendingInfo(): { sessionId: string; turnId: string; requestId: string } | null {
		const pending = this.pending;
		return pending
			? { sessionId: pending.sessionId, turnId: pending.turnId, requestId: pending.requestId }
			: null;
	}

	respond(input: {
		sessionId: string;
		turnId: string;
		requestId: string;
		decision: PermissionDecision;
		reason?: string;
	}): PermissionResponseStatus {
		const pending = this.pending;
		if (!pending || pending.requestId !== input.requestId) {
			return this.lastResolved?.requestId === input.requestId
				&& this.lastResolved.sessionId === input.sessionId
				&& this.lastResolved.turnId === input.turnId
				? "already_resolved"
				: "not_found";
		}
		if (pending.sessionId !== input.sessionId || pending.turnId !== input.turnId) return "scope_mismatch";
		if (input.decision === "allow_session" && pending.approvalKey) {
			this.sessionApprovals.add(pending.approvalKey);
		}
		const verdict: AuthorizerVerdict = input.decision === "deny"
			? { kind: "deny", reason: input.reason?.trim() || "Denied by the user. Do not retry this operation." }
			: { kind: "allow" };
		this.resolvePending(verdict, true, input.decision);
		return "accepted";
	}

	unbindTurn(input: { sessionId: string; turnId: string; reason: string }): void {
		if (!this.binding || this.binding.sessionId !== input.sessionId || this.binding.turnId !== input.turnId) return;
		if (this.pending?.sessionId === input.sessionId && this.pending.turnId === input.turnId) {
			this.resolvePending({
				kind: "deny",
				reason: `Permission prompt closed (${input.reason}). The operation was denied.`,
			}, true);
		}
		this.binding = null;
	}

	private resolvePending(verdict: AuthorizerVerdict, emitResolved: boolean, decision?: PermissionDecision): void {
		const pending = this.pending;
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending = null;
		this.lastResolved = { requestId: pending.requestId, sessionId: pending.sessionId, turnId: pending.turnId };
		if (emitResolved && this.binding?.sessionId === pending.sessionId && this.binding.turnId === pending.turnId) {
			this.binding.emit({
				type: "permission_resolved",
				requestId: pending.requestId,
				decision: decision ?? "deny",
				allowed: verdict.kind === "allow",
			});
		}
		pending.resolve(verdict);
	}
}

/** Stable cache key for tenant + session + agent run and the normalized
 * command/path. Returns null when the ask has no usable value. */
function sessionApprovalKey(binding: TurnBinding, details: PermissionAskDetails): string | null {
	const surface = details.surface ?? details.toolName ?? null;
	const value = details.value ?? details.command ?? details.path ?? details.target ?? details.skillName ?? null;
	if (!surface || !value) return null;
	const scope = `${binding.tenantId ?? "local"}\0${binding.sessionId}\0${binding.runId ?? binding.sessionId}`;
	return `${scope}\0${surface}\0${value}`;
}

export const permissionBridge = new PermissionBridge();
