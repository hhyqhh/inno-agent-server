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
		const tool = createOcrTools(config(), { restrictToWorkspace: true, workspaceDir: workspace })[0];

		const result = await tool.execute(
			{ filePath: "linked.png" },
			{ callId: "test-call" } as never,
			{ abortSignal: undefined } as never,
		);

		expect(result.details).toMatchObject({ error: "submit_failed" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("caches durable OCR completion without repeating remote calls on retry", async () => {
		tempRoot = mkdtempSync(join(tmpdir(), "inno-ocr-durable-"));
		const workspace = join(tempRoot, "workspace");
		mkdirSync(workspace);
		writeFileSync(join(workspace, "note.png"), "image");
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (init?.method === "POST") {
				return new Response(JSON.stringify({ data: { jobId: "job-1" } }), { status: 200 });
			}
			if (url.endsWith("/job-1")) {
				return new Response(JSON.stringify({ data: { state: "done", resultUrl: { jsonUrl: "https://ocr.test/result" } } }), { status: 200 });
			}
			return new Response(`${JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: "识别文本" } }] } })}\n`, { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const tool = createOcrTools(config(), {
			restrictToWorkspace: true,
			workspaceDir: workspace,
			durable: {
				checkpointDir: join(tempRoot, "ocr"),
				getOperationId: (callId) => `ocr_image:durable-session:${callId}`,
			},
		})[0];
		const execute = () => tool.execute(
			{ filePath: "note.png" },
			{ callId: "stable-call" } as never,
			{ abortSignal: undefined } as never,
		);

		const first = await execute();
		const retry = await execute();

		expect(first.output?.[0]).toEqual({ type: "text", text: "识别文本" });
		expect(retry).toEqual(first);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});
