/*
 * idle-efforts.js — the idle alarm's core (#3641, spec #3623): one pure
 * function from a reading of every tracker the refill loop could serve to the
 * efforts nothing has launched for 2 days, one line per tracker.
 *
 * An effort is an open issue with its descendants. Its last activity is the
 * latest launch of it or any descendant, or its creation where none is later.
 * One whose own or a descendant's launch is still running is not idle. Blocked,
 * gated, `takes:human` and `parked` issues are not counted: each waits on
 * something other than a launch, as does a container all of whose open
 * children do. A stranding is counted once, at its deepest idle issue, never
 * again at each ancestor.
 *
 * The reason printed beside a tracker's oldest is the loop's own launch filter
 * (lib/refill-decide.js's buildSkipReason).
 */

const { buildSkipReason } = require("./refill-decide.js");
const { PARKED_LABEL } = require("./parked.js");
const { takesLabel, takesOf } = require("./takes-label.js");
const { refKey } = require("./issue-ref.js");
const { resolveGate } = require("./issue-gate.js");

const DAY_MS = 24 * 60 * 60 * 1000;
/* One figure for every route: house, #3588. */
const IDLE_DAYS = 2;
const IDLE_MS = IDLE_DAYS * DAY_MS;
const URGENT_LABEL = "urgent";
const EXCLUDED_LABELS = [takesLabel("human"), PARKED_LABEL];
/* Blockers read inline per issue, lib/blocked-by-batch.js's INNER: 50 issues
 * of 100 labels, 25 blockers and 100 sub-issues stays far under GitHub's
 * 500,000-node cap. A
 * parent holds at most 100 sub-issues, closed ones counted. */
const QUERY =
	"query($owner: String!, $name: String!, $endCursor: String) { repository(owner: $owner, name: $name) { issues(states: OPEN, first: 50, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { number title createdAt body labels(first: 100) { nodes { name } } blockedBy(first: 25) { totalCount nodes { state } } subIssues(first: 100) { nodes { number state repository { nameWithOwner } } } } } } }";

/**
 * A node of QUERY's answer, as parsed: every reader below defaults a missing
 * field rather than checking its shape.
 * @typedef {any} GhJson
 */

/** @typedef {{repo: string, number: number}} Ref */

/**
 * @typedef {object} IssueReading
 * @property {number} number
 * @property {string} title
 * @property {number} createdAt ms
 * @property {string[]} labels
 * @property {boolean} blocked an open native blocker
 * @property {boolean} gated a date gate or a `Gated on:` holding
 * @property {Ref[]} children every sub-issue, closed ones and other repos'
 *   included
 */

/**
 * @typedef {object} TrackerReading
 * @property {string} repo `owner/name`
 * @property {boolean} served whether the loop's current scope serves it
 * @property {IssueReading[]} issues its open issues
 * @property {string|null} error why its issues would not read
 */

/**
 * @typedef {object} Readings
 * @property {TrackerReading[]} trackers
 * @property {Map<string, number>} launches refKey to its last launch, ms
 * @property {Set<string>} running refKeys of launches still running
 * @property {number} now ms
 */

/**
 * @typedef {object} Idle
 * @property {number} number
 * @property {string} title
 * @property {number} idleMs
 * @property {boolean} urgent
 * @property {string|null} skip the launch filter's reason, null where it
 *   passes the row
 */

/**
 * @typedef {object} TrackerFinding
 * @property {string} repo
 * @property {boolean} served
 * @property {string|null} error
 * @property {Idle[]} idle oldest first
 */

/**
 * Whether an open blocker holds the issue. A list longer than QUERY reads is
 * read as blocked.
 * @param {GhJson} conn
 */
const isBlocked = (conn) =>
	(conn?.totalCount ?? 0) > (conn?.nodes ?? []).length ||
	(conn?.nodes ?? []).some((/** @type {GhJson} */ b) => b?.state === "OPEN");

/**
 * One tracker's open issues from QUERY's answer, its gates judged at `now`.
 * Throws where a page names no issues.
 * @param {GhJson[]} pages
 * @param {number} now ms
 * @returns {IssueReading[]}
 */
function parseIssueNodes(pages, now) {
	return pages.flatMap((p) => {
		const issues = p?.data?.repository?.issues?.nodes;
		if (!Array.isArray(issues))
			throw new Error("gh's GraphQL answer named no issues");
		return issues.map((/** @type {GhJson} */ i) => {
			const gate = resolveGate(i.body ?? "", now);
			return {
				number: i.number,
				title: i.title ?? "",
				createdAt: Date.parse(i.createdAt),
				labels: (i.labels?.nodes ?? []).map(
					(/** @type {GhJson} */ l) => l.name,
				),
				blocked: isBlocked(i.blockedBy),
				gated: gate.gateHolds || gate.gateOnHolds,
				children: (i.subIssues?.nodes ?? []).map((/** @type {GhJson} */ k) => ({
					repo: k.repository?.nameWithOwner ?? "",
					number: k.number,
				})),
			};
		});
	});
}

/** @param {IssueReading} i */
const isExcluded = (i) =>
	i.blocked || i.gated || i.labels.some((l) => EXCLUDED_LABELS.includes(l));

