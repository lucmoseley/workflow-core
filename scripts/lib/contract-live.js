/*
 * contract-live.js — which live contract cases have skipped in every
 * scheduled sweep for longer than WINDOW_MS (#5408), off a ledger of each
 * `*.contract.test.ts` case's newest live run, folded from each sweep's
 * vitest reports once.
 *
 * WHY SWEEPS. A contract file that skips a case on a silent service still
 * passes, so the pass store caches it and a local run never asks again; the
 * sweep runs every file from cold on a clock, rowless (lib/pass-store.js).
 *
 * WHY A LEDGER. A sweep's reports are ~11 MB and kept 14 days; reading the
 * window's sweeps whole on every run would download over 300 MB. Each sweep
 * is read once and its cases folded in.
 *
 * LIVE is a case that passed or failed: either way it reached what it asks
 * about. A case that never ran live in any sweep folded — one that skips on
 * the runner by design, as a Windows tool or the installed `claude` — is
 * counted, never reported: nothing says it could run there.
 */

const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { reportRoot } = require("./suite-timings.js");

const DAY_MS = 86_400_000;

/* Fowler's limit on a quarantined test's stay, "no longer than a week"
 * (martinfowler.com/articles/nonDeterminism.html, in
 * docs/practice/test-design-and-reliability.md): a skipping case is one
 * quarantined by the service rather than by a person. */
const WINDOW_MS = 7 * DAY_MS;

/* A case unseen this long is renamed or gone, and leaves the ledger. */
const FORGET_MS = 2 * WINDOW_MS;

const CONTRACT = /\.contract\.test\.ts$/;

/** @typedef {{ lastLive: number|null, lastSkipped: number|null, lastSeen: number }} Case */
/** @typedef {{ newestRun: number, newestAt: number, cases: Record<string, Case> }} Ledger */
/** @typedef {{ key: string, live: boolean }} Seen */
/** @typedef {{ at: number, seen: Seen[] }} Sweep */

/** @returns {Ledger} */
const emptyLedger = () => ({ newestRun: 0, newestAt: 0, cases: {} });

/**
 * The ledger at `file`; an empty one where it is absent. Any other read or
 * parse fault throws.
 * @param {string} file
 * @returns {Ledger}
 */
function readLedger(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT")
			return emptyLedger();
		throw e;
	}
	return JSON.parse(text);
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
function sweepAt(dir, root) {
	if (!fs.existsSync(dir)) return null;
	const files = fs
		.readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((f) => f.endsWith(".json"));
	if (files.length === 0) return null;
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
 * dropped.
 * @param {Ledger} ledger
 * @param {number} run
 * @param {Sweep} sweep
 * @returns {Ledger}
 */
function fold(ledger, run, sweep) {
	const cases = { ...ledger.cases };
	for (const { key, live } of sweep.seen) {
		const c = cases[key] ?? { lastLive: null, lastSkipped: null, lastSeen: 0 };
		const latest = (/** @type {number|null} */ t) => Math.max(t ?? 0, sweep.at);
		cases[key] = {
			lastLive: live ? latest(c.lastLive) : c.lastLive,
			lastSkipped: live ? c.lastSkipped : latest(c.lastSkipped),
			lastSeen: latest(c.lastSeen),
		};
	}
	const newestAt = Math.max(ledger.newestAt, sweep.at);
	for (const [key, c] of Object.entries(cases))
		if (newestAt - c.lastSeen > FORGET_MS) delete cases[key];
	return { newestRun: Math.max(ledger.newestRun, run), newestAt, cases };
}

/**
 * The cases skipped in the newest sweep and in every sweep since their last
 * live run, that run more than `windowMs` before it, oldest first; and how
 * many have never run live in a sweep folded.
 * @param {Ledger} ledger
 * @param {number} [windowMs]
 */
function judge(ledger, windowMs = WINDOW_MS) {
	const silent = [];
	let neverLive = 0;
	for (const [key, c] of Object.entries(ledger.cases)) {
		if (c.lastLive === null) {
			neverLive++;
			continue;
		}
		const skippedNewest =
			c.lastSeen === ledger.newestAt && c.lastSkipped === c.lastSeen;
		if (skippedNewest && ledger.newestAt - c.lastLive > windowMs)
			silent.push({ key, lastLive: c.lastLive });
	}
	silent.sort((a, b) => a.lastLive - b.lastLive);
	return { silent, neverLive };
}

module.exports = {
	DAY_MS,
	WINDOW_MS,
	emptyLedger,
	fold,
	judge,
	readLedger,
	sweepAt,
	writeLedger,
};
