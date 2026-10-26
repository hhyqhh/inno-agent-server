import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../config.js";
import { createConfiguredDurableModels } from "./durable-models.js";

function config(apiKey: string, baseUrl: string) {
	return normalizeConfig({
		defaultProvider: "tenant-provider",
		defaultModel: "tenant-model",
		providers: {
			"tenant-provider": {
				baseUrl,
				apiKey,
				api: "openai-completions",
				models: [{
					id: "tenant-model",
					name: "Tenant model",
					reasoning: false,
					input: ["text"],
					contextWindow: 32_000,
					maxTokens: 2_000,
				}],
			},
		},
	});
}

describe("createConfiguredDurableModels", () => {
	it("builds independent provider/auth runtimes without global models.json", async () => {
		const a = await createConfiguredDurableModels(config("key-a", "http://tenant-a.invalid/v1"));
		const b = await createConfiguredDurableModels(config("key-b", "http://tenant-b.invalid/v1"));
		expect(a.model).toEqual({ provider: "tenant-provider", modelId: "tenant-model" });
		expect(a.models.getModel("tenant-provider", "tenant-model")?.baseUrl).toBe("http://tenant-a.invalid/v1");
		expect(b.models.getModel("tenant-provider", "tenant-model")?.baseUrl).toBe("http://tenant-b.invalid/v1");
		const authA = await a.models.getAuth("tenant-provider");
		const authB = await b.models.getAuth("tenant-provider");
		expect(authA?.auth).toMatchObject({ apiKey: "key-a" });
		expect(authB?.auth).toMatchObject({ apiKey: "key-b" });
		expect(a.models.getProvider("tenant-provider")).not.toBe(b.models.getProvider("tenant-provider"));
	});

	it("rejects a model absent from the resolved tenant config", async () => {
		await expect(createConfiguredDurableModels(config("key", "http://localhost/v1"), {
			provider: "tenant-provider",
			modelId: "other-tenant-model",
		})).rejects.toThrow("Configured durable model not found");
	});
});
