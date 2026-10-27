// vitest.config.ts — the git-spawn census's own config (mantahostels#2218).
import path from "node:path";
import base from "../../vitest.config";

// Derived from this file's own location, never the cwd, so a run started
// from a throwaway worktree still measures that worktree rather than
// silently censusing the canonical checkout (matches scripts/run-vitest.js's
// own ROOT derivation).
const ROOT = path.resolve(__dirname, "../..");

/*
 * Spreads the shipped config and changes two things: `root` (load-bearing —
 * base's setupFiles/globalSetup/reporters are root-relative and would
 * otherwise resolve against this file's own directory) and `setupFiles`
 * (adds the wrapper). `pool`, `maxWorkers` and `include` are untouched.
 *
 * It sets neither `testTimeout` nor `hookTimeout` (mantahostels#2264):
 * `...base.test` carries both at mantahostels#2262's 90,000 ms repo default
 * unshadowed, and a local figure below that would tighten the one run that
 * is slower than normal by construction — every `git` spawn wrapped and
 * buffered. The wrapper's buffered afterAll flush spends `hookTimeout`; see
 * git-spawn-wrapper.setup.ts's own LOAD-BEARING DEFECTS for where its margin
 * comes from. A future cut to the repo default tightens the census run
 * first, with no local signal of its own.
 *
 * Drops `vitest-pass-reporter.ts` from the inherited reporters: left in, a
 * whole-suite census run — which run.sh sanctions — would stamp the mantahostels#987
 * pre-push certificate off a run whose `git` is a PATH shim and whose
 * `node:child_process` exports are monkey-patched.
 */
export default {
	...base,
	root: ROOT,
	test: {
		...base.test,
		setupFiles: [
			...((base.test?.setupFiles as string[]) ?? []),
			`${ROOT}/scripts/census/git-spawn-wrapper.setup.ts`,
		],
		reporters: ((base.test?.reporters ?? []) as unknown[]).filter(
			(r) => !(typeof r === "string" && r.includes("vitest-pass-reporter")),
		),
	},
};
