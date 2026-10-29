import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { runDurableJobPrompt } from "./durable-job-runner.js";
import type { DurableSessionService } from "./durable-session-service.js";

function fixture(overrides: { pending?: boolean } = {}) {
	const binding = vi.fn();
	const permissionBinding = vi.fn();
	const submit = vi.fn(async () => ({ id: "submission-1" }));
	const stop = vi.fn(async () => undefined);
	const watch = vi.fn(async (callback: (events: any[]) => Promise<void>) => {
		await callback([{ type: "message_update", changes: [{ type: "text_delta", delta: "durable", contentIndex: 0 }] }]);
		return { stop };
	});
	const release = vi.fn(async () => undefined);
	const runtime = {
		bindQuestionTurn: binding,
		unbindQuestionTurn: vi.fn(),
		bindPermissionTurn: permissionBinding,
		unbindPermissionTurn: vi.fn(),
		watch,
		submit,
		waitForSubmission: vi.fn(async () => ({ status: "done", text: "durable answer" })),
	};
	const service = {
		pendingQuestion: vi.fn(() => overrides.pending ? { questionId: "pending" } : undefined),
		pendingPermission: vi.fn(() => undefined),
		prepareImages: vi.fn(() => null),
		recordTurnMetadata: vi.fn(),
		prepareRecallContext: vi.fn(async () => "recalled context"),
		lease: vi.fn(async () => ({ runtime, release })),
		noteSubmission: vi.fn(),
		snapshot: vi.fn(async () => ({})),
		maybeAutoGenerateTopic: vi.fn(async () => undefined),
	};
	return { service: service as unknown as DurableSessionService, binding, permissionBinding, submit, stop, watch, release };
}

const req = {} as IncomingMessage;

describe("runDurableJobPrompt", () => {
	it("uses no_ui for headless runs and commits recall with the raw prompt", async () => {
		const { service, binding, permissionBinding, submit, watch, release } = fixture();
		await expect(runDurableJobPrompt(req, service, "durable-session", "scheduled prompt", {
			requestId: "job-request", turnId: "job-turn",
		})).resolves.toBe("durable answer");
		expect(binding).toHaveBeenCalledWith({ turnId: "job-turn", noUi: true });
		expect(permissionBinding).toHaveBeenCalledWith({ turnId: "job-turn", noUi: true });
		expect(watch).not.toHaveBeenCalled();
		expect(submit).toHaveBeenCalledWith([
			{ type: "text", text: "scheduled prompt" },
			{ type: "text", text: "recalled context" },
		], "job-request");
		expect(release).toHaveBeenCalledOnce();
	});

	it("projects live events and binds streaming questions to the job turn", async () => {
		const { service, binding, permissionBinding, watch, stop } = fixture();
		const onEvent = vi.fn();
		await expect(runDurableJobPrompt(req, service, "durable-session", "stream prompt", {
			requestId: "job-request", turnId: "job-turn", onEvent,
		})).resolves.toBe("durable answer");
		expect(binding).toHaveBeenCalledWith({ turnId: "job-turn", emit: onEvent });
		expect(permissionBinding).toHaveBeenCalledWith({ turnId: "job-turn", emit: onEvent });
		expect(watch).toHaveBeenCalledOnce();
		expect(onEvent).toHaveBeenCalledWith({ type: "text_delta", delta: "durable", contentIndex: 0 });
		expect(stop).toHaveBeenCalledOnce();
	});

	it("keeps streaming channel runs no_ui even while projecting events", async () => {
		const { service, binding, permissionBinding } = fixture();
		const onEvent = vi.fn();
		await runDurableJobPrompt(req, service, "durable-session", "channel prompt", {
			requestId: "channel-request", turnId: "channel-turn", onEvent, noUi: true,
		});
		expect(binding).toHaveBeenCalledWith({ turnId: "channel-turn", emit: onEvent, noUi: true });
		expect(permissionBinding).toHaveBeenCalledWith({ turnId: "channel-turn", emit: onEvent, noUi: true });
	});

	it.each([{ native: true }, { native: false }])("prepares channel images with native=$native and restores their sidecar metadata", async ({ native }) => {
		const { service, submit } = fixture();
		const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
		const prepared = {
			nativeImages: native ? [image] : [],
			images: [{ mimeType: "image/png", workspacePath: ".chat-images/channel.png" }],
			fallbackContext: "Image path hints",
			workspaceId: "workspace-1",
			workspaceRoot: "/tmp/workspace-1",
		};
		vi.mocked(service.prepareImages).mockReturnValue(prepared);

		await runDurableJobPrompt(req, service, "durable-session", "describe this", {
			requestId: "channel-request", turnId: "channel-turn", images: [image], noUi: true,
		});

		expect(service.prepareImages).toHaveBeenCalledWith(req, "durable-session", [image], "channel-request");
		expect(service.recordTurnMetadata).toHaveBeenCalledWith(req, "durable-session", null, prepared, "describe this", "channel-request");
		expect(submit).toHaveBeenCalledWith([
			{ type: "text", text: "describe this" },
			...(native ? [image] : []),
			{ type: "text", text: "Image path hints" },
			{ type: "text", text: "recalled context" },
		], "channel-request");
	});

	it("rejects a pending question before opening a headless run", async () => {
		const { service } = fixture({ pending: true });
		await expect(runDurableJobPrompt(req, service, "durable-session", "prompt", {
			requestId: "job-request", turnId: "job-turn",
		})).rejects.toThrow("pending question");
		expect(service.lease).not.toHaveBeenCalled();
	});
});
