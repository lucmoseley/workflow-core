/*
 * refill-batch.js — the refill loop's launch step: a tick's launches grouped
 * into one dispatcher call per repo and seat (#2196), each call run, and its
 * members' records read back from the dispatch ledger, and a parked member
 * resumed in place instead where the decision routed it so (#3621). A module
 * of its own (#3265) so the launch step changes alone and is driven directly,
 * with the spawn, the ledger, the resume and the clock passed in.
 */

const { hasNothingToRepeat } = require("./loop-prompts.js");
const { launchName } = require("./refill-blocks.js");
const { buildCheckoutEnv } = require("./refill-repos.js");
const { seatIdOf } = require("./refill-seats.js");

/* Untraced: the dispatcher call's one-off gates and a `claude --bg` that hangs
 * up to dispatch-sessions.sh's own launch ceiling. */
const DISPATCH_FIXED_MS = 10 * 60 * 1000;
/* Untraced: a member's 120 s launch ceiling, about 9 s of admission and the
 * 2 s stagger, rounded up (#2196). A member's worktree cut is a fetch and a
 * `git worktree add` inside it: the call sets WFC_DISPATCH_NO_BUILD, so a cut
 * finding no dependency store refuses rather than run `npm ci`, and the tick's
 * warm pass builds the store outside this budget (#4318). */
const DISPATCH_MEMBER_MS = 150 * 1000;
/* dispatch-sessions.sh's STAGGER_SECONDS default, which a test holds equal,
 * and whose measurement it is (mantahostels#2588). */
const STAGGER_SECONDS = 2;
/* The slack covers the clock read before the spawn. */
const LEDGER_SLACK_MS = 1000;

/**
 * The pause, ms, that lets a re-read count the bg-spare the last start warmed.
 * Unset or empty is the default, as in the shell; so is an unreadable value, as
 * a NaN would never wake sleepSync.
 * @param {NodeJS.ProcessEnv} [env]
 */
function readStaggerMs(env = process.env) {
	const seconds = Number(env.WFC_DISPATCH_STAGGER_SECONDS || STAGGER_SECONDS);
	return (Number.isNaN(seconds) ? STAGGER_SECONDS : seconds) * 1000;
}

/**
 * A tick's launches as dispatcher calls: one per repo and seat, in the order
 * each first appears, its members in pick order (#2196).
 * @param {import("./refill-decide.js").Launch[]} launches
 * @returns {import("./refill-decide.js").Launch[][]}
 */
