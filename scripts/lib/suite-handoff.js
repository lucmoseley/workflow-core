/*
 * suite-handoff.js — the suite certificate's two hand-offs (#1491).
 *
 * THE LAUNCH RECORD crosses the spawn boundary: `scripts/run-vitest.js` knows
 * how a run was launched, and the reporter and the globalSetup teardown that
 * write the certificate run in the vitest child, which inherits the parent's
 * environment and never its argv. So the record travels as JSON in one
 * environment key, `launchEnv` writing it and `readLaunch` reading it.
 *
 * ALWAYS SET, NEVER OMITTED (mantahostels#2146). `runOnce` spreads `launchEnv`
 * into every spawn, so an inner run never inherits an outer run's record: an
 * outer admissible run must not lend the flag to an inner hand-typed one.
 *
 * EACH FIELD FAILS SHUT ON ITS OWN. A forged, mistyped or off-vocabulary field
 * reads as absent and the others stand; a value that does not parse, or no
 * key at all, reads as a record with every field absent. A run started any
 * way but `run-vitest.js` — a hand-typed `vitest run`, a bare `vitest
 * --changed` — therefore certifies as the hand-typed run it is. Nothing here
 * tells a real record from one exported by hand, and the push gate warns
 * rather than refuses for that reason (mantahostels#908).
 *
 * THE RUN REPORT crosses no boundary: vitest runs reporters and globalSetup in
 * one process and calls `onTestRunEnd` strictly before `teardown` (measured
 * against vitest 4.1.10 at mantahostels#987), and both reach this module
 * through the same require cache. So the reporter fills the report in memory
 * and the teardown takes it.
 *
 * ONE TAKE CLEARS ALL OF IT. A null outcome means the reporter never ran, and
 * then no certificate is written: a missing certificate costs a warning, a
 * false one costs the gate. A stale closure would attest a later run's sha on
 * an earlier run's reads. The timings clear too (#1461 Q4): the teardown
 * takes once per process, so nothing reads them a second time.
 *
 * THE TIMINGS ARE FILLED PER RUN, never in globalSetup (mantahostels#1953).
 * `setup` and `teardown` fire once per PROCESS; in watch mode one process
 * serves every re-run, so a bracket taken there would time the whole watch
 * session, idle minutes and all, while the certificate carries the last
 * re-run's verdict. The reporter's `onTestRunStart` and `onTestRunEnd` fire
 * per run, so the last fill describes the run the certificate is for.
 */

const { FULL_REASONS, FULL_CAUSES } = require("./test-pass-marker.js");

const LAUNCH_ENV = "WFC_SUITE_LAUNCH";

/**
 * How the run was launched, as the certificate records it.
 *
 * - `admissible`: the narrowed run may stand in for a whole-suite one at the
 *   push (mantahostels#2146, mantahostels#2207). Only the launcher can know:
 *   it sets this having checked the read graph against the tree, on an argv
 *   of nothing but `--changed`.
 * - `isolated`: the run read a frozen `--isolated` worktree rather than the
 *   shared tree (mantahostels#2169, mantahostels#2187).
 * - `viaChanged`: the run came from `npm run test:changed` at all, pass or
 *   fail on the freshness check (mantahostels#2303). A DENOMINATOR, NEVER A
 *   CERTIFICATE: without it a failed `test:changed` is byte-identical in the
 *   store to a hand-typed file list, because the launcher consumes
 *   `--changed` before vitest sees it. No gate may read it. The launcher
 *   takes it off argv, never off the selection plan: a null plan is both a
 *   `--changed`-free argv and an expansion that failed open, and the second
 *   is the one the store could not otherwise see.
 * - `full`: why the run was unnarrowed, one of `FULL_REASONS` (mantahostels#3207).
 * - `fullCause`: why the session typed `--full=<cause>`, one of `FULL_CAUSES`
 *   (#182). Read only beside `full: "flag"`.
 * - `argv`: the launch's own argv before any flag was stripped (#182).
 * - `changedPaths`, `base`: the diff the narrowed selection was computed from
 *   and what it was diffed against (#189); absent on a full run and on an
 *   expansion that failed open, so such a certificate covers no path by them.
 *
 * @typedef {{
 *   admissible: boolean,
 *   isolated: boolean,
 *   viaChanged: boolean,
 *   full: string|null,
 *   fullCause: string|null,
 *   argv: string[]|null,
 *   changedPaths: string[]|null,
 *   base: string|null,
 * }} Launch
 */

