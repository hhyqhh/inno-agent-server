import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurablePermissionStore } from "./durable-permissions.js";

const roots: string[] = [];

function permissionDir(): string {
	const root = mkdtempSync(join(tmpdir(), "inno-durable-permissions-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ask = { toolName: "write", path: "notes/today.md", preview: '{"path":"notes/today.md"}' };

describe("DurablePermissionStore", () => {
	it("rebinds a pending card and returns a persisted approval after reopen", async () => {
		const directory = permissionDir();
		const first = new DurablePermissionStore("durable-session", directory);
		const controller = new AbortController();
		const firstEvents: Array<Record<string, unknown>> = [];
		first.bindTurn({ turnId: "turn-one", emit: (event) => firstEvents.push(event) });
		const waiting = first.authorize("stable-call", ask, controller.signal);
		const requestId = first.pendingPermission()!.requestId;
		expect(firstEvents[0]).toMatchObject({
			type: "permission_request", requestId, toolName: "write", path: ask.path, turnId: "turn-one",
		});
		controller.abort();
		await expect(waiting).rejects.toThrow();

		const reopened = new DurablePermissionStore("durable-session", directory);
		const recoveredEvents: Array<Record<string, unknown>> = [];
		reopened.bindTurn({ turnId: "turn-two", emit: (event) => recoveredEvents.push(event) });
		expect(recoveredEvents).toHaveLength(1);
		expect(recoveredEvents[0]).toMatchObject({ type: "permission_request", requestId, turnId: "turn-two" });
		expect(reopened.respond({ turnId: "turn-one", requestId, decision: "allow_once" })).toBe("scope_mismatch");
		expect(reopened.respond({ turnId: "turn-two", requestId, decision: "allow_once" })).toBe("accepted");
		expect(reopened.respond({ turnId: "turn-two", requestId, decision: "allow_once" })).toBe("already_resolved");
		expect(reopened.pendingPermission()).toBeUndefined();

		const completed = new DurablePermissionStore("durable-session", directory);
		await expect(completed.authorize("stable-call", ask, new AbortController().signal))
			.resolves.toEqual({ kind: "allow" });
	});

	it("persists denial and cancellation without resurrecting cards", async () => {
		const directory = permissionDir();
		const store = new DurablePermissionStore("durable-session", directory);
		const events: Array<Record<string, unknown>> = [];
		store.bindTurn({ turnId: "cancel-turn", emit: (event) => events.push(event) });
		const waiting = store.authorize("cancel-call", ask, new AbortController().signal);
		expect(store.cancelTurn("wrong-turn")).toBe(0);
		expect(store.cancelTurn("cancel-turn")).toBe(1);
		await expect(waiting).resolves.toMatchObject({ kind: "deny", reason: expect.stringContaining("cancelled") });
		expect(store.pendingPermission()).toBeUndefined();
		expect(events.at(-1)).toMatchObject({ type: "permission_resolved", decision: "deny", allowed: false });

		const reopened = new DurablePermissionStore("durable-session", directory);
		await expect(reopened.authorize("cancel-call", ask, new AbortController().signal))
			.resolves.toMatchObject({ kind: "deny" });
		expect(reopened.pendingPermission()).toBeUndefined();
	});

	it("fails closed for no-UI calls without leaving a pending card", async () => {
		const store = new DurablePermissionStore("durable-session", permissionDir());
		store.bindTurn({ turnId: "http-once", noUi: true });
		await expect(store.authorize("no-ui-call", ask, new AbortController().signal))
			.resolves.toMatchObject({ kind: "deny", reason: expect.stringContaining("no streaming web UI") });
		expect(store.pendingPermission()).toBeUndefined();
	});

	it("caches allow-session only for the same workspace mutation", async () => {
		const store = new DurablePermissionStore("durable-session", permissionDir());
		const events: Array<Record<string, unknown>> = [];
		store.bindTurn({ turnId: "session-turn", emit: (event) => events.push(event) });
		const waiting = store.authorize("first-call", ask, new AbortController().signal);
		const requestId = store.pendingPermission()!.requestId;
		expect(store.respond({ turnId: "session-turn", requestId, decision: "allow_session" })).toBe("accepted");
		await expect(waiting).resolves.toEqual({ kind: "allow" });
		await expect(store.authorize("second-call", ask, new AbortController().signal))
			.resolves.toEqual({ kind: "allow" });
		expect(events.filter((event) => event.type === "permission_request")).toHaveLength(1);

		const otherPath = store.authorize("other-call", { ...ask, path: "other.md" }, new AbortController().signal);
		expect(store.pendingPermission()).toMatchObject({ path: "other.md" });
		store.cancelTurn("session-turn");
		await expect(otherPath).resolves.toMatchObject({ kind: "deny" });
	});
});
