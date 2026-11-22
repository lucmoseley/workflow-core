const path = require("node:path");
const { readText } = require("./file-read.js");
const { repoPath } = require("./read-audit-paths.js");
const { fileReach, isFile, isScript, languageOf } = require("./file-reach.js");

/** @typedef {import("./file-reach.js").PyEntry} PyEntry */

/**
 * @typedef {{file: string, from: string | null}} Missing
 * @typedef {{files: string[], missing: Missing[], outside: Missing[],
 *   unread: string[],
 *   unknown: string[], shadows: string[], python: boolean}} RunReach
 * @typedef {{edges: string[], missing: string[], outside: string[],
 *   shadows: string[],
 *   python: boolean, unread: boolean, unknown: boolean, faults: string[],
 *   pySearch: PyEntry[] | null}} Visit
 * @typedef {(rel: string, pySearch: PyEntry[] | null) => Visit} VisitOf
 */

/**
 * @param {string} root
 * @returns {(start: string, fault?: (file: string, msg: string) => void) =>
 *   RunReach}
 */
function readRunReach(root) {
	/** @type {Map<string, Visit>} */
	const memo = new Map();
	/** @type {VisitOf} */
	const visitOf = (rel, pySearch) => {
		const key = JSON.stringify([rel, pySearch]);
		const known = memo.get(key);
		if (known) return known;
		const found = readVisit(root, rel, pySearch);
		memo.set(key, found);
		return found;
	};
	return (start, fault = () => undefined) => {
		if (!isFile(path.join(root, start)))
			return { ...NO_RUN, missing: [{ file: start, from: null }] };
		/** @type {Set<string>} */
		const heard = new Set();
		const hear = (/** @type {string} */ rel, /** @type {string} */ msg) => {
			const key = JSON.stringify([rel, msg]);
			if (!heard.has(key)) fault(rel, msg);
			heard.add(key);
		};
		const run = {
			files: new Set([start]),
			/** @type {Map<string, string>} */
			missing: new Map(),
			/** @type {Map<string, string>} */
			outside: new Map(),
			unread: new Set(),
			unknown: new Set(),
			shadows: new Set(),
			python: false,
		};
		const scripts = [start];
		const seen = new Set(scripts);
		for (const script of scripts)
			for (const next of runScript(script, visitOf, run, hear))
				if (!seen.has(next)) {
					seen.add(next);
					scripts.push(next);
				}
		return {
			files: [...run.files],
			missing: [...run.missing].map(([file, from]) => ({ file, from })),
			outside: [...run.outside].map(([file, from]) => ({ file, from })),
			unread: [...run.unread],
			unknown: [...run.unknown],
			shadows: [...run.shadows],
			python: run.python,
		};
	};
}

/** @type {RunReach} */
const NO_RUN = {
	files: [],
	missing: [],
	outside: [],
	unread: [],
	unknown: [],
	shadows: [],
	python: false,
};

/**
 * @typedef {{files: Set<string>, missing: Map<string, string>,
 *   outside: Map<string, string>,
 *   unread: Set<string>, unknown: Set<string>, shadows: Set<string>,
 *   python: boolean}} RunSoFar
 * @typedef {{visits: {rel: string, found: Visit}[], spawned: Set<string>,
 *   pySearch: PyEntry[] | null}} Pass
 */

/**
 * @param {string} script
 * @param {VisitOf} visitOf
 * @param {RunSoFar} run
 * @param {(rel: string, msg: string) => void} hear
 * @returns {Set<string>}
 */
function runScript(script, visitOf, run, hear) {
	/** @type {PyEntry[] | null} */
	let pySearch = null;
	for (;;) {
		const pass = scriptPass(script, pySearch, visitOf);
		const settled = JSON.stringify(pass.pySearch) === JSON.stringify(pySearch);
		const stuck =
			!settled && (pass.pySearch?.length ?? 0) <= (pySearch?.length ?? -1);
		if (stuck) run.unread.add(script);
		if (settled || stuck) {
			addPass(pass, run, hear);
			return pass.spawned;
		}
		pySearch = pass.pySearch;
	}
}

