#!/usr/bin/env node
/*
 * check-suite-margin.js — did the latest green whole vitest suite finish
 * inside the margin it is held to?
 *
 * Usage:
 *   node check-suite-margin.js [--store <pass-marker file>] [--notify] [--json]
 *
 * A whole suite killed at the ceiling turns the push gate red (#2667), so the
 * margin is watched before the gate goes red (#2729, #2770; shards #3090): where the latest green whole
 * suite took longer than `TARGET_MS` (`scripts/lib/suite-ceiling.js`), this
 * names its sha, its duration against the target and the ceiling, the machine
 * reading across the run and its slowest files.
 *
 * THE LATEST RUN ALONE — or, where the whole suite runs as `--shard=k/n`
 * shards (`fullTestShards`, #2996), the latest of each shard, since each runs
 * under its own ceiling.
 *
 * A WHOLE SUITE IS `scope.full` SET AND EVERY MODULE RUN (`isFullRun`); A
 * SHARD IS `scope.full` AND `scope.shard` SET, NARROWED BY NOTHING ELSE
 * (`isUnnarrowedScope`).
 *
 * WARN-ONLY, ALWAYS (#1797).
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), says when the latest green whole vitest suite, or any of its latest green shards, took longer than the target scripts/lib/suite-ceiling.js sets below the suite ceiling, with its sha, machine reading and slowest files. It refuses nothing.
 * JUSTIFIED: fail-safe — a suite outgrowing its margin is otherwise silent until a push gate is killed at the ceiling.
 * DEFEAT:    convenience — --store reads another pass-marker file on a hand run.
 */

const { runCheck } = require("./lib/check.js");
const {
	CEILING_MS,
	TARGET_FRACTION,
	TARGET_MS,
} = require("./lib/suite-ceiling.js");
const {
	DEFAULT_SUITE,
	isFullRun,
	isUnnarrowedScope,
	readMarkers,
	readStoreFile,
	shortSha,
	suiteOf,
} = require("./lib/test-pass-marker.js");

/** @typedef {import("./lib/test-pass-marker.js").Marker} Marker */

/** @param {number} ms */
const secs = (ms) => `${Math.round(ms / 1000)} s`;

/** @typedef {Marker & {durationMs: number}} TimedMarker */

/**
 * @param {Marker} m
 * @returns {m is TimedMarker}
 */
const isGreenFull = (m) =>
	suiteOf(m) === DEFAULT_SUITE &&
	Boolean(m.scope?.full) &&
	!m.scope?.failures?.length &&
	!m.ceilingKill &&
	typeof m.durationMs === "number";

/**
 * A `--shard=k/n` part of a whole suite, narrowed by nothing but the shard.
 * @param {Marker} m
 */
const isFullShard = (m) =>
	Boolean(m.scope?.shard) && isUnnarrowedScope(m.scope);

/**
 * The runs the margin is judged on: the latest green whole suite, or, where
 * the latest green full run is a shard, the latest green run of each of its
 * shards since that whole suite — every shard holds its own slot under its own
 * ceiling. A shard with no such run is named in `unjudged`, never dropped
 * silently.
 * @param {Marker[]} markers
 * @returns {{runs: TimedMarker[], unjudged: string[]}}
 */
function latestRuns(markers) {
	const all = markers
		.filter(isGreenFull)
		.filter((m) => isFullRun(m) || isFullShard(m));
	const latest = all.at(-1);
	const shard = latest?.scope?.shard;
	if (!latest || !shard) return { runs: latest ? [latest] : [], unjudged: [] };
	/* A shard's green run older than the latest green whole suite describes a
	 * suite the lander no longer runs. */
	const full = all.slice(all.findLastIndex((m) => !m.scope?.shard) + 1);
	/** @type {TimedMarker[]} */
	const runs = [];
	/** @type {string[]} */
	const unjudged = [];
	for (let index = 1; index <= shard.count; index++) {
		const run = full.findLast(
			(m) =>
				m.scope?.shard?.count === shard.count && m.scope.shard.index === index,
		);
		if (run) runs.push(run);
		else unjudged.push(`${index}/${shard.count}`);
	}
	return { runs, unjudged };
}

