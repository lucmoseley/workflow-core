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
 * files an issue: it joins no family (§N3).
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
const { escapeRe } = require("./shell-words.js");
const { latestTimings } = require("./latest-timings.js");
const { parseCsv } = require("./suite-timings.js");
const { writeFd } = require("./write-fd.js");

/* 10 s of a file's own wall time: the founder's ruling at #1797 Q4 (A). */
const BUDGET_SECONDS = 10;

/* 2.5x: the p90 slowest/fastest spread across CI sweeps (#4283), so growth
 * past it is not run-to-run noise. */
const GROWTH_BAND = 2.5;

/* A guess, never measured: a tracker slower than this costs the line its
 * ticket, which then reads unknown, never the run its end. */
const TICKET_TIMEOUT_MS = 20_000;

/** Every line opens with this. */
const PREFIX = "RUN COST:";

const GB = 1024 ** 3;

/**
 * @typedef {object} ReportInput
 * @property {Readonly<Record<string, number>>} timings each test file the run
 *   timed, repo-relative, to its figure
 * @property {readonly { file: string, atBase: boolean }[]} changed the test
 *   files new or changed against `base`; `atBase` false is a new file
 * @property {string} base the ref the run's diff is taken against
 * @property {number|null} load the 1-minute load average, null where unknown
 * @property {number|null} availableBytes available memory, null where unknown
 * @property {"seconds"|"worker-seconds"} [unit] worker-seconds for pytest,
 *   whose per-file figure is summed across xdist workers (#1797)
 * @property {CiRecord|null} record the CI record, null where none was read
 * @property {boolean} ci judging under `CI`: grown files and the summary only
 * @property {TicketFinder} findTicket the open tickets naming a file: a seam
 *   beside `WFC_GH`, so the in-process cases spawn no gh
 */

/**
 * @typedef {{ run: string, sha: string, seconds: Map<string, number> }} CiRecord
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
	ci,
	findTicket,
}) {
	/* A file the run selected only as a reader of the diff is not in `changed`,
	 * so it is never named. */
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
	lines.push(
		`${PREFIX} ${judgedText}; ${loadText} (1 min), ${memText}. A report, never a refusal (mantahostels#2255).`,
	);
	return lines;
}

/** @param {unknown} error */
function buildFailOpenLine(error) {
	const why = error instanceof Error ? error.message : String(error);
	return `${PREFIX} the report failed and printed nothing else; the suite's verdict stands (#1880): ${why}`;
}

/**
 * Which of `files` are new or changed against `base`, committed, uncommitted
 * or untracked, and whether each was present at `base`. Null where git would
 * not answer.
 * @param {string} root
 * @param {string} base
 * @param {readonly string[]} files repo-relative
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
 * The CI record, or null where none can be read. A failed refresh reads the
 * last one held.
 * @param {string} root
 * @returns {CiRecord|null}
 */
function readRecord(root) {
	const { file } = latestTimings(root);
	if (file === null) return null;
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const { meta, rows } = parseCsv(text);
	/** @type {Map<string, number>} */
	const seconds = new Map();
	for (const row of rows)
		if (row.seconds !== null) seconds.set(row.file, row.seconds);
	return { run: meta.run ?? "unknown", sha: meta.sha ?? "unknown", seconds };
}

/**
 * The open issues whose title names `file`'s basename, in the tracker `gh`
 * reads from `root`, oldest first.
 * @param {string} root
 * @returns {TicketFinder}
 */
const openTicketFinder = (root) => (file) => {
	const name = path.basename(file);
	/* The whole name, so `old.test.ts` never matches `bold.test.tsx`. */
	const named = new RegExp(`(?:^|[^\\w.-])${escapeRe(name)}(?![\\w-]|\\.\\w)`);
	try {
		/** @type {{ number: number, title: string }[]} */
		const rows = ghJson(
			[
				"issue",
				"list",
				"--state",
				"open",
				"--search",
				`"${name}" in:title`,
				"--json",
				"number,title",
			],
			{ cwd: root, timeout: TICKET_TIMEOUT_MS },
		);
		return {
			tickets: rows
				.filter((r) => named.test(r.title))
				.sort((a, b) => a.number - b.number),
		};
	} catch (error) {
		/* Fails open (mantahostels#2255). */
		return { failed: parseErrLine(error) };
	}
};

/**
 * @typedef {{ platform?: string, loadavg?: () => number[], freemem?: () => number }} MachineSeams
 */

/**
 * The 1-minute load average and available memory. Windows has no load
 * average, and Node reports it there as 0, so that reads unknown.
 * @param {MachineSeams} seams
 */
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
 * A decoded timings value as a map of repo-relative path to seconds, or the
 * reason it is not one.
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
 * The report for a run that timed `raw`, a decoded map of test file to its
 * figure, against the base the narrowed default run resolves in `root`. What
 * a runner calls once its suite has finished. Never throws.
 * @param {string} root
 * @param {unknown} raw
 * @param {{ unit?: ReportInput["unit"], machine?: MachineSeams, findTicket?: TicketFinder }} [options]
 *   `machine` and `findTicket` are a test's fakes for the platform, load and
 *   memory, and for the tracker
 * @returns {string[]}
 */
function reportForRun(
	root,
	raw,
	{ unit = "seconds", machine = {}, findTicket = openTicketFinder(root) } = {},
) {
	try {
		const read = timingsFrom(raw, root);
		if ("bad" in read) return [buildFailOpenLine(read.bad)];
		const base = readDefaultChangedBase(root, execFileSync);
		const record = readRecord(root);
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
			ci,
			findTicket,
			...machineState(machine),
		});
	} catch (error) {
		/* Fails open by design (mantahostels#2255): the report must never cost a
		 * suite its green. */
		return [buildFailOpenLine(error)];
	}
}

/**
 * The report for the timings file at `file`, decoded and read against `root`.
 * The one reader of a timings file, for the program entry and the vitest
 * runner alike. Never throws.
 * @param {string} root
 * @param {string} file
 * @returns {string[]}
 */
function reportForFile(root, file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		/* Fails open (mantahostels#2255): an unreadable file is one line. */
		return [buildFailOpenLine(error)];
	}
	/** @type {unknown} */
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		/* Fails open (mantahostels#2255): malformed input is one line. */
		return [buildFailOpenLine(`the timings are not JSON (${String(error)})`)];
	}
	return reportForRun(root, parsed);
}

/**
 * The program entry's lines for argv. Never throws.
 * @param {string[]} argv
 * @returns {string[]}
 */
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
	try {
		if (lines.length > 0) writeFd(1, `${lines.join("\n")}\n`);
	} catch {
		/* A closed or stalled pipe loses the report, never the exit 0
		 * (mantahostels#2255). */
	}
}

module.exports = { buildFailOpenLine, reportForFile, reportForRun };
