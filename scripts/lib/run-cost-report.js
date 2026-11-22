#!/usr/bin/env node
/*
 * run-cost-report.js — the run-cost report a test runner prints after its
 * suite's own summary: each new or changed test file over the per-file budget,
 * and one summary line beside the machine's load (#1880, under #1869's spec).
 *
 * THE ONLY PLACE ITS WORDING AND ITS BUDGET LIVE. The core's pytest runner
 * calls `reportForRun` in-process and its vitest runner `reportForFile`; an
 * adopter's own runner calls the program entry below through the resolver's
 * script form (#1797 Q1 (B)):
 *   node scripts/lib/resolve-core.js scripts/lib/run-cost-report.js <timings.json>
 * where `<timings.json>` maps each test file the run timed, repo-relative or
 * absolute, to its seconds.
 *
 * AN EXISTING FILE IS JUDGED ON ITS GROWTH (#4289): against its row in the CI
 * record, the newest green suite run's per-file timings
 * (scripts/lib/latest-timings.js, #4579). A change is judged before it lands,
 * so that run never holds it. Past `GROWTH_BAND` times that row it is named
 * as grown; within it, it is excepted, and the line names the open ticket for
 * its speed-up or says none is open.
 *
 * UNDER `CI` IT JUDGES EVERY TIMED FILE THE RECORD HOLDS, not the diff's
 * files alone, and prints only the grown ones and its summary: there the run
 * and the record are the same kind of machine, and growth from any change
 * since the record shows. Its record there is the one the shard planned by.
 * It looks up no ticket there.
 *
 * IT NEVER REFUSES (mantahostels#2255). Timings move with load, so a line here is
 * evidence for base §X8 (5), never a verdict: any failure inside prints one
 * fail-open line and the suite's own verdict stands, and the program exits 0 on
 * every path, malformed input included (§N5). Not a `report-*` program, which
 * files an issue: it joins no family (§N3). A file's CI time is refused in the
 * scheduled sweep instead, by `scripts/check-file-ci-time.js` (#4293).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { readDefaultChangedBase } = require("./changed-selection.js");
const { gitRead, readUntrackedFiles } = require("./dirty-tree.js");
const { ghJson, parseErrLine } = require("./gh.js");
const { hostRoot } = require("./host-root.js");
const { scriptPath } = require("./script-path.js");
const { escapeRe } = require("./regex-group.js");
const { latestTimings } = require("./latest-timings.js");
const { readText } = require("./file-read.js");
const { parseCsv } = require("./suite-timings.js");
const { writeFd } = require("./write-fd.js");
const { ignoreFailure } = require("./caught.js");

// guess, #1797
const BUDGET_SECONDS = 10;

// measured p90 spread 2.5x, #4283
const GROWTH_BAND = 2.5;

// guess, #4289
const TICKET_TIMEOUT_MS = 20_000;

const PREFIX = "RUN COST:";

const GB = 1024 ** 3;

/**
 * @typedef {object} ReportInput
 * @property {Readonly<Record<string, number>>} timings
 * @property {readonly { file: string, atBase: boolean }[]} changed
 * @property {string} base
 * @property {number|null} load
 * @property {number|null} availableBytes
 * @property {"seconds"|"worker-seconds"} [unit]
 * @property {CiRecord|null} record
 * @property {string|null} [stale]
 * @property {boolean} ci
 * @property {TicketFinder} findTicket
 */

/**
 * @typedef {{ run: string, sha: string, seconds: Map<string, number> }} CiRecord
 * @typedef {Parameters<typeof latestTimings>[1]} TimingsSeams
 * @typedef {(file: string) => { tickets: { number: number, title: string }[] } | { failed: string }} TicketFinder
 */

/** @param {number} n */
const fixed1 = (n) => (Math.round(n * 10) / 10).toFixed(1);

/**
 * @param {ReturnType<TicketFinder>} found
 */
function ticketText(found) {
	if ("failed" in found)
		return `unknown: the open-ticket lookup failed (${found.failed})`;
	if (found.tickets.length === 0) return "none: no open issue's title names it";
	return found.tickets.map((t) => `#${t.number} (${t.title})`).join(", ");
}

