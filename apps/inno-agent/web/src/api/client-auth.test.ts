// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, ApiError } from "./client.js";
import { UNAUTHORIZED_EVENT } from "./auth.js";

afterEach(() => vi.unstubAllGlobals());

describe("API authentication handling", () => {
	it("uses same-origin cookies and announces expired sessions", async () => {
		const response = new Response(JSON.stringify({ error: "Authentication required" }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
		const fetchMock = vi.fn().mockResolvedValue(response);
		vi.stubGlobal("fetch", fetchMock);
		const expired = vi.fn();
		window.addEventListener(UNAUTHORIZED_EVENT, expired, { once: true });

		await expect(apiFetch("/api/sessions")).rejects.toBeInstanceOf(ApiError);
		expect(expired).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith("/api/sessions", expect.objectContaining({ credentials: "same-origin" }));
	});
});