/**
 * The open children of `key` this reading holds; a closed child, or one in a
 * tracker that would not read, is none.
 * @param {string} key
 * @param {Map<string, IssueReading>} open
 */
const openChildKeys = (key, open) =>
	(open.get(key)?.children ?? []).map(refKey).filter((k) => open.has(k));

/**
 * Whether `key` waits on something other than a launch.
 * @param {string} key
 * @param {Map<string, IssueReading>} open
 * @param {Set<string>} seen accumulator: the keys already walked
 * @returns {boolean}
 */
function isWaiting(key, open, seen = new Set()) {
	const i = open.get(key);
	if (i === undefined || isExcluded(i)) return true;
	if (seen.has(key)) return true;
	seen.add(key);
	const kids = openChildKeys(key, open);
	return kids.length > 0 && kids.every((k) => isWaiting(k, open, seen));
}

/**
 * The latest launch of `key` or any descendant, Infinity where one is
 * running, else -Infinity. A closed child is read for its own launch only, its
 * descendants unread.
 * @param {string} key
 * @param {Map<string, IssueReading>} open
 * @param {Readings} readings
 * @param {Set<string>} seen accumulator: the keys already walked
 * @returns {number}
 */
function lastLaunchUnder(key, open, readings, seen = new Set()) {
	if (seen.has(key)) return Number.NEGATIVE_INFINITY;
	seen.add(key);
	if (readings.running.has(key)) return Number.POSITIVE_INFINITY;
	let last = readings.launches.get(key) ?? Number.NEGATIVE_INFINITY;
	for (const child of open.get(key)?.children ?? [])
		last = Math.max(last, lastLaunchUnder(refKey(child), open, readings, seen));
	return last;
}

/**
 * Whether an open descendant of `key` is itself idle.
 * @param {string} key
 * @param {Map<string, IssueReading>} open
 * @param {Set<string>} idle
 * @param {Set<string>} seen accumulator: the keys already walked
 * @returns {boolean}
 */
function hasIdleDescendant(key, open, idle, seen = new Set()) {
	if (seen.has(key)) return false;
	seen.add(key);
	return openChildKeys(key, open).some(
		(k) => idle.has(k) || hasIdleDescendant(k, open, idle, seen),
	);
}

/**
 * Every tracker's efforts idle past 2 days.
 * @param {Readings} readings
 * @returns {TrackerFinding[]}
 */
function findIdleEfforts(readings) {
	/** @type {Map<string, IssueReading>} */
	const open = new Map();
	for (const t of readings.trackers)
		for (const i of t.issues) open.set(refKey({ repo: t.repo, ...i }), i);
	/** @type {Map<string, number>} key to its idle time, past 2 days only */
	const idleMs = new Map();
	for (const [key, i] of open) {
		if (isWaiting(key, open)) continue;
		const ms =
			readings.now -
			Math.max(i.createdAt, lastLaunchUnder(key, open, readings));
		if (ms > IDLE_MS) idleMs.set(key, ms);
	}
	const idle = new Set(idleMs.keys());
	return readings.trackers.map((t) => ({
		repo: t.repo,
		served: t.served,
		error: t.error,
		idle: t.issues
			.map((i) => ({ i, key: refKey({ repo: t.repo, ...i }) }))
			.filter(({ key }) => idle.has(key) && !hasIdleDescendant(key, open, idle))
			.map(({ i, key }) => ({
				number: i.number,
				title: i.title,
				idleMs: Number(idleMs.get(key)),
				urgent: i.labels.includes(URGENT_LABEL),
				skip: buildSkipReason({
					labels: i.labels,
					takes: takesOf(i.labels),
				}),
			}))
			.sort((a, b) => b.idleMs - a.idleMs),
	}));
}

/** @param {number} ms */
const days = (ms) => `${(ms / DAY_MS).toFixed(1)} days`;

/** @param {Idle} i */
const named = (i) => `#${i.number} (${i.title}), idle ${days(i.idleMs)}`;

/**
 * One line per tracker, and beneath a tracker the loop does not serve, each
 * `urgent` issue past the threshold; first, where no loop runs, a line saying
 * so.
 * @param {TrackerFinding[]} findings
 * @param {boolean} loopRunning
 * @returns {string[]}
 */
function buildIdleLines(findings, loopRunning) {
	const lines = findings.flatMap((f) => {
		const unserved = f.served ? "" : " (the refill loop does not serve it)";
		if (f.error !== null) return [`${f.repo}: unread — ${f.error}`];
		const [oldest] = f.idle;
		if (oldest === undefined)
			return [`${f.repo}: none idle past ${IDLE_DAYS} days${unserved}`];
		const skip = oldest.skip ?? "none, the launch filter passes it";
		return [
			`${f.repo}: ${f.idle.length} idle past ${IDLE_DAYS} days${unserved}; oldest ${named(oldest)}; skip reason: ${skip}`,
			...(f.served
				? []
				: f.idle.filter((i) => i.urgent).map((i) => `  urgent ${named(i)}`)),
		];
	});
	return loopRunning
		? lines
		: ["The refill loop is not running, so it serves no tracker.", ...lines];
}

module.exports = {
	IDLE_DAYS,
	QUERY,
	buildIdleLines,
	findIdleEfforts,
	parseIssueNodes,
};
