import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { defineInnoTool } from "../agent/inno-tool.js";
import { ChannelRegistry, FileSendNotSupportedError } from "./channel.js";
import {
	channelOutboxPayloadPath,
	completeChannelOutbox,
	loadChannelOutbox,
	prepareChannelOutbox,
	type ChannelOutboxRecord,
} from "./channel-outbox.js";
import type { ChannelName } from "./types.js";
import type { WorkspaceRegistry } from "../workspace/workspace-registry.js";
import { logger } from "../logger.js";

export interface ChannelToolsDeps {
	channelRegistry: ChannelRegistry;
	/** Resolve workspace files for the active session (server mode). */
	workspaceRegistry?: WorkspaceRegistry;
	getCurrentSessionId?: () => string;
	/** Fallback workspace root (CLI / no registry). */
	workspaceDir: string;
	/** Tenant executions fail closed instead of using the deployment workspace root. */
	allowWorkspaceFallback?: boolean;
	/**
	 * Tag the active session as having interacted with a channel. Called after a
	 * successful file send so the session picks up the channel badge in the UI.
	 */
	recordChannelInteraction?: (channel: ChannelName) => void;
	/** Durable sends persist a payload snapshot and completion marker. External
	 * delivery remains at-least-once across the send/completion crash window. */
	durable?: {
		outboxDir: string;
		getOperationId: (toolCallId: string) => string;
	};
}

/**
 * Resolve the active session's workspace directory. Falls back to the runtime
 * workspace root when no registry/session mapping is available (CLI mode).
 */
function resolveWorkspaceDir(deps: ChannelToolsDeps): string | null {
	if (deps.workspaceRegistry && deps.getCurrentSessionId) {
		try {
			const sessionId = deps.getCurrentSessionId();
			if (sessionId) {
				const workspaceId = deps.workspaceRegistry.getSessionWorkspaceId(sessionId);
				const dir = deps.workspaceRegistry.resolveWorkspaceDir(workspaceId);
				if (dir) return dir;
			}
		} catch (err) {
			logger.warn({ err }, "failed to resolve workspace dir");
		}
	}
	if (deps.allowWorkspaceFallback === false) return null;
	return deps.workspaceDir;
}

/**
 * Safely resolve a user-supplied path against the workspace root, refusing any
 * path that escapes the workspace via `..` or absolute traversal.
 */
function safeResolveInWorkspace(workspaceDir: string, userPath: string): string | null {
	const root = resolve(workspaceDir);
	const cleaned = isAbsolute(userPath) ? userPath : userPath.replace(/^\/+/, "");
	const resolved = resolve(root, cleaned);
	const rel = relative(root, resolved);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
	if (existsSync(resolved)) {
		try {
			const realRel = relative(realpathSync(root), realpathSync(resolved));
			if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) return null;
		} catch {
			return null;
		}
	}
	return resolved;
}

/**
 * Create channel-facing tools. Currently exposes `send_file_to_channel`, which
 * pushes a workspace file out to a chat channel (Feishu, etc.).
 */
