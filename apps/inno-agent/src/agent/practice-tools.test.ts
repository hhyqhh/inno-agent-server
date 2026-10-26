import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceRegistry } from "../workspace/workspace-registry.js";
import { createPracticeTools } from "./practice-tools.js";

function registry(workspaceRoot: string): WorkspaceRegistry {
	return {
		getSessionWorkspaceId: () => "workspace-1",
		resolveWorkspaceDir: () => workspaceRoot,
	} as unknown as WorkspaceRegistry;
}

describe("create_practice_lab workspace boundary", () => {
	let tempRoot: string;
	let workspaceRoot: string;

	function makeWorkspace() {
		tempRoot = mkdtempSync(join(tmpdir(), "inno-practice-tool-"));
		workspaceRoot = join(tempRoot, "workspace");
		mkdirSync(workspaceRoot);
	}

	afterEach(() => {
		if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
	});

	it("does not follow an existing symlink outside the workspace", async () => {
		makeWorkspace();
		const outside = join(tempRoot, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(workspaceRoot, "linked"), "dir");
		const tool = createPracticeTools({
			registry: registry(workspaceRoot),
			getCurrentSessionId: () => "session-1",
			restrictToWorkspace: true,
		})[0];

		const result = await tool.execute("test-call", {
			files: [{ path: "linked/escape.py", content: "secret = true" }],
		}, undefined, undefined, {} as never);

		expect(result.details).toMatchObject({ ok: false });
		expect(existsSync(join(outside, "escape.py"))).toBe(false);
	});

	it("still creates ordinary nested workspace files", async () => {
		makeWorkspace();
		const tool = createPracticeTools({
			registry: registry(workspaceRoot),
			getCurrentSessionId: () => "session-1",
			restrictToWorkspace: true,
		})[0];

		const result = await tool.execute("test-call", {
			files: [{ path: "src/main.py", content: "print('ok')" }],
		}, undefined, undefined, {} as never);

		expect(result.details).toMatchObject({ ok: true, mainFile: "src/main.py" });
		expect(readFileSync(join(workspaceRoot, "src/main.py"), "utf8")).toBe("print('ok')");
	});
});
