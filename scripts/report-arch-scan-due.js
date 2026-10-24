#!/usr/bin/env node
/*
 * report-arch-scan-due.js — the architecture-scan counter (#1362, spec #1348
 * Part 2): how far a repo's busiest code has grown since its last scan, and
 * the threshold that growth is judged against.
 *
 *   (no flag)                 the daily filing run (#1378), launched detached
 *                             at every session start by
 *                             scripts/sweep-debts-detached.sh, in every repo.
 *                             At most one reading a day, off a stamp in the
 *                             git common directory, so worktrees share it, and
 *                             behind a lock, through lib/periodic-reading.js.
 *                             At or over the threshold it files or refreshes
 *                             the one *Architecture scan due* issue, found by
 *                             title alone, so a retitled one is not found and
 *                             the next reading over the threshold files a
 *                             second.
 *   --dry-run                 print the window, the ten hot files with their
 *                             commits and net growth, the total, the threshold
 *                             and its source.
 *   --next-threshold <yield>  print {threshold, nextThreshold} as one JSON line
 *                             for the architecture-scan skill's close line, so
 *                             the rule lives here alone: the threshold in force
 *                             and what the recalibration rule gives from the
 *                             learned one, which an override never moves.
 *   --hot-files <file>        print a saved dry run's hot files as one compact
 *                             JSON array of {path, commits, net}, for the
 *                             skill's scan line, so the row format is read
 *                             where it is written (#1490). A file holding no
 *                             hot-file row is BROKEN, never an empty array.
 *   --partners <file>         print a saved dry run's hot files, each with its
 *                             change-coupling partners: the code files most
 *                             often in the same commits over that run's
 *                             window, as one JSON array of {path, partners:
 *                             [{path, commits}]}, for the skill's explore
 *                             step, so a partner passes the filter a hot file
 *                             does (#1743).
 *
 * CODE is a file tracked at the window's end with a code extension or under
 * `.husky/`, minus test kind (lib/test-kind.js), vendored
 * `.agents/`, generated `*.d.ts` and `*.min.js`, and `archScan.exclude`'s
 * pathspec globs.
 *
 * THE HOT FILES are the ten code files with the most commits in the window;
 * GROWTH is lines added minus deleted over them, renames detected, a renamed
 * file counted under its newest path.
 *
 * THE FILING RUN FILES NOTHING while the newest `scan` line has no `close`
 * line for its map: that scan is in flight. Where the newest closed due issue
 * has no `scan` line dated on or after its creation day, it was closed without
 * a scan, so the window starts at its close, for the issue refiled from it
 * too. By day, since the skill's scan line may carry no time: a scan run
 * earlier on the day a due issue was filed counts as following it.
 *
 * Exit 0 on a reading. The filing run always exits 0: anything it cannot do —
 * an unreadable run log, a malformed `archScan` value, a git or `gh` failure —
 * is one line in the arbiter's error log, which `npm run check:guard-errors`
 * reports, and the next day's reading retries. `--dry-run` reads no tracker,
 * so its window never starts at a close. The flagged modes exit 2 on
 * those, and on a refused command line.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { logError } = require("./lib/arbiter-core");
const { errMessage, now } = require("./lib/check");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root");
const { periodicReading, skipLine } = require("./lib/periodic-reading");
const { requiredGroup } = require("./lib/regex-group");
const { isTestKind } = require("./lib/test-kind");
const { fileOrRefresh, findTrackingIssue } = require("./lib/tracking-issue");
const {
	archScanFault,
	readConfig,
	UPSTREAM_TRACKER,
} = require("./lib/workflow-core-config");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { takesLabel } = require("./lib/takes-label");

const RECORD = "docs/data/arch-scan-runs.jsonl";
/* The spec's chosen values: the start date at #1309 Q4 (A), the threshold,
 * its bounds and recalibrate()'s bands at #1309 Q2 (A), the hot-file count at
 * #1309 Q1 (A). */
const DEFAULT_SINCE = "2026-09-21T00:00Z";
const START_THRESHOLD = 8750;
const MIN_THRESHOLD = 4000;
const MAX_THRESHOLD = 40_000;
const HOT_COUNT = 10;
/* The spec names one partner per hot file, the strongest (#1310); three gives
 * the scan the runners-up beside it. Untraced. */
