import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { logger } from "../logger.js";
import { resolveContainedPath } from "../utils/path-safety.js";

export function parseInlineImages(raw: unknown): ImageContent[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((image): image is { data: string; mimeType: string } => Boolean(
			image && typeof image === "object"
			&& typeof (image as { data?: unknown }).data === "string"
			&& typeof (image as { mimeType?: unknown }).mimeType === "string",
		))
		.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
}

function mimeTypeToExtension(mimeType: string): string {
	switch (mimeType) {
		case "image/png": return ".png";
		case "image/jpeg": return ".jpg";
		case "image/gif": return ".gif";
		case "image/webp": return ".webp";
		case "image/tiff": return ".tiff";
		case "image/bmp": return ".bmp";
		default: return ".png";
	}
}

/** Persist inline chat images where workspace file tools can read them. A
 * durable content key makes retries idempotent without overwriting a file when
 * a client incorrectly reuses a request ID with different bytes. */
export function persistInlineImages(images: ImageContent[], workspaceRoot: string, contentKey?: string): string[] {
	if (images.length === 0) return [];
	const chatImagesDir = resolveContainedPath(workspaceRoot, ".chat-images");
	if (!chatImagesDir) {
		logger.warn({ workspaceRoot }, "skipping inline image persistence: .chat-images escapes the workspace");
		return [];
	}
	try {
		if (!existsSync(chatImagesDir)) mkdirSync(chatImagesDir, { recursive: true });
	} catch (err) {
		logger.warn({ err }, "failed to create .chat-images dir");
		return [];
	}
	const timestamp = Date.now();
	const paths: string[] = [];
	images.forEach((image, index) => {
		const filenameKey = contentKey
			? createHash("sha256").update(`${contentKey}:${index}:${image.data}`).digest("hex").slice(0, 24)
			: `${timestamp}`;
		const filename = `${filenameKey}-${index}${mimeTypeToExtension(image.mimeType)}`;
		try {
			writeFileSync(join(chatImagesDir, filename), Buffer.from(image.data, "base64"));
			paths.push(`.chat-images/${filename}`);
		} catch (err) {
			logger.warn({ err, filename }, "failed to persist inline image");
		}
	});
	return paths;
}

/** Text-only models receive workspace paths rather than native image blocks. */
export function buildImagePathsHint(imagePaths: string[]): string {
	if (imagePaths.length === 0) return "";
	const list = imagePaths.map((path) => `- ${path}`).join("\n");
	return `[用户本轮上传了 ${imagePaths.length} 张图片，已保存到工作区：\n${list}\n如果需要识别图片中的文字（当前模型可能不支持图片识别），请调用 ocr_image 工具并传入上述路径。]`;
}

export function prependImagePathsHint(prompt: string, imagePaths: string[]): string {
	const hint = buildImagePathsHint(imagePaths);
	return hint ? `${hint}\n\n${prompt}` : prompt;
}

export function isImagePathsHint(text: string): boolean {
	return text.startsWith("[用户本轮上传了 ");
}
