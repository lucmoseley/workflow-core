/*
 * refill-resume.js — the refill loop's resume of a stopped session (#2354 F6,
 * #2963, #3734, #3736, #4147, #4180, #4098): `claude --bg --resume`, the job
 * it started judged and confirmed, a copy handed what the session held and
 * its original's row retired, a session a restart killed resumed under its
 * own id, a move onto another seat or onto an overflow key recorded. A
 * session on an overflow key resumes headless instead
 * (lib/headless-sessions.js, #4580), since the key's credits cover `claude -p`
 * and not a `--bg` job (#4578). Every read, write and child process goes
 * through the ResumeIo port, whose production adapter is lib/resume-io.js's;
 * lib/refill-blocks.js's acts call these through its BlockIo.
 */

const { childFailure } = require("./child-failure.js");
const { parseResumed } = require("./bg-resume.js");
const { shortJobId } = require("./job-paths.js");
const { transcriptPath } = require("./project-slug.js");
const { MODEL } = require("./refill-decide.js");
const { seatIdOf } = require("./refill-seats.js");
const { buildSeatEnv } = require("./seat-claude.js");
const { buildErrorText } = require("./caught.js");
const { movedOnto } = require("./refill-limits.js");
const { buildLaunchRecordReader } = require("./launch-record.js");

/** @typedef {import("./refill-blocks.js").Resumed} Resumed */
/** @typedef {import("./refill-blocks.js").Adopted} Adopted */
/** @typedef {import("./refill-limits.js").MoveTarget} MoveTarget */
/** @typedef {import("./refill-blocks.js").JobLaunch} JobLaunch */
/** @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch */
/**
 * @typedef {Pick<import("./refill-blocks.js").SessionRef, "root"|"seat"|"keyVar">
 *   & {issues: number[]}} Resumable  the session a resume runs on: its
 *   checkout, its seat and any overflow key, and the issues whose claims
 *   follow a copy
 * @typedef {Omit<Resumable, "issues"> & {issues?: number[]}} StoppedResumable
 *   a stopped session, whose issues one the loop did not launch leaves out:
 *   none, so a copy of it moves no claims (#4825)
 */
/** @typedef {ReturnType<typeof import("./child-spawn.js").spawnChild>} ChildRun */
/** @typedef {import("./dispatch-ledger.js").OverflowLookup} OverflowLookup */

/**
 * The reads, writes and child processes a resume runs through.
 * @typedef {{
 *   log: (line: string) => void,
 *   env: () => NodeJS.ProcessEnv,
 *   authRefusal: (launch: {env: NodeJS.ProcessEnv, cwd: string}) =>
 *     string|null,
 *   settingsLockout: (cwd: string) => string|null,
 *   launchHeadless: typeof import("./headless-sessions.js").launch,
 *   findHeadlessRun: typeof import("./headless-runs.js").findRunSince,
 *   readRunAsJob: typeof import("./headless-runs.js").readRunAsJob,
 *   runClaude: (args: string[], opts: {cwd: string, env: NodeJS.ProcessEnv}) =>
 *     ChildRun,
 *   readJobRecord: (seat: string, jobId: string) =>
 *     import("./launch-record.js").LaunchRecord|null,
 *   findResumed: typeof import("./resumed-copy.js").findResumed,
 *   copyTranscript: typeof import("./seat-move.js").copyTranscript,
 *   hasJobRecord: (seat: string, jobId: string) => boolean,
 *   writeJobName: typeof import("./job-name.js").writeJobName,
 *   stop: (seat: string, jobId: string) => import("./claude-stop.js").StopOutcome,
 *   overflowLookup: (root: string) => OverflowLookup,
 *   recordLaunch: typeof import("./dispatch-ledger.js").record,
 *   copySpendUsd: (file: string) => number,
 *   sessionSpendUsd: (file: string) => number,
 *   sessionName: typeof import("./session-name.js").readSessionName,
 *   moveIssueClaim: (root: string, n: number, from: string, to: string)
 *     => ChildRun,
 *   movePassMarkers: typeof import("./move-pass-markers.js").movePassMarkers,
 *   moveParkedBy: typeof import("./parked.js").moveParkedBy,
 * }} ResumeIo
 */

