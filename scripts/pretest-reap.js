#!/usr/bin/env node
const { writeFd } = require("./lib/write-fd.js");
const { execFileSync } = require("node:child_process");
const nodePath = require("node:path");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const {
	SUITE_MAX,
	WHOLE_SUITE_WORKERS,
	readRunningVitestSuites,
	suiteRungMb,
} = require("./lib/admission");
const { readAvailableMb, readTotalMb } = require("./lib/meminfo.js");
const { clampedClause, reachableRung } = require("./lib/suite-ladder.js");

const REAP_SCRIPT = () =>
	process.env.WFC_REAP_SCRIPT ||
	nodePath.join(__dirname, "reap-finished-sessions.js");

/** @param {number} busy */
const reachOf = (busy) =>
	reachableRung(suiteRungMb(busy + WHOLE_SUITE_WORKERS), readTotalMb());

/**
 * @param {number} busy
 * @param {import("./lib/suite-ladder.js").Reach} reach
 */
function rungName(busy, { rungMb: mb, ladderMb }) {
	const workers = busy + WHOLE_SUITE_WORKERS;
	const suite = workers / WHOLE_SUITE_WORKERS;
	const clamp = clampedClause(ladderMb);
	if (suite === 1) return `the ${mb} MB one-suite rung${clamp}`;
	return Number.isInteger(suite) && suite <= SUITE_MAX
		? `the ${mb} MB rung for suite ${suite} of ${SUITE_MAX}${clamp}`
		: `the ${mb} MB rung for ${workers} vitest workers, ${busy} of them already running${clamp}`;
}

function runReapScript() {
	return execFileSync(process.execPath, [REAP_SCRIPT()], {
		encoding: "utf8",
		maxBuffer: CHILD_MAX_BUFFER,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function pretestReap() {
	const log = (/** @type {string} */ line) => writeFd(1, `${line}\n`);
	const running = readRunningVitestSuites();
	if (!running.ok)
		log(
			`pretest: running suites unread (${running.error}) — judging against ${rungName(0, reachOf(0))}`,
		);
	const busy = running.ok ? running.workers : 0;
	const reach = reachOf(busy);
	const rungMb = reach.rungMb;
	const rung = rungName(busy, reach);

	const before = readAvailableMb();
	if (!before.ok) {
		log(
			`pretest: available memory unread (${before.error}) — suite runs anyway`,
		);
		return 0;
	}
	if (before.mb >= rungMb) return 0;

	log(
		`pretest: ${before.mb} MB available, under ${rung} — reaping finished sessions`,
	);
	let out = "";
	try {
		out = runReapScript().trim();
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		out = `reap: did not run — ${msg.split("\n")[0]}`;
	}
	if (out) log(out);

	const after = readAvailableMb();
	if (!after.ok) {
		log(`pretest: available memory unread after the reap (${after.error})`);
		return 0;
	}
	if (after.mb >= rungMb) {
		log(`pretest: ${after.mb} MB available now — above ${rung}`);
		return 0;
	}
	log(
		`pretest: still ${after.mb} MB available, under ${rung} — nothing further is reapable. ` +
			"The suite runs anyway and earlyoom may kill it; wait for a working session to finish, or stop one by name.",
	);
	return 0;
}

if (require.main === module) process.exit(pretestReap());
