const { hasNothingToRepeat } = require("./loop-prompts.js");
const {
	buildResumedHow,
	launchName,
	withUnretired,
} = require("./refill-block-core.js");
const { buildCheckoutEnv } = require("./refill-repos.js");
const { carriedOnto, parkedCarryOf } = require("./refill-carry.js");
const { seatIdOf } = require("./refill-seats.js");
const {
	DEFAULT_STAGGER_SECONDS,
	MEMBER_REFUSED_TAIL,
	memberDropped,
	memberRefused,
} = require("./dispatch-sessions.js");

// guess, #2315
const DISPATCH_FIXED_MS = 10 * 60 * 1000;
// guess, #2196
const DISPATCH_MEMBER_MS = 150 * 1000;
// guess, #2012
const LEDGER_SLACK_MS = 1000;

/** @param {NodeJS.ProcessEnv} [env] */
function readStaggerMs(env = process.env) {
	const seconds = Number(
		env.WFC_DISPATCH_STAGGER_SECONDS || DEFAULT_STAGGER_SECONDS,
	);
	return (Number.isNaN(seconds) ? DEFAULT_STAGGER_SECONDS : seconds) * 1000;
}

/**
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
 * @param {import("./refill-decide.js").Launch[]} batch
 * @param {string} dispatcher
 * @param {NodeJS.ProcessEnv} env
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
		file: dispatcher,
		args: batch.flatMap((l) => [l.model, l.prompt]),
		cwd: root,
		env: childEnv,
		timeout: DISPATCH_FIXED_MS + DISPATCH_MEMBER_MS * batch.length,
	};
}

/** @param {ReturnType<typeof dispatchCall>} call */
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
 *   resumeRefused?: string|null}} BatchOutcome
 * @typedef {{resume: (l: import("./refill-decide.js").Launch,
 *   target: import("./refill-decide.js").ResumeTarget) =>
 *   import("./refill-blocks.js").Resumed,
 *   readActsBefore: import("./refill-blocks.js").ReadActsBefore,
 *   admitResume: (root: string) => string|null, stagger: () => void,
 *   recordLaunch: typeof import("./dispatch-ledger.js").record,
 *   log: (line: string) => void, now: () => number}} ResumeIo
 */

const SET_HEADER = /^\s*(REFUSED: |DROPPING |CAPPED: )/;
const ADMISSION_HOLD = /^slots 0 — HOLD\b/;
/** @param {string} reason */
const isAdmissionHold = (reason) => ADMISSION_HOLD.test(reason);

/**
 * @param {string} out
 * @param {string} prompt
 * @param {string|null} failed
 */
function parseRefusalReason(out, prompt, failed) {
	const lines = out.split("\n");
	const isSetHeader = (/** @type {string} */ l) =>
		SET_HEADER.test(l) && !l.endsWith(MEMBER_REFUSED_TAIL);
	const at = lines.indexOf(memberRefused(prompt));
	if (at !== -1) {
		const end = lines.findIndex((l, i) => i > at && !l.startsWith("  "));
		const block = lines
			.slice(at + 1, end === -1 ? undefined : end)
			.map((l) => l.trim().replace(/\s+/g, " "))
			.filter(Boolean);
		return (
			block.find((l) => l.startsWith("slots ")) ??
			block[0] ??
			memberRefused(prompt)
		);
	}
	const dropped = lines.findIndex((l) => l.trim() === memberDropped(prompt));
	if (dropped !== -1)
		return (
			lines.slice(0, dropped).findLast(isSetHeader)?.trim() ??
			memberDropped(prompt)
		);
	if (failed)
		return lines.findLast(isSetHeader)?.trim() ?? `dispatcher ${failed}`;
	return "no ledger entry written for it";
}

/** @param {import("./refill-decide.js").Launch} l */
const limitParksOf = (l) =>
	l.parkedRoute?.limitParks ? { limitParks: l.parkedRoute.limitParks } : {};

/**
 * @param {import("./refill-decide.js").Launch[]} batch
 * @param {{dispatcher: string, env: NodeJS.ProcessEnv,
 *   run: (call: ReturnType<typeof dispatchCall>) => {failed: string|null, out: string},
 *   entriesOf: (root: string) => import("./dispatch-ledger.js").DispatchRecord[],
 *   sessionOf: (jobId: string) => string|undefined, now: () => number}} io
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
	const held = new Set(
		refused.filter((f) => isAdmissionHold(f.reason)).map((f) => f.launch),
	);
	const tried = (r.failed ? reached : batch).filter((l) => !held.has(l));
	return { launched, refused, tried, ...r };
}

/**
 * @param {import("./refill-decide.js").Launch[]} batch
 * @param {number} calledAt
 * @param {Pick<Parameters<typeof launchBatch>[1], "entriesOf"|"sessionOf">} io
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
		const sessionId =
			entry.jobId === null ? undefined : io.sessionOf(entry.jobId);
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
			...(l.releaseBump ? { releaseBump: l.releaseBump } : {}),
			...(sessionId === undefined ? {} : { sessionId }),
			...limitParksOf(l),
		});
	}
	return { launched, reached, missing };
}

/**
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
	io.log(`resumed parked ${launchName(l)}, ${buildResumedHow(r)}`);
	return recordParkedResume(l, parked.resume, r, {
		launchedAt: io.now(),
		actsBefore,
		io,
	});
}

/**
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
 * @param {import("./refill-decide.js").Launch} l
 * @param {import("./refill-decide.js").ResumeTarget} target
 * @param {Extract<import("./refill-blocks.js").Resumed, {failed: null}>} r
 * @param {{launchedAt: number,
 *   actsBefore: NonNullable<import("./refill-loop.js").LoopLaunch["actsBefore"]>}} at
 * @returns {import("./refill-loop.js").LoopLaunch}
 */
function buildParkedRecord(l, target, r, { launchedAt, actsBefore }) {
	const { from, to } = parkedCarryOf(target);
	/** @type {import("./refill-loop.js").LoopLaunch} */
	const record = {
		root: l.root,
		issues: l.issues,
		prompt: l.prompt,
		seat: target.seat,
		reason: "parked session's seat",
		...carriedOnto(from, to),
		jobId: r.jobId,
		launchedAt,
		finishedAt: null,
		...(r.sessionId ? { sessionId: r.sessionId } : {}),
		...(r.copy ? { pastSessionIds: [target.sessionId] } : {}),
		actsBefore,
		...(hasNothingToRepeat(target.parkCause) ? { nothingToRepeat: true } : {}),
		...limitParksOf(l),
	};
	return withUnretired(record, r);
}

/** @typedef {{at: number, batch: import("./refill-decide.js").Launch[]}} Launching */

/**
 * @param {Launching} launching
 * @param {Pick<ResumeIo, "readActsBefore"|"recordLaunch"|"log"> &
 *   Pick<Parameters<typeof launchBatch>[1], "entriesOf"|"sessionOf"> & {
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
 * @param {import("./refill-decide.js").Launch[]} batch
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
			refusal = io.admitResume(l.root);
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
