/*
 * refill-resume.js — the refill loop's resume of a stopped session (#2354 F6,
 * #2963, #3734, #3736, #4147, #4180): `claude --bg --resume`, the job it
 * started judged and confirmed, a copy handed what the session held, a move
 * onto another seat or onto an overflow key recorded. Every read, write and
 * child process goes through the ResumeIo port, whose production adapter is
 * lib/resume-io.js's; lib/refill-blocks.js's acts call these through its
 * BlockIo.
 */

const { childFailure } = require("./child-failure.js");
const { parseResumed } = require("./bg-resume.js");
const { shortJobId } = require("./job-paths.js");
const { transcriptPath } = require("./project-slug.js");
const { MODEL } = require("./refill-decide.js");
const { seatIdOf } = require("./refill-seats.js");
const { buildErrorText } = require("./caught.js");
const { movedOnto } = require("./refill-blocks.js");

/** @typedef {import("./refill-blocks.js").Resumed} Resumed */
/** @typedef {import("./refill-blocks.js").Adopted} Adopted */
/** @typedef {import("./refill-blocks.js").MoveTarget} MoveTarget */
/** @typedef {import("./refill-blocks.js").JobLaunch} JobLaunch */
/** @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch */
/** @typedef {ReturnType<typeof import("./child-spawn.js").spawnChild>} ChildRun */
/** @typedef {ReturnType<typeof import("./dispatch-ledger.js").readOverflowLookup>} OverflowLookup */

/**
 * The reads, writes and child processes a resume runs through.
 * @typedef {{
 *   log: (line: string) => void,
 *   env: () => NodeJS.ProcessEnv,
 *   keySettings: (keyVar: string) => {settings: string}|{why: string},
 *   authRefusal: (launch: {env: NodeJS.ProcessEnv, cwd: string,
 *     settings?: string}) => string|null,
 *   runClaude: (args: string[], opts: {cwd: string, env: NodeJS.ProcessEnv}) =>
 *     ChildRun,
 *   readJobRecord: (seat: string, jobId: string) => unknown,
 *   findResumed: typeof import("./resumed-copy.js").findResumed,
 *   copyTranscript: typeof import("./seat-move.js").copyTranscript,
 *   hasJobRecord: (seat: string, jobId: string) => boolean,
 *   stop: (seat: string, jobId: string) => import("./claude-stop.js").StopOutcome,
 *   overflowLookup: (root: string) => OverflowLookup,
 *   recordLaunch: typeof import("./dispatch-ledger.js").record,
 *   copySpendUsd: (file: string) => number,
 *   sessionSpendUsd: (file: string) => number,
 *   runArbiter: (root: string, cmd: "claim-issue"|"release-issue", n: number,
 *     sessionId: string) => ChildRun,
 *   movePassMarkers: typeof import("./move-pass-markers.js").movePassMarkers,
 *   moveParkedBy: typeof import("./parked.js").moveParkedBy,
 * }} ResumeIo
 */

/**
 * The resume steps over `io`.
 * @param {ResumeIo} io
 */
