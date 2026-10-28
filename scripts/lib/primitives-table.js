/*
 * primitives-table.js — the check-primitives core (#3451): parses the
 * primitives tables in the code standards base and a repo's local file,
 * judges every path and § id they name, and builds the count line.
 *
 * A CORE (base §T7): every read comes in through the ports below.
 *
 *   read(side)               the side's standards text, null where absent
 *   exists(side, rel)        whether `rel` names a file or directory at the
 *                            side's root: the plugin root for `base`, the
 *                            host root for `local`, as base §0 reads line pins
 *   countBreaches(side, rel) the findings check program `rel` reports over
 *                            the whole tree, or why it could not be read
 *   readNewHeresies()        the sub-issues of the last closed *Heresy sweep
 *                            due* issue, or why they could not be read
 *
 * A TABLE is the first Markdown table under a `## Primitives` heading whose
 * header row is COLUMNS exactly. A side with no such heading has no rows; a
 * heading with no such table is a finding.
 *
 * A COUNT IS A NUMBER OR A REASON, never a 0 standing in for one it could not
 * read (#3365).
 */

const COLUMNS = ["Job", "Primitive", "Exemplar", "Rule", "Enforcing check"];

/* The Enforcing check cell's one non-path value: the row is a criterion
 * `/code-review`'s Standards axis judges, and no program enforces it. */
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
/** @typedef {{ count: number } | { unknown: string }} Count */
/**
 * @typedef {{
 *   read: (side: Side) => string | null,
 *   exists: (side: Side, rel: string) => boolean,
 *   countBreaches: (side: Side, rel: string) => Count,
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
 * The side's rows, or the reason its table cannot be read; no rows where the
 * text has no primitives heading.
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

/**
 * Every § id a heading in `text` defines: `## §G — …` and `### §G1 · …`.
 * @param {string} text
 */
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
	[...cell.matchAll(BACKTICKED)].flatMap((m) => (m[1] ? [m[1]] : []));

/** @param {string} job */
const jobKey = (job) => job.toLowerCase().replace(/\s+/g, " ");

/** @param {Row} row */
const isProgramEnforced = (row) => row.check !== AXIS_CRITERION;

/**
 * @param {Row} row
 * @param {string} message
 * @returns {Finding}
 */
const finding = (row, message) => ({
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
	if (rels.length === 0) return [finding(row, empty)];
	return rels
		.filter((rel) => !exists(row.side, rel))
		.map((rel) => finding(row, `its ${noun} \`${rel}\` does not exist${fix}`));
}

/**
 * @param {Row} row
 * @param {Set<string>} ids the ids this row's side may cite
 * @param {Ports["exists"]} exists
 * @returns {Finding[]}
 */
function judgeRow(row, ids, exists) {
	const out = pathFaults(
		row,
		row.exemplar,
		{
			noun: "exemplar",
			empty: "its Exemplar cell names no backticked path",
			fix: " — point the cell at the file that does the job now, or drop the row",
		},
		exists,
	);
	if (isProgramEnforced(row))
		out.push(
			...pathFaults(
				row,
				row.check,
				{
					noun: "enforcing check",
					fix: ` — name the program that refuses a breach now, or \`${AXIS_CRITERION}\``,
					empty: `its Enforcing check cell names neither a backticked check path nor \`${AXIS_CRITERION}\``,
				},
				exists,
			),
		);
	const cited = row.rule.match(RULE_ID) ?? [];
	if (cited.length === 0) out.push(finding(row, "its Rule cell cites no § id"));
	for (const [cell, name] of /** @type {const} */ ([
		[row.job, "Job"],
		[row.primitive, "Primitive"],
	]))
		if (cell === "") out.push(finding(row, `its ${name} cell is empty`));
	for (const id of cited.filter((c) => !ids.has(c)))
		out.push(
			finding(
				row,
				`its Rule cell cites ${id}, which no standards file defines — cite the § that states the primitive, or write one under base §0 "How a rule enters"`,
			),
		);
	return out;
}

/**
 * Sum the breaches every program-enforced row's check reports, each distinct
 * check counted once.
 * @param {Row[]} rows
 * @param {Ports["countBreaches"]} countBreaches
 * @returns {Count}
 */
function sumBreaches(rows, countBreaches) {
	let total = 0;
	/** @type {string[]} */
	const reasons = [];
	const seen = new Set();
	for (const row of rows.filter(isProgramEnforced))
		for (const rel of backticked(row.check)) {
			const key = `${row.side}:${rel}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const c = countBreaches(row.side, rel);
			if ("unknown" in c) reasons.push(`${rel}: ${c.unknown}`);
			else total += c.count;
		}
	return reasons.length > 0
		? { unknown: reasons.join("; ") }
		: { count: total };
}

/** @param {Count} c @param {string} noun */
const shown = (c, noun) =>
	"unknown" in c ? `${noun} unknown (${c.unknown})` : `${c.count} ${noun}`;

/**
 * @param {{ enforced: Count, breaches: Count, heresies: Count }} counts
 */
const countLine = ({ enforced, breaches, heresies }) =>
	`primitives: ${shown(enforced, "enforced")}, ${shown(breaches, "open breaches")}, ${shown(heresies, "new heresies since the last sweep")}`;

/**
 * Both sides' rows, with a finding and a reason for each side whose table
 * cannot be read.
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
 * A local row naming a base row's job, as a finding; null for any other row.
 * @param {Row} row
 * @param {Map<string, Row>} baseJobs
 * @returns {Finding | null}
 */
function twinFinding(row, baseJobs) {
	const twin = row.side === "local" ? baseJobs.get(jobKey(row.job)) : null;
	return twin
		? finding(
				row,
				`it names the job of the base row at line ${twin.line}, whose primitive is ${twin.primitive}; a local row adds a job the base has none for (base §0) — drop the local row, or name a job of its own`,
			)
		: null;
}

/**
 * Judge both tables. `counts` false reads stat calls alone and leaves the
 * count line out, for the pre-commit run.
 * @param {Ports} ports
 * @param {{ counts: boolean }} opts
 * @returns {{ rows: Row[], findings: Finding[], broken: string | null,
 *   countLine: string | null }}
 */
function judgePrimitives(ports, { counts }) {
	const baseText = ports.read("base");
	if (baseText === null)
		return {
			rows: [],
			findings: [],
			broken: "the code standards base is unreadable at the plugin root",
			countLine: null,
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
	if (!counts) return { rows, findings, broken: null, countLine: null };
	/** @type {Count | null} */
	const blind =
		unreadable.length > 0 ? { unknown: unreadable.join("; ") } : null;
	return {
		rows,
		findings,
		broken: null,
		countLine: countLine({
			enforced: blind ?? { count: rows.filter(isProgramEnforced).length },
			breaches: blind ?? sumBreaches(rows, ports.countBreaches),
			heresies: ports.readNewHeresies(),
		}),
	};
}

module.exports = { judgePrimitives };
