#!/usr/bin/env node

const { configDirs } = require("./lib/arbiter-store");

const { now, runCheck, skipError } = require("./lib/check");
const {
	WATCH_FILE,
	readBaseline,
	readRoots,
	recordReading,
	trimmedRoots,
} = require("./lib/history-trim");

/** @typedef {import("./lib/check").Ctx} Ctx */
/** @typedef {import("./lib/history-trim").RootReading} RootReading */

/**
 * @param {RootReading[]} roots
 */
function rootTable(roots) {
	const rows = roots.map((r) => {
		if (r.state === "absent") return `  ${r.dir.padEnd(10)}  no history.jsonl`;
		if (r.state === "unreadable")
			return `  ${r.dir.padEnd(10)}  unreadable — permission error or no parseable timestamp`;
		const oldest =
			r.oldestMs === null
				? "?"
				: new Date(r.oldestMs).toISOString().slice(0, 10);
		return `  ${r.dir.padEnd(10)}  oldest ${oldest}  ${r.lineCount} line(s)`;
	});
	return `HISTORY ROOTS (${roots.length})\n${rows.join("\n")}\n`;
}

/**
 * @param {RootReading[]} roots
 * @param {Record<string, RootReading> | null | undefined} baseline
 */
function newRootsSince(roots, baseline) {
	if (baseline === null || baseline === undefined) return [];
	return roots.filter((r) => {
		if (r.state !== "ok") return false;
		const prior = baseline[r.dir];
		return prior?.state !== "ok" || prior.oldestMs === null;
	});
}

/**
 * @param {Ctx} ctx
 * @param {{ roots: RootReading[], baseline: Record<string, RootReading> | null | undefined, newRoots: RootReading[], recorded: "recorded" | "throttled" | "failed" | "unwritten" }} reading
 */
function sayReadingSummary(ctx, { roots, baseline, newRoots, recorded }) {
	ctx.say(rootTable(roots));
	if (baseline === null)
		ctx.say(
			`(no prior recording in ${WATCH_FILE()} — this is the baseline.)\n`,
		);
	if (newRoots.length > 0)
		ctx.say(
			`NEW ROOT(S) (${newRoots.length}) — first recording, nothing to compare: ${newRoots.map((r) => r.dir).join(", ")}\n`,
		);
	if (recorded === "unwritten")
		ctx.say(
			`(today's reading was not recorded in ${WATCH_FILE()}: \`--write\` records it.)\n`,
		);
	if (recorded === "failed")
		ctx.say(
			`(could not append today's reading to ${WATCH_FILE()}, so this\n` +
				"reading is lost — see WATCH_FILE in scripts/lib/history-trim.js.)\n",
		);
}

/**
 * @param {Ctx} ctx
 * @param {{ dir: string, priorOldestMs: number, newOldestMs: number }[]} trimmed
 */
function reportTrimmed(ctx, trimmed) {
	for (const t2 of trimmed) {
		ctx.warn(
			"HISTORY-TRIMMED",
			`${t2.dir}/history.jsonl's oldest line moved from ${new Date(t2.priorOldestMs).toISOString()} to ${new Date(t2.newOldestMs).toISOString()} — history was dropped`,
			{
				dir: t2.dir,
				priorOldestMs: t2.priorOldestMs,
				newOldestMs: t2.newOldestMs,
			},
			`history-trimmed:${t2.dir}`,
		);
	}
	ctx.say(
		`HISTORY TRIMMED (${trimmed.length}) — the oldest surviving line moved forward, so\n` +
			"burn attribution's retroactive corpus (mantahostels#2607) has shrunk. This never repairs\n" +
			"or archives; the archiver is mantahostels#2607's deferred ruling.\n" +
			trimmed
				.map(
					(t2) =>
						`  ${t2.dir}: oldest was ${new Date(t2.priorOldestMs).toISOString().slice(0, 10)}, now ${new Date(t2.newOldestMs).toISOString().slice(0, 10)}\n`,
				)
				.join(""),
	);
}

runCheck({
	name: "history-trim",
	usage: "node check-history-trim.js [--warn] [--json] [--notify] [--write]",
	flags: ["--write"],
	/** @param {Ctx} ctx */
	run(ctx) {
		const t = now();
		const dirs = configDirs();
		const roots = readRoots(dirs);
		const present = roots.filter((r) => r.state !== "absent");
		if (present.length === 0)
			throw skipError(
				`no Claude Code seat directory holds a history.jsonl (${dirs.join(", ")}).`,
			);

		const baseline = readBaseline();
		if (baseline === undefined)
			ctx.broken(
				`could not read the prior recording in ${WATCH_FILE()} — it exists but its newest line will not parse, or it is unreadable.`,
			);
		const trimmed = trimmedRoots(roots, baseline);
		const newRoots = newRootsSince(roots, baseline);
		const recorded = ctx.has("--write") ? recordReading(roots, t) : "unwritten";
		if (recorded === "failed")
			ctx.dirtied(
				`${WATCH_FILE()} could not be appended to just now — today's reading is lost.`,
			);

		if (!ctx.notify)
			sayReadingSummary(ctx, { roots, baseline, newRoots, recorded });

		if (trimmed.length > 0) reportTrimmed(ctx, trimmed);

		return {
			okLine:
				trimmed.length === 0
					? `${present.length} history root(s) read, none trimmed since the last recording.`
					: undefined,
			noun: "trimmed root(s)",
			count: trimmed.length,
			data: {
				recorded,
				roots: roots.map((r) => ({
					dir: r.dir,
					state: r.state,
					oldestMs: r.oldestMs,
					lineCount: r.lineCount,
				})),
				trimmed,
				newRoots: newRoots.map((r) => r.dir),
			},
		};
	},
});
