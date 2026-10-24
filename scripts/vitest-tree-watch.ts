/*
 * A vitest globalSetup that says whether the tree moved while the suite ran.
 *
 * Why, and what it can and cannot see: `scripts/lib/tree-drift.js`, which owns
 * the policy. In short — mantahostels#273, where one session's suite imported another's
 * half-written source out of the repo-global worktree and went red with a
 * different set of failures each run.
 *
 * IMPLICIT:  on every suite run, names the tracked files a parallel session rewrote while the suite ran, and at run start the files already dirty and claimed elsewhere; and, on a verdict the reporter left, records the run's green or red marker in the canonical checkout's marker store, the green one being what the pre-push gate reads.
 * JUSTIFIED: fail-safe — a red caused by a neighbour's half-saved file is otherwise read as your own breakage (mantahostels#273).
 * DEFEAT:    none — it prints and records, and never fails a run.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
	snapshot,
	drift,
	format,
	formatNeighbourDirty,
	fromArbiter,
	endOfRunTreeIdentity,
} = require("./lib/tree-drift.js");
const { registryNames } = require("./lib/arbiter-core.js");
const {
	markerFrom,
	record,
	recordFailure,
	FAIL_STORE,
	repoRoot,
} = require("./lib/test-pass-marker.js");
const { readLaunch, takeRunReport } = require("./lib/suite-handoff.js");

/*
 * The tree under test: vitest's own root, handed to `setup`. Never this file's
 * location, which in a plugin install is the plugin cache (workflow-core#552). The cwd
 * stands in where `setup` never ran, as for a test driving the teardown.
 */
let treeRoot = process.cwd();

let before: unknown = null;
let inherited: unknown = null;

export function setup(project?: { config?: { root?: string } }) {
	const root = project?.config?.root;
	if (typeof root === "string" && root) treeRoot = root;
	before = snapshot(treeRoot);
	inherited = fromArbiter(before);
}

export function teardown() {
	runTeardown();
}

/*
 * `teardown` split out so a test can point the marker write at a sandbox
 * instead of this checkout's own store — vitest calls `teardown()` bare, so
 * that export stays zero-arg and this is the only way in (mantahostels#2182).
 *
 * `runTeardown` is exported and `rootOverride` is unguarded: any caller, not
 * only a test, can redirect the pre-push marker write away from the store
 * `check-test-marker.js` and the push gate actually read.
 */
export function runTeardown(rootOverride?: string | null) {
	const after = snapshot(treeRoot);
	const drifted = drift(before, after);

	// stderr, so these survive a reporter writing the summary to stdout.
	for (const message of [
		format(drifted),
		formatNeighbourDirty(inherited, undefined, registryNames()),
	])
		if (message) process.stderr.write(`${message}\n`);

	/*
	 * The marker the pre-push hook reads (mantahostels#987). Written here rather than in the
	 * reporter because this is where the tree findings are — and only on a
	 * verdict the reporter actually left, so a run whose result was never
	 * observed records nothing rather than a false green.
	 *
	 * `after.head` is HEAD as it stood when the suite finished, which is the sha
	 * a push straight afterwards carries.
	 */
	// The one take CLEARS the whole report, so the two branches below share
	// its result — a second take would come back empty.
	const { outcome, ...report } = takeRunReport();
	const launch = readLaunch();
	// A function, so a run with no verdict asks git nothing.
	const buildMarkerRun = () => ({
		held: inherited,
		...report,
		isolated: launch.isolated,
		argv: launch.argv,
		// Taken in treeRoot — the worktree this process is actually running
		// against, frozen or shared — and AFTER the run, unlike every other
		// tree field (mantahostels#2187's own point: they all describe the start).
		treeAtEnd: endOfRunTreeIdentity(treeRoot),
	});

	// The canonical checkout of treeRoot, so an isolated worktree's run lands in the
	// shared store. `rootOverride` exists only so a test can point the write at a
	// sandbox instead of this checkout's own store.
	const root = rootOverride ?? repoRoot(treeRoot);

	if (outcome === true && after)
		record(markerFrom(before, after, drifted, buildMarkerRun()), { root });

	/*
	 * The red half (mantahostels#1942), carrying the failing names in `scope.failures`. It
	 * gates nothing: no green is recorded here, and `check-test-marker.js` reads
	 * the green store alone, so a red sha still warns exactly as it did before.
	 *
	 * `outcome === false` and not `!== true`: a null outcome means the reporter
	 * never ran, so nothing observed the result and there is nothing to attest,
	 * red or green.
	 */
	if (outcome === false && after) {
		const written = recordFailure(
			markerFrom(before, after, drifted, buildMarkerRun()),
			{
				root,
			},
		);
		/*
		 * SAYING SO IS HALF THE FEATURE. A store nothing announces is a store
		 * nobody opens, and the whole point is that a session which piped the run
		 * through `tail` still gets the names. stderr, beside the drift findings
		 * above, because the reporter owns stdout.
		 *
		 * Never on a `rootOverride` run (mantahostels#2182): the recipe below names the real
		 * checkout's `FAIL_STORE`, which a sandboxed write never touched — printing
		 * it there is a false claim about where the names actually landed.
		 */
		if (written && rootOverride == null)
			process.stderr.write(
				`\n  The failing test names are recorded in .claude/tmp/markers/${FAIL_STORE}, so this run\n` +
					"  need not be repeated to recover them. Newest line, names only:\n" +
					`    tail -1 .claude/tmp/markers/${FAIL_STORE} | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const f of (JSON.parse(s).scope?.failures??[]))console.log(f.file,"—",f.tests.join(", "))})'\n`,
			);
	}
}
