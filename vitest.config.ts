import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { TEST_TIMEOUT_MS, WORKER_HEAP_MB } from "./scripts/lib/test-ceiling";
import ShardSequencer from "./scripts/vitest-shard-sequencer";

export default defineConfig({
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
		// 90 s, not vitest's 5 s, because THE TESTS THAT CROSS THE BAR HERE ARE NOT
		// THE SLOW ONES. Re-run on a quiet machine, every one of a loaded full run's
		// 28 timeouts passes, 24 of 28 under 1 s. Load multiplies them by a median
		// x39.6, up to x386.2, so the population at risk is any subprocess-spawning
		// test on a contended machine rather than the tail near the bar. 90 s
		// carries a p99 test (2,271 ms quiet) through that median amplification;
		// 30 s does not. It carries it with no margin at all, so a residual timeout
		// under heavy load is expected here, not a regression.
		//
		// A repo-wide default had been DECLINED, in check-ci-status.test.ts's own
		// header, on the ground that it "would weaken the signal on ~140 suites to
		// cover 4". What fell is the premise: 24 of the 28 were the machine and not
		// the code, so the signal on those ~140 was already false, not merely weak.
		//
		// Distribution, amplification pairs and the run they came from:
		// mantahostels#2255, comment 5477335265
		//
		// THE ONE THING THAT WOULD FLIP THIS is a test that hangs ASYNCHRONOUSLY
		// without end: it now costs 90 s of a worker rather than 5 s. A SYNCHRONOUS
		// hang is untouched either way — `testTimeout` is enforced on the event loop
		// such a call never yields to (scripts/lib/test-inflight.js), which is why
		// run-vitest.js carries a stall watchdog of its own.
		// The value lives in scripts/lib/test-ceiling.js, not here — see that
		// file for why (mantahostels#2267).
		testTimeout: TEST_TIMEOUT_MS,
		// Unmeasured: mantahostels#2255 timed tests, never hooks. The same amplification reaches
		// hooks by construction, §X3's prescribed shape putting a temp git repo and
		// real spawns in `beforeEach`.
		hookTimeout: TEST_TIMEOUT_MS,
		// AT LEAST 38 per-test timeout overrides (36 inline third-argument, 2
		// `{ timeout }` second-argument) persist across 17 files — a floor, not
		// an exact count: a third argument that is a named constant rather than
		// a numeric literal escapes both grep and an AST walk that checks literals only, and nobody has yet
		// walked the identifier-reference case. No blanket claim that they
		// invert against this default, either: mantahostels#2262 read some as deliberate
		// per-case bounds and left the rest unread. No per-`describe` override
		// remains — mantahostels#2264 took the last four. Re-derive before trusting any
		// count here (mantahostels#2281).
		// Reports a tracked file rewritten by a parallel session while the suite
		// ran, so a red result caused by a neighbour's half-saved file is not read
		// as your own breakage (mantahostels#273). Prints; never fails a run.
		globalSetup: ["./scripts/vitest-tree-watch.ts"],
		// Records the run's verdict for the globalSetup teardown above to stamp a
		// pre-push marker with (mantahostels#987). "default" is listed because naming any
		// reporter replaces the default set rather than adding to it.
		// Names the started-and-unfinished modules for scripts/run-vitest.js's
		// stall watchdog to print when it kills a parked run.
		reporters: [
			"default",
			"./scripts/vitest-pass-reporter.ts",
			"./scripts/vitest-inflight-reporter.ts",
			// ci.yml's Vitest step names a file here, and uploads the report
			// `suite-timings.js extract` refreshes the shard timings from (#2413).
			...(process.env.WFC_VITEST_JSON
				? [
						["json", { outputFile: process.env.WFC_VITEST_JSON }] as [
							"json",
							{ outputFile: string },
						],
					]
				: []),
		],
		sequence: { sequencer: ShardSequencer },
		pool: "forks",
		// W, the workers a whole suite runs. One whole suite runs at a time
		// (#2680), so W is sized to a lone run on this machine's 8 cores. #2772
		// timed a fixed 202-file sample (every third test file) twice at each W,
		// interleaved 3 4 5 6 6 5 4 3, each run the only whole suite:
		//
		//   W=3: 394 s, 309 s    W=4: 259 s, 251 s
		//   W=5: 213 s, 247 s    W=6: 308 s, 249 s
		//
		// W=5 has the lowest median (230 s); W=4's is 10.9% slower, outside the
		// 3.4% tie band #2772's choice rule set. Replicates of one W spread up to
		// 27%, so the bench ranks 5 above 3 and 6 more surely than above 4.
		// Cores: 5 worker processes plus vitest's main process make 6. Any
		// number of part-suites may run beside it, each adding up to 6, held
		// by the memory rung rather than a count cap, and each yields the CPU by cpu-yield.js's YIELD_NICE (#2955).
		// Memory: a lone W stays inside the 9 workers docs/environment.md §6's
		// ladder was measured over.
		// Admission charges a whole suite at lib/suite-bounded.js's
		// WHOLE_SUITE_WORKERS, which lib/suite-bounded.test.ts holds equal.
		maxWorkers: 5,
		// Why the value: scripts/lib/test-ceiling.js.
		execArgv: [`--max-old-space-size=${WORKER_HEAP_MB}`],
		// `.claude/**` is named explicitly. Vitest 4's default include does reach
		// dot-directories, but the roadmap-edit scripts that gate every roadmap
		// edit live under `.claude/` — and biome.json already excludes that path,
		// so "tooling silently stops covering .claude" is a real failure shape
		// here. Pinning it means a future default can't drop those tests quietly.
		include: [
			"**/*.{test,spec}.?(c|m)[jt]s?(x)",
			".claude/**/*.{test,spec}.?(c|m)[jt]s?(x)",
		],
		// `.claude/worktrees/**` holds agent worktrees — a whole second copy of the
		// tree, whose own `*.test.ts` files the `.claude/**` include above would
		// otherwise collect alongside the real ones, doubling the run.
		//
		// `.claude/tmp/**` is the sanctioned session scratch directory (mantahostels#2089,
		// gitignored since mantahostels#2103, so `include` reaches it only because vitest does
		// not read .gitignore), and
		// a dead session can leave a frozen COPY of a test file there (mantahostels#2018: 60
		// failures a run from one such snapshot of an older guard's tests). It can
		// never reach CI, which checks the tree out clean, so its only effect is
		// to make every LOCAL full-suite run read red — and a suite that is always
		// red is one nobody reads.
		//
		// `.local/**` is the same hazard by a different route: it is not
		// gitignored, and sessions put throwaway git WORKTREES there — each a
		// full checkout, so every test file is collected two or three times over
		// and the extra copies attest a stale commit rather than your own
		// (mantahostels#2206: 149 collected where the tree holds 51). Vitest does not read
		// .gitignore, so gitignoring `.local/` misses it.
		//
		// Every mod's tests (`wfc-*`) import `claude-code/testing`, which exists only
		// under `claude plugin test` (#849 §Testing Decisions).
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