const PARTNER_COUNT = 3;
/** A `--numstat` line: added, deleted, path — the path empty on a rename. */
const NUMSTAT_RE = /^(\d+|-)\t(\d+|-)\t(.*)$/s;
const TITLE = "Architecture scan due";
const LABEL = takesLabel("implement");
const STAMP = ".arch-scan-read";
const LOCK = ".arch-scan-read.lock";
const DAY_MS = 24 * 3_600_000;
const SHA_RE = /^[0-9a-f]{40}$/;
const WHERE = "report-arch-scan-due";

const CODE_EXT = /\.(?:js|mjs|cjs|ts|tsx|sh|py)$/;
const GENERATED = /\.(?:d\.ts|min\.js)$/;

const USAGE =
	"usage: node scripts/report-arch-scan-due.js [--dry-run | --next-threshold <yield> | --hot-files <file> | --partners <file>]";
/** A dry run's hot-file row, as hotRow() writes it: commits, signed net, path. */
const HOT_ROW_RE = /^ +(\d+) commits +([+-]\d+) {2}(.+)$/gm;
/** A dry run's window line, as dryRun() writes it: its since, where that came from, then its end sha. */
const WINDOW_RE =
	/^Window: since (.+) \(([^()]*)\) to ([0-9a-f]{40}) \([^()]*\)$/m;

/** @param {string} p repo-relative, forward slashes */
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
	execFileSync("git", args, {
		cwd: hostRoot(),
		encoding: "utf8",
		maxBuffer: CHILD_MAX_BUFFER,
		stdio: ["ignore", "pipe", "pipe"],
	});

/**
 * The run log's lines, oldest first; none where the file is absent, as in an
 * adopter no scan has reached. Throws on a line it cannot read, so a corrupt
 * log never reads as "never scanned".
 *
 * @returns {Array<Record<string, unknown>>}
 */
function readRecord() {
	const file = path.join(hostRoot(), RECORD);
	if (!fs.existsSync(file)) return [];
	/** @type {Array<Record<string, unknown>>} */
	const rows = [];
	for (const [i, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line));
		} catch (e) {
			throw new Error(
				`${RECORD}:${i + 1} is not JSON — ${e instanceof Error ? e.message : String(e)}`,
				{ cause: e },
			);
		}
	}
	return rows;
}

/**
 * @typedef {{ sha: string } | { date: string, from: string }} Start
 * @typedef {{ path: string, commits: number, net: number }} HotFile
 * @typedef {"default" | "log" | "override"} Source
 */

/**
 * Where counting starts: the newest scan's head, else the newest seed's
 * since, else the plugin's default date.
 *
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Start}
 */
