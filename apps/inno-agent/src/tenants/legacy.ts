import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { RuntimePaths } from "../runtime.js";
import { readJson } from "../storage/file-store.js";
import type { LegacyResourceSet } from "./store.js";
import { TEMP_WORKSPACE_ID } from "../workspace/workspace-registry.js";

export function discoverLegacyResources(paths: RuntimePaths): LegacyResourceSet {
	const sessions = existsSync(paths.sessionDir)
		? readdirSync(paths.sessionDir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => basename(name, ".jsonl"))
		: [];
	const registry = readJson<{ workspaces?: Array<{ id?: unknown }> }>(
		join(paths.dataDir, "workspaces", "registry.json"),
		{ workspaces: [] },
	);
	const workspaces = (registry.workspaces ?? [])
		.map((workspace) => workspace.id)
		.filter((id): id is string => typeof id === "string" && id.length > 0 && id !== TEMP_WORKSPACE_ID);
	return { sessions, workspaces };
}
