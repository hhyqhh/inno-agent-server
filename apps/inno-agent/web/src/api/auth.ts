export interface AuthUser {
	userId: string;
	email: string;
	name: string;
}

export interface AuthSessionResponse {
	mode: "local" | "better-auth";
	allowSignUp: boolean;
	user: AuthUser | null;
}

export const UNAUTHORIZED_EVENT = "inno:unauthorized";

export async function getAuthSession(): Promise<AuthSessionResponse> {
	const response = await fetch("/api/session", { credentials: "same-origin" });
	if (!response.ok) throw new Error("Unable to load the current session");
	return response.json() as Promise<AuthSessionResponse>;
}

async function authRequest(path: string, body: Record<string, string>): Promise<void> {
	const response = await fetch(path, {
		method: "POST",
		credentials: "same-origin",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const data = await response.json().catch(() => ({})) as { message?: string; error?: string };
		throw new Error(data.message || data.error || "Authentication failed");
	}
}

export function signIn(email: string, password: string): Promise<void> {
	return authRequest("/api/auth/sign-in/email", { email, password });
}

export function signUp(name: string, email: string, password: string): Promise<void> {
	return authRequest("/api/auth/sign-up/email", { name, email, password });
}

export function signOut(): Promise<void> {
	return authRequest("/api/auth/sign-out", {});
}
