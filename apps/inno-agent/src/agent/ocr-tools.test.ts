import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigHolder } from "./inno-extension.js";
import { createOcrTools } from "./ocr-tools.js";

function config(): ConfigHolder {
	return { current: { ocrApi: { token: "test-token" } } } as ConfigHolder;
}

describe("ocr_image workspace boundary", () => {
	let tempRoot: string;

	afterEach(() => {
		if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
		vi.unstubAllGlobals();
	});

	it("rejects a symlink escape before sending file content to the OCR service", async () => {
		tempRoot = mkdtempSync(join(tmpdir(), "inno-ocr-tool-"));
		const workspace = join(tempRoot, "workspace");
		mkdirSync(workspace);
		const outside = join(tempRoot, "outside.png");
		writeFileSync(outside, "secret");
		symlinkSync(outside, join(workspace, "linked.png"));
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const tool = createOcrTools(config(), { restrictToWorkspace: true })[0];

		const result = await tool.execute(
			"test-call",
			{ filePath: "linked.png" },
			undefined,
			undefined,
			{ cwd: workspace } as never,
		);

		expect(result.details).toMatchObject({ error: "submit_failed" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
