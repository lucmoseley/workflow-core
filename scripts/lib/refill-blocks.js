/*
 * refill-blocks.js — the refill loop's blocked and resumed-idle launches
 * (#2848, spec #2695): their block and resume records, the act
 * lib/block-act.js's table returns for each, and each act done through the
 * I/O the program passes in (BlockIo).
 */

const path = require("node:path");
const { isTerminalAgent } = require("./agent-liveness.js");
const { swapHoldText } = require("./admission.js");
const {
	IDLE_TRIES,
	RESUME_CAP,
	blockAct,
	buildLimitParkWhy,
	nextTryAt,
	resumeDueAt,
} = require("./block-act.js");
const { API_PROMPT, IDLE_PROMPT, LIMIT_PROMPT } = require("./loop-prompts.js");
const { pickMoveSeat } = require("./refill-decide.js");

/* #2359's "within one tick": a typed line reaches the timeline at once
 * (#2354 F8), so a minute is ample; untraced. */
const ATTACH_VERDICT_MS = 60 * 1000;
const ATTACH_ROUTE = "typing into the live session";
const FALLBACK_ROUTE = "stop and --bg --resume";
/* Half the dispatch ledger's hour, so a hold never lapses between ticks;
 * untraced. */
const LEDGER_RENEW_MS = 30 * 60 * 1000;
/* The hand-offs of a stopped resumed-idle session tried before the loop gives
 * up on posting it and finishes the launch; untraced. */
const HAND_OFF_TRIES = 3;
/* The resumes of a session stopped under the swap hold that fail before the
 * loop hands it off instead: untraced (#3093). */
const SWAP_RESUME_TRIES = 3;
/* The listed state of a session parked on a question
 * (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-state-status-skew.md §F1). */
const PARKED_STATE = "blocked";

/**
 * @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch
 * @typedef {LoopLaunch & {jobId: string}} JobLaunch
 * @typedef {JobLaunch & {block: import("./block-act.js").Block}} BlockedLaunch
 * @typedef {import("./block-act.js").Act} Act
 * @typedef {import("./agent-liveness.js").AgentRecord} AgentRecord
 * @typedef {{tries: number, triedAt: number, nextAt: number,
 *   attachAt?: number, heldAt?: number}} Resumes  a launch's resumes after an
 *   API error, kept across spells so the cap is the session's (#2705)
 * @typedef {{tries: number, triedAt: number}} IdleResumes  its typed
 *   resumes while resumed-idle (#2659), cleared once it takes a turn
 * @typedef {{at: number, sessionId: string, cwd: string, tries: number}}
 *   SwapHeld  a resumed-idle session the loop stopped under the swap hold
 *   (#3093): when, the session and directory its resume runs in, read before
 *   the stop, and the resumes since tried that failed
 * @typedef {{bar: "weekly"|"5-hour"|null, resets: string|null}} LimitRead  the
 *   limit a seat's reading shows a session stopped on, null where neither bar
 *   read, with its reset as read; from the reading, never the limit's text
 * @typedef {{at: number, sessionId: string, cwd: string, limit: LimitRead,
 *   resumedAt?: number, ledgerAt?: number, failedTries?: number}}
 *   LimitHeld  a limit-blocked session the loop stopped (#3735): when, the
 *   session and directory its resume runs in, read before the stop, and its
 *   limit, read then, as a reset seat no longer shows it; `resumedAt`, a
 *   resume not yet judged; `ledgerAt`, when its ledger hold was last written;
 *   `failedTries`, its failed resumes this hold, which park it at the cap
 * @typedef {{tries: number, triedAt: number, nextAt: number, failed?: string,
 *   takenAt?: number, dryResumes?: number}}
 *   LimitResumes  its resumes in place, kept for the launch's life, each
 *   spacing the next; `failed`, why the last one failed; `takenAt`, when the
 *   last one took, until judged at its next limit block (judgeTakenResume);
 *   `dryResumes`, those in a row that took and bought no reply, which park it
 *   at the cap (#3792)
 * @typedef {(l: LoopLaunch, row: AgentRecord) =>
 *   import("./block-cause.js").Reading} CauseOf
 * @typedef {{sessionId: string|null, cwd: string}} ResumeTarget  a job's
 *   full session id, null unread, and the directory its resume runs in
 * @typedef {{agents: AgentRecord[]|null, now: number, io: BlockIo,
 *   swapHold: import("./admission.js").SwapHold}} Tick  a tick's listing,
 *   null unread; its clock; the program's I/O; the swap hold (#2690) as read
 *   this tick
 * @typedef {Tick & {typedSeat: string|null, slots: number,
 *   readMoveSeats: () => import("./refill-decide.js").SizedSeat[],
 *   seatListRead: boolean}} LimitTick  `seatListRead`, whether the seats read
 *   are the loop's own list, not a damaged or empty control's stand-in
 *   a tick read further for its limit-blocked launches: the plan seats sized
 *   for one session each, and admission's free slots
 * @typedef {{failed: string}|{failed: null, jobId: string,
 *   sessionId: string|null, copy: boolean}} Resumed  a `--bg --resume`: why
 *   it failed, else the job it runs on as, its full session id, null unread,
 *   and whether that job is a copy (#2963) rather than the one woken in place
 */

/**
 * The program's I/O for the acts on blocked and resumed-idle launches. Each
 * returns why it failed, or null once done, unless said otherwise.
 * @typedef {object} BlockIo
 * @property {(seat: string, jobId: string) =>
 *   import("./claude-stop.js").StopOutcome} stop  `claude stop` on a seat's
 *   job (lib/claude-stop.js's stopOn)
 * @property {(l: JobLaunch, prompt: string) => string|null} type  type
 *   `prompt` into the live session
 * @property {(l: JobLaunch) => ResumeTarget} resumeTargetOf  read before
 *   its stop, which may rewrite the job record
 * @property {(l: JobLaunch, prompt: string, target: ResumeTarget &
 *   {sessionId: string}) => Resumed} resumeStopped  `claude --bg
 *   --resume` of the stopped job
 * @property {(l: JobLaunch) => {state?: unknown, detail?: unknown}|null}
 *   jobStateOf  its job's state.json, null unread
 * @property {(l: LoopLaunch) => boolean} renewLedgerHold  its dispatch-ledger
 *   hold written again; whether it was
 * @property {(l: JobLaunch) => unknown[]|null} readTimeline  its job's
 *   timeline rows, null unread
 * @property {(l: JobLaunch) => import("./block-cause.js").IdleReading}
 *   idleSince  lib/block-cause.js's resumedIdleSince on its records
 * @property {(l: JobLaunch, at: number) => boolean} hasTurnedSince
 *   lib/block-cause.js's hasTurnedSince on its transcript, false unread
 * @property {(l: JobLaunch, at: number) => boolean|null} hasRepliedSince
 *   lib/block-cause.js's hasRepliedSince on its transcript, null unread
 * @property {(l: LoopLaunch) => {n: number, why: string}[]} labelParked
 *   each of its issues the `parked` label would not go on, with why
 * @property {(l: LoopLaunch, sessionId: string, numbers: number[]) =>
 *   string|null} recordParked  add `numbers` to the session's `.parked-`
 *   marker in its checkout (lib/parked.js); null, else why not, which may
 *   carry a stack
 * @property {(l: LoopLaunch, body: string) => void} comment  on each of its
 *   issues, a failure logged
 * @property {(l: JobLaunch) => {failed: string|null, out: string}}
 *   postHandOff  `rescue-sessions.js hand-off` of the stopped session
 * @property {(l: JobLaunch) => boolean} release  its dispatch-ledger hold;
 *   whether it went
 * @property {(l: LoopLaunch) => object} progressOf  a finishing launch's
 *   progress fields, logged
 * @property {(line: string) => void} log
 */

