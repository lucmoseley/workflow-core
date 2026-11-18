/*
 * contract-live.js — which live contract cases have skipped in every
 * scheduled sweep for longer than WINDOW_MS (workflow-core#5408), off a ledger of each
 * `*.contract.test.ts` case's newest live run, folded from each sweep's
 * vitest reports once.
 *
 * WHY SWEEPS. A contract file that skips a case on a silent service still
 * passes, so the pass store caches it and a local run never asks again; the
 * sweep runs every file from cold on a clock, rowless (lib/pass-store.js).
 *
 * WHY A LEDGER. A sweep's reports are ~11 MB and kept 14 days; reading the
 * window's sweeps whole on every run would download over 300 MB.
 *
 * LIVE is a case that passed or failed: either way it reached what it asks
 * about. A case that never ran live in any sweep folded — one that skips on
 * the runner by design, as a Windows tool or the installed `claude` — is
 * never a finding. One first seen after the
 * ledger began is named for a window, so a new case whose service was silent
 * from the start is seen.
 *
 * A GAP — sweeps that dropped off the listing unread — may hold a case's live
 * run, so a case is judged from the first sweep after it at the earliest.
 */

const path = require("node:path");
const fs = require("node:fs");
const { writeFileAtomic } = require("./atomic-write.js");
const { readText } = require("./file-read.js");
const { reportRoot } = require("./suite-timings.js");

const DAY_MS = 86_400_000;

/* Fowler's limit on a quarantined test's stay, "no longer than a week"
 * (martinfowler.com/articles/nonDeterminism.html, in
 * docs/practice/test-design-and-reliability.md): a skipping case is one
 * quarantined by the service rather than by a person. */
const WINDOW_MS = 7 * DAY_MS;

/* scheduled-checks.yml keeps a sweep's reports 14 days: a case unseen that
 * long is renamed or gone, and leaves the ledger. */
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
 * The ledger at `file`: an empty one where it is absent, and an empty one
 * with the fault where it will not read or is not a ledger.
 * @param {string} file
 * @returns {{ ledger: Ledger, fault: string|null }}
 */
function readLedger(file) {
	const read = readText(file);
	if (read.state === "absent") return { ledger: emptyLedger(), fault: null };
	if (read.state === "unreadable")
		return { ledger: emptyLedger(), fault: read.message };
	try {
		const parsed = JSON.parse(read.data);
		if (isLedger(parsed)) return { ledger: parsed, fault: null };
	} catch {
		/* not JSON: the fault below */
	}
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
 * One sweep's contract cases off the vitest reports under `dir`, its time
 * the latest report's `startTime`; null where it holds no report.
 * @param {string} dir
 * @param {string} root this checkout, which the report's file names are made relative to
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
 * The contract cases in one parsed vitest report.
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
 * `ledger` with sweep `run` folded in, and the cases unseen for FORGET_MS
 * dropped. `afterGap` where sweeps before this one went unread.
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

/**
 * The cases skipped in the newest sweep and in every sweep since their last
 * live run (or the last gap), that more than WINDOW_MS before it, oldest
 * first; the never-live cases first seen since the ledger began or the last
 * gap, and within the window; and how many never ran live in all.
 * @param {Ledger} ledger
 */
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
