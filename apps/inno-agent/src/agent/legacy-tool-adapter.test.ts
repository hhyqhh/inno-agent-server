import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { defineInnoTool } from "./inno-tool.js";
import { createLegacyToolDefinitions } from "./legacy-tool-adapter.js";

describe("createLegacyToolDefinitions", () => {
	it("keeps the legacy execution ABI at the legacy registration boundary", async () => {
		const controller = new AbortController();
		const execute = vi.fn(async (params: { value: string }, api: any, context: any) => {
			api.output("partial");
			await api.details({ phase: "working" });
			expect(api.callId).toBe("legacy-call");
			expect(api.innoLegacy).toMatchObject({
				cwd: "/tmp/workspace",
				model: "legacy-model",
				modelRegistry: "legacy-registry",
				sessionId: "/tmp/session.jsonl",
			});
			expect(context.abortSignal).toBe(controller.signal);
			return { content: [{ type: "text" as const, text: params.value }], details: { done: true } };
		});
		const native = defineInnoTool({
			name: "native_probe",
			label: "Native probe",
			description: "Probe the legacy adapter",
			parameters: Type.Object({ value: Type.String() }),
			execute,
		});
		const [legacy] = createLegacyToolDefinitions([native]);
		const onUpdate = vi.fn();
		const result = await legacy.execute(
			"legacy-call",
			{ value: "done" },
			controller.signal,
			onUpdate,
			{
				cwd: "/tmp/workspace",
				model: "legacy-model",
				modelRegistry: "legacy-registry",
				sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
			} as never,
		);

		expect(execute).toHaveBeenCalledOnce();
		expect(result).toMatchObject({
			content: [{ type: "text", text: "done" }],
			details: { done: true },
		});
		expect(onUpdate).toHaveBeenCalledWith({ content: [{ type: "text", text: "partial" }], details: {} });
		expect(onUpdate).toHaveBeenCalledWith({
			content: [{ type: "text", text: "partial" }],
			details: { phase: "working" },
		});
	});
});
