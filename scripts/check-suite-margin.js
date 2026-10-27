#!/usr/bin/env node
/*
 * check-suite-margin.js — did the latest green whole vitest suite finish
 * under the target it is held to?
 *
 * Usage:
 *   node check-suite-margin.js [--store <pass-marker file>]
 *     [--fail-store <fail-marker file>] [--notify] [--json]
 *
 * A lone whole suite is aimed at `TARGET_MS` (`scripts/lib/suite-ceiling.js`);
 * the ceiling is the backstop that kills a runaway run and turns the push gate
 * red (#2667). So where the latest green whole suite (#2729, #2770; shards
 * #3090) took `TARGET_MS` or longer, this
 * names its sha, its duration against the target and the ceiling, the machine
 * reading across the run and its slowest files.
 *
 * THE LATEST GREEN RUN AND EVERY CEILING KILL AFTER IT (#3237) — or, where the
 * whole suite runs as `--shard=k/n` shards (`fullTestShards`, #2996), the
 * same for each shard, since each runs under its own ceiling.
 *
 * A WHOLE SUITE IS `scope.full` SET AND EVERY MODULE RUN (`isFullRun`); A
 * SHARD IS `scope.full` SET, NARROWED BY NOTHING ELSE (`isUnnarrowedScope`).
 *
 * WARN-ONLY, ALWAYS (#1797).
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), says when the latest green whole vitest suite, or any of its latest green shards, took the target scripts/lib/suite-ceiling.js sets or longer, or was killed at the ceiling since, with its sha, machine reading and slowest files, and names a shard with no run to judge. It refuses nothing.
 * JUSTIFIED: fail-safe — a suite over its target is otherwise silent until a push gate is killed at the ceiling.
 * DEFEAT:    convenience — --store and --fail-store read other marker files on a hand run.
 */

