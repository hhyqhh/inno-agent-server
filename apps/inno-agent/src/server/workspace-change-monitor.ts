import { existsSync, statSync, watch } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { logger } from "../logger.js";
import { WORKSPACE_IGNORES } from "./file-helpers.js";

export interface WorkspaceFileChange {
	path: string;
	change: "created" | "modified" | "deleted";
}

export interface WorkspaceChangeMonitor {
	noteToolEnd(toolCallId: string, toolName: string): void;
	close(): void;
}

const MAX_WORKSPACE_CHANGE_EVENTS = 40;
const WORKSPACE_CHANGE_SETTLE_MS = 80;

export function createWorkspaceChangeMonitor(
	rootDir: string | null,
	publish: (event: unknown) => void,
): WorkspaceChangeMonitor | null {
	if (!rootDir || !existsSync(rootDir)) return null;
	const root = resolve(rootDir);
	const pending = new Map<string, "change" | "rename">();
	let context: { toolCallId: string; toolName: string } | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;

	const flush = () => {
		if (timer) clearTimeout(timer);
		timer = null;
		if (pending.size === 0 || !context) return;
		const entries = Array.from(pending.entries());
		pending.clear();
		const changes: WorkspaceFileChange[] = [];
		for (const [path, eventType] of entries.slice(0, MAX_WORKSPACE_CHANGE_EVENTS)) {
			const fullPath = resolve(root, path);
			if (existsSync(fullPath)) {
				try {
					if (!statSync(fullPath).isFile()) continue;
				} catch {
					continue;
				}
				changes.push({ path, change: eventType === "rename" ? "created" : "modified" });
			} else {
				changes.push({ path, change: "deleted" });
			}
		}
		if (changes.length > 0) {
			publish({
				type: "workspace_change",
				...context,
				changes,
				truncated: entries.length > MAX_WORKSPACE_CHANGE_EVENTS,
			});
		}
	};

	const scheduleFlush = () => {
		if (!context || closed) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(flush, WORKSPACE_CHANGE_SETTLE_MS);
	};

	let watcher: ReturnType<typeof watch>;
	try {
		watcher = watch(root, { recursive: true }, (eventType, filename) => {
			if (!filename || closed) return;
			const fullPath = resolve(root, filename.toString());
			const relativePath = relative(root, fullPath);
			if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return;
			const normalizedPath = relativePath.replaceAll("\\", "/");
			if (normalizedPath.split("/").some((part) => WORKSPACE_IGNORES.has(part))) return;
			pending.set(normalizedPath, eventType);
			scheduleFlush();
		});
	} catch (err) {
		logger.warn({ err, root }, "workspace file monitoring unavailable");
		return null;
	}

	watcher.on("error", (err) => {
		logger.warn({ err, root }, "workspace file monitor failed");
	});

	return {
		noteToolEnd(toolCallId, toolName) {
			context = { toolCallId, toolName };
			scheduleFlush();
		},
		close() {
			closed = true;
			flush();
			watcher.close();
		},
	};
}
