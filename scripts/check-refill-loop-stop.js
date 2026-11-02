#!/usr/bin/env node
/*
 * check-refill-loop-stop.js — name, at the next session start, a refill loop
 * that stopped on a damaged control file (#3389) or that the no-progress rule
 * paused (#2014, spec #1995 story 32; #3859), and its first overflow launch
 * after a plan-seat launch, with the plan seats it rested on (#3767).
 *
 * Usage:  node scripts/check-refill-loop-stop.js [--notify] [--json]
 *
 * READS the loop's state file (lib/refill-files.js) for its last stop, its
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
 * THE RESTART MATCHES THE STOPPED SCOPE (#3371): `/pick-next` restarts normal
 * mode only, naming the loop's other repos and goals (#3390). An away-mode
 * stop names one `refill-loop.js start` per goal's checkout, then the `set
 * --away` with its repos. `start` files a goal under CLAUDE_PROJECT_DIR before
 * the working directory (lib/host-root.js), so each such start sets it, and
 * names the script absolute. A loop started again since names no restart.
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
 * IMPLICIT:  at every session start but a dispatcher's or the loop's job, prints the refill loop's no-progress pause, or its last stop where it was a damaged control file, where newer than the stamp, then stamps it; prints its newest first overflow launch where newer than that launch's stamp, then stamps it; and names a damaged state file or a stopped loop's damaged control file.
 * JUSTIFIED: fail-safe — the loop runs outside any session, so nothing else reports its stopping, its pausing itself or its spending.
 * DEFEAT:    none needed — it never blocks; deleting a stamp names its last event again.
 */

const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const hookMessage = require("./lib/hook-message");
const { isFounderNoticeHeld } = require("./lib/background-start.js");
const { buildOverflowStartLines } = require("./lib/overflow-notice.js");
const { NO_PROGRESS_PAUSE, buildPauseText } = require("./lib/refill-decide.js");
const { pidLock } = require("./lib/pid-lock.js");
const loop = require("./lib/refill-loop.js");
const refillFiles = require("./lib/refill-files.js");
const { buildSeatName } = require("./lib/refill-seats.js");
const { expandPastePaths, scriptPath } = require("./lib/script-path.js");
const { shellQuote } = require("./lib/sh-quote.js");

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

const PICK_NEXT = "Restart it with /pick-next.";

const STATUS = `node ${scriptPath("refill-loop.js")} status`;

/**
 * The restart for a stopped loop's scope: `/pick-next` where it was normal
 * mode or is unknown, else a start per goal's checkout, then the switch to away
 * with its repos (#3371).
 * Residual: an away loop whose control file is lost after its stop is named
 * `/pick-next`, which restarts it as normal mode.
 * @param {import("./lib/refill-loop.js").Control|null} control
 * @returns {string[]}
 */
function buildRestartLines(control) {
	if (control === null) return [PICK_NEXT];
	if (control.scope.mode === "normal") return buildPickNextLines(control.scope);
	const { repos, goals } = control.scope;
	const script = `node ${expandPastePaths("{script:refill-loop.js}", "")}`;
	const away = `${script} set --away${repos
		.map((r) => ` --repos ${path.basename(r)}`)
		.join("")}`;
	const perGoal = Object.entries(goals).map(
		([root, issues]) =>
			`  CLAUDE_PROJECT_DIR=${shellQuote(root)} ${script} start --goal ${issues.join(",")}`,
	);
	return perGoal.length === 0
		? [`Restart away mode: ${script} start, then ${away}`]
		: [
				"Restart away mode, one start per goal's checkout, then the switch:",
				...perGoal,
				`  ${away}`,
			];
}

/**
 * A normal loop's restart: the checkout that started it names the other repos
 * and its goal, and each other goal's checkout its own goal, since `/pick-next`
 * resolves a goal against the tracker it runs in (#3390). The starter leads
 * `repos`: `start` writes it first and the union keeps the first start's
 * order; a scope with no repos leads with its first goal's checkout.
 * @param {import("./lib/refill-loop.js").Scope} scope
 * @returns {string[]}
 */
function buildPickNextLines({ repos, goals }) {
	const lead = repos[0] ?? Object.keys(goals)[0];
	if (lead === undefined) return [PICK_NEXT];
	const extras = repos.filter((r) => r !== lead);
	const goalRoots = Object.keys(goals).filter((r) => r !== lead);
	if (extras.length === 0 && goalRoots.length === 0 && !goals[lead])
		return [PICK_NEXT];
	/** @param {string} root */
	const command = (root) =>
		[
			"/pick-next",
			...(goals[root] ?? []).map((n) => `#${n}`),
			...(root === lead ? extras.map((r) => path.basename(r)) : []),
		].join(" ");
	/* No trailing period: §1 of the skill would read `repo.` as no checkout. */
	if (goalRoots.length === 0)
		return [`Restart it in ${path.basename(lead)}: ${command(lead)}`];
	return [
		"Restart it with /pick-next, one per goal's checkout:",
		...[lead, ...goalRoots].map(
			(r) => `  in ${path.basename(r)}: ${command(r)}`,
		),
	];
}

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
		const { stopped, overflowStart } = refillFiles.readStateFile(reportDamaged);
		const seen = readSeen(files.stopSeen);
		const fresh =
			stopped !== null &&
			stopped.reason === "control-damaged" &&
			stopped.at > seen;
		/* Silent where another line names the damage: a running loop's in
		 * check-idle-efforts.js, a fresh control-damaged stop's below (#3927). */
		const control = refillFiles.readControlFile(
			pidLock(files.pid, "refill-loop.js").holder() !== null || fresh
				? () => undefined
				: reportDamaged,
		);
		if (fresh) {
			const at = new Date(stopped.at).toISOString();
			const restarted = loop.isRestartedSince(control, stopped.at);
			const since = restarted
				? " It has been started again since."
				: " Running sessions finish; nothing new launches.";
			const lines = [
				...(restarted ? [] : buildRestartLines(control)),
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
			okLine: "no refill loop stop, pause or overflow start to name.",
			noun: "refill loop stop(s), pause(s), overflow start(s) or damaged file(s)",
			data: { stopped, overflowStart },
		};
	},
});
