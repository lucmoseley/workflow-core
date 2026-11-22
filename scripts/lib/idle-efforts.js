const {
	buildLimitCapHoldWhy,
	buildLoopWait,
	buildPausedWaitText,
	buildSkipReason,
} = require("./refill-decide.js");
const { buildProbeHeldRoots, PROBE_HELD } = require("./launch-room.js");
const { PARKED_LABEL, newestMarkerListing } = require("./parked.js");
const { takesLabel, takesOf } = require("./takes-label.js");
const { refKey } = require("./issue-ref.js");
const { isGateHolding } = require("./issue-gate.js");
const { scriptPath } = require("./script-path.js");
const { URGENT_LABEL } = require("./urgent-label.js");

const DAY_MS = 24 * 60 * 60 * 1000;
// guess, #3588
const IDLE_DAYS = 2;
const IDLE_MS = IDLE_DAYS * DAY_MS;
const HUMAN_LABEL = takesLabel("human");
const QUERY =
	"query($owner: String!, $name: String!, $endCursor: String) { repository(owner: $owner, name: $name) { issues(states: OPEN, first: 50, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { number title createdAt body labels(first: 100) { nodes { name } } blockedBy(first: 25) { totalCount nodes { state } } subIssues(first: 100) { nodes { number state repository { nameWithOwner } } } } } } }";

/** @typedef {any} GhJson */

/** @typedef {{repo: string, number: number}} Ref */

/**
 * @typedef {object} IssueReading
 * @property {number} number
 * @property {string} title
 * @property {number} createdAt
 * @property {string[]} labels
 * @property {boolean} blocked
 * @property {boolean} gated
 * @property {Ref[]} children
 */

/**
 * @typedef {object} TrackerReading
 * @property {string} repo
 * @property {boolean} served
 * @property {boolean} probeHeld
 * @property {boolean} holdsUnread
 * @property {string|null} loopWait
 * @property {IssueReading[]} issues
 * @property {string|null} error
 */

/**
 * @typedef {{why: string, since: number, atCap?: boolean, onLimit?: boolean}} IdleHold
 */

/**
 * @typedef {object} Readings
 * @property {TrackerReading[]} trackers
 * @property {Map<string, number>} launches
 * @property {Set<string>} running
 * @property {Map<string, IdleHold>} holds
 * @property {number} now
 */

/**
 * @typedef {object} Idle
 * @property {number} number
 * @property {string} title
 * @property {number} idleMs
 * @property {boolean} urgent
 * @property {boolean} heldAtCap
 * @property {boolean} heldOnLimit
 * @property {string|null} skip
 */

/**
 * @typedef {object} TrackerFinding
 * @property {string} repo
 * @property {boolean} served
 * @property {boolean} holdsUnread
 * @property {string|null} loopWait
 * @property {string|null} error
 * @property {Idle[]} idle
 */

/**
 * @typedef {object} LedgerReading
 * @property {string} root
 * @property {Map<number, number>} launchTimes
 * @property {number[][]} recent
 */

/**
 * @typedef {object} TrackerRead
 * @property {string} repo
 * @property {IssueReading[]} issues
 * @property {string|null} error
 * @property {LedgerReading[]} ledgers
 * @property {import("./parked.js").ParkMarkerRead[][]} markers
 */

/**
 * @typedef {object} LoopReading
 * @property {string[]} served
 * @property {{root: string, issues: number[]}[]} launches
 * @property {import("./refill-state.js").Hold[]} held
 * @property {import("./refill-decide.js").TickHold[]} repoHolds
 * @property {string|null} loopWait
 * @property {Record<string, import("./refill-decide.js").Pause>} repoPaused
 * @property {string[]} holdsUnreadRoots
 */

/**
 * @param {import("./refill-decide.js").Pause|null|undefined} paused
 * @param {import("./refill-decide.js").Idle|null|undefined} lastIdle
 * @returns {string|null}
 */
