import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { cpus, totalmem, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { DurableSessionRuntime } from "./durable-runtime.js";
import { durableEntriesToMessages } from "./durable-projection.js";

interface CapacityOptions {
	sessions: number;
	runs: number;
	concurrency: number;
	delayMs: number;
	output?: string;
	keepData: boolean;
	skipRecovery: boolean;
}

interface Distribution {
	samples: number;
	min: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
	mean: number;
}

interface SessionBench {
	runtime: DurableSessionRuntime;
	provider: FauxProviderHandle;
	probe: DatabaseSync;
	probeStatement: ReturnType<DatabaseSync["prepare"]>;
}

const USAGE = `Usage: npm run benchmark:durable -- [options]

Options:
  --sessions <n>       Independent durable sessions (default: 8)
  --runs <n>           Total turns, distributed over sessions (default: sessions)
  --concurrency <n>    Active turns, at most one per session (default: sessions)
  --delay-ms <n>       Artificial faux-provider delay per turn (default: 100)
  --output <path>      Also write the JSON report to this path
  --keep-data          Retain the temporary SQLite data root
  --skip-recovery      Skip the real SIGKILL/reopen recovery measurement
  --help               Show this help

This benchmark uses only in-process faux providers. It never calls a paid or
remote model endpoint. One turn per independent session is active at a time.`;

function positiveInteger(value: string, flag: string, allowZero = false): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
		throw new Error(`${flag} requires ${allowZero ? "a non-negative" : "a positive"} integer`);
	}
	return parsed;
}

function parseOptions(argv: string[]): CapacityOptions | undefined {
	if (argv.includes("--help")) {
		console.log(USAGE);
		return undefined;
	}
	const values = new Map<string, string>();
	const flags = new Set<string>();
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (["--keep-data", "--skip-recovery"].includes(arg)) {
			flags.add(arg);
			continue;
		}
		if (!["--sessions", "--runs", "--concurrency", "--delay-ms", "--output"].includes(arg)) {
			throw new Error(`Unknown option: ${arg}\n\n${USAGE}`);
		}
		const value = argv[++index];
		if (!value) throw new Error(`${arg} requires a value`);
		values.set(arg, value);
	}
	const sessions = positiveInteger(values.get("--sessions") ?? "8", "--sessions");
	const runs = positiveInteger(values.get("--runs") ?? String(sessions), "--runs");
	const concurrency = positiveInteger(values.get("--concurrency") ?? String(sessions), "--concurrency");
	if (concurrency > sessions) throw new Error("--concurrency cannot exceed --sessions (one active turn per session)");
	return {
		sessions,
		runs,
		concurrency,
		delayMs: positiveInteger(values.get("--delay-ms") ?? "100", "--delay-ms", true),
		...(values.has("--output") ? { output: resolve(values.get("--output")!) } : {}),
		keepData: flags.has("--keep-data"),
		skipRecovery: flags.has("--skip-recovery"),
	};
}

function round(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}

function distribution(samples: number[]): Distribution {
	const sorted = [...samples].sort((a, b) => a - b);
	const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
	return {
		samples: samples.length,
		min: round(sorted[0]!),
		p50: round(percentile(0.50)),
		p95: round(percentile(0.95)),
		p99: round(percentile(0.99)),
		max: round(sorted.at(-1)!),
		mean: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
	};
}

