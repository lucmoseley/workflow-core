#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const {
	buildBlockText,
	buildVerdict,
	readTicks,
} = require("./lib/concurrency.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { childFailure, childVerdict } = require("./lib/child-failure.js");
const { writeFd } = require("./lib/write-fd.js");

// workflow-core#3496 guess, over ten times one ~5 s run
const ADMISSION_TIMEOUT_MS = 60_000;

/** @type {import("node:child_process").SpawnSyncReturns<string> | undefined} */
let liveAdmission;
const readLiveAdmission = () => {
	liveAdmission ??= spawnSync(
		process.execPath,
		[path.join(__dirname, "admission.js"), "--json", "--skip-allowance"],
		{
			encoding: "utf8",
			timeout: ADMISSION_TIMEOUT_MS,
			maxBuffer: CHILD_MAX_BUFFER,
		},
	);
	return liveAdmission;
};

/** @returns {number | null} */
function readLiveHeldRun() {
	try {
		const { heldRunMb } = JSON.parse(readLiveAdmission().stdout);
		return Number.isFinite(heldRunMb) ? heldRunMb : null;
	} catch {
		return null;
	}
}

/**
 * @returns {import("./lib/concurrency.js").UnlistedRead}
 */
function readLiveUnlisted() {
	const r = readLiveAdmission();
	let row = null;
	try {
		/** @type {Partial<Pick<import("./lib/admission.js").AdmissionJson, "memory">>} */
		const verdict = JSON.parse(r.stdout);
		row = verdict.memory?.unlisted;
	} catch {
		row = null;
	}
	return (
		row ?? {
			count: null,
			mb: null,
			unknown: `admission gave no unlisted row: ${childFailure(childVerdict(r)) || "exit 0"}`,
		}
	);
}

/** @returns {number} */
function main() {
	const r = buildVerdict({ ...readTicks(), now: Date.now() });
	writeFd(1, `${buildBlockText(r, readLiveUnlisted, readLiveHeldRun)}\n`);
	return 0;
}

if (require.main === module) process.exit(main());

module.exports = { main };
