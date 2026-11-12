/*
 * wsl-disk.js — the core of the monthly WSL disk compaction (#5044): reads
 * win-interop-watchdog/compact-disk.ps1's log, judges when a run is due and
 * when a missed one should warn, and judges the sparse watch. Held apart from
 * its reads, so each verdict is testable with no Windows side and no network.
 */

const fs = require("node:fs");
const path = require("node:path");
const { compareVersions } = require("./compare-versions.js");

const DAY_MS = 86_400_000;

/** Untraced: the ruling's "monthly" (#5041 Q1). */
const DUE_DAYS = 30;

/** The ticket's figure (#5044): a month and a few days' grace for a deferral. */
const STALE_DAYS = 35;

/*
 * Untraced: about 8% of this laptop's 476 GB C:. The VM died at 7.7 GB free
 * (#5041), and rebuild-disk.ps1 stops at 15 GB.
 */
const LOW_FREE_GB = 40;

/** The ps1 writes it to %LOCALAPPDATA%; WFC_WSL_COMPACT_LOG names a stand-in. */
const LOG_NAME = "wsl-compact.log";

/*
 * microsoft/WSL issues on sparse safety (#5041's research): #41837 is the
 * one whose fix the ruling waits on; the other two are watched for a close.
 */
const WATCHED_ISSUES = /** @type {const} */ ([41_837, 42_179, 10_609]);
const BLOCKING_ISSUE = 41_837;

/**
 * @typedef {{at: number, result: string, fields: Record<string, string>, line: string}} Entry
 * @typedef {{number: number, state: string, state_reason: string | null}} IssueRow
 * @typedef {{tag_name: string, body: string | null, prerelease: boolean, draft: boolean}} ReleaseRow
 * @typedef {{key: string, title: string, line: string}} Trigger
 */

/**
 * The log's lines, oldest first: `<local ISO time> <result> key=value…`.
 * A line that does not parse is skipped.
 * @param {string} text
 * @returns {Entry[]}
 */
function parseLog(text) {
	/** @type {Entry[]} */
	const entries = [];
	for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
		const [stamp = "", result = "", ...tokens] = raw.trim().split(/\s+/);
		if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(stamp)) continue;
		if (!/^[a-z]+$/.test(result)) continue;
		const at = Date.parse(stamp);
		if (Number.isNaN(at)) continue;
		/** @type {Record<string, string>} */
		const fields = {};
		for (const token of tokens) {
			const eq = token.indexOf("=");
			if (eq > 0) fields[token.slice(0, eq)] = token.slice(eq + 1);
		}
		entries.push({ at, result, fields, line: raw.trim() });
	}
	return entries;
}

/**
 * The newest `ok`, or the `registered` line the count starts from.
 * @param {Entry[]} entries
 * @returns {Entry | null}
 */
function lastSuccess(entries) {
	return (
		entries.findLast((e) => ["ok", "registered"].includes(e.result)) ?? null
	);
}

/**
 * Whether a run is due: DUE_DAYS since the last success, or none on record.
 * @param {Entry[]} entries
 * @param {number} now
 */
function isDue(entries, now) {
	const last = lastSuccess(entries);
	return last === null || now - last.at >= DUE_DAYS * DAY_MS;
}

/**
 * The status check's verdict.
 * @param {{entries: Entry[] | null, now: number, freeGB: number | null}} input
 * `entries` null is no log at all.
 * @returns {{warnings: {tag: string, line: string}[], okLine: string}}
 */
function judgeDisk({ entries, now, freeGB }) {
	const warnings = [];
	const free =
		freeGB === null ? "C: free unread" : `C: free ${freeGB.toFixed(1)} GB`;
	if (freeGB !== null && freeGB < LOW_FREE_GB)
		warnings.push({
			tag: "C-LOW",
			line: `${free}, under ${LOW_FREE_GB} GB. Run \`node scripts/wsl-disk-compaction.js run --now\`, and look for what is filling it (docs/environment.md §1).`,
		});
	if (entries === null) {
		warnings.push({
			tag: "COMPACT-UNINSTALLED",
			line: `no ${LOG_NAME} in %LOCALAPPDATA%, so the monthly compaction is not installed: run \`bash scripts/install-interop-watchdog.sh\`.`,
		});
		return { warnings, okLine: "" };
	}
	const last = lastSuccess(entries);
	const newest = entries.at(-1);
	if (last === null || now - last.at > STALE_DAYS * DAY_MS)
		warnings.push({
			tag: "COMPACT-STALE",
			line: `${last === null ? "no compaction has succeeded" : `the last compaction succeeded ${Math.floor((now - last.at) / DAY_MS)} days ago`}, over ${STALE_DAYS}; newest log line: ${newest?.line ?? "none"}.`,
		});
	if (newest && newest.result === "failed")
		warnings.push({
			tag: "COMPACT-FAILED",
			line: `the last compaction run failed: ${newest.line}`,
		});
	const shown =
		last === null
			? ""
			: `last compaction ${last.line.slice(0, 10)}${last.fields.after_gb ? ` (${last.fields.before_gb} to ${last.fields.after_gb} GB)` : ` (${last.result})`}, `;
	return { warnings, okLine: `${shown}${free}` };
}

