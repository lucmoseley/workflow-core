/*
 * refill-batch.js — the refill loop's launch step: a tick's launches grouped
 * into one dispatcher call per repo and seat (#2196), each call run, and its
 * members' records read back from the dispatch ledger. A module of its own
 * (#3265) so the launch step changes alone and is driven directly, with the
 * spawn, the ledger and the clock passed in.
 */

const { checkoutEnv } = require("./refill-repos.js");

/* Untraced: the dispatcher call's one-off gates and a `claude --bg` that hangs
 * up to dispatch-sessions.sh's own launch ceiling. */
const DISPATCH_FIXED_MS = 10 * 60 * 1000;
/* Untraced: a member's 120 s launch ceiling, about 9 s of admission and the
 * 2 s stagger, rounded up (#2196). */
const DISPATCH_MEMBER_MS = 150 * 1000;
/* The slack covers the clock read before the spawn. */
const LEDGER_SLACK_MS = 1000;

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
 * headless launch the dispatcher makes there (#2611).
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
 * @typedef {{launched: import("./refill-loop.js").LoopLaunch[], refused: Refusal[]}} BatchOutcome
 */

/* The dispatcher's per-member lines parseRefusalReason keys on, which a test
 * pins to dispatch-sessions.sh's printf formats through launchBatch. */
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
 * the call's last set-level refusal or its exit (#2500).
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
 * from the start (#2611): a run ending before any listing shows it still has
 * its acts read.
 * @param {import("./refill-decide.js").Launch[]} batch one of batchesOf's
 * @param {{dispatcher: string, env: NodeJS.ProcessEnv,
 *   run: (call: ReturnType<typeof dispatchCall>) => {failed: string|null, out: string},
 *   entriesOf: (root: string) => import("./dispatch-ledger.js").DispatchRecord[],
 *   sessionOf: (jobId: string) => string|undefined, now: () => number}} io
 *   `sessionOf` is lib/headless-sessions.js's record of the job, undefined
 *   for any other; `now` is read once, before the call
 * @returns {BatchOutcome & {tried: import("./refill-decide.js").Launch[],
 *   failed: string|null, out: string}}
 */
function launchBatch(batch, io) {
	const call = dispatchCall(batch, io.dispatcher, io.env);
	const calledAt = io.now();
	const r = io.run(call);
	const entries = io
		.entriesOf(call.cwd)
		.filter((e) => Date.parse(e.ts) >= calledAt - LEDGER_SLACK_MS);
	/** @type {import("./refill-loop.js").LoopLaunch[]} */
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

module.exports = {
	batchesOf,
	buildWouldRunLine,
	dispatchCall,
	launchBatch,
};
