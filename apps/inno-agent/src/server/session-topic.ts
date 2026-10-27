import type { SessionMessageSummary, SessionSummary } from "./session-model.js";
import { stripUploadedImagesPrefix } from "./upload-prefix.js";

export type SessionTopicCompletion = (prompt: string, maxTokens: number) => Promise<string>;

export function cleanGeneratedTopic(raw: string): string {
	return raw
		.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
		.replace(/^标题[:：]\s*/i, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 32);
}

/** Strip machine-injected prefixes so titles reflect the user's actual words. */
function stripInjectedPrefix(content: string): string {
	return stripUploadedImagesPrefix(content);
}

export function fallbackTopicFromMessages(messages: SessionMessageSummary[], summary: SessionSummary): string {
	const source = stripInjectedPrefix(messages.find((message) => message.role === "user")?.content || "") || summary.preview || summary.name;
	const cleaned = source.replace(/\s+/g, " ").trim();
	return cleaned ? (cleaned.length > 28 ? `${cleaned.slice(0, 28)}...` : cleaned) : "New conversation";
}

/** Build the dialogue excerpt for topic generation: first 2 + last 4 usable
 *  messages (the opening states the goal, the tail captures where the
 *  conversation actually went), consecutive duplicates dropped (scheduler
 *  nudges repeat), machine prefixes stripped, ~2400 chars. */
export function buildTopicExcerpt(messages: SessionMessageSummary[]): string {
	const usable = messages
		.map((message) => ({
			role: message.role,
			content: stripInjectedPrefix(message.content).replace(/\s+/g, " ").trim(),
		}))
		.filter((message) => message.content)
		.filter((message, index, all) => index === 0 || message.content !== all[index - 1].content);
	const picked = usable.length <= 6 ? usable : [...usable.slice(0, 2), ...usable.slice(-4)];
	return picked
		.map((message) => `${message.role === "user" ? "用户" : "助手"}: ${message.content}`)
		.join("\n")
		.slice(0, 2400);
}

export function buildTopicPrompt(messages: SessionMessageSummary[]): string {
	const excerpt = buildTopicExcerpt(messages);
	if (!excerpt) return "";
	return `请用一句简短的中文短语概括下面学习对话中用户的学习目标或任务。
要求：
- 只输出标题本身，不要解释
- 8 到 16 个中文字符
- 聚焦用户想学的内容或要做的任务，忽略寒暄、客套话和系统提示
- 不要使用引号、句号或冒号

示例一：
对话：
用户: 你好
助手: 你好！今天想学点什么？
用户: 我一直搞不清贝叶斯定理，能举个生活中的例子讲讲吗
标题：贝叶斯定理入门

示例二：
对话：
用户: 帮我把这份教案改成 45 分钟公开课的版本
助手: 好的，我先看看教案的结构……
标题：教案改编公开课版

对话：
${excerpt}
标题：`;
}

export async function generateSessionTopicWithCompletion(
	summary: SessionSummary,
	messages: SessionMessageSummary[],
	complete: SessionTopicCompletion,
): Promise<string> {
	const prompt = buildTopicPrompt(messages);
	if (!prompt) return fallbackTopicFromMessages(messages, summary);
	try {
		// Reasoning models can consume a small budget before emitting visible text.
		const generated = cleanGeneratedTopic(await complete(prompt, 1024));
		return generated || fallbackTopicFromMessages(messages, summary);
	} catch {
		return fallbackTopicFromMessages(messages, summary);
	}
}