const { runCheck } = require("./lib/check.js");
const {
	fullFlagWord,
	isFullRunArgv,
	stripWrapperFlags,
} = require("./lib/launch-route.js");
const { CEILING_MS, TARGET_MS } = require("./lib/suite-ceiling.js");
const {
	DEFAULT_SUITE,
	isFullRun,
	isUnnarrowedScope,
	readFailures,
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
 * The `--shard=k/n` a launch typed: every lander shard run before #3090
 * carries its argv but no `scope.shard`.
 * @param {string[]} [argv]
 * @returns {{index: number, count: number}|null}
 */
function parseArgvShard(argv = []) {
	const at = argv.findIndex((w) => w === "--shard" || w.startsWith("--shard="));
	if (at < 0) return null;
	const word = argv[at] ?? "";
	const spelled =
		word === "--shard" ? argv[at + 1] : word.slice("--shard=".length);
	const k = /^(\d+)\/(\d+)$/.exec(spelled ?? "");
	return k ? { index: Number(k[1]), count: Number(k[2]) } : null;
}

/** @param {Marker} m */
const shardOf = (m) => m.scope?.shard ?? parseArgvShard(m.argv);

/**
 * A `--shard=k/n` part of a whole suite, narrowed by nothing but the shard.
 * @param {Marker} m
 */
const isFullShard = (m) => Boolean(shardOf(m)) && isUnnarrowedScope(m.scope);

/**
 * A whole suite or a shard of one, killed at the ceiling. The kill record has
 * no scope, the run never having reported, so its selection is read off the
 * launch: `full` where run-vitest recorded it (#3237), else a typed `--full` word,
 * and argv the launch route reads as full-shaped.
 * @param {Marker} m
 * @returns {m is TimedMarker}
 */
function isWholeKill(m) {
	if (suiteOf(m) !== DEFAULT_SUITE || !m.ceilingKill) return false;
	if (typeof m.durationMs !== "number") return false;
	const argv = m.argv ?? [];
	if (!m.full && fullFlagWord(argv) === null) return false;
	return isFullRunArgv(stripWrapperFlags(argv));
}

/** Oldest first; the two stores are separate files.
 * @param {Marker} a @param {Marker} b */
function byAt(a, b) {
	const [x, y] = [a.at ?? "", b.at ?? ""];
	if (x === y) return 0;
	return x < y ? -1 : 1;
}

/**
 * The runs the margin is judged on, in the shape of the latest green run —
 * the whole suite, or its shards at that count — or of the latest kill where
 * nothing is green; a kill never sets it, so a hand run killed between the
 * lander's shards hides none of them. For each slot, the whole suite or each
 * shard, that is its latest green run and every kill after it. A green run
 * older than the last of another shape describes a suite the lander no longer
 * runs. A slot with no run
 * is named in `unjudged`, never dropped silently.
 * @param {Marker[]} markers
 * @param {Marker[]} failures
 * @returns {{runs: TimedMarker[], unjudged: string[]}}
 */
function latestRuns(markers, failures) {
	const all = [
		...markers
			.filter(isGreenFull)
			.filter((m) => isFullRun(m) || isFullShard(m)),
		...failures.filter(isWholeKill),
	].sort(byAt);
	const latest = all.findLast((m) => !m.ceilingKill) ?? all.at(-1);
	if (!latest) return { runs: [], unjudged: [] };
	/** @param {Marker} m */
	const countOf = (m) => shardOf(m)?.count ?? 0;
	const count = countOf(latest);
	const recent = all.slice(
		all.findLastIndex((m) => !m.ceilingKill && countOf(m) !== count) + 1,
	);
	const shaped = recent.filter((m) => countOf(m) === count);
	/** @type {TimedMarker[]} */
	const runs = [];
	/** @type {string[]} */
	const unjudged = [];
	for (let index = count === 0 ? 0 : 1; index <= count; index++) {
		const slot = shaped.filter((m) => (shardOf(m)?.index ?? 0) === index);
		const green = slot.findLastIndex((m) => !m.ceilingKill);
		if (slot.length > 0) runs.push(...slot.slice(Math.max(green, 0)));
		else unjudged.push(`${index}/${count}`);
	}
	runs.push(...recent.filter((m) => countOf(m) !== count));
	return { runs, unjudged };
}

/** @param {Marker} m */
const subjectOf = (m) => {
	const shard = shardOf(m);
	const what = shard
		? `shard ${shard.index}/${shard.count} of the whole suite`
		: "whole suite";
	return m.ceilingKill
		? `a ${what} killed at the ceiling, at ${shortSha(m.sha)}`
		: `the latest green ${what}, at ${shortSha(m.sha)}`;
};

/** @param {NonNullable<Marker["machine"]>|undefined} machine */
function machineLine(machine) {
	if (!machine) return "machine reading: none recorded";
	const load =
		machine.load1 === null ? "load1 unknown" : `load1 ${machine.load1}`;
	return `machine reading: busy ${machine.busyPct}% of ${machine.ceilingPct}% (system ${machine.systemPct}%, nice ${machine.nicePct}%, user ${machine.userPct}%, iowait ${machine.iowaitPct}%), ${load}`;
}

/**
 * A kill's files in flight, or a green run's slowest.
 * @param {Marker} m
 * @returns {string[]}
 */
function buildFileLines(m) {
	if (m.ceilingKill) {
		const inflight = m.inflight ?? [];
		if (inflight.length === 0)
			return ["  in flight at the kill: none recorded"];
		return [
			"  in flight at the kill:",
			...inflight.map((f) => `    ${f.module} (${f.stage})`),
		];
	}
	const slowest = m.slowest ?? [];
	if (slowest.length === 0) return ["  slowest files: none recorded"];
	return [
		"  slowest files:",
		...slowest.map((s) => `    ${s.seconds.toFixed(1)} s  ${s.file}`),
	];
}

/**
 * Warns on one run over the target and says its detail.
 * @param {import("./lib/check.js").Ctx} ctx
 * @param {TimedMarker} marker
 * @param {string} target
 */
function reportBreach(ctx, marker, target) {
	const subject = subjectOf(marker);
	const shard = shardOf(marker);
	const record = {
		sha: marker.sha,
		at: marker.at ?? null,
		shard,
		ceilingKill: Boolean(marker.ceilingKill),
		durationMs: marker.durationMs,
		targetMs: TARGET_MS,
		ceilingMs: CEILING_MS,
		machine: marker.machine ?? null,
		slowest: marker.slowest ?? [],
	};
	const slot = shard ? `\t${shard.index}/${shard.count}` : "";
	const killed = record.ceilingKill ? `\tkilled ${record.at}` : "";
	ctx.warn(
		"SUITE-MARGIN",
		`${subject}, took ${secs(record.durationMs)}, over ${target}.`,
		record,
		`SUITE-MARGIN\t${marker.sha}${slot}${killed}`,
	);
	ctx.say(
		`SUITE-MARGIN — ${subject} (${marker.at ?? "undated"}), took ${secs(record.durationMs)}: over the ${secs(TARGET_MS)} target, against the ${secs(CEILING_MS)} ceiling.`,
	);
	ctx.say(`  ${machineLine(marker.machine)}`);
	for (const line of buildFileLines(marker)) ctx.say(line);
	return record;
}

runCheck({
	name: "suite-margin",
	usage:
		"node check-suite-margin.js [--store <pass-marker file>] [--fail-store <fail-marker file>] [--notify] [--json]",
	valueFlags: ["--store", "--fail-store"],
	run(/** @type {import("./lib/check.js").Ctx} */ ctx) {
		const store = ctx.value("--store", "");
		const failStore = ctx.value("--fail-store", "");
		const markers = store ? readStoreFile(store) : readMarkers();
		const failures = failStore ? readStoreFile(failStore) : readFailures();
		const { runs, unjudged } = latestRuns(markers, failures);
		const target = `the ${secs(TARGET_MS)} target (the ${secs(CEILING_MS)} ceiling is the backstop)`;
		if (runs.length === 0)
			return { okLine: "no green whole vitest suite is recorded." };
		/* An unjudged shard may be the one over the target, so it never reads
		 * OK. */
		/** @param {string[]} slots */
		const buildUnjudgedText = (slots) =>
			`No green run of shard ${slots.join(", ")} is recorded, so it is unjudged: run it with \`npm run test -- --full=other --shard=<k/n>\`, or wait for the lander's next shard runs.`;
		const unjudgedLine = buildUnjudgedText(unjudged);
		for (const slot of unjudged)
			ctx.warn(
				"SUITE-MARGIN-UNJUDGED",
				buildUnjudgedText([slot]),
				{ shard: slot },
				`SUITE-MARGIN-UNJUDGED\t${slot}`,
			);

		const over = runs.filter((m) => m.ceilingKill || m.durationMs >= TARGET_MS);
		if (over.length === 0) {
			const inside = `${runs.map((m) => `${subjectOf(m)}, took ${secs(m.durationMs)}`).join("; ")}: inside ${target}.`;
			if (unjudged.length === 0) return { okLine: inside };
			ctx.say(inside);
			ctx.say(unjudgedLine);
			return {
				noun: "shard(s) with no green run",
				count: unjudged.length,
				data: { unjudged },
			};
		}

		const records = over.map((m) => reportBreach(ctx, m, target));
		if (unjudged.length > 0) ctx.say(unjudgedLine);
		ctx.say(
			"  A run past the ceiling is killed and the push gate goes red (#2667). Cut its heavy tail by measured cost (#2729), or raise `fullTestShards` (#2996).",
		);
		return {
			noun:
				unjudged.length === 0
					? "run(s) over the target"
					: "run(s) over the target or shard(s) unjudged",
			count: over.length + unjudged.length,
			data: { breaches: records, unjudged },
		};
	},
});
