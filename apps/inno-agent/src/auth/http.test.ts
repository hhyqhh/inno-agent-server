import { describe, expect, it } from "vitest";
import { isPublicApiRequest, isTrustedOrigin } from "./http.js";
import { readAuthRuntimeConfig } from "./config.js";

describe("public API policy", () => {
	it("allows only explicit health, auth, and bearer bridge routes", () => {
		expect(isPublicApiRequest("GET", "/health")).toBe(true);
		expect(isPublicApiRequest("GET", "/api/health")).toBe(true);
		expect(isPublicApiRequest("POST", "/api/auth/sign-in/email")).toBe(true);
		expect(isPublicApiRequest("GET", "/api/auth/get-session")).toBe(true);
		expect(isPublicApiRequest("POST", "/api/bridge/messages")).toBe(true);
	});

	it("does not expose other API routes", () => {
		expect(isPublicApiRequest("GET", "/api/sessions")).toBe(false);
		expect(isPublicApiRequest("POST", "/api/health")).toBe(false);
		expect(isPublicApiRequest("GET", "/api/bridge/messages")).toBe(false);
		expect(isPublicApiRequest("POST", "/api/channels/bridge/test")).toBe(false);
	});
});

describe("browser origin policy", () => {
	const config = readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth",
		DATABASE_URL: "postgresql://localhost/inno",
		BETTER_AUTH_SECRET: "test-secret-with-at-least-32-characters",
		BETTER_AUTH_URL: "https://agent.example.com",
		INNO_TRUSTED_ORIGINS: "https://app.example.com",
	});

	it("allows same-origin, configured origins and non-browser clients", () => {
		expect(isTrustedOrigin(undefined, config)).toBe(true);
		expect(isTrustedOrigin("https://agent.example.com", config)).toBe(true);
		expect(isTrustedOrigin("https://app.example.com/path", config)).toBe(true);
	});

	it("rejects untrusted and malformed origins", () => {
		expect(isTrustedOrigin("https://attacker.example.com", config)).toBe(false);
		expect(isTrustedOrigin("not a URL", config)).toBe(false);
	});
});
