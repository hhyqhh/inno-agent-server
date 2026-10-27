import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { InnoConfig, InnoModelConfig } from "../config.js";

export interface DurableModelSelection {
	models: Models;
	model: ModelRef;
}

function providerModel(model: InnoModelConfig) {
	return {
		id: model.id,
		name: model.name,
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
	const models = await ModelRuntime.create({
		modelsPath: null,
		credentials: new InMemoryCredentialStore(),
		refreshOnCreate: false,
	});
	for (const [providerId, providerConfig] of Object.entries(config.providers)) {
		models.registerProvider(providerId, {
			baseUrl: providerConfig.baseUrl,
			apiKey: providerConfig.apiKey || "local",
			api: providerConfig.api ?? "openai-completions",
			headers: providerConfig.headers,
			authHeader: providerConfig.authHeader,
			models: providerConfig.models.map(providerModel),
		});
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
