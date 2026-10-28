// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "./AuthGate.js";
import { sessionsStore } from "../stores/sessions-store.js";
import "../i18n/index.js";

function sessionResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

afterEach(() => {
	cleanup();
	sessionsStore.durableEnabled = false;
	vi.unstubAllGlobals();
});

describe("AuthGate", () => {
	it("renders local mode without requiring an account", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sessionResponse({
			mode: "local", allowSignUp: false, durableEnabled: true, user: null,
		})));
		render(<AuthGate><div>protected app</div></AuthGate>);
		expect(await screen.findByText("protected app")).toBeTruthy();
		expect(sessionsStore.durableEnabled).toBe(true);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("shows sign-in and signs up when registration is enabled", async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(sessionResponse({ mode: "better-auth", allowSignUp: true, user: null }))
			.mockResolvedValueOnce(sessionResponse({}))
			.mockResolvedValueOnce(sessionResponse({
				mode: "better-auth", allowSignUp: true,
				user: { userId: "u1", email: "a@example.com", name: "A" },
			}));
		vi.stubGlobal("fetch", fetchMock);
		render(<AuthGate><div>protected app</div></AuthGate>);
		fireEvent.click(await screen.findByRole("button", { name: "没有账号？立即注册" }));
		fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "A" } });
		fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "a@example.com" } });
		fireEvent.change(screen.getByLabelText("密码"), { target: { value: "password123" } });
		fireEvent.click(screen.getByRole("button", { name: "注册" }));
		expect(await screen.findByText("protected app")).toBeTruthy();
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
		expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/sign-up/email");
	});

	it("returns to sign-in when an authenticated request expires", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sessionResponse({
			mode: "better-auth", allowSignUp: false,
			user: { userId: "u1", email: "a@example.com", name: "A" },
		})));
		render(<AuthGate><div>protected app</div></AuthGate>);
		expect(await screen.findByText("protected app")).toBeTruthy();
		fireEvent(window, new Event("inno:unauthorized"));
		expect(await screen.findByRole("button", { name: "登录" })).toBeTruthy();
		expect(screen.queryByText("protected app")).toBeNull();
	});
});
