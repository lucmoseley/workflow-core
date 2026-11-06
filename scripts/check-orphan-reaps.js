#!/usr/bin/env node
/*
 * check-orphan-reaps.js — name every kill reap-orphan-hooks.js logged in the
 * last WINDOW_DAYS, on `npm run status` (#4342): a dead session's process, or
 * a hook run past its timeout, each with its argv and, for the first, its
 * session.
 *
 * Usage:  node scripts/check-orphan-reaps.js [--json]
 *
 * WHY A LOG READER. The reaper kills at session start and from its user timer
 * with no session open; the timer's persisted report is replayed at the next
 * start only while fresh, so an overnight kill reaches the founder here.
 * Running the reaper itself here would kill from a read-only surface.
 *
 * READ-ONLY: it reads `.orphan-hook-reaps.jsonl` under the canonical
 * checkout's markers and writes nothing. No log yet is all-clear.
 */

const { now, runCheck } = require("./lib/check");
const { describeSession } = require("./lib/ended-sessions.js");
const { readJsonl } = require("./lib/jsonl.js");
const { ARGV_SHOWN, reapLogPath } = require("./lib/orphan-hooks.js");
const { DAY_MS } = require("./lib/retained-jsonl.js");
const { repoRoot } = require("./lib/test-pass-marker.js");

/* Untraced: a week spans a weekend away from the machine. */
const WINDOW_DAYS = 7;

runCheck({
	name: "orphan-reaps",
	usage: "node check-orphan-reaps.js [--json]",
	run(ctx) {
		const canonical =
			repoRoot() ?? ctx.skip("git names no canonical checkout.");
		const log = reapLogPath(canonical);
		const since = now() - WINDOW_DAYS * DAY_MS;
		const rows = (readJsonl(log)?.rows ?? []).filter(
			(r) => typeof r.at === "string" && Date.parse(r.at) >= since,
		);
		for (const r of rows) {
			const session =
				/** @type {import("./lib/ended-sessions.js").Session | undefined} */ (
					r.session
				);
			const what = session
				? `outlived ${describeSession(session)}`
				: "a hook run past its timeout";
			const killed = Array.isArray(r.killed) ? r.killed.length : 0;
			const argv = String(r.argv ?? "").slice(0, ARGV_SHOWN);
			const line = `${r.at}: pid ${r.pid}, ${what}, ${killed} killed: ${argv}`;
			ctx.warn(session ? "ORPHAN-SESSION" : "ORPHAN-HOOK", line, r);
			ctx.say(`  ${line}`);
		}
		if (rows.length > 0)
			ctx.say(
				`\n  Logged in ${log}. Trace each launch from its argv (#4333's routes).\n`,
			);
		return {
			okLine: `no orphan killed in the last ${WINDOW_DAYS} days.`,
			noun: `orphan kill(s) in the last ${WINDOW_DAYS} days`,
			data: { log, kills: rows },
		};
	},
});
