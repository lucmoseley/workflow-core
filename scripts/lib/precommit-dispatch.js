/*
 * precommit-dispatch.js — the git-hook dispatcher's core (#5172, #5207):
 * every Node step of a git hook runs in one Node process, so they share one
 * startup instead of paying one each. Built for .husky/pre-commit's member
 * gates; each other hook brings its own registry and entry.
 *
 * THE EXIT CONTRACT. Rows run in order, and the first gating red ends the
 * run with that row's code: 1 for FAIL, 2 for BROKEN, a program's own code.
 * 0 means every armed row passed, skipped or only warned; 1 where git will
 * not name the staged paths. Each row's stdout and stderr reach fds 1 and 2
 * when it finishes, before the next starts — except a `quietPass` row's pass
 * with no WARN in it, whose output is dropped.
 *
 * THE FAILURE POLICY, per row (#5171). A `gate` row fails closed: a throw
 * while its module loads, while the list it arms on is computed or while it
 * runs is BROKEN, exit 2, with one line naming the row. A `warn` row never
 * refuses: its output prints, whatever its exit, and its own throw prints
 * one line naming it and the run goes on.
 *
 * ARMING. A row arms `always`, on a pattern any staged path matches, or on
 * a list a port computes, any member of which is staged. Its `when`, where
 * set, narrows that further to the commit routes and hook facts it names; a
 * route that will not read arms no row whose `when` names routes. The staged
 * paths are read only where some row arms on a path.
 *
 * A SIGNAL (#5188). A row runs to its end, so its own cleanup runs; the
 * `interrupted` port is asked before each row, after a gating red and after
 * the last, and once it answers a code, no further row runs and the run
 * exits with it, saying so on fd 2.
 */

const { caught } = require("./caught.js");
const { inRouteSet } = require("./commit-route.js");
const { armed } = require("./precommit-arm.js");

/**
 * @typedef {"all" | "merge" | "batch"} GateSet
 * @typedef {"every" | "merge" | "batch" | "none"} Lander
 * @typedef {{ status: string, path: string }} StagedEntry
 * @typedef {{ always: true }
 *   | { pattern: RegExp, live?: boolean, computed?: string }
 *   | { computed: string }} Arm `live` keeps the paths armed_live would:
 *   added or modified, and still on disk
 * @typedef {{ exit: number, stdout: string, stderr: string }} RowResult
 * @typedef {{ routes?: string[], unlessRoutes?: string[], facts?: string[],
 *   unlessFacts?: string[] }} When `routes` any of, `unlessRoutes` none of,
 *   each a lib/commit-route.js route set name or one route; `facts` all of,
 *   `unlessFacts` none of, each a fact the hook's entry answers
 * @typedef {{ id: string, lander?: Lander, arm: Arm, when?: When,
 *   policy: "gate" | "warn", quietPass?: boolean }} Row `lander` absent runs
 *   the row in every gate set
 */

/**
 * @template {Row} R
 * @typedef {{
 *   staged: () => StagedEntry[],
 *   computed: (name: string) => string[],
 *   exists: (rel: string) => boolean,
 *   load: (row: R) => () => RowResult | Promise<RowResult>,
 *   write: (fd: number, text: string) => void,
 *   interrupted: () => Promise<number | null>,
 *   route?: () => string | null,
 *   fact?: (name: string) => boolean,
 * }} Ports `staged` throws where git will not name the staged paths;
 *   `interrupted` answers the code a caught signal owes, 128 + n, else null;
 *   `route` the commit route, null where it will not read
 */

/** @param {string} hook @param {string} noun */
const stoppedLine = (hook, noun) =>
	`${hook}: a signal stopped the run; no ${noun} ran after it.\n`;

const STOPPED_LINE = stoppedLine("pre-commit", "gate");

/** @type {Record<Lander, GateSet[]>} */
const SETS = {
	every: ["all", "merge", "batch"],
	merge: ["all", "merge"],
	batch: ["all", "batch"],
	none: ["all"],
};

/**
 * The hook a run speaks for, and what its rows are called in its lines.
 * @typedef {{ hook: string, noun: string }} Voice
 */

/** @type {Voice} */
const PRE_COMMIT = { hook: "pre-commit", noun: "gate" };

/**
 * Whether `row`'s arm reads the staged paths.
 * @param {Row} row
 */
const armsOnPaths = (row) => !("always" in row.arm);

/**
 * Whether `row`'s `when` holds on this commit.
 * @template {Row} R
 * @param {R} row
 * @param {Ports<R>} ports
 * @param {() => string | null} route
 */
function whenHolds(row, ports, route) {
	const w = row.when;
	if (!w) return true;
	if (w.routes || w.unlessRoutes) {
		const r = route();
		if (r === null) return false;
		if (w.routes && !w.routes.some((name) => inRouteSet(name, r))) return false;
		if (w.unlessRoutes?.some((name) => inRouteSet(name, r))) return false;
	}
	const fact = (/** @type {string} */ name) => ports.fact?.(name) ?? false;
	if (w.facts && !w.facts.every(fact)) return false;
	return !w.unlessFacts?.some(fact);
}

