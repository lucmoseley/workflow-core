#!/usr/bin/env node

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const { orFallback } = require("./lib/caught.js");
const { readJsonl } = require("./lib/jsonl.js");
const path = require("node:path");
const { failureReason } = require("./lib/check");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root");
const { requiredGroup } = require("./lib/regex-group");
const { isTestKind } = require("./lib/test-kind");
const { fileOrRefresh, findTrackingIssue } = require("./lib/tracking-issue");
const {
	archScanFault,
	readConfig,
	UPSTREAM_TRACKER,
} = require("./lib/workflow-core-config");
const { takesLabel } = require("./lib/takes-label");
const { execGit } = require("./lib/git.js");
const { FULL_SHA } = require("./lib/commit-sha.js");
const { buildStandaloneLine } = require("./lib/standalone-line.js");
const { runDailyReading } = require("./lib/daily-reading.js");

const RECORD = "docs/data/arch-scan-runs.jsonl";
// workflow-core#1309
const DEFAULT_SINCE = "2026-09-21T00:00Z";
const START_THRESHOLD = 8750;
const MIN_THRESHOLD = 4000;
const MAX_THRESHOLD = 40_000;
const HOT_COUNT = 10;
// workflow-core#1310 guess
const PARTNER_COUNT = 3;
const NUMSTAT_RE = /^(\d+|-)\t(\d+|-)\t(.*)$/s;
const TITLE = "Architecture scan due";
const LABEL = takesLabel("implement");

const CODE_EXT = /\.(?:js|mjs|cjs|ts|tsx|sh|py)$/;
const GENERATED = /\.(?:d\.ts|min\.js)$/;

const USAGE = `usage: node ${scriptPath("report-arch-scan-due.js")} [--dry-run | --next-threshold <yield> | --hot-files <file> | --partners <file>]`;
const HOT_ROW_RE = /^ +(\d+) commits +([+-]\d+) {2}(.+)$/gm;
const WINDOW_RE =
	/^Window: since (.+) \(([^()]*)\) to ([0-9a-f]{40}) \([^()]*\)$/m;

/** @param {string} p */
const isCode = (p) =>
	(CODE_EXT.test(p) || p.startsWith(".husky/")) &&
	!isTestKind(p) &&
	!GENERATED.test(p) &&
	!p.startsWith(".agents/");

/**
 * @param {string[]} args
 * @returns {string}
 */
