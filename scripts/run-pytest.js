#!/usr/bin/env node
/*
 * `npm run test:py`, wrapped so a green pytest run leaves the suite certificate
 * that vitest leaves (mantahostels#987, mantahostels#1256).
 *
 * WHY A WRAPPER AND NOT ONLY A PLUGIN. The marker records the tree the suite
 * read — what was already uncommitted, who else held it, what moved mid-run —
 * and that policy lives in `lib/tree-drift.js` and `lib/test-pass-marker.js`.
 * Reimplementing it in Python would make a second copy that drifts from the
 * first. So the plugin answers "did it pass, and how much ran", this answers
 * everything else, and the two meet in a JSON temp file.
 *
 * IT MUST NOT CHANGE WHAT `test:py` MEANS. Arguments but a lone `--full` pass
 * straight through, pytest writes to the terminal unbuffered, and a red run
 * stays red — a marker that cannot be written costs a warning at the next
 * push, never a red run. EXIT 0 OR 1, NEVER PYTEST'S OWN CODE (#4779): the
 * helper surface lists this command's exits, and pytest's set grows with its
 * version, so every failing exit reads as 1 and pytest's own report says
 * which. cli-args-exempt: every argument is pytest's, passed through
 * unparsed, bar the one whole-argv match below.
 *
 * A BARE RUN IS A TOUCHED ONE (#2934): it hands
 * pytest only the test files `lib/touched-tests.js` resolves from the
 * session's own changed paths, as a bare `npm run test` does vitest (#2930).
 * With a session id those are the paths its overlay would carry, read in the
 * working tree, so a file it did not write selects nothing (#2958). An empty set spawns nothing, records no marker, writes its ledger
 * line and exits 0; the lander runs the full suite. Any argument at all keeps
 * the run exactly as typed. A lone `--full` is the whole suite, handed to
 * pytest as no argument: a full-suite caller — CI, the lander — runs
 * from a clean checkout, where a bare run selects nothing (#3508). Beside
 * other words it is pytest's, which refuses it, so it never quietly narrows.
 *
 * THE SUITE CEILING (#2702, ruled at #2667). pytest leads a process group of
 * its own, and at the ceiling `lib/suite-ceiling.js` sets, the whole group is
 * killed, xdist workers included: the run exits 1 and records no certificate. The
 * group is not the terminal's foreground one, so a Ctrl-C reaches this
 * wrapper alone and is passed on to the group. RESIDUAL: a pytest that reads
 * the terminal (`--pdb`, `breakpoint()`, `input()` under `-s`) is stopped by
 * it and waits out the ceiling, and a Ctrl-Z stops this wrapper, not pytest.
 *
 * A SCOPE OF ITS OWN (#3401). pytest starts in a pids-capped user scope
 * (lib/user-scope.js), killed whole when the run ends; a run that hit the cap
 * exits 1 and records no certificate.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
	readTreeSnapshot,
	drift,
	format,
	endOfRunTreeIdentity,
} = require("./lib/tree-drift.js");
const {
	formatFilteredRun,
	markerFrom,
	record,
	recordKill,
	repoRoot,
} = require("./lib/test-pass-marker.js");
const { worktreeRoot } = require("./lib/host-root.js");
const { readTouchedBase, selectTouched } = require("./lib/touched-tests.js");
const { ownDefaultWork } = require("./lib/own-selection.js");
const { appendEmptyTouchedLine } = require("./lib/run-ledger.js");
const idSeam = require("./lib/session-id.js");
const { reportForRun } = require("./lib/run-cost-report.js");
const { writeFd } = require("./lib/write-fd.js");
const { narrowingRefusal } = require("./lib/narrowing-refusal.js");
const { pythonSpawnRemedy } = require("./lib/python-bin.js");
const { monotonicMs } = require("./lib/clock.js");
const { sweepDeadRunRoots } = require("./lib/run-temp-root.js");
const { runPytest, ceilingKillRow } = require("./lib/pytest-child.js");

// #2940
const TREE_ROOT = worktreeRoot();

const FULL = "--full";

/**
 * @param {string[]} [argv]
 * @returns {Promise<void>}
 */
async function main(argv = process.argv.slice(2)) {
	const plan = pytestPlan(argv, TREE_ROOT);
	if (typeof plan === "number") process.exitCode = plan;
	else await runAndRecord(plan, TREE_ROOT);
}

/**
 * @param {Plan} plan
 * @param {string} root
 * @returns {Promise<void>}
 */
