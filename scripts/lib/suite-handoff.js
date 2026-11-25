const { readEnvironVar } = require("./proc-environ.js");
const { procRoot } = require("./proc-root.js");
const { orFallback } = require("./caught.js");
const {
	FULL_REASONS,
	FULL_CAUSES,
	TOUCHED_BASES,
} = require("./test-pass-marker.js");

const LAUNCH_ENV = "WFC_SUITE_LAUNCH";

/**
 * @typedef {{
 *   admissible: boolean,
 *   isolated: boolean,
 *   viaChanged: boolean,
 *   touched: boolean,
 *   full: string|null,
 *   fullCause: string|null,
 *   argv: string[]|null,
 *   resolvedFiles: number|null,
 *   wholeSlot: boolean,
 *   leftOut: string[]|null,
 *   touchedBase: import("./test-pass-marker.js").TouchedBase|null,
 *   changedPaths: string[]|null,
 *   base: string|null,
 * }} Launch
 */

/** @param {unknown} v @returns {string[]|null} */
const stringsOrNull = (v) =>
	Array.isArray(v) && v.every((w) => typeof w === "string") ? v : null;

/** @param {readonly string[]} vocabulary @param {unknown} v @returns {string|null} */
const oneOf = (vocabulary, v) =>
	typeof v === "string" && vocabulary.includes(v) ? v : null;

/** @param {Record<string, unknown>} raw @returns {Launch} */
function validLaunch(raw) {
	return {
		admissible: raw.admissible === true,
		isolated: raw.isolated === true,
		viaChanged: raw.viaChanged === true,
		touched: raw.touched === true,
		full: oneOf(FULL_REASONS, raw.full),
		fullCause: oneOf(FULL_CAUSES, raw.fullCause),
		argv: stringsOrNull(raw.argv),
		resolvedFiles:
			Number.isInteger(raw.resolvedFiles) && Number(raw.resolvedFiles) >= 0
				? Number(raw.resolvedFiles)
				: null,
		wholeSlot: raw.wholeSlot === true,
		leftOut: stringsOrNull(raw.leftOut),
		touchedBase: /** @type {Launch["touchedBase"]} */ (
			oneOf(TOUCHED_BASES, raw.touchedBase)
		),
		changedPaths: stringsOrNull(raw.changedPaths),
		base:
			typeof raw.base === "string" && raw.base.trim() ? raw.base.trim() : null,
	};
}

/** @param {Partial<Launch>} launch @returns {Record<string, string>} */
function launchEnv(launch) {
	return { [LAUNCH_ENV]: JSON.stringify(validLaunch(launch)) };
}

/** @param {Record<string, string|undefined>} [env] @returns {Launch} */
function readLaunch(env = process.env) {
	const raw = orFallback(() => JSON.parse(env[LAUNCH_ENV] ?? ""), null);
	return validLaunch(raw !== null && typeof raw === "object" ? raw : {});
}

/** @typedef {Pick<Launch, "resolvedFiles"|"wholeSlot">} CarriedWeight */

/**
 * @param {number | null} pid
 * @param {string} [proc]
 * @returns {CarriedWeight | null}
 */
function readCarriedWeight(pid, proc = procRoot()) {
	if (pid === null) return null;
	const record = readEnvironVar(pid, LAUNCH_ENV, proc);
	if (!record.ok || record.value === null) return null;
	const { resolvedFiles, wholeSlot } = readLaunch({
		[LAUNCH_ENV]: record.value,
	});
	return resolvedFiles === null && !wholeSlot
		? null
		: { resolvedFiles, wholeSlot };
}

/**
 * @typedef {{
 *   outcome: boolean|null,
 *   scope: import("./test-pass-marker.js").Scope|null,
 *   attestation: import("./test-pass-marker.js").Attestation|null,
 *   startedAtMs: number|null,
 *   elapsedMs: number|null,
 *   machineStart: import("./cpu-sample.js").CpuSample|null,
 *   machineEnd: import("./cpu-sample.js").CpuSample|null,
 *   endedAtMs: number|null,
 *   slowest: import("./test-file-timings.js").SlowFile[]|null,
 *   files: {results: import("./pass-store.js").FileResult[], shared: string[],
 *     clean: boolean}|null,
 * }} RunReport
 */

/** @returns {RunReport} */
const buildEmptyReport = () => ({
	outcome: null,
	scope: null,
	attestation: null,
	startedAtMs: null,
	elapsedMs: null,
	machineStart: null,
	machineEnd: null,
	endedAtMs: null,
	slowest: null,
	files: null,
});

let report = buildEmptyReport();

/** @param {Partial<RunReport>} fields */
function fillRunReport(fields) {
	for (const key of Object.keys(fields))
		if (!(key in report)) throw new Error(`no run report field ${key}`);
	report = { ...report, ...fields };
}

/** @returns {RunReport} */
function takeRunReport() {
	const taken = report;
	report = buildEmptyReport();
	return taken;
}

module.exports = {
	launchEnv,
	readLaunch,
	readCarriedWeight,
	fillRunReport,
	takeRunReport,
};
