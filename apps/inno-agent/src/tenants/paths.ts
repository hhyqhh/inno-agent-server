import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { getRequestTenant } from "./http.js";
import { getCurrentTenant } from "./current.js";

/** Resolve a domain directory without trusting client-provided path segments. */
export function resolveTenantDataDir(
	req: IncomingMessage,
	dataDir: string,
	domain: "learner" | "l2" | "l3",
): string {
	const tenant = getRequestTenant(req);
	return tenant ? join(dataDir, "tenants", tenant.tenantId, domain) : join(dataDir, domain);
}

export function resolveCurrentTenantDataDir(
	dataDir: string,
	domain: "learner" | "l2" | "l3",
): string {
	const tenant = getCurrentTenant();
	return tenant ? join(dataDir, "tenants", tenant.tenantId, domain) : join(dataDir, domain);
}