/**
 * @param {Pass} pass
 * @param {RunSoFar} run
 * @param {(rel: string, msg: string) => void} hear
 */
function addPass(pass, run, hear) {
	for (const { rel, found } of pass.visits) addVisit(rel, found, run, hear);
}

/**
 * @param {string} rel
 * @param {Visit} found
 * @param {RunSoFar} run
 * @param {(rel: string, msg: string) => void} hear
 */
function addVisit(rel, found, run, hear) {
	if (found.unread) run.unread.add(rel);
	if (found.unknown) run.unknown.add(rel);
	for (const msg of found.faults) hear(rel, msg);
	nameFirst(run.outside, found.outside, rel);
	run.python ||= found.python;
	for (const p of found.shadows) run.shadows.add(p);
	for (const p of found.edges) run.files.add(p);
	nameFirst(run.missing, found.missing, rel);
}

/**
 * @param {Map<string, string>} named
 * @param {string[]} paths
 * @param {string} rel
 */
function nameFirst(named, paths, rel) {
	for (const p of paths) if (!named.has(p)) named.set(p, rel);
}

/**
 * @param {string} script
 * @param {PyEntry[] | null} pySearch
 * @param {VisitOf} visitOf
 * @returns {Pass}
 */
function scriptPass(script, pySearch, visitOf) {
	const files = [script];
	const loaded = new Set(files);
	/** @type {Pass} */
	const pass = { visits: [], spawned: new Set(), pySearch };
	for (const rel of files) {
		const found = visitOf(rel, pass.pySearch);
		pass.visits.push({ rel, found });
		pass.pySearch = found.pySearch ?? pass.pySearch;
		for (const next of found.edges)
			if (!found.pySearch || languageOf(next) !== "python")
				pass.spawned.add(next);
			else if (!loaded.has(next)) {
				loaded.add(next);
				files.push(next);
			}
	}
	return pass;
}

/** @type {Visit} */
const NO_VISIT = {
	edges: [],
	missing: [],
	outside: [],
	shadows: [],
	python: false,
	unread: false,
	unknown: false,
	faults: [],
	pySearch: null,
};

/**
 * @param {string} root
 * @param {string} rel
 * @param {PyEntry[] | null} pySearch
 * @returns {Visit}
 */
function readVisit(root, rel, pySearch) {
	const abs = path.join(root, rel);
	if (!isScript(abs)) return NO_VISIT;
	const read = readText(abs);
	if (read.state !== "read")
		throw new Error(
			`${rel} will not read: ${read.state === "absent" ? "it is gone" : read.message}`,
		);
	/** @type {string[]} */
	const faults = [];
	const reach = fileReach(abs, read.data, (m) => faults.push(m), pySearch);
	/** @type {string[]} */
	const edges = [];
	/** @type {string[]} */
	const missing = [];
	/** @type {string[]} */
	const outside = [];
	for (const e of [...reach.edges, ...reach.reads]) {
		const at = runPath(root, e);
		if (at !== null) (isFile(e) ? edges : missing).push(at);
		else if (e !== root) outside.push(toPosixRel(root, e));
	}
	return {
		edges,
		missing,
		outside,
		shadows: reach.shadows.flatMap((p) => runPath(root, p) ?? []),
		python: reach.python,
		unread: reach.unread.length > 0,
		unknown: reach.unknown.length > 0,
		faults,
		pySearch: reach.pySearch,
	};
}

/**
 * @param {string} root
 * @param {string} abs
 */
const toPosixRel = (root, abs) =>
	path.relative(root, abs).split(path.sep).join("/");

/**
 * @param {string} root
 * @param {string} abs
 */
function runPath(root, abs) {
	const rel = repoPath(root, abs);
	return rel === null || rel === "." ? null : rel;
}

module.exports = { readRunReach };
