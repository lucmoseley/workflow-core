const { requiredGroup } = require("./regex-group.js");

const COLUMNS = ["Job", "Primitive", "Exemplar", "Rule", "Enforcing check"];

const STANDARDS_DOCS = {
	base: "docs/code-standards-base.md",
	local: "docs/code-standards.md",
};

const AXIS_CRITERION = "Standards axis criterion";

const HEADING = /^##\s+Primitives\s*$/;
const SECTION_ID = /^#{2,3}\s+(§[0-9A-Z]+)\b/;
const RULE_ID = /§[0-9A-Z]+/g;
const BACKTICKED = /`([^`]+)`/g;

/** @typedef {"base" | "local"} Side */
/**
 * @typedef {{ side: Side, line: number, job: string, primitive: string,
 *   exemplar: string, rule: string, check: string }} Row
 */
/** @typedef {{ side: Side, line: number, job: string, message: string }} Finding */
/**
 * @typedef {{ change: "added" | "removed" | "rewritten", job: string,
 *   primitive: string, cells: string[] }} RowChange
 */
/** @typedef {{ count: number } | { unknown: string }} Count */
/**
 * @typedef {{
 *   read: (side: Side) => string | null,
 *   exists: (side: Side, rel: string) => boolean,
 *   countBreaches: (checks: { side: Side, rel: string }[]) => Promise<Count[]>,
 *   readNewHeresies: () => Count,
 * }} Ports
 */

/** @param {string} line */
const cellsOf = (line) =>
	line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((c) => c.trim());

/** @param {string} line */
const isTableLine = (line) => line.trim().startsWith("|");

/**
 * @param {Side} side
 * @param {string} text
 * @returns {{ rows: Row[] } | { unreadable: string }}
 */
function parseTable(side, text) {
	const lines = text.split("\n");
	const heading = lines.findIndex((l) => HEADING.test(l));
	if (heading === -1) return { rows: [] };
	let at = heading + 1;
	while (at < lines.length && !isTableLine(lines[at] ?? "")) {
		if (/^#{1,2}\s/.test(lines[at] ?? "")) break;
		at++;
	}
	const header = lines[at];
	if (header === undefined || !isTableLine(header))
		return { unreadable: "its Primitives section holds no table" };
	if (cellsOf(header).join("|") !== COLUMNS.join("|"))
		return {
			unreadable: `its Primitives table's header is not | ${COLUMNS.join(" | ")} |`,
		};
	/** @type {Row[]} */
	const rows = [];
	for (let i = at + 2; i < lines.length && isTableLine(lines[i] ?? ""); i++) {
		const cells = cellsOf(lines[i] ?? "");
		const [job = "", primitive = "", exemplar = "", rule = "", check = ""] =
			cells;
		rows.push({ side, line: i + 1, job, primitive, exemplar, rule, check });
	}
	return { rows };
}

/** @param {string} text */
function sectionIds(text) {
	const ids = new Set();
	for (const line of text.split("\n")) {
		const id = SECTION_ID.exec(line)?.[1];
		if (id) ids.add(id);
	}
	return ids;
}

/** @param {string} cell */
const backticked = (cell) =>
	[...cell.matchAll(BACKTICKED)].map((m) => requiredGroup(m, 1, BACKTICKED));

/** @param {string} job */
const jobKey = (job) => job.toLowerCase().replace(/\s+/g, " ");

/** @param {Row} row */
const isProgramEnforced = (row) => row.check !== AXIS_CRITERION;

/**
 * @param {Row} row
 * @param {string} message
 * @returns {Finding}
 */
const buildFinding = (row, message) => ({
	side: row.side,
	line: row.line,
	job: row.job,
	message,
});

/**
 * @param {Row} row
 * @param {string} cell
 * @param {{ noun: string, empty: string, fix: string }} words
 * @param {Ports["exists"]} exists
 * @returns {Finding[]}
 */
function pathFaults(row, cell, { noun, empty, fix }, exists) {
	const rels = backticked(cell);
	if (rels.length === 0) return [buildFinding(row, empty)];
	return rels
		.filter((rel) => !exists(row.side, rel))
		.map((rel) =>
			buildFinding(row, `its ${noun} \`${rel}\` does not exist${fix}`),
		);
}

/**
 * @param {Row} row
 * @returns {{ cell: string, words: { noun: string, empty: string, fix: string } }[]}
 */
const pathCells = (row) => [
	{
		cell: row.exemplar,
		words: {
			noun: "exemplar",
			empty: "its Exemplar cell names no backticked path",
			fix: " — point the cell at the file that does the job now, or drop the row",
		},
	},
	...(isProgramEnforced(row)
		? [
				{
					cell: row.check,
					words: {
						noun: "enforcing check",
						fix: ` — name the program that refuses a breach now, or \`${AXIS_CRITERION}\``,
						empty: `its Enforcing check cell names neither a backticked check path nor \`${AXIS_CRITERION}\``,
					},
				},
			]
		: []),
];

