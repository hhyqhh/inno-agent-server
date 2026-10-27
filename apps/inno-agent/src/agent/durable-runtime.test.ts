import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef, SubmissionId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { durableEntriesToMessages } from "./durable-projection.js";
import { DurableSessionRuntime, DurableStorageOwnerError } from "./durable-runtime.js";
import { loadEvents, loadProfile } from "../memory/learner/profile-store.js";
import { readManifest } from "../memory/l2/manifest-store.js";
import { ChannelRegistry } from "../channels/channel.js";
import { DurableQuestionStore } from "./durable-questions.js";
import { buildImagePathsHint } from "../server/inline-images.js";

interface FauxRuntime {
	faux: FauxProviderHandle;
	models: Models;
	model: ModelRef;
}

function fauxRuntime(): FauxRuntime {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return {
		faux,
		models,
		model: { provider: faux.provider.id, modelId: faux.getModel().id },
	};
}

function waitForOutput(child: ChildProcess, marker: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${marker}; stdout=${stdout}; stderr=${stderr}`)), 10_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			if (stdout.includes(marker)) {
				clearTimeout(timeout);
				resolve(stdout);
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("exit", (code) => {
			if (!stdout.includes(marker)) {
				clearTimeout(timeout);
				reject(new Error(`Crash fixture exited ${code}; stdout=${stdout}; stderr=${stderr}`));
			}
		});
	});
}

const tempRoots: string[] = [];
const openRuntimes: DurableSessionRuntime[] = [];
const children = new Set<ChildProcess>();

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "inno-durable-runtime-"));
	tempRoots.push(root);
	return root;
}

async function open(options: Parameters<typeof DurableSessionRuntime.open>[0]): Promise<DurableSessionRuntime> {
	const runtime = await DurableSessionRuntime.open(options);
	openRuntimes.push(runtime);
	return runtime;
}

async function waitForText(runtime: DurableSessionRuntime, id: SubmissionId): Promise<string> {
	const result = await runtime.waitForSubmission(id);
	if (result.status !== "done") throw new Error(`Submission was unanswered: ${result.reason}`);
	return result.text;
}

afterEach(async () => {
	await Promise.all(openRuntimes.splice(0).map((runtime) => runtime.close().catch(() => undefined)));
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	children.clear();
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DurableSessionRuntime", () => {
	it("keeps concurrent sessions and request-id namespaces isolated", async () => {
		const root = tempRoot();
		const a = fauxRuntime();
		const b = fauxRuntime();
		a.faux.setResponses([fauxAssistantMessage("answer for A")]);
		b.faux.setResponses([fauxAssistantMessage("answer for B")]);
		const runtimeA = await open({ storagePath: join(root, "a.sqlite"), ...a });
		const runtimeB = await open({ storagePath: join(root, "b.sqlite"), ...b });

		const [submissionA, submissionB] = await Promise.all([
			runtimeA.submit("question A", "shared-client-request"),
			runtimeB.submit("question B", "shared-client-request"),
		]);
		const [resultA, resultB] = await Promise.all([
			runtimeA.waitForSubmission(submissionA.id),
			runtimeB.waitForSubmission(submissionB.id),
		]);

		expect(resultA).toMatchObject({ status: "done", text: "answer for A" });
		expect(resultB).toMatchObject({ status: "done", text: "answer for B" });
		const messagesA = durableEntriesToMessages((await runtimeA.snapshot()).entries);
		const messagesB = durableEntriesToMessages((await runtimeB.snapshot()).entries);
		expect(messagesA.map((message) => message.content)).toEqual(["question A", "answer for A"]);
		expect(messagesB.map((message) => message.content)).toEqual(["question B", "answer for B"]);
	});

	it("deduplicates concurrent and post-reopen submissions by requestId", async () => {
		const root = tempRoot();
		const provider = fauxRuntime();
		provider.faux.setResponses([fauxAssistantMessage("only once")]);
		const storagePath = join(root, "session.sqlite");
		let runtime = await open({ storagePath, ...provider });
		const first = await runtime.submit("do not duplicate", "same-request");
		const duplicate = await runtime.submit("do not duplicate", "same-request");
		expect(duplicate.id).toBe(first.id);
		expect(await waitForText(runtime, first.id)).toBe("only once");
		expect(provider.faux.state.callCount).toBe(1);
		await runtime.close();
		openRuntimes.splice(openRuntimes.indexOf(runtime), 1);

		runtime = await open({ storagePath, ...provider });
		const afterReopen = await runtime.submit("do not duplicate", "same-request");
		expect(afterReopen.id).toBe(first.id);
		expect(await waitForText(runtime, first.id)).toBe("only once");
		expect(provider.faux.state.callCount).toBe(1);
		expect(durableEntriesToMessages((await runtime.snapshot()).entries).filter((message) => message.role === "user")).toHaveLength(1);
	});

	it("retries rejected native images with committed OCR context in the same submission", async () => {
		const root = tempRoot();
		const provider = fauxRuntime();
		const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
		const hint = buildImagePathsHint([".chat-images/image.png"]);
		provider.faux.setResponses([
			(context) => {
				const body = JSON.stringify(context);
				expect(body).toContain('"type":"image"');
				expect(body).not.toContain("用户本轮上传了");
				return fauxAssistantMessage([], {
					stopReason: "error", errorMessage: "unknown variant 'image_url', expected 'text'",
				});
			},
			(context) => {
				const body = JSON.stringify(context);
				expect(body).not.toContain('"type":"image"');
				expect(body).toContain("用户本轮上传了");
				expect(body).toContain(".chat-images/image.png");
				return fauxAssistantMessage("fallback complete");
			},
			(context) => {
				// Capability rejections skip native images for later turns in this runtime.
				expect(JSON.stringify(context)).not.toContain('"type":"image"');
				return fauxAssistantMessage("next fallback complete");
			},
		]);
		const runtime = await open({ storagePath: join(root, "image-fallback.sqlite"), ...provider });
		const content = [{ type: "text" as const, text: "inspect image" }, image, { type: "text" as const, text: hint }];
		const submission = await runtime.submit(content, "image-fallback-request");
		expect(await waitForText(runtime, submission.id)).toBe("fallback complete");
		expect(provider.faux.state.callCount).toBe(2);

		const duplicate = await runtime.submit(content, "image-fallback-request");
		expect(duplicate.id).toBe(submission.id);
		expect(await waitForText(runtime, duplicate.id)).toBe("fallback complete");
		expect(provider.faux.state.callCount).toBe(2);
		const next = await runtime.submit([
			{ type: "text", text: "inspect another image" }, image, { type: "text", text: hint },
		], "next-image-fallback-request");
		expect(await waitForText(runtime, next.id)).toBe("next fallback complete");
		expect(provider.faux.state.callCount).toBe(3);
		expect(durableEntriesToMessages((await runtime.snapshot()).entries)
			.filter((message) => message.role === "user").map((message) => message.content))
			.toEqual(["inspect image", "inspect another image"]);
	});

	it("persists turn cancellation across close and reopen", async () => {
		const root = tempRoot();
		const storagePath = join(root, "abort.sqlite");
		const provider = fauxRuntime();
		let notifyStarted!: () => void;
		const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
		provider.faux.setResponses([async (_context, options) => {
			notifyStarted();
			const signal = options?.signal;
			if (!signal) throw new Error("Expected a model abort signal");
			await new Promise<void>((resolve) => {
				if (signal.aborted) { resolve(); return; }
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return fauxAssistantMessage("unreachable");
		}]);
		let runtime = await open({ storagePath, ...provider });
		const submission = await runtime.submit("cancel this turn", "abort-request");
		await started;
		await runtime.abort();
		expect(await runtime.waitForSubmission(submission.id)).toMatchObject({ status: "unanswered" });
		expect(provider.faux.state.callCount).toBe(1);
		await runtime.close();
		openRuntimes.splice(openRuntimes.indexOf(runtime), 1);

		runtime = await open({ storagePath, ...provider });
		expect(await runtime.waitForSubmission(submission.id)).toMatchObject({ status: "unanswered" });
		expect(provider.faux.state.callCount).toBe(1);
		provider.faux.appendResponses([fauxAssistantMessage("next turn works")]);
		const next = await runtime.submit("continue", "after-abort-request");
		expect(await waitForText(runtime, next.id)).toBe("next turn works");
	});

	it("runs the optional read tool inside the workspace and records its result", async () => {
		const root = tempRoot();
		writeFileSync(join(root, "note.txt"), "workspace note");
		const provider = fauxRuntime();
		provider.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "note.txt" }, { id: "read-note" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("read complete"),
		]);
		const runtime = await open({
			storagePath: join(root, "session.sqlite"),
			workspaceDir: root,
			readOnlyTools: true,
			...provider,
		});
		const submission = await runtime.submit("read my note", "read-request");
		expect(await waitForText(runtime, submission.id)).toBe("read complete");
		const messages = durableEntriesToMessages((await runtime.snapshot()).entries);
		const tool = messages.flatMap((message) => message.tools ?? []).find((call) => call.toolCallId === "read-note");
		expect(tool).toMatchObject({ toolName: "read", isError: false });
		expect(JSON.stringify(tool?.result)).toContain("workspace note");
	});

	it("runs replay-safe tenant memory tools without duplicate writes after reopen", async () => {
		const root = tempRoot();
		const provider = fauxRuntime();
		provider.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("record_learning_event", {
				event_type: "goal_declared",
				context: { goal_id: "goal-rust" },
				payload: { goal_description: "学习 Rust", action: "active" },
			}, { id: "memory-event" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("l2_archive", {
				title: "Rust 所有权",
				content: "所有权与借用基础",
				sourceType: "markdown",
			}, { id: "memory-archive" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("memory complete"),
		]);
		const storagePath = join(root, "session.sqlite");
		const memory = {
			sessionId: "durable-memory-test",
			learnerDataDir: join(root, "tenant", "learner"),
			l2DataDir: join(root, "tenant", "l2"),
			workspaceDir: root,
			l1Enabled: true,
			l2Enabled: true,
		};
		let runtime = await open({ storagePath, memory, ...provider });
		const submission = await runtime.submit("remember this", "memory-request");
		expect(await waitForText(runtime, submission.id)).toBe("memory complete");
		expect(provider.faux.state.callCount).toBe(3);
		expect(loadEvents(memory.learnerDataDir)).toHaveLength(1);
		expect(loadProfile(memory.learnerDataDir).applied_operation_ids).toEqual([
			"record_learning_event:durable-memory-test:memory-event",
		]);
		expect(readManifest(memory.l2DataDir)).toHaveLength(1);
		await runtime.close();
		openRuntimes.splice(openRuntimes.indexOf(runtime), 1);

		runtime = await open({ storagePath, memory, ...provider });
		const duplicate = await runtime.submit("remember this", "memory-request");
		expect(duplicate.id).toBe(submission.id);
		expect(await waitForText(runtime, duplicate.id)).toBe("memory complete");
		expect(provider.faux.state.callCount).toBe(3);
		expect(loadEvents(memory.learnerDataDir)).toHaveLength(1);
		expect(readManifest(memory.l2DataDir)).toHaveLength(1);
	});

	it("enforces one in-process owner and leaves unrelated legacy JSONL untouched", async () => {
		const root = tempRoot();
		const provider = fauxRuntime();
		provider.faux.setResponses([fauxAssistantMessage("ok")]);
		const storagePath = join(root, "durable", "session.sqlite");
		const legacyPath = join(root, "sessions", "legacy.jsonl");
		mkdirSync(join(root, "sessions"), { recursive: true });
		writeFileSync(legacyPath, "{\"type\":\"session\"}\n", { flag: "wx" });
		const before = readFileSync(legacyPath, "utf-8");
		const runtime = await open({ storagePath, ...provider });
		await expect(open({ storagePath, ...provider })).rejects.toBeInstanceOf(DurableStorageOwnerError);
		symlinkSync(join(root, "durable"), join(root, "durable-alias"), "dir");
		await expect(open({ storagePath: join(root, "durable-alias", "session.sqlite"), ...provider }))
			.rejects.toBeInstanceOf(DurableStorageOwnerError);
		const submission = await runtime.submit("hello", "request-1");
		await runtime.waitForSubmission(submission.id);
		expect(readFileSync(legacyPath, "utf-8")).toBe(before);
		await runtime.close();
		openRuntimes.splice(openRuntimes.indexOf(runtime), 1);
		const reopened = await open({ storagePath, ...provider });
		expect((await reopened.snapshot()).entries.length).toBeGreaterThan(0);
	});

	it("resumes an admitted submission after the owner process is killed", async () => {
		const root = tempRoot();
		const storagePath = join(root, "crash.sqlite");
		const fixture = fileURLToPath(new URL("./durable-crash-fixture.ts", import.meta.url));
		const child = spawn(process.execPath, ["--import", "tsx", fixture, storagePath], {
			cwd: process.cwd(),
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.add(child);
		const output = await waitForOutput(child, "model-started");
		const submissionId = Number(/submission:(\d+)/.exec(output)?.[1]) as SubmissionId;
		expect(Number.isInteger(submissionId)).toBe(true);
		child.kill("SIGKILL");
		await once(child, "exit");
		children.delete(child);

		const provider = fauxRuntime();
		provider.faux.setResponses([fauxAssistantMessage("recovered after crash")]);
		const runtime = await open({ storagePath, ...provider });
		const recovered = await runtime.waitForSubmission(submissionId);
		expect(recovered).toMatchObject({ status: "done", text: "recovered after crash" });
		const duplicate = await runtime.submit("persist this before the crash", "crash-request");
		expect(duplicate.id).toBe(submissionId);
		const messages = durableEntriesToMessages((await runtime.snapshot()).entries);
		expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(messages.at(-1)?.content).toBe("recovered after crash");
		expect(provider.faux.state.callCount).toBe(1);
	}, 20_000);

	it("replays an interrupted memory tool without duplicating its event or profile signals", async () => {
		const root = tempRoot();
		const storagePath = join(root, "memory-crash.sqlite");
		const dataRoot = join(root, "tenant");
		const fixture = fileURLToPath(new URL("./durable-memory-crash-fixture.ts", import.meta.url));
		const child = spawn(process.execPath, ["--import", "tsx", fixture, storagePath, dataRoot], {
			cwd: process.cwd(),
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.add(child);
		const output = await waitForOutput(child, "event-applied-before-profile-commit");
		const submissionId = Number(/submission:(\d+)/.exec(output)?.[1]) as SubmissionId;
		expect(Number.isInteger(submissionId)).toBe(true);
		await once(child, "exit");
		children.delete(child);

		const provider = fauxRuntime();
		provider.faux.setResponses([fauxAssistantMessage("memory recovered")]);
		const memory = {
			sessionId: "durable-crash-memory",
			learnerDataDir: join(dataRoot, "learner"),
			l2DataDir: join(dataRoot, "l2"),
			workspaceDir: dataRoot,
			l1Enabled: true,
			l2Enabled: true,
		};
		const runtime = await open({ storagePath, memory, ...provider });
		const recovered = await runtime.waitForSubmission(submissionId);
		expect(recovered).toMatchObject({ status: "done", text: "memory recovered" });
		expect(provider.faux.state.callCount).toBe(1);
		const events = loadEvents(memory.learnerDataDir);
		const profile = loadProfile(memory.learnerDataDir);
		expect(events).toHaveLength(1);
		expect(profile.applied_operation_ids).toEqual([
			"record_learning_event:durable-crash-memory:crash-memory-event",
		]);
		expect(profile.knowledge_states[0]).toMatchObject({
			concept_id: "physics.force_decomposition",
			evidence_ids: [events[0]!.event_id],
		});
	}, 20_000);

	it("resumes a submitted OCR job after SIGKILL without submitting it again", async () => {
		const root = tempRoot();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		writeFileSync(join(workspace, "note.png"), "fixture image");
		let submissions = 0;
		let polls = 0;
		let resultFetches = 0;
		let finished = false;
		let notifyFirstPoll!: () => void;
		const firstPoll = new Promise<void>((resolveFirstPoll) => { notifyFirstPoll = resolveFirstPoll; });
		const server = createHttpServer((req, res) => {
			const path = new URL(req.url ?? "/", "http://ocr.local").pathname;
			if (req.method === "POST" && path === "/jobs") {
				submissions += 1;
				req.resume();
				req.on("end", () => {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ data: { jobId: "ocr-crash-job" } }));
				});
				return;
			}
			if (req.method === "GET" && path === "/jobs/ocr-crash-job") {
				polls += 1;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ data: finished ? {
					state: "done",
					resultUrl: { jsonUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/result` },
				} : { state: "running" } }));
				if (polls === 1) notifyFirstPoll();
				return;
			}
			if (req.method === "GET" && path === "/result") {
				resultFetches += 1;
				res.writeHead(200, { "Content-Type": "application/x-ndjson" });
				res.end(`${JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: "崩溃后恢复的 OCR 文本" } }] } })}\n`);
				return;
			}
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jobs`;
		try {
			const storagePath = join(root, "ocr-crash.sqlite");
			const checkpointDir = join(root, "tenant", "ocr");
			const fixture = fileURLToPath(new URL("./durable-ocr-crash-fixture.ts", import.meta.url));
			const child = spawn(process.execPath, ["--import", "tsx", fixture, storagePath, checkpointDir, workspace, baseUrl], {
				cwd: process.cwd(),
				env: { ...process.env },
				stdio: ["ignore", "pipe", "pipe"],
			});
			children.add(child);
			const output = await waitForOutput(child, "submission:");
			const submissionId = Number(/submission:(\d+)/.exec(output)?.[1]) as SubmissionId;
			await firstPoll;
			child.kill("SIGKILL");
			await once(child, "exit");
			children.delete(child);
			finished = true;

			const provider = fauxRuntime();
			provider.faux.setResponses([fauxAssistantMessage("ocr recovered")]);
			const runtime = await open({
				storagePath,
				workspaceDir: workspace,
				ocr: {
					sessionId: "durable-crash-ocr",
					checkpointDir,
					workspaceDir: workspace,
					ocrApi: { token: "fixture-token", baseUrl },
				},
				...provider,
			});
			const recovered = await runtime.waitForSubmission(submissionId);
			expect(recovered).toMatchObject({ status: "done", text: "ocr recovered" });
			expect(submissions).toBe(1);
			expect(polls).toBeGreaterThanOrEqual(2);
			expect(resultFetches).toBe(1);
			const messages = durableEntriesToMessages((await runtime.snapshot()).entries);
			const tool = messages.flatMap((message) => message.tools ?? []).find((call) => call.toolCallId === "crash-ocr-call");
			expect(JSON.stringify(tool?.result)).toContain("崩溃后恢复的 OCR 文本");
		} finally {
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		}
	}, 20_000);

	it("replays an unconfirmed channel send from its outbox snapshot after SIGKILL", async () => {
		const root = tempRoot();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const source = join(workspace, "report.txt");
		writeFileSync(source, "outbox snapshot contents");
		const storagePath = join(root, "channel-crash.sqlite");
		const outboxDir = join(root, "tenant", "channels", "outbox");
		const fixture = fileURLToPath(new URL("./durable-channel-crash-fixture.ts", import.meta.url));
		const child = spawn(process.execPath, ["--import", "tsx", fixture, storagePath, outboxDir, workspace], {
			cwd: process.cwd(),
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.add(child);
		const output = await waitForOutput(child, "file-sent-before-outbox-commit");
		const submissionId = Number(/submission:(\d+)/.exec(output)?.[1]) as SubmissionId;
		expect(output).toContain("file-sent-before-outbox-commit:outbox snapshot contents");
		await once(child, "exit");
		children.delete(child);
		rmSync(source);

		const sends: Array<{ chatId: string; fileName?: string; contents: string }> = [];
		const channelRegistry = new ChannelRegistry();
		channelRegistry.register({
			name: "feishu",
			verify: async () => true,
			parse: async () => null,
			reply: async () => {},
			push: async () => {},
			sendFile: async (target, filePath, fileName) => {
				sends.push({ chatId: target.chatId, fileName, contents: readFileSync(filePath, "utf-8") });
			},
		});
		channelRegistry.setDefaultTarget({ channel: "feishu", chatId: "changed-default-chat" });
		const provider = fauxRuntime();
		provider.faux.setResponses([fauxAssistantMessage("channel recovered")]);
		const runtime = await open({
			storagePath,
			workspaceDir: workspace,
			channels: {
				sessionId: "durable-crash-channel",
				outboxDir,
				workspaceDir: workspace,
				channelRegistry,
			},
			...provider,
		});
		const recovered = await runtime.waitForSubmission(submissionId);

		expect(recovered).toMatchObject({ status: "done", text: "channel recovered" });
		expect(sends).toEqual([{ chatId: "crash-chat", fileName: "report.txt", contents: "outbox snapshot contents" }]);
		const messages = durableEntriesToMessages((await runtime.snapshot()).entries);
		const tool = messages.flatMap((message) => message.tools ?? []).find((call) => call.toolCallId === "crash-channel-call");
		expect(JSON.stringify(tool?.result)).toContain("已把文件 report.txt");
	}, 20_000);

	it("resumes a persisted question answer without asking again after SIGKILL", async () => {
		const root = tempRoot();
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const storagePath = join(root, "question-crash.sqlite");
		const questionDir = join(root, "tenant", "durable", "questions", "durable-crash-question");
		const fixture = fileURLToPath(new URL("./durable-question-crash-fixture.ts", import.meta.url));
		const child = spawn(process.execPath, ["--import", "tsx", fixture, storagePath, questionDir, workspace], {
			cwd: process.cwd(),
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.add(child);
		const output = await waitForOutput(child, "question-answer-persisted:accepted");
		const submissionId = Number(/submission:(\d+)/.exec(output)?.[1]) as SubmissionId;
		await once(child, "exit");
		children.delete(child);

		const provider = fauxRuntime();
		provider.faux.setResponses([fauxAssistantMessage("question answer recovered")]);
		const store = new DurableQuestionStore("durable-crash-question", questionDir);
		const events: Array<Record<string, unknown>> = [];
		store.bindTurn({ turnId: "recovered-turn", emit: (event) => events.push(event) });
		const runtime = await open({
			storagePath,
			workspaceDir: workspace,
			questions: { store, workspaceDir: workspace },
			...provider,
		});
		const recovered = await runtime.waitForSubmission(submissionId);

		expect(recovered).toMatchObject({ status: "done", text: "question answer recovered" });
		expect(events).toEqual([]);
		expect(store.pendingQuestion()).toBeUndefined();
		const messages = durableEntriesToMessages((await runtime.snapshot()).entries);
		const tool = messages.flatMap((message) => message.tools ?? []).find((call) => call.toolCallId === "crash-question-call");
		expect(JSON.stringify(tool?.result)).toContain("继续学习吗？");
		expect(JSON.stringify(tool?.result)).toContain("继续");
	}, 20_000);
});
