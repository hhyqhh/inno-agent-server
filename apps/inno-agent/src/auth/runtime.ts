import type { IncomingMessage, ServerResponse } from "node:http";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { Pool } from "pg";
import type { AuthRuntimeConfig } from "./config.js";

export interface AuthPrincipal {
	userId: string;
	email: string;
	name: string;
}

export interface AuthSession {
	principal: AuthPrincipal;
	sessionId: string;
}

export interface AuthRuntime {
	mode: "local" | "better-auth";
	allowSignUp: boolean;
	getSession(req: IncomingMessage): Promise<AuthSession | null>;
	handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
	checkConnection(): Promise<void>;
	close(): Promise<void>;
}

export const authOptions = {
	emailAndPassword: { enabled: true },
} satisfies Partial<BetterAuthOptions>;

export function createAuthRuntime(config: AuthRuntimeConfig): AuthRuntime {
	if (config.mode === "local") {
		return {
			mode: config.mode,
			allowSignUp: false,
			getSession: async () => null,
			handle: async (_req, res) => {
				res.writeHead(404).end();
			},
			close: async () => {},
			checkConnection: async () => {},
		};
	}

	const pool = new Pool({
		connectionString: config.databaseUrl,
		max: 10,
	});
	const auth = betterAuth({
		...authOptions,
		database: pool,
		secret: config.secret,
		baseURL: config.baseUrl,
		trustedOrigins: config.trustedOrigins,
	});
	const nodeHandler = toNodeHandler(auth);

	return {
		mode: config.mode,
		allowSignUp: config.allowSignUp,
		async getSession(req) {
			const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
			if (!session) return null;
			return {
				principal: {
					userId: session.user.id,
					email: session.user.email,
					name: session.user.name,
				},
				sessionId: session.session.id,
			};
		},
		async handle(req, res) {
			await nodeHandler(req, res);
		},
		async close() {
			await pool.end();
		},
		async checkConnection() {
			try {
				await pool.query('SELECT 1 FROM "user" LIMIT 1');
				await pool.query("SELECT 1 FROM tenants LIMIT 1");
			} catch (err) {
				throw new Error("Better Auth database/schema is unavailable; run auth:migrate before starting the server", { cause: err });
			}
		},
	};
}