/**
 * @param {Row} row
 * @param {Set<string>} ids
 * @param {Ports["exists"]} exists
 * @returns {Finding[]}
 */
function judgeRow(row, ids, exists) {
	const out = pathCells(row).flatMap(({ cell, words }) =>
		pathFaults(row, cell, words, exists),
	);
	const cited = row.rule.match(RULE_ID) ?? [];
	if (cited.length === 0)
		out.push(buildFinding(row, "its Rule cell cites no § id"));
	for (const [cell, name] of /** @type {const} */ ([
		[row.job, "Job"],
		[row.primitive, "Primitive"],
	]))
		if (cell === "") out.push(buildFinding(row, `its ${name} cell is empty`));
	for (const id of cited.filter((c) => !ids.has(c)))
		out.push(
			buildFinding(
				row,
				`its Rule cell cites ${id}, which no standards file defines — cite the § that states the primitive, or write one under base §0 "How a rule enters"`,
			),
		);
	return out;
}

/**
 * @param {Row[]} rows
 * @param {Ports["countBreaches"]} countBreaches
 * @returns {Promise<Count>}
 */
async function sumBreaches(rows, countBreaches) {
	/** @type {Map<string, { side: Side, rel: string }>} */
	const checks = new Map();
	for (const row of rows.filter(isProgramEnforced))
		for (const rel of backticked(row.check))
			checks.set(`${row.side}:${rel}`, { side: row.side, rel });
	const asked = [...checks.values()];
	const counts = await countBreaches(asked);
	let total = 0;
	/** @type {string[]} */
	const reasons = [];
	asked.forEach(({ rel }, i) => {
		const c = counts[i];
		if (!c) reasons.push(`${rel}: no count came back`);
		else if ("unknown" in c) reasons.push(`${rel}: ${c.unknown}`);
		else total += c.count;
	});
	return reasons.length > 0
		? { unknown: reasons.join("; ") }
		: { count: total };
}

/**
 * @param {string} stdout
 * @param {number | null} status
 * @returns {Count}
 */
function parseBreaches(stdout, status) {
	/** @type {{ outcome?: unknown, findings?: unknown } | null} */
	let envelope;
	try {
		envelope = JSON.parse(stdout);
	} catch {
		return { unknown: `it printed no --json envelope (exit ${status})` };
	}
	if (envelope?.outcome === "BROKEN") return { unknown: "it answered BROKEN" };
	if (!Array.isArray(envelope?.findings))
		return { unknown: "its envelope carries no findings array" };
	if (envelope.outcome === "SKIP") return { count: 0 };
	return {
		count: envelope.findings.filter((f) => f?.severity === "FAIL").length,
	};
}

/** @param {Count} c @param {string} noun */
const shown = (c, noun) =>
	"unknown" in c ? `${noun} unknown (${c.unknown})` : `${c.count} ${noun}`;

/**
 * @param {{ enforced: Count, breaches: Count, heresies: Count }} counts
 */
const buildCountLine = ({ enforced, breaches, heresies }) =>
	`primitives: ${shown(enforced, "enforced")}, ${shown(breaches, "open breaches")}, ${shown(heresies, "new heresies since the last sweep")}`;

/**
 * @param {{ rows: number, line: string | null, findings: number }} judged
 * @returns {{ okLine: string, extraLine: string | null }}
 */
function primitivesOutcome({ rows, line, findings }) {
	const table = `${rows} primitives row(s), every path and § id real`;
	return {
		okLine: line ? `${table}. ${line}.` : `${table}.`,
		extraLine: line && findings > 0 ? `${line}.` : null,
	};
}

/**
 * @param {Finding[]} findings
 * @param {boolean} inAdopter
 * @returns {{ message: string, file: string, gates: boolean }[]}
 */
function buildFindingReports(findings, inAdopter) {
	return findings.map((f) => {
		const file = STANDARDS_DOCS[f.side];
		const at = `${file}${f.line > 0 ? `:${f.line}` : ""}`;
		const row = f.job ? ` (row "${f.job}")` : "";
		const pluginsToFix = f.side === "base" && inAdopter;
		return {
			message: `${at}${row}: ${f.message}${pluginsToFix ? " — the plugin's to fix" : ""}`,
			file,
			gates: !pluginsToFix,
		};
	});
}

/**
 * @param {string} baseText
 * @param {string | null} localText
 */
function parseTables(baseText, localText) {
	/** @type {Row[]} */
	const rows = [];
	/** @type {Finding[]} */
	const findings = [];
	/** @type {string[]} */
	const unreadable = [];
	for (const [side, text] of /** @type {const} */ ([
		["base", baseText],
		["local", localText],
	])) {
		if (text === null) continue;
		const parsed = parseTable(side, text);
		if ("unreadable" in parsed) {
			findings.push({ side, line: 0, job: "", message: parsed.unreadable });
			unreadable.push(`the ${side} table is unreadable`);
		} else rows.push(...parsed.rows);
	}
	return { rows, findings, unreadable };
}

