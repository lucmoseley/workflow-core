/*
 * refill-loop.js — the refill loop's files and the pure readings around
 * lib/refill-decide.js (workflow-core#2012, spec workflow-core#1995).
 *
 * THREE FILES, ONE WRITER EACH, under lib/refill-dir.js's directory, so
 * `start` and `stop` never race the loop's own tick:
 *   - control, written by `start` and `stop`;
 *   - state, written by the loop;
 *   - pidfile, created by the loop exclusively, so a second loop exits.
 * `WFC_REFILL_DIR` moves all three, with the log, the stop-seen stamp
 * check-refill-loop-stop.js writes, and the code directory of worktrees the
 * loop runs from (lib/refill-code.js).
 */

const fs = require("node:fs");
const path = require("node:path");
const { isTerminalAgent } = require("./agent-liveness.js");
const { RESUME_CAP } = require("./block-act.js");
const { neverStartedJobs } = require("./hung-jobs.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { REVIEW_HOUR, localDate } = require("./morning-review.js");
const { refillPath } = require("./refill-dir.js");
const {
	FULL,
	UNREAD,
	actsRead,
	decideTick,
	fitsLaunch,
	hasRoom,
} = require("./refill-decide.js");
const {
	isHeld,
	isResuming,
	isSwapHeld,
	iso,
	launchName,
	markParked,
	nextResumeAt,
} = require("./refill-blocks.js");
const { checkoutEnv } = require("./refill-repos.js");
const { OUTCOME_PREFIX } = require("./usage-probe.js");

/* A finished session drops off the listing; one just launched may not be on
 * it yet, so a launch younger than this is never judged finished. Untraced. */
const LISTING_GRACE_MS = 2 * 60 * 1000;
/* Enough for the no-progress run and for `status`. Untraced. */
const HISTORY_KEPT = 50;
/* Untraced. */
const STATUS_LAUNCHES = 10;
/* The skipped rows an idle tick's log line names, and `status` lists.
 * Untraced. */
const LINE_SKIPS = 3;
const STATUS_SKIPS = 10;
/* dispatch-sessions.sh's WEEK_CEILING and SESSION_CEILING defaults, the
 * thresholds its cap sizes a launch past; its test pins the two copies
 * together. */
const DEFAULT_CEILINGS = { week: 97, session: 90 };

/**
 * @typedef {object} Control
 * @property {number} startedAt ms, the last `start` or renewal
 * @property {boolean} stopRequested
 * @property {string[]} seats config dirs, in failover order
 * @property {Scope} scope
 */

/**
 * Which repos the loop serves (workflow-core#2123). Normal mode, what `/pick-next` starts,
 * serves `repos`; away mode, started only on the founder's ask, serves every
 * included checkout bar `exclude`.
 * @typedef {object} Scope
 * @property {"normal"|"away"} mode
 * @property {string[]} repos checkout roots; normal mode only
 * @property {string[]} exclude checkout roots; away mode only
 * @property {Record<string, number[]>} goals keyed by checkout root
 */

/**
 * A loop launch, as lib/refill-decide.js reads it, plus what the loop needs
 * to judge it. `parked` is the last read listing's word on whether its
 * session waits on a question, and `block` why (lib/block-cause.js, workflow-core#2699).
 * `parkStopped` is when the loop stopped it for that park. `resumes` counts
 * the loop's resumes of it after an API error, kept across spells so the cap
 * is the session's (workflow-core#2705), with when the last was made; `attachAt`, a typed
 * resume not yet seen arrive; `heldAt`, when the loop stopped the session to
 * wait for the next. `idleResumes` counts its typed resumes of a
 * resumed-idle session (workflow-core#2659), cleared once the session takes a turn;
 * `idleSince`, the time of the harness restart row it last read resumed-idle
 * on (workflow-core#2978). `swapHeld`, set while the loop holds one it stopped under the
 * swap hold (workflow-core#3093). `handOffTries` counts the hand-offs of
 * one stopped still idle that failed, and
 * `handedOff` is when one went to a fresh launch. `relaunchedAt` is when a
 * stop and `--bg --resume` last restarted its job, from which it has the
 * listing's grace. Where a resume moved it to a copy (workflow-core#2963), `copiedFrom`
 * is the job its dispatch-ledger hold names; `pastSessionIds`, the sessions
 * it ran under before `sessionId`.
 * @typedef {import("./refill-decide.js").LaunchRecord & {
 *   prompt: string, seat: string, jobId: string|null,
 *   parked?: boolean, block?: import("./block-act.js").Block,
 *   parkStopped?: number, sessionId?: string,
 *   resumes?: import("./refill-blocks.js").Resumes,
 *   idleResumes?: import("./refill-blocks.js").IdleResumes, idleSince?: number,
 *   swapHeld?: import("./refill-blocks.js").SwapHeld,
 *   handOffTries?: number, handedOff?: number, copiedFrom?: string,
 *   relaunchedAt?: number, pastSessionIds?: string[]}} LoopLaunch
 */

/**
 * @typedef {object} LoopState
 * @property {LoopLaunch[]} launches
 * @property {{at: number, summary: string,
 *   skipped?: import("./refill-decide.js").Skip[]}|null} lastTick
 * @property {{at: number, reason: string, detail: string}|null} stopped
 * @property {string|null} reviewRunOn machine-local date of the last full
 *   morning review run
 */

/** @typedef {import("./refill-decide.js").SeatReading} SeatReading */
/** @typedef {import("./refill-decide.js").SizedSeat} SizedSeat */

function loopFiles() {
	return {
		control: refillPath(".refill-loop-control.json"),
		state: refillPath(".refill-loop-state.json"),
		pid: refillPath(".refill-loop.pid"),
		log: refillPath(".refill-loop.log"),
		stopSeen: refillPath(".refill-loop-stop-seen"),
		wake: refillPath(".refill-loop-wake"),
		gates: refillPath(".refill-gate-readings.json"),
		code: refillPath(".refill-loop-code"),
	};
}

/**
 * The parsed file, or null where it is absent or unparseable.
 * @param {string} file
 * @returns {unknown}
 */
function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/**
 * @param {string} file
 * @param {unknown} value
 */
function writeJson(file, value) {
	writeFileAtomic(file, `${JSON.stringify(value, null, "\t")}\n`, {
		mkdir: true,
	});
}

/** @param {unknown} raw @returns {raw is Record<string, any>} */
const isRecord = (raw) => typeof raw === "object" && raw !== null;

/** @param {unknown} raw */
const parseStrings = (raw) =>
	Array.isArray(raw) ? raw.filter((s) => typeof s === "string") : [];

/**
 * The control file's scope. A scope that does not say normal reads as away
 * mode, a loop over every included repo.
 * @param {unknown} raw
 * @returns {Scope}
 */
function parseScope(raw) {
	const r = isRecord(raw) ? raw : {};
	/** @type {Record<string, number[]>} */
	const goals = {};
	for (const [root, issues] of Object.entries(
		isRecord(r.goals) ? r.goals : {},
	)) {
		const kept = Array.isArray(issues) ? issues.filter(Number.isInteger) : [];
		if (kept.length > 0) goals[root] = kept;
	}
	return {
		mode: r.mode === "normal" ? "normal" : "away",
		repos: parseStrings(r.repos),
		exclude: parseStrings(r.exclude),
		goals,
	};
}

/**
 * The control file's fields, or null where it is not one.
 * @param {unknown} raw
 * @returns {Control|null}
 */
function parseControl(raw) {
	if (!isRecord(raw) || typeof raw.startedAt !== "number") return null;
	return {
		startedAt: raw.startedAt,
		stopRequested: raw.stopRequested === true,
		seats: parseStrings(raw.seats),
		scope: parseScope(raw.scope),
	};
}

/**
 * The scope a `start` writes, given the running loop's (null where none
 * runs) and the one asked for from `root`. A normal start adds its repos to
 * a running normal loop's; an away start widens whatever runs; a normal
 * start never narrows a running away mode, nor renews its 24 hours. In
 * every case the asked goal replaces `root`'s, a bare start clearing it
 * (workflow-core#2119, workflow-core#2123).
 * @param {Scope|null} running
 * @param {Scope} asked
 * @param {string} root
 * @returns {{scope: Scope, renew: boolean}}
 */
function mergedScope(running, asked, root) {
	if (running === null) return { scope: asked, renew: true };
	const goals = { ...running.goals };
	delete goals[root];
	Object.assign(goals, asked.goals);
	if (asked.mode === "away") return { scope: { ...asked, goals }, renew: true };
	if (running.mode === "away")
		return { scope: { ...running, goals }, renew: false };
	const repos = [...new Set([...running.repos, ...asked.repos])];
	return { scope: { ...asked, repos, goals }, renew: true };
}

/**
 * The roots a tick serves, and why each root in scope is not. `included` is
 * discovery's set, read for away mode only; `exclusionOf` re-reads a normal
 * root's config, so a repo that opts out mid-run is dropped.
 * @param {Scope} scope
 * @param {() => string[]} included
 * @param {(root: string) => string|null} exclusionOf
 */
function scopeRoots(scope, included, exclusionOf) {
	if (scope.mode === "away")
		return {
			roots: included().filter((r) => !scope.exclude.includes(r)),
			dropped: [],
		};
	/** @type {string[]} */
	const roots = [];
	/** @type {{root: string, why: string}[]} */
	const dropped = [];
	for (const root of scope.repos) {
		const why = exclusionOf(root);
		if (why === null) roots.push(root);
		else dropped.push({ root, why });
	}
	return { roots, dropped };
}

/**
 * @param {Control} control
 * @param {number} runMs
 */
const buildStopLine = (control, runMs) =>
	control.stopRequested
		? "stops:     at its next tick, on request"
		: `stops by:  ${iso(control.startedAt + runMs)}`;

/**
 * The lines naming what a loop serves, on which seats and until when.
 * @param {Control} control
 * @param {{runMs: number, served: string[], running: boolean}} opts
 *   `served`, scopeRoots's roots
 */
function buildScopeLines(control, { runMs, served, running }) {
	const { scope } = control;
	const names = (/** @type {string[]} */ roots) =>
		roots.map((r) => path.basename(r)).join(", ") || "none";
	const goals = Object.entries(scope.goals).map(
		([root, issues]) =>
			`${path.basename(root)} ${issues.map((n) => `#${n}`).join(", ")}`,
	);
	const away = scope.mode === "away";
	return [
		away ? "mode:      away (every included repo)" : "mode:      normal",
		`repos:     ${names(served)}`,
		...(away ? [`excluding: ${names(scope.exclude)}`] : []),
		`goal:      ${goals.join("; ") || "none"}`,
		...(running ? [buildStopLine(control, runMs)] : []),
		`seats:     ${control.seats.join(", ") || "none"}`,
	];
}

/** @param {unknown} raw @returns {LoopState["stopped"]} */
function parseStopped(raw) {
	if (
		!isRecord(raw) ||
		typeof raw.at !== "number" ||
		typeof raw.reason !== "string"
	)
		return null;
	return {
		at: raw.at,
		reason: raw.reason,
		detail: typeof raw.detail === "string" ? raw.detail : "",
	};
}

/** @param {unknown} raw */
const isSkip = (raw) =>
	isRecord(raw) &&
	typeof raw.root === "string" &&
	typeof raw.number === "number" &&
	typeof raw.why === "string";

/** @param {unknown} raw @returns {LoopState["lastTick"]} */
function parseLastTick(raw) {
	if (
		!isRecord(raw) ||
		typeof raw.at !== "number" ||
		typeof raw.summary !== "string"
	)
		return null;
	const skipped = Array.isArray(raw.skipped) ? raw.skipped.filter(isSkip) : [];
	return { at: raw.at, summary: raw.summary, skipped };
}

/** @param {unknown} raw @returns {LoopState} */
function parseState(raw) {
	const r = isRecord(raw) ? raw : {};
	return {
		launches: Array.isArray(r.launches) ? r.launches : [],
		lastTick: parseLastTick(r.lastTick),
		stopped: parseStopped(r.stopped),
		reviewRunOn: typeof r.reviewRunOn === "string" ? r.reviewRunOn : null,
	};
}

/**
 * Whether this tick runs the morning review generator in full: the first tick
 * at or after REVIEW_HOUR on a day it has not run (workflow-core#2017).
 * @param {Date} now
 * @param {string|null} lastRunOn
 */
const isReviewRunDue = (now, lastRunOn) =>
	now.getHours() >= REVIEW_HOUR && localDate(now) !== lastRunOn;

/**
 * The last full run's date after a tick's review run: today once a due run
 * filed (exit 0) or was refused (exit 2, which a retry would only repeat);
 * unchanged after a gh failure (1) or a timeout or kill (null).
 * @param {{due: boolean, status: number|null, lastRunOn: string|null,
 *   today: string}} run
 */
const reviewRunRecorded = ({ due, status, lastRunOn, today }) =>
	due && (status === 0 || status === 2) ? today : lastRunOn;

/** @param {LoopLaunch[]} launches */
const trimmed = (launches) => launches.slice(-HISTORY_KEPT);

/**
 * dispatch-sessions.sh's cap thresholds, from the variables it reads.
 * @param {Record<string, string | undefined>} env
 */
const ceilingsOf = (env) => ({
	week: Number(env.WFC_DISPATCH_WEEK_CEILING || DEFAULT_CEILINGS.week),
	session: Number(env.WFC_DISPATCH_SESSION_CEILING || DEFAULT_CEILINGS.session),
});

/**
 * A seat's reading from lib/allowance.js's bars. A bar is full where it reads
 * 100% fresh, or, unfresh, its cached percent is 100 and its cached reset is
 * still ahead: a locked seat's bars age without refreshing, and neither
 * reopens before its reset (workflow-core#2606). A passed or unparsed reset leaves it
 * unread.
 * @param {string} seat
 * @param {{session: import("./allowance.js").Bar,
 *   weekly_all: import("./allowance.js").Bar}} bars
 * @param {number} now
 * @returns {SeatReading}
 */
function seatReadingOf(seat, { session, weekly_all: week }, now) {
	/** @param {import("./allowance.js").Bar} b */
	const fresh = (b) => (b.trust === "fresh" ? b.percent : null);
	/** @param {import("./allowance.js").Bar} b */
	const full = (b) =>
		b.percent !== null &&
		b.percent >= FULL &&
		(b.trust === "fresh" || Date.parse(b.resetsAt ?? "") > now);
	const sessionFull = full(session);
	return {
		seat,
		week: fresh(week),
		session: fresh(session),
		weekFull: full(week),
		sessionFull,
		sessionResets: sessionFull ? session.resetsAt : null,
	};
}

/**
 * The stale seats to refresh: those ahead of the first fresh seat with room,
 * so failover keeps its order and a stale seat behind a full one is read
 * rather than waited on. A seat the cap sized 0 is passed as a full one is; a
 * seat with a full bar is passed unread, that bar reopening only at its reset.
 * @param {(SeatReading & {fits?: number|null})[]} readings in failover order
 */
function seatsToRefresh(readings) {
	/** @type {string[]} */
	const stale = [];
	for (const r of readings) {
		if (r.weekFull || r.sessionFull) continue;
		if (r.week === null || r.session === null) stale.push(r.seat);
		// Not fitsLaunch: an unsized seat with room ends the walk, the tick waiting on it.
		else if (hasRoom(r) && r.fits !== 0) break;
	}
	return stale;
}

/**
 * Each seat with the dispatcher's cap sized on it, in failover order, up to
 * the first seat with room that sizes above 0 (workflow-core#2432): the decision core
 * launches there, so the seats behind it are left unsized. With no slot free
 * nothing is sized.
 * @param {SeatReading[]} readings
 * @param {number} slots
 * @param {(seat: string, members: number) => number|null} sizeOf the cap's
 *   launch count for `members` on `seat`, null where it cannot be sized
 * @returns {SizedSeat[]}
 */
function sizedSeats(readings, slots, sizeOf) {
	let sized = false;
	return readings.map((r) => {
		if (sized || !hasRoom(r)) return { ...r, fits: null };
		const fits = slots > 0 ? sizeOf(r.seat, slots) : 0;
		sized = fitsLaunch({ ...r, fits });
		return { ...r, fits };
	});
}

/**
 * Each seat read and sized for a tick: the stale seats ahead of the first one
 * free to launch are refreshed by `/usage` first, then those behind a seat the
 * cap sizes 0, so the fall-through reaches them (workflow-core#2432). Each seat is probed
 * and sized at most once; with no slot free nothing is refreshed or sized.
 * @param {number} slots
 * @param {{
 *   read: (usage: Map<string, string>) => SeatReading[],
 *   probe: (seats: string[]) => {usage: Map<string, string>, probes: Probe[]},
 *   sizeOf: (seat: string, members: number, usageText: string) => number|null,
 * }} io `read` takes each refreshed seat's printed `/usage`
 * @returns {{seats: SizedSeat[], probes: Probe[]}}
 */
function readSizedSeats(slots, { read, probe, sizeOf }) {
	/** @type {Map<string, string>} */
	const usage = new Map();
	/** @type {Probe[]} */
	const probes = [];
	/* Keyed on the seat alone: `members` is always `slots`, and a sized seat
	 * reads fresh, so it is never refreshed later in the tick. */
	/** @type {Map<string, number|null>} */
	const fits = new Map();
	const sizeOnce = (/** @type {string} */ seat, /** @type {number} */ n) => {
		const known = fits.get(seat);
		if (known !== undefined) return known;
		const sized = sizeOf(seat, n, usage.get(seat) ?? "");
		fits.set(seat, sized);
		return sized;
	};
	let readings = read(usage);
	let stale = slots > 0 ? seatsToRefresh(readings) : [];
	for (;;) {
		if (stale.length > 0) {
			const printed = probe(stale);
			for (const [seat, text] of printed.usage) usage.set(seat, text);
			probes.push(...printed.probes);
			readings = read(usage);
		}
		const sized = sizedSeats(readings, slots, sizeOnce);
		stale =
			slots > 0 ? seatsToRefresh(sized).filter((seat) => !usage.has(seat)) : [];
		if (stale.length === 0) return { seats: sized, probes };
	}
}

/**
 * Each overflow seat's reading for the decision core, its budget read only
 * once every plan seat is weekly-full, the one state it launches in (workflow-core#2570).
 * A key is spent for its cycle where Anthropic refused it for credit, or
 * where its settled spend leaves under one launch's reservation, which no
 * running session's end reopens. A seat file that refuses reads as one
 * unread seat, so the tick waits on it rather than stopping the run (workflow-core#2611).
 * @param {import("./refill-seats.js").SeatList} list
 * @param {SeatReading[]} plan
 * @param {(seat: import("./refill-seats.js").OverflowSeat) =>
 *   import("./overflow-budget-core.js").Budget|{why: string}} budgetOf
 *   lib/overflow-budget.js's seatBudget
 * @returns {import("./refill-decide.js").OverflowReading[]}
 */
function overflowReadings(list, plan, budgetOf) {
	if (list.errors.length > 0)
		return [
			{
				seat: "the seat file",
				fits: null,
				spentUntil: null,
				why: `it refuses: ${list.errors.join("; ")}`,
			},
		];
	/* The decision core's own test too; repeated here so a tick a plan seat
	 * can serve settles no ledger. */
	const due = plan.every((s) => s.weekFull);
	/** @type {import("./refill-seats.js").OverflowSeat[]} */
	const seats = list.seats.flatMap((s) => (s.kind === "overflow" ? [s] : []));
	return seats.map((seat) => {
		const unread = { seat: seat.dir, fits: null, spentUntil: null };
		if (!due) return { ...unread, why: "a plan seat is not weekly-full" };
		const b = budgetOf(seat);
		if ("why" in b) return { ...unread, why: b.why };
		const spent = b.exhausted || b.grantUsd - b.settledUsd < b.qUsd;
		return {
			seat: seat.dir,
			fits: b.fit,
			spentUntil: spent ? localDate(new Date(b.nextCycleStart)) : null,
			why: null,
		};
	});
}

/**
 * The `admission.js` arguments the loop's free-slot count passes:
 * dispatch-sessions.sh's per-member re-read's, so a slot counted is one that
 * re-read admits (workflow-core#2500), with the allowance limb left to the cap; its test
 * pins them to the script's.
 */
const FREE_SLOT_ARGS = ["--json", "--launch", "--skip-allowance"];

/**
 * The `allowance.js` arguments dispatch-sessions.sh's cap call passes, for
 * `members` on `seat`; its test pins the flags to the script's.
 * @param {string} seat
 * @param {number} members
 * @param {{week: number, session: number}} ceilings
 */
const capArgs = (seat, members, ceilings) => [
	"--json",
	"--config-dir",
	seat,
	"--cap",
	String(members),
	"--session-threshold",
	String(ceilings.session),
	"--week-threshold",
	String(ceilings.week),
];

/**
 * The cap's launch count from `allowance.js --json --cap`'s output, or why
 * there is none: the dispatcher refuses on both. A launch that is the floor's
 * member alone reads 0 (workflow-core#2425): each tick would otherwise launch one more
 * past the headroom. `fault` marks a cap the call could not size, where the
 * seat's reading itself was trustworthy (workflow-core#2937).
 * @param {string} stdout
 * @returns {{fits: number} | {fits: null, why: string, fault: boolean}}
 */
function capFitsOf(stdout) {
	let payload;
	try {
		payload = JSON.parse(stdout);
	} catch {
		return { fits: null, why: "allowance.js printed no JSON", fault: true };
	}
	const cap = payload?.cap;
	if (!cap)
		return {
			fits: null,
			why: "no trustworthy allowance reading",
			fault: false,
		};
	if (cap.error) return { fits: null, why: String(cap.error), fault: true };
	if (!Number.isInteger(cap.launch))
		return { fits: null, why: `cap.launch is ${cap.launch}`, fault: true };
	return { fits: cap.floored === true ? 0 : cap.launch };
}

/* Untraced: the dispatcher call's one-off gates and a `claude --bg` that hangs
 * up to dispatch-sessions.sh's own launch ceiling. */
const DISPATCH_FIXED_MS = 10 * 60 * 1000;
/* Untraced: a member's 120 s launch ceiling, about 9 s of admission and the
 * 2 s stagger, rounded up (workflow-core#2196). */
const DISPATCH_MEMBER_MS = 150 * 1000;
/* The slack covers the clock read before the spawn. */
const LEDGER_SLACK_MS = 1000;

/**
 * A tick's launches as dispatcher calls: one per repo and seat, in the order
 * each first appears, its members in pick order (workflow-core#2196).
 * @param {import("./refill-decide.js").Launch[]} launches
 * @returns {import("./refill-decide.js").Launch[][]}
 */
function batchesOf(launches) {
	/** @type {Map<string, import("./refill-decide.js").Launch[]>} */
	const batches = new Map();
	for (const l of launches) {
		const key = JSON.stringify([l.root, l.seat]);
		batches.set(key, [...(batches.get(key) ?? []), l]);
	}
	return [...batches.values()];
}

/**
 * The dispatcher call for one batch: run with the target checkout as its
 * working directory and host root, so that repo's ledger, duplicate drop and
 * memory re-read apply, and on the batch's seat. The loop is no session, so
 * no session id rides along to be recorded as the launcher.
 * @param {import("./refill-decide.js").Launch[]} batch one of batchesOf's
 * @param {string} dispatcher path to dispatch-sessions.sh
 * @param {NodeJS.ProcessEnv} env the loop's own
 */
function dispatchCall(batch, dispatcher, env) {
	const [first] = batch;
	if (!first) throw new Error("dispatchCall: an empty batch");
	const { root, seat } = first;
	/** @type {NodeJS.ProcessEnv} */
	const childEnv = { ...checkoutEnv(root, env), CLAUDE_CONFIG_DIR: seat };
	delete childEnv.CLAUDE_CODE_SESSION_ID;
	return {
		file: "bash",
		args: [dispatcher, ...batch.flatMap((l) => [l.model, l.prompt])],
		cwd: root,
		env: childEnv,
		timeout: DISPATCH_FIXED_MS + DISPATCH_MEMBER_MS * batch.length,
	};
}

/**
 * The dry run's line for one dispatcher call; on an overflow seat it names the
 * headless launch the dispatcher makes there (workflow-core#2611).
 * @param {ReturnType<typeof dispatchCall>} call
 * @param {Set<string>} overflow the overflow seats' config dirs
 */
function buildWouldRunLine(call, overflow) {
	const seat = String(call.env.CLAUDE_CONFIG_DIR);
	const on = overflow.has(seat)
		? `overflow seat ${seat}, each member a headless \`claude -p\` (lib/headless-sessions.js)`
		: seat;
	return `would run in ${call.cwd} on ${on}: ${call.file} ${call.args.join(" ")}`;
}

/**
 * @typedef {{launch: import("./refill-decide.js").Launch, reason: string}} Refusal
 * @typedef {{launched: LoopLaunch[], refused: Refusal[]}} BatchOutcome
 */

/* The dispatcher's per-member lines refusalReasonOf keys on, which a test
 * pins to dispatch-sessions.sh's printf formats. */
const MEMBER_REFUSED = (/** @type {string} */ prompt) =>
	`REFUSED: ${prompt} — not launching this member.`;
const MEMBER_DROPPED = (/** @type {string} */ prompt) => `dropped: ${prompt}`;
/* A set-level refusal or cut: the duplicate gate's REFUSED or DROPPING
 * header, the allowance cap's CAPPED, the launch timeout's REFUSED. */
const SET_HEADER = /^\s*(REFUSED: |DROPPING |CAPPED: )/;

/**
 * Parse why the dispatcher launched nothing for `prompt` from its output: the
 * re-read's `slots` line under that member's REFUSED block, else the block's
 * first line; for a dropped member, the last set header above the drop; else
 * the call's last set-level refusal or its exit (workflow-core#2500).
 * @param {string} out the dispatcher's stdout and stderr
 * @param {string} prompt
 * @param {string|null} failed the call's failure, null on exit 0
 */
function parseRefusalReason(out, prompt, failed) {
	const lines = out.split("\n");
	const isSetHeader = (/** @type {string} */ l) =>
		SET_HEADER.test(l) && !l.endsWith("— not launching this member.");
	const at = lines.indexOf(MEMBER_REFUSED(prompt));
	if (at !== -1) {
		const end = lines.findIndex((l, i) => i > at && !l.startsWith("  "));
		const block = lines
			.slice(at + 1, end === -1 ? undefined : end)
			.map((l) => l.trim().replace(/\s+/g, " "))
			.filter(Boolean);
		return (
			block.find((l) => l.startsWith("slots ")) ??
			block[0] ??
			MEMBER_REFUSED(prompt)
		);
	}
	const dropped = lines.findIndex((l) => l.trim() === MEMBER_DROPPED(prompt));
	if (dropped !== -1)
		return (
			lines.slice(0, dropped).findLast(isSetHeader)?.trim() ??
			MEMBER_DROPPED(prompt)
		);
	if (failed)
		return lines.findLast(isSetHeader)?.trim() ?? `dispatcher ${failed}`;
	return "no ledger entry written for it";
}

/**
 * Launch one batch through the dispatcher: the record of each member it
 * launched, stamped with its own ledger entry's time, each it refused with
 * parseRefusalReason's reason, and the members it tried. The ledger is read after
 * every exit: a non-zero one can follow earlier members' launches, and exit 0
 * covers a dropped member too, so only an entry written for a member's prompt
 * since the call proves its launch.
 * After a non-zero exit only the launched members count as tried, as the
 * rest may never have been reached and the next tick retries them.
 * A headless launch's session id is fixed at launch, so its record carries it
 * from the start (workflow-core#2611): a run ending before any listing shows it still has
 * its acts read.
 * @param {import("./refill-decide.js").Launch[]} batch one of batchesOf's
 * @param {{dispatcher: string, env: NodeJS.ProcessEnv,
 *   run: (call: ReturnType<typeof dispatchCall>) => {failed: string|null, out: string},
 *   entriesOf: (root: string) => import("./dispatch-ledger.js").DispatchRecord[],
 *   sessionOf: (jobId: string) => string|undefined}} io `sessionOf` is
 *   lib/headless-sessions.js's record of the job, undefined for any other
 * @returns {BatchOutcome & {tried: import("./refill-decide.js").Launch[],
 *   failed: string|null, out: string}}
 */
function launchBatch(batch, io) {
	const call = dispatchCall(batch, io.dispatcher, io.env);
	const calledAt = Date.now();
	const r = io.run(call);
	const entries = io
		.entriesOf(call.cwd)
		.filter((e) => Date.parse(e.ts) >= calledAt - LEDGER_SLACK_MS);
	/** @type {LoopLaunch[]} */
	const launched = [];
	/** @type {import("./refill-decide.js").Launch[]} */
	const reached = [];
	/** @type {Refusal[]} */
	const refused = [];
	for (const l of batch) {
		const entry = entries.filter((e) => e.prompt === l.prompt).pop();
		if (!entry) {
			refused.push({
				launch: l,
				reason: parseRefusalReason(r.out, l.prompt, r.failed),
			});
			continue;
		}
		reached.push(l);
		const sessionId =
			entry.jobId === null ? undefined : io.sessionOf(entry.jobId);
		launched.push({
			root: l.root,
			issues: l.issues,
			prompt: l.prompt,
			seat: l.seat,
			jobId: entry.jobId,
			launchedAt: Date.parse(entry.ts),
			finishedAt: null,
			...(l.gate ? { gate: l.gate } : {}),
			...(sessionId === undefined ? {} : { sessionId }),
		});
	}
	return { launched, refused, tried: r.failed ? reached : batch, ...r };
}

/**
 * The launches whose session has left the listing or ended, and are not
 * judged yet. Nothing is judged off an unread listing, and a launch with no
 * job id is never judged: nothing ties it to a listed session. The listing
 * must span every seat the loop launches on (scripts/refill-loop.js's
 * SEATS).
 * @param {LoopLaunch[]} launches
 * @param {import("./agent-liveness.js").AgentRecord[]|null} agents
 * @param {number} now
 */
function newlyFinished(launches, agents, now) {
	if (!agents) return [];
	const live = new Set(
		agents.filter((a) => a.id && !isTerminalAgent(a)).map((a) => a.id),
	);
	return launches.filter(
		(l) =>
			l.finishedAt === null &&
			l.jobId !== null &&
			now - Math.max(l.launchedAt, l.relaunchedAt ?? 0) >= LISTING_GRACE_MS &&
			!live.has(l.jobId) &&
			!isHeld(l),
	);
}

/**
 * The launches with `sessionId` taken from the listing for each that has none
 * yet and whose job it shows (workflow-core#2311), for the wake on a session's end and
 * actsOf. Off an unread listing, or for a job it does not show, a launch is
 * returned as it was.
 * @param {LoopLaunch[]} launches
 * @param {import("./agent-liveness.js").AgentRecord[]|null} agents
 */
function withSessionIds(launches, agents) {
	if (!agents) return launches;
	const sessions = new Map(
		agents.flatMap((a) => (a.id && a.sessionId ? [[a.id, a.sessionId]] : [])),
	);
	return launches.map((l) => {
		const sessionId = l.jobId === null ? undefined : sessions.get(l.jobId);
		return l.sessionId === undefined && sessionId !== undefined
			? { ...l, sessionId }
			: l;
	});
}

/**
 * The launches after one listing: each the listing first shows given its
 * session id, then each newly finished one marked with `progressOf`'s fields,
 * then each still listed marked parked or not (markParked). The id comes first, so a
 * launch whose first listing already shows it ended is judged with it.
 * @template {object} P
 * @param {LoopLaunch[]} launches
 * @param {import("./agent-liveness.js").AgentRecord[]|null} agents
 * @param {number} now
 * @param {{progressOf: (l: LoopLaunch) => P,
 *   causeOf: import("./refill-blocks.js").CauseOf}} read
 * @returns {LoopLaunch[]}
 */
function judgedLaunches(launches, agents, now, { progressOf, causeOf }) {
	const listed = withSessionIds(launches, agents);
	const done = new Set(newlyFinished(listed, agents, now));
	const judged = listed.map((l) =>
		done.has(l) ? { ...l, ...progressOf(l), finishedAt: now } : l,
	);
	return markParked(judged, agents, causeOf, now);
}

/**
 * A finished launch's progress: the acts of its session and each it ran
 * under before a resume moved it to a copy (workflow-core#2969), across `roots`' stores,
 * counted per kind (workflow-core#2312). UNREAD where its session id was never captured,
 * its past sessions' acts then unsummed, or where no act read and some store
 * would not, which is not "did nothing".
 * The reader is passed in so this module stays free of store reads.
 * @param {LoopLaunch} l
 * @param {string[]} roots
 * @param {(sessionId: string, roots: string[]) =>
 *   {acts: string[], unreadable: string[]}} readActsBy lib/arbiter-ledger.js's
 * @returns {{acts: Record<string, number>|typeof UNREAD}}
 */
function actsOf(l, roots, readActsBy) {
	if (!l.sessionId) return { acts: UNREAD };
	const ids = new Set([...(l.pastSessionIds ?? []), l.sessionId]);
	const reads = [...ids].map((id) => readActsBy(id, roots));
	const acts = reads.flatMap((r) => r.acts);
	if (acts.length === 0 && reads.some((r) => r.unreadable.length > 0))
		return { acts: UNREAD };
	/** @type {Record<string, number>} */
	const counts = {};
	for (const act of acts) {
		const kind = act.replace(/ .*/s, "");
		counts[kind] = (counts[kind] ?? 0) + 1;
	}
	return { acts: counts };
}

/**
 * The loop log's line for a finished launch.
 * @param {LoopLaunch} l
 */
function buildFinishLine(l) {
	const read = actsRead(l);
	const acts = read
		? Object.entries(read)
				.map(([kind, n]) => `${kind} ${n}`)
				.join(", ") || "no acts"
		: UNREAD;
	return `finished ${launchName(l)}: ${acts}`;
}

/**
 * The loop's unfinished launches, for the decision core's `running`, whose one
 * use is not relaunching their issues. Parked ones stay in it (workflow-core#2118): their
 * session still holds the issue, and no count of these sizes a slot, which
 * admission's memory reading alone does.
 * @param {LoopLaunch[]} launches
 */
const runningOf = (launches) =>
	launches
		.filter((l) => l.finishedAt === null && l.jobId !== null)
		.map((l) => ({ root: l.root, issues: l.issues }));

/**
 * Whether `start` renewed the loop after a tick read `startedAt`, so a stop
 * that tick decided is stale.
 * @param {Control|null} control
 * @param {number} startedAt
 */
const isRenewedSince = (control, startedAt) =>
	control !== null && !control.stopRequested && control.startedAt > startedAt;

/**
 * Whether a control read mid-tick asks the loop to stop. A control gone
 * missing does, as at the tick's start.
 * @param {Control|null} control
 */
const isStopRequested = (control) => control?.stopRequested !== false;

/**
 * What the dispatches did, dispatching each batch in turn after re-reading the
 * control, and none once it asks for a stop (workflow-core#2126): one dispatch can hold
 * the tick for minutes. Residual: a dispatch already running still launches
 * every member.
 * @param {import("./refill-decide.js").Launch[][]} batches
 * @param {() => Control|null} readControl
 * @param {(batch: import("./refill-decide.js").Launch[]) => BatchOutcome} launch
 * @returns {Outcome}
 */
function launchUntilStopped(batches, readControl, launch) {
	/** @type {Outcome} */
	const outcome = { launched: [], refused: [], unreached: [] };
	for (const [i, batch] of batches.entries()) {
		if (isStopRequested(readControl())) {
			outcome.unreached = batches.slice(i).flat();
			break;
		}
		const r = launch(batch);
		outcome.launched.push(...r.launched);
		outcome.refused.push(...r.refused);
	}
	return outcome;
}

/**
 * @param {{root: string, prompt: string}[]} launches
 */
const buildLaunchesLine = (launches) => launches.map(launchName).join("; ");

/**
 * One line naming a decision.
 * @param {import("./refill-decide.js").Decision} d
 */
function summaryOf(d) {
	if ("stop" in d) return `stop: ${d.stop} — ${d.detail}`;
	if (d.launches.length > 0) return `launch ${buildLaunchesLine(d.launches)}`;
	return `idle: ${d.idle}`;
}

/**
 * A probed seat's outcome: the outcome line scripts/usage-probe.js writes on
 * stderr, else how its run failed.
 * @param {string} stderr
 * @param {string|null} failed runChild's failure, null on exit 0
 */
function parseProbeOutcome(stderr, failed) {
	const line = stderr.split("\n").find((l) => l.startsWith(OUTCOME_PREFIX));
	return line
		? line.slice(OUTCOME_PREFIX.length).trim()
		: `no outcome line, ${failed ?? "exit 0"}`;
}

/** @typedef {{seat: string, outcome: string}} Probe */

/**
 * A tick's frontier read: the merged rows and how long the read took.
 * @typedef {{rows: number, ms: number}} FrontierRead
 */

/** @param {FrontierRead} read */
const buildFrontierReadText = (read) =>
	`frontier: ${read.rows} rows in ${(read.ms / 1000).toFixed(1)} s`;

/** @param {import("./refill-decide.js").Skip} s */
const buildSkipText = (s) => `${path.basename(s.root)} #${s.number} ${s.why}`;

/**
 * An idle tick's account of the frontier it read (workflow-core#2561).
 * @param {Extract<import("./refill-decide.js").Decision, {idle: unknown}>} d
 * @param {FrontierRead|null} read
 */
function frontierNotes(d, read) {
	if (read === null) return [];
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const s of d.skipped) counts.set(s.why, (counts.get(s.why) ?? 0) + 1);
	return [
		buildFrontierReadText(read),
		...(counts.size > 0
			? [
					`skipped ${[...counts].map(([why, n]) => `${n} ${why}`).join(", ")}`,
					`first ${d.skipped.slice(0, LINE_SKIPS).map(buildSkipText).join(", ")}`,
				]
			: []),
	];
}

