const { caught } = require("./caught.js");
const { checkRouteSetName, inRouteSet } = require("./commit-route.js");
const { armed } = require("./precommit-arm.js");

/**
 * @typedef {"all" | "merge" | "batch"} GateSet
 * @typedef {"every" | "merge" | "batch" | "none"} Lander
 * @typedef {{ status: string, path: string }} StagedEntry
 * @typedef {{ always: true }
 *   | { pattern: RegExp, live?: boolean, computed?: string }
 *   | { computed: string }} Arm
 * @typedef {{ exit: number, stdout: string, stderr: string }} RowResult
 * @typedef {{ routes?: string[], unlessRoutes?: string[], facts?: string[],
 *   unlessFacts?: string[] }} When
 * @typedef {{ id: string, lander?: Lander, arm: Arm, when?: When,
 *   policy: "gate" | "warn", quietPass?: boolean }} Row
 */

/**
 * @template {Row} R
 * @typedef {{
 *   staged?: () => StagedEntry[],
 *   computed?: (name: string) => string[],
 *   exists?: (rel: string) => boolean,
 *   load: (row: R) => () => RowResult | Promise<RowResult>,
 *   write: (fd: number, text: string) => void,
 *   interrupted: () => Promise<number | null>,
 *   route?: () => string | null,
 *   fact?: (name: string) => boolean,
 * }} Ports
 */

/** @param {string} name */
const missingPortLine = (name) =>
	`a row arms on a path, and this hook passes no ${name} port`;

const PATH_PORTS = /** @type {const} */ (["staged", "computed", "exists"]);

/**
 * @template {Function} F
 * @param {F | undefined} port
 * @returns {F}
 */
const pathPort = (port) => /** @type {F} */ (port);

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

/** @typedef {{ hook: string, noun: string }} Voice */

/** @type {Voice} */
const PRE_COMMIT = { hook: "pre-commit", noun: "gate" };

/** @param {Row} row */
const armsOnPaths = (row) => !("always" in row.arm);

/**
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
	const fact = (/** @type {string} */ name) => {
		if (!ports.fact)
			throw new Error(
				`row ${row.id} arms on the fact '${name}', and this hook passes no fact port`,
			);
		return ports.fact(name);
	};
	if (w.facts && !w.facts.every(fact)) return false;
	return !w.unlessFacts?.some(fact);
}

/**
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
			list = pathPort(ports.computed)(row.arm.computed);
		} catch (e) {
			ports.write(2, crashLine(voice, row, "load", e));
			return "broken";
		}
	return armed(row.arm, staged, list, pathPort(ports.exists))
		? "armed"
		: "unarmed";
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
 * @template {Row} R
 * @param {{ rows: R[], gates: GateSet, ports: Ports<R>, voice?: Voice }} input
 * @returns {Promise<number>}
 */
async function dispatch({ rows, gates, ports, voice = PRE_COMMIT }) {
	for (const { when } of rows)
		for (const name of [...(when?.routes ?? []), ...(when?.unlessRoutes ?? [])])
			checkRouteSetName(name);
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
			} catch (e) {
				ports.write(
					2,
					`${voice.hook}: the commit route would not read (${caught(e).message.split("\n")[0]}), so every ${voice.noun} that arms on a route stood down.\n`,
				);
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
 * @template {Row} R
 * @param {Ports<R>} ports
 * @param {Voice} voice
 * @returns {Promise<{ staged: StagedEntry[] } | { exit: number }>}
 */
async function readStagedOrRefuse(ports, voice) {
	try {
		const missing = PATH_PORTS.find((name) => !ports[name]);
		if (missing) {
			ports.write(2, `${voice.hook}: ${missingPortLine(missing)}\n`);
			return { exit: 2 };
		}
		return { staged: pathPort(ports.staged)() };
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
};