function windowStart(rows) {
	const scan = newestRow(rows, "scan");
	if (scan) {
		if (typeof scan.head !== "string" || !SHA_RE.test(scan.head))
			throw new Error(`${RECORD}: the newest scan line has no 40-hex "head"`);
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
 * @param {number | undefined} override archScan.threshold
 * @returns {{ threshold: number, source: Source }}
 */
function thresholdInForce(rows, override) {
	if (override !== undefined)
		return { threshold: override, source: "override" };
	return learnedThreshold(rows);
}

/**
 * The newest close line's nextThreshold, else the start value. An override
 * neither reads nor moves it, so removing one resumes this (#1348).
 *
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
 * @param {number} y the scan's candidates accepted for build
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

/** The window's end: origin's HEAD, else the checked-out HEAD. */
function windowEnd() {
	for (const ref of ["refs/remotes/origin/HEAD", "HEAD"]) {
		try {
			return { sha: git(["rev-parse", "--verify", "-q", ref]).trim(), ref };
		} catch {
			/* `--verify -q` exits 1, silent, on a ref that does not resolve,
			 * which is the fallback's whole case. */
		}
	}
	throw new Error(
		"no commit to count to: neither origin's HEAD nor HEAD resolves",
	);
}

/**
 * The files at the window's end that the exclusion leaves in.
 *
 * The exclusion applies here, to the files at the window's end, never to
 * the log: a path the log's pathspec drops is gone before rename detection,
 * so a file moved out of an excluded directory would count whole. A diff
 * from the empty tree is the one listing of a tree that takes `:(glob)`.
 *
 * @param {string} head
 * @param {string[]} exclude archScan.exclude
 * @returns {Set<string>}
 */
function countedFiles(head, exclude) {
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
 * A numstat record's path under its newest name. An empty `name` is a rename,
 * whose two paths are the iterator's next two tokens.
 *
 * @param {string} name
 * @param {Iterator<string>} tokens accumulator: a rename's two paths are taken off it
 * @param {Map<string, string>} renamedTo accumulator: each rename's old path is mapped to its newest
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
 * A numstat line's added (group 1) or deleted (group 2) count; git's `-`, a
 * binary file, changes no line.
 *
 * @param {RegExpExecArray} m @param {1 | 2} n
 */
function numstatLines(m, n) {
	const g = requiredGroup(m, n, NUMSTAT_RE);
	return g === "-" ? 0 : Number(g);
}

/**
 * Each commit in the window, as the net lines it changed in each code file,
 * every path under its newest name.
 *
 * @param {Start} start
 * @param {string} head
 * @param {string[] | undefined} exclude archScan.exclude
 * @returns {Array<Map<string, number>>}
 */
function windowCommits(start, head, exclude = []) {
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
	const counted = countedFiles(head, exclude);

	/** Newest name of each path a rename moved, built newest-first. */
	/** @type {Map<string, string>} */
	const renamedTo = new Map();
	/** @type {Array<Map<string, number>>} */
	const commits = [];
	/** @type {Map<string, number>} */
	let inCommit = new Map();

	// One iterator, so a rename's body can take its two path tokens off it.
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
			(inCommit.get(name) ?? 0) + numstatLines(m, 1) - numstatLines(m, 2),
		);
	}
	return commits;
}

/**
 * Commits and net lines per code file in the window, the busiest first.
 *
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
 * The `n` rows in the most commits, ties by path.
 *
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
 * The code files most often in the same commits as `hot`, the most first.
 *
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

/** The config's archScan, BROKEN-thrown on a malformed value. */
function archScanConfig() {
	const c = readConfig();
	const file = path.relative(hostRoot(), c.file);
	const fault = archScanFault(c);
	if (fault) throw new Error(`${file}: ${fault}`);
	return { config: c.archScan ?? {}, file };
}

/** @param {Source} source @param {string} file */
const sourceLine = (source, file) => {
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
	const end = windowEnd();
	const hot = tally(windowCommits(start, end.sha, config.exclude));
	const { threshold, source } = thresholdInForce(rows, config.threshold);
	return {
		start,
		end,
		hot,
		growth: hot.reduce((s, f) => s + f.net, 0),
		threshold,
		source,
		sourceText: `${source}: ${sourceLine(source, file)}`,
	};
}

/** @param {Start} start */
const sinceText = (start) =>
	"sha" in start
		? `${start.sha} (newest scan line)`
		: `${start.date} (${start.from})`;

/** @param {number} n */
const signed = (n) => (n >= 0 ? `+${n}` : String(n));

/** @param {HotFile} f */
const hotRow = (f) =>
	`  ${String(f.commits).padStart(5)} commits  ${signed(f.net).padStart(7)}  ${f.path}`;

function dryRun() {
	const archScan = archScanConfig();
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
		`Window: since ${sinceText(reading.start)} to ${reading.end.sha} (${reading.end.ref})`,
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
	process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * The map of the newest scan where no close line names it, else null.
 *
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

/**
 * Carries no date of the reading's own, so a reading that finds nothing
 * changed leaves the body as it stands.
 *
 * @param {Reading} reading
 */
function body(reading) {
	return [
		"Filed automatically by `scripts/report-arch-scan-due.js`, which reads this repo once a day at session start and rewrites this body at each reading while growth stays at or over the threshold. **Edit it by hand and the next reading silently overwrites it** — put anything you want kept in a comment.",
		"",
		"## This repo's busiest code has grown past its threshold",
		"",
		`Window: since ${sinceText(reading.start)} to ${reading.end.sha}.`,
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
		`Standalone: the architecture-scan counter's standing condition (${UPSTREAM_TRACKER}#1348).`,
	].join("\n");
}

/**
 * The newest due issue's close, where no scan followed its filing; else null.
 *
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

/** @returns {string} what happened, for the run to print */
function fileRun() {
	const archScan = archScanConfig();
	const rows = readRecord();
	const map = scanInFlight(rows);
	if (map)
		return `The scan filed as ${map} is in flight: ${RECORD} holds no close line for it. Nothing filed.`;
	const reading = measure(
		archScan,
		rows,
		unscannedCloseStart(rows) ?? windowStart(rows),
	);
	const figure = `Growth ${reading.growth} against ${reading.threshold} (${reading.source}), since ${sinceText(reading.start)}`;
	if (reading.growth < reading.threshold)
		return `${figure}: under the threshold, nothing filed.`;
	return `${figure}. ${fileOrRefresh({ title: TITLE, labels: [LABEL], body: body(reading) })}`;
}

const commonDir = () =>
	git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();

/**
 * A failed git or gh call's message holds its whole argv, a filed body
 * included; its stderr is the reason.
 *
 * @param {unknown} e
 */
function reason(e) {
	const stderr =
		e && typeof e === "object" && "stderr" in e ? String(e.stderr).trim() : "";
	return stderr || errMessage(e);
}

function daily() {
	try {
		const nowMs = now();
		const dir = commonDir();
		const gate = periodicReading(
			{
				stamp: path.join(dir, STAMP),
				lock: path.join(dir, LOCK),
				nowMs,
				everyMs: DAY_MS,
			},
			fileRun,
		);
		console.log(gate.ran ? gate.value : skipLine(gate, "a day"));
	} catch (e) {
		/* Fails open (#1378): a session start never waits on, or fails for, a
		 * count nobody asked for. */
		logError(WHERE, e);
		process.stderr.write(
			`FAILED OPEN: ${reason(e)} — recorded in the guard-error log; the next day's reading retries.\n`,
		);
	}
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
	const { config } = archScanConfig();
	const rows = readRecord();
	const inForce = thresholdInForce(rows, config.threshold);
	const learned = learnedThreshold(rows);
	const y = Number(raw);
	process.stderr.write(
		`From ${learned.threshold} (${learned.source}), yield ${y}; ${inForce.threshold} (${inForce.source}) in force.\n`,
	);
	process.stdout.write(
		`${JSON.stringify({ threshold: inForce.threshold, nextThreshold: recalibrate(learned.threshold, y) })}\n`,
	);
}

/**
 * A saved `--dry-run` output's hot files, BROKEN-thrown where it holds none.
 *
 * @param {string} file
 * @returns {{ text: string, hot: HotFile[] }}
 */
function readSavedRun(file) {
	if (!fs.existsSync(file))
		throw new Error(`${file} does not exist — ${saveHint(file)}`);
	const text = fs.readFileSync(file, "utf8");
	const hot = [...text.matchAll(HOT_ROW_RE)].map((m) => ({
		path: requiredGroup(m, 3, HOT_ROW_RE),
		commits: Number(requiredGroup(m, 1, HOT_ROW_RE)),
		net: Number(requiredGroup(m, 2, HOT_ROW_RE)),
	}));
	if (hot.length === 0)
		throw new Error(
			`${file} holds no hot-file row of a --dry-run output — ${saveHint(file)}`,
		);
	return { text, hot };
}

/** @param {string} file */
const saveHint = (file) =>
	`save one with: node scripts/report-arch-scan-due.js --dry-run > ${file}`;

/** @param {string} file a saved `--dry-run` output */
function hotFiles(file) {
	process.stdout.write(`${JSON.stringify(readSavedRun(file).hot)}\n`);
}

/**
 * Over the saved run's own window, so a head that moved since cannot shift
 * the partners off the hot files they belong to.
 *
 * @param {string} file a saved `--dry-run` output
 */
function partners(file) {
	const { text, hot } = readSavedRun(file);
	const m = WINDOW_RE.exec(text);
	if (!m)
		throw new Error(
			`${file} holds no Window line of a --dry-run output — ${saveHint(file)}`,
		);
	const since = requiredGroup(m, 1, WINDOW_RE);
	/** @type {Start} */
	const start = SHA_RE.test(since)
		? { sha: since }
		: { date: since, from: requiredGroup(m, 2, WINDOW_RE) };
	const commits = windowCommits(
		start,
		requiredGroup(m, 3, WINDOW_RE),
		archScanConfig().config.exclude,
	);
	process.stdout.write(
		`${JSON.stringify(hot.map((f) => ({ path: f.path, partners: partnersOf(commits, f.path) })))}\n`,
	);
}

/**
 * Each flagged mode, run with its flag's value; naming none is the daily run.
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
		writeFd(2, `BROKEN: ${reason(e)}\n`);
		process.exit(2);
	}
}

if (require.main === module) main();
