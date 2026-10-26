import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef, SubmissionId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { durableEntriesToMessages } from "./durable-projection.js";
import { DurableSessionRuntime, DurableStorageOwnerError } from "./durable-runtime.js";

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
});
