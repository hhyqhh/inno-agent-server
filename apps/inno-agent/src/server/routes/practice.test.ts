import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { HOST_TERMINAL_DISABLED_ERROR } from "../../agent/host-execution-policy.js";
import { handlePracticeRoutes, type PracticeRouteContext } from "./practice.js";

function fakeReq(body?: unknown): HttpReq {
	const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as HttpReq;
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

function routeContext(hostTerminalDisabled: boolean): PracticeRouteContext {
	return {
		workspaceRegistry: {} as PracticeRouteContext["workspaceRegistry"],
		dataDir: "/unused",
		terminalManager: { create: vi.fn() } as unknown as PracticeRouteContext["terminalManager"],
		runRecordStore: {} as PracticeRouteContext["runRecordStore"],
		tenantStore: null,
		hostTerminalDisabled,
	};
}

describe("host terminal policy", () => {
	it("rejects authenticated terminal creation before spawning a PTY", async () => {
		const ctx = routeContext(true);
		const res = fakeRes();

		expect(await handlePracticeRoutes(fakeReq(), res, "POST", "/api/terminal/sessions", ctx)).toBe(true);

		expect(res.statusCode).toBe(409);
		expect(res.payload).toEqual({ error: HOST_TERMINAL_DISABLED_ERROR });
		expect(ctx.terminalManager.create).not.toHaveBeenCalled();
	});

	it("keeps local terminal creation available", async () => {
		const ctx = routeContext(false);
		const res = fakeRes();

		expect(await handlePracticeRoutes(fakeReq({}), res, "POST", "/api/terminal/sessions", ctx)).toBe(true);

		expect(res.statusCode).toBe(400);
		expect(res.payload).toEqual({ error: "Missing sessionId" });
	});
});
