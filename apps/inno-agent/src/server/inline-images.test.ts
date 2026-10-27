import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildImagePathsHint,
	parseInlineImages,
	persistInlineImages,
	prependImagePathsHint,
} from "./inline-images.js";

describe("inline chat images", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "inno-inline-images-"));
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	it("parses only well-formed image payloads", () => {
		expect(parseInlineImages([
			{ data: "aW1hZ2U=", mimeType: "image/png" },
			{ data: 1, mimeType: "image/png" },
			null,
		])).toEqual([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
		expect(parseInlineImages("no")).toEqual([]);
	});

	it("reuses durable paths for identical retries without overwriting changed bytes", () => {
		const images = parseInlineImages([{ data: "Zmlyc3Q=", mimeType: "image/png" }]);
		const first = persistInlineImages(images, workspace, "request-1");
		const retry = persistInlineImages(images, workspace, "request-1");
		expect(retry).toEqual(first);
		expect(readdirSync(join(workspace, ".chat-images"))).toHaveLength(1);
		expect(readFileSync(join(workspace, first[0]), "utf8")).toBe("first");

		const changed = persistInlineImages(parseInlineImages([{ data: "c2Vjb25k", mimeType: "image/png" }]), workspace, "request-1");
		expect(changed[0]).not.toBe(first[0]);
		expect(readFileSync(join(workspace, first[0]), "utf8")).toBe("first");
		expect(readFileSync(join(workspace, changed[0]), "utf8")).toBe("second");
	});

	it("builds the OCR path hint without changing the legacy prompt format", () => {
		const hint = buildImagePathsHint([".chat-images/a.png"]);
		expect(hint).toContain("用户本轮上传了 1 张图片");
		expect(hint).toContain("ocr_image");
		expect(prependImagePathsHint("总结图片", [".chat-images/a.png"])).toBe(`${hint}\n\n总结图片`);
		expect(prependImagePathsHint("plain", [])).toBe("plain");
	});
});
