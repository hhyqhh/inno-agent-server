import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createDurableToolRegistrations, type DurableExecutableTool } from "./durable-tool-adapter.js";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("createDurableToolRegistrations", () => {
	it("preserves call identity, abort/cwd context, updates and result envelopes", async () => {
		const controller = new AbortController();
		const execute = vi.fn(async (
			_toolCallId: string,
			_params: unknown,
			_signal: AbortSignal | undefined,
			onUpdate: ((partial: { content: Array<{ type: string; text?: string }>; details?: unknown }) => void) | undefined,
		) => {
			onUpdate?.({ content: [{ type: "text", text: "partial" }], details: { progress: 1 } });
			return {
				content: [{ type: "text" as const, text: "done" }],
				details: { persisted: true },
				structuredContent: { value: 1 },
				isError: false,
				usage: zeroUsage,
				terminate: true,
			};
		});
		const tool: DurableExecutableTool = {
			name: "adapter_probe",
			description: "Probe the durable adapter",
			parameters: Type.Object({ value: Type.String() }),
			outputSchema: Type.Object({ value: Type.Number() }),
			executionMode: "sequential",
			execute,
		};
		const [registration] = createDurableToolRegistrations([tool], { cwd: "/tmp/workspace" });
		const api = { callId: "stable-call", output: vi.fn(), details: vi.fn(async () => undefined) };
		const result = await registration.execute(
			{ value: "argument" },
			api as never,
			{ abortSignal: controller.signal } as never,
		);

		expect(execute).toHaveBeenCalledWith(
			"stable-call",
			{ value: "argument" },
			controller.signal,
			expect.any(Function),
			{ cwd: "/tmp/workspace", model: undefined, modelRegistry: undefined },
		);
		expect(api.output).toHaveBeenCalledWith("partial");
		expect(api.details).toHaveBeenCalledWith({ progress: 1 }, { abortSignal: controller.signal });
		expect(result).toMatchObject({
			output: [{ type: "text", text: "done" }],
			details: { persisted: true },
			structuredOutput: { value: 1 },
			isError: false,
			usage: zeroUsage,
			control: { terminate: true },
		});
	});
});
