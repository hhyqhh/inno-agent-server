import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunRecordStore } from "./run-record-store.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "inno-run-store-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("RunRecordStore", () => {
	it("resolves the run root at execution time", () => {
		let tenant = "a";
		const store = new RunRecordStore(() => join(dir, tenant));
		const runA = store.start({ sessionId: "session", workspaceId: "workspace", command: "secret-a", cwd: dir });
		store.appendOutput(runA, "output-a\n");
		store.finish(runA, { exitCode: 0 });

		tenant = "b";
		expect(store.get(runA.id)).toBeNull();
		expect(store.listForSession("session")).toEqual([]);
		const runB = store.start({ sessionId: "session", workspaceId: "workspace", command: "secret-b", cwd: dir });
		expect(store.listForSession("session").map((run) => run.id)).toEqual([runB.id]);

		tenant = "a";
		expect(store.get(runA.id)?.command).toBe("secret-a");
		expect(store.getOutputTail(runA)).toBe("output-a\n");
		expect(store.listForSession("session").map((run) => run.id)).toEqual([runA.id]);
	});

	it("keeps the fixed-directory behavior for local mode", () => {
		const store = new RunRecordStore(join(dir, "runs"));
		const run = store.start({ sessionId: "local", workspaceId: "tmp", command: "pwd", cwd: dir });
		expect(store.get(run.id)?.sessionId).toBe("local");
	});
});
