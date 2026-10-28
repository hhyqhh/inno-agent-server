import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceFileEnv } from "./durable-env.js";

const roots: string[] = [];
function root(): string {
	const value = mkdtempSync(join(tmpdir(), "inno-durable-env-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("WorkspaceFileEnv", () => {
	it("reads workspace files but denies outside paths and symlink escapes", async () => {
		const base = root();
		const workspace = join(base, "workspace");
		const outside = join(base, "outside");
		mkdirSync(workspace);
		mkdirSync(outside);
		writeFileSync(join(workspace, "inside.txt"), "inside");
		writeFileSync(join(outside, "secret.txt"), "secret");
		symlinkSync(join(outside, "secret.txt"), join(workspace, "escape.txt"));
		const env = new WorkspaceFileEnv(workspace);

		const valid = await env.readTextFile("inside.txt", BACKGROUND_CONTEXT);
		expect(valid).toMatchObject({ ok: true, value: "inside" });
		for (const path of [join(outside, "secret.txt"), "../outside/secret.txt", "escape.txt"]) {
			const result = await env.readTextFile(path, BACKGROUND_CONTEXT);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("permission_denied");
		}
		const resolved = await env.absolutePath("../outside/secret.txt", BACKGROUND_CONTEXT);
		expect(resolved.ok).toBe(false);
	});

	it("writes inside the workspace but denies escapes, shell and other mutations", async () => {
		const base = root();
		const workspace = join(base, "workspace");
		const outside = join(base, "outside");
		mkdirSync(workspace);
		mkdirSync(outside);
		writeFileSync(join(outside, "secret.txt"), "secret");
		symlinkSync(join(outside, "secret.txt"), join(workspace, "escape.txt"));
		const env = new WorkspaceFileEnv(workspace);

		const absolute = await env.absolutePath("nested/new.txt", BACKGROUND_CONTEXT);
		expect(absolute.ok).toBe(true);
		const write = await env.writeFile("nested/new.txt", "yes", BACKGROUND_CONTEXT);
		expect(write.ok).toBe(true);
		expect(readFileSync(join(workspace, "nested", "new.txt"), "utf-8")).toBe("yes");
		expect((await env.writeFile(join(realpathSync(workspace), "canonical.txt"), "canonical", BACKGROUND_CONTEXT)).ok).toBe(true);
		expect(readFileSync(join(workspace, "canonical.txt"), "utf-8")).toBe("canonical");
		for (const path of [join(outside, "secret.txt"), "../outside/secret.txt", "escape.txt"]) {
			const result = await env.writeFile(path, "stolen", BACKGROUND_CONTEXT);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("permission_denied");
		}
		expect(readFileSync(join(outside, "secret.txt"), "utf-8")).toBe("secret");
		expect((await env.appendFile("nested/new.txt", "no", BACKGROUND_CONTEXT)).ok).toBe(false);
		expect((await env.remove("nested/new.txt", undefined, BACKGROUND_CONTEXT)).ok).toBe(false);
		const exec = await env.exec("pwd", undefined, BACKGROUND_CONTEXT);
		expect(exec.ok).toBe(false);
		if (!exec.ok) expect(exec.error.code).toBe("shell_unavailable");
	});
});