/**
 * The launch flags job record `rec` saved (`respawnFlags`), null where it
 * saved none.
 * @param {import("./launch-record.js").LaunchRecord|null} rec
 * @returns {string[]|null}
 */
function savedFlagsOf(rec) {
	const saved = rec?.respawnFlags;
	return Array.isArray(saved) &&
		saved.every((/** @type {unknown} */ f) => typeof f === "string")
		? saved
		: null;
}

/* A copy adoptResumed found: the kill took the launcher's note with it. */
const ADOPTED_WHY = "found after a kill, the harness's reason lost with it";

/**
 * The resume steps over `io`.
 * @param {ResumeIo} io
 */
function resumeSteps(io) {
	const { log } = io;
	const readLaunchRecord = buildLaunchRecordReader(io);

	/**
	 * Move each issue claim session `from` holds on `l`'s issues to its copy's
	 * session `to` (#2963).
	 * @param {Resumable} l
	 * @param {string} from
	 * @param {string} to
	 */
	function moveClaims({ root, issues }, from, to) {
		for (const n of issues) {
			const r = io.moveIssueClaim(root, n, from, to);
			if (r.failed)
				log(
					`move-issue #${n} from ${from} to ${to} failed: ${childFailure(r)}`,
				);
		}
	}

	/**
	 * lib/parked.js's moveParkedBy for `l`. Fails open (#3709): a marker left
	 * names a job a resume then falls back from.
	 * @param {Resumable} l
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
	 * marker, then its name, and retire the original's job row, so one row of
	 * the work is left to revive (#4098). The mark comes first, so a move's
	 * copy that will not record, and is stopped, takes nothing from the
	 * session it leaves held.
	 * @param {Resumable} l
	 * @param {string} from
	 * @param {{jobId: string, sessionId: string|null, cwd: string,
	 *   why: string}} copy  `why`, the reason the harness gave for the copy
	 * @param {MoveTarget} [move] a move onto the key, whose allowance the copy,
	 *   that key's first launch of the session, runs at (#3736)
	 * @returns {Resumed} failed only where a move's job will not record, and is
	 *   stopped; `unretired`, the original whose job would not retire, for a
	 *   later tick's retireOriginals (#4646)
	 */
	function settleCopy(l, from, copy, move) {
		const { jobId, sessionId, why } = copy;
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
		nameCopy(l.seat, from, copy);
		/** @type {Resumed} */
		const settled = { failed: null, jobId, sessionId, copy: true, why };
		const retired = retireJob(l.seat, from, copy.cwd);
		if (!retired) return settled;
		log(
			`original ${shortJobId(from)} of copy ${jobId} not retired: ${retired}`,
		);
		const unretired = {
			seat: l.seat,
			sessionId: from,
			cwd: copy.cwd,
			copyJobId: jobId,
			tries: 1,
		};
		return { ...settled, unretired };
	}

	/**
	 * The name session `sessionId`'s transcript on `seat` carries
	 * (lib/session-name.js's readSessionName).
	 * @param {string} seat
	 * @param {string} cwd
	 * @param {string} sessionId
	 */
	const readTranscriptName = (seat, cwd, sessionId) =>
		io.sessionName(transcriptPath(seat, cwd, sessionId));

	/**
	 * Give copy `copy` of session `from` the name `from`'s transcript carries,
	 * which a copy does not take with it (#4098); logged where it will not.
	 * @param {string} seat
	 * @param {string} from
	 * @param {{jobId: string, cwd: string}} copy
	 */
	function nameCopy(seat, from, { jobId, cwd }) {
		const read = readTranscriptName(seat, cwd, from);
		const name = "name" in read ? read.name : null;
		const failed = name
			? io.writeJobName(seat, jobId, name)
			: `no name read for ${from}${"why" in read ? `: ${read.why}` : ""}`;
		if (failed) log(`copy ${jobId} of ${from} not named: ${failed}`);
	}

	/**
	 * Stop session `sessionId`'s own job on `seat`, the one under its short id,
	 * and remove its job record (`claude rm`, which keeps transcripts); null
	 * once no record of it is left, or the record there names another
	 * session, else why not. A job not confirmed stopped is never removed,
	 * since `claude rm` drops a live job's row too.
	 * @param {string} seat
	 * @param {string} sessionId
	 * @param {string} cwd
	 */
	function retireJob(seat, sessionId, cwd) {
		const jobId = shortJobId(sessionId);
		if (!io.hasJobRecord(seat, jobId)) return null;
		if (io.readJobRecord(seat, jobId)?.sessionId !== sessionId) return null;
		const stop = io.stop(seat, jobId);
		if (!stop.ok && !stop.noJob)
			return `its job ${jobId} not confirmed stopped: ${stop.why}`;
		return removeJobRecord(seat, sessionId, cwd);
	}

	/**
	 * The name `l`'s session takes moved onto a key: the name its row shows,
	 * else its prompt; the headless launcher adds the overflow prefix (#4395).
	 * @param {JobLaunch} l
	 * @param {{sessionId: string, cwd: string}} ids
	 */
	function readMovedName(l, { sessionId, cwd }) {
		const read = readTranscriptName(l.seat, cwd, sessionId);
		if ("why" in read)
			log(
				`${sessionId}'s name not read, so named after its prompt: ${read.why}`,
			);
		return ("name" in read && read.name) || l.prompt;
	}

	/**
	 * `claude --bg --resume <full id> "<prompt>"` of `l`'s stopped job, from
	 * its cwd (#2354 F6). The launcher exits 0 whatever happens (F8). On
	 * 2.1.310 it wakes a stopped job in place, else starts a copy under a new
	 * job and session id, which carries the conversation on and takes the issue
	 * claims (#2963, #2968). The resume counts where the launcher named the
	 * job it started (lib/bg-resume.js) and that job's state.json does not
	 * read failed; a later tick judges the resumed turn. A session on an
	 * overflow key resumes headless instead (resumeHeadless), which refuses a
	 * cwd whose own settings would lock the resumed session out
	 * (lib/settings-lockout.js, #4752); a `--bg` one is refused here.
	 * @param {StoppedResumable} session
	 * @param {string} prompt
	 * @param {{sessionId: string, cwd: string}} target
	 * @param {{move?: MoveTarget, name?: string, flags?: string[]}} [moved]
	 *   `move`, the target of a move onto `l`'s seat, which `l` already names;
	 *   `name`, the name the resumed job takes, which left out keeps the
	 *   session's; `flags`, launch flags passed before it
	 * @returns {Resumed}
	 */
	function resumeStopped(session, prompt, target, moved = {}) {
		if (!session.keyVar) {
			const lockout = io.settingsLockout(target.cwd);
			if (lockout) return { failed: lockout };
		}
		return startResume(session, prompt, target, moved);
	}

	/**
	 * resumeStopped's launch, once its worktree's settings are cleared.
	 * @param {StoppedResumable} session
	 * @param {string} prompt
	 * @param {{sessionId: string, cwd: string}} target
	 * @param {{move?: MoveTarget, name?: string, flags?: string[]}} [moved]
	 * @returns {Resumed}
	 */
	function startResume(
		session,
		prompt,
		{ sessionId, cwd },
		{ move, name, flags = [] } = {},
	) {
		const l = { ...session, issues: session.issues ?? [] };
		if (l.keyVar)
			return resumeHeadless({ ...l, keyVar: l.keyVar }, prompt, {
				sessionId,
				cwd,
				move,
				name,
			});
		const env = buildSeatEnv(io.env(), l.seat);
		const refusal = io.authRefusal({ env, cwd });
		if (refusal) return { failed: refusal };
		const nameArgs = name === undefined ? [] : ["-n", name];
		const r = io.runClaude(
			["--bg", "--resume", sessionId, ...flags, ...nameArgs, prompt],
			{
				cwd,
				env,
			},
		);
		return settleStarted(l, r, { sessionId, cwd }, move);
	}

	/**
	 * Resume `l`'s session, which a restart killed, under its own id (#4098):
	 * its job's saved launch flags taken from `ids`, as read before any try
	 * removed its record, else read now, the job stopped and its record
	 * removed, then started as resumeStopped starts one, with those flags,
	 * stopped again where it failed. Nothing is stopped where its cwd's own
	 * settings would lock it out (#4752). The 2.1.319 harness starts a copy of a resume carrying flags only while a job record exists, so one
	 * removed continues under the session's id with its name and model. A
	 * record naming another session is left, and the harness copies; a session
	 * on an overflow key resumes headless, under its id already.
	 * @param {Resumable} l
	 * @param {string} prompt
	 * @param {{sessionId: string, cwd: string, flags?: string[]}} ids
	 * @returns {Resumed}
	 */
	function resumeOwnId(l, prompt, ids) {
		if (l.keyVar) return startResume(l, prompt, ids);
		const lockout = io.settingsLockout(ids.cwd);
		if (lockout) return { failed: lockout };
		const refusal = io.authRefusal({
			env: buildSeatEnv(io.env(), l.seat),
			cwd: ids.cwd,
		});
		if (refusal) return { failed: refusal };
		const flags = ids.flags ?? resumeFlagsOf(l, ids);
		const retired = retireJob(l.seat, ids.sessionId, ids.cwd);
		if (retired) return { failed: retired };
		const r = startResume(l, prompt, ids, { flags });
		if (r.failed !== null) stopFailed(l.seat, ids.sessionId);
		return r;
	}

	/**
	 * Stop what a failed resume of session `sessionId` on `seat` may still be
	 * starting under its id, so two live processes never share it; logged
	 * where it will not stop.
	 * @param {string} seat
	 * @param {string} sessionId
	 */
	function stopFailed(seat, sessionId) {
		const stop = io.stop(seat, shortJobId(sessionId));
		if (!stop.ok && !stop.noJob)
			log(
				`could not stop ${shortJobId(sessionId)}'s failed resume: ${stop.why}`,
			);
	}

	/**
	 * The launch flags to resume `ids` under its own id with: those its own job
	 * record saved (`respawnFlags`); where it saved none, the loop's model and the name
	 * `ids`'s transcript carries.
	 * @param {{seat: string}} l
	 * @param {{sessionId: string, cwd: string}} ids
	 * @returns {string[]}
	 */
	function resumeFlagsOf(l, { sessionId, cwd }) {
		const rec = io.readJobRecord(l.seat, shortJobId(sessionId));
		const saved = rec?.sessionId === sessionId ? savedFlagsOf(rec) : null;
		if (saved) return saved;
		const read = readTranscriptName(l.seat, cwd, sessionId);
		const name = "name" in read ? read.name : null;
		log(
			`no saved launch flags read for ${sessionId}: resumed with the loop's model${name ? " and its transcript's name" : ""}`,
		);
		return ["--model", MODEL, ...(name ? ["--name", name] : [])];
	}

	/**
	 * `claude -p --resume <session id> "<prompt>"` of `l`'s session on its
	 * overflow key, through lib/headless-sessions.js, which hands it the key's
	 * `--settings` under the seat's dir. The run keeps the session id under a
	 * job of its own, so it holds the session's claims as a job woken in place
	 * does; a move onto the key records that job as the key's launch, capped
	 * at the allowance it moved with.
	 * @param {Resumable & {keyVar: string}} l
	 * @param {string} prompt
	 * @param {{sessionId: string, cwd: string, move?: MoveTarget,
	 *   name?: string}} run
	 * @returns {Resumed}
	 */
	function resumeHeadless(l, prompt, { sessionId, cwd, move, name }) {
		const r = io.launchHeadless({
			keyVar: l.keyVar,
			cwd,
			prompt,
			resume: sessionId,
			...(name === undefined ? {} : { name }),
			...(move?.allowanceUsd === undefined
				? {}
				: { budgetUsd: move.allowanceUsd }),
		});
		if ("why" in r) return { failed: r.why };
		return recordWoken(
			l,
			{ sessionId, cwd },
			{ jobId: r.record.jobId, sessionId },
			move,
		);
	}

	/**
	 * `l`'s full session id, the listing's else its job record's, its job's
	 * cwd, else its checkout, and the launch flags its job record saved.
	 * @param {import("./refill-blocks.js").SessionRef} l
	 * @returns {import("./refill-blocks.js").ResumeTarget}
	 */
	function readResumeTarget(l) {
		const job = readLaunchRecord(l);
		const flags = savedFlagsOf(job);
		return {
			sessionId:
				l.sessionId ??
				(typeof job?.sessionId === "string" ? job.sessionId : null),
			cwd: typeof job?.cwd === "string" ? job.cwd : l.root,
			...(flags ? { flags } : {}),
		};
	}

	/**
	 * resumeStopped's launcher run judged: the job it named, woken in place or
	 * a copy, settled.
	 * @param {Resumable} l
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
			{ jobId, sessionId: copySession, cwd, why: started.why },
			move,
		);
	}

	/**
	 * lib/resumed-copy.js's findResumed for `l`'s seat, past `l`'s earlier
	 * sessions: a copy found is handed what the session held (#4157, #4180);
	 * why not, where the job store or a transcript will not read. On an
	 * overflow key, adoptHeadless.
	 * @param {Resumable & {pastSessionIds?: string[]}} l
	 * @param {{sessionId: string, cwd: string}} target
	 * @param {number} since
	 * @param {MoveTarget} [move] the target of a move onto `l`'s seat, which
	 *   `l` already names
	 * @returns {Adopted}
	 */
	function adoptResumed(l, target, since, move) {
		if (l.keyVar) return adoptHeadless(l, target, since, move);
		const found = io.findResumed(l.seat, target, since, l.pastSessionIds ?? []);
		if (found === null || "unread" in found) return found;
		const { jobId, sessionId } = found;
		const r = found.copy
			? settleCopy(
					l,
					target.sessionId,
					{ jobId, sessionId, cwd: target.cwd, why: ADOPTED_WHY },
					move,
				)
			: recordWoken(l, target, { jobId, sessionId }, move);
		/* A move's job that will not record is stopped, so it reads as no job. */
		return r.failed === null ? r : { unread: r.failed };
	}

	/**
	 * adoptResumed on an overflow key: the headless run of the session
	 * launched since, from the run store.
	 * @param {Resumable} l
	 * @param {{sessionId: string, cwd: string}} target
	 * @param {number} since
	 * @param {MoveTarget} [move]
	 * @returns {Adopted}
	 */
	function adoptHeadless(l, target, since, move) {
		let run;
		try {
			run = io.findHeadlessRun(target.sessionId, since);
		} catch (e) {
			return { unread: buildErrorText(e) };
		}
		if (!run) return null;
		const r = recordWoken(l, target, run, move);
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
			io.runClaude(["rm", jobId], { cwd, env: buildSeatEnv(io.env(), seat) }),
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
		const name = target.keyVar ? readMovedName(l, ids) : undefined;
		const r = resumeStopped(movedOnto(l, target), prompt, ids, {
			move: target,
			name,
		});
		if (r.failed === null) return r;
		stopFailed(seat, sessionId);
		return r;
	}

	return {
		adoptResumed,
		moveSession,
		readResumeTarget,
		removeJobRecord,
		resumeOwnId,
		resumeStopped,
		retireJob,
	};
}

module.exports = { resumeSteps };
