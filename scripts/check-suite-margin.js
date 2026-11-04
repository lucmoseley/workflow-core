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
 * A RED RUN'S SLOWEST FILES TOO (#4291), any scope, since the earliest
 * green run judged: a red suite has no green run to show them.
 * Residual: a red run narrowed to a few files under load can name a file
 * that a whole run times under the target, and a slow file seen only in
 * green part-suites is never named.
 *
 * WARN-ONLY, ALWAYS (#1797).
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), says when the latest green whole vitest suite, or any of its latest green shards, took the target scripts/lib/suite-ceiling.js sets or longer, or was killed at the ceiling since, with its sha, machine reading and slowest files; names a file at the target in a red run since, with its sha; and names a suite or shard with no run to judge. It refuses nothing.
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

/** @typedef {{file: string, seconds: number, sha: string, at: string|null}} SlowRedFile */

/**
 * Each file at or over the target in a red run newer than `since`, or in any
 * red run, undated included, where `since` is null; at its newest reading.
 * @param {Marker[]} failures
 * @param {string|null} since
 * @returns {SlowRedFile[]}
 */
function slowRedFiles(failures, since) {
	/** @type {Map<string, SlowRedFile>} */
	const newest = new Map();
	const reds = failures
		.filter(
			(m) =>
				suiteOf(m) === DEFAULT_SUITE &&
				(since === null || (m.at ?? "") > since),
		)
		.sort(byAt);
	for (const m of reds)
		for (const s of m.slowest ?? [])
			newest.set(s.file, {
				file: s.file,
				seconds: s.seconds,
				sha: m.sha,
				at: m.at ?? null,
			});
	return [...newest.values()]
		.filter((f) => f.seconds * 1000 >= TARGET_MS)
		.sort((a, b) => b.seconds - a.seconds);
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

/**
 * Warns on each slot with no run to judge — the whole suite where nothing is
 * recorded, or each shard. An unjudged slot
 * may be the one over the target, so it never reads OK.
 * @param {import("./lib/check.js").Ctx} ctx
 * @param {boolean} noRun
 * @param {string[]} shards
 * @returns {string[]}
 */
function warnUnjudged(ctx, noRun, shards) {
	/** @param {string[]} slots */
	const shardText = (slots) =>
		`No green run of shard ${slots.join(", ")} is recorded, so it is unjudged: run it with \`npm run test -- --full=other --shard=<k/n>\`, or wait for the lander's next shard runs.`;
	const lines = [];
	if (noRun) {
		const text =
			"No green whole vitest suite is recorded, so the margin is unjudged: run one with `npm run test -- --full=other --queue`, or wait for the lander's next run.";
		ctx.warn("SUITE-MARGIN-UNJUDGED", text, {}, "SUITE-MARGIN-UNJUDGED");
		lines.push(text);
	}
	for (const slot of shards)
		ctx.warn(
			"SUITE-MARGIN-UNJUDGED",
			shardText([slot]),
			{ shard: slot },
			`SUITE-MARGIN-UNJUDGED\t${slot}`,
		);
	if (shards.length > 0) lines.push(shardText(shards));
	return lines;
}

/**
 * Warns on one red-run file at or over the target.
 * @param {import("./lib/check.js").Ctx} ctx
 * @param {SlowRedFile} f
 * @param {string} target
 */
function reportSlowFile(ctx, f, target) {
	const took = `${f.file} took ${f.seconds.toFixed(1)} s in a red run at ${shortSha(f.sha)}`;
	ctx.warn(
		"SUITE-MARGIN-SLOW-FILE",
		`${took}, at or over ${target}.`,
		f,
		`SUITE-MARGIN-SLOW-FILE\t${f.file}`,
	);
	ctx.say(
		`SUITE-MARGIN — ${took} (${f.at ?? "undated"}): at or over the ${secs(TARGET_MS)} target on its own.`,
	);
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
		/* The earliest judged green run: a shard's green names only its own
		 * files, so a red between two shards' greens stays in. */
		const since = runs
			.filter((m) => !m.ceilingKill)
			.map((m) => m.at ?? "")
			.reduce(
				(at, x) => (at === null || x < at ? x : at),
				/** @type {string|null} */ (null),
			);
		const slowFiles = slowRedFiles(failures, since);
		const unjudgedLines = warnUnjudged(ctx, runs.length === 0, unjudged);

		const over = runs.filter((m) => m.ceilingKill || m.durationMs >= TARGET_MS);
		const inside =
			runs.length > 0 && over.length === 0
				? `${runs.map((m) => `${subjectOf(m)}, took ${secs(m.durationMs)}`).join("; ")}: inside ${target}.`
				: null;
		if (inside && slowFiles.length === 0 && unjudged.length === 0)
			return { okLine: inside };

		if (inside) ctx.say(inside);
		const records = over.map((m) => reportBreach(ctx, m, target));
		for (const f of slowFiles) reportSlowFile(ctx, f, target);
		for (const line of unjudgedLines) ctx.say(line);
		if (over.length > 0)
			ctx.say(
				"  A run past the ceiling is killed and the push gate goes red (#2667). Cut its heavy tail by measured cost (#2729), or raise `fullTestShards` (#2996).",
			);
		if (slowFiles.length > 0)
			ctx.say(
				"  A file runs whole on one worker, so no shard count brings the suite under it: cut it by measured cost (#2729).",
			);
		/** @type {[number, string][]} */
		const parts = [
			[over.length, "run(s) over the target"],
			[slowFiles.length, "red-run file(s) over the target"],
			[unjudged.length, "shard(s) with no green run"],
			[runs.length === 0 ? 1 : 0, "whole suite with no green run"],
		];
		const counted = parts.filter(([n]) => n > 0);
		return {
			noun:
				counted.length === 1
					? counted[0][1]
					: `finding(s): ${counted.map(([n, noun]) => `${n} ${noun}`).join(", ")}`,
			count: counted.reduce((sum, [n]) => sum + n, 0),
			data: { breaches: records, slowFiles, unjudged },
		};
	},
});