/**
 * @param {Row} row
 * @param {Map<string, Row>} baseJobs
 * @returns {Finding | null}
 */
function twinFinding(row, baseJobs) {
	const twin = row.side === "local" ? baseJobs.get(jobKey(row.job)) : null;
	return twin
		? buildFinding(
				row,
				`it names the job of the base row at line ${twin.line}, whose primitive is ${twin.primitive}; a local row adds a job the base has none for (base §0) — drop the local row, or name a job of its own`,
			)
		: null;
}

/**
 * @param {Pick<Ports, "read" | "exists">} ports
 * @returns {{ rows: Row[], findings: Finding[], broken: string | null,
 *   unreadable: string[] }}
 */
function judgePrimitives(ports) {
	const baseText = ports.read("base");
	if (baseText === null)
		return {
			rows: [],
			findings: [],
			broken: "the code standards base is unreadable at the plugin root",
			unreadable: [],
		};
	const localText = ports.read("local");
	const { rows, findings, unreadable } = parseTables(baseText, localText);
	const baseIds = sectionIds(baseText);
	const localIds = new Set([...baseIds, ...sectionIds(localText ?? "")]);
	const baseJobs = new Map(
		rows.filter((r) => r.side === "base").map((r) => [jobKey(r.job), r]),
	);
	for (const row of rows) {
		findings.push(
			...judgeRow(row, row.side === "base" ? baseIds : localIds, ports.exists),
		);
		const twin = twinFinding(row, baseJobs);
		if (twin) findings.push(twin);
	}
	return { rows, findings, broken: null, unreadable };
}

/**
 * @param {{ rows: Row[], unreadable: string[] }} judged
 * @param {Pick<Ports, "countBreaches" | "readNewHeresies">} ports
 * @returns {Promise<string>}
 */
async function countPrimitives({ rows, unreadable }, ports) {
	/** @type {Count | null} */
	const blind =
		unreadable.length > 0 ? { unknown: unreadable.join("; ") } : null;
	return buildCountLine({
		enforced: blind ?? { count: rows.filter(isProgramEnforced).length },
		breaches: blind ?? (await sumBreaches(rows, ports.countBreaches)),
		heresies: ports.readNewHeresies(),
	});
}

/** @type {Record<string, keyof Row>} */
const CELL_KEYS = {
	Primitive: "primitive",
	Exemplar: "exemplar",
	Rule: "rule",
	"Enforcing check": "check",
};

/**
 * @param {Side} side
 * @param {string | null} text
 * @returns {{ rows: Map<string, Row> } | { unreadable: string }}
 */
function rowsByJob(side, text) {
	const r = text === null ? { rows: [] } : parseTable(side, text);
	return "unreadable" in r
		? r
		: { rows: new Map(r.rows.map((row) => [jobKey(row.job), row])) };
}

/**
 * @param {RowChange["change"]} change
 * @param {Row} row
 * @param {string[]} [cells]
 * @returns {RowChange}
 */
const buildRowChange = (change, { job, primitive }, cells = []) => ({
	change,
	job,
	primitive,
	cells,
});

/**
 * @param {Side} side
 * @param {string | null} before
 * @param {string | null} after
 * @returns {{ changes: RowChange[] } | { unreadable: string }}
 */
function rowChanges(side, before, after) {
	const was = rowsByJob(side, before);
	if ("unreadable" in was) return { unreadable: `before: ${was.unreadable}` };
	const is = rowsByJob(side, after);
	if ("unreadable" in is) return { unreadable: `after: ${is.unreadable}` };
	const [prior, next] = [was.rows, is.rows];
	/** @type {RowChange[]} */
	const changes = [];
	for (const [key, row] of next) {
		const old = prior.get(key);
		if (!old) {
			changes.push(buildRowChange("added", row));
			continue;
		}
		const cells = Object.entries(CELL_KEYS)
			.filter(([, k]) => old[k] !== row[k])
			.map(([name]) => name);
		if (cells.length > 0) changes.push(buildRowChange("rewritten", row, cells));
	}
	for (const [key, row] of prior)
		if (!next.has(key)) changes.push(buildRowChange("removed", row));
	return { changes };
}

/**
 * @param {string} baseText
 * @returns {{ paths: { line: number, rel: string }[] } | { unreadable: string }}
 */
function parseBasePaths(baseText) {
	const parsed = parseTable("base", baseText);
	if ("unreadable" in parsed) return parsed;
	return {
		paths: parsed.rows.flatMap((row) =>
			pathCells(row).flatMap(({ cell }) =>
				backticked(cell).map((rel) => ({ line: row.line, rel })),
			),
		),
	};
}

module.exports = {
	STANDARDS_DOCS,
	parseBasePaths,
	countPrimitives,
	judgePrimitives,
	parseBreaches,
	primitivesOutcome,
	buildFindingReports,
	rowChanges,
};