async function runAndRecord(plan, root) {
	const { args } = plan;
	// lucmoseley/mantahostels#1953
	const startedAtMs = Date.now();
	const startedAtMono = monotonicMs();
	const before = readTreeSnapshot(root);

	const handOff = handOffPath();
	const inflightFile = handOff
		? path.join(path.dirname(handOff), "inflight.json")
		: null;
	const run = await runPytest(args, root, { handOff, inflightFile });
	if (run.error)
		writeFd(
			2,
			`pytest could not be run: ${run.error}\n${pythonSpawnRemedy(run.error)}`,
		);
	const result = handOff ? readHandOff(handOff) : null;
	if (run.ceilingKill)
		recordCeilingKill(root, run.ceilingKill, {
			sha: before?.head,
			startedAtMs,
			argv: args,
			touchedBase: plan.touched?.touchedBase ?? null,
		});

	const after = readTreeSnapshot(root);
	const drifted = drift(before, after);
	const moved = format(drifted);
	if (moved) writeFd(2, `${moved}\n`);

	// pytest_terminal_summary runs before teardown and interpreter shutdown: https://docs.pytest.org/en/stable/reference/reference.html#pytest.hookspec.pytest_terminal_summary
	if (!run.forcedRed && run.status === 0 && result?.passed === true && after) {
		record(
			markerFrom(before, after, drifted, {
				scope: runScope(result.scope, plan.touched),
				suite: "pytest",
				startedAtMs,
				elapsedMs: monotonicMs() - startedAtMono,
				// lucmoseley/mantahostels#2187
				isolated: false,
				treeAtEnd: endOfRunTreeIdentity(root),
			}),
			{ root: repoRoot(root) },
		);
		const line = formatFilteredRun(result.scope);
		if (line) writeFd(1, `${line}\n`);
	}

	// #1884
	if (result?.fileSeconds !== undefined) {
		const lines = reportForRun(root, result.fileSeconds, {
			unit: "worker-seconds",
		});
		if (lines.length > 0) writeFd(1, `${lines.join("\n")}\n`);
	}

	process.exitCode = !run.forcedRed && run.status === 0 ? 0 : 1;
}

/**
 * @param {string} root
 * @param {import("./lib/pytest-child.js").CeilingKill} kill
 * @param {{ sha: string|undefined, startedAtMs: number, argv: string[],
 *    touchedBase: import("./lib/touched-tests.js").TouchedBase|null }} run
 */
function recordCeilingKill(
	root,
	kill,
	{ sha, startedAtMs, argv, touchedBase },
) {
	recordKill(
		ceilingKillRow(kill, {
			sha: sha ?? "",
			startedAtMs,
			argv,
			sessionId: idSeam.fromEnv() || null,
			lander: idSeam.isLanderRun(),
			touchedBase,
		}),
		{ root: repoRoot(root), say: (text) => writeFd(2, text) },
	);
}

/**
 * @param {import("./lib/test-pass-marker.js").Scope|null|undefined} scope
 * @param {Plan["touched"]} touched
 */
function runScope(scope, touched) {
	return touched === null || !scope
		? scope
		: { ...scope, touched: true, ...touched };
}

/**
 * @typedef {{ args: string[], touched: { resolvedFiles: number,
 *    leftOut: string[],
 *    touchedBase: import("./lib/touched-tests.js").TouchedBase }|null }} Plan
 */

/**
 * @param {string[]} argv
 * @param {string} root
 * @returns {Plan|number}
 */
function pytestPlan(argv, root) {
	if (argv.length > 0)
		return {
			args: argv.length === 1 && argv[0] === FULL ? [] : argv,
			touched: null,
		};
	const sessionId = idSeam.fromEnv();
	const from = readTouchedBase();
	try {
		const ownWork =
			sessionId && from === "merge-base"
				? ownDefaultWork(root, sessionId)
				: undefined;
		if (ownWork === null)
			throw new Error(
				"this session's own work could not be read: git would not say what is uncommitted, write the commit carrying it, or diff that commit",
			);
		const { files, leftOut, banner } = selectTouched(root, {
			suite: "pytest",
			from,
			...(ownWork ? { ownWork } : {}),
		});
		writeFd(1, banner);
		if (files.length > 0)
			return {
				args: files,
				touched: { resolvedFiles: files.length, leftOut, touchedBase: from },
			};
		appendEmptyTouchedLine(repoRoot(root) || root, root, {
			suite: "pytest",
			sessionId: sessionId || null,
			argv: [],
			leftOut,
			touchedBase: from,
		});
		return 0;
	} catch (error) {
		writeFd(
			2,
			narrowingRefusal({
				ruling: "(#2934)",
				cause: error,
				wholeSuite: "npm run test:py -- scripts",
			}),
		);
		return 1;
	}
}

function handOffPath() {
	try {
		return path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "pytest-scope-")),
			"scope.json",
		);
	} catch {
		return null;
	}
}

/** @param {string} file */
function readHandOff(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	} finally {
		fs.rmSync(path.dirname(file), { recursive: true, force: true });
	}
}

module.exports = { main };

// process.exit can cut a pending stdout write on a pipe short: https://nodejs.org/api/process.html#processexit
if (require.main === module) {
	sweepDeadRunRoots("pytest");
	main().catch((e) => {
		writeFd(2, `run-pytest: ${e?.stack ?? e}\n`);
		process.exitCode = 1;
	});
}
