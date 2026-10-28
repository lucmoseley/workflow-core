// @vitest-environment node
/*
 * The glue wiring the arbiter into the vitest globalSetup (mantahostels#392), plus
 * `runTeardown`'s marker-timing wire-up (mantahostels#2182) driven through its sandbox
 * seam — this file's own module state, not a script run end to end.
 *
 * It is the globalSetup of every suite run: loosen a case and a red run caused
 * by a neighbour's half-written file is no longer named as such, so a session
 * debugs a fault that is not its own, or the pre-push marker lands somewhere
 * other than the store the push gate reads.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	commitAll,
	freshSandbox,
	gitRepo,
	liveHolder,
	putLock,
} from "./lib/arbiter-testkit";
import { stubLaunch } from "./lib/suite-handoff-testkit";
import { runTeardown, setup, teardown } from "./vitest-tree-watch";

const markerLib = require("./lib/test-pass-marker.js");
const { FAIL_STORE } = markerLib;
const { fillRunReport, takeRunReport } = require("./lib/suite-handoff.js");

const sb = freshSandbox(() => {
	process.env.CLAUDE_CODE_SESSION_ID = "me";
});

/*
 * Points the module's tree at a committed sandbox repository for each case, so
 * `runTeardown`'s `endOfRunTreeIdentity` asks this repository's git, never the
 * shared checkout's (#2092). Returns a holder whose `sha`, the tree a clean run
 * must stamp, is filled per case: read it inside a test body, never at
 * describe scope.
 */
function sandboxTree() {
	const tree = { sha: "" };
	beforeEach(() => {
		gitRepo(sb);
		fs.writeFileSync(path.join(sb.repo, "seed.txt"), "seed\n");
		commitAll(sb);
		tree.sha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
			cwd: sb.repo,
			encoding: "utf8",
		}).trim();
		setup({ config: { root: sb.repo } });
	});
	afterEach(() => {
		setup({ config: { root: process.cwd() } });
	});
	return tree;
}

/*
 * The branch the mantahostels#1942 resolution first declared untestable, on the wrong
 * grounds — code review corrected it. Under the correct code a null outcome
 * writes NOTHING, so no root has to be injected to check it; under the
 * `!== true` mutant this same test writes a line and fails.
 */
describe("a run whose verdict nobody observed (mantahostels#1942)", () => {
	/* teardown() resolves its own root from the module's location, never the
	 * sandbox env, so the store it would write is the real checkout's. */
	const failStore = markerLib.storePath(
		markerLib.repoRoot(path.dirname(__filename)) ?? ".",
		FAIL_STORE,
	);

	it("records no red marker when the reporter never ran", () => {
		// Deliberately no outcome filled: mid-suite, the reporter's onTestRunEnd
		// has not fired, so the run report's outcome is null — the case this pins.
		const lines = () => {
			try {
				return fs.readFileSync(failStore, "utf8").split("\n").length;
			} catch {
				return 0;
			}
		};

		const before = lines();
		expect(() => teardown()).not.toThrow();
		expect(lines()).toBe(before);
	});
});

/*
 * mantahostels#2182: a RED run stamps `startedAt`/`durationMs`, off the reporter's own
 * `onTestRunStart`/`onTestRunEnd` clock rather than the moment the marker is
 * written.
 *
 * Writes to a SANDBOX root via `runTeardown`'s override, never the real
 * checkout's `.test-fail-markers.jsonl` — `teardown()` resolves its root from
 * this module's own location and cannot be sandboxed, which is why this and
 * the mantahostels#2210 block below drive `runTeardown` directly rather than `teardown`.
 *
 * The run report is process-global. Under this repo's `pool: "forks"`
 * (`vitest.config.ts`) this file runs in its own worker, so the real reporter
 * driving THIS suite is a different process and cannot read what the test
 * fills — the take in `afterEach` protects a neighbouring test FILE sharing
 * this worker (`isolate` unset, pool default), never the reporter.
 */
describe("a red run's timing (mantahostels#2182)", () => {
	// No case here reads `treeAtEnd`, but `stash create` would still rewrite
	// the shared checkout's index under a neighbour's run.
	sandboxTree();
	let redSandbox: string;

	beforeEach(() => {
		redSandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tree-watch-red-"));
	});

	afterEach(() => {
		takeRunReport();
		fs.rmSync(redSandbox, { recursive: true, force: true });
	});

	it("writes startedAt/durationMs from the run's own clock, not the write time", () => {
		const startedAtMs = Date.now() - 600_000;
		fillRunReport({
			startedAtMs,
			endedAtMs: startedAtMs + 5000,
			elapsedMs: 5000,
			outcome: false,
		});

		runTeardown(redSandbox);

		const [marker] = markerLib.readFailures({ root: redSandbox });
		expect(marker.startedAt).toBe(new Date(startedAtMs).toISOString());
		expect(marker.durationMs).toBe(5000);
	});
});