/** @param {number} ms */
const iso = (ms) => new Date(ms).toISOString();

/** @param {{root: string, prompt: string}} l */
const launchName = (l) => `${path.basename(l.root)} ${l.prompt}`;

/** @param {string} text */
const indented = (text) => text.replace(/\n/g, "\n  ");

/**
 * A child run's log line: its label, its failure or `exit 0`, then its output
 * indented under it.
 * @param {string} label
 * @param {{out: string, failed?: string|null}} ran
 */
const buildChildLine = (label, ran) =>
	`${label}: ${ran.failed ?? "exit 0"}\n  ${indented(ran.out)}`;

/**
 * Whether `l` is unfinished and tied to a job. A launch with no job id is never
 * judged, so it never finishes and is not live.
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch}
 */
const isLive = (l) => l.finishedAt === null && l.jobId !== null;

/**
 * Whether the loop may act on `l`'s session: live and not stopped already for
 * a park.
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch}
 */
const isActionable = (l) => isLive(l) && l.parkStopped === undefined;

/**
 * Whether `l` waits on the loop's resumes after a transient API stop.
 * @param {LoopLaunch} l
 */
const isResuming = (l) =>
	l.block?.cause === "API_ERROR" &&
	l.block.sub === "transient" &&
	l.parkStopped === undefined;

/**
 * Whether the loop stopped `l`'s resumed-idle session under the swap hold
 * (#3093).
 * @param {LoopLaunch} l
 * @returns {l is LoopLaunch & {swapHeld: SwapHeld}}
 */
const isSwapHeld = (l) => l.swapHeld !== undefined;

/**
 * Whether the loop stopped `l`'s session on its seat's limit (#3735).
 * @param {LoopLaunch} l
 * @returns {l is LoopLaunch & {limitHeld: LimitHeld}}
 */
const isLimitHeld = (l) => l.limitHeld !== undefined;

/**
 * Whether `l` was resumed from its limit hold and not yet judged.
 * @param {LoopLaunch} l
 * @returns {l is LoopLaunch & {limitHeld: LimitHeld}}
 */
const isResumeUnjudged = (l) =>
	isLimitHeld(l) && l.limitHeld.resumedAt !== undefined;

/**
 * Whether `l` waits on its seat's limit, its session live or held.
 * @param {LoopLaunch} l
 * @returns {l is JobLaunch & {block: import("./block-act.js").Block}}
 */
const isLimitBlocked = (l) => isActionable(l) && l.block?.cause === "LIMIT";

/**
 * Whether the loop stopped `l`'s session to wait for its next resume, for
 * the swap hold to clear (#3093) or for a seat with room (#3735): the launch
 * stays unfinished until a resume takes, it parks or it is handed off.
 * @param {LoopLaunch} l
 */
const isHeld = (l) =>
	(isResuming(l) && l.resumes?.heldAt !== undefined) ||
	isSwapHeld(l) ||
	isLimitHeld(l);

/**
 * `l`'s block with its resume record, as lib/block-act.js reads it.
 * @param {LoopLaunch & {block: import("./block-act.js").Block}} l
 * @returns {import("./block-act.js").Block}
 */
const blockOf = (l) => ({
	...l.block,
	tries: l.resumes?.tries ?? 0,
	nextAt: l.resumes?.nextAt,
	triedAt: l.resumes?.triedAt,
	held: l.resumes?.heldAt !== undefined,
	typing: l.resumes?.attachAt !== undefined,
});

/**
 * When the loop's next resume of a launch it resumes after an API error is
 * due.
 * @param {LoopLaunch & {block: import("./block-act.js").Block}} l
 */
const nextResumeAt = (l) => resumeDueAt(blockOf(l));

/**
 * The launches with `parked` read off the listing, and each parked one's
 * `block`: its cause this tick, and since when it has been parked, kept across
 * a change of cause. A parked
 * session is neither finished nor working: it waits in its own thread for the
 * founder's answer (#1995 stories 52, 55). It is the glossary's Parked as the
 * listing sees it, before or without the `parked` label, which the Stop hook
 * adds only on a house-decision round. Off an unread listing, for an
 * unlisted launch, for one whose row carries no `state`, or for a held one
 * (isHeld) whose session has ended, each keeps what the last read said; one held under the swap hold whose session
 * the listing shows live again is no longer held (#3093).
 * @param {LoopLaunch[]} launches
 * @param {AgentRecord[]|null} agents
 * @param {CauseOf} causeOf
 * @param {number} now
 */
function markParked(launches, agents, causeOf, now) {
	if (!agents) return launches;
	const rows = new Map(agents.flatMap((a) => (a.id ? [[a.id, a]] : [])));
	return launches.map((l) => {
		const row = l.jobId === null ? undefined : rows.get(l.jobId);
		if (l.finishedAt !== null || !row) return l;
		if (isHeld(l) && isTerminalAgent(row)) return l;
		/* causeOf reads a row carrying no `state` UNKNOWN, and logs why
		 * (#3200). */
		if (row.state == null) {
			causeOf(l, row);
			return l;
		}
		const { block: _, swapHeld: __, limitHeld: ___, ...rest } = l;
		if (row.state !== PARKED_STATE) return { ...rest, parked: false };
		const reading = causeOf(l, row);
		return {
			...rest,
			parked: true,
			block: {
				cause: reading.cause,
				...("sub" in reading ? { sub: reading.sub } : {}),
				since: l.block?.since ?? now,
			},
		};
	});
}

/**
 * The job ids the listing shows blocked.
 * @param {AgentRecord[]} agents
 */
const blockedIdsOf = (agents) =>
	new Set(agents.filter((a) => a.state === PARKED_STATE).map((a) => a.id));

/**
 * The launches the table acts on this tick, each with its act: those the
 * listing shows blocked, and the held ones (isHeld) whatever it shows, bar
 * the limit-blocked, whose act waits on the seats (actOnLimits). None off an
 * unread listing, which cannot tell a live session from a stopped one.
 * @param {LoopLaunch[]} launches markParked's, off `seen`'s listing
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 * @returns {{l: BlockedLaunch, act: Act}[]}
 */
function blockedActs(launches, mode, { agents, now }) {
	if (!agents) return [];
	const blocked = blockedIdsOf(agents);
	return launches.flatMap((l) => {
		if (
			!isActionable(l) ||
			!l.block ||
			isLimitBlocked(l) ||
			!(blocked.has(l.jobId) || isHeld(l))
		)
			return [];
		const b = { ...l, block: l.block };
		return [{ l: b, act: blockAct(blockOf(b), mode, now) }];
	});
}

