#!/usr/bin/env node
/*
 * check-suite-margin.js — did the latest green whole vitest suite finish
 * inside the margin it is held to?
 *
 * Usage:
 *   node check-suite-margin.js [--store <pass-marker file>] [--notify] [--json]
 *
 * A whole suite killed at the ceiling turns the push gate red (#2667), so the
 * margin is watched before the gate goes red: where the latest green whole
 * suite took longer than `TARGET_MS` (`scripts/lib/suite-ceiling.js`), this
 * names its sha, its duration against the target and the ceiling, the machine
 * reading across the run and its slowest files.
 *
 * THE LATEST RUN ALONE.
 *
 * A WHOLE SUITE IS `scope.full` SET AND EVERY MODULE RUN (`isFullRun`).
 *
 * WARN-ONLY, ALWAYS (#1797).
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), says when the latest green whole vitest suite took longer than the target scripts/lib/suite-ceiling.js sets below the suite ceiling, with its sha, machine reading and slowest files. It refuses nothing.
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
	readMarkers,
	readStoreFile,
	shortSha,
	suiteOf,
} = require("./lib/test-pass-marker.js");

/** @typedef {import("./lib/test-pass-marker.js").Marker} Marker */

/** @param {number} ms */
const secs = (ms) => `${Math.round(ms / 1000)} s`;

/** @param {Marker} m */
const isGreenWhole = (m) =>
	suiteOf(m) === DEFAULT_SUITE &&
	Boolean(m.scope?.full) &&
	isFullRun(m) &&
	!m.scope?.failures?.length &&
	!m.ceilingKill &&
	typeof m.durationMs === "number";

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
		const latest = markers.filter(isGreenWhole).at(-1);
		const target = `the ${secs(TARGET_MS)} target (${Math.round(TARGET_FRACTION * 100)}% of the ${secs(CEILING_MS)} ceiling)`;
		if (!latest) return { okLine: "no green whole vitest suite is recorded." };

		const durationMs = /** @type {number} */ (latest.durationMs);
		const subject = `the latest green whole suite, at ${shortSha(latest.sha)}`;
		if (durationMs <= TARGET_MS)
			return {
				okLine: `${subject}, took ${secs(durationMs)}, inside ${target}.`,
			};

		const data = {
			sha: latest.sha,
			at: latest.at ?? null,
			durationMs,
			targetMs: TARGET_MS,
			ceilingMs: CEILING_MS,
			machine: latest.machine ?? null,
			slowest: latest.slowest ?? [],
		};
		ctx.warn(
			"SUITE-MARGIN",
			`${subject}, took ${secs(durationMs)}, over ${target}.`,
			data,
			`SUITE-MARGIN\t${latest.sha}`,
		);
		ctx.say(
			`SUITE-MARGIN — ${subject} (${latest.at ?? "undated"}), took ${secs(durationMs)}: over the ${secs(TARGET_MS)} target, against the ${secs(CEILING_MS)} ceiling.`,
		);
		ctx.say(`  ${machineLine(latest.machine)}`);
		if (data.slowest.length === 0) ctx.say("  slowest files: none recorded");
		else {
			ctx.say("  slowest files:");
			for (const s of data.slowest)
				ctx.say(`    ${s.seconds.toFixed(1)} s  ${s.file}`);
		}
		ctx.say(
			"  A whole suite past the ceiling is killed and the push gate goes red (#2667). Cut its heavy tail by measured cost (#2729).",
		);
		return { noun: "suite over its margin", count: 1, data };
	},
});
