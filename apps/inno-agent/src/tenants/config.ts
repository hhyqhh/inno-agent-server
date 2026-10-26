import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	loadConfig,
	normalizeConfig,
	saveConfig,
	type InnoConfig,
} from "../config.js";
import { getCurrentTenant } from "./current.js";

const TENANT_CONFIG_OPTIONS = { allowEmptyProviders: true } as const;

export function tenantConfigDir(dataDir: string, tenantId: string): string {
	return join(dataDir, "tenants", tenantId, "config");
}

export function tenantConfigPath(dataDir: string, tenantId: string): string {
	return join(tenantConfigDir(dataDir, tenantId), "config.json");
}

/**
 * Authenticated accounts start without provider or integration credentials.
 * Legacy/local config is deliberately not copied: doing so would silently share
 * the deployment owner's paid API keys and external channel accounts.
 */
export function createEmptyTenantConfig(): InnoConfig {
	return normalizeConfig({
		defaultProvider: "",
		defaultModel: "",
		providers: {},
		subagents: { enabled: false },
		mcp: { enabled: false },
		plugins: {
			todo: { enabled: true },
			webAccess: { enabled: false },
			permissionSystem: { enabled: true, mode: "default" },
			computerUse: { enabled: false },
			codemode: { enabled: false },
		},
	}, TENANT_CONFIG_OPTIONS);
}

export function loadTenantConfig(dataDir: string, tenantId: string): InnoConfig {
	const path = tenantConfigPath(dataDir, tenantId);
	if (!existsSync(path)) return createEmptyTenantConfig();
	return loadConfig(path, TENANT_CONFIG_OPTIONS);
}

export function saveTenantConfig(dataDir: string, tenantId: string, config: InnoConfig): InnoConfig {
	return saveConfig(tenantConfigPath(dataDir, tenantId), config, TENANT_CONFIG_OPTIONS);
}

/** Resolve configuration at execution time, inside the verified ALS tenant scope. */
export function resolveCurrentTenantConfig(dataDir: string, localConfig: InnoConfig): InnoConfig {
	const tenant = getCurrentTenant();
	return tenant ? loadTenantConfig(dataDir, tenant.tenantId) : localConfig;
}