/**
 * A resume record after a try made at `now`, `typed` where it went into the
 * live session, so the next tick checks it arrived.
 * @param {{tries: number}|undefined} was
 * @param {number} now
 * @param {boolean} typed
 */
const nextTry = (was, now, typed) => ({
	tries: (was?.tries ?? 0) + 1,
	triedAt: now,
	...(typed ? { attachAt: now } : {}),
});

/**
 * `l` after a resume made at `now`: one more try, the next due on the
 * schedule; `attachAt` where it was typed into the live session; `heldAt`
 * kept where it failed, its session being stopped still.
 * @template {LoopLaunch} L
 * @param {L} l
 * @param {number} now
 * @param {{typed: boolean, failed: boolean}} how
 * @returns {L}
 */
function afterResume(l, now, { typed, failed }) {
	const { attachAt, ...tried } = nextTry(l.resumes, now, typed);
	return {
		...l,
		resumes: {
			...tried,
			nextAt: nextTryAt(tried.tries, now),
			...(attachAt === undefined ? {} : { attachAt }),
			...(failed ? { heldAt: l.resumes?.heldAt ?? now } : {}),
		},
	};
}

/**
 * `l` after a typed resume of its resumed-idle session at `now`.
 * @template {LoopLaunch} L
 * @param {L} l
 * @param {number} now
 * @returns {L}
 */
const afterIdleResume = (l, now) => ({
	...l,
	idleResumes: { tries: (l.idleResumes?.tries ?? 0) + 1, triedAt: now },
});

/**
 * Whether a resume typed at `attachAt` arrived (#2354 F8): the timeline has a
 * row after it whose detail is the typed prompt, or the start of it, a long
 * detail being cut short.
 * @param {number} attachAt ms
 * @param {string} prompt
 * @param {unknown[]|null} timeline  the job's timeline rows, null unread
 */
function isResumeArrived(attachAt, prompt, timeline) {
	return (timeline ?? []).some((r) => {
		const row = /** @type {{at?: unknown, detail?: unknown}} */ (r);
		const detail =
			typeof row.detail === "string" ? row.detail.replace(/…$/, "") : "";
		return (
			typeof row.at === "string" &&
			Date.parse(row.at) > attachAt &&
			detail.length > 0 &&
			prompt.startsWith(detail)
		);
	});
}

/**
 * `l` with its resumed-idle episode ended.
 * @template {LoopLaunch} L
 * @param {L} l
 */
function endedIdle(l) {
	const { idleResumes: _, idleSince: __, ...rest } = l;
	return rest;
}

/**
 * `l`'s resumed-idle reading off its job store and transcript: "turned"
 * where it took a turn after the loop's last typed resume (#2978), "ended"
 * where its job no longer reads idle, "unread" where its records will not
 * read, else when it went idle.
 * @param {JobLaunch} l
 * @param {BlockIo} io
 * @returns {"turned"|"ended"|"unread"|number}
 */
function idleReading(l, io) {
	const at = l.idleResumes?.triedAt;
	if (at !== undefined && io.hasTurnedSince(l, at)) return "turned";
	return io.idleSince(l) ?? "ended";
}

/**
 * The resumed-idle launches (#2659) and the RESUMED_IDLE row's act on each:
 * every actionable launch the loop does not resume after an API error nor
 * hold stopped under the swap hold, whose
 * job `idleSince` reads resumed-idle off the job store and transcript alone,
 * never the listing. Each launch read resumed-idle is returned with its
 * `idleSince` set, kept from the first such reading; one read taking a turn
 * again, an `api-request` or assistant row after the loop's last typed
 * resume included (#2978), with that and its `idleResumes` cleared; one
 * whose records will not read, unchanged (#2847).
 * @param {LoopLaunch[]} launches
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 * @returns {{launches: LoopLaunch[], acts: {l: BlockedLaunch, act: Act}[]}}
 */
function idleActs(launches, mode, { now, io, swapHold }) {
	/** @type {{l: BlockedLaunch, act: Act}[]} */
	const acts = [];
	const read = launches.map((l) => {
		if (
			!isActionable(l) ||
			isResuming(l) ||
			l.handOffTries !== undefined ||
			isSwapHeld(l) ||
			isLimitHeld(l)
		)
			return l;
		const since = idleReading(l, io);
		if (since === "unread") return l;
		if (typeof since === "string") return endedIdle(l);
		const idle = { ...l, idleSince: l.idleSince ?? since };
		/* From the loop's own typed resume where later, so each gets its
		 * window. */
		/** @type {import("./block-act.js").Block} */
		const block = {
			cause: "RESUMED_IDLE",
			since: Math.max(since, l.idleResumes?.triedAt ?? 0),
			tries: l.idleResumes?.tries ?? 0,
			swapHeld: swapHold.held,
		};
		acts.push({ l: { ...idle, block }, act: blockAct(block, mode, now) });
		return idle;
	});
	return { launches: read, acts };
}

/**
 * The loop log's line for a resume after an API error, or one that could not
 * be made.
 * @param {LoopLaunch} l  afterResume's
 * @param {string} route  how it went in
 * @param {string|null} failed
 */
function buildResumeLine(l, route, failed) {
	const what = `resume ${l.resumes?.tries ?? 0} of ${RESUME_CAP} after an API error, ${launchName(l)}, by ${route}`;
	if (failed) return `could not ${what}: ${failed}`;
	return l.resumes ? `${what}; next due ${iso(l.resumes.nextAt)}` : what;
}

/**
 * The loop log's line for a typed resume of a resumed-idle session, or one
 * that could not be made.
 * @param {LoopLaunch} l  afterIdleResume's
 * @param {string|null} failed
 */
const buildIdleResumeLine = (l, failed) =>
	`${failed ? "could not resume" : "resumed"} ${launchName(l)}, idle since its host's restart, by ${ATTACH_ROUTE}, try ${l.idleResumes?.tries ?? 0} of ${IDLE_TRIES}${failed ? `: ${failed}` : ""}`;

/**
 * The loop log's line for a park it stopped, or could not; `brief`, the
 * issue comment's, each reason cut to its first line, never a stack (#3670).
 * @param {BlockedLaunch & {act?: Act, whyEnded?: string}} l  `whyEnded`, why a
 *   held session's wait ended
 * @param {"away"|"normal"} mode
 * @param {{failed: string|null, unlabelled: {n: number, why: string}[],
 *   unmarkedWhy?: string|null}} outcome  `unmarkedWhy`, why the labelled issues are
 *   not in the session's marker
 * @param {{brief?: boolean}} [opts]
 */