function eventLoopDistribution(histogram: ReturnType<typeof monitorEventLoopDelay>): Distribution {
	if (histogram.count === 0) return { samples: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
	return {
		samples: histogram.count,
		min: round(histogram.min / 1e6),
		p50: round(histogram.percentile(50) / 1e6),
		p95: round(histogram.percentile(95) / 1e6),
		p99: round(histogram.percentile(99) / 1e6),
		max: round(histogram.max / 1e6),
		mean: round(histogram.mean / 1e6),
	};
}

function mib(bytes: number): number {
	return round(bytes / (1024 * 1024));
}

function waitForOutput(child: ChildProcess, marker: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${marker}; stdout=${stdout}; stderr=${stderr}`)), 15_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			if (stdout.includes(marker)) {
				clearTimeout(timeout);
				resolve();
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.once("error", (error) => { clearTimeout(timeout); reject(error); });
		child.once("exit", (code) => {
			if (!stdout.includes(marker)) {
				clearTimeout(timeout);
				reject(new Error(`Crash fixture exited ${code}; stdout=${stdout}; stderr=${stderr}`));
			}
		});
	});
}

async function measureRecovery(root: string): Promise<{ wallMs: number; providerCalls: number; userMessages: number }> {
	const storagePath = join(root, "recovery.sqlite");
	const fixture = fileURLToPath(new URL("./durable-crash-fixture.ts", import.meta.url));
	const child = spawn(process.execPath, ["--import", "tsx", fixture, storagePath], {
		cwd: process.cwd(),
		env: { ...process.env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let runtime: DurableSessionRuntime | undefined;
	try {
		await waitForOutput(child, "model-started");
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;

		const provider = fauxProvider();
		const models = createModels();
		models.setProvider(provider.provider);
		provider.setResponses([fauxAssistantMessage("recovered capacity answer")]);
		const started = performance.now();
		runtime = await DurableSessionRuntime.open({
			storagePath,
			models,
			model: { provider: provider.provider.id, modelId: provider.getModel().id },
		});
		// Repeating the exact stored request reacquires the admitted submission;
		// it must not append a synthetic user turn.
		const submission = await runtime.submit("persist this before the crash", "crash-request");
		const result = await runtime.waitForSubmission(submission.id);
		if (result.status !== "done" || result.text !== "recovered capacity answer") {
			throw new Error(`Recovery did not complete with the expected answer: ${JSON.stringify(result)}`);
		}
		const messages = durableEntriesToMessages((await runtime.snapshot()).entries);
		const userMessages = messages.filter((message) => message.role === "user").length;
		if (userMessages !== 1) throw new Error(`Recovery duplicated durable user input: ${userMessages}`);
		return { wallMs: round(performance.now() - started), providerCalls: provider.state.callCount, userMessages };
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await runtime?.close();
	}
}

async function main(options: CapacityOptions): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "inno-durable-capacity-"));
	const sessions: SessionBench[] = [];
	const eventLoop = monitorEventLoopDelay({ resolution: 20 });
	let peakRss = process.memoryUsage().rss;
	let peakHeap = process.memoryUsage().heapUsed;
	const memorySampler = setInterval(() => {
		peakRss = Math.max(peakRss, process.memoryUsage().rss);
		peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
	}, 10);
	memorySampler.unref();
	const startedRss = process.memoryUsage().rss;
	let report: Record<string, unknown>;
	try {
		const openStarted = performance.now();
		for (let index = 0; index < options.sessions; index++) {
			const provider = fauxProvider();
			const models = createModels();
			models.setProvider(provider.provider);
			const runCount = Math.floor(options.runs / options.sessions) + (index < options.runs % options.sessions ? 1 : 0);
			const response = async () => {
				if (options.delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, options.delayMs));
				return fauxAssistantMessage(`capacity response ${provider.state.callCount}`);
			};
			provider.setResponses(Array.from({ length: runCount }, () => response));
			const storagePath = join(root, `session-${index}.sqlite`);
			const runtime = await DurableSessionRuntime.open({
				storagePath,
				models,
				model: { provider: provider.provider.id, modelId: provider.getModel().id },
			});
			const probe = new DatabaseSync(storagePath, { readOnly: true });
			sessions.push({ runtime, provider, probe, probeStatement: probe.prepare("SELECT COUNT(*) AS count FROM sqlite_schema") });
		}
		const openMs = performance.now() - openStarted;
		const openRss = process.memoryUsage().rss;
		eventLoop.enable();
		eventLoop.reset();
		const admissionMs: number[] = [];
		const turnMs: number[] = [];
		const snapshotMs: number[] = [];
		const sqliteProbeMs: number[] = [];
		let nextRun = 0;
		let activeRuns = 0;
		let maxActiveRuns = 0;
		let failure: unknown;
		const loadStarted = performance.now();
		const worker = async () => {
			while (!failure) {
				const run = nextRun++;
				if (run >= options.runs) return;
				const session = sessions[run % sessions.length]!;
				activeRuns += 1;
				maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
				try {
					const turnStarted = performance.now();
					const submissionStarted = performance.now();
					const submission = await session.runtime.submit(`capacity prompt ${run}`, `capacity-request-${run}`);
					admissionMs.push(performance.now() - submissionStarted);
					const result = await session.runtime.waitForSubmission(submission.id);
					if (result.status !== "done") throw new Error(`Turn ${run} was unanswered: ${result.reason}`);
					turnMs.push(performance.now() - turnStarted);
					const snapshotStarted = performance.now();
					await session.runtime.snapshot();
					snapshotMs.push(performance.now() - snapshotStarted);
					const probeStarted = performance.now();
					session.probeStatement.get();
					sqliteProbeMs.push(performance.now() - probeStarted);
				} catch (error) {
					failure ??= error;
				} finally {
					activeRuns -= 1;
				}
			}
		};
		await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
		const loadMs = performance.now() - loadStarted;
		eventLoop.disable();
		if (failure) throw failure;
		const closeStarted = performance.now();
		for (const session of sessions) {
			session.probe.close();
			await session.runtime.close();
		}
		const closeMs = performance.now() - closeStarted;
		const finalRss = process.memoryUsage().rss;
		report = {
			schemaVersion: 1,
			createdAt: new Date().toISOString(),
			environment: {
				node: process.version,
				platform: process.platform,
				arch: process.arch,
				logicalCpus: cpus().length,
				totalMemoryMiB: mib(totalmem()),
			},
			config: {
				sessions: options.sessions,
				runs: options.runs,
				concurrency: options.concurrency,
				providerDelayMs: options.delayMs,
				provider: "faux (no network or paid model calls)",
			},
			load: {
				openMs: round(openMs),
				wallMs: round(loadMs),
				closeMs: round(closeMs),
				maxActiveRuns,
				throughputRunsPerSecond: round(options.runs / (loadMs / 1_000)),
				admissionMs: distribution(admissionMs),
				turnMs: distribution(turnMs),
				snapshotReadMs: distribution(snapshotMs),
				sqliteProbeMs: distribution(sqliteProbeMs),
				eventLoopLagMs: eventLoopDistribution(eventLoop),
				memory: {
					startRssMiB: mib(startedRss),
					openRssMiB: mib(openRss),
					peakRssMiB: mib(peakRss),
					peakHeapUsedMiB: mib(peakHeap),
					finalRssMiB: mib(finalRss),
				},
			},
		};
		if (!options.skipRecovery) report.recovery = await measureRecovery(root);
	} finally {
		clearInterval(memorySampler);
		eventLoop.disable();
		for (const session of sessions) {
			try { session.probe.close(); } catch { /* already closed */ }
			await session.runtime.close().catch(() => undefined);
		}
		if (!options.keepData) rmSync(root, { recursive: true, force: true });
	}

	if (options.keepData) report.dataRoot = root;
	const serialized = `${JSON.stringify(report, null, 2)}\n`;
	if (options.output) {
		await mkdir(dirname(options.output), { recursive: true });
		await writeFile(options.output, serialized, "utf-8");
	}
	console.log(serialized);
}

try {
	const options = parseOptions(process.argv.slice(2));
	if (options) await main(options);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
