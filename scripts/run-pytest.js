#!/usr/bin/env node
/*
 * `npm run test:py`, wrapped so a green pytest run leaves the pre-push certificate
 * that vitest leaves (mantahostels#987, mantahostels#1256).
 *
 * WHY A WRAPPER AND NOT ONLY A PLUGIN. The marker records the tree the suite
 * read — what was already uncommitted, who else held it, what moved mid-run —
 * and that policy lives in `lib/tree-drift.js` and `lib/test-pass-marker.js`.
 * Reimplementing it in Python would make a second copy that drifts from the
 * first. So the plugin answers "did it pass, and how much ran", this answers
 * everything else, and the two meet in a JSON temp file.
 *
 * IT MUST NOT CHANGE WHAT `test:py` MEANS. Arguments pass straight through,
 * pytest writes to the terminal unbuffered, and this exits on the child's own
 * code — a marker that cannot be written costs a warning at the next push,
 * never a red run. cli-args-exempt: every argument is pytest's, passed through
 * unparsed.
 *
 * UNDER THE `landing` MODULE A BARE RUN IS A TOUCHED ONE (#2934): it hands
 * pytest only the test files `lib/touched-tests.js` resolves from the
 * session's own changed paths, as a bare `npm run test` does vitest (#2930).
 * With a session id those are the paths its overlay would carry, read in the
 * shared tree, so a neighbour's uncommitted or untracked file selects nothing
 * (#2958). An empty set spawns nothing, records no marker, writes its ledger
 * line and exits 0; the lander runs the full suite. Any argument at all keeps
 * the run exactly as typed.
 *
 * THE SUITE CEILING (#2702, ruled at #2667). pytest leads a process group of
 * its own, and at the ceiling `lib/suite-ceiling.js` sets, the whole group is
 * killed, xdist workers included: the run exits 1 and records no marker. The
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
	formatNeighbourDirty,
	fromArbiter,
	endOfRunTreeIdentity,
} = require("./lib/tree-drift.js");
const {
	formatFilteredRun,
	markerFrom,
	record,
	repoRoot,
} = require("./lib/test-pass-marker.js");
const { worktreeRoot } = require("./lib/host-root.js");
const { moduleOn } = require("./lib/workflow-core-config.js");
const { selectTouched } = require("./lib/touched-tests.js");
const { ownDefaultWork } = require("./lib/own-selection.js");
const { appendEmptyTouchedLine } = require("./lib/run-ledger.js");
const idSeam = require("./lib/session-id.js");
const { reportForRun } = require("./lib/run-cost-report.js");
const { writeFd } = require("./lib/write-fd.js");
const { pythonBin, pythonSpawnRemedy } = require("./lib/python-bin.js");
const { spawnInRunScope, endRunScope } = require("./lib/user-scope.js");
const {
	CEILING_CLOSE,
	SETTLE_MS,
	armCeiling,
	ceilingHeadline,
	ceilingMs,
	deadlineUnwritten,
	groupUnkilled,
	killGroup,
	monotonicMs,
} = require("./lib/suite-ceiling.js");

/* Resolved through the host-root seam (#1), never `__dirname`: the pytest suite,
 * its `scripts/` on PYTHONPATH and the tree-drift snapshot all belong to the
 * tree under test — the host repo, or the linked worktree of it the run was
 * launched in (#2940) — and in a plugin install `__dirname` would name the
 * plugin cache instead. */
const TREE_ROOT = worktreeRoot();

/* `-n 2` more than halves the local suite but gains only ~7% on the 2-vCPU CI
 * runner (mantahostels#313). No other worker count was ever measured;
 * requirements-dev.txt has why two, not one per core. */
/* `-p` here rather than in pytest.ini's addopts, so a bare `pytest` run
 * writes no marker. */
const DEFAULT_ARGS = ["-n", "2", "-p", "pytest_pass_plugin"];

/* Passed on to pytest's group rather than left to end this wrapper, so pytest
 * still prints its own interrupted summary. */
const FORWARDED = /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]);