const buildLiveLoopWait = (paused, lastIdle) =>
	paused ? buildPausedWaitText(paused) : buildLoopWait(lastIdle ?? null);

/**
 * @param {string[]} served
 * @param {LoopReading} loop
 * @returns {string|null}
 */
function buildTrackerWait(served, loop) {
	const [first] = served;
	if (first === undefined) return null;
	const pause = loop.repoPaused[first];
	return pause && served.every((r) => loop.repoPaused[r])
		? buildPausedWaitText(pause)
		: loop.loopWait;
}

/**
 * @param {{noProgressFrom: number}|null} control
 * @param {{from: number}|null|undefined} launchCount
 * @returns {number|null}
 */
const stoppedRunOf = (control, launchCount) =>
	control?.noProgressFrom ?? launchCount?.from ?? null;

/**
 * @param {TrackerRead} t
 * @returns {[string, IdleHold][]}
 */
const buildLimitCapHolds = ({ repo, issues, markers }) =>
	issues
		.filter((i) => i.labels.includes(PARKED_LABEL))
		.flatMap((i) => {
			const [hold] = markers
				.flatMap((inCheckout) => {
					const marker = newestMarkerListing(inCheckout, i.number);
					const why = buildLimitCapHoldWhy(marker?.limitParks);
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
 * @param {object} input
 * @param {Map<string, string[]>} input.rootsOf
 * @param {TrackerRead[]} input.trackers
 * @param {LoopReading} input.loop
 * @param {number} input.now
 * @returns {Readings}
 */
function buildReadings({ rootsOf, trackers, loop, now }) {
	/** @param {string} root */
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
		...trackers.flatMap(buildLimitCapHolds),
	]);
	for (const t of trackers)
		for (const { root, launchTimes, recent } of t.ledgers) {
			for (const [n, at] of launchTimes) {
				const key = refKey({ repo: t.repo, number: n });
				launches.set(key, Math.max(launches.get(key) ?? 0, at));
			}
			for (const issues of recent) markRunning(root, issues);
		}
	const probeHeldRoots = buildProbeHeldRoots(loop.repoHolds);
	return {
		trackers: trackers.map(({ repo, issues, error }) => {
			const served = (rootsOf.get(repo) ?? []).filter((r) =>
				loop.served.includes(r),
			);
			return {
				repo,
				served: served.length > 0,
				probeHeld:
					served.length > 0 && served.every((r) => probeHeldRoots.has(r)),
				holdsUnread:
					served.length > 0 &&
					served.every((r) => loop.holdsUnreadRoots.includes(r)),
				loopWait: buildTrackerWait(served, loop),
				issues,
				error,
			};
		}),
		launches,
		running,
		holds,
		now,
	};
}

/** @param {GhJson} conn */
const isBlocked = (conn) =>
	(conn?.totalCount ?? 0) > (conn?.nodes ?? []).length ||
	(conn?.nodes ?? []).some((/** @type {GhJson} */ b) => b?.state === "OPEN");

/**
 * @param {GhJson[]} pages
 * @param {number} now
 * @returns {IssueReading[]}
 */
function parseIssueNodes(pages, now) {
	return pages.flatMap((p) => {
		const issues = p?.data?.repository?.issues?.nodes;
		if (!Array.isArray(issues))
			throw new Error("gh's GraphQL answer named no issues");
		return issues.map((/** @type {GhJson} */ i) => {
			return {
				number: i.number,
				title: i.title ?? "",
				createdAt: Date.parse(i.createdAt),
				labels: (i.labels?.nodes ?? []).map(
					(/** @type {GhJson} */ l) => l.name,
				),
				blocked: isBlocked(i.blockedBy),
				gated: isGateHolding(i.body ?? "", now),
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
 * @param {boolean} isHeld
 */
const isExcluded = (i, isHeld) =>
	i.blocked ||
	i.gated ||
	i.labels.includes(HUMAN_LABEL) ||
	(i.labels.includes(PARKED_LABEL) && !isHeld);

/**
 * @param {string} key
 * @param {Map<string, IssueReading>} open
 */
const openChildKeys = (key, open) =>
	(open.get(key)?.children ?? []).map(refKey).filter((k) => open.has(k));

/**
 * @param {string} key
 * @param {Map<string, IssueReading>} open
 * @param {Readings["holds"]} holds
 * @param {Set<string>} seen
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
 * @param {string} key
 * @param {Map<string, IssueReading>} open
 * @param {Readings} readings
 * @param {Set<string>} seen
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
 * @param {string} key
 * @param {Map<string, IssueReading>} open
 * @param {Set<string>} idle
 * @param {Set<string>} seen
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
 * @param {TrackerReading} t
 * @param {IssueReading} i
 * @param {IdleHold} [hold]
 * @returns {string|null}
 */
function buildRowSkip(t, i, hold) {
	if (hold?.atCap || hold?.onLimit) return hold.why;
	if (t.probeHeld)
		return t.loopWait
			? `${PROBE_HELD}; and the loop launches nothing: ${t.loopWait}`
			: PROBE_HELD;
	return (
		hold?.why ?? buildSkipReason({ labels: i.labels, takes: takesOf(i.labels) })
	);
}

/**
 * @param {Readings} readings
 * @returns {TrackerFinding[]}
 */
function findIdleEfforts(readings) {
	/** @type {Map<string, IssueReading>} */
	const open = new Map();
	for (const t of readings.trackers)
		for (const i of t.issues) open.set(refKey({ repo: t.repo, ...i }), i);
	/** @type {Map<string, number>} */
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
		holdsUnread: t.holdsUnread,
		loopWait: t.loopWait,
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
				skip: buildRowSkip(t, i, readings.holds.get(key)),
			}))
			.sort((a, b) => b.idleMs - a.idleMs),
	}));
}

/** @param {number} ms */
const days = (ms) => `${(ms / DAY_MS).toFixed(1)} days`;

/** @param {Idle} i */
const named = (i) => `#${i.number} (${i.title}), idle ${days(i.idleMs)}`;

const LOOP_STOPPED_TEXT = `The refill loop is not running, so it serves no tracker. node ${scriptPath("refill-loop.js")} start restarts it.`;

/** @param {string} damage */
const buildDamagedText = (damage) => `Refill loop file damaged: ${damage}`;

/** @param {TrackerFinding} f */
function buildFilterPassedText(f) {
	const passed = "none, the launch filter passes it";
	if (!f.served) return passed;
	if (f.loopWait)
		return `${passed}, but the loop launches nothing: ${f.loopWait}`;
	return f.holdsUnread
		? `${passed}; a hold store would not read, and the loop reads that as no hold`
		: `${passed}, so it waits on rank`;
}

/**
 * @typedef {object} IdleLine
 * @property {string} text
 * @property {boolean} nested
 */

/**
 * @param {TrackerFinding[]} findings
 * @param {boolean} omitStopLine
 * @param {string[]} damaged
 * @returns {IdleLine[]}
 */
function buildIdleLines(findings, omitStopLine, damaged) {
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
		const skip = oldest.skip ?? buildFilterPassedText(f);
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
	return [
		...damaged.map((d) => buildTopLine(buildDamagedText(d))),
		...(omitStopLine ? [] : [buildTopLine(LOOP_STOPPED_TEXT)]),
		...lines,
	];
}

/**
 * @typedef {object} FindingRecord
 * @property {"IDLE-EFFORTS"|"IDLE-EFFORTS-UNREAD"|"REFILL-LOOP-NOT-RUNNING"|"REFILL-LOOP-FILE-DAMAGED"} code
 * @property {string} text
 * @property {{repo: string, loopWait: string|null, idle: Idle[]}} [data]
 */

/**
 * @param {TrackerFinding[]} findings
 * @param {boolean} stopUnseen
 * @param {string[]} damaged
 * @returns {FindingRecord[]}
 */
const buildFindingRecords = (findings, stopUnseen, damaged) => [
	...damaged.map(
		/** @returns {FindingRecord} */
		(d) => ({ code: "REFILL-LOOP-FILE-DAMAGED", text: buildDamagedText(d) }),
	),
	.../** @type {FindingRecord[]} */ (
		stopUnseen
			? [{ code: "REFILL-LOOP-NOT-RUNNING", text: LOOP_STOPPED_TEXT }]
			: []
	),
	...findings.flatMap(
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
							data: { repo: f.repo, loopWait: f.loopWait, idle: f.idle },
						},
					];
		},
	),
];