/**
 * Whether `row` runs on this commit: `broken` where the list it arms on will
 * not compute.
 * @template {Row} R
 * @param {R} row
 * @param {StagedEntry[]} staged
 * @param {Ports<R>} ports
 * @param {Voice} voice
 * @returns {"armed" | "unarmed" | "broken"}
 */
function armingOf(row, staged, ports, voice) {
	/** @type {string[]} */
	let list = [];
	if ("computed" in row.arm && row.arm.computed !== undefined)
		try {
			list = ports.computed(row.arm.computed);
		} catch (e) {
			ports.write(2, crashLine(voice, row, "load", e));
			return "broken";
		}
	return armed(row.arm, staged, list, ports.exists) ? "armed" : "unarmed";
}

/**
 * @param {Voice} voice
 * @param {Row} row
 * @param {"load" | "run"} at
 * @param {unknown} e
 */
const crashLine = (voice, row, at, e) =>
	`${voice.hook}: the ${row.id} ${voice.noun} ${at === "load" ? "could not load" : "threw"}: ${caught(e).message}\n`;

/**
 * The hook's exit code for this commit's armed rows. The staged paths are
 * read before any row runs where some row in `gates` arms on a path, and
 * never otherwise.
 *
 * @template {Row} R
 * @param {{ rows: R[], gates: GateSet, ports: Ports<R>, voice?: Voice }} input
 * @returns {Promise<number>}
 */
async function dispatch({ rows, gates, ports, voice = PRE_COMMIT }) {
	const inSet = rows.filter(
		(row) => !row.lander || SETS[row.lander].includes(gates),
	);
	if (!inSet.some(armsOnPaths)) return runRows(inSet, [], ports, voice);
	const read = await readStagedOrRefuse(ports, voice);
	return "exit" in read ? read.exit : runRows(inSet, read.staged, ports, voice);
}

/**
 * @template {Row} R
 * @param {R[]} rows
 * @param {StagedEntry[]} staged
 * @param {Ports<R>} ports
 * @param {Voice} voice
 * @returns {Promise<number>}
 */
async function runRows(rows, staged, ports, voice) {
	const stopped = async () => {
		const code = await ports.interrupted();
		if (code !== null) ports.write(2, stoppedLine(voice.hook, voice.noun));
		return code;
	};
	/** @type {{ value: string | null } | undefined} */
	let routeRead;
	const route = () => {
		if (!routeRead) {
			let value = null;
			try {
				value = ports.route?.() ?? null;
			} catch {
				/* A route that will not read arms no route-narrowed row. */
			}
			routeRead = { value };
		}
		return routeRead.value;
	};
	for (const row of rows) {
		if (!whenHolds(row, ports, route)) continue;
		const arming = armingOf(row, staged, ports, voice);
		if (arming === "unarmed") continue;
		const before = await stopped();
		if (before !== null) return before;
		const result =
			arming === "armed" ? await runRow(row, ports, voice) : { exit: 2 };
		if (row.policy === "warn" || result.exit === 0) continue;
		const after = await stopped();
		if (after !== null) return after;
		return result.exit;
	}
	return (await stopped()) ?? 0;
}

/**
 * The commit's staged entries, else the exit code where git will not name
 * them: 1, or the 128 + n of a caught signal, which kills git too.
 * @template {Row} R
 * @param {Ports<R>} ports
 * @param {Voice} voice
 * @returns {Promise<{ staged: StagedEntry[] } | { exit: number }>}
 */
async function readStagedOrRefuse(ports, voice) {
	try {
		return { staged: ports.staged() };
	} catch (e) {
		const code = await ports.interrupted();
		ports.write(
			2,
			code === null
				? `${voice.hook}: ${caught(e).message}\n`
				: stoppedLine(voice.hook, voice.noun),
		);
		return { exit: code ?? 1 };
	}
}

/**
 * @template {Row} R
 * @param {R} row
 * @param {Ports<R>} ports
 * @param {Voice} voice
 * @returns {Promise<{ exit: number }>}
 */
async function runRow(row, ports, voice) {
	/** @type {"load" | "run"} */
	let at = "load";
	try {
		const run = ports.load(row);
		at = "run";
		const { exit, stdout, stderr } = await run();
		if (row.quietPass && exit === 0 && !/WARN:/.test(stdout + stderr))
			return { exit };
		if (stdout) ports.write(1, stdout);
		if (stderr) ports.write(2, stderr);
		return { exit };
	} catch (e) {
		ports.write(2, crashLine(voice, row, at, e));
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

module.exports = {
	dispatch,
	gateSetOf,
	STOPPED_LINE,
	stoppedLine,
};
