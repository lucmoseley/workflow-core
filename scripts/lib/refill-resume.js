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
const { buildCarriedNote } = require("./carry-job-files.js");
const { parseModelFlag, relaunchFlags } = require("./model-table.js");

/** @typedef {import("./refill-blocks.js").Resumed} Resumed */
/** @typedef {import("./refill-blocks.js").Adopted} Adopted */
/** @typedef {import("./refill-limits.js").MoveTarget} MoveTarget */
/** @typedef {import("./refill-blocks.js").JobLaunch} JobLaunch */
/** @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch */
/**
 * @typedef {Pick<import("./refill-blocks.js").SessionRef, "root"|"seat"|"keyVar">
 *   & {issues: number[]}} Resumable
 * @typedef {Omit<Resumable, "issues"> & {issues?: number[]}} StoppedResumable
 */
/** @typedef {ReturnType<typeof import("./child-spawn.js").spawnChild>} ChildRun */
/** @typedef {import("./dispatch-ledger.js").OverflowLookup} OverflowLookup */
/** @typedef {{carried: {from: string, to: string}[]} | {why: string}} Carry */

/**
 * @typedef {{
 *   log: (line: string) => void,
 *   env: () => NodeJS.ProcessEnv,
 *   burnOn: () => boolean,
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
 *   carryJobFiles: (seat: string, jobId: string, cwd: string) => Carry,
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

const ADOPTED_WHY = "found after a kill, the harness's reason lost with it";

/** @param {ResumeIo} io */
function resumeSteps(io) {
	const { log } = io;
	const readLaunchRecord = buildLaunchRecordReader(io);

	/**
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
	 * @param {{root: string, keyVar: string}} on
	 * @param {string} from
	 * @param {{jobId: string, sessionId: string|null}} copy
	 */
	function recordOverflowCopy({ root, keyVar }, from, { jobId, sessionId }) {
		const failure = `overflow copy ${jobId} of ${from} not marked in the dispatch ledger`;
		try {
			const lookup = io.overflowLookup(root);
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

	/** @param {{seat: string, from: string, cwd: string, copy: boolean}} moved */
	function readOffKeyUsd({ seat, from, cwd, copy }) {
		const file = transcriptPath(seat, cwd, from);
		return copy ? io.copySpendUsd(file) : io.sessionSpendUsd(file);
	}

	/**
	 * @param {{root: string, keyVar: string}} on
	 * @param {string} from
	 * @param {{jobId: string, sessionId: string|null, allowanceUsd: number,
	 *   offKeyUsd: number}} run
	 * @returns {string|null}
	 */
	function recordMovedOverflow({ root, keyVar }, from, run) {
		const failure = `moved overflow job ${run.jobId} of ${from} not recorded in the dispatch ledger`;
		try {
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
	 * @param {{root: string, seat: string, keyVar?: string}} l
	 * @param {string} from
	 * @param {{jobId: string, sessionId: string|null}} run
	 * @param {{copy: boolean, cwd: string, move?: MoveTarget}} how
	 * @returns {string|null}
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
		const stop = io.stop(seat, run.jobId);
		return stop.ok || stop.noJob
			? failed
			: `${failed}, and its job not stopped: ${stop.why}`;
	}

	/**
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
	 * @param {Resumable} l
	 * @param {string} from
	 * @param {{jobId: string, sessionId: string|null, cwd: string,
	 *   why: string}} copy
	 * @param {MoveTarget} [move]
	 * @returns {Resumed}
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
	 * @param {string} seat
	 * @param {string} cwd
	 * @param {string} sessionId
	 */
	const readTranscriptName = (seat, cwd, sessionId) =>
		io.sessionName(transcriptPath(seat, cwd, sessionId));

	/**
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
	 * @param {Resumable & {prompt: string}} l
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
	 * @param {StoppedResumable} session
	 * @param {string} prompt
	 * @param {{sessionId: string, cwd: string}} target
	 * @param {{move?: MoveTarget, name?: string, flags?: string[],
	 *   carried?: Carry}} [moved]
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
	 * @param {StoppedResumable} session
	 * @param {string} prompt
	 * @param {{sessionId: string, cwd: string}} target
	 * @param {{move?: MoveTarget, name?: string, flags?: string[],
	 *   carried?: Carry}} [moved]
	 * @returns {Resumed}
	 */
	function startResume(
		session,
		prompt,
		{ sessionId, cwd },
		{ move, name, flags = [], carried } = {},
	) {
		const l = { ...session, issues: session.issues ?? [] };
		const carry =
			carried ?? io.carryJobFiles(l.seat, shortJobId(sessionId), cwd);
		if ("why" in carry)
			log(
				`${sessionId}'s job files not carried before its resume: ${carry.why}`,
			);
		const note = "why" in carry ? "" : buildCarriedNote(carry.carried);
		const told = note ? `${prompt}\n\n${note}` : prompt;
		if (l.keyVar)
			return resumeHeadless({ ...l, keyVar: l.keyVar }, told, {
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
			[
				"--bg",
				"--resume",
				sessionId,
				...launchFlags(flags, l.seat, sessionId),
				...nameArgs,
				told,
			],
			{
				cwd,
				env,
			},
		);
		return settleStarted(l, r, { sessionId, cwd }, move);
	}

	/**
	 * @param {string[]} flags
	 * @param {string} seat
	 * @param {string} sessionId
	 * @returns {string[]}
	 */
	function launchFlags(flags, seat, sessionId) {
		return flags.length > 0 ? flags : movedModelArgs(seat, sessionId);
	}

	/**
	 * @param {string} seat
	 * @param {string} sessionId
	 * @returns {string[]}
	 */
	function movedModelArgs(seat, sessionId) {
		const rec = io.readJobRecord(seat, shortJobId(sessionId));
		const saved = rec?.sessionId === sessionId ? savedFlagsOf(rec) : null;
		if (!saved) return [];
		const moved = relaunchFlags(saved, io.burnOn());
		if (moved === saved) return [];
		const found = parseModelFlag(moved);
		if (!found) throw new Error("relaunchFlags moved a --model it then lost");
		log(
			`${sessionId} wakes on ${found.model}, not its saved routed-away model (#4992)`,
		);
		return moved.slice(found.at, found.at + found.width);
	}

	/**
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
		const asSaved = ids.flags ?? resumeFlagsOf(l, ids);
		const flags = relaunchFlags(asSaved, io.burnOn());
		if (flags !== asSaved)
			log(
				`${ids.sessionId} resumes on its launch model as burn mode stands: ${asSaved.join(" ")} -> ${flags.join(" ")}`,
			);
		const carried = io.carryJobFiles(
			l.seat,
			shortJobId(ids.sessionId),
			ids.cwd,
		);
		if ("why" in carried) return { failed: carried.why };
		const retired = retireJob(l.seat, ids.sessionId, ids.cwd);
		if (retired) return { failed: retired };
		const r = startResume(l, prompt, ids, { flags, carried });
		if (r.failed !== null) stopFailed(l.seat, ids.sessionId);
		return r;
	}

	/**
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
	 * @param {Resumable & {pastSessionIds?: string[]}} l
	 * @param {{sessionId: string, cwd: string}} target
	 * @param {number} since
	 * @param {MoveTarget} [move]
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
		return r.failed === null ? r : { unread: r.failed };
	}

	/**
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
	 * @param {string} seat
	 * @param {string} sessionId
	 * @param {string} cwd
	 */
	function removeJobRecord(seat, sessionId, cwd) {
		const jobId = shortJobId(sessionId);
		if (!io.hasJobRecord(seat, jobId)) return null;
		const carry = io.carryJobFiles(seat, jobId, cwd);
		if ("why" in carry)
			return `keeping its job's files on ${seat}: ${carry.why}`;
		const failed = childFailure(
			io.runClaude(["rm", jobId], { cwd, env: buildSeatEnv(io.env(), seat) }),
		);
		return failed && `removing its stale job record on ${seat}: ${failed}`;
	}

	/**
	 * @param {Resumable & {prompt: string}} l
	 * @param {MoveTarget} target
	 * @param {string} prompt
	 * @param {{sessionId: string, cwd: string}} ids
	 * @returns {Resumed}
	 */
	function moveSession(l, target, prompt, ids) {
		const { seat } = target;
		const { sessionId, cwd } = ids;
		const carried = io.carryJobFiles(l.seat, shortJobId(sessionId), cwd);
		if ("why" in carried) return { failed: carried.why };
		const prepared =
			io.copyTranscript({ from: l.seat, to: seat, sessionId, cwd }) ??
			removeJobRecord(seat, sessionId, cwd);
		if (prepared) return { failed: prepared };
		const name = target.keyVar ? readMovedName(l, ids) : undefined;
		const r = resumeStopped(movedOnto(l, target), prompt, ids, {
			move: target,
			name,
			carried,
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
