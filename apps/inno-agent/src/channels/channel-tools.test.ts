import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceRegistry } from "../workspace/workspace-registry.js";
import { ChannelRegistry } from "./channel.js";
import {
	channelOutboxPayloadPath,
	completeChannelOutbox,
	deleteChannelOutboxForSession,
	loadChannelOutbox,
	prepareChannelOutbox,
	pruneCompletedChannelOutboxForIdleSession,
	type ChannelOutboxRecord,
} from "./channel-outbox.js";
import { createChannelTools } from "./channel-tools.js";
import type { PushTarget } from "./types.js";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-channel-tools-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(workspaceDir: string | null, fallbackDir: string) {
	const registry = new ChannelRegistry();
	const sends: Array<{ target: PushTarget; filePath: string }> = [];
	registry.register({
		name: "feishu",
		verify: async () => true,
		parse: async () => null,
		reply: async () => {},
		push: async () => {},
		sendFile: async (target, filePath) => { sends.push({ target, filePath }); },
	});
	registry.setDefaultTarget({ channel: "feishu", chatId: "tenant-chat" });
	const workspaceRegistry = {
		getSessionWorkspaceId: () => "current-workspace",
		resolveWorkspaceDir: () => workspaceDir,
	} as unknown as WorkspaceRegistry;
	const tool = createChannelTools({
		channelRegistry: registry,
		workspaceRegistry,
		getCurrentSessionId: () => "current.jsonl",
		workspaceDir: fallbackDir,
		allowWorkspaceFallback: false,
	})[0];
	return { registry, sends, tool };
}

function executeTool(
	tool: ReturnType<typeof createChannelTools>[number],
	callId: string,
	params: { filePath: string },
) {
	return tool.execute(params, { callId } as never, { abortSignal: undefined } as never);
}

describe("tenant-safe channel file tools", () => {
	it("sends from the active session workspace to the scoped default target", async () => {
		const workspace = tempDir();
		const fallback = tempDir();
		writeFileSync(join(workspace, "report.txt"), "tenant file");
		writeFileSync(join(fallback, "report.txt"), "global file");
		const { sends, tool } = setup(workspace, fallback);

		const result = await executeTool(tool, "call", { filePath: "report.txt" });

		expect(result.details).toMatchObject({ channel: "feishu", chatId: "tenant-chat" });
		expect(sends).toEqual([{ target: { channel: "feishu", chatId: "tenant-chat" }, filePath: join(workspace, "report.txt") }]);
	});

	it("fails closed when the tenant workspace cannot be resolved", async () => {
		const fallback = tempDir();
		writeFileSync(join(fallback, "report.txt"), "global file");
		const { sends, tool } = setup(null, fallback);

		const result = await executeTool(tool, "call", { filePath: "report.txt" });

		expect(result.details).toMatchObject({ error: "workspace_unavailable" });
		expect(sends).toEqual([]);
	});

	it("caches durable delivery completion and retains a snapshot of the sent file", async () => {
		const workspace = tempDir();
		const source = join(workspace, "report.txt");
		writeFileSync(source, "snapshot contents");
		const registry = new ChannelRegistry();
		const sends: Array<{ filePath: string; fileName?: string }> = [];
		registry.register({
			name: "feishu",
			verify: async () => true,
			parse: async () => null,
			reply: async () => {},
			push: async () => {},
			sendFile: async (_target, filePath, fileName) => { sends.push({ filePath, fileName }); },
		});
		registry.setDefaultTarget({ channel: "feishu", chatId: "tenant-chat" });
		const tool = createChannelTools({
			channelRegistry: registry,
			workspaceDir: workspace,
			durable: {
				outboxDir: join(workspace, "outbox"),
				getOperationId: (callId) => `send_file_to_channel:durable-session:${callId}`,
			},
		})[0];
		const execute = () => executeTool(tool, "stable-call", { filePath: "report.txt" });

		const first = await execute();
		expect(sends).toHaveLength(1);
		expect(sends[0]).toMatchObject({ fileName: "report.txt" });
		expect(sends[0]!.filePath).not.toBe(source);
		expect(readFileSync(sends[0]!.filePath, "utf-8")).toBe("snapshot contents");
		rmSync(source);
		const retry = await execute();

		expect(retry).toEqual(first);
		expect(sends).toHaveLength(1);
	});

	it("prunes expired completions only for an idle session and deletes its outbox on removal", () => {
		const workspace = tempDir();
		const source = join(workspace, "report.txt");
		const outboxDir = join(workspace, "outbox");
		writeFileSync(source, "snapshot");
		const completed: ChannelOutboxRecord = {
			operationId: "send_file_to_channel:durable-a:completed",
			channel: "feishu", chatId: "chat", filePath: "report.txt",
		};
		const pending: ChannelOutboxRecord = { ...completed, operationId: "send_file_to_channel:durable-a:pending" };
		const other: ChannelOutboxRecord = { ...completed, operationId: "send_file_to_channel:durable-b:completed" };
		for (const record of [completed, pending, other]) prepareChannelOutbox(outboxDir, record, source);
		completeChannelOutbox(outboxDir, completed, { text: "sent", details: {} });
		completeChannelOutbox(outboxDir, other, { text: "sent", details: {} });
		const staleTmp = join(outboxDir, "orphan.tmp");
		writeFileSync(staleTmp, "stale");
		const old = new Date(Date.now() - 60_000);
		for (const file of readdirSync(outboxDir)) utimesSync(join(outboxDir, file), old, old);

		expect(pruneCompletedChannelOutboxForIdleSession(outboxDir, "durable-a", Date.now())).toBe(1);
		expect(loadChannelOutbox(outboxDir, completed.operationId)).toBeUndefined();
		expect(existsSync(channelOutboxPayloadPath(outboxDir, completed.operationId))).toBe(false);
		expect(loadChannelOutbox(outboxDir, pending.operationId)).toBeDefined();
		expect(loadChannelOutbox(outboxDir, other.operationId)).toBeDefined();
		expect(existsSync(staleTmp)).toBe(false);

		expect(deleteChannelOutboxForSession(outboxDir, "durable-a")).toBe(1);
		expect(loadChannelOutbox(outboxDir, pending.operationId)).toBeUndefined();
		expect(loadChannelOutbox(outboxDir, other.operationId)).toBeDefined();
	});
});
