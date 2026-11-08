#!/usr/bin/env node
/*
 * check-refill-loop-stop.js — name, at the next session start, a refill loop
 * that stopped on a damaged control file (#3389) or that the no-progress rule
 * paused (#2014, spec #1995 story 32; #3859), and its first overflow launch
 * after a plan-seat launch, with the plan seats it rested on (#3767). And a
 * running loop whose wait on a listing after a restart has outlasted its bound
 * (lib/refill-boot.js's restartWaitOf, #4145), at every start while it lasts.
 *
 * Usage:  node scripts/check-refill-loop-stop.js [--notify] [--json]
 *
 * READS the loop's state file (lib/refill-state.js) for its last stop, its
 * control file for its pause, and its pid lock for whether it runs. An explicit
 * stop and a founder's pause are not named.
 *
 * ONCE PER STOP OR PAUSE. A `--notify` run, bar under `--json`, records its time
 * in the stop-seen stamp beside the state file, and names none at or before it. A
 * plain run names it and records nothing. A compaction is no session start: its hook
 * payload's `source` is `compact`, and it prints and records nothing. The
 * stamp is per machine, as the loop is, so whichever session starts first on
 * any seat or repo spends it; a dispatcher's or the loop's job start, or any
 * job's wake, prints and records nothing either (lib/background-start.js, #3707, #3772), so the
 * founder's does, in a terminal or from the agents view.
 *
 * THE RESTART IS ONE COMMAND (#3868): `start` restarts from the stored settings, or
 * writes fresh ones where the control will not read, the script absolute. A loop
 * started again since names no restart.
 *
 * Severity is WARN: a notice for the founder. An absent or damaged state
 * file is no stop. A damaged state file is its own WARN, named at every
 * session start until the loop's next tick rewrites it. A stopped loop's
 * damaged control file is its own WARN on the same terms, until a `start`
 * rewrites it (#3380, #3927); beside the fresh stop it caused, the stop line
 * names it. A running loop's is check-idle-efforts.js's to name, once a day.
 * Residual: that checker's line replays at the next start, so where the loop
 * stopped between the two, that one start names the damage twice.
 *
 * ITS NOTICES REACH THE FOUNDER'S SCREEN as a `systemMessage`, and the model as
 * context (lib/check.js's screenNotices, #3776). A stamp is written once the
 * notice is out.
 *
 * IMPLICIT:  at every session start but a dispatcher's or the loop's job, prints the refill loop's no-progress pause, or its last stop where it was a damaged control file, where newer than the stamp, then stamps it; prints its newest first overflow launch where newer than that launch's stamp, then stamps it; and names a damaged state file, a stopped loop's damaged control file or a running loop's overlong restart wait.
 * JUSTIFIED: fail-safe — the loop runs outside any session, so nothing else reports its stopping, its pausing itself, its spending or its sticking in a restart wait.
 * DEFEAT:    none needed — it never blocks; deleting a stamp names its last event again.
 * TREE:      none — judges machine-wide refill-loop state
 */

const fs = require("node:fs");
const { now: clockNow, runCheck } = require("./lib/check");
const hookMessage = require("./lib/hook-message");
const { isFounderNoticeHeld } = require("./lib/background-start.js");
const { buildOverflowStartLines } = require("./lib/overflow-notice.js");
const { NO_PROGRESS_PAUSE, buildPauseText } = require("./lib/refill-decide.js");
const { pidLock } = require("./lib/pid-lock.js");
const loop = require("./lib/refill-loop.js");
const refillFiles = require("./lib/refill-files.js");
const { restartWaitOf } = require("./lib/refill-boot.js");
const { readState } = require("./lib/refill-state.js");
const { buildSeatName } = require("./lib/refill-seats.js");
const { expandPastePaths, scriptPath } = require("./lib/script-path.js");

/** @param {string} file */
function readSeen(file) {
	try {
		const at = Number(fs.readFileSync(file, "utf8").trim());
		return Number.isFinite(at) ? at : 0;
	} catch {
		/* Absent on the first run; unreadable only repeats the notice (#2014). */
		return 0;
	}
}

const CHECKER = "refill-loop-stop";

const STATUS = `node ${scriptPath("refill-loop.js")} status`;

/**
 * @param {import("./lib/check").CheckContext} ctx
 * @param {import("./lib/refill-loop.js").Control|null} control
 * @param {number} seen the stamp's time
 * @returns {number|null} the pause time it named, for the stamp
 */
function reportNoProgressPause(ctx, control, seen) {
	const paused = control?.paused;
	if (paused?.by !== NO_PROGRESS_PAUSE || paused.at <= seen) return null;
	const text = buildPauseText(paused);
	ctx.warn("REFILL-LOOP-PAUSED", `the refill loop is ${text}`, { ...paused });
	ctx.sayNotice(
		`REFILL-LOOP-PAUSED — the refill loop is ${text}. It launches nothing and stays paused; look at those issues, then resume it.\n` +
			`  node ${scriptPath("refill-loop.js")} set --resume\n` +
			`  Its status: ${STATUS}\n`,
	);
	return paused.at;
}