/**
 * Sets the exit code rather than returning it, the shape runInProcessAsync
 * reads.
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
async function runAndRecord({ args, resolvedFiles }, root) {
	// Before the spawn, so the marker's duration covers the whole run (mantahostels#1953).
	const startedAtMs = Date.now();
	const startedAtMono = monotonicMs();
	const before = readTreeSnapshot(root);
	const inherited = fromArbiter(before);

	const handOff = handOffPath();
	const inflightFile = handOff
		? path.join(path.dirname(handOff), "inflight.json")
		: null;
	const run = await runPytest(args, root, handOff, inflightFile);
	// Set only when the spawn itself fails; a failing pytest sets status instead.
	if (run.error)
		writeFd(
			2,
			`pytest could not be run: ${run.error}\n${pythonSpawnRemedy(run.error)}`,
		);
	const result = handOff ? readHandOff(handOff) : null;

	const after = readTreeSnapshot(root);
	const drifted = drift(before, after);
	for (const message of [format(drifted), formatNeighbourDirty(inherited)])
		if (message) writeFd(2, `${message}\n`);

	// BOTH verdicts, never the plugin's alone. `pytest_terminal_summary` runs
	// before teardown and interpreter shutdown, so an INTERNALERROR after it —
	// or earlyoom killing python between the two — leaves `passed: true` behind
	// a non-zero exit, and that must not read as a pass.
	if (!run.forcedRed && run.status === 0 && result?.passed === true && after) {
		record(
			markerFrom(before, after, drifted, {
				held: inherited,
				scope: runScope(result.scope, resolvedFiles),
				suite: "pytest",
				startedAtMs,
				elapsedMs: monotonicMs() - startedAtMono,
				// pytest has no `--isolated` path (mantahostels#2187): every run
				// reads the shared tree, at `root` — the same directory the
				// identity below is taken in.
				isolated: false,
				treeAtEnd: endOfRunTreeIdentity(root),
			}),
			{ root: repoRoot(root) },
		);
		const line = formatFilteredRun(result.scope);
		if (line) writeFd(1, `${line}\n`);
	}

	// Red or green, since it reports cost and never a verdict (#1884). No
	// hand-off, as under `--collect-only` or an interrupt, gets no report.
	if (result?.fileSeconds !== undefined) {
		const lines = reportForRun(root, result.fileSeconds, {
			unit: "worker-seconds",
		});
		if (lines.length > 0) writeFd(1, `${lines.join("\n")}\n`);
	}

	process.exitCode = run.forcedRed || run.status === null ? 1 : run.status;
}

/**
 * The plugin's scope, marked touched with its file count on a touched run, so
 * the run ledger keys its kind on them (#2958).
 *
 * @param {import("./lib/test-pass-marker.js").Scope|null|undefined} scope
 * @param {number|null} resolvedFiles
 */
function runScope(scope, resolvedFiles) {
	return resolvedFiles === null || !scope
		? scope
		: { ...scope, touched: true, resolvedFiles };
}

/**
 * @typedef {{ args: string[], resolvedFiles: number|null }} Plan what pytest
 *   is handed, and a touched run's file count: null on a run as typed
 */

/**
 * What pytest is handed: `argv` as typed, or under `landing` a bare run's
 * touched files, its banner printed. A number is the exit code of a run that
 * spawns nothing: 0 on an empty selection, 1 where the changed paths could
 * not be read (#2698).
 *
 * @param {string[]} argv
 * @param {string} root
 * @returns {Plan|number}
 */
function pytestPlan(argv, root) {
	if (argv.length > 0 || !moduleOn("landing", { root }))
		return { args: argv, resolvedFiles: null };
	const sessionId = idSeam.fromEnv();
	try {
		const ownWork = sessionId ? ownDefaultWork(root, sessionId) : undefined;
		if (ownWork === null)
			throw new Error(
				"this session's own work could not be read: git would not say what is uncommitted, write the commit carrying it, or diff that commit",
			);
		const { files, banner } = selectTouched(root, {
			suite: "pytest",
			...(ownWork ? { ownWork } : {}),
		});
		writeFd(1, banner);
		if (files.length > 0) return { args: files, resolvedFiles: files.length };
		appendEmptyTouchedLine(repoRoot(root) || root, root, {
			suite: "pytest",
			sessionId: sessionId || null,
			argv: [],
		});
		return 0;
	} catch (error) {
		writeFd(
			2,
			`\nNARROWING FAILED, SO NOTHING RAN (#2934) — ${String(error instanceof Error ? error.message : error).trim()}\n\n` +
				"A failed narrowing is never widened to the whole suite. Fix the cause and re-run, or run the whole suite on purpose:\n\n" +
				"  npm run test:py -- scripts\n\n",
		);
		return 1;
	}
}

/**
 * @param {string[]} argv
 * @param {string} root
 * @param {string|null} handOff
 * @param {string|null} inflightFile
 * @returns {Promise<{ status: number|null, error: Error|null,
 *   forcedRed: boolean }>} `forcedRed` on a run killed at the ceiling or one
 *   that hit its scope's task cap, which fails whatever pytest said
 */
