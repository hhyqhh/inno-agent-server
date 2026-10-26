import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { handleSkillsRoutes, type SkillsRouteContext } from "./skills.js";

function fakeReq(): HttpReq {
	const req = Readable.from([]) as HttpReq;
	req.headers = {};
	return req;
}

function fakeRes(): ServerResponse & { statusCode: number; payload: unknown } {
	const res = {
		statusCode: 0,
		payload: undefined as unknown,
		writeHead(status: number) {
			res.statusCode = status;
			return res;
		},
		end(body?: string) {
			res.payload = body ? JSON.parse(body) : undefined;
			return res;
		},
	};
	return res as unknown as ServerResponse & { statusCode: number; payload: unknown };
}

function routeContext(sharedSkillsReadOnly: boolean): SkillsRouteContext {
	return {
		skillsDir: "/unused",
		sharedSkillsReadOnly,
		scheduleSkillsReload: vi.fn(),
		listProjectSkills: vi.fn(() => [{ name: "shared-skill" }]),
		setSkillEnabled: vi.fn(),
		installSkillZip: vi.fn(),
		installSkillMarkdown: vi.fn(),
		listSkillLibrary: vi.fn(async () => []),
		importSkillFromLibrary: vi.fn(),
	};
}

describe("shared skill management boundary", () => {
	it.each([
		["POST", "/api/skills/upload"],
		["POST", "/api/skills/reload"],
		["POST", "/api/skill-library/import"],
		["PATCH", "/api/skills/shared-skill"],
		["DELETE", "/api/skills/shared-skill"],
		["PUT", "/api/skills/shared-skill/content"],
		["PUT", "/api/skills/shared-skill/file"],
	])("rejects authenticated %s %s before touching shared state", async (method, url) => {
		const ctx = routeContext(true);
		const res = fakeRes();

		expect(await handleSkillsRoutes(fakeReq(), res, method, url, ctx)).toBe(true);

		expect(res.statusCode).toBe(409);
		expect(res.payload).toEqual({ error: "Shared skill management is read-only in authenticated mode" });
		expect(ctx.scheduleSkillsReload).not.toHaveBeenCalled();
		expect(ctx.setSkillEnabled).not.toHaveBeenCalled();
		expect(ctx.installSkillZip).not.toHaveBeenCalled();
		expect(ctx.installSkillMarkdown).not.toHaveBeenCalled();
		expect(ctx.importSkillFromLibrary).not.toHaveBeenCalled();
	});

	it("keeps the shared catalog readable in authenticated mode", async () => {
		const ctx = routeContext(true);
		const res = fakeRes();

		expect(await handleSkillsRoutes(fakeReq(), res, "GET", "/api/skills", ctx)).toBe(true);

		expect(res.statusCode).toBe(200);
		expect(res.payload).toEqual([{ name: "shared-skill" }]);
	});

	it("preserves local-mode skill reloads", async () => {
		const ctx = routeContext(false);
		const res = fakeRes();

		expect(await handleSkillsRoutes(fakeReq(), res, "POST", "/api/skills/reload", ctx)).toBe(true);

		expect(res.statusCode).toBe(200);
		expect(ctx.scheduleSkillsReload).toHaveBeenCalledOnce();
	});
});
