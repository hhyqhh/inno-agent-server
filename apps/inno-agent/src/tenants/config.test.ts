import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InnoConfig } from "../config.js";
import { runInTenantContext } from "./current.js";
import {
	createEmptyTenantConfig,
	loadTenantConfig,
	resolveCurrentTenantConfig,
	saveTenantConfig,
	tenantConfigPath,
} from "./config.js";
import type { TenantContext, TenantStore } from "./store.js";

const tempDirs: string[] = [];
const tenantStore = {} as TenantStore;

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-tenant-config-"));
	tempDirs.push(dir);
	return dir;
}

function context(tenantId: string): TenantContext {
	return { tenantId, userId: `user-${tenantId}`, role: "owner" };
}

function localConfig(): InnoConfig {
	return {
		...createEmptyTenantConfig(),
		defaultProvider: "legacy",
		defaultModel: "legacy-model",
		providers: {
			legacy: {
				baseUrl: "http://legacy.invalid",
				apiKey: "legacy-secret",
				models: [{ id: "legacy-model", name: "Legacy", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100 }],
			},
		},
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tenant configuration", () => {
	it("does not inherit legacy providers or integration credentials", () => {
		const dataDir = tempDir();
		const config = loadTenantConfig(dataDir, "tenant-a");
		expect(config.providers).toEqual({});
		expect(config.defaultProvider).toBe("");
		expect(config.defaultModel).toBe("");
		expect(config.plugins?.webAccess?.enabled).toBe(false);
		expect(config.plugins?.permissionSystem?.mode).toBe("default");
		expect(config.tavily).toBeUndefined();
		expect(config.ocrApi).toBeUndefined();
	});

	it("persists providers independently and resolves them from tenant context", () => {
		const dataDir = tempDir();
		const local = localConfig();
		const tenantA = createEmptyTenantConfig();
		tenantA.providers.shared = {
			baseUrl: "http://tenant-a.invalid",
			apiKey: "tenant-a-secret",
			models: [{ id: "model-a", name: "A", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100 }],
		};
		tenantA.defaultProvider = "shared";
		tenantA.defaultModel = "model-a";
		saveTenantConfig(dataDir, "tenant-a", tenantA);

		expect(loadTenantConfig(dataDir, "tenant-b").providers).toEqual({});
		expect(JSON.parse(readFileSync(tenantConfigPath(dataDir, "tenant-a"), "utf-8")).providers.shared.apiKey).toBe("tenant-a-secret");
		runInTenantContext(context("tenant-a"), tenantStore, () => {
			expect(resolveCurrentTenantConfig(dataDir, local).providers.shared.apiKey).toBe("tenant-a-secret");
		});
		runInTenantContext(context("tenant-b"), tenantStore, () => {
			expect(resolveCurrentTenantConfig(dataDir, local).providers).toEqual({});
		});
		expect(resolveCurrentTenantConfig(dataDir, local)).toBe(local);
	});
});