/** @param {unknown} v @returns {string[]|null} */
const stringsOrNull = (v) =>
	Array.isArray(v) && v.every((w) => typeof w === "string") ? v : null;

/** @param {string[]} vocabulary @param {unknown} v @returns {string|null} */
const oneOf = (vocabulary, v) =>
	typeof v === "string" && vocabulary.includes(v) ? v : null;

/**
 * Every field of a launch, validated on its own — the one rule both ends
 * apply, so the encoder can never write what the decoder would refuse.
 * @param {Record<string, unknown>} raw
 * @returns {Launch}
 */
function validLaunch(raw) {
	return {
		admissible: raw.admissible === true,
		isolated: raw.isolated === true,
		viaChanged: raw.viaChanged === true,
		full: oneOf(FULL_REASONS, raw.full),
		fullCause: oneOf(FULL_CAUSES, raw.fullCause),
		argv: stringsOrNull(raw.argv),
		changedPaths: stringsOrNull(raw.changedPaths),
		base:
			typeof raw.base === "string" && raw.base.trim() ? raw.base.trim() : null,
	};
}

/**
 * The environment entry carrying a launch into the vitest child.
 * @param {Partial<Launch>} launch
 * @returns {Record<string, string>}
 */
function launchEnv(launch) {
	return { [LAUNCH_ENV]: JSON.stringify(validLaunch(launch)) };
}

/**
 * The launch off the environment the child inherited.
 * @param {Record<string, string|undefined>} [env]
 * @returns {Launch}
 */
function readLaunch(env = process.env) {
	let raw = null;
	try {
		raw = JSON.parse(env[LAUNCH_ENV] ?? "");
	} catch {
		/* unparseable or missing reads as every field absent */
	}
	return validLaunch(raw !== null && typeof raw === "object" ? raw : {});
}

/**
 * What the reporter hands the teardown: the verdict, the scope, the
 * attestation (#189), and both halves of the time and CPU brackets
 * (mantahostels#1953). The bracket field names are `markerFrom`'s own.
 *
 * @typedef {{
 *   outcome: boolean|null,
 *   scope: import("./test-pass-marker.js").Scope|null,
 *   attestation: import("./test-pass-marker.js").Attestation|null,
 *   startedAtMs: number|null,
 *   machineStart: import("./cpu-sample.js").CpuSample|null,
 *   machineEnd: import("./cpu-sample.js").CpuSample|null,
 *   endedAtMs: number|null,
 * }} RunReport
 */

/** @returns {RunReport} */
const emptyReport = () => ({
	outcome: null,
	scope: null,
	attestation: null,
	startedAtMs: null,
	machineStart: null,
	machineEnd: null,
	endedAtMs: null,
});

let report = emptyReport();

/**
 * Sets the named fields, leaving the rest as they stand. Throws on a field
 * the report does not carry, so a misspelt fill fails its test rather than
 * leaving the field null in every certificate.
 * @param {Partial<RunReport>} fields
 */
function fillRunReport(fields) {
	for (const key of Object.keys(fields))
		if (!(key in report)) throw new Error(`no run report field ${key}`);
	report = { ...report, ...fields };
}

/** @returns {RunReport} the whole report, which it clears */
function takeRunReport() {
	const taken = report;
	report = emptyReport();
	return taken;
}

module.exports = { launchEnv, readLaunch, fillRunReport, takeRunReport };