/** @param {ReportInput} input */
function linesFor({
	timings,
	changed,
	base,
	load,
	availableBytes,
	unit = "seconds",
	record,
	stale = null,
	ci,
	findTicket,
}) {
	const timed = changed.flatMap(({ file, atBase }) => {
		const seconds = timings[file];
		if (seconds === undefined) return [];
		const recorded = atBase ? record?.seconds.get(file) : undefined;
		const grown =
			recorded !== undefined &&
			seconds > BUDGET_SECONDS &&
			seconds > GROWTH_BAND * recorded;
		return [{ file, atBase, seconds, recorded, grown }];
	});
	if (timed.length === 0) return [];
	const label = unit === "worker-seconds" ? "worker-seconds" : "s";
	const over = timed
		.filter(({ seconds, grown }) => seconds > BUDGET_SECONDS && (grown || !ci))
		.sort((a, b) => b.seconds - a.seconds);
	const ciRun = record
		? `CI run ${record.run} at ${record.sha.slice(0, 12)}`
		: "";
	const lines = over.map(({ file, atBase, seconds, recorded, grown }) => {
		const took = `${PREFIX} ${file} took ${fixed1(seconds)} ${label}`;
		if (!atBase)
			return `${took}, over the ${BUDGET_SECONDS} s budget — new since ${base}: make it cheaper, or say why in its header (base §X8 (5)).`;
		if (grown && recorded !== undefined)
			return `${took}, ${(seconds / recorded).toFixed(2)}x its ${fixed1(recorded)} s on ${ciRun} — grown past the ${GROWTH_BAND}x noise band: make it cheaper, or say why in its header (base §X8 (5)).`;
		const judged =
			recorded === undefined
				? `unjudged, ${record ? `${ciRun} holding no row for it` : "no CI record read"}`
				: `within ${GROWTH_BAND}x of its ${fixed1(recorded)} s on ${ciRun}, so base §X8 (5) excepts it`;
		return `${took}, over the ${BUDGET_SECONDS} s budget — pre-existing at ${base}, ${judged}; its speed-up's open ticket: ${ticketText(findTicket(file))}.`;
	});
	const grownCount = timed.filter((t) => t.grown).length;
	const unjudged = timed.filter(
		(t) => t.atBase && t.recorded === undefined,
	).length;
	const loadText = load === null ? "load unknown" : `load ${load.toFixed(2)}`;
	const memText =
		availableBytes === null
			? "available memory unknown"
			: `${fixed1(availableBytes / GB)} GB available`;
	const judgedText = ci
		? `${grownCount} of ${timed.length} test file(s) in ${ciRun || "no CI record"} grown past ${GROWTH_BAND}x their row, against ${base}`
		: `${over.length} of ${timed.length} new or changed test file(s) over the ${BUDGET_SECONDS} s budget, ${grownCount} grown past ${GROWTH_BAND}x their CI record and ${unjudged} pre-existing without one, against ${base}`;
	const staleText =
		stale === null ? "" : `; CI record not refreshed (${stale})`;
	lines.push(
		`${PREFIX} ${judgedText}${staleText}; ${loadText} (1 min), ${memText}. A report, never a refusal (mantahostels#2255).`,
	);
	return lines;
}

/** @param {unknown} error */
function buildFailOpenLine(error) {
	const why = error instanceof Error ? error.message : String(error);
	return `${PREFIX} the report failed and printed nothing else; the suite's verdict stands (#1880): ${why}`;
}

/**
 * @param {string} root
 * @param {string} base
 * @param {readonly string[]} files
 * @returns {{ file: string, atBase: boolean }[]|null}
 */
function readChangedAgainst(root, base, files) {
	const diff = gitRead(["diff", "--name-only", "-z", base], root);
	const untracked = readUntrackedFiles(root);
	if (diff === null || untracked === null) return null;
	const moved = new Set([...diff.split("\0"), ...untracked]);
	const candidates = files.filter((f) => moved.has(f));
	if (candidates.length === 0) return [];
	const present = gitRead(
		["ls-tree", "-r", "--name-only", "-z", base, "--", ...candidates],
		root,
	);
	if (present === null) return null;
	const atBase = new Set(present.split("\0"));
	return candidates.map((file) => ({ file, atBase: atBase.has(file) }));
}

/**
 * @param {string} root
 * @param {TimingsSeams} timings
 * @returns {{ record: CiRecord|null, stale: string|null }}
 */
function readCiRecord(root, timings) {
	const { file, failed } = latestTimings(root, timings);
	const read = file === null ? null : readText(file);
	if (read === null || read.state !== "read")
		return { record: null, stale: failed };
	const { meta, rows } = parseCsv(read.data);
	/** @type {Map<string, number>} */
	const seconds = new Map();
	for (const row of rows)
		if (row.seconds !== null) seconds.set(row.file, row.seconds);
	if (seconds.size === 0) return { record: null, stale: failed };
	return {
		record: {
			run: meta.run ?? "unknown",
			sha: meta.sha ?? "unknown",
			seconds,
		},
		stale: failed,
	};
}