function runPytest(argv, root, handOff, inflightFile) {
	const ceiling = ceilingMs();
	return new Promise((resolve) => {
		/* Injected at WFC_PYTHON, never by PATH, because the tests feed it chosen
		 * hand-offs (§N7, #2102). */
		const child = spawnInRunScope(
			pythonBin(),
			["-m", "pytest", ...DEFAULT_ARGS, ...argv],
			{
				cwd: root,
				stdio: "inherit",
				detached: true,
				env: {
					...process.env,
					...(handOff ? { WFC_PYTEST_SCOPE_OUT: handOff } : {}),
					...(inflightFile ? { WFC_PYTEST_INFLIGHT_OUT: inflightFile } : {}),
					// The plugin is loaded by name before conftest puts `scripts/` on
					// sys.path, so the path has to be given here. It ships beside this
					// wrapper, not in the host's `scripts/`, so a plugin install needs
					// `__dirname` too; the host's goes first so its own imports win (#1285).
					PYTHONPATH: [
						path.join(root, "scripts"),
						__dirname,
						process.env.PYTHONPATH,
					]
						.filter(Boolean)
						.join(path.delimiter),
				},
			},
		);
		const spawnedAtMono = monotonicMs();
		let ceilingKilled = false;
		const forward = (/** @type {NodeJS.Signals} */ signal) => {
			const unreached = child.pid ? killGroup(child.pid, signal) : null;
			if (unreached)
				writeFd(
					2,
					`${signal} could not be passed on to pytest's process group (${unreached}); it may run on.\n`,
				);
		};
		for (const signal of FORWARDED) process.on(signal, forward);

		/** @type {ReturnType<typeof setTimeout>|null} */
		let giveUp = null;
		const held = armCeiling({
			pgid: child.pid,
			ms: ceiling,
			now: spawnedAtMono,
			onCeiling: () => {
				ceilingKilled = true;
				writeFd(
					2,
					buildCeilingReport(readInflight(inflightFile), {
						ceiling,
						elapsed: monotonicMs() - spawnedAtMono,
					}),
				);
				const unkilled = child.pid ? killGroup(child.pid) : null;
				if (unkilled) writeFd(2, groupUnkilled("pytest", unkilled));
				giveUp = setTimeout(() => {
					/* A child that never closed would keep this process alive past
					 * its own verdict. */
					child.unref();
					settle(null, null);
				}, SETTLE_MS);
				giveUp.unref?.();
			},
		});
		if (held.error) writeFd(2, deadlineUnwritten(held.error));

		let settled = false;
		/** @param {number|null} status @param {Error|null} error */
		const settle = (status, error) => {
			if (settled) return;
			settled = true;
			if (giveUp) clearTimeout(giveUp);
			held.release();
			for (const signal of FORWARDED) process.off(signal, forward);
			const capped = endRunScope(child);
			if (capped) writeFd(2, capped);
			resolve({ status, error, forcedRed: ceilingKilled || capped !== null });
		};
		child.on("error", (error) => settle(null, error));
		child.on("close", (status) => settle(status, null));
	});
}

/**
 * @typedef {{ open: { nodeid: string, stage: string }[], finished: number,
 *   collected: number|null }} PytestInflight
 */

/**
 * @param {string|null} file
 * @returns {PytestInflight|null}
 */
function readInflight(file) {
	if (!file) return null;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		return Array.isArray(parsed.open) && Number.isInteger(parsed.finished)
			? parsed
			: null;
	} catch {
		/* A missing or torn file costs the report its names, never the kill
		 * itself (#2702). */
		return null;
	}
}

/**
 * @param {PytestInflight|null} inflight
 * @param {{ ceiling: number, elapsed: number }} run
 */
function buildCeilingReport(inflight, run) {
	const lines = ["", `${ceilingHeadline("pytest", run)}.`, ""];
	if (inflight === null)
		lines.push(
			"pytest reported no tests in flight, so the list is unavailable: the kill",
			"came before a test started, or the plugin could not write it.",
		);
	else {
		if (inflight.open.length > 0) {
			lines.push("In flight:");
			for (const row of inflight.open)
				lines.push(`  ${row.nodeid} — ${row.stage}`);
		} else lines.push("No test was in flight.");
		lines.push(
			"",
			inflight.collected === null
				? "Never started: unavailable, as pytest reported no collected count."
				: `Never started: ${String(inflight.collected - inflight.finished - inflight.open.length)} test(s).`,
			`Finished: ${String(inflight.finished)} test(s).`,
		);
	}
	lines.push("", ...CEILING_CLOSE, "");
	return lines.join("\n");
}

/** Where the plugin should write its verdict, or null where tmp will not have it. */
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

/** The plugin's verdict, or null where it never wrote one — an interrupted run,
 * a pytest too old to load it, an unreadable temp dir. */
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

/* exitCode, never process.exit: an exit straight after a write to a pipe
 * can drop it (mantahostels#1943). */
if (require.main === module)
	main().catch((e) => {
		writeFd(2, `run-pytest: ${e?.stack ?? e}\n`);
		process.exitCode = 1;
	});
