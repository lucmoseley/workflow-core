/*
 * precommit-dispatch.js — the pre-commit dispatcher's core (#5172): every
 * member gate of .husky/pre-commit runs in one Node process, so they share
 * one startup instead of paying one each. scripts/precommit-dispatch.js is
 * its shell; lib/precommit-gates.js's rows are its members, in order.
 *
 * THE EXIT CONTRACT. Rows run in order, and the first gating red ends the
 * run with that row's code: 1 for FAIL, 2 for BROKEN, a program's own code.
 * 0 means every armed row passed, skipped or only warned. Each row's stdout
 * and stderr reach fds 1 and 2 when it finishes, before the next starts.
 *
 * THE FAILURE POLICY, per row. A `gate` row fails closed: a throw while its
 * module loads or while it runs is BROKEN, exit 2, with one line naming the
 * row. A `warn` row never refuses: its output prints, whatever its exit, and
 * its own throw prints one line naming it and the run goes on.
 *
 * ARMING. The staged entries are read once, by staged_names' own git call
 * (lib/precommit-gate.sh), so a rename arms on both its ends. A row arms
 * `always`, on a pattern any staged path matches, or on a list a port
 * computes, any member of which is staged; a pattern row's `live` narrows it
 * to the paths armed_live keeps.
 *
 * THE LANDER SETS (#4545). `--gates=merge` runs the `every` and `merge` rows,
 * `--gates=batch` the `every` and `batch` rows; a plain commit runs them all.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { spawnGitSync } = require("./git.js");

/**
 * @typedef {"all" | "merge" | "batch"} GateSet
 * @typedef {"every" | "merge" | "batch" | "none"} Lander
 * @typedef {{ status: string, path: string }} StagedEntry
 * @typedef {{ always: true }
 *   | { pattern: RegExp, live?: boolean }
 *   | { computed: string }} Arm `live` keeps the paths armed_live would:
 *   added or modified, and still on disk
 * @typedef {{ exit: number, stdout: string, stderr: string }} RowResult
 * @typedef {{ id: string, lander: Lander, arm: Arm, policy: "gate" | "warn" }} Row
 */

/**
 * @template {Row} R
 * @typedef {{
 *   staged: () => StagedEntry[],
 *   computed: (name: string) => string[],
 *   exists: (rel: string) => boolean,
 *   load: (row: R) => () => RowResult | Promise<RowResult>,
 *   write: (fd: number, text: string) => void,
 * }} Ports
 */

/** @type {Record<Lander, GateSet[]>} */
const SETS = {
	every: ["all", "merge", "batch"],
	merge: ["all", "merge"],
	batch: ["all", "batch"],
	none: ["all"],
};

/**
 * The commit's staged entries, by staged_names' call: `--no-renames` so a
 * rename is its `D` and its `A`, `-z` so a non-ASCII path is not quoted.
 * @param {string} cwd
 * @returns {StagedEntry[]}
 */
function readStaged(cwd) {
	const r = spawnGitSync(
		["diff", "--cached", "--name-status", "--no-renames", "-z"],
		{ cwd, encoding: "utf8" },
	);
	if (r.status !== 0 || r.error)
		throw new Error(
			"could not read this commit's staged paths from git — refusing, since no gate could arm.",
		);
	const fields = String(r.stdout).split("\0");
	/** @type {StagedEntry[]} */
	const entries = [];
	for (let i = 0; i + 1 < fields.length; i += 2)
		entries.push({ status: fields[i] ?? "", path: fields[i + 1] ?? "" });
	return entries;
}

/**
 * @param {Arm} arm
 * @param {StagedEntry[]} staged
 * @param {Pick<Ports<Row>, "computed" | "exists">} ports
 */
function armed(arm, staged, ports) {
	if ("always" in arm) return true;
	if ("computed" in arm) {
		const list = new Set(ports.computed(arm.computed));
		return staged.some((e) => list.has(e.path));
	}
	return staged.some(
		(e) =>
			arm.pattern.test(e.path) &&
			(!arm.live ||
				((e.status === "A" || e.status === "M") && ports.exists(e.path))),
	);
}

/**
 * @param {Row} row
 * @param {"load" | "run"} at
 * @param {unknown} e
 */
const crashLine = (row, at, e) =>
	`pre-commit: the ${row.id} gate ${at === "load" ? "could not load" : "threw"}: ${caught(e).message}\n`;

/**
 * Runs the rows armed for this commit in order, writing each one's output as
 * it finishes, and answers the hook's exit code.
 *
 * @template {Row} R
 * @param {{ rows: R[], gates: GateSet, ports: Ports<R> }} input
 * @returns {Promise<number>}
 */
async function dispatch({ rows, gates, ports }) {
	const staged = ports.staged();
	for (const row of rows) {
		if (!SETS[row.lander].includes(gates)) continue;
		if (!armed(row.arm, staged, ports)) continue;
		const result = await runRow(row, ports);
		if (row.policy === "warn" || result.exit === 0) continue;
		return result.exit;
	}
	return 0;
}

/**
 * One row, its output written: a throw becomes its one line and BROKEN.
 * @template {Row} R
 * @param {R} row
 * @param {Ports<R>} ports
 * @returns {Promise<{ exit: number }>}
 */
async function runRow(row, ports) {
	/** @type {"load" | "run"} */
	let at = "load";
	try {
		const run = ports.load(row);
		at = "run";
		const { exit, stdout, stderr } = await run();
		if (stdout) ports.write(1, stdout);
		if (stderr) ports.write(2, stderr);
		return { exit };
	} catch (e) {
		ports.write(2, crashLine(row, at, e));
		return { exit: 2 };
	}
}

/**
 * The gate set `--gates` names, `merge` or `batch`, else every gate, as the
 * hook's own `case` reads it.
 * @param {string | undefined} value
 * @returns {GateSet}
 */
function gateSetOf(value) {
	if (value === "merge" || value === "batch") return value;
	return "all";
}

/**
 * @param {string} cwd
 * @returns {(rel: string) => boolean}
 */
const existsUnder = (cwd) => (rel) => fs.existsSync(path.join(cwd, rel));

module.exports = { dispatch, existsUnder, gateSetOf, readStaged };