/**
 * What a tick's dispatches did: the members launched, each refused with its
 * reason, and those a stop left undispatched.
 * @typedef {BatchOutcome & {unreached: import("./refill-decide.js").Launch[]}} Outcome
 */

/**
 * A launching tick's line: what launched, and each member the dispatcher
 * refused as refused, with its reason (workflow-core#2500).
 * @param {Outcome} o
 */
const buildOutcomeLine = (o) =>
	[
		...(o.launched.length > 0
			? [`launch ${buildLaunchesLine(o.launched)}`]
			: []),
		...o.refused.map(
			(r) => `refused ${buildLaunchesLine([r.launch])}: ${r.reason}`,
		),
		...(o.unreached.length > 0
			? [
					`not dispatched ${buildLaunchesLine(o.unreached)}: a stop landed first`,
				]
			: []),
	].join("; ");

/**
 * The decision's log line, an idle one naming admission's free slots and its
 * frontier, a launching one its dispatches' outcome and its frontier read's
 * time, which sizes the shortlist cap (workflow-core#2677), and a tick that probed
 * naming each seat's outcome, so the log alone tells a stale-reading wait
 * that had a slot from one that had none (workflow-core#2362).
 * @param {import("./refill-decide.js").Decision} d
 * @param {Outcome} outcome
 * @param {{freeSlots: number, probes: Probe[], read: FrontierRead|null}} seen
 */
