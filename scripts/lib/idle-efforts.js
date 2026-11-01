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
 * children do. A parked issue held is counted, from the hold's start: on its
 * session's full seat, as a running loop's state says in either mode, it waits
 * on that seat's reset, up to 7 days (#3680, #3850), and at the limit-cap parks'
 * cap, as its park marker says whatever the loop's mode and whether or not it runs (#3840), on the founder
 * (#3804). So is a launch waiting on a limit, from when it began (#3838). One at
 * the cap, which no reset ends, or on a limit, is named beneath its tracker's
 * line, however old its tracker's oldest (#3809, #3838); a full seat's stays in
 * the count. A stranding is counted once, at its deepest idle issue, never again
 * at each ancestor.
 *
 * The reason printed beside a tracker's oldest is its hold's where it is held,
 * else the loop's launch filter (lib/refill-decide.js's buildSkipReason).
 *
 * The shell hands over raw reads, keyed by checkout; buildReadings joins them
 * to the trackers those checkouts file to, and buildFindingRecords picks each
 * tracker's finding code (#3711).
 */

const { buildSkipReason, limitCapHoldOf } = require("./refill-decide.js");
const { PARKED_LABEL, newestMarkerListing } = require("./parked.js");
const { takesLabel, takesOf } = require("./takes-label.js");
const { refKey } = require("./issue-ref.js");
const { resolveGate } = require("./issue-gate.js");

const DAY_MS = 24 * 60 * 60 * 1000;
/* One figure for every route: house, #3588. */
const IDLE_DAYS = 2;
const IDLE_MS = IDLE_DAYS * DAY_MS;
const URGENT_LABEL = "urgent";
const HUMAN_LABEL = takesLabel("human");
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
 * A hold's reason, start, ms, and whether it is at the limit-cap parks' cap or a
 * launch waiting on a limit.
 * @typedef {{why: string, since: number, atCap?: boolean, onLimit?: boolean}} IdleHold
 */

/**
 * @typedef {object} Readings
 * @property {TrackerReading[]} trackers
 * @property {Map<string, number>} launches refKey to its last launch, ms
 * @property {Set<string>} running refKeys of launches still running
 * @property {Map<string, IdleHold>} holds refKeys of the issues held
 * @property {number} now ms
 */

/**
 * @typedef {object} Idle
 * @property {number} number
 * @property {string} title
 * @property {number} idleMs
 * @property {boolean} urgent
 * @property {boolean} heldAtCap it is held at the limit-cap parks' cap
 * @property {boolean} heldOnLimit its launch waits on a limit
 * @property {string|null} skip its hold's or the loop's launch filter's reason,
 *   null where the filter passes the row
 */

/**
 * @typedef {object} TrackerFinding
 * @property {string} repo
 * @property {boolean} served
 * @property {string|null} error
 * @property {Idle[]} idle oldest first
 */

/**
 * One checkout's dispatch ledger, as the shell read it.
 * @typedef {object} LedgerReading
 * @property {string} root the checkout
 * @property {Map<number, number>} launchTimes issue to its last launch, ms
 * @property {number[][]} recent the issues of each launch still in the
 *   ledger's window, so running; none for a limit hold's row, whose session
 *   is stopped, and a stopped loop's left to the alarm (#3785)
 */

/**
 * @typedef {object} TrackerRead
 * @property {string} repo `owner/name`
 * @property {IssueReading[]} issues
 * @property {string|null} error
 * @property {LedgerReading[]} ledgers its checkouts' ledgers, as far as they
 *   read
 * @property {import("./parked.js").ParkMarkerRead[][]} markers each of its
 *   checkouts' park markers
 */

/**
 * The refill loop as read: nothing where it does not run.
 * @typedef {object} LoopReading
 * @property {string[]} served the checkouts its scope serves
 * @property {{root: string, issues: number[]}[]} launches its launches at work
 * @property {import("./refill-loop.js").Hold[]} held the issues it holds: parked
 *   rows on a full seat and launches waiting on a limit
 */