function buildParkStopLine(
	l,
	mode,
	{ failed, unlabelled, unmarkedWhy = null },
	{ brief = false } = {},
) {
	const reason = (/** @type {string} */ why) =>
		brief ? why.split(/\r?\n/)[0] : why;
	const tried = l.resumes ? `, ${l.resumes.tries} resumes` : "";
	const morning = l.act === "park-at-morning" ? ", at the morning cut-off" : "";
	const ended = l.whyEnded ? `, ${l.whyEnded}` : "";
	const what = `${l.block.cause} park ${launchName(l)} (${mode} mode, blocked since ${iso(l.block.since)}${tried}${morning}${ended})`;
	if (failed) return `could not stop ${what}: ${failed}`;
	const labelled = labelledOf(l, unlabelled);
	return [
		`stopped ${what}`,
		`labelled parked: ${labelled.map((n) => `#${n}`).join(", ") || "none"}`,
		...unlabelled.map((u) => `not labelled #${u.n}: ${reason(u.why)}`),
		...(unmarkedWhy
			? [`left parked until claimed, not on his typing: ${reason(unmarkedWhy)}`]
			: []),
	].join("; ");
}

/**
 * @param {{issues: number[]}} l
 * @param {{n: number}[]} unlabelled
 */
function labelledOf(l, unlabelled) {
	const missed = new Set(unlabelled.map((u) => u.n));
	return l.issues.filter((n) => !missed.has(n));
}

/**
 * Add `l`'s labelled issues to its session's `.parked-` marker, so the
 * founder's typing there takes the label off (unpark-on-prompt.js, #3584);
 * null once recorded or with none labelled, else why not.
 * @param {LoopLaunch} l
 * @param {number[]} labelled
 * @param {BlockIo} io
 */
function markLabelled(l, labelled, io) {
	if (labelled.length === 0) return null;
	if (!l.sessionId) return "no session id read";
	return io.recordParked(l, l.sessionId, labelled);
}

/**
 * `claude stop` on `l`'s job; null once stopped, else why not. A job the loop
 * already stopped to wait for its next resume (isHeld) may be gone, so a
 * stop that finds no job is that stop, not a failure.
 * @param {JobLaunch} l
 * @param {BlockIo} io
 */
function stopJob(l, io) {
	const r = io.stop(l.seat, l.jobId);
	if (r.ok) return null;
	return isHeld(l) && r.noJob ? null : r.why;
}

/**
 * Park `l`, its session stopped: label its issues `parked`, record them in its
 * session's marker and comment its cause on them, since a stopped session's own
 * words may not say why it waits (#2846). `l`, marked `parkStopped`.
 * @param {BlockedLaunch} l
 * @param {{act: Act, whyEnded?: string}} why
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function parkOnceStopped(l, why, mode, { now, io }) {
	const parking = { ...l, ...why };
	const unlabelled = io.labelParked(l);
	const outcome = {
		failed: null,
		unlabelled,
		unmarkedWhy: markLabelled(l, labelledOf(l, unlabelled), io),
	};
	io.log(buildParkStopLine(parking, mode, outcome));
	io.comment(
		l,
		`Refill loop: ${buildParkStopLine(parking, mode, outcome, { brief: true })}. The conversation is kept: \`claude attach\` reopens it.`,
	);
	return { ...l, parkStopped: now };
}

/**
 * Stop `l`'s park and, where the stop held, park it (parkOnceStopped).
 * @param {BlockedLaunch} l
 * @param {{act: Act, whyEnded?: string}} why  `act`, stop-and-park or
 *   park-at-morning
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function stopPark(l, why, mode, seen) {
	const failed = stopJob(l, seen.io);
	if (failed) {
		seen.io.log(
			buildParkStopLine({ ...l, ...why }, mode, { failed, unlabelled: [] }),
		);
		return l;
	}
	return parkOnceStopped(l, why, mode, seen);
}

/**
 * `l` with its session marked stopped at `now` until its next resume.
 * @template {LoopLaunch} L
 * @param {L} l
 * @param {number} now
 * @returns {L}
 */
const withHeld = (l, now) =>
	l.resumes ? { ...l, resumes: { ...l.resumes, heldAt: now } } : l;

/**
 * Stop `l`'s resuming session until its next resume (#2359). `l`, marked
 * held once stopped.
 * @param {BlockedLaunch} l
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function holdForResume(l, { now, io }) {
	const failed = stopJob(l, io);
	io.log(
		failed
			? `could not stop ${launchName(l)} until its next resume: ${failed}`
			: `stopped ${launchName(l)} until its next resume, due ${iso(l.resumes?.nextAt ?? now)}`,
	);
	return failed ? l : withHeld(l, now);
}

/**
 * Stop `l`'s job, then `claude --bg --resume <full id> "<API_PROMPT>"`
 * (#2354 F6). The resume's outcome; `fromSessionId`, the session it resumed.
 * @param {JobLaunch} l
 * @param {BlockIo} io
 * @returns {{failed: string}|(Resumed & {fromSessionId: string})}
 */
function relaunchResume(l, io) {
	const { sessionId, cwd } = io.resumeTargetOf(l);
	if (!sessionId) return { failed: "no session id read for it" };
	const stopFailed = stopJob(l, io);
	if (stopFailed) return { failed: `stop: ${stopFailed}` };
	return {
		...io.resumeStopped(l, API_PROMPT, { sessionId, cwd }),
		fromSessionId: sessionId,
	};
}

/**
 * `l` after a resume that restarted its job at `now`: `relaunchedAt` set,
 * from which it has the listing's grace. Where the job is a copy, `l` tracks
 * the copy's job and session id, its dispatch-ledger hold still the job
 * first launched (#2963), and `fromSessionId`, the session it resumed, kept
 * among its past ones for actsOf (#2969); a job woken in place keeps both.
 * @param {JobLaunch} l
 * @param {Extract<Resumed, {failed: null}> & {fromSessionId: string}} resumed
 * @param {number} now
 * @returns {JobLaunch}
 */
function relaunched(l, { jobId, sessionId, copy, fromSessionId }, now) {
	if (!copy)
		return { ...l, ...(sessionId ? { sessionId } : {}), relaunchedAt: now };
	const { sessionId: _, ...rest } = l;
	const past = new Set([...(l.pastSessionIds ?? []), fromSessionId]);
	return {
		...rest,
		jobId,
		copiedFrom: l.copiedFrom ?? l.jobId,
		relaunchedAt: now,
		...(sessionId ? { sessionId } : {}),
		pastSessionIds: [...past],
	};
}

/**
 * One resume, or one that could not be made, logged and commented on `l`'s
 * issues.
 * @param {LoopLaunch} l  after the try
 * @param {string} line  its cause's line
 * @param {BlockIo} io
 */
function reportResume(l, line, io) {
	io.log(line);
	io.comment(l, `Refill loop: ${line}.`);
}

/**
 * `l` after a resume by stop and `--bg --resume` at `now`: a try of its own,
 * or, the fallback of a typed one, that same try, held where it failed.
 * @param {JobLaunch} l
 * @param {number} now
 * @param {{failed: boolean, again: boolean}} how
 */
function afterFallBack(l, now, { failed, again }) {
	if (!again) return afterResume(l, now, { typed: false, failed });
	return failed ? withHeld(l, now) : l;
}

/**
 * Resume `l`'s API-error stop by stop and `--bg --resume`, never off an
 * unread listing ("doubt never stops a session"). One whose resume failed
 * is held, its `heldAt` set, for the next on the schedule.
 * @param {JobLaunch} l
 * @param {Tick} seen
 * @param {{route: string, again: boolean}} how  how the resume is told in
 *   the log and comment; whether it is the fallback of a typed resume
 *   already made, and so the same try
 * @returns {LoopLaunch}
 */