function buildTickLine(d, outcome, { freeSlots, probes, read }) {
	if ("stop" in d) return summaryOf(d);
	const head = d.launches.length > 0 ? buildOutcomeLine(outcome) : summaryOf(d);
	const notes = [
		...(d.launches.length === 0
			? [`free slots: ${freeSlots}`, ...frontierNotes(d, read)]
			: []),
		...(d.launches.length > 0 && read ? [buildFrontierReadText(read)] : []),
		...(probes.length > 0
			? [`probed ${probes.map((p) => `${p.seat}: ${p.outcome}`).join(", ")}`]
			: []),
	];
	return `${head}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
}

/**
 * The state's stop record for a stop decision, else null.
 * @param {import("./refill-decide.js").Decision} d
 * @param {number} at
 */
const stoppedOf = (d, at) =>
	"stop" in d ? { at, reason: d.stop, detail: d.detail } : null;

/**
 * A tick from its decision on: dispatch its launches while the control asks
 * for no stop, write the state before the morning review runs, so the
 * review's minutes cannot lose this tick's launches to a kill, then run it.
 * A stop that landed during the dispatches or the review is logged and
 * recorded as `stop: explicit`, so the loop ends at this tick's end, which
 * `stop` promises (workflow-core#2126).
 * @param {{input: import("./refill-decide.js").TickInput,
 *   decision: import("./refill-decide.js").Decision, state: LoopState,
 *   judged: LoopLaunch[], probes: Probe[], read: FrontierRead|null}} tick
 * @param {{readControl: () => Control|null,
 *   launchBatch: (batch: import("./refill-decide.js").Launch[]) => BatchOutcome,
 *   runReview: (lastRunOn: string|null, now: number) => string|null,
 *   writeState: (state: LoopState) => void,
 *   log: (line: string) => void}} io
 * @returns {import("./refill-decide.js").Decision} the late stop where one
 *   landed, else the tick's decision
 */
function settleTick({ input, decision, state, judged, probes, read }, io) {
	const outcome = launchUntilStopped(
		"stop" in decision ? [] : batchesOf(decision.launches),
		io.readControl,
		io.launchBatch,
	);
	const summary = buildTickLine(decision, outcome, {
		freeSlots: input.freeSlots,
		probes,
		read,
	});
	io.log(summary);
	const next = {
		launches: trimmed([...judged, ...outcome.launched]),
		lastTick: {
			at: input.now,
			summary,
			...("stop" in decision ? {} : { skipped: decision.skipped }),
		},
		stopped: stoppedOf(decision, input.now) ?? state.stopped,
		reviewRunOn: state.reviewRunOn,
	};
	io.writeState(next);
	const reviewRunOn = io.runReview(state.reviewRunOn, input.now);
	const late =
		"stop" in decision || !isStopRequested(io.readControl())
			? null
			: decideTick({ ...input, stopRequested: true });
	if (late) io.log(summaryOf(late));
	if (late || reviewRunOn !== state.reviewRunOn)
		io.writeState({
			...next,
			stopped: (late && stoppedOf(late, Date.now())) ?? next.stopped,
			reviewRunOn,
		});
	return late ?? decision;
}

/**
 * Where a launch stands, for `status`.
 * @typedef {"park-stopped"|"handed-off"|"hand-off-owed"|"finished"
 *   |"resuming"|"swap-held"|"resumed-idle"|"parked"|"running"} LaunchKind
 * @param {LoopLaunch} l
 * @returns {LaunchKind}
 */
function launchKindOf(l) {
	if (l.parkStopped !== undefined) return "park-stopped";
	if (l.handedOff !== undefined) return "handed-off";
	if (l.handOffTries !== undefined) return "hand-off-owed";
	if (l.finishedAt !== null) return "finished";
	if (isResuming(l)) return "resuming";
	if (isSwapHeld(l)) return "swap-held";
	if (l.idleSince !== undefined) return "resumed-idle";
	return l.parked ? "parked" : "running";
}

/** The kinds `status` lists past its launch window: each waits on the
 * founder or on the loop's resumes or hand-off. */
const UNSETTLED = new Set([
	"park-stopped",
	"hand-off-owed",
	"resuming",
	"swap-held",
	"resumed-idle",
	"parked",
]);

/** @param {LoopLaunch} l */
function launchStateOf(l) {
	switch (launchKindOf(l)) {
		case "park-stopped":
			return "parked, stopped";
		case "handed-off":
			return "handed off: stopped idle after its host's restart";
		case "hand-off-owed":
			return `stopped idle after its host's restart, its hand-off failed ${l.handOffTries} times`;
		case "finished":
			return "finished";
		case "resuming": {
			const blocked =
				/** @type {LoopLaunch & {block: import("./block-act.js").Block}} */ (l);
			const next =
				l.resumes?.attachAt === undefined
					? `next at ${iso(nextResumeAt(blocked))}`
					: "its typed resume being checked";
			return `resuming after an API error, ${l.resumes?.tries ?? 0} of ${RESUME_CAP} tries, ${next}`;
		}
		case "swap-held":
			return `stopped under the swap hold since ${iso(/** @type {number} */ (l.swapHeld?.at))}, resumed once it clears`;
		case "resumed-idle": {
			const r = l.idleResumes;
			return `resumed-idle since ${iso(/** @type {number} */ (l.idleSince))}, ${r ? `resumed ${r.tries} times, last at ${iso(r.triedAt)}` : "not yet resumed"}`;
		}
		case "parked":
			return "parked";
		default:
			return "running";
	}
}