/**
 * A tracker's parked issues held at the limit-cap parks' cap, each to its hold:
 * the loop routes a row on the newest marker in the row's own checkout, so it is
 * held where that marker in any checkout is at the cap, from the latest such
 * start.
 * @param {TrackerRead} t
 * @returns {[string, IdleHold][]}
 */
const limitCapHoldsOf = ({ repo, issues, markers }) =>
	issues
		.filter((i) => i.labels.includes(PARKED_LABEL))
		.flatMap((i) => {
			const [hold] = markers
				.flatMap((inCheckout) => {
					const marker = newestMarkerListing(inCheckout, i.number);
					const why = limitCapHoldOf(marker?.limitParks);
					return marker && why !== null
						? [{ why, since: marker.writtenAt, atCap: true }]
						: [];
				})
				.sort((a, b) => b.since - a.since);
			return hold
				? [
						/** @type {[string, IdleHold]} */ ([
							refKey({ repo, number: i.number }),
							hold,
						]),
					]
				: [];
		});

/**
 * The readings findIdleEfforts judges, joined from checkout roots to the
 * trackers they file to.
 * @param {object} input
 * @param {Map<string, string[]>} input.rootsOf tracker to its checkouts
 * @param {TrackerRead[]} input.trackers
 * @param {LoopReading} input.loop
 * @param {number} input.now ms
 * @returns {Readings}
 */
function buildReadings({ rootsOf, trackers, loop, now }) {
	/** The trackers checkout `root` files to. @param {string} root */
	const reposOf = (root) =>
		[...rootsOf].filter(([, roots]) => roots.includes(root)).map(([r]) => r);
	/** @type {Map<string, number>} */
	const launches = new Map();
	/** @type {Set<string>} */
	const running = new Set();
	/** @param {string} root @param {number[]} issues */
	const markRunning = (root, issues) => {
		for (const repo of reposOf(root))
			for (const n of issues) running.add(refKey({ repo, number: n }));
	};
	for (const l of loop.launches) markRunning(l.root, l.issues);
	/* The marker's entries last, so a cap, which no reset ends, names a row over
	 * the loop's full-seat hold of it. */
	/** @type {Readings["holds"]} */
	const holds = new Map([
		...loop.held.flatMap(({ root, number, why, since, onLimit }) =>
			reposOf(root).map(
				(repo) =>
					/** @type {[string, IdleHold]} */ ([
						refKey({ repo, number }),
						{ why, since, onLimit },
					]),
			),
		),
		...trackers.flatMap(limitCapHoldsOf),
	]);
	for (const t of trackers)
		for (const { root, launchTimes, recent } of t.ledgers) {
			for (const [n, at] of launchTimes) {
				const key = refKey({ repo: t.repo, number: n });
				launches.set(key, Math.max(launches.get(key) ?? 0, at));
			}
			for (const issues of recent) markRunning(root, issues);
		}
	return {
		trackers: trackers.map(({ repo, issues, error }) => ({
			repo,
			served: (rootsOf.get(repo) ?? []).some((r) => loop.served.includes(r)),
			issues,
			error,
		})),
		launches,
		running,
		holds,
		now,
	};
}

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

/**
 * @param {IssueReading} i
 * @param {boolean} isHeld whether it is held
 */
const isExcluded = (i, isHeld) =>
	i.blocked ||
	i.gated ||
	i.labels.includes(HUMAN_LABEL) ||
	(i.labels.includes(PARKED_LABEL) && !isHeld);

/**
 * The open children of `key` this reading holds; a closed child, or one in a
 * tracker that would not read, is none.
 * @param {string} key
 * @param {Map<string, IssueReading>} open
 */
const openChildKeys = (key, open) =>
	(open.get(key)?.children ?? []).map(refKey).filter((k) => open.has(k));

/**
 * Whether `key` waits on something other than a launch; one the loop holds
 * waits on no child (#3838).
 * @param {string} key
 * @param {Map<string, IssueReading>} open
 * @param {Readings["holds"]} holds
 * @param {Set<string>} seen accumulator: the keys already walked
 * @returns {boolean}
 */
