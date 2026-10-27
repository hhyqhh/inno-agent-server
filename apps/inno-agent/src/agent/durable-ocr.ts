import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { InnoConfig } from "../config.js";
import type { ConfigHolder } from "./inno-extension.js";
import { createDurableToolRegistrations } from "./durable-tool-adapter.js";
import { createOcrTools } from "./ocr-tools.js";

export interface DurableOcrToolOptions {
	sessionId: string;
	checkpointDir: string;
	workspaceDir: string;
	ocrApi?: InnoConfig["ocrApi"];
}

/** OCR jobs checkpoint their remote job ID before polling and cache the final
 * markdown. The remote API has no idempotency key, so a crash between remote
 * acceptance and the local job-ID commit can still duplicate one submission. */
export function createDurableOcrRegistrations(options: DurableOcrToolOptions): ToolRegistration[] {
	const holder = { current: { ocrApi: options.ocrApi } } as ConfigHolder;
	const tools = createOcrTools(holder, {
		restrictToWorkspace: true,
		durable: {
			checkpointDir: options.checkpointDir,
			getOperationId: (toolCallId) => `ocr_image:${options.sessionId}:${toolCallId}`,
		},
	});
	return createDurableToolRegistrations(tools, { cwd: options.workspaceDir });
}