/**
 * @param {import("./lib/check").CheckContext} ctx
 * @param {number|null} since restartWaitOf's
 */
function reportRestartWait(ctx, since) {
	if (since === null) return;
	const at = new Date(since).toISOString();
	const line = `the refill loop has waited since a restart at ${at} for a session listing to read`;
	ctx.warn("REFILL-LOOP-RESTART-WAIT", line, { since: at });
	ctx.sayNotice(
		`REFILL-LOOP-RESTART-WAIT — ${line}, to queue the sessions the restart killed. Until one reads, it counts them as running and resumes none; its log names each refused listing.\n` +
			`  Its status: ${STATUS}\n`,
	);
}

/**
 * @param {import("./lib/check").CheckContext} ctx
 * @param {import("./lib/overflow-notice.js").OverflowStart|null} start
 * @param {string} seenFile
 * @returns {number|null} the launch time it named, for the stamp
 */
function reportOverflowStart(ctx, start, seenFile) {
	if (start === null || start.at <= readSeen(seenFile)) return null;
	const at = new Date(start.at).toISOString();
	const seat = buildSeatName(start.seat);
	ctx.warn(
		"REFILL-LOOP-OVERFLOW",
		`the refill loop began spending API credits on ${seat} at ${at}`,
		{ ...start },
	);
	ctx.sayNotice(
		`REFILL-LOOP-OVERFLOW — the refill loop began spending API credits at ${at}: its first overflow launch after a plan-seat launch, on ${seat}. Overflow launches only once every plan seat is weekly-full, and it read:\n` +
			[...buildOverflowStartLines(start), `Its status: ${STATUS}`]
				.map((l) => `  ${l}\n`)
				.join(""),
	);
	return start.at;
}

runCheck({
	name: CHECKER,
	usage: "node check-refill-loop-stop.js [--notify] [--json]",
	screenNotices: true,
	run(ctx) {
		/* Read under --notify alone: a plain run's stdin may be a terminal. */
		if (
			ctx.notify &&
			isFounderNoticeHeld(CHECKER, hookMessage.readPayload()?.source)
		)
			ctx.skip("this start is not the founder's own.");
		const files = refillFiles.loopFiles();
		/** @param {string} line */
		const reportDamaged = (line) => {
			ctx.warn("REFILL-LOOP-FILE-DAMAGED", line);
			ctx.sayNotice(`REFILL-LOOP-FILE-DAMAGED — ${line}.`);
		};
		const state = readState(reportDamaged);
		const { stopped, overflowStart } = state;
		const running = pidLock(files.pid, "refill-loop.js").holder() !== null;
		const seen = readSeen(files.stopSeen);
		const fresh =
			stopped !== null &&
			stopped.reason === "control-damaged" &&
			stopped.at > seen;
		/* Silent where another line names the damage: a running loop's in
		 * check-idle-efforts.js, a fresh control-damaged stop's below (#3927). */
		const control = refillFiles.readControlFile(
			running || fresh ? () => undefined : reportDamaged,
		);
		if (fresh) {
			const at = new Date(stopped.at).toISOString();
			const restarted = loop.isRestartedSince(control, stopped.at);
			const since = restarted
				? " It has been started again since."
				: " Running sessions finish; nothing new launches.";
			const lines = [
				...(restarted
					? []
					: [
							`Restart it: node ${expandPastePaths("{script:refill-loop.js}", "")} start`,
						]),
				`Its status: ${STATUS}`,
			];
			ctx.warn(
				"REFILL-LOOP-STOPPED",
				`the refill loop stopped on a damaged control file at ${at}`,
				{ reason: stopped.reason, at, detail: stopped.detail },
			);
			ctx.sayNotice(
				`REFILL-LOOP-STOPPED — the refill loop stopped on a damaged control file at ${at}: ${stopped.detail}.${since}\n` +
					lines.map((l) => `  ${l}\n`).join(""),
			);
		}
		if (running) reportRestartWait(ctx, restartWaitOf(state, clockNow()));
		const pauseAt = reportNoProgressPause(ctx, control, seen);
		const overflowAt = reportOverflowStart(
			ctx,
			overflowStart,
			files.overflowSeen,
		);
		return {
			afterReport() {
				if (!ctx.notify) return;
				const named = Math.max(fresh ? stopped.at : 0, pauseAt ?? 0);
				if (named > 0) fs.writeFileSync(files.stopSeen, `${named}\n`);
				if (overflowAt !== null)
					fs.writeFileSync(files.overflowSeen, `${overflowAt}\n`);
			},
			okLine:
				"no refill loop stop, pause, overflow start or restart wait to name.",
			noun: "refill loop stop(s), pause(s), overflow start(s), restart wait(s) or damaged file(s)",
			data: { stopped, overflowStart },
		};
	},
});