function isWaiting(key, open, holds, seen = new Set()) {
	const i = open.get(key);
	if (i === undefined || isExcluded(i, holds.has(key))) return true;
	if (seen.has(key)) return true;
	seen.add(key);
	const kids = openChildKeys(key, open);
	return (
		!holds.has(key) &&
		kids.length > 0 &&
		kids.every((k) => isWaiting(k, open, holds, seen))
	);
}

/**
 * The latest launch or hold's start of `key` or any descendant, Infinity where
 * one is running, else -Infinity. A hold counts so that a container is not named
 * over a child held under 2 days, parked holds included (#3838). A closed child
 * is read for its own only, its descendants unread.
 * @param {string} key
 * @param {Map<string, IssueReading>} open
 * @param {Readings} readings
 * @param {Set<string>} seen accumulator: the keys already walked
 * @returns {number}
 */
function lastActivityUnder(key, open, readings, seen = new Set()) {
	if (seen.has(key)) return Number.NEGATIVE_INFINITY;
	seen.add(key);
	if (readings.running.has(key)) return Number.POSITIVE_INFINITY;
	let last = Math.max(
		readings.launches.get(key) ?? Number.NEGATIVE_INFINITY,
		readings.holds.get(key)?.since ?? Number.NEGATIVE_INFINITY,
	);
	for (const child of open.get(key)?.children ?? [])
		last = Math.max(
			last,
			lastActivityUnder(refKey(child), open, readings, seen),
		);
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
		if (isWaiting(key, open, readings.holds)) continue;
		const ms =
			readings.now -
			Math.max(i.createdAt, lastActivityUnder(key, open, readings));
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
				heldAtCap: readings.holds.get(key)?.atCap === true,
				heldOnLimit: readings.holds.get(key)?.onLimit === true,
				skip:
					readings.holds.get(key)?.why ??
					buildSkipReason({
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
 * @typedef {object} IdleLine
 * @property {string} text
 * @property {boolean} nested beneath the tracker line before it
 */

/**
 * One line per tracker, beneath it each issue past the threshold held at the
 * limit-cap parks' cap or on a limit that the line does not already name as its
 * oldest, and
 * beneath a tracker the loop does not serve, each `urgent` one; first, where no
 * loop runs, a line saying so.
 * @param {TrackerFinding[]} findings
 * @param {boolean} loopRunning
 * @returns {IdleLine[]}
 */
function buildIdleLines(findings, loopRunning) {
	/** @param {string} text */
	const buildTopLine = (text) => ({ text, nested: false });
	/** @param {string} text */
	const buildNestedLine = (text) => ({ text, nested: true });
	const lines = findings.flatMap((f) => {
		const unserved = f.served ? "" : " (the refill loop does not serve it)";
		if (f.error !== null)
			return [buildTopLine(`${f.repo}: unread — ${f.error}`)];
		const [oldest] = f.idle;
		if (oldest === undefined)
			return [
				buildTopLine(`${f.repo}: none idle past ${IDLE_DAYS} days${unserved}`),
			];
		const skip = oldest.skip ?? "none, the launch filter passes it";
		return [
			buildTopLine(
				`${f.repo}: ${f.idle.length} idle past ${IDLE_DAYS} days${unserved}; oldest ${named(oldest)}; skip reason: ${skip}`,
			),
			...f.idle
				.filter((i) => (i.heldAtCap || i.heldOnLimit) && i !== oldest)
				.map((i) =>
					buildNestedLine(`held ${named(i)}; skip reason: ${i.skip}`),
				),
			...(f.served
				? []
				: f.idle
						.filter((i) => i.urgent)
						.map((i) => buildNestedLine(`urgent ${named(i)}`))),
		];
	});
	return loopRunning
		? lines
		: [
				buildTopLine(
					"The refill loop is not running, so it serves no tracker.",
				),
				...lines,
			];
}

/**
 * @typedef {object} FindingRecord
 * @property {"IDLE-EFFORTS"|"IDLE-EFFORTS-UNREAD"} code
 * @property {string} text
 * @property {{repo: string, idle: Idle[]}} [data]
 */

/**
 * One record per tracker holding a finding: an unread tracker, or one with
 * efforts idle past the threshold.
 * @param {TrackerFinding[]} findings
 * @returns {FindingRecord[]}
 */
const buildFindingRecords = (findings) =>
	findings.flatMap(
		/** @returns {FindingRecord[]} */
		(f) => {
			if (f.error !== null)
				return [
					{
						code: "IDLE-EFFORTS-UNREAD",
						text: `${f.repo} would not read: ${f.error}`,
					},
				];
			return f.idle.length === 0
				? []
				: [
						{
							code: "IDLE-EFFORTS",
							text: `${f.repo}: ${f.idle.length} effort(s) idle past ${IDLE_DAYS} days`,
							data: { repo: f.repo, idle: f.idle },
						},
					];
		},
	);

/**
 * @typedef {object} SeenStamp
 * @property {string} day machine-local `YYYY-MM-DD`
 * @property {string[]} seen
 */

/**
 * A finding is an idle issue, or a tracker that would not read.
 * @param {TrackerFinding} f
 */
const findingKeys = (f) =>
	f.error === null
		? f.idle.map((i) => refKey({ repo: f.repo, number: i.number }))
		: [`${f.repo.toLowerCase()} unread`];

/**
 * The findings a delivered stamp records for `day`.
 * @param {string|null} stamp
 * @param {string} day
 * @returns {Set<string>}
 */
function seenOn(stamp, day) {
	try {
		const { day: at, seen } = JSON.parse(stamp ?? "null") ?? {};
		return new Set(
			at === day && Array.isArray(seen)
				? seen.filter((k) => typeof k === "string")
				: [],
		);
	} catch {
		/* Damaged only repeats today's notice (#3644). */
		return new Set();
	}
}

/**
 * The trackers a session start names, once per finding per day: each holding
 * a finding the delivered stamp does not record for `day`, whole.
 * @param {TrackerFinding[]} findings
 * @param {string|null} stamp the last delivered signature
 * @param {string} day
 * @returns {{unseen: TrackerFinding[], signature: string|null}}
 */
function selectUnseen(findings, stamp, day) {
	const seen = seenOn(stamp, day);
	const unseen = findings.filter((f) =>
		findingKeys(f).some((k) => !seen.has(k)),
	);
	if (unseen.length === 0) return { unseen, signature: null };
	for (const k of unseen.flatMap(findingKeys)) seen.add(k);
	/** @type {SeenStamp} */
	const next = { day, seen: [...seen] };
	return { unseen, signature: JSON.stringify(next) };
}

/**
 * @typedef {object} IdleReport
 * @property {TrackerFinding[]} unseen the trackers this run names
 * @property {string[]} lines its text, nested lines indented; empty where it
 *   names none
 * @property {string|null} signature what records `unseen` as shown
 * @property {string|null} stampNow the signature to write now; null where this
 *   start holds the notice or has nothing new to record
 */

/**
 * What one run reports and records. A `notice` run, a session start's, names
 * only what its stamp does not record for its day; a plain run names all and
 * records nothing.
 * @param {TrackerFinding[]} findings
 * @param {boolean} loopRunning
 * @param {{stamp: string|null, day: string, held: boolean}|null} notice
 * @returns {IdleReport}
 */
function buildIdleReport(findings, loopRunning, notice) {
	const { unseen, signature } = notice
		? selectUnseen(findings, notice.stamp, notice.day)
		: { unseen: findings, signature: null };
	return {
		unseen,
		lines:
			unseen.length === 0
				? []
				: buildIdleLines(unseen, loopRunning).map(({ text, nested }) =>
						nested ? `  ${text}` : text,
					),
		signature,
		stampNow: notice?.held ? null : signature,
	};
}

module.exports = {
	IDLE_DAYS,
	QUERY,
	buildIdleLines,
	buildIdleReport,
	buildReadings,
	findIdleEfforts,
	buildFindingRecords,
	parseIssueNodes,
};