/**
 * @typedef {object} SeenStamp
 * @property {string} day
 * @property {string[]} seen
 */

/** @param {TrackerFinding} f */
const findingKeys = (f) =>
	f.error === null
		? f.idle.map((i) => refKey({ repo: f.repo, number: i.number }))
		: [`${f.repo.toLowerCase()} unread`];

/** @param {string} damage */
const buildDamagedKey = (damage) => `damaged ${damage}`;

/**
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
		return new Set();
	}
}

/**
 * @param {TrackerFinding[]} findings
 * @param {boolean} loopRunning
 * @param {string[]} damaged
 * @param {IdleNotice} notice
 * @returns {{unseen: TrackerFinding[], stopUnseen: boolean, damagedUnseen: string[], signature: string|null}}
 */
function selectUnseen(
	findings,
	loopRunning,
	damaged,
	{ stamp, day, stoppedRun },
) {
	const seen = seenOn(stamp, day);
	const unseen = findings.filter((f) =>
		findingKeys(f).some((k) => !seen.has(k)),
	);
	const stopKey = `refill-loop stopped ${stoppedRun}`;
	const stopUnseen = !loopRunning && !seen.has(stopKey);
	const damagedUnseen = damaged.filter((d) => !seen.has(buildDamagedKey(d)));
	if (unseen.length === 0 && !stopUnseen && damagedUnseen.length === 0)
		return { unseen, stopUnseen, damagedUnseen, signature: null };
	for (const k of unseen.flatMap(findingKeys)) seen.add(k);
	if (stopUnseen) seen.add(stopKey);
	for (const d of damagedUnseen) seen.add(buildDamagedKey(d));
	/** @type {SeenStamp} */
	const next = { day, seen: [...seen] };
	return { unseen, stopUnseen, damagedUnseen, signature: JSON.stringify(next) };
}

