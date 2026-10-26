import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportShowcaseCase, isValidCaseId, type CaseSpec } from "./case-exporter.js";

let root: string;
let sessionsDir: string;
let spec: CaseSpec;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "showcase-exporter-"));
	sessionsDir = join(root, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	writeFileSync(join(sessionsDir, "2026-10-27_test.jsonl"), `${JSON.stringify({
		type: "message",
		timestamp: "2026-10-27T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{
				type: "toolCall",
				id: "learning-call",
				name: "record_learning_event",
				arguments: { payload: { topic: "tenant private milestone" } },
			}],
			stopReason: "stop",
		},
	})}\n`);
	spec = {
		id: "safe-case",
		sessionFile: "2026-10-27_test.jsonl",
		title: "Safe case",
		titleEn: "",
		description: "",
		tags: [],
	};
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("showcase export boundaries", () => {
	it.each(["", ".", "..", "../escape", "nested/case", "nested\\case", "/absolute", "index", "INDEX", "white space"])(
		"rejects unsafe case id %j before creating output",
		(id) => {
			const outDir = join(root, "cases");
			expect(isValidCaseId(id)).toBe(false);
			expect(() => exportShowcaseCase({ ...spec, id }, { sessionsDir, dataDir: root, outDir }, []))
				.toThrow("Invalid showcase case id");
			expect(existsSync(outDir)).toBe(false);
		},
	);

	it("reads only the explicitly selected learner root", () => {
		const globalLearner = join(root, "learner");
		const tenantLearner = join(root, "tenants", "tenant-a", "learner");
		mkdirSync(globalLearner, { recursive: true });
		mkdirSync(tenantLearner, { recursive: true });
		writeFileSync(join(globalLearner, "profile.json"), JSON.stringify({ profile_summary: "legacy-global-secret" }));
		writeFileSync(join(tenantLearner, "profile.json"), JSON.stringify({ profile_summary: "tenant-a-secret" }));
		const outDir = join(root, "tenants", "tenant-a", "showcase-exports", "cases");

		const entry = exportShowcaseCase(spec, { sessionsDir, dataDir: root, learnerDataDir: tenantLearner, outDir }, []);
		expect(entry?.id).toBe("safe-case");
		const exported = readFileSync(join(outDir, "safe-case.json"), "utf-8");
		expect(exported).toContain("tenant-a-secret");
		expect(exported).not.toContain("legacy-global-secret");

		const localOutDir = join(root, "local-cases");
		exportShowcaseCase(spec, { sessionsDir, dataDir: root, outDir: localOutDir }, []);
		const localExport = readFileSync(join(localOutDir, "safe-case.json"), "utf-8");
		expect(localExport).toContain("legacy-global-secret");
		expect(localExport).not.toContain("tenant-a-secret");
	});
});