// measured 23 open issues, x40, #5294
const OPEN_ISSUE_LIMIT = 1000;

/** @param {string} root @returns {TicketFinder} */
const openTicketFinder = (root) => {
	/** @type {{ rows: { number: number, title: string }[] } | { failed: string } | undefined} */
	let open;
	return (file) => {
		open ??= listOpenIssues(root);
		if ("failed" in open) return open;
		const name = path.basename(file);
		const named = new RegExp(
			`(?:^|[^\\w.-])${escapeRe(name)}(?![\\w-]|\\.\\w)`,
		);
		return {
			tickets: open.rows
				.filter((r) => named.test(r.title))
				.sort((a, b) => a.number - b.number),
		};
	};
};

/**
 * @param {string} root
 * @returns {{ rows: { number: number, title: string }[] } | { failed: string }}
 */
function listOpenIssues(root) {
	try {
		return {
			rows: ghJson(
				[
					"issue",
					"list",
					"--state",
					"open",
					"--limit",
					String(OPEN_ISSUE_LIMIT),
					"--json",
					"number,title",
				],
				{ cwd: root, timeout: TICKET_TIMEOUT_MS },
			),
		};
	} catch (error) {
		return { failed: parseErrLine(error) };
	}
}

/**
 * @typedef {{ platform?: string, loadavg?: () => number[], freemem?: () => number }} MachineSeams
 */

/** @param {MachineSeams} seams */
function machineState({
	platform = process.platform,
	loadavg = os.loadavg,
	freemem = os.freemem,
}) {
	const load = platform === "win32" ? null : (loadavg()[0] ?? null);
	const bytes = freemem();
	return {
		load,
		availableBytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null,
	};
}

/**
 * @param {unknown} parsed
 * @param {string} root
 * @returns {{ timings: Record<string, number> } | { bad: string }}
 */
function timingsFrom(parsed, root) {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		return { bad: "the timings are not a JSON object of file to seconds" };
	/** @type {Record<string, number>} */
	const timings = {};
	for (const [file, seconds] of Object.entries(parsed)) {
		if (typeof seconds !== "number" || !Number.isFinite(seconds))
			return { bad: `${file}'s seconds are not a number` };
		timings[path.isAbsolute(file) ? path.relative(root, file) : file] = seconds;
	}
	return { timings };
}

/**
 * @param {string} root
 * @param {unknown} raw
 * @param {{ unit?: ReportInput["unit"], machine?: MachineSeams, findTicket?: TicketFinder, timings?: TimingsSeams }} [options]
 * @returns {string[]}
 */
function reportForRun(
	root,
	raw,
	{
		unit = "seconds",
		machine = {},
		findTicket = openTicketFinder(root),
		timings = {},
	} = {},
) {
	try {
		const read = timingsFrom(raw, root);
		if ("bad" in read) return [buildFailOpenLine(read.bad)];
		const base = readDefaultChangedBase(root, execFileSync);
		const { record, stale } = readCiRecord(root, timings);
		const ci = Boolean(process.env.CI);
		const changed = ci
			? Object.keys(read.timings)
					.filter((file) => record?.seconds.has(file))
					.map((file) => ({ file, atBase: true }))
			: readChangedAgainst(root, base, Object.keys(read.timings));
		if (changed === null)
			return [buildFailOpenLine(`git could not diff the tree against ${base}`)];
		return linesFor({
			timings: read.timings,
			changed,
			base,
			unit,
			record,
			stale,
			ci,
			findTicket,
			...machineState(machine),
		});
	} catch (error) {
		return [buildFailOpenLine(error)];
	}
}

/** @param {string} root @param {string} file @returns {string[]} */
function reportForFile(root, file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		return [buildFailOpenLine(error)];
	}
	/** @type {unknown} */
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return [buildFailOpenLine(`the timings are not JSON (${String(error)})`)];
	}
	return reportForRun(root, parsed);
}

/** @param {string[]} argv @returns {string[]} */
function readProgramLines(argv) {
	const [file] = argv;
	if (argv.length !== 1 || file === undefined)
		return [
			buildFailOpenLine(
				`usage: node ${scriptPath("lib/run-cost-report.js")} <timings.json>`,
			),
		];
	return reportForFile(hostRoot(), file);
}

if (require.main === module) {
	const lines = readProgramLines(process.argv.slice(2));
	ignoreFailure(() => {
		if (lines.length > 0) writeFd(1, `${lines.join("\n")}\n`);
	});
}

module.exports = { buildFailOpenLine, reportForFile, reportForRun };