/**
 * @typedef {object} IdleNotice
 * @property {string|null} stamp
 * @property {string} day
 * @property {boolean} held
 * @property {number|null} stoppedRun
 */

/**
 * @typedef {object} IdleReport
 * @property {TrackerFinding[]} unseen
 * @property {boolean} stopUnseen
 * @property {string[]} damagedUnseen
 * @property {string[]} lines
 * @property {string|null} signature
 * @property {string|null} stampNow
 */

/**
 * @param {TrackerFinding[]} findings
 * @param {boolean} loopRunning
 * @param {string[]} damaged
 * @param {IdleNotice|null} notice
 * @returns {IdleReport}
 */
function buildIdleReport(findings, loopRunning, damaged, notice) {
	const { unseen, stopUnseen, damagedUnseen, signature } = notice
		? selectUnseen(findings, loopRunning, damaged, notice)
		: {
				unseen: findings,
				stopUnseen: !loopRunning,
				damagedUnseen: damaged,
				signature: null,
			};
	return {
		unseen,
		stopUnseen,
		damagedUnseen,
		lines: buildIdleLines(unseen, !stopUnseen, damagedUnseen).map(
			({ text, nested }) => (nested ? `  ${text}` : text),
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
	buildLiveLoopWait,
	buildReadings,
	findIdleEfforts,
	buildFindingRecords,
	parseIssueNodes,
	stoppedRunOf,
};