/**
 * The lines a recorded start gives `status`: launches since it, and any still
 * running from before a renewal.
 * @param {Control} control
 * @param {LoopState} state
 * @param {{runMs: number, served: string[], running: boolean}} opts
 */
function buildControlLines(control, state, opts) {
	const lines = [`started:   ${iso(control.startedAt)}`];
	lines.push(...buildScopeLines(control, opts));
	const since = state.launches.filter(
		(l) => l.launchedAt >= control.startedAt,
	).length;
	const shown = state.launches.filter(
		(l) => l.launchedAt >= control.startedAt || l.finishedAt === null,
	);
	const kinds = shown.map(launchKindOf);
	const running = kinds.filter(
		(k) => k === "running" || k === "resumed-idle",
	).length;
	const parked = kinds.filter(
		(k) => k === "park-stopped" || k === "parked",
	).length;
	lines.push(
		`launches:  ${since} since start, ${running} running, ${parked} parked`,
	);
	const listed = shown.filter(
		(l, i) =>
			i >= shown.length - STATUS_LAUNCHES || UNSETTLED.has(launchKindOf(l)),
	);
	for (const l of listed) {
		const at = launchStateOf(l);
		const session = l.sessionId ? `  session ${l.sessionId}` : "";
		lines.push(
			`  ${iso(l.launchedAt)}  ${path.basename(l.root)}  ${l.prompt}  ${at}${session}`,
		);
	}
	return lines;
}

