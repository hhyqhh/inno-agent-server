export type AuthMode = "local" | "better-auth";

export interface AuthRuntimeConfig {
	mode: AuthMode;
	databaseUrl?: string;
	secret?: string;
	baseUrl?: string;
	trustedOrigins: string[];
	allowSignUp: boolean;
	multiUserEnabled: boolean;
}

export interface ListenConfig {
	host: string;
	allowUnauthenticatedNetwork: boolean;
}

function readBoolean(value: string | undefined, fallback = false): boolean {
	if (value === undefined || value.trim() === "") return fallback;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	throw new Error(`Invalid boolean value: ${value}`);
}

function readOrigins(value: string | undefined): string[] {
	if (!value) return [];
	return value.split(",").map((origin) => origin.trim()).filter(Boolean).map((origin) => {
		const url = new URL(origin);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error(`Invalid trusted origin: ${origin}`);
		}
		return url.origin;
	});
}

export function readAuthRuntimeConfig(env: NodeJS.ProcessEnv): AuthRuntimeConfig {
	const rawMode = env.INNO_AUTH_MODE?.trim() || "local";
	if (rawMode !== "local" && rawMode !== "better-auth") {
		throw new Error(`Invalid INNO_AUTH_MODE: ${rawMode}`);
	}
	const multiUserEnabled = readBoolean(env.INNO_MULTI_USER_ENABLED);
	if (multiUserEnabled && rawMode !== "better-auth") {
		throw new Error("INNO_MULTI_USER_ENABLED requires INNO_AUTH_MODE=better-auth");
	}
	if (rawMode === "local") {
		return {
			mode: rawMode,
			trustedOrigins: [],
			allowSignUp: false,
			multiUserEnabled,
		};
	}

	const databaseUrl = env.DATABASE_URL?.trim();
	const secret = env.BETTER_AUTH_SECRET?.trim();
	const baseUrl = env.BETTER_AUTH_URL?.trim();
	const missing = [
		!databaseUrl && "DATABASE_URL",
		!secret && "BETTER_AUTH_SECRET",
		!baseUrl && "BETTER_AUTH_URL",
	].filter(Boolean);
	if (missing.length > 0) {
		throw new Error(`Better Auth mode requires: ${missing.join(", ")}`);
	}
	if (secret!.length < 32) {
		throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
	}
	const parsedBaseUrl = new URL(baseUrl!);
	if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
		throw new Error("BETTER_AUTH_URL must use http or https");
	}

	return {
		mode: rawMode,
		databaseUrl,
		secret,
		baseUrl: parsedBaseUrl.origin,
		trustedOrigins: readOrigins(env.INNO_TRUSTED_ORIGINS),
		allowSignUp: readBoolean(env.INNO_AUTH_ALLOW_SIGNUP, true),
		multiUserEnabled,
	};
}

export function readListenConfig(env: NodeJS.ProcessEnv, authMode: AuthMode): ListenConfig {
	const host = env.INNO_HOST?.trim() || "127.0.0.1";
	const allowUnauthenticatedNetwork = readBoolean(env.INNO_ALLOW_UNAUTHENTICATED_NETWORK);
	const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
	if (authMode === "local" && !isLoopback && !allowUnauthenticatedNetwork) {
		throw new Error(
			"Unauthenticated local mode only listens on loopback by default. "
			+ "Set INNO_ALLOW_UNAUTHENTICATED_NETWORK=true to explicitly expose it.",
		);
	}
	return { host, allowUnauthenticatedNetwork };
}