function fallBack(l, seen, { route, again }) {
	if (!seen.agents) {
		reportResume(
			l,
			buildResumeLine(l, route, "the listing is unread, so it is not stopped"),
			seen.io,
		);
		return l;
	}
	const r = relaunchResume(l, seen.io);
	let resumed = l;
	let told = route;
	if (r.failed === null) {
		resumed = relaunched(l, r, seen.now);
		told = `${route}, ${r.copy ? `as its copy ${resumed.jobId}` : "woken in place"}`;
	}
	const tried = {
		...afterFallBack(resumed, seen.now, { failed: r.failed !== null, again }),
		jobId: resumed.jobId,
	};
	reportResume(tried, buildResumeLine(tried, told, r.failed), seen.io);
	return tried;
}

/**
 * The launches with each API-error resume typed a tick ago checked (#2359's
 * route): where its line never reached the timeline, the same try falls back
 * to stop and `--bg --resume`. None off an unread listing, which could not
 * tell the session's state, the fallback being a stop.
 * @param {LoopLaunch[]} launches
 * @param {Tick} seen
 */
function settleTyped(launches, seen) {
	const { agents, now, io } = seen;
	if (!agents) return launches;
	return launches.map((l) => {
		const resumes = l.resumes;
		const at = resumes?.attachAt;
		if (
			!resumes ||
			at === undefined ||
			now - at < ATTACH_VERDICT_MS ||
			!isActionable(l)
		)
			return l;
		const { attachAt: _, ...rest } = resumes;
		const settled = /** @type {JobLaunch} */ ({ ...l, resumes: rest });
		if (
			!isResuming(settled) ||
			isResumeArrived(at, API_PROMPT, io.readTimeline(settled))
		)
			return settled;
		return fallBack(settled, seen, {
			route: `${FALLBACK_ROUTE}, the typed one unseen`,
			again: true,
		});
	});
}

/**
 * Whether `l`'s session is live, or the listing unread.
 * @param {JobLaunch} l
 * @param {AgentRecord[]|null} agents
 */
const isLiveIn = (l, agents) =>
	!agents || agents.some((a) => a.id === l.jobId && !isTerminalAgent(a));

/**
 * Resume `l`'s API-error stop (#2705): typed into its session where it is
 * live or the listing is unread; else, or where the typing failed, by
 * fallBack.
 * @param {JobLaunch} l
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function makeResume(l, seen) {
	const { agents, now, io } = seen;
	const live = isLiveIn(l, agents);
	const typeFailed = live ? io.type(l, API_PROMPT) : null;
	if (typeFailed)
		io.log(`could not type the resume into ${l.jobId}: ${typeFailed}`);
	if (!live || typeFailed)
		return fallBack(l, seen, { route: FALLBACK_ROUTE, again: false });
	const tried = afterResume(l, now, { typed: true, failed: false });
	reportResume(tried, buildResumeLine(tried, ATTACH_ROUTE, null), io);
	return tried;
}

/**
 * Type the resume into `l`'s resumed-idle session (#2978): never a stop, so
 * an unread listing types too. A try that could not be typed still counts,
 * so a session the loop cannot reach is handed off on the table's schedule;
 * a later tick reads the transcript for its turn (idleActs).
 * @param {JobLaunch} l
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function typeIdleResume(l, { agents, now, io }) {
	const failed = isLiveIn(l, agents)
		? io.type(l, IDLE_PROMPT)
		: "its session is not live";
	const tried = afterIdleResume(l, now);
	reportResume(tried, buildIdleResumeLine(tried, failed), io);
	return tried;
}

/** Why idleSpared spares a launch, by its idleReading. */
const SPARED_WHY = {
	turned: "it took a turn after its resume",
	ended: "its job is no longer idle",
	unread: "its resumed-idle records are unread",
};

/**
 * `l` where its records, read again just before a stop, no longer read
 * resumed-idle (#2979): an `api-request` or assistant row after the loop's
 * last resume, or a job no longer working, ends the episode (endedIdle), and
 * records that will not read stop nothing ("doubt never stops a session"),
 * each logged. Null where it still reads idle.
 * @param {JobLaunch} l
 * @param {BlockIo} io
 * @returns {LoopLaunch|null}
 */
function idleSpared(l, io) {
	const since = idleReading(l, io);
	if (typeof since === "number") return null;
	io.log(`not stopping ${launchName(l)}: ${SPARED_WHY[since]}`);
	return since === "unread" ? l : endedIdle(l);
}

/**
 * Stop `b`'s resumed-idle session, still idle after its typed resumes, and
 * hand its issues to a fresh launch (#2659): `io.postHandOff`, which posts
 * its snapshot as a `**Hand-off:**` comment on each and releases its claim.
 * Its launch is finished and its dispatch-ledger hold released (#2744), so
 * the next tick may relaunch its issues within the ledger's hour; a failed
 * hand-off is retried on the next tick, the session left stopped, up to
 * HAND_OFF_TRIES. One given up keeps its hold, as its claim may still stand
 * and no snapshot was posted, so its issues wait out the hour. Never off an
 * unread listing ("doubt never stops a session"), nor where idleSpared
 * spares it.
 * @param {JobLaunch} b
 * @param {Tick} seen
 * @param {boolean} [stopped]  its stop already held, on a retried hand-off
 * @returns {LoopLaunch}
 */
function handOff(b, { agents, now, io }, stopped = false) {
	const { block: _, ...l } = b;
	if (!agents) {
		io.log(`not handing off ${launchName(l)}: the listing is unread`);
		return l;
	}
	const spared = stopped ? null : idleSpared(l, io);
	if (spared) return spared;
	const failed = stopped ? null : stopJob(b, io);
	if (failed) {
		io.log(`could not stop ${launchName(l)} to hand it off: ${failed}`);
		return l;
	}
	const r = io.postHandOff(b);
	io.log(
		buildChildLine(
			`stopped ${launchName(l)}, idle after its resume, and handed it off`,
			r,
		),
	);
	const tries = (l.handOffTries ?? 0) + 1;
	if (r.failed && tries < HAND_OFF_TRIES) return { ...l, handOffTries: tries };
	if (r.failed)
		io.log(`gave up handing off ${launchName(l)} after ${tries} tries`);
	else if (!io.release(b))
		io.log(
			`could not release ${launchName(l)}'s dispatch-ledger hold: its issues wait out the hour (#2744)`,
		);
	const { handOffTries: __, ...done } = l;
	return {
		...done,
		...io.progressOf(done),
		finishedAt: now,
		handedOff: now,
	};
}

