#!/usr/bin/env node
/*
 * check-refill-loop-stop.js — name, at the next session start, a refill loop
 * that stopped on no progress or on the allowance cut (workflow-core#2014, spec workflow-core#1995
 * story 32).
 *
 * Usage:  node scripts/check-refill-loop-stop.js [--notify] [--json]
 *
 * READS the loop's state file (lib/refill-loop.js) for its last stop. An
 * expiry or an explicit stop is not named.
 *
 * ONCE PER STOP. A `--notify` run records the stop's time in the stop-seen
 * stamp beside the state file, and names no stop at or before it. A plain run
 * names it and records nothing. A compaction is no session start: its hook
 * payload's `source` is `compact`, and it prints and records nothing. The
 * stamp is per machine, as the loop is, so whichever session starts first on
 * any seat or repo spends it — a background job's start included.
 *
 * Severity is WARN: a notice for the founder. An absent or unreadable state
 * file is no stop.
 *
 * IMPLICIT:  at every session start, prints the refill loop's last stop where it was no progress or the allowance cut and is newer than the stamp, then stamps it.
 * JUSTIFIED: fail-safe — the loop runs outside any session, so nothing else reports its stopping.
 * DEFEAT:    none needed — it never blocks; deleting the stamp names the last stop again.
 */

const fs = require("node:fs");
const { runCheck } = require("./lib/check");
const hookMessage = require("./lib/hook-message");
const loop = require("./lib/refill-loop.js");
const { scriptPath } = require("./lib/script-path.js");

/** @type {Partial<Record<import("./lib/refill-decide.js").StopReason, string>>} */
const STOP_REASON_WORDS = {
	"no-progress": "no progress",
	allowance: "the allowance cut",
};

/** @param {string} file */
function readSeen(file) {
	try {
		const at = Number(fs.readFileSync(file, "utf8").trim());
		return Number.isFinite(at) ? at : 0;
	} catch {
		/* Absent on the first run; unreadable only repeats the notice (workflow-core#2014). */
		return 0;
	}
}

runCheck({
	name: "refill-loop-stop",
	usage: "node check-refill-loop-stop.js [--notify] [--json]",
	run(ctx) {
		/* Read under --notify alone: a plain run's stdin may be a terminal. */
		if (ctx.notify && hookMessage.readPayload()?.source === "compact")
			ctx.skip("a compaction is no session start.");
		const files = loop.loopFiles();
		const { stopped } = loop.parseState(loop.readJson(files.state));
		const why = stopped
			? STOP_REASON_WORDS[
					/** @type {import("./lib/refill-decide.js").StopReason} */ (
						stopped.reason
					)
				]
			: undefined;
		const fresh =
			stopped !== null &&
			why !== undefined &&
			stopped.at > readSeen(files.stopSeen);
		if (fresh) {
			const at = new Date(stopped.at).toISOString();
			const control = loop.parseControl(loop.readJson(files.control));
			const since = loop.isRenewedSince(control, stopped.at)
				? " It has been started again since."
				: " Running sessions finish; nothing new launches.";
			ctx.warn(
				"REFILL-LOOP-STOPPED",
				`the refill loop stopped on ${why} at ${at}`,
				{ reason: stopped.reason, at, detail: stopped.detail },
			);
			ctx.say(
				`REFILL-LOOP-STOPPED — the refill loop stopped on ${why} at ${at}: ${stopped.detail}.${since}\n` +
					`  Restart it with /pick-next; its status: node ${scriptPath("refill-loop.js")} status\n`,
			);
			if (ctx.notify) fs.writeFileSync(files.stopSeen, `${stopped.at}\n`);
		}
		return {
			okLine: "no refill loop stop to name.",
			noun: "refill loop stop(s)",
			count: fresh ? 1 : 0,
			data: { stopped },
		};
	},
});