/*
 * mantahostels#2210: the green and red record() branches stamp `isolated`/`treeAtEnd`
 * (mantahostels#2187) via `endOfRunTreeIdentity`.
 */
describe("isolated/treeAtEnd on the write path (mantahostels#2210)", () => {
	const tree = sandboxTree();
	let markerSandbox: string;

	beforeEach(() => {
		markerSandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tree-watch-iso-"));
	});

	afterEach(() => {
		takeRunReport();
		fs.rmSync(markerSandbox, { recursive: true, force: true });
	});

	it("stamps a certificate with isolated:true and a real treeAtEnd sha", () => {
		stubLaunch({ isolated: true });
		fillRunReport({ outcome: true });

		runTeardown(markerSandbox);

		const [marker] = markerLib.readMarkers({ root: markerSandbox });
		expect(marker.isolated).toBe(true);
		expect(marker.treeAtEnd).toBe(tree.sha);
	});

	it("stamps the launch's argv off the launch record, on the certificate and the red marker alike (#1491)", () => {
		stubLaunch({ argv: ["--full=coverage"] });
		fillRunReport({ outcome: true });
		runTeardown(markerSandbox);
		fillRunReport({ outcome: false });
		runTeardown(markerSandbox);

		expect(markerLib.readMarkers({ root: markerSandbox })[0].argv).toEqual([
			"--full=coverage",
		]);
		expect(markerLib.readFailures({ root: markerSandbox })[0].argv).toEqual([
			"--full=coverage",
		]);
	});

	it("stamps the closure the reporter handed over, on the certificate and the red marker alike (#189)", () => {
		fillRunReport({
			outcome: true,
			attestation: { closure: ["a.test.ts", "a.js"], changedPaths: ["a.js"] },
		});
		runTeardown(markerSandbox);
		const [certificate] = markerLib.readMarkers({ root: markerSandbox });
		expect(certificate.closure).toEqual(["a.test.ts", "a.js"]);
		expect(certificate.changedPaths).toEqual(["a.js"]);
		// Taken once: the next run's marker must not inherit this closure.
		expect(takeRunReport().attestation).toBeNull();

		fillRunReport({ outcome: false, attestation: { closure: "*" } });
		runTeardown(markerSandbox);
		const [red] = markerLib.readFailures({ root: markerSandbox });
		expect(red.closure).toBe("*");
	});

	it("stamps a red marker with isolated:false where the launch says not isolated", () => {
		// Explicit, not relied on from ordering: a real `--isolated` run sets
		// the record on the whole process (`scripts/run-vitest.js`), and this
		// test means to pin the shared-tree case regardless of what ran before it.
		stubLaunch({ isolated: false });
		fillRunReport({ outcome: false });

		runTeardown(markerSandbox);

		const [marker] = markerLib.readFailures({ root: markerSandbox });
		expect(marker.isolated).toBe(false);
		expect(marker.treeAtEnd).toBe(tree.sha);
	});
});

/*
 * The wiring itself: a claim held as the run starts is named as it ends. Who
 * counts as a neighbour is `lib/tree-drift.test.ts`'s to pin.
 */
describe("a neighbour's claim on a file dirty at the run's start (mantahostels#392)", () => {
	afterEach(() => {
		// `setup` pointed the module at a scratch repository the outer afterEach deletes.
		setup({ config: { root: process.cwd() } });
	});

	it("is named on stderr at the teardown", () => {
		const file = path.join(sb.repo, "scripts", "x.js");
		gitRepo(sb);
		fs.mkdirSync(path.dirname(file));
		fs.writeFileSync(file, "one\n");
		commitAll(sb);
		fs.writeFileSync(file, "two\n");
		putLock("scripts/x.js", { sessionId: "them", ...liveHolder() });

		setup({ config: { root: sb.repo } });
		const err: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => {
			err.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			runTeardown(path.join(sb.dir, "markers"));
		} finally {
			process.stderr.write = original;
		}

		expect(err.join("")).toContain("scripts/x.js  held by them");
	});
});
