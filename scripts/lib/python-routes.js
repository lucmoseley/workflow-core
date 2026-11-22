const { globMatches } = require("./pathspec-glob.js");
const { PYTHON_KINDS } = require("./workflow-core-config.js");
const { requiredGroup } = require("./regex-group.js");
const { beforeMatch } = require("./cut-at.js");

/** @typedef {import("./workflow-core-config.js").PythonKind} PythonKind */
/** @typedef {{ glob: string, kind: string, line: number }} RouteRow */
/** @typedef {{ line: number, glob: string, detail: string }} Drift */

const BASE_KINDS = ["hook module", "test", "shell", "program", "library"];
const HEADING = /^## Route rows\b/;
const SEPARATOR = /^\|[\s:|-]+\|$/;

const GLOB = /`([^`]+)`/g;

/** @param {string} cell */
const kindOf = (cell) => {
	const c = cell.trim().toLowerCase();
	const base = [...BASE_KINDS, "none"].find(
		(k) => c.startsWith(k) && !/^\w/.test(c.slice(k.length)),
	);
	return base ?? beforeMatch(c, /[:,(]/).trim();
};

/** @param {string} glob */
const isPythonReachable = (glob) => {
	const last = glob.slice(glob.lastIndexOf("/") + 1);
	return last === "" || last.endsWith(".py") || last.endsWith("*");
};

/**
 * @param {string} line
 * @param {number} at
 * @param {{ rows: RouteRow[], unread: number[] }} into
 */
function readRow(line, at, { rows, unread }) {
	const [paths, kind] = line.slice(1, -1).split("|");
	const globs =
		paths === undefined
			? []
			: [...paths.matchAll(GLOB)].map((m) => requiredGroup(m, 1, GLOB));
	if (kind === undefined || globs.length === 0) unread.push(at);
	else
		for (const glob of globs) rows.push({ glob, kind: kindOf(kind), line: at });
}

/** @param {string} text */
function parseRouteRows(text) {
	const found = {
		rows: /** @type {RouteRow[]} */ ([]),
		unread: /** @type {number[]} */ ([]),
	};
	const lines = text.split("\n").map((l) => l.trim());
	const head = lines.findIndex((l) => HEADING.test(l));
	if (head === -1) return found;
	const rest = lines.slice(head + 1);
	const sep = rest.findIndex((l) => SEPARATOR.test(l) || /^#{1,2} /.test(l));
	const [separator, ...body] = sep === -1 ? [] : rest.slice(sep);
	if (separator === undefined || !SEPARATOR.test(separator)) return found;
	for (const [n, line] of body.entries()) {
		if (!line.startsWith("|")) break;
		readRow(line, head + sep + n + 3, found);
	}
	return found;
}

/** @param {string} kind */
const declaredKindFor = (kind) => {
	const want = PYTHON_KINDS.find((k) => k === kind) ?? "none";
	const routed = `the local route table routes it to ${kind}${want === kind ? "" : `, which pythonRoutes carries as ${want}`}`;
	return { want, routed };
};

/**
 * @param {Map<string, RouteRow>} local
 * @param {Record<string, PythonKind>} declared
 * @returns {Drift[]}
 */
function rowDrift(local, declared) {
	/** @type {Drift[]} */
	const drift = [];
	for (const [glob, { kind, line }] of local) {
		const { want, routed } = declaredKindFor(kind);
		const have = Object.hasOwn(declared, glob) ? declared[glob] : undefined;
		if (have === undefined)
			drift.push({
				line,
				glob,
				detail: `${routed}, and pythonRoutes has no such row: add "${glob}": "${want}"`,
			});
		else if (have !== want)
			drift.push({
				line,
				glob,
				detail: `${routed}, pythonRoutes to ${have}: make it "${want}"`,
			});
	}
	for (const [glob, kind] of Object.entries(declared))
		if (!local.has(glob))
			drift.push({
				line: 0,
				glob,
				detail: `pythonRoutes routes it to ${kind}, and no local route row reaching Python does: add the row to the local table, or drop it from pythonRoutes`,
			});
	return drift;
}

/**
 * @param {Map<string, RouteRow>} local
 * @param {Record<string, PythonKind>} declared
 * @returns {Drift[]}
 */
function orderDrift(local, declared) {
	const ours = [...local.values()].filter((r) =>
		Object.hasOwn(declared, r.glob),
	);
	const theirs = Object.keys(declared).filter((g) => local.has(g));
	const first = ours.find((r, n) => r.glob !== theirs[n]);
	if (first === undefined) return [];
	return [
		{
			line: first.line,
			glob: first.glob,
			detail: `pythonRoutes holds the shared rows in another order, and the first match wins: the table has ${ours.map((r) => r.glob).join(", ")}; pythonRoutes ${theirs.join(", ")}`,
		},
	];
}

/**
 * @param {string} text
 * @param {Record<string, PythonKind> | undefined} declared
 * @returns {{ rows: number, drift: Drift[] }}
 */
function pythonRouteDrift(text, declared = {}) {
	const { rows, unread } = parseRouteRows(text);
	/** @type {Map<string, RouteRow>} */
	const local = new Map();
	for (const row of rows)
		if (
			(isPythonReachable(row.glob) || Object.hasOwn(declared, row.glob)) &&
			!local.has(row.glob)
		)
			local.set(row.glob, row);
	const drift = unread.map((line) => ({
		line,
		glob: "(no glob)",
		detail:
			"this route row has no backticked glob or no kind cell, so whether it routes Python went unchecked",
	}));
	return {
		rows: local.size,
		drift: [
			...drift,
			...rowDrift(local, declared),
			...orderDrift(local, declared),
		],
	};
}

/**
 * @param {Record<string, PythonKind> | undefined} declared
 * @param {string} rel
 * @returns {PythonKind | undefined}
 */
const pythonRouteKind = (declared, rel) =>
	Object.entries(declared ?? {}).find(([glob]) => globMatches(glob, rel))?.[1];

module.exports = { pythonRouteDrift, pythonRouteKind };