/**
 * A watched issue's trigger: #41837 closed for any reason, another closed as
 * completed.
 * @param {IssueRow} i
 * @returns {Trigger[]}
 */
function issueTrigger(i) {
	if (i.state !== "closed") return [];
	const blocking = i.number === BLOCKING_ISSUE;
	if (!blocking && i.state_reason !== "completed") return [];
	return [
		{
			key: `issue-${i.number}`,
			title: `Convert the WSL disk to sparse? microsoft/WSL#${i.number} closed`,
			line: `microsoft/WSL#${i.number} closed (${i.state_reason ?? "no reason given"})${blocking ? ", the corruption after a full host disk that #5041 Q1 waits on" : ""}.`,
		},
	];
}

/**
 * A release's trigger: stable, newer than `installed`, its notes naming sparse.
 * @param {ReleaseRow} r
 * @param {number[]} installed
 * @returns {Trigger[]}
 */
function releaseTrigger(r, installed) {
	const tag = /^\d+(?:\.\d+)*$/.test(r.tag_name)
		? r.tag_name.split(".").map(Number)
		: null;
	if (r.draft || r.prerelease || tag === null) return [];
	if (compareVersions(tag, installed) <= 0) return [];
	const hits = (r.body ?? "")
		.split(/\r?\n/)
		.filter((l) => /sparse/i.test(l))
		.map((l) => l.trim());
	if (hits.length === 0) return [];
	return [
		{
			key: `release-${r.tag_name}`,
			title: `Convert the WSL disk to sparse? WSL ${r.tag_name} names sparse`,
			line: `WSL ${r.tag_name}'s notes name sparse: ${hits.slice(0, 5).join(" / ")}`,
		},
	];
}

/**
 * The sparse watch (#5041 Q1 (B)): what would make converting to sparse worth
 * asking about again. Each trigger's title is unique to it, so a filing is
 * deduped on the title.
 * @param {{issues: IssueRow[], releases: ReleaseRow[], installed: number[]}} input
 * @returns {Trigger[]}
 */
function judgeSparse({ issues, releases, installed }) {
	return [
		...issues.flatMap(issueTrigger),
		...releases.flatMap((r) => releaseTrigger(r, installed)),
	];
}

/**
 * The log's path on the Windows side, read with no interop call, since the
 * bridge is what fails: the newest `<user>/AppData/Local/wsl-compact.log`
 * under `usersDir`. Residual: two Windows users with a log each, the newer read.
 * @param {string} [usersDir]
 * @returns {string | null}
 */
function findLog(usersDir = "/mnt/c/Users") {
	const named = process.env.WFC_WSL_COMPACT_LOG;
	if (named) return fs.existsSync(named) ? named : null;
	let best = null;
	let bestAt = -1;
	let names = [];
	try {
		names = fs.readdirSync(usersDir);
	} catch {
		return null;
	}
	for (const name of names) {
		const p = path.join(usersDir, name, "AppData", "Local", LOG_NAME);
		const at = fs.statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? -1;
		if (at > bestAt) [best, bestAt] = [p, at];
	}
	return best;
}

/**
 * C:'s free space in GB, read off the drvfs mount, or null.
 * @param {string} [mount]
 */
function readFreeGB(mount = process.env.WFC_WIN_C || "/mnt/c") {
	try {
		const s = fs.statfsSync(mount);
		return (s.bavail * s.bsize) / 1e9;
	} catch {
		return null;
	}
}

/**
 * A WSL-side line in the ps1's shape, which a run that never starts the task
 * writes (`deferred`, `failed`).
 * @param {number} at
 * @param {string} rest
 */
function buildLogLine(at, rest) {
	const d = new Date(at);
	const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${rest}`;
}

module.exports = {
	BLOCKING_ISSUE,
	DUE_DAYS,
	LOW_FREE_GB,
	STALE_DAYS,
	WATCHED_ISSUES,
	buildLogLine,
	findLog,
	isDue,
	judgeDisk,
	judgeSparse,
	lastSuccess,
	parseLog,
	readFreeGB,
};
