#!/usr/bin/env node

const { runCheck } = require("./lib/check");
const {
	defaultQueueDir,
	isMarkerStale,
	readMarkers,
} = require("./lib/suite-queue.js");

/** @param {number | null} ms */
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