/**
 * Stop `b`'s resumed-idle session under the swap hold until it clears
 * (#3093, #3084). Its resume target is read first, the stop being free to
 * rewrite the job record; one with no session id is not stopped, as nothing
 * could resume it. A stop that fails, a job not found included, is logged
 * and never held, so the next tick tries again; never off an unread listing,
 * nor where idleSpared spares it. Its typed resumes are kept across the
 * hold, so one idle by its own fault still meets its hand-off.
 * @param {BlockedLaunch} b
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function holdIdle(b, { agents, now, io, swapHold }) {
	const { block: _, ...l } = b;
	const what = `${launchName(l)}, restarted by its host, under the swap hold${swapHold.held ? ` (${swapHoldText(swapHold)})` : ""}`;
	if (!agents) {
		io.log(`not stopping ${what}: the listing is unread`);
		return l;
	}
	const spared = idleSpared(l, io);
	if (spared) return spared;
	const { sessionId, cwd } = io.resumeTargetOf(b);
	if (!sessionId) {
		io.log(`not stopping ${what}: no session id read to resume it by`);
		return l;
	}
	const failed = stopJob(b, io);
	if (failed) {
		io.log(`could not stop ${what}: ${failed}`);
		return l;
	}
	io.log(`stopped ${what}, until the hold clears`);
	const { idleSince: __, ...stopped } = l;
	return { ...stopped, swapHeld: { at: now, sessionId, cwd, tries: 0 } };
}

/**
 * Resume `l`, stopped under the swap hold, on the first tick it has cleared:
 * `claude --bg --resume` of its session with the restart's prompt. One whose
 * resume fails stays held for the next tick, and after SWAP_RESUME_TRIES
 * failures is handed off instead. Nothing off an unread listing; one live
 * again markParked has let go.
 * @param {JobLaunch & {swapHeld: SwapHeld}} l
 * @param {Tick} seen
 * @returns {LoopLaunch}
 */
function resumeSwapHeld(l, seen) {
	const { agents, now, io, swapHold } = seen;
	if (swapHold.held) return l;
	const { swapHeld, ...rest } = l;
	const what = `${launchName(l)}, stopped under the swap hold at ${iso(swapHeld.at)}`;
	if (!agents) {
		io.log(`not resuming ${what}: the listing is unread`);
		return l;
	}
	const { sessionId, cwd } = swapHeld;
	const r = io.resumeStopped(l, IDLE_PROMPT, { sessionId, cwd });
	if (r.failed === null) {
		const resumed = relaunched(rest, { ...r, fromSessionId: sessionId }, now);
		io.log(
			`resumed ${what}, the hold cleared, by --bg --resume, ${r.copy ? `as its copy ${resumed.jobId}` : "woken in place"}`,
		);
		return resumed;
	}
	const tries = swapHeld.tries + 1;
	io.log(
		`could not resume ${what}, try ${tries} of ${SWAP_RESUME_TRIES}: ${r.failed}`,
	);
	if (tries < SWAP_RESUME_TRIES)
		return { ...l, swapHeld: { ...swapHeld, tries } };
	return handOff(rest, seen, true);
}

/**
 * @typedef {{mode: "away"|"normal", resume: (l: BlockedLaunch, seen: Tick)
 *   => LoopLaunch, hold: (l: BlockedLaunch, seen: Tick) => LoopLaunch}}
 *   ActHow  `resume` and `hold`, the acts of those names for the cause
 */

/**
 * Each act's handler, for blocked and resumed-idle launches alike; `wait` and
 * `none` have none.
 * @type {Partial<Record<Act, (l: BlockedLaunch, seen: Tick, how: ActHow) =>
 *   LoopLaunch>>}
 */
const ACTS = {
	"stop-and-park": (l, seen, { mode }) =>
		stopPark(l, { act: "stop-and-park" }, mode, seen),
	"park-at-morning": (l, seen, { mode }) =>
		stopPark(l, { act: "park-at-morning" }, mode, seen),
	hold: (l, seen, { hold }) => hold(l, seen),
	resume: (l, seen, { resume }) => resume(l, seen),
	"handoff-relaunch": (l, seen) => handOff(l, seen),
};

/**
 * Each of `acts` done through ACTS, by job id.
 * @param {{l: BlockedLaunch, act: Act}[]} acts
 * @param {Tick} seen
 * @param {ActHow} how
 * @returns {Map<string, LoopLaunch>}
 */
function actedOn(acts, seen, how) {
	const acted = new Map();
	for (const { l, act } of acts) {
		const handler = ACTS[act];
		if (handler) acted.set(l.jobId, handler(l, seen, how));
	}
	return acted;
}

/**
 * The launches with each launch in `acted` put in, by job id.
 * @param {LoopLaunch[]} launches
 * @param {Map<string, LoopLaunch>} acted
 */
const withActed = (launches, acted) =>
	launches.map((l) => (l.jobId && acted.get(l.jobId)) || l);

/**
 * The tick's acts on blocked launches: each typed resume checked, then the
 * table's act on each (blockedActs).
 * @param {LoopLaunch[]} launches markParked's, off `seen`'s listing
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 */
function actOnBlocks(launches, mode, seen) {
	const settled = settleTyped(launches, seen);
	const acts = blockedActs(settled, mode, seen);
	return withActed(
		settled,
		actedOn(acts, seen, { mode, resume: makeResume, hold: holdForResume }),
	);
}

/**
 * The limit a seat's reading shows: a full bar, the weekly first, as it
 * outlasts the 5-hour one, else the fuller, a session reaching its limit
 * ahead of the cached reading.
 * @param {import("./refill-decide.js").SizedSeat} s
 * @returns {LimitRead}
 */
function limitReadOf(s) {
	if (s.week === null && s.session === null && !s.weekFull && !s.sessionFull)
		return { bar: null, resets: null };
	const isWeekly =
		s.weekFull || (!s.sessionFull && (s.week ?? 0) >= (s.session ?? 0));
	return isWeekly
		? {
				bar: "weekly",
				resets: s.weekResets === null ? null : iso(s.weekResets),
			}
		: { bar: "5-hour", resets: s.sessionResets };
}

/** @param {LimitRead} limit */
const buildLimitText = ({ bar, resets }) =>
	`${bar ?? "unread"} limit (reset ${resets ?? "unread"})`;

/**
 * `l` with one more resume in place counted, `failed` why it failed, which a
 * held one's hold counts towards its park at the cap (#3790); one that took
 * is judged at the launch's next limit block (#3792).
 * @template {LoopLaunch} L
 * @param {L} l
 * @param {number} now
 * @param {string} [failed]
 * @returns {L}
 */
function afterLimitTry(l, now, failed) {
	const tries = (l.limitResumes?.tries ?? 0) + 1;
	const held = l.limitHeld;
	const dryResumes = l.limitResumes?.dryResumes;
	return {
		...l,
		...(failed !== undefined && held
			? {
					limitHeld: {
						...held,
						failedTries: (held.failedTries ?? 0) + 1,
					},
				}
			: {}),
		limitResumes: {
			tries,
			triedAt: now,
			nextAt: nextTryAt(tries, now),
			...(dryResumes === undefined ? {} : { dryResumes }),
			...(failed === undefined ? { takenAt: now } : { failed }),
		},
	};
}

/**
 * Log a resume in place that failed, and comment it where its failure is
 * news, so one that keeps failing does not comment on every try.
 * @param {LoopLaunch} l
 * @param {string} what
 * @param {string} why
 * @param {BlockIo} io
 */
