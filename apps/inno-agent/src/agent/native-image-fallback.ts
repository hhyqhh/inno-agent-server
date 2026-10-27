import type { AssistantMessage, Context, ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { logger } from "../logger.js";
import { isImagePathsHint } from "../server/inline-images.js";

export function isNativeImagePayloadError(message: string | undefined): boolean {
	if (!message) return false;
	const normalized = message.toLowerCase();
	// Text-only deployments that answer image requests with a plain
	// "model only support(s) text input" 400 — no image keyword at all.
	if (/only supports? text( |-)?input/.test(normalized)) return true;
	const mentionsImagePayload = /image_url|image message|image input|image content|vision/.test(normalized);
	const rejectsPayload = /unknown variant|expected [`'"]?text|unsupported|not support|does not support|invalid|malformed|decode failed|too large/.test(normalized);
	return mentionsImagePayload && rejectsPayload;
}

export function isNativeImageCapabilityError(message: string | undefined): boolean {
	if (!message) return false;
	const normalized = message.toLowerCase();
	if (/only supports? text( |-)?input/.test(normalized)) return true;
	if (/unknown variant.{0,80}image_url|image_url.{0,80}unknown variant/.test(normalized)) return true;
	if (/expected [`'"]?text.{0,80}(?:image|vision)|(?:image|vision).{0,80}expected [`'"]?text/.test(normalized)) {
		return true;
	}
	return /(?:image|vision).{0,80}(?:unsupported|not support|does not support)|(?:unsupported|not support|does not support).{0,80}(?:image|vision)/.test(normalized) &&
		!/format|mime|base64|decode|dimension|resolution|too large|file size/.test(normalized);
}

/** HTTP 413-style rejections can come from a proxy without mentioning images. */
export function isOversizedPayloadError(message: string | undefined): boolean {
	if (!message) return false;
	return /^\s*413\b|\brequest entity too large\b|\bpayload too large\b|\bcontent too large\b/i.test(message);
}

const NATIVE_IMAGE_OMITTED_NOTICE = [
	"[当前 Provider 无法接收图片内容，因此这张图片没有发送给模型。",
	"你并没有看到图片；不要猜测或声称已经看到。",
	"如需识别，请使用对话中提供的工作区图片路径调用 ocr_image。",
	"read 工具返回“Read image file”也不代表你看到了图片。",
	"如果 OCR 无法提供足够信息，请明确说明限制。]",
].join("");

type MediaContent = TextContent | ImageContent;

function isMediaMessage(message: Message): message is Extract<Message, { role: "user" | "toolResult" }> {
	return message.role === "user" || message.role === "toolResult";
}

function transformMediaContent(
	context: Context,
	transform: (content: MediaContent[], role: "user" | "toolResult") => MediaContent[],
): Context {
	return {
		...context,
		messages: context.messages.map((message) => {
			if (!isMediaMessage(message) || !Array.isArray(message.content)) return message;
			return { ...message, content: transform(message.content, message.role) };
		}),
	};
}

function contextHasNativeImages(context: Context): boolean {
	return context.messages.some((message) => isMediaMessage(message)
		&& Array.isArray(message.content) && message.content.some((block) => block.type === "image"));
}

/** Fallback paths are committed with durable input but hidden while the native
 * attempt still carries images. The first block is always the visible prompt. */
function withoutImagePathHints(context: Context): Context {
	return transformMediaContent(context, (content, role) => content.filter((block, index) =>
		block.type !== "text" || !isImagePathsHint(block.text) || (role === "user" && index === 0)));
}

function withoutNativeImages(context: Context): Context {
	return transformMediaContent(context, (content) => {
		const filtered = content.filter((block) => block.type !== "image");
		if (filtered.length === content.length) return content;
		const hasPaths = content.some((block) => block.type === "text" && isImagePathsHint(block.text));
		return hasPaths ? filtered : [...filtered, { type: "text", text: NATIVE_IMAGE_OMITTED_NOTICE }];
	});
}

function modelKey(model: { provider: string; baseUrl: string; id: string }): string {
	return JSON.stringify([model.provider, model.baseUrl, model.id]);
}

function errorMessage(model: Parameters<Models["streamSimple"]>[0], error: unknown, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "error",
		errorMessage: aborted ? "Request was aborted" : error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/** Retry one durable model request without creating a second submission. The
 * original committed input contains both native images and their hidden OCR
 * path hints, so crash recovery can repeat the same fallback without new UI
 * messages or request IDs. Capability rejection is cached only for this runtime. */
export function withNativeImageFallback(models: Models): Models {
	const rejectedModels = new Set<string>();
	const streamSimple: Models["streamSimple"] = (model, context, options) => {
		const output = createAssistantMessageEventStream();
		const hasImages = contextHasNativeImages(context);
		const useFallback = !hasImages || rejectedModels.has(modelKey(model));
		const initial = useFallback ? withoutNativeImages(context) : withoutImagePathHints(context);
		void (async () => {
			try {
				const native = models.streamSimple(model, initial, options);
				for await (const event of native) {
					const rejected = hasImages && !useFallback && event.type === "error" && event.reason === "error" &&
						(isNativeImagePayloadError(event.error.errorMessage) || isOversizedPayloadError(event.error.errorMessage));
					if (!rejected) {
						output.push(event);
						continue;
					}
					const message = event.error.errorMessage;
					if (isNativeImageCapabilityError(message)) rejectedModels.add(modelKey(model));
					logger.warn({ provider: model.provider, model: model.id, errorMessage: message },
						"provider rejected native image payload; retrying durable request with workspace OCR fallback");
					const fallback = models.streamSimple(model, withoutNativeImages(context), options);
					for await (const fallbackEvent of fallback) output.push(fallbackEvent);
					output.end();
					return;
				}
				output.end();
			} catch (error) {
				const aborted = options?.signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
				output.push({ type: "error", reason: aborted ? "aborted" : "error", error: errorMessage(model, error, aborted) });
			}
		})();
		return output;
	};
	return new Proxy(models, {
		get(target, property) {
			if (property === "streamSimple") return streamSimple;
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