export function createChannelTools(deps: ChannelToolsDeps): ToolRegistration[] {
	const sendFileTool = defineInnoTool({
		name: "send_file_to_channel",
		...(deps.durable ? { replay: "safe" as const } : {}),
		label: "发送文件到渠道",
		description:
			"把工作区里的某个文件发送到聊天渠道（如飞书）。" +
			"当用户说「把 xxx 文件发给我」「发送到飞书/微信」「整理好后推给我」时调用。" +
			"filePath 是相对于当前工作区的路径。channel 可选，缺省时使用消息来源渠道的默认推送目标。" +
			"注意：微信(iLink) 渠道暂不支持发送文件；如果用户未配置任何渠道，会返回提示让用户去配置。",
		parameters: Type.Object({
			filePath: Type.String({ description: "要发送的文件路径（相对于当前工作区）" }),
			channel: Type.Optional(
				StringEnum(["feishu", "wechat", "qq", "wecom"] as const, {
					description: "目标渠道（可选）。缺省时使用已注册渠道的默认推送目标。",
				}),
			),
			chatId: Type.Optional(
				Type.String({ description: "推送目标 chat_id（可选）。缺省时使用该渠道的默认目标。" }),
			),
			fileName: Type.Optional(
				Type.String({ description: "发送时显示的文件名（可选），默认用文件本身的名字。" }),
			),
		}),
		async execute(params, api) {
			const durable = deps.durable;
			const operationId = durable?.getOperationId(api.callId);
			let outbox: ChannelOutboxRecord | undefined;
			if (durable && operationId) {
				try {
					outbox = loadChannelOutbox(durable.outboxDir, operationId);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text" as const, text: `渠道发送恢复失败：${msg}` }],
						details: { error: "outbox_failed", message: msg } as Record<string, unknown>,
					};
				}
				if (outbox?.completion) {
					return {
						content: [{ type: "text" as const, text: outbox.completion.text }],
						details: outbox.completion.details,
					};
				}
			}
			const registered = deps.channelRegistry.all();
			if (registered.length === 0) {
				return {
					content: [{
						type: "text" as const,
						text: "你还没有配置任何消息渠道，无法发送文件。请先在设置里启用并配置飞书或微信等渠道后重试。",
					}],
					details: { error: "no_channels_configured" } as Record<string, unknown>,
				};
			}

			// Resolve the target channel: persisted intent → explicit param → unique registered channel.
			let channelName: ChannelName | undefined = outbox?.channel ?? params.channel as ChannelName | undefined;
			if (!channelName) {
				if (registered.length === 1) {
					channelName = registered[0].name as ChannelName;
				} else {
					const names = registered.map((c) => c.name).join("、");
					return {
						content: [{
							type: "text" as const,
							text: `你启用了多个渠道（${names}）。请告诉我要发送到哪个渠道，或在调用时指定 channel 参数。`,
						}],
						details: { error: "channel_ambiguous", available: registered.map((c) => c.name) } as Record<string, unknown>,
					};
				}
			}

			const channel = deps.channelRegistry.get(channelName);
			if (!channel) {
				return {
					content: [{
						type: "text" as const,
						text: `渠道「${channelName}」尚未启用或配置，无法发送文件。请先在设置里启用并配置该渠道。`,
					}],
					details: { error: "channel_not_registered", channel: channelName } as Record<string, unknown>,
				};
			}

			if (!channel.sendFile) {
				return {
					content: [{
						type: "text" as const,
						text: `渠道「${channelName}」暂不支持发送文件。`,
					}],
					details: { error: "file_send_not_supported", channel: channelName } as Record<string, unknown>,
				};
			}

			// Resolve the push target. Recovered sends keep the original target even
			// if the tenant's default changed while the process was down.
			const chatId = outbox?.chatId ?? (params.chatId?.trim()
				|| deps.channelRegistry.getDefaultTarget(channelName)?.chatId);
			if (!chatId) {
				return {
					content: [{
						type: "text" as const,
						text: `还不知道该把文件发到「${channelName}」的哪个会话。请先从该渠道给我发一条消息（用于绑定默认目标），或在调用时指定 chatId。`,
					}],
					details: { error: "no_target", channel: channelName } as Record<string, unknown>,
				};
			}

			let resolved: string;
			if (outbox && durable && operationId) {
				resolved = channelOutboxPayloadPath(durable.outboxDir, operationId);
				if (!existsSync(resolved) || !statSync(resolved).isFile()) {
					return {
						content: [{ type: "text" as const, text: "渠道 outbox 的文件快照丢失，已停止恢复发送。" }],
						details: { error: "outbox_payload_missing", filePath: outbox.filePath } as Record<string, unknown>,
					};
				}
			} else {
				// Resolve and validate the file path within the workspace.
				const workspaceDir = resolveWorkspaceDir(deps);
				if (!workspaceDir) {
					return {
						content: [{ type: "text" as const, text: "无法确定当前会话的工作区，已停止发送文件。" }],
						details: { error: "workspace_unavailable" } as Record<string, unknown>,
					};
				}
				const workspaceFile = safeResolveInWorkspace(workspaceDir, params.filePath);
				if (!workspaceFile) {
					return {
						content: [{
							type: "text" as const,
							text: `文件路径不合法或超出了工作区范围：${params.filePath}`,
						}],
						details: { error: "invalid_path", filePath: params.filePath } as Record<string, unknown>,
					};
				}
				if (!existsSync(workspaceFile) || !statSync(workspaceFile).isFile()) {
					return {
						content: [{
							type: "text" as const,
							text: `工作区里找不到这个文件：${params.filePath}`,
						}],
						details: { error: "file_not_found", filePath: params.filePath } as Record<string, unknown>,
					};
				}
				resolved = workspaceFile;
				if (durable && operationId) {
					outbox = {
						operationId,
						channel: channelName,
						chatId,
						filePath: params.filePath,
						fileName: params.fileName,
					};
					try {
						resolved = prepareChannelOutbox(durable.outboxDir, outbox, workspaceFile);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: "text" as const, text: `渠道 outbox 写入失败：${msg}` }],
							details: { error: "outbox_failed", filePath: params.filePath, message: msg } as Record<string, unknown>,
						};
					}
				}
			}

			try {
				await channel.sendFile(
					{ channel: channelName, chatId },
					resolved,
					outbox ? outbox.fileName ?? basename(outbox.filePath) : params.fileName,
				);
			} catch (err) {
				logger.warn({ err, channel: channelName, filePath: params.filePath }, "send_file_to_channel tool failed");
				if (err instanceof FileSendNotSupportedError) {
					return {
						content: [{ type: "text" as const, text: err.message }],
						details: { error: "file_send_not_supported", channel: channelName } as Record<string, unknown>,
					};
				}
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{
						type: "text" as const,
						text: `发送文件到「${channelName}」失败：${msg}`,
					}],
					details: { error: "send_failed", channel: channelName, message: msg } as Record<string, unknown>,
				};
			}

			const completion = {
				text: `已把文件 ${params.fileName ?? params.filePath} 发送到「${channelName}」。`,
				details: { channel: channelName, chatId, filePath: params.filePath } as Record<string, unknown>,
			};
			if (durable && outbox) {
				try {
					completeChannelOutbox(durable.outboxDir, outbox, completion);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text" as const, text: `文件已发送，但渠道 outbox 完成标记写入失败：${msg}` }],
						details: { error: "outbox_completion_failed", channel: channelName, message: msg } as Record<string, unknown>,
					};
				}
			}

			// Tag the active session as having interacted with this channel so the
			// UI shows the channel badge (best-effort — never fail the send on this).
			try {
				deps.recordChannelInteraction?.(channelName);
			} catch (err) {
				logger.warn({ err }, "failed to tag session channel interaction");
				// ignore tagging failures
			}

			return {
				content: [{ type: "text" as const, text: completion.text }],
				details: completion.details,
			};
		},
	});

	return [sendFileTool];
}
