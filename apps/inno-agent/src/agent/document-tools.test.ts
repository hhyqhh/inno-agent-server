import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const parser = vi.hoisted(() => ({
	parseDocument: vi.fn(),
	screenshotDocument: vi.fn(),
}));

vi.mock("../memory/l2/document-parser.js", () => ({
	...parser,
	DocumentParseError: class DocumentParseError extends Error {},
}));

import { createDocumentTools } from "./document-tools.js";

describe("parse_document", () => {
	let tempRoot: string;
	let workspaceDir: string;

	function makeWorkspace() {
		tempRoot = mkdtempSync(join(tmpdir(), "inno-document-tool-"));
		workspaceDir = join(tempRoot, "workspace");
		mkdirSync(workspaceDir);
	}

	afterEach(() => {
		parser.parseDocument.mockReset();
		parser.screenshotDocument.mockReset();
		if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
	});

	it("resolves relative paths against the current session cwd", async () => {
		makeWorkspace();
		const filePath = join(workspaceDir, "paper.pdf");
		writeFileSync(filePath, "placeholder");
		parser.parseDocument.mockResolvedValue({ pageCount: 1, text: "parsed", pages: [{ pageNumber: 1, text: "parsed" }] });

		const tool = createDocumentTools()[0];
		const result = await tool.execute(
			"test-call",
			{ filePath: "paper.pdf" },
			undefined,
			undefined,
			{ cwd: workspaceDir } as never,
		);

		expect(parser.parseDocument).toHaveBeenCalledWith(filePath);
		expect(result.details).toMatchObject({ filePath });
		expect(result.content[0]).toMatchObject({ type: "text" });
	});

	it.each(["absolute", "parent"])("rejects authenticated %s paths outside the workspace", async (kind) => {
		makeWorkspace();
		const outsidePath = join(tempRoot, "outside.pdf");
		writeFileSync(outsidePath, "secret");
		const tool = createDocumentTools({ restrictToWorkspace: true })[0];

		const result = await tool.execute(
			"test-call",
			{ filePath: kind === "absolute" ? outsidePath : "../outside.pdf" },
			undefined,
			undefined,
			{ cwd: workspaceDir } as never,
		);

		expect(result.details).toMatchObject({ error: "outside_workspace" });
		expect(parser.parseDocument).not.toHaveBeenCalled();
	});

	it("rejects an authenticated symlink that escapes the workspace", async () => {
		makeWorkspace();
		const outsidePath = join(tempRoot, "outside.pdf");
		writeFileSync(outsidePath, "secret");
		symlinkSync(outsidePath, join(workspaceDir, "linked.pdf"));
		const tool = createDocumentTools({ restrictToWorkspace: true })[0];

		const result = await tool.execute(
			"test-call",
			{ filePath: "linked.pdf" },
			undefined,
			undefined,
			{ cwd: workspaceDir } as never,
		);

		expect(result.details).toMatchObject({ error: "outside_workspace" });
		expect(parser.parseDocument).not.toHaveBeenCalled();
	});

	it("preserves local absolute-path parsing", async () => {
		makeWorkspace();
		const outsidePath = join(tempRoot, "outside.pdf");
		writeFileSync(outsidePath, "local");
		parser.parseDocument.mockResolvedValue({ pageCount: 1, text: "parsed", pages: [] });
		const tool = createDocumentTools()[0];

		const result = await tool.execute(
			"test-call",
			{ filePath: outsidePath },
			undefined,
			undefined,
			{ cwd: workspaceDir } as never,
		);

		expect(result.details).toMatchObject({ filePath: outsidePath, pageCount: 1 });
		expect(parser.parseDocument).toHaveBeenCalledWith(outsidePath);
	});
});
