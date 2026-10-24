#!/usr/bin/env node
/*
 * `npm run test:py`, wrapped so a green pytest run leaves the pre-push marker
 * that vitest leaves (mantahostels#987, mantahostels#1256).
 *
 * WHY A WRAPPER AND NOT ONLY A PLUGIN. The marker records the tree the suite
 * read — what was already uncommitted, who else held it, what moved mid-run —
 * and that policy lives in `lib/tree-drift.js` and `lib/test-pass-marker.js`.
 * Reimplementing it in Python would make a second copy that drifts from the
 * first. So the plugin answers "did it pass, and how much ran", this answers
 * everything else, and the two meet in a JSON temp file.
 *
 * IT MUST NOT CHANGE WHAT `test:py` MEANS. Arguments pass straight through, the
 * child owns the terminal, and this exits on the child's own code — a marker
 * that cannot be written costs a warning at the next push, never a red run.
 * cli-args-exempt: every argument is pytest's, passed through unparsed.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
	snapshot,
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
const { hostRoot } = require("./lib/host-root.js");
const { reportForRun } = require("./lib/run-cost-report.js");
const { writeFd } = require("./lib/write-fd.js");

/* Resolved through the host-root seam (#1), never `__dirname`: the pytest suite,
 * its `scripts/` on PYTHONPATH and the tree-drift snapshot all belong to the
 * host repo, and in a plugin install `__dirname` would name the plugin cache
 * instead. */
const ROOT = hostRoot();

/* `-n 2` is the measured worker count for this machine (CLAUDE.md §Machine
 * limits). */
/* `-p` here rather than in pytest.ini's addopts, so a bare `pytest` run in a
 * session behaves exactly as it did before mantahostels#1256 and writes no marker. */
const DEFAULT_ARGS = ["-n", "2", "-p", "pytest_pass_plugin"];

/** @param {string[]} argv */
function main(argv) {
	const root = ROOT;
	// Before the spawn, so the marker's duration covers the whole run (mantahostels#1953).
	const startedAtMs = Date.now();
	const before = snapshot(root);
	const inherited = fromArbiter(before);

	const handOff = handOffPath();
	/* Injected at WFC_PYTHON, never by PATH, because the tests feed it chosen
	 * hand-offs (§N7, #2102). */
	const child = spawnSync(
		process.env.WFC_PYTHON || "python3",
		["-m", "pytest", ...DEFAULT_ARGS, ...argv],
		{
			cwd: root,
			stdio: "inherit",
			env: {
				...process.env,
				...(handOff ? { WFC_PYTEST_SCOPE_OUT: handOff } : {}),
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
	// ENOENT on the python, EACCES, EAGAIN: spawnSync reports these on the result
	// rather than throwing, and the shell's own "command not found" is gone now
	// that a wrapper sits in front.
	if (child.error)
		process.stderr.write(
			`pytest could not be run: ${child.error}\n` +
				"Install python3 or point WFC_PYTHON at it, then its test deps: " +
				"python3 -m pip install -r requirements-dev.txt\n",
		);
	const result = handOff ? readHandOff(handOff) : null;

	const after = snapshot(root);
	const drifted = drift(before, after);
	for (const message of [format(drifted), formatNeighbourDirty(inherited)])
		if (message) process.stderr.write(`${message}\n`);

	// BOTH verdicts, never the plugin's alone. `pytest_terminal_summary` runs
	// before teardown and interpreter shutdown, so an INTERNALERROR after it —
	// or earlyoom killing python between the two — leaves `passed: true` behind
	// a non-zero exit, and that must not read as a green.
	if (child.status === 0 && result?.passed === true && after) {
		record(
			markerFrom(before, after, drifted, {
				held: inherited,
				scope: result.scope,
				suite: "pytest",
				startedAtMs,
				// pytest has no `--isolated` path (mantahostels#2187's "not this ticket"): every
				// run reads the shared tree, at `root` — the same directory the
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

	return child.status === null ? 1 : child.status;
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

if (require.main === module) process.exit(main(process.argv.slice(2)));
