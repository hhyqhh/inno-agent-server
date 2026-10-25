import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["apps/inno-agent/src/**/*.integration.test.ts"],
		exclude: ["**/node_modules/**"],
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
