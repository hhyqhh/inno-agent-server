import { describe, expect, it } from "vitest";
import { filterActiveToolsForMode, isHostExecutionTool } from "./host-execution-policy.js";

describe("authenticated host execution policy", () => {
	it("removes every PI host shell and file tool while preserving tenant-safe tools", () => {
		const active = ["bash", "read", "write", "edit", "grep", "find", "ls", "parse_document", "l2_archive"];

		expect(filterActiveToolsForMode(active, true)).toEqual(["parse_document", "l2_archive"]);
		for (const name of active.slice(0, 7)) expect(isHostExecutionTool(name)).toBe(true);
	});

	it("preserves local, CLI, and Desktop tool activation", () => {
		const active = ["bash", "read", "parse_document"];
		expect(filterActiveToolsForMode(active, false)).toBe(active);
	});
});