function reportLimitFailure(l, what, why, io) {
	const line = `could not resume ${what}`;
	io.log(`${line}: ${why}`);
	if (l.limitResumes?.failed === why) return;
	io.comment(
		l,
		`Refill loop: ${line}: ${why.split(/\r?\n/)[0]}. It stays held on its seat, its conversation kept, and is judged again on a later tick.`,
	);
}

/**
 * Stop `l`'s limit-blocked session until a seat has room: it keeps its
 * conversation and its launch, and holds no memory or slot. Told in the log
 * alone. One with no session id is not stopped, as nothing could resume it.
 * @param {JobLaunch} l
 * @param {LimitRead} limit
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function holdForLimit(l, limit, { now, io }) {
	const what = `${l.jobId} ${launchName(l)} on ${l.seat}, at its ${buildLimitText(limit)}`;
	const { sessionId, cwd } = io.resumeTargetOf(l);
	if (!sessionId) {
		io.log(`not holding ${what}: no session id read to resume it by`);
		return l;
	}
	const failed = stopJob(l, io);
	if (failed) {
		io.log(`could not hold ${what}: ${failed}`);
		return l;
	}
	io.log(`held ${what}: stopped until a seat has room`);
	return { ...l, limitHeld: { at: now, sessionId, cwd, limit } };
}

/**
 * Resume `l`'s limit-blocked session on its own seat (#3735): stopped, unless
 * held already, then `--bg --resume` under its own session id. A resume stays
 * held until settleLimitResume, as a failed one can show only seconds later
 * (#2159). One the launcher ran as a copy tracks the copy, as
 * lib/refill-tick.js's resumeStopped moves the claims to it (#2963).
 * @param {JobLaunch} l
 * @param {LimitRead} limit  what a live session's seat reads now
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function resumeInPlace(l, limit, { now, io }) {
	const held = l.limitHeld ?? { ...io.resumeTargetOf(l), at: now, limit };
	const limitText = buildLimitText(held.limit);
	const what = `${l.jobId} ${launchName(l)} on ${l.seat}, after its ${limitText}`;
	const { sessionId, cwd } = held;
	if (!sessionId) {
		const why = "no session id read for it";
		reportLimitFailure(l, what, why, io);
		return afterLimitTry(l, now, why);
	}
	const stopFailed = isLimitHeld(l) ? null : stopJob(l, io);
	if (stopFailed) {
		const why = `stop: ${stopFailed}`;
		reportLimitFailure(l, what, why, io);
		return afterLimitTry(l, now, why);
	}
	const stopped = { ...l, limitHeld: { ...held, sessionId } };
	const r = io.resumeStopped(stopped, LIMIT_PROMPT, { sessionId, cwd });
	if (r.failed !== null) {
		reportLimitFailure(stopped, what, r.failed, io);
		return afterLimitTry(stopped, now, r.failed);
	}
	const resumed = relaunched(
		{
			...stopped,
			parked: false,
			limitHeld: { ...stopped.limitHeld, resumedAt: now },
		},
		{ ...r, fromSessionId: sessionId },
		now,
	);
	const how = r.copy ? `as its copy ${resumed.jobId}` : "woken in place";
	io.log(`resumed ${what}: same seat, ${how}`);
	io.comment(
		l,
		`Refill loop: resumed this session after its ${limitText}: same seat, ${l.seat}, ${how}. Lost: its in-flight subagents, background tasks and monitors, and the warm prompt cache (one cache rewrite of its context).`,
	);
	return afterLimitTry(resumed, now);
}

/**
 * Judge a resume in place a tick on, its session not listed live or markParked
 * would have let it go. A job record reading failed or unread goes back to
 * held, named; any other is let go, for the listing to judge finished.
 * @param {JobLaunch & {limitHeld: LimitHeld}} l
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function settleLimitResume(l, { now, io }) {
	const job = io.jobStateOf(l);
	if (job && job.state !== "failed") {
		const { limitHeld: _, block: __, ...rest } = l;
		return rest;
	}
	const { resumedAt: _, ...limitHeld } = l.limitHeld;
	const why = job
		? `state failed after its resume: ${job.detail}`
		: "its job record is unread after its resume";
	const what = `${l.jobId} ${launchName(l)} on ${l.seat}`;
	reportLimitFailure(l, what, why, io);
	return afterLimitTry({ ...l, limitHeld }, now, why);
}

/**
 * `l`, limit-blocked again, with its last resume that took judged, once: no
 * reply since adds to its dry resumes, a reply clears them (#3792). An unread
 * transcript judges nothing, and the next resume replaces what it would have
 * judged.
 * Residual: a launch whose transcript never reads is never counted, though one
 * that reads LIMIT has read its transcript that tick.
 * @template {JobLaunch} L
 * @param {L} l
 * @param {BlockIo} io
 * @returns {L}
 */
function judgeTakenResume(l, io) {
	if (l.limitResumes?.takenAt === undefined) return l;
	const { takenAt, dryResumes = 0, ...rest } = l.limitResumes;
	const replied = io.hasRepliedSince(l, takenAt);
	if (replied === null) return l;
	return {
		...l,
		limitResumes: replied ? rest : { ...rest, dryResumes: dryResumes + 1 },
	};
}

/**
 * `l`, held past the dispatch ledger's window, with its hold written again:
 * its stopped session leaves the listing and its claim unread, so nothing else
 * keeps a direct dispatch off its issues. A write that fails is logged, and
 * the next tick tries again.
 * @param {LoopLaunch & {limitHeld: LimitHeld}} l
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function renewLedgerHold(l, { now, io }) {
	if (now - (l.limitHeld.ledgerAt ?? 0) < LEDGER_RENEW_MS) return l;
	if (io.renewLedgerHold(l))
		return { ...l, limitHeld: { ...l.limitHeld, ledgerAt: now } };
	io.log(`could not renew ${launchName(l)}'s dispatch-ledger hold`);
	return l;
}

/**
 * Park `l`, held where nothing will resume it, so the launch finishes and a
 * normal-mode loop routes its ticket back (#3790). A failed resume can leave
 * its session starting, so it is stopped too, though a stop that fails, as
 * one off a dropped seat may for good, does not keep it held. Off the hold, as
 * isLimitHeld has no parkStopped guard; its session id kept for the marker.
 * @param {JobLaunch & {block: import("./block-act.js").Block,
 *   limitHeld: LimitHeld}} l
 * @param {string|undefined} whyEnded  for the park's line
 * @param {"away"|"normal"} mode
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function parkHeld(l, whyEnded, mode, seen) {
	const stopFailed = stopJob(l, seen.io);
	if (stopFailed)
		seen.io.log(`could not stop ${launchName(l)} for its park: ${stopFailed}`);
	const { limitHeld: _, ...parked } = parkOnceStopped(
		{ ...l, sessionId: l.sessionId ?? l.limitHeld.sessionId },
		{ act: "stop-and-park", whyEnded },
		mode,
		seen,
	);
	return parked;
}

/**
 * `l`'s block as the table reads it, short of what its seat's reading adds.
 * @param {JobLaunch & {block: import("./block-act.js").Block}} l
 * @returns {import("./block-act.js").Block}
 */