/**
 * The last tick's line, then the rows it skipped (workflow-core#2561).
 * @param {NonNullable<LoopState["lastTick"]>} t
 */
function buildLastTickLines(t) {
	const skipped = t.skipped ?? [];
	return [
		`last tick: ${iso(t.at)}  ${t.summary}`,
		...skipped
			.slice(0, STATUS_SKIPS)
			.map((s) => `  skipped ${buildSkipText(s)}`),
		...(skipped.length > STATUS_SKIPS
			? [`  … and ${skipped.length - STATUS_SKIPS} more skipped`]
			: []),
	];
}

/**
 * @param {{control: Control|null, state: LoopState, pid: number|null,
 *   runMs: number, served: string[], codeSha?: string|null}} input `served`,
 *   scopeRoots's roots; `codeSha`, lib/refill-code.js's readRunningCode
 * @returns {string[]}
 */
function buildStatusLines({
	control,
	state,
	pid,
	runMs,
	served,
	codeSha = null,
}) {
	return [
		pid === null
			? "refill loop: not running"
			: `refill loop: running, pid ${pid}`,
		...(pid !== null && codeSha ? [`code:      ${codeSha}`] : []),
		...(control
			? buildControlLines(control, state, {
					runMs,
					served,
					running: pid !== null,
				})
			: ["never started on this machine"]),
		...(state.lastTick ? buildLastTickLines(state.lastTick) : []),
		...(state.stopped
			? [
					`last stop: ${iso(state.stopped.at)}  ${state.stopped.reason} — ${state.stopped.detail}`,
				]
			: []),
	];
}

