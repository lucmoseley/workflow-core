#!/usr/bin/env node
/*
 * check-stale-suite-queue.js — report a `wfc-suite-queue-*.json` marker
 * left behind by a waiter that is gone, so debris in the queue directory is
 * visible without going and looking in it by hand.
 *
 * Usage:  npm run check:suite-queue  [--notify] [--json]
 *
 * WHAT IT IS FOR (mantahostels#2034 — the fourth item its own fix left open). `queueJoin`
 * (scripts/lib/suite-queue.js) writes a marker per waiting `--queue` suite and
 * run-vitest.js removes it on resolution or on SIGTERM/SIGINT/SIGHUP; `queueTurn` sweeps a
 * stale one opportunistically, but only when another `--queue` run next
 * walks the directory. Between two such runs a marker from a SIGKILLed
 * waiter, or one written by a process that then crashed outright, sits
 * unreported.
 *
 * ONE STALENESS RULE, NOT TWO. `lib/suite-queue.js`'s `isMarkerStale` is the
 * same test `queueTurn` sweeps with — restating it here is exactly how the
 * original defect got in (mantahostels#2034's own postmortem), so this script imports it
 * rather than re-deriving "the pid is gone, or it's been reused" on its own.
 *
 * REPORT-ONLY, DELIBERATELY (unlike `queueTurn`, which already sweeps). This
 * sweep never unlinks a marker: `queueTurn` is the one place a stale marker is
 * actually cleared, on its own next walk, and duplicating that here buys
 * nothing while adding a second place that could delete a live waiter's place
 * in the queue on a wrong verdict.
 *
 * A TORN MARKER IS SILENCE, NOT A FINDING. `queueJoin` writes with a bare
 * `writeFileSync`, no temp-and-rename, so a marker read mid-write can be
 * truncated or fail to parse — a fact about timing, not about a leak.
 * `queueTurn` already treats that the same way (a bare `continue`), and so
 * does this sweep, matching it rather than raising an UNREADABLE-style
 * finding a healthy machine would trip on every run.
 *
 * `lib/suite-queue.js`'s `readMarkers` is the WALK, not just the predicate —
 * an earlier draft of this sweep re-derived the walk locally and it promptly
 * disagreed with `queueTurn` on which markers even counted (a marker with no
 * numeric `at` was reported stale here with advice `queueTurn` would not
 * honour). Sharing the walk closes that the same way `isMarkerStale` closes
 * the staleness question.
 *
 * AN UNREADABLE QUEUE DIRECTORY IS A SKIP, NOT AN "OK: 0 STANDING". The queue
 * directory lives outside the repo, matching check-stranded-file-claims.js's own
 * SUBJECT-vs-APPARATUS split (mantahostels#174) — a store this checker cannot see into is
 * a fact worth saying, not a clean sweep.
 *
 * LOCAL ONLY. It reads the queue directory directly, with no remote oracle to
 * degrade — `pidAlive`/`readStartTimeOf` are `/proc` reads on this machine alone,
 * so a CI runner or a different host finds nothing here and reports all-clear.
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), reports the standing count of wfc-suite-queue-*.json markers whose (pid, start) no longer matches a live process, itemising each one's path, pid and age. It never removes a marker.
 * JUSTIFIED: fail-safe — a leaked marker is otherwise invisible between one `--queue` run and the next, and a run that cannot tell live from finished reports nothing rather than calling a marker dead.
 * DEFEAT:    none; a hand run itemises the same set --notify already prints the count of.
 */

const { runCheck } = require("./lib/check");
const {
	defaultQueueDir,
	isMarkerStale,
	readMarkers,
} = require("./lib/suite-queue.js");

/**
 * An age with no verb — "3m", "2h", "1d" — for a sentence that supplies its
 * own, matching check-stranded-file-claims.js's `ageOf` in shape only: this
 * one reads a millisecond delta rather than hours, and adds a minutes tier
 * below it, since a leaked marker is expected to surface in minutes rather
 * than the days a stranded file claim can legitimately stand for.
 * @param {number | null} ms
 */
function ageOf(ms) {
	if (ms === null) return "an unreadable time";
	const seconds = ms / 1000;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86_400)}d`;
}

runCheck({
	name: "stale-suite-queue",
	usage: "node check-stale-suite-queue.js [--notify] [--json]",
	/** @param {import("./lib/check").Ctx} ctx */
	run(ctx) {
		const dir = defaultQueueDir();
		const { markers, error } = readMarkers(dir);
		if (error)
			ctx.skip(
				`the queue directory (${dir}) could not be read, so what is standing is unknown — not nothing: ${error}`,
			);

		const stale = markers
			.filter(({ record }) => isMarkerStale(record))
			.map(({ file, record }) => ({
				file,
				pid: record.pid,
				start: record.start ?? null,
				ageMs: Date.now() - record.at,
			}));

		if (stale.length === 0)
			return { okLine: `no stale marker among ${markers.length} standing.` };

		for (const s of stale)
			ctx.warn(
				"STALE-QUEUE-MARKER",
				`${s.file} — pid ${s.pid} is gone or reused, held ${ageOf(s.ageMs)}`,
				s,
			);

		ctx.say(
			`STALE-QUEUE-MARKER (${stale.length}) standing — a suite-queue marker whose (pid, start) no longer matches a live process.`,
		);
		for (const s of stale)
			ctx.say(`  ${s.file} — pid ${s.pid}, held ${ageOf(s.ageMs)}`);
		if (!ctx.notify)
			ctx.say(
				"\n  Nothing was removed, and this sweep has no way to remove anything: the\n" +
					"  next `--queue` suite clears it on its own next walk of the directory.\n" +
					"  Delete by hand only if you are certain no waiter is using it.\n",
			);

		return {
			okLine: `no stale marker among ${markers.length} standing.`,
			noun: "stale suite-queue marker(s)",
			data: { stale, markers: markers.length },
		};
	},
});
