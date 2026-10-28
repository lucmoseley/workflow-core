#!/usr/bin/env node
/*
 * concurrency-readout.js — `npm run status`'s concurrency block (#3317): the
 * refill loop's last verdict, its "also" limits, memory's largest holder and
 * the 24-hour sustained figure, from the two records lib/concurrency.js
 * reads. Refreshes the precomputed 24-hour file as it goes. Reads no
 * transcript and runs nowhere at session start (#2038).
 *
 * In no family (§N3): it files nothing, checks nothing and always exits 0;
 * `npm run status` prints its standing.
 *
 * Usage:  node scripts/concurrency-readout.js
 */

const {
	SUSTAINED_WINDOW_MS,
	buildBlockText,
	readRecords,
	readout,
	writeSustained,
} = require("./lib/concurrency.js");
const { writeFd } = require("./lib/write-fd.js");

const r = readout({
	...readRecords(),
	now: Date.now(),
	windowMs: SUSTAINED_WINDOW_MS,
});
writeSustained(r);
writeFd(1, `${buildBlockText(r)}\n`);