const git = (args) =>
	execGit(args, {
		cwd: hostRoot(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

/** @returns {Array<Record<string, unknown>>} */
function readRecord() {
	const read = readJsonl(path.join(hostRoot(), RECORD));
	if (!read) return [];
	const [bad] = read.bad;
	if (bad !== undefined)
		throw new Error(`${RECORD}:${bad} is not a JSON object`);
	return read.rows;
}

/**
 * @typedef {{ sha: string } | { date: string, from: string }} Start
 * @typedef {{ path: string, commits: number, net: number }} HotFile
 * @typedef {"default" | "log" | "override"} Source
 */

/**
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Start}
 */
function windowStart(rows) {
	const scan = newestRow(rows, "scan");
	if (scan) {
		if (typeof scan.head !== "string" || !FULL_SHA.test(scan.head))
			throw new Error(`${RECORD}: the newest scan line has no full-sha "head"`);
		return { sha: scan.head };
	}
	const seed = newestRow(rows, "seed");
	if (seed) {
		if (typeof seed.since !== "string" || Number.isNaN(Date.parse(seed.since)))
			throw new Error(
				`${RECORD}: the newest seed line has no readable "since"`,
			);
		return { date: seed.since, from: "seed line" };
	}
	return { date: DEFAULT_SINCE, from: "default start" };
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {"seed" | "scan" | "close"} mode
 */
const newestRow = (rows, mode) => rows.findLast((r) => r?.mode === mode);

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {number | undefined} override
 * @returns {{ threshold: number, source: Source }}
 */
function thresholdInForce(rows, override) {
	if (override !== undefined)
		return { threshold: override, source: "override" };
	return learnedThreshold(rows);
}

// workflow-core#1348
/**
 * @param {Array<Record<string, unknown>>} rows
 * @returns {{ threshold: number, source: Exclude<Source, "override"> }}
 */
function learnedThreshold(rows) {
	const close = newestRow(rows, "close");
	if (!close) return { threshold: START_THRESHOLD, source: "default" };
	const n = close.nextThreshold;
	if (typeof n !== "number" || !Number.isInteger(n) || n <= 0)
		throw new Error(
			`${RECORD}: the newest close line has no positive-integer "nextThreshold"`,
		);
	return { threshold: n, source: "log" };
}

/**
 * @param {number} threshold
 * @param {number} y
 */
function recalibrate(threshold, y) {
	let factor = 2;
	if (y >= 6) factor = 0.7;
	else if (y >= 3) factor = 1;
	else if (y >= 1) factor = 1.5;
	return Math.min(
		MAX_THRESHOLD,
		Math.max(MIN_THRESHOLD, Math.round(threshold * factor)),
	);
}

function readWindowEnd() {
	for (const ref of ["refs/remotes/origin/HEAD", "HEAD"]) {
		const sha = orFallback(
			() => git(["rev-parse", "--verify", "-q", ref]).trim(),
			undefined,
		);
		if (sha !== undefined) return { sha, ref };
	}
	throw new Error(
		"no commit to count to: neither origin's HEAD nor HEAD resolves",
	);
}

/**
 * @param {string} head
 * @param {string[]} exclude
 * @returns {Set<string>}
 */
function readCountedFiles(head, exclude) {
	const emptyTree = git(["hash-object", "-t", "tree", "/dev/null"]).trim();
	return new Set(
		git([
			"diff",
			"--name-only",
			"--no-renames",
			"-z",
			emptyTree,
			head,
			"--",
			".",
			...exclude.map((g) => `:(exclude,glob)${g}`),
		]).split("\0"),
	);
}

/**
 * @param {string} name
 * @param {Iterator<string>} tokens
 * @param {Map<string, string>} renamedTo
 * @returns {string}
 */
function numstatName(name, tokens, renamedTo) {
	if (name !== "") return renamedTo.get(name) ?? name;
	const from = tokens.next().value;
	const to = tokens.next().value;
	if (from === undefined || to === undefined)
		throw new Error("git log -z: a rename record ends before its two paths");
	const newest = renamedTo.get(to) ?? to;
	renamedTo.set(from, newest);
	return newest;
}

/**
 * @param {RegExpExecArray} m
 * @param {1 | 2} n
 */
function parseNumstatCount(m, n) {
	const g = requiredGroup(m, n, NUMSTAT_RE);
	return g === "-" ? 0 : Number(g);
}

/**
 * @param {Start} start
 * @param {string} head
 * @param {string[] | undefined} exclude
 * @returns {Array<Map<string, number>>}
 */
function readWindowCommits(start, head, exclude = []) {
	const range =
		"sha" in start
			? [`${start.sha}..${head}`]
			: [`--since=${start.date}`, head];
	const out = git([
		"log",
		"--numstat",
		"-M",
		"-z",
		"--format=%x01%H",
		...range,
	]);
	const counted = readCountedFiles(head, exclude);

	/** @type {Map<string, string>} */
	const renamedTo = new Map();
	/** @type {Array<Map<string, number>>} */
	const commits = [];
	/** @type {Map<string, number>} */
	let inCommit = new Map();

	const tokens = out.split("\0").values();
	for (const token of tokens) {
		const t = token.replace(/^\n/, "");
		if (t.startsWith("\x01")) {
			inCommit = new Map();
			commits.push(inCommit);
			continue;
		}
		const m = NUMSTAT_RE.exec(t);
		if (!m) continue;
		const name = numstatName(
			requiredGroup(m, 3, NUMSTAT_RE),
			tokens,
			renamedTo,
		);
		if (!counted.has(name) || !isCode(name)) continue;
		inCommit.set(
			name,
			(inCommit.get(name) ?? 0) +
				parseNumstatCount(m, 1) -
				parseNumstatCount(m, 2),
		);
	}
	return commits;
}

/**
 * @param {Array<Map<string, number>>} commits
 * @returns {HotFile[]}
 */
function tally(commits) {
	/** @type {Map<string, HotFile>} */
	const files = new Map();
	for (const commit of commits)
		for (const [name, net] of commit) {
			const f = files.get(name) ?? { path: name, commits: 0, net: 0 };
			f.commits++;
			f.net += net;
			files.set(name, f);
		}
	return busiestFirst([...files.values()], HOT_COUNT);
}

/**
 * @template {{ path: string, commits: number }} T
 * @param {T[]} rows
 * @param {number} n
 * @returns {T[]}
 */
const busiestFirst = (rows, n) =>
	rows
		.toSorted((a, b) => b.commits - a.commits || a.path.localeCompare(b.path))
		.slice(0, n);

/**
 * @param {Array<Map<string, number>>} commits
 * @param {string} hot
 * @returns {Array<{ path: string, commits: number }>}
 */
function partnersOf(commits, hot) {
	/** @type {Map<string, number>} */
	const shared = new Map();
	for (const commit of commits) {
		if (!commit.has(hot)) continue;
		for (const name of commit.keys())
			if (name !== hot) shared.set(name, (shared.get(name) ?? 0) + 1);
	}
	return busiestFirst(
		[...shared].map(([p, n]) => ({ path: p, commits: n })),
		PARTNER_COUNT,
	);
}

function readArchScanConfig() {
	const c = readConfig();
	const file = path.relative(hostRoot(), c.file);
	const fault = archScanFault(c);
	if (fault) throw new Error(`${file}: ${fault}`);
	return { config: c.archScan ?? {}, file };
}

/** @param {Source} source @param {string} file */
const buildSourceLine = (source, file) => {
	if (source === "override") return `archScan.threshold in ${file}`;
	if (source === "log") return `the newest close line in ${RECORD}`;
	return "the start value";
};

/**
 * @typedef {{ start: Start, end: { sha: string, ref: string },
 *   hot: HotFile[], growth: number, threshold: number, source: Source,
 *   sourceText: string }} Reading
 */

/**
 * @param {{ config: { threshold?: number, exclude?: string[] }, file: string }} archScan
 * @param {Array<Record<string, unknown>>} rows
 * @param {Start} start
 * @returns {Reading}
 */
function measure({ config, file }, rows, start) {
	const end = readWindowEnd();
	const hot = tally(readWindowCommits(start, end.sha, config.exclude));
	const { threshold, source } = thresholdInForce(rows, config.threshold);
	return {
		start,
		end,
		hot,
		growth: hot.reduce((s, f) => s + f.net, 0),
		threshold,
		source,
		sourceText: `${source}: ${buildSourceLine(source, file)}`,
	};
}

/** @param {Start} start */
const buildSinceText = (start) =>
	"sha" in start
		? `${start.sha} (newest scan line)`
		: `${start.date} (${start.from})`;

/** @param {number} n */
const signed = (n) => (n >= 0 ? `+${n}` : String(n));

/** @param {HotFile} f */
const hotRow = (f) =>
	`  ${String(f.commits).padStart(5)} commits  ${signed(f.net).padStart(7)}  ${f.path}`;

function dryRun() {
	const archScan = readArchScanConfig();
	const rows = readRecord();
	const reading = measure(archScan, rows, windowStart(rows));
	const map = scanInFlight(rows);
	let filing = "Under the threshold: a filing run would file nothing.";
	if (map)
		filing = `The scan filed as ${map} is in flight: a filing run would file nothing.`;
	else if (reading.growth >= reading.threshold)
		filing =
			"At or over the threshold: a filing run would file or refresh the due issue.";
	const lines = [
		`Window: since ${buildSinceText(reading.start)} to ${reading.end.sha} (${reading.end.ref})`,
		"",
		`Hot files, the ${HOT_COUNT} code files with the most commits:`,
		...reading.hot.map(hotRow),
		...(reading.hot.length > 0
			? []
			: ["  (no code file changed in the window)"]),
		"",
		`Growth: ${reading.growth} lines net over the hot files`,
		`Threshold: ${reading.threshold} (${reading.sourceText})`,
		filing,
		"Dry run: nothing filed.",
	];
	writeFd(1, `${lines.join("\n")}\n`);
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @returns {string | null}
 */
function scanInFlight(rows) {
	const scan = newestRow(rows, "scan");
	if (!scan) return null;
	return rows.some((row) => row?.mode === "close" && row.map === scan.map)
		? null
		: String(scan.map);
}

/** @param {Reading} reading */
function body(reading) {
	return [
		"Filed automatically by `scripts/report-arch-scan-due.js`, which reads this repo once a day at session start and rewrites this body at each reading while growth stays at or over the threshold. **Edit it by hand and the next reading silently overwrites it** — put anything you want kept in a comment.",
		"",
		"## This repo's busiest code has grown past its threshold",
		"",
		`Window: since ${buildSinceText(reading.start)} to ${reading.end.sha}.`,
		"",
		`The ${HOT_COUNT} code files with the most commits in the window:`,
		"",
		"| Commits | Net lines | File |",
		"| --- | --- | --- |",
		...reading.hot.map(
			(f) => `| ${f.commits} | ${signed(f.net)} | \`${f.path}\` |`,
		),
		"",
		`**Growth: ${reading.growth} lines** net over these files, against a threshold of ${reading.threshold} (${reading.sourceText}).`,
		"",
		"## What to do",
		"",
		"From this repo's own checkout, run the `architecture-scan` skill with this issue's number: `scan <this issue>`. It files a wayfinder map of deepening candidates, appends a `scan` line to `docs/data/arch-scan-runs.jsonl` and closes this issue.",
		"",
		"Closed without a scan, this issue is not filed again until growth counted from the close reaches the threshold.",
		"",
		buildStandaloneLine(
			`the architecture-scan counter's standing condition (${UPSTREAM_TRACKER}workflow-core#1348).`,
		),
	].join("\n");
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Start | null}
 */
function unscannedCloseStart(rows) {
	const closed = findTrackingIssue({ title: TITLE }, "closed");
	if (!closed?.closedAt) return null;
	const filed = closed.createdAt.slice(0, 10);
	const scanned = rows.some(
		(row) =>
			row?.mode === "scan" &&
			typeof row.date === "string" &&
			row.date.slice(0, 10) >= filed,
	);
	return scanned
		? null
		: {
				date: closed.closedAt,
				from: `the close of #${closed.number}, which no scan followed`,
			};
}

/** @returns {string} */
function fileRun() {
	const archScan = readArchScanConfig();
	const rows = readRecord();
	const map = scanInFlight(rows);
	if (map)
		return `The scan filed as ${map} is in flight: ${RECORD} holds no close line for it. Nothing filed.`;
	const reading = measure(
		archScan,
		rows,
		unscannedCloseStart(rows) ?? windowStart(rows),
	);
	const figure = `Growth ${reading.growth} against ${reading.threshold} (${reading.source}), since ${buildSinceText(reading.start)}`;
	if (reading.growth < reading.threshold)
		return `${figure}: under the threshold, nothing filed.`;
	return `${figure}. ${fileOrRefresh({ title: TITLE, labels: [LABEL], body: body(reading) })}`;
}

function daily() {
	runDailyReading({
		script: __filename,
		stamp: ".arch-scan-read",
		read: fileRun,
	});
}

/** @param {string} raw */
function nextThreshold(raw) {
	if (!/^\d+$/.test(raw)) {
		writeFd(
			2,
			`--next-threshold takes the scan's yield, a whole number of accepted candidates; got "${raw}"\n\n${USAGE}\n`,
		);
		process.exit(2);
	}
	const { config } = readArchScanConfig();
	const rows = readRecord();
	const inForce = thresholdInForce(rows, config.threshold);
	const learned = learnedThreshold(rows);
	const y = Number(raw);
	writeFd(
		2,
		`From ${learned.threshold} (${learned.source}), yield ${y}; ${inForce.threshold} (${inForce.source}) in force.\n`,
	);
	writeFd(
		1,
		`${JSON.stringify({ threshold: inForce.threshold, nextThreshold: recalibrate(learned.threshold, y) })}\n`,
	);
}

/**
 * @param {string} file
 * @returns {{ text: string, hot: HotFile[] }}
 */
function readSavedRun(file) {
	if (!fs.existsSync(file))
		throw new Error(`${file} does not exist — ${buildSaveHint(file)}`);
	const text = fs.readFileSync(file, "utf8");
	const hot = [...text.matchAll(HOT_ROW_RE)].map((m) => ({
		path: requiredGroup(m, 3, HOT_ROW_RE),
		commits: Number(requiredGroup(m, 1, HOT_ROW_RE)),
		net: Number(requiredGroup(m, 2, HOT_ROW_RE)),
	}));
	if (hot.length === 0)
		throw new Error(
			`${file} holds no hot-file row of a --dry-run output — ${buildSaveHint(file)}`,
		);
	return { text, hot };
}

/** @param {string} file */
const buildSaveHint = (file) =>
	`save one with: node ${scriptPath("report-arch-scan-due.js")} --dry-run > ${file}`;

/** @param {string} file */
function hotFiles(file) {
	writeFd(1, `${JSON.stringify(readSavedRun(file).hot)}\n`);
}

/** @param {string} file */
function partners(file) {
	const { text, hot } = readSavedRun(file);
	const m = WINDOW_RE.exec(text);
	if (!m)
		throw new Error(
			`${file} holds no Window line of a --dry-run output — ${buildSaveHint(file)}`,
		);
	const since = requiredGroup(m, 1, WINDOW_RE);
	/** @type {Start} */
	const start = FULL_SHA.test(since)
		? { sha: since }
		: { date: since, from: requiredGroup(m, 2, WINDOW_RE) };
	const commits = readWindowCommits(
		start,
		requiredGroup(m, 3, WINDOW_RE),
		readArchScanConfig().config.exclude,
	);
	writeFd(
		1,
		`${JSON.stringify(hot.map((f) => ({ path: f.path, partners: partnersOf(commits, f.path) })))}\n`,
	);
}

/**
 * @type {Record<string, { kind: "boolean" | "value", run: (value: string) => void }>}
 */
const MODES = {
	"--dry-run": { kind: "boolean", run: () => dryRun() },
	"--next-threshold": { kind: "value", run: nextThreshold },
	"--hot-files": { kind: "value", run: hotFiles },
	"--partners": { kind: "value", run: partners },
};

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: Object.fromEntries(
			Object.entries(MODES).map(([f, { kind }]) => [f, kind]),
		),
	});
	const named = Object.entries(MODES).filter(([f]) => f in flags);
	if (named.length > 1) {
		writeFd(2, `Name one mode at most.\n\n${USAGE}\n`);
		process.exit(2);
	}
	const [mode] = named;
	if (mode === undefined) return daily();
	const [flag, { run }] = mode;
	try {
		run(flagValue(flags, flag) ?? "");
	} catch (e) {
		writeFd(2, `BROKEN: ${failureReason(e)}\n`);
		process.exit(2);
	}
}

if (require.main === module) main();
