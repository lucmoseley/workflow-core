import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { TEST_TIMEOUT_MS, WORKER_HEAP_MB } from "./scripts/lib/test-ceiling";
import ShardSequencer from "./scripts/vitest-shard-sequencer";

export default defineConfig({
	cacheDir: ".vite",
	plugins: [react()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "."),
		},
	},
	test: {
		environment: "jsdom",
		globals: true,
		setupFiles: ["./vitest.setup.ts"],
		unstubEnvs: true,
		testTimeout: TEST_TIMEOUT_MS,
		hookTimeout: TEST_TIMEOUT_MS,
		globalSetup: [
			"./scripts/vitest-temp-root.ts",
			"./scripts/vitest-tree-watch.ts",
		],
		reporters: [
			"default",
			"./scripts/vitest-pass-reporter.ts",
			"./scripts/vitest-inflight-reporter.ts",
			...(process.env.WFC_VITEST_JSON
				? [
						[
							"./scripts/vitest-json-reporter.ts",
							{ outputFile: process.env.WFC_VITEST_JSON },
						] as [string, { outputFile: string }],
					]
				: []),
		],
		sequence: { sequencer: ShardSequencer },
		pool: "forks",
		// measured 230 s median suite at W=5, #2772
		maxWorkers: 5,
		execArgv: [`--max-old-space-size=${WORKER_HEAP_MB}`],
		include: [
			"**/*.{test,spec}.?(c|m)[jt]s?(x)",
			".claude/**/*.{test,spec}.?(c|m)[jt]s?(x)",
		],
		exclude: [
			"node_modules",
			".next",
			".claude/worktrees/**",
			".claude/tmp/**",
			".local/**",
			".claude/skills/wfc-*/**",
		],
	},
});
