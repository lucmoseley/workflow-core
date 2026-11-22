#!/usr/bin/env node

const fs = require("node:fs");
const { now: clockNow, runCheck } = require("./lib/check");
const hookMessage = require("./lib/hook-message");
const { isFounderNoticeHeld } = require("./lib/background-start.js");
const {
	buildOverflowStartLines,
	buildStartLabel,
} = require("./lib/overflow-notice.js");
const path = require("node:path");
const { buildPauseText } = require("./lib/refill-decide.js");
const { pidLock } = require("./lib/pid-lock.js");
const loop = require("./lib/refill-loop.js");
const refillFiles = require("./lib/refill-files.js");
const { restartWaitOf } = require("./lib/refill-boot.js");
const { readState } = require("./lib/refill-state.js");
const { expandPastePaths, scriptPath } = require("./lib/script-path.js");

/** @param {string} file */
function readSeen(file) {
	try {
		const at = Number(fs.readFileSync(file, "utf8").trim());
		return Number.isFinite(at) ? at : 0;
	} catch {
		return 0;
	}
}

const CHECKER = "refill-loop-stop";

const STATUS = `node ${scriptPath("refill-loop.js")} status`;

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {import("./lib/refill-loop.js").Control|null} control
 * @param {number} seen
 * @returns {number|null}
 */
function reportNoProgressPause(ctx, control, seen) {
	/** @type {number|null} */
	let latest = null;
	for (const [root, paused] of Object.entries(control?.repoPaused ?? {})) {
		if (paused.at <= seen) continue;
		const repo = path.basename(root);
		const text = buildPauseText(paused);
		ctx.warn("REFILL-LOOP-PAUSED", `the refill loop's ${repo} is ${text}`, {
			root,
			...paused,
		});
		ctx.sayNotice(
			`REFILL-LOOP-PAUSED — the refill loop's ${repo} is ${text}. It launches nothing there and stays paused; look at those issues, then resume it.\n` +
				`  node ${scriptPath("refill-loop.js")} set --resume\n` +
				`  Its status: ${STATUS}\n`,
		);
		latest = Math.max(latest ?? 0, paused.at);
	}
	return latest;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {number|null} since
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
 * @param {import("./lib/check").Ctx} ctx
 * @param {import("./lib/overflow-notice.js").OverflowStart|null} start
 * @param {string} seenFile
 * @returns {number|null}
 */
function reportOverflowStart(ctx, start, seenFile) {
	if (start === null || start.at <= readSeen(seenFile)) return null;
	const at = new Date(start.at).toISOString();
	const seat = buildStartLabel(start);
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
