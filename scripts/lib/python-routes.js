/*
 * python-routes.js — where a host's `pythonRoutes` in
 * .claude/workflow-core.json disagrees with its code-standards local file's
 * route table on Python (#1863). The swallowed-error gate routes by
 * `pythonRoutes`, a copy of the table's Python rows (#1830); the table wins.
 *
 * WHICH ROWS: the table under the local file's `## Route rows` heading, each
 * backticked glob in a row's path cell taken alone, the prose beside them
 * unread. A glob reaches Python where it ends in `/`, or its last segment ends
 * in `.py` or `*`, or `pythonRoutes` names it; a bare directory or an
 * extensionless name it does not name goes unchecked.
 * A glob a later row repeats keeps the first row's kind.
 *
 * WHICH KIND: the kind cell's leading base §0 kind, or its words up to the
 * first `:`, `,` or `(`. One `pythonRoutes` cannot carry — shell, hook module,
 * a local kind such as tool configuration — is expected there as `none`: the
 * gate judges programs alone, and the table makes none of these one.
 */

const { PYTHON_KINDS } = require("./workflow-core-config.js");
const { requiredGroup } = require("./regex-group.js");

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
	return base ?? c.replace(/[:,(][\s\S]*$/, "").trim();
};

/** @param {string} glob */
const isPythonReachable = (glob) => {
	const last = glob.slice(glob.lastIndexOf("/") + 1);
	return last === "" || last.endsWith(".py") || last.endsWith("*");
};

/**
 * One table row's globs onto `rows`, or its line onto `unread` where it has
 * no backticked glob or no kind cell.
 * @param {string} line
 * @param {number} at its 1-based document line
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

/**
 * The route table's rows, one per glob, with their 1-based document line,
 * and the lines of any row it could not read.
 * @param {string} text
 */
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

/**
 * A local row's kind as `pythonRoutes` must carry it, and how a finding says
 * so where the two spellings differ.
 * @param {string} kind
 */
const declaredKindFor = (kind) => {
	const want = PYTHON_KINDS.find((k) => k === kind) ?? "none";
	const routed = `the local route table routes it to ${kind}${want === kind ? "" : `, which pythonRoutes carries as ${want}`}`;
	return { want, routed };
};

/**
 * A row missing from either side, and a kind that differs.
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
 * The rows both sides hold, where they stand in another order: one finding,
 * on the first row out of place.
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
 * Each disagreement between the local file's Python route rows and
 * `pythonRoutes`. `line` is the row's document line, 0 for a row only
 * `pythonRoutes` holds.
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

module.exports = { pythonRouteDrift };
