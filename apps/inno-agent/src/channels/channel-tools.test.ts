import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceRegistry } from "../workspace/workspace-registry.js";
import { ChannelRegistry } from "./channel.js";
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

describe("tenant-safe channel file tools", () => {
	it("sends from the active session workspace to the scoped default target", async () => {
		const workspace = tempDir();
		const fallback = tempDir();
		writeFileSync(join(workspace, "report.txt"), "tenant file");
		writeFileSync(join(fallback, "report.txt"), "global file");
		const { sends, tool } = setup(workspace, fallback);

		const result = await tool.execute("call", { filePath: "report.txt" }, undefined, undefined, {} as never);

		expect(result.details).toMatchObject({ channel: "feishu", chatId: "tenant-chat" });
		expect(sends).toEqual([{ target: { channel: "feishu", chatId: "tenant-chat" }, filePath: join(workspace, "report.txt") }]);
	});

	it("fails closed when the tenant workspace cannot be resolved", async () => {
		const fallback = tempDir();
		writeFileSync(join(fallback, "report.txt"), "global file");
		const { sends, tool } = setup(null, fallback);

		const result = await tool.execute("call", { filePath: "report.txt" }, undefined, undefined, {} as never);

		expect(result.details).toMatchObject({ error: "workspace_unavailable" });
		expect(sends).toEqual([]);
	});
});
