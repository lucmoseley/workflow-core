/*
 * Publishes which test modules are started-and-unfinished, so scripts/run-vitest.js
 * can NAME the file a stalled run is parked in rather than reporting a bare
 * timeout (mantahostels#1910's follow-on). The reasoning for the file-on-disk channel, and
 * why no in-worker timeout can do this job, is in scripts/lib/test-inflight.js.
 *
 * A SECOND REPORTER RATHER THAN A BRANCH IN vitest-pass-reporter.ts. That one
 * carries a "must never turn a passing suite red" contract around a marker the
 * push gate reads; this one writes a scratch file nothing gates on.
 *
 * ONLY THE QUEUED/END PAIR BOUNDS A MODULE. `onTestModuleCollected` sits between
 * them and is recorded as a stage change, not as an exit. The same pair times
 * each file for the run-cost report (#1883), whose reasoning is in
 * scripts/lib/test-file-timings.js.
 *
 * IMPLICIT:  writes .test-inflight.json on every module transition of every suite run, and touches it on every test and hook event; writes the run's file timings once at its end, where the wrapper names a file for them.
 * JUSTIFIED: fail-safe — every write is wrapped and a lost record costs the diagnosis or the report, never the run.
 * DEFEAT:    drop it from vitest.config.ts's `reporters`, which costs run-vitest.js the file name and the heartbeat, so any file silent past the ceiling is killed again, and costs the run-cost report its timings.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const inflight = require("./lib/test-inflight.js");
const { TIMINGS_ENV, createTimings } = require("./lib/test-file-timings.js");

interface ModuleLike {
	moduleId?: string;
}

export default class TestInflightReporter {
	/* vitest's own config root, not process.cwd(): a run started from elsewhere
	 * must still write beside the checkout run-vitest.js reads from. */
	private root: string = process.cwd();

	private timings = createTimings();

	onInit(vitest: unknown) {
		const root = (vitest as { config?: { root?: string } })?.config?.root;
		if (typeof root === "string" && root) this.root = root;
	}

	onTestRunStart() {
		inflight.begin(this.root);
		this.timings = createTimings();
	}

	onTestModuleQueued(module: ModuleLike) {
		inflight.enter(this.root, module?.moduleId, "loading");
		this.timings.start(module?.moduleId, performance.now());
	}

	onTestModuleCollected(module: ModuleLike) {
		inflight.enter(this.root, module?.moduleId, "running its tests");
	}

	onTestModuleEnd(module: ModuleLike) {
		inflight.leave(this.root, module?.moduleId);
		this.timings.end(module?.moduleId, performance.now());
	}

	/* Signs of life inside a module, so a long file reads as slow rather than
	 * parked (#1149). */
	onTestCaseReady() {
		inflight.beat(this.root);
	}

	onTestCaseResult() {
		inflight.beat(this.root);
	}

	onHookStart() {
		inflight.beat(this.root);
	}

	onHookEnd() {
		inflight.beat(this.root);
	}

	/* A run that ENDS has nothing parked, so the record is dropped rather than
	 * left empty. */
	onTestRunEnd() {
		inflight.clear(this.root);
		this.timings.save(process.env[TIMINGS_ENV]);
	}
}
