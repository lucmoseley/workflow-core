#!/usr/bin/env node
/*
 * concurrency-readout.js — `npm run status`'s concurrency block (#3317): the
 * refill loop's last verdict, its "also" limits, memory's largest holder and
 * the 24-hour sustained figure, from the two records lib/concurrency.js
 * reads. Where the newest tick is stale, as it is whenever the refill loop is
 * off (#3215), the unlisted watch reads `admission.js --json` live instead
 * (#3496). Refreshes the precomputed 24-hour file as it goes. Reads no
 * transcript and runs nowhere at session start (#2038).
 *
 * In no family (§N3): it files nothing, checks nothing and always exits 0.
 *
 * Usage:  node scripts/concurrency-readout.js
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const {
	SUSTAINED_WINDOW_MS,
	buildBlockText,
	readRecords,
	readout,
	writeSustained,
} = require("./lib/concurrency.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { childFailure, childVerdict } = require("./lib/child-failure.js");
const { writeFd } = require("./lib/write-fd.js");

/* Untraced: over ten times the ~5 s one run took (#3496). */
const ADMISSION_TIMEOUT_MS = 60_000;

/**
 * Admission's unlisted row read now, unknown where admission did not give
 * one. Allowance is skipped: the row is memory's alone.
 * @returns {import("./lib/concurrency.js").UnlistedRead}
 */
function readLiveUnlisted() {
	const r = spawnSync(
		process.execPath,
		[path.join(__dirname, "admission.js"), "--json", "--skip-allowance"],
		{
			encoding: "utf8",
			timeout: ADMISSION_TIMEOUT_MS,
			maxBuffer: CHILD_MAX_BUFFER,
		},
	);
	/* Admission prints its JSON on a hold (exit 1) and a refusal (exit 2)
	 * alike, so the parse judges the read, not the exit. */
	let row = null;
	try {
		/* Read off any verdict, a refusal included, which also carries
		 * `memory`. */
		/** @type {{memory?: {unlisted?: import("./lib/concurrency.js").UnlistedRead}}} */
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
	const r = readout({
		...readRecords(),
		now: Date.now(),
		windowMs: SUSTAINED_WINDOW_MS,
	});
	writeSustained(r);
	writeFd(1, `${buildBlockText(r, readLiveUnlisted)}\n`);
	return 0;
}

if (require.main === module) process.exit(main());

module.exports = { main };
