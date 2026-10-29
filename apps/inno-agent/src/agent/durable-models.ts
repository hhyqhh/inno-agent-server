import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { InnoConfig, InnoModelConfig, InnoProviderConfig } from "../config.js";

export interface DurableModelSelection {
	models: Models;
	model: ModelRef;
}

function providerModel(providerId: string, provider: InnoProviderConfig, model: InnoModelConfig): Model<Api> {
	return {
		id: model.id,
		name: model.name,
		provider: providerId,
		api: provider.api ?? "openai-completions",
		baseUrl: provider.baseUrl,
		reasoning: model.reasoning,
		input: model.input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		compat: { supportsDeveloperRole: false },
	};
}

/** Build an isolated model/auth runtime from the already resolved tenant config.
 * No global models.json, auth.json, environment credential, or legacy registry is
 * consulted. The selected model must exist in that same tenant configuration. */
export async function createConfiguredDurableModels(
	config: InnoConfig,
	selection: { provider: string; modelId: string } = {
		provider: config.defaultProvider,
		modelId: config.defaultModel,
	},
): Promise<DurableModelSelection> {
	const provider = config.providers[selection.provider];
	if (!provider || !provider.models.some((model) => model.id === selection.modelId)) {
		throw new Error(`Configured durable model not found: ${selection.provider}/${selection.modelId}`);
	}
	const models = createModels({ credentials: new InMemoryCredentialStore() });
	for (const [providerId, providerConfig] of Object.entries(config.providers)) {
		const api = providerConfig.api ?? "openai-completions";
		const implementation = getApiProvider(api);
		if (!implementation) throw new Error(`No API provider registered for api: ${api}`);
		models.setProvider(createProvider({
			id: providerId,
			baseUrl: providerConfig.baseUrl,
			auth: {
				apiKey: {
					name: "API key",
					resolve: async ({ credential }) => {
						const apiKey = credential?.key || providerConfig.apiKey || "local";
						const headers = providerConfig.authHeader
							? { ...providerConfig.headers, Authorization: `Bearer ${apiKey}` }
							: providerConfig.headers;
						return {
							auth: { apiKey, ...(headers ? { headers } : {}) },
							source: credential?.key ? "stored credential" : "configured API key",
						};
					},
				},
			},
			api: implementation,
			models: providerConfig.models.map((model) => providerModel(providerId, providerConfig, model)),
		}));
	}
	if (!models.getModel(selection.provider, selection.modelId)) {
		throw new Error(`Durable model registration failed: ${selection.provider}/${selection.modelId}`);
	}
	return { models, model: selection };
}

/** Stateless metadata completion through the same isolated configured runtime as
 * the durable session. It never consults the legacy active session or registry. */
export async function completeConfiguredDurablePrompt(
	config: InnoConfig,
	selection: { provider: string; modelId: string },
	prompt: string,
	maxTokens = 1024,
	timeoutMs = 20_000,
): Promise<string> {
	const { models } = await createConfiguredDurableModels(config, selection);
	const model = models.getModel(selection.provider, selection.modelId);
	if (!model) throw new Error(`Durable model registration failed: ${selection.provider}/${selection.modelId}`);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await models.completeSimple(model, {
			messages: [{
				role: "user",
				content: [{ type: "text", text: prompt }],
				timestamp: Date.now(),
			}],
		}, { maxTokens, signal: controller.signal, timeoutMs });
		if (response.stopReason === "error" || response.stopReason === "aborted") return "";
		return response.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim();
	} finally {
		clearTimeout(timer);
	}
}