function resumeSteps(io) {
	const { log } = io;

	/**
	 * The environment a `claude` call on `l`'s seat runs in: `stop`, `attach`
	 * and the job record are scoped to CLAUDE_CONFIG_DIR.
	 * @param {{seat: string}} l
	 */
	const seatEnv = (l) =>
		/** @type {NodeJS.ProcessEnv} */ ({
			...io.env(),
			CLAUDE_CONFIG_DIR: l.seat,
		});

	/**
	 * The environment and `--settings` a `--bg` launch of `l`'s session hands
	 * its child: on an overflow seat, its key's helper and neither a key nor
	 * this process's session id, as dispatch-sessions.sh launches it (#3701);
	 * why not where the key cannot be read.
	 * @param {{seat: string, keyVar?: string}} l
	 * @returns {{env: NodeJS.ProcessEnv, settings?: string}|{why: string}}
	 */
	function buildSeatLaunch(l) {
		const env = seatEnv(l);
		if (!l.keyVar) return { env };
		const built = io.keySettings(l.keyVar);
		if ("why" in built) return built;
		delete env.ANTHROPIC_API_KEY;
		delete env.CLAUDE_CODE_SESSION_ID;
		delete env[l.keyVar];
		return { env, settings: built.settings };
	}

	/**
	 * `session-arbiter.js <cmd> <n>` as session `sessionId`, in `root`; what it
	 * printed, or null where it failed, logged.
	 * @param {string} root
	 * @param {"claim-issue"|"release-issue"} cmd
	 * @param {number} n
	 * @param {string} sessionId
	 */
	function arbiterAs(root, cmd, n, sessionId) {
		const r = io.runArbiter(root, cmd, n, sessionId);
		if (!r.failed) return r.out;
		log(`${cmd} #${n} as ${sessionId} failed: ${childFailure(r)}`);
		return null;
	}

	/**
	 * Move each issue claim session `from` holds on `l`'s issues to its copy's
	 * session `to` (#2963).
	 * @param {{root: string, issues: number[]}} l
	 * @param {string} from
	 * @param {string} to
	 */
	function moveClaims({ root, issues }, from, to) {
		for (const n of issues)
			if (arbiterAs(root, "release-issue", n, from)?.startsWith("Released"))
				arbiterAs(root, "claim-issue", n, to);
	}

	/**
	 * lib/parked.js's moveParkedBy for `l`. Fails open (#3709): a marker left
	 * names a job a resume then falls back from.
	 * @param {{root: string, issues: number[], seat: string, keyVar?: string}} l
	 * @param {string} from
	 * @param {{sessionId: string|null, jobId: string, cwd: string}} copy
	 */
	function moveParked(
		{ root, issues, seat, keyVar },
		from,
		{ sessionId, jobId, cwd },
	) {
		try {
			io.moveParkedBy(from, issues, {
				root,
				copySessionId: sessionId,
				job: { ...seatIdOf({ seat, keyVar }), jobId, cwd },
			});
		} catch (e) {
			log(`marker of ${from} not moved: ${buildErrorText(e)}`);
		}
	}

	/**
	 * lib/move-pass-markers.js's movePassMarkers for `l`. Fails open (#4105): a
	 * marker left only owes its pass again.
	 * @param {{root: string}} l
	 * @param {string} from
	 * @param {string} to
	 */
	function movePasses({ root }, from, to) {
		try {
			const left = io.movePassMarkers(root, from, to);
			if (left) log(`pass markers of ${from} not moved: ${left}`);
		} catch (e) {
			log(`pass markers of ${from} not moved: ${buildErrorText(e)}`);
		}
	}

	/**
	 * Mark an overflow session's copy overflow in the dispatch ledger, the only
	 * such mark a parking session can read (#4147), naming the session it copies
	 * so the cap prices the two together (#4195). No issues, so the row holds
	 * nothing: the first job keeps the ledger hold. Fails open, logged:
	 * unmarked, the copy's own park reads as a plan seat's.
	 * @param {{root: string, keyVar: string}} on
	 * @param {string} from the session it copies
	 * @param {{jobId: string, sessionId: string|null}} copy
	 */
	function recordOverflowCopy({ root, keyVar }, from, { jobId, sessionId }) {
		const failure = `overflow copy ${jobId} of ${from} not marked in the dispatch ledger`;
		try {
			const lookup = io.overflowLookup(root);
			/* Marked already where a kill came after the mark and before the
			 * state write, and the next step adopts the copy (#4157). */
			if (lookup({ jobId })) return;
			const first = lookup({ sessionId: from });
			if (!first) {
				log(`${failure}: no launch of ${from} on key=${keyVar} is recorded`);
				return;
			}
			const written = io.recordLaunch({
				issues: [],
				model: MODEL,
				prompt: `copy of ${from}`,
				root,
				jobId,
				overflow: {
					keyVar,
					allowanceUsd: first.allowanceUsd,
					sessionId,
					copyOf: from,
				},
			});
			if (!written) log(failure);
		} catch (e) {
			log(`${failure}: ${buildErrorText(e)}`);
		}
	}

	/**
	 * What a session moved onto a key carries in its new transcript from
	 * before the move, which its plan paid (#3736): a copy repeats its parent's
	 * main-thread requests (#4195), and a job woken in place keeps its whole
	 * session. Read off the parent's transcript the move put on `seat`.
	 * @param {{seat: string, from: string, cwd: string, copy: boolean}} moved
	 */
	function readOffKeyUsd({ seat, from, cwd, copy }) {
		const file = transcriptPath(seat, cwd, from);
		return copy ? io.copySpendUsd(file) : io.sessionSpendUsd(file);
	}

	/**
	 * Record the job a move onto an overflow seat started as a launch on its
	 * key, with the allowance it moved with (#3736), so the budget gate
	 * reserves for it and the allowance stop caps it as any overflow launch.
	 * No issues, as a copy's: the launch it moved keeps the ledger hold.
	 * @param {{root: string, keyVar: string}} on
	 * @param {string} from the session it moved
	 * @param {{jobId: string, sessionId: string|null, allowanceUsd: number,
	 *   offKeyUsd: number}} run
	 * @returns {string|null} why it was not recorded, else null
	 */
	function recordMovedOverflow({ root, keyVar }, from, run) {
		const failure = `moved overflow job ${run.jobId} of ${from} not recorded in the dispatch ledger`;
		try {
			/* Recorded already where a kill came after the record and before the
			 * state write, and the next step adopts the job (#4180). */
			if (io.overflowLookup(root)({ jobId: run.jobId })) return null;
			const written = io.recordLaunch({
				issues: [],
				model: MODEL,
				prompt: `move of ${from}`,
				root,
				jobId: run.jobId,
				overflow: {
					keyVar,
					allowanceUsd: run.allowanceUsd,
					sessionId: run.sessionId,
					offKeyUsd: run.offKeyUsd,
				},
			});
			return written ? null : failure;
		} catch (e) {
			return `${failure}: ${buildErrorText(e)}`;
		}
	}

	/**
	 * The dispatch-ledger row for job `run`, which a resume of session `from`
	 * started on `l`'s overflow seat, where it owes one: a move onto the key's
	 * first launch there, at its allowance (#3736), else a copy's, at its first
	 * job's. A plan seat's job, or one woken in place on its key, owes none.
	 * @param {{root: string, seat: string, keyVar?: string}} l
	 * @param {string} from
	 * @param {{jobId: string, sessionId: string|null}} run
	 * @param {{copy: boolean, cwd: string, move?: MoveTarget}} how  `move`, the
	 *   target of a move onto the key
	 * @returns {string|null} why a move's job could not be recorded, which stops
	 *   it, else null
	 */
	function recordOnKey({ root, seat, keyVar }, from, run, how) {
		if (!keyVar) return null;
		const { copy, move } = how;
		if (!move) {
			if (copy) recordOverflowCopy({ root, keyVar }, from, run);
			return null;
		}
		const failed =
			move.allowanceUsd === undefined
				? "no allowance read for the key"
				: recordMovedOverflow({ root, keyVar }, from, {
						...run,
						allowanceUsd: move.allowanceUsd,
						offKeyUsd: readOffKeyUsd({ seat, from, cwd: how.cwd, copy }),
					});
		if (!failed) return null;
		/* Unrecorded, it would run on the key uncapped and unreserved. */
		const stop = io.stop(seat, run.jobId);
		return stop.ok || stop.noJob
			? failed
			: `${failed}, and its job not stopped: ${stop.why}`;
	}

	/**
	 * The job a resume woke in place, confirmed or found after a kill; on a
	 * move onto a key, recorded as that key's launch.
	 * @param {{root: string, seat: string, keyVar?: string}} l
	 * @param {{sessionId: string, cwd: string}} target
	 * @param {{jobId: string, sessionId: string|null}} found
	 * @param {MoveTarget} [move]
	 * @returns {Resumed}
	 */
	function recordWoken(l, target, { jobId, sessionId }, move) {
		const unrecorded = recordOnKey(
			l,
			target.sessionId,
			{ jobId, sessionId },
			{ copy: false, cwd: target.cwd, move },
		);
		return unrecorded
			? { failed: unrecorded }
			: { failed: null, jobId, sessionId, copy: false };
	}

	/**
	 * A resume that woke the stopped job itself: confirmed where its
	 * state.json, which already names its session, reads it no longer stopped;
	 * on a move onto a key, recorded as that key's launch.
	 * @param {{root: string, seat: string, keyVar?: string}} l
	 * @param {{jobId: string, sessionId: string, cwd: string,
	 *   after: {state?: unknown, sessionId?: unknown}|null}} woken
	 * @param {MoveTarget} [move]
	 * @returns {Resumed}
	 */
	function settleWoken(l, { jobId, sessionId, cwd, after }, move) {
		if (after?.sessionId !== sessionId || after.state === "stopped")
			return {
				failed: `not confirmed: job ${jobId}'s state.json reads ${after?.state ?? "(unread)"}, session ${after?.sessionId ?? "(unread)"}, not ${sessionId}`,
			};
		return recordWoken(l, { sessionId, cwd }, { jobId, sessionId }, move);
	}

	/**
	 * Hand copy `copy` of session `from` what the session held: on an overflow
	 * seat its ledger mark, then its issue claims, pass markers and park
	 * marker. The mark comes first, so a move's copy that will not record, and
	 * is stopped, takes nothing from the session it leaves held.
	 * @param {{root: string, issues: number[], seat: string, keyVar?: string}} l
	 * @param {string} from
	 * @param {{jobId: string, sessionId: string|null, cwd: string}} copy
	 * @param {MoveTarget} [move] a move onto the key, whose allowance the copy,
	 *   that key's first launch of the session, runs at (#3736)
	 * @returns {Resumed} failed only where a move's job will not record, and is
	 *   stopped
	 */
	function settleCopy(l, from, copy, move) {
		const { jobId, sessionId } = copy;
		const unrecorded = recordOnKey(
			l,
			from,
			{ jobId, sessionId },
			{ copy: true, cwd: copy.cwd, move },
		);
		if (unrecorded) return { failed: unrecorded };
		if (sessionId) {
			moveClaims(l, from, sessionId);
			movePasses(l, from, sessionId);
		} else
			log(
				`no session id read for copy ${jobId}: its issue claims and pass markers not moved`,
			);
		moveParked(l, from, copy);
		return { failed: null, jobId, sessionId, copy: true };
	}

	/**
	 * `claude --bg --resume <full id> "<prompt>"` of `l`'s stopped job, from
	 * its cwd (#2354 F6). The launcher exits 0 whatever happens (F8). On
	 * 2.1.310 it wakes a stopped job in place, else starts a copy under a new
	 * job and session id, which carries the conversation on and takes the issue
	 * claims (#2963, #2968). An overflow session's carries its key's
	 * `--settings` (buildSeatLaunch), so it never bills the plan, and the flags
	 * always start a copy (#3692 (d)). The resume counts where the launcher
	 * named the job it started (lib/bg-resume.js) and that job's state.json
	 * does not read failed; a later tick judges the resumed turn.
	 * @param {{root: string, issues: number[], seat: string, keyVar?: string}} l
	 * @param {string} prompt
	 * @param {{sessionId: string, cwd: string}} target
	 * @param {MoveTarget} [move] the target of a move onto `l`'s seat, which
	 *   `l` already names
	 * @returns {Resumed}
	 */
	function resumeStopped(l, prompt, { sessionId, cwd }, move) {
		const launch = buildSeatLaunch(l);
		if ("why" in launch) return { failed: launch.why };
		const { env, settings } = launch;
		const refusal = io.authRefusal({ env, cwd, settings });
		if (refusal) return { failed: refusal };
		const keyArgs = settings === undefined ? [] : ["--settings", settings];
		const r = io.runClaude(
			["--bg", "--resume", sessionId, ...keyArgs, prompt],
			{
				cwd,
				env,
			},
		);
		return settleStarted(l, r, { sessionId, cwd }, move);
	}

	/**
	 * `l`'s full session id, the listing's else its job record's, and its job's
	 * cwd, else its checkout.
	 * @param {JobLaunch} l
	 * @returns {import("./refill-blocks.js").ResumeTarget}
	 */
	function resumeTargetOf(l) {
		const job = /** @type {{sessionId?: unknown, cwd?: unknown}|null} */ (
			l.jobId ? io.readJobRecord(l.seat, l.jobId) : null
		);
		return {
			sessionId:
				l.sessionId ??
				(typeof job?.sessionId === "string" ? job.sessionId : null),
			cwd: typeof job?.cwd === "string" ? job.cwd : l.root,
		};
	}

	/**
	 * resumeStopped's launcher run judged: the job it named, woken in place or
	 * a copy, settled.
	 * @param {{root: string, issues: number[], seat: string, keyVar?: string}} l
	 * @param {ChildRun} r
	 * @param {{sessionId: string, cwd: string}} target
	 * @param {MoveTarget} [move]
	 * @returns {Resumed}
	 */
	function settleStarted(l, r, { sessionId, cwd }, move) {
		const failed = childFailure(r);
		if (failed) return { failed };
		const started = parseResumed(r);
		if (!started)
			return {
				failed: `the launcher never said what it started: ${r.out.split("\n").pop()}`,
			};
		const { jobId } = started;
		const after = /** @type {{state?: unknown, detail?: unknown,
			sessionId?: unknown}|null} */ (io.readJobRecord(l.seat, jobId));
		if (after?.state === "failed")
			return { failed: `state failed: ${after.detail}` };
		if (!started.copy)
			return settleWoken(l, { jobId, sessionId, cwd, after }, move);
		const copySession =
			typeof after?.sessionId === "string" ? after.sessionId : null;
		return settleCopy(
			l,
			sessionId,
			{ jobId, sessionId: copySession, cwd },
			move,
		);
	}

	/**
	 * lib/resumed-copy.js's findResumed for `l`'s seat, past `l`'s earlier
	 * sessions: a copy found is handed what the session held (#4157, #4180);
	 * why not, where the job store or a transcript will not read.
	 * @param {{root: string, issues: number[], seat: string, keyVar?: string,
	 *   pastSessionIds?: string[]}} l
	 * @param {{sessionId: string, cwd: string}} target
	 * @param {number} since
	 * @param {MoveTarget} [move] the target of a move onto `l`'s seat, which
	 *   `l` already names
	 * @returns {Adopted}
	 */
	function adoptResumed(l, target, since, move) {
		const found = io.findResumed(l.seat, target, since, l.pastSessionIds ?? []);
		if (found === null || "unread" in found) return found;
		const { jobId, sessionId } = found;
		const r = found.copy
			? settleCopy(
					l,
					target.sessionId,
					{ jobId, sessionId, cwd: target.cwd },
					move,
				)
			: recordWoken(l, target, { jobId, sessionId }, move);
		/* A move's job that will not record is stopped, so it reads as no job. */
		return r.failed === null ? r : { unread: r.failed };
	}

	/**
	 * Remove any job record for session `sessionId`'s short id on seat `seat`
	 * (`claude rm`, which keeps transcripts); null once none is left, else why
	 * not.
	 * @param {string} seat
	 * @param {string} sessionId
	 * @param {string} cwd
	 */
	function removeJobRecord(seat, sessionId, cwd) {
		const jobId = shortJobId(sessionId);
		if (!io.hasJobRecord(seat, jobId)) return null;
		const failed = childFailure(
			io.runClaude(["rm", jobId], { cwd, env: seatEnv({ seat }) }),
		);
		return failed && `removing its stale job record on ${seat}: ${failed}`;
	}

	/**
	 * Carry `l`'s stopped session to seat `target` and resume it there under
	 * its own session id (#2159's steps, #3734): its transcript copied, any job
	 * record for it on `target` removed so its resume keeps the id instead of
	 * starting a copy, then resumeStopped under `target`, which reads back the
	 * job's state. A resume that failed may still be starting, so it is
	 * stopped, and two live processes never share the id; the old seat's
	 * transcript is left whole, for its next try.
	 * @param {JobLaunch} l
	 * @param {MoveTarget} target
	 * @param {string} prompt
	 * @param {{sessionId: string, cwd: string}} ids
	 * @returns {Resumed}
	 */
	function moveSession(l, target, prompt, ids) {
		const { seat } = target;
		const { sessionId, cwd } = ids;
		const prepared =
			io.copyTranscript({ from: l.seat, to: seat, sessionId, cwd }) ??
			removeJobRecord(seat, sessionId, cwd);
		if (prepared) return { failed: prepared };
		const r = resumeStopped(movedOnto(l, target), prompt, ids, target);
		if (r.failed === null) return r;
		const stop = io.stop(seat, shortJobId(sessionId));
		if (!stop.ok && !stop.noJob)
			log(
				`could not stop ${shortJobId(sessionId)}'s failed resume: ${stop.why}`,
			);
		return r;
	}

	return {
		adoptResumed,
		moveSession,
		removeJobRecord,
		resumeStopped,
		resumeTargetOf,
		seatEnv,
	};
}

module.exports = { resumeSteps };
