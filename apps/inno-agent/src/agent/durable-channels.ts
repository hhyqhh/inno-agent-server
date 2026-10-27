import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { ChannelRegistry } from "../channels/channel.js";
import { createChannelTools } from "../channels/channel-tools.js";
import { createDurableToolRegistrations } from "./durable-tool-adapter.js";

export interface DurableChannelToolOptions {
	sessionId: string;
	outboxDir: string;
	workspaceDir: string;
	channelRegistry: ChannelRegistry;
}

/** File sends recover from a persisted payload snapshot. Completion caching
 * prevents another send after the marker commits; the earlier crash window is
 * explicitly at-least-once because channel APIs have no common idempotency key. */
export function createDurableChannelRegistrations(options: DurableChannelToolOptions): ToolRegistration[] {
	const tools = createChannelTools({
		channelRegistry: options.channelRegistry,
		workspaceDir: options.workspaceDir,
		allowWorkspaceFallback: true,
		durable: {
			outboxDir: options.outboxDir,
			getOperationId: (toolCallId) => `send_file_to_channel:${options.sessionId}:${toolCallId}`,
		},
	});
	return createDurableToolRegistrations(tools, { cwd: options.workspaceDir });
}
