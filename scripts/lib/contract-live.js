const path = require("node:path");
const fs = require("node:fs");
const { writeFileAtomic } = require("./atomic-write.js");
const { orFallback } = require("./caught.js");
const { readText } = require("./file-read.js");
const { reportRoot } = require("./suite-timings.js");

const DAY_MS = 86_400_000;

const WINDOW_MS = 7 * DAY_MS;

const FORGET_MS = 14 * DAY_MS;

const CONTRACT = /\.contract\.test\.ts$/;

/** @typedef {{ firstSeen: number, lastLive: number|null, lastSkipped: number|null, lastSeen: number }} Case */
/** @typedef {{ firstAt: number, newestRun: number, newestAt: number, gapAt: number, cases: Record<string, Case> }} Ledger */
/** @typedef {{ key: string, live: boolean }} Seen */
/** @typedef {{ at: number, seen: Seen[] }} Sweep */

/** @returns {Ledger} */
const emptyLedger = () => ({
	firstAt: 0,
	newestRun: 0,
	newestAt: 0,
	gapAt: 0,
	cases: {},
});

/** @param {unknown} v */
const isLedger = (v) => {
	const l = /** @type {Record<string, unknown>} */ (v);
	return (
		typeof l === "object" &&
		l !== null &&
		["firstAt", "newestRun", "newestAt", "gapAt"].every(
			(k) => typeof l[k] === "number",
		) &&
		typeof l.cases === "object" &&
		l.cases !== null
	);
};

/**
 * @param {string} file
 * @returns {{ ledger: Ledger, fault: string|null }}
 */
function readLedger(file) {
	const read = readText(file);
	if (read.state === "absent") return { ledger: emptyLedger(), fault: null };
	if (read.state === "unreadable")
		return { ledger: emptyLedger(), fault: read.message };
	const parsed = orFallback(() => JSON.parse(read.data), undefined);
	if (isLedger(parsed)) return { ledger: parsed, fault: null };
	return { ledger: emptyLedger(), fault: "not a ledger" };
}

/**
 * @param {string} file
 * @param {Ledger} ledger
 */
function writeLedger(file, ledger) {
	writeFileAtomic(file, `${JSON.stringify(ledger)}\n`, { mkdir: true });
}

/**
 * @param {string} dir
 * @param {string} root
 * @returns {Sweep|null}
 */
function readSweep(dir, root) {
	if (!fs.existsSync(dir)) return null;
	const files = fs
		.readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((f) => f.endsWith(".json"));
	let at = 0;
	/** @type {Seen[]} */
	const seen = [];
	for (const f of files) {
		const report = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
		if (typeof report.startTime === "number")
			at = Math.max(at, report.startTime);
		seen.push(...casesOf(report, root));
	}
	return at > 0 ? { at, seen } : null;
}

/**
 * @param {{ testResults?: { name?: string, assertionResults?: { fullName: string, status: string }[] }[] }} report
 * @param {string} root
 * @returns {Seen[]}
 */
function casesOf(report, root) {
	const base = reportRoot(report, root, (rel) =>
		fs.existsSync(path.join(root, rel)),
	);
	return (report.testResults ?? []).flatMap((r) => {
		const file = path.relative(base, String(r.name ?? ""));
		if (!CONTRACT.test(file)) return [];
		return (r.assertionResults ?? []).map((a) => ({
			key: `${file} > ${a.fullName}`,
			live: a.status === "passed" || a.status === "failed",
		}));
	});
}

/**
 * @param {Ledger} ledger
 * @param {number} run
 * @param {Sweep} sweep
 * @param {boolean} afterGap
 * @returns {Ledger}
 */
function fold(ledger, run, sweep, afterGap) {
	const cases = { ...ledger.cases };
	const latest = (/** @type {number|null} */ t) => Math.max(t ?? 0, sweep.at);
	for (const { key, live } of sweep.seen) {
		const c = cases[key] ?? {
			firstSeen: sweep.at,
			lastLive: null,
			lastSkipped: null,
			lastSeen: 0,
		};
		cases[key] = {
			firstSeen: c.firstSeen,
			lastLive: live ? latest(c.lastLive) : c.lastLive,
			lastSkipped: live ? c.lastSkipped : latest(c.lastSkipped),
			lastSeen: latest(c.lastSeen),
		};
	}
	const newestAt = Math.max(ledger.newestAt, sweep.at);
	for (const [key, c] of Object.entries(cases))
		if (newestAt - c.lastSeen > FORGET_MS) delete cases[key];
	return {
		firstAt: ledger.firstAt || sweep.at,
		newestRun: Math.max(ledger.newestRun, run),
		newestAt,
		gapAt: afterGap ? sweep.at : ledger.gapAt,
		cases,
	};
}

/** @param {Ledger} ledger */
function judge(ledger) {
	const silent = [];
	const fresh = [];
	let neverLive = 0;
	for (const [key, c] of Object.entries(ledger.cases)) {
		const skippedNewest =
			c.lastSeen === ledger.newestAt && c.lastSkipped === c.lastSeen;
		if (c.lastLive === null) {
			neverLive++;
			const since = Math.max(ledger.firstAt, ledger.gapAt);
			if (
				skippedNewest &&
				c.firstSeen > since &&
				ledger.newestAt - c.firstSeen <= WINDOW_MS
			)
				fresh.push({ key, firstSeen: c.firstSeen });
			continue;
		}
		const from = Math.max(c.lastLive, ledger.gapAt);
		if (skippedNewest && ledger.newestAt - from > WINDOW_MS)
			silent.push({ key, lastLive: c.lastLive });
	}
	silent.sort((a, b) => a.lastLive - b.lastLive);
	return { silent, fresh, neverLive };
}

module.exports = {
	DAY_MS,
	WINDOW_MS,
	fold,
	judge,
	readLedger,
	readSweep,
	writeLedger,
};