/** @param {Marker} m */
const subjectOf = (m) => {
	const shard = m.scope?.shard;
	const what = shard
		? `green shard ${shard.index}/${shard.count} of the whole suite`
		: "green whole suite";
	return `the latest ${what}, at ${shortSha(m.sha)}`;
};

/** @param {NonNullable<Marker["machine"]>|undefined} machine */
function machineLine(machine) {
	if (!machine) return "machine reading: none recorded";
	const load =
		machine.load1 === null ? "load1 unknown" : `load1 ${machine.load1}`;
	return `machine reading: busy ${machine.busyPct}% of ${machine.ceilingPct}% (system ${machine.systemPct}%, nice ${machine.nicePct}%, user ${machine.userPct}%, iowait ${machine.iowaitPct}%), ${load}`;
}

runCheck({
	name: "suite-margin",
	usage:
		"node check-suite-margin.js [--store <pass-marker file>] [--notify] [--json]",
	valueFlags: ["--store"],
	run(/** @type {import("./lib/check.js").Ctx} */ ctx) {
		const store = ctx.value("--store", "");
		const markers = store ? readStoreFile(store) : readMarkers();
		const { runs, unjudged } = latestRuns(markers);
		const target = `the ${secs(TARGET_MS)} target (${Math.round(TARGET_FRACTION * 100)}% of the ${secs(CEILING_MS)} ceiling)`;
		if (runs.length === 0)
			return { okLine: "no green whole vitest suite is recorded." };
		const unjudgedNote =
			unjudged.length === 0
				? ""
				: ` No green run of shard ${unjudged.join(", ")} is recorded, so it is unjudged.`;

		const over = runs.filter((m) => m.durationMs > TARGET_MS);
		if (over.length === 0)
			return {
				okLine: `${runs.map((m) => `${subjectOf(m)}, took ${secs(m.durationMs)}`).join("; ")}: inside ${target}.${unjudgedNote}`,
			};

		const breaches = over.map((marker) => ({
			marker,
			record: {
				sha: marker.sha,
				at: marker.at ?? null,
				shard: marker.scope?.shard ?? null,
				durationMs: marker.durationMs,
				targetMs: TARGET_MS,
				ceilingMs: CEILING_MS,
				machine: marker.machine ?? null,
				slowest: marker.slowest ?? [],
			},
		}));
		for (const { marker, record } of breaches) {
			const subject = subjectOf(marker);
			const { shard } = record;
			ctx.warn(
				"SUITE-MARGIN",
				`${subject}, took ${secs(record.durationMs)}, over ${target}.`,
				record,
				`SUITE-MARGIN\t${marker.sha}${shard ? `\t${shard.index}/${shard.count}` : ""}`,
			);
			ctx.say(
				`SUITE-MARGIN — ${subject} (${marker.at ?? "undated"}), took ${secs(record.durationMs)}: over the ${secs(TARGET_MS)} target, against the ${secs(CEILING_MS)} ceiling.`,
			);
			ctx.say(`  ${machineLine(marker.machine)}`);
			if (record.slowest.length === 0)
				ctx.say("  slowest files: none recorded");
			else {
				ctx.say("  slowest files:");
				for (const s of record.slowest)
					ctx.say(`    ${s.seconds.toFixed(1)} s  ${s.file}`);
			}
		}
		if (unjudgedNote) ctx.say(` ${unjudgedNote}`);
		ctx.say(
			"  A run past the ceiling is killed and the push gate goes red (#2667). Cut its heavy tail by measured cost (#2729), or raise `fullTestShards` (#2996).",
		);
		return {
			noun: "run(s) over the target",
			count: over.length,
			data: breaches.map((b) => b.record),
		};
	},
});
