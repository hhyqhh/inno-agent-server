import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../config.js";
import { completeConfiguredDurablePrompt, createConfiguredDurableModels } from "./durable-models.js";

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

	it("uses tenant credentials and headers for OpenAI-compatible HTTP streaming", async () => {
		let request: { url?: string; headers: Record<string, string | string[] | undefined>; body: any } | undefined;
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
			req.on("end", () => {
				request = {
					url: req.url,
					headers: req.headers,
					body: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
				};
				const chunk = (delta: Record<string, unknown>, finishReason: string | null) => `data: ${JSON.stringify({
					id: "local-transport",
					object: "chat.completion.chunk",
					created: 0,
					model: "tenant-model",
					choices: [{ index: 0, delta, finish_reason: finishReason }],
				})}`;
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end([
					chunk({ role: "assistant", content: "local transport response" }, null),
					"",
					chunk({}, "stop"),
					"",
					"data: [DONE]",
					"",
					"",
				].join("\n"));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address() as AddressInfo;
			const configured = config("tenant-secret", `http://127.0.0.1:${address.port}/v1`);
			configured.providers["tenant-provider"].authHeader = true;
			configured.providers["tenant-provider"].headers = { "x-tenant-header": "tenant-a" };
			const selection = { provider: "tenant-provider", modelId: "tenant-model" };
			await expect(completeConfiguredDurablePrompt(
				configured,
				selection,
				"Reply through the local transport",
				64,
				5_000,
			)).resolves.toBe("local transport response");

			expect(request?.url).toBe("/v1/chat/completions");
			expect(request?.headers.authorization).toBe("Bearer tenant-secret");
			expect(request?.headers["x-tenant-header"]).toBe("tenant-a");
			expect(request?.body).toMatchObject({ model: "tenant-model", stream: true, max_completion_tokens: 64 });
			expect(JSON.stringify(request?.body.messages)).toContain("Reply through the local transport");
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	});
});