/**
 * Stop each job that never started (lib/hung-jobs.js's neverStartedJobs,
 * workflow-core#2467) through `stop(job)`, a `claude stop <short id>` on its seat that
 * answers null or why it failed; the log line for each. Its live processes
 * are lib/registry-agents.js's, which needs no CLI (workflow-core#2665). Off a registry
 * seat that would not read, or no job store, it stops nothing and says why;
 * a job on a seat with no registry at all is left unjudged.
 * @param {import("./registry-agents.js").RegistryListing} registry
 * @param {Parameters<typeof neverStartedJobs>[0]|null} jobs
 * @param {(job: ReturnType<typeof neverStartedJobs>[number]) => string|null} stop
 */
function stopNeverStarted(registry, jobs, stop) {
	/** @param {string} why */
	const skipped = (why) => [`never-started jobs unjudged: ${why}`];
	if (registry.faults.length > 0) return skipped(registry.faults.join("; "));
	if (!jobs) return skipped("no job store would open");
	const live = new Set(registry.agents.map((a) => a.sessionId));
	return neverStartedJobs(jobs, { live, seats: registry.seats }).map((j) => {
		const failed = stop(j);
		const age = j.age === null ? "an unreadable age" : `${Math.floor(j.age)}m`;
		return `${failed ? "could not stop" : "stopped"} never-started job ${j.job} on ${j.seat} (${j.intent ?? "no intent"}; ${age}, no pid, no transcript)${failed ? `: ${failed}` : ""}`;
	});
}

module.exports = {
	FREE_SLOT_ARGS,
	MEMBER_DROPPED,
	MEMBER_REFUSED,
	actsOf,
	batchesOf,
	capArgs,
	capFitsOf,
	ceilingsOf,
	parseControl,
	dispatchCall,
	buildFinishLine,
	isRenewedSince,
	judgedLaunches,
	launchBatch,
	buildLaunchesLine,
	loopFiles,
	mergedScope,
	readJson,
	buildFrontierReadText,
	buildSkipText,
	isReviewRunDue,
	reviewRunRecorded,
	runningOf,
	buildScopeLines,
	parseScope,
	scopeRoots,
	parseProbeOutcome,
	overflowReadings,
	seatReadingOf,
	seatsToRefresh,
	settleTick,
	readSizedSeats,
	sizedSeats,
	parseState,
	buildStatusLines,
	stopNeverStarted,
	summaryOf,
	buildWouldRunLine,
	writeJson,
};