function batchesOf(launches) {
	/** @type {Map<string, import("./refill-decide.js").Launch[]>} */
	const batches = new Map();
	for (const l of launches) {
		const key = JSON.stringify([l.root, l.seat, l.keyVar]);
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
	const { root, seat, keyVar } = first;
	/** @type {NodeJS.ProcessEnv} */
	const childEnv = {
		...buildCheckoutEnv(root, env),
		CLAUDE_CONFIG_DIR: seat,
		WFC_SEAT_REASON: first.reason,
		WFC_DISPATCH_NO_BUILD: "1",
		...(keyVar ? { WFC_SEAT_KEY: keyVar } : {}),
	};
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
 * The dry run's line for one dispatcher call, naming the key an overflow
 * seat's members bill (#2611, #3701).
 * @param {ReturnType<typeof dispatchCall>} call
 */
function buildWouldRunLine(call) {
	const seat = String(call.env.CLAUDE_CONFIG_DIR);
	const on = call.env.WFC_SEAT_KEY
		? `overflow seat ${seat}, each member billed to key=${call.env.WFC_SEAT_KEY}`
		: seat;
	return `would run in ${call.cwd} on ${on}: ${call.file} ${call.args.join(" ")}`;
}

/**
 * @typedef {{launch: import("./refill-decide.js").Launch, reason: string}} Refusal
 * @typedef {{launched: import("./refill-loop.js").LoopLaunch[], refused: Refusal[],
 *   resumeRefused?: string|null}} BatchOutcome  `resumeRefused`, why a resume
 *   waits, which holds back every batch behind it
 * @typedef {{resume: (l: import("./refill-decide.js").Launch,
 *   target: import("./refill-decide.js").ResumeTarget) =>
 *   import("./refill-blocks.js").Resumed,
 *   readActsBefore: import("./refill-blocks.js").ReadActsBefore,
 *   admitResume: () => string|null, stagger: () => void,
 *   recordLaunch: typeof import("./dispatch-ledger.js").record,
 *   log: (line: string) => void, now: () => number}} ResumeIo
 */

/* The dispatcher's per-member lines parseRefusalReason keys on, which a test
 * pins to dispatch-sessions.sh's printf formats through launchBatch. */
const MEMBER_REFUSED_TAIL = "— not launching this member.";
const buildMemberRefused = (/** @type {string} */ prompt) =>
	`REFUSED: ${prompt} ${MEMBER_REFUSED_TAIL}`;
const buildMemberDropped = (/** @type {string} */ prompt) =>
	`dropped: ${prompt}`;
/* A set-level refusal or cut: the duplicate gate's REFUSED or DROPPING
 * header, the allowance cap's CAPPED, the launch timeout's REFUSED. */
const SET_HEADER = /^\s*(REFUSED: |DROPPING |CAPPED: )/;

/**
 * Parse why the dispatcher launched nothing for `prompt` from its output: the
 * re-read's `slots` line under that member's REFUSED block, else the block's
 * first line; for a dropped member, the last set header above the drop; else
 * the call's last set-level refusal or its exit (#2500).
 * @param {string} out the dispatcher's stdout and stderr
 * @param {string} prompt
 * @param {string|null} failed the call's failure, null on exit 0
 */
function parseRefusalReason(out, prompt, failed) {
	const lines = out.split("\n");
	const isSetHeader = (/** @type {string} */ l) =>
		SET_HEADER.test(l) && !l.endsWith(MEMBER_REFUSED_TAIL);
	const at = lines.indexOf(buildMemberRefused(prompt));
	if (at !== -1) {
		const end = lines.findIndex((l, i) => i > at && !l.startsWith("  "));
		const block = lines
			.slice(at + 1, end === -1 ? undefined : end)
			.map((l) => l.trim().replace(/\s+/g, " "))
			.filter(Boolean);
		return (
			block.find((l) => l.startsWith("slots ")) ??
			block[0] ??
			buildMemberRefused(prompt)
		);
	}
	const dropped = lines.findIndex(
		(l) => l.trim() === buildMemberDropped(prompt),
	);
	if (dropped !== -1)
		return (
			lines.slice(0, dropped).findLast(isSetHeader)?.trim() ??
			buildMemberDropped(prompt)
		);
	if (failed)
		return lines.findLast(isSetHeader)?.trim() ?? `dispatcher ${failed}`;
	return "no ledger entry written for it";
}

/**
 * The parked route's limit-cap parks in a row, for `l`'s launch record: the next
 * such park counts on from them, whichever session makes it (#3804).
 * @param {import("./refill-decide.js").Launch} l
 */
const limitParksOf = (l) =>
	l.parkedRoute?.limitParks ? { limitParks: l.parkedRoute.limitParks } : {};

/**
 * Launch one batch through the dispatcher: the record of each member it
 * launched, stamped with its own ledger entry's time, each it refused with
 * parseRefusalReason's reason, and the members it tried. The ledger is read after
 * every exit: a non-zero one can follow earlier members' launches, and exit 0
 * covers a dropped member too, so only an entry written for a member's prompt
 * since the call proves its launch.
 * After a non-zero exit only the launched members count as tried, as the
 * rest may never have been reached and the next tick retries them.
 * @param {import("./refill-decide.js").Launch[]} batch one of batchesOf's
 * @param {{dispatcher: string, env: NodeJS.ProcessEnv,
 *   run: (call: ReturnType<typeof dispatchCall>) => {failed: string|null, out: string},
 *   entriesOf: (root: string) => import("./dispatch-ledger.js").DispatchRecord[],
 *   now: () => number}} io  `now` is read once, before the call
 * @returns {BatchOutcome & {tried: import("./refill-decide.js").Launch[],
 *   failed: string|null, out: string}}
 */
function launchBatch(batch, io) {
	const call = dispatchCall(batch, io.dispatcher, io.env);
	const calledAt = io.now();
	const r = io.run(call);
	const { launched, reached, missing } = readLaunched(batch, calledAt, io);
	const refused = missing.map((l) => ({
		launch: l,
		reason: parseRefusalReason(r.out, l.prompt, r.failed),
	}));
	return { launched, refused, tried: r.failed ? reached : batch, ...r };
}

/**
 * The members of `batch` the dispatch ledger shows launched by a call made at
 * `calledAt`: an entry written since for a member's prompt is its launch, and
 * its record is stamped with that entry's time. `reached`, those members;
 * `missing`, the rest.
 * @param {import("./refill-decide.js").Launch[]} batch one of batchesOf's
 * @param {number} calledAt
 * @param {Pick<Parameters<typeof launchBatch>[1], "entriesOf">} io
 */
function readLaunched(batch, calledAt, io) {
	const [first] = batch;
	const entries = first
		? io
				.entriesOf(first.root)
				.filter((e) => Date.parse(e.ts) >= calledAt - LEDGER_SLACK_MS)
		: [];
	/** @type {import("./refill-loop.js").LoopLaunch[]} */
	const launched = [];
	/** @type {import("./refill-decide.js").Launch[]} */
	const reached = [];
	/** @type {import("./refill-decide.js").Launch[]} */
	const missing = [];
	for (const l of batch) {
		const entry = entries.filter((e) => e.prompt === l.prompt).pop();
		if (!entry) {
			missing.push(l);
			continue;
		}
		reached.push(l);
		launched.push({
			root: l.root,
			issues: l.issues,
			prompt: l.prompt,
			...seatIdOf(l),
			reason: l.reason,
			jobId: entry.jobId,
			launchedAt: Date.parse(entry.ts),
			finishedAt: null,
			...(l.gate ? { gate: l.gate } : {}),
			...limitParksOf(l),
		});
	}
	return { launched, reached, missing };
}

/**
 * Resume the session that parked `l`'s ticket, in place (#3621): its new
 * launch record, or null, logged, where the decision routed it afresh or the
 * resume failed, for `l` to launch afresh. The resume is written to the
 * dispatch ledger as a launch, so the idle alarm dates the issue from it
 * (#3704); a write that fails is logged and the resume stands
 * (mantahostels#1528). A session woken in place keeps its id, so the record
 * notes the acts read before the wake, which are not this launch's (#3942); a
 * copy's session starts with none.
 * @param {import("./refill-decide.js").Launch} l
 * @param {NonNullable<import("./refill-decide.js").Launch["parkedRoute"]>} parked
 * @param {ResumeIo} io
 * @returns {import("./refill-loop.js").LoopLaunch|null}
 */
function resumeParked(l, parked, io) {
	/** @param {string} why */
	const afresh = (why) => {
		io.log(`parked ${launchName(l)} not resumed: ${why}; launching afresh`);
		return null;
	};
	if ("afresh" in parked) return afresh(parked.afresh);
	const actsBefore = io.readActsBefore(l.root, parked.resume.sessionId);
	const r = io.resume(l, parked.resume);
	if (r.failed !== null) return afresh(r.failed);
	io.log(`resumed parked ${launchName(l)} as job ${r.jobId}`);
	return recordParkedResume(l, parked.resume, r, {
		launchedAt: io.now(),
		actsBefore,
		io,
	});
}

/**
 * The launch record of parked `l`'s resume `r` of `target` at `launchedAt`, the
 * resume written to the dispatch ledger as a launch (resumeParked).
 * @param {import("./refill-decide.js").Launch} l
 * @param {import("./refill-decide.js").ResumeTarget} target
 * @param {Extract<import("./refill-blocks.js").Resumed, {failed: null}>} r
 * @param {{launchedAt: number,
 *   actsBefore: NonNullable<import("./refill-loop.js").LoopLaunch["actsBefore"]>,
 *   io: Pick<ResumeIo, "recordLaunch"|"log">}} at
 * @returns {import("./refill-loop.js").LoopLaunch}
 */
function recordParkedResume(l, target, r, { launchedAt, actsBefore, io }) {
	if (
		!io.recordLaunch({
			issues: l.issues,
			model: l.model,
			prompt: l.prompt,
			root: l.root,
			jobId: r.jobId,
			launchedAt,
		})
	)
		io.log(
			`resume of ${launchName(l)} not written to the dispatch ledger: the idle alarm dates it from its last launch`,
		);
	return buildParkedRecord(l, target, r, { launchedAt, actsBefore });
}

/**
 * The launch record of parked `l`'s resume `r` of `target` at `launchedAt`.
 * @param {import("./refill-decide.js").Launch} l
 * @param {import("./refill-decide.js").ResumeTarget} target
 * @param {Extract<import("./refill-blocks.js").Resumed, {failed: null}>} r
 * @param {{launchedAt: number,
 *   actsBefore: NonNullable<import("./refill-loop.js").LoopLaunch["actsBefore"]>}} at
 * @returns {import("./refill-loop.js").LoopLaunch}
 */
function buildParkedRecord(l, target, r, { launchedAt, actsBefore }) {
	return {
		root: l.root,
		issues: l.issues,
		prompt: l.prompt,
		seat: target.seat,
		reason: "parked session's seat",
		jobId: r.jobId,
		launchedAt,
		finishedAt: null,
		...(r.sessionId ? { sessionId: r.sessionId } : {}),
		...(r.copy ? { pastSessionIds: [target.sessionId] } : {}),
		actsBefore,
		...(hasNothingToRepeat(target.parkCause) ? { nothingToRepeat: true } : {}),
		...limitParksOf(l),
	};
}

/**
 * @typedef {{at: number, batch: import("./refill-decide.js").Launch[]}}
 *   Launching  the batch the loop was launching from `at`, on record before
 *   its first member starts and gone with the tick's own write (#4180)
 */

/**
 * The members of `launching` that started, which a kill left out of the state
 * (#4180), recorded as the launch would have: a parked member routed to resume
 * whose session's job the store shows started since (lib/resumed-copy.js's
 * findResumed), handed what the session held; else a member the dispatch ledger
 * shows launched (readLaunched). The ledger row a parked resume owes is written
 * where the kill came first. A store that will not tell is logged, and the
 * member is looked for in the ledger alone.
 * Residual: a parked session woken in place has its acts since the wake read as
 * made before it.
 * @param {Launching} launching
 * @param {Pick<ResumeIo, "readActsBefore"|"recordLaunch"|"log"> &
 *   Pick<Parameters<typeof launchBatch>[1], "entriesOf"> & {
 *   adoptResumed: (l: import("./refill-decide.js").Launch,
 *     target: import("./refill-decide.js").ResumeTarget, since: number) =>
 *     import("./refill-blocks.js").Adopted}} io
 * @returns {import("./refill-loop.js").LoopLaunch[]}
 */
function adoptLaunching({ at, batch }, io) {
	const resumed = [];
	const rest = [];
	for (const l of batch) {
		const target =
			l.parkedRoute && "resume" in l.parkedRoute ? l.parkedRoute.resume : null;
		const r = target && io.adoptResumed(l, target, at);
		if (r && "unread" in r)
			io.log(
				`whether parked ${launchName(l)}'s resume started a job is unread: ${r.unread}`,
			);
		if (!target || !r || "unread" in r) {
			rest.push(l);
			continue;
		}
		const entry = io
			.entriesOf(l.root)
			.find(
				(e) =>
					e.jobId === r.jobId &&
					e.prompt === l.prompt &&
					Date.parse(e.ts) >= at - LEDGER_SLACK_MS,
			);
		const actsBefore = io.readActsBefore(l.root, target.sessionId);
		resumed.push(
			entry
				? buildParkedRecord(l, target, r, {
						launchedAt: Date.parse(entry.ts),
						actsBefore,
					})
				: recordParkedResume(l, target, r, { launchedAt: at, actsBefore, io }),
		);
	}
	return [...resumed, ...readLaunched(rest, at, io).launched];
}

/**
 * `batch` launched: each parked member the decision routed to resume resumed
 * in place (resumeParked), the rest and any not resumed through one
 * dispatcher call, `launchFresh`, which is skipped where none is left. Each
 * resume first passes the re-read the tick's resume step gives a stopped
 * session (#3872, #3855), and the next re-read waits out its spare; the first
 * it refuses is refused with every member behind it, for a later tick, so none
 * overtakes it.
 * @param {import("./refill-decide.js").Launch[]} batch one of batchesOf's
 * @param {ResumeIo & {launchFresh: (batch: import("./refill-decide.js").Launch[]) => BatchOutcome}} io
 * @returns {BatchOutcome}
 */
function launchOrResume(batch, io) {
	const resumed = [];
	const fresh = [];
	/** @type {Refusal[]} */
	const refused = [];
	/** @type {string|null} */
	let refusal = null;
	for (const l of batch) {
		if (refusal === null && l.parkedRoute && "resume" in l.parkedRoute)
			refusal = io.admitResume();
		if (refusal !== null) {
			refused.push({ launch: l, reason: refusal });
			continue;
		}
		const r = l.parkedRoute ? resumeParked(l, l.parkedRoute, io) : null;
		if (r) {
			resumed.push(r);
			io.stagger();
		} else fresh.push(l);
	}
	const out =
		fresh.length > 0 ? io.launchFresh(fresh) : { launched: [], refused: [] };
	return {
		...out,
		launched: [...resumed, ...out.launched],
		refused: [...refused, ...out.refused],
		resumeRefused: refusal,
	};
}

module.exports = {
	adoptLaunching,
	batchesOf,
	buildWouldRunLine,
	dispatchCall,
	launchBatch,
	launchOrResume,
	readStaggerMs,
};