const limitBlockOf = (l) => ({
	...l.block,
	held: isLimitHeld(l),
	heldAt: l.limitHeld?.at,
	tries: l.limitHeld?.failedTries,
	nextAt: l.limitResumes?.nextAt,
	dryResumes: l.limitResumes?.dryResumes,
});

/**
 * `l`, whose seat the seats read do not hold: parked where it is held and the
 * seats are the loop's own list, or, whatever the list, held at a cap.
 * @param {JobLaunch & {block: import("./block-act.js").Block}} l
 * @param {"away"|"normal"} mode
 * @param {LimitTick} seen
 * @returns {LoopLaunch}
 */
function parkOffList(l, mode, seen) {
	if (!isLimitHeld(l)) return l;
	if (seen.seatListRead)
		return parkHeld(l, `its seat ${l.seat} off the loop's seats`, mode, seen);
	const whyEnded = buildLimitParkWhy(limitBlockOf(l), seen.now);
	return whyEnded ? parkHeld(l, whyEnded, mode, seen) : l;
}

/**
 * The move pick and the table's act on one limit-blocked launch on a plan seat.
 * @param {JobLaunch & {block: import("./block-act.js").Block}} l
 * @param {import("./refill-decide.js").SizedSeat} own  its seat's reading
 * @param {LimitTick} seen
 * @param {{mode: "away"|"normal", slots: number,
 *   moveSeats: import("./refill-decide.js").SizedSeat[]}} how
 * @returns {LoopLaunch}
 */
function actOnLimit(l, own, seen, { mode, slots, moveSeats }) {
	const { seat: movePick } = pickMoveSeat({
		seats: moveSeats,
		typedSeat: seen.typedSeat,
		ownSeat: l.seat,
		since: l.block.since,
	});
	const block = {
		...limitBlockOf(l),
		seat: l.seat,
		movePick,
		slotFree: slots > 0,
	};
	const act = blockAct(block, mode, seen.now);
	if (act === "stop-and-park") {
		const whyEnded = buildLimitParkWhy(block, seen.now);
		return isLimitHeld(l)
			? parkHeld(l, whyEnded, mode, seen)
			: stopPark(l, { act, whyEnded }, mode, seen);
	}
	const limit = limitReadOf(own);
	if (act === "hold") return holdForLimit(l, limit, seen);
	if (act === "resume-in-place") return resumeInPlace(l, limit, seen);
	if (movePick === l.seat && slots <= 0)
		seen.io.log(
			`${launchName(l)} on ${l.seat} reads open, and waits on a free slot`,
		);
	return l;
}

/**
 * The sessions an act on `l` added to the listing (#3778): one resumed from
 * held adds one, and one live left held or parked, no resume made, is gone. A
 * live one stopped and resumed in place adds none.
 * @param {LoopLaunch} l
 * @param {LoopLaunch} out
 * @returns {-1|0|1}
 */
function limitWorkingChange(l, out) {
	if (!isLimitHeld(out))
		return out.parkStopped !== undefined && !isLimitHeld(l) ? -1 : 0;
	const resumed = out.limitHeld.resumedAt !== undefined;
	if (isLimitHeld(l)) return resumed ? 1 : 0;
	return resumed ? 0 : -1;
}

/**
 * The tick's acts on limit-blocked launches, on the seats they read (#3735):
 * each resume made a tick ago judged, then for each on a plan seat its act; one
 * held whose seat has left the loop's list is parked (#3790), so a restart on
 * fewer seats parks each hold on those dropped. A move to another seat is not
 * made here, so that session is held. Each one
 * resumed from held takes a slot, so a seat's reset lets them back only as
 * admission has room. The launches, the slots left, and the net sessions added
 * to those admission read. Nothing off an unread listing, and with none
 * limit-blocked no seat is read.
 * @param {LoopLaunch[]} launches
 * @param {"away"|"normal"} mode
 * @param {LimitTick} seen
 * @returns {{launches: LoopLaunch[], slots: number, workingChange: number}}
 */
function actOnLimits(launches, mode, seen) {
	let { slots } = seen;
	let workingChange = 0;
	if (!seen.agents || !launches.some(isLimitBlocked))
		return { launches, slots, workingChange };
	const moveSeats = seen.readMoveSeats();
	const blocked = blockedIdsOf(seen.agents);
	const acted = launches.map((l) => {
		if (!isLimitBlocked(l)) return l;
		if (isResumeUnjudged(l)) return settleLimitResume(l, seen);
		const own = moveSeats.find((s) => s.seat === l.seat);
		if (!own) return parkOffList(l, mode, seen);
		if (!(blocked.has(l.jobId) || isLimitHeld(l))) return l;
		const out = actOnLimit(judgeTakenResume(l, seen.io), own, seen, {
			mode,
			slots,
			moveSeats,
		});
		const change = limitWorkingChange(l, out);
		if (change > 0) slots -= 1;
		workingChange += change;
		return isLimitHeld(out) ? renewLedgerHold(out, seen) : out;
	});
	return { launches: acted, slots, workingChange };
}

/**
 * The tick's acts on resumed-idle launches (#2659), read off the job store
 * and transcripts whether or not the listing read: each owed hand-off
 * retried, each typed resume checked, then the RESUMED_IDLE row's act, its
 * block made up for the act and so not kept; last, each launch stopped under
 * a swap hold since cleared resumed (#3093).
 * @param {LoopLaunch[]} launches
 * @param {"away"|"normal"} mode
 * @param {Tick} seen
 */
function actOnIdle(launches, mode, seen) {
	const owed = launches.map((l) =>
		isActionable(l) && l.handOffTries !== undefined
			? handOff(l, seen, true)
			: l,
	);
	const read = idleActs(owed, mode, seen);
	const acted = actedOn(read.acts, seen, {
		mode,
		resume: typeIdleResume,
		hold: holdIdle,
	});
	const unblocked = new Map(
		[...acted].map(([jobId, { block: _, ...l }]) => [jobId, l]),
	);
	return withActed(read.launches, unblocked).map((l) =>
		isActionable(l) && isSwapHeld(l) ? resumeSwapHeld(l, seen) : l,
	);
}

/**
 * The why of launch `key`'s UNKNOWN reading where it is news to log, else
 * null: once for each why, forgotten once a cause reads (#3200). Updates
 * `logged`, the loop's record, one entry per launch the loop process has seen
 * unread.
 * @param {Map<string, string>} logged
 * @param {string} key
 * @param {import("./block-cause.js").Reading} reading
 * @returns {string|null}
 */
function unknownNews(logged, key, reading) {
	if (reading.cause !== "UNKNOWN") {
		logged.delete(key);
		return null;
	}
	if (logged.get(key) === reading.why) return null;
	logged.set(key, reading.why);
	return reading.why;
}

module.exports = {
	actOnBlocks,
	actOnIdle,
	actOnLimits,
	buildChildLine,
	buildLimitText,
	indented,
	isHeld,
	isLimitBlocked,
	isLimitHeld,
	isLive,
	isResuming,
	isSwapHeld,
	iso,
	launchName,
	markParked,
	nextResumeAt,
	unknownNews,
};
