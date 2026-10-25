import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, json } from "../server/http-helpers.js";
import type { AuthRuntimeConfig } from "./config.js";
import type { AuthRuntime, AuthSession } from "./runtime.js";

export function isTrustedOrigin(origin: string | undefined, config: AuthRuntimeConfig): boolean {
	if (!origin) return true;
	try {
		const normalized = new URL(origin).origin;
		return normalized === config.baseUrl || config.trustedOrigins.includes(normalized);
	} catch {
		return false;
	}
}

export function isPublicApiRequest(method: string, path: string): boolean {
	if (method === "GET" && (path === "/health" || path === "/api/health")) return true;
	if (path === "/api/auth" || path.startsWith("/api/auth/")) return true;
	// This endpoint performs its own constant-time bearer-token check. Other
	// channel endpoints still require a browser session.
	return method === "POST" && path === "/api/bridge/messages";
}

export async function requireSession(
	req: IncomingMessage,
	res: ServerResponse,
	auth: AuthRuntime,
): Promise<AuthSession | null> {
	if (auth.mode === "local") return null;
	const session = await auth.getSession(req);
	if (!session) {
		json(res, 401, { error: "Authentication required" });
		return null;
	}
	return session;
}

export function assertSignUpAllowed(auth: AuthRuntime, method: string, path: string): void {
	if (auth.mode === "better-auth" && !auth.allowSignUp
		&& method === "POST" && path === "/api/auth/sign-up/email") {
		throw new HttpError(403, "Sign-up is disabled");
	}
}
