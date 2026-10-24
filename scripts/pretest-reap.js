#!/usr/bin/env node
/*
 * pretest-reap.js — return finished sessions' memory before a suite runs.
 *
 * THE PROBLEM (mantahostels#1840, which ruled this seam). `reap-finished-sessions.js` runs
 * at SessionStart and nowhere else, so a session that reaches `npm run test`
 * hours later reads the headroom the ladder demands (docs/environment.md §6)
 * against a pool holding 330-450 MB per finished-but-resident neighbour. The
 * session then stops and asks the founder, who tells it to reap — the reap
 * being the answer every time, it belongs on the suite's own path.
 *
 * WHY npm's `pretest` AND NOT A HOOK. A PreToolUse Bash hook sees the spellings
 * it matches and no others, and never sees a terminal run at all. `pretest` is
 * on the one route every caller takes to the suite, and `pretest:changed` on
 * the narrowed one (workflow-core#633).
 *
 * IT NEVER REFUSES. npm aborts a script on a non-zero pre-script, which would turn
 * a stall into a hard block — still landing on the founder. Every failure here
 * degrades to a printed line and exit 0: an unreadable /proc/meminfo, a reaper
 * that throws, a pool still short after reaping.
 *
 * IT ONLY REAPS WHEN SHORT — for the suite being started (workflow-core#627). The run needs
 * the rung for the vitest workers already running plus a whole suite's, each
 * running run weighed by the test files its runner line names (workflow-core#2560). This
 * script runs before vitest spawns, so the run is never in its own count.
 * Above that rung there is nothing to buy: no `claude stop` calls, nothing
 * printed. It over-reaches for a run naming 1–2 files, which it judges as a
 * whole suite, and under-reaches beside a non-vitest runner, which goes
 * uncounted.
 */

const { writeFd } = require("./lib/write-fd.js");
const { execFileSync } = require("node:child_process");
const nodePath = require("node:path");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const {
	SUITE_MAX,
	SUITE_WORKERS,
	availableMb,
	readRunningVitestSuites,
	suiteRungMb,
} = require("./lib/admission");

const REAP_SCRIPT = () =>
	process.env.WFC_REAP_SCRIPT ||
	nodePath.join(__dirname, "reap-finished-sessions.js");

/** @param {number} busy the vitest workers already running */
function rungName(busy) {
	const mb = suiteRungMb(busy + SUITE_WORKERS);
	const suite = busy / SUITE_WORKERS + 1;
	if (suite === 1) return `the ${mb} MB one-suite rung`;
	return Number.isInteger(suite) && suite <= SUITE_MAX
		? `the ${mb} MB rung for suite ${suite} of ${SUITE_MAX}`
		: `the ${mb} MB rung for ${busy + SUITE_WORKERS} vitest workers, ${busy} of them already running`;
}

function runReapScript() {
	/* stderr is captured rather than inherited: a reaper that dies would
	 * otherwise print a node stack trace above the suite's own output. */
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
			`pretest: running suites unread (${running.error}) — judging against ${rungName(0)}`,
		);
	const busy = running.ok ? running.workers : 0;
	const rungMb = suiteRungMb(busy + SUITE_WORKERS);
	const rung = rungName(busy);

	const before = availableMb();
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
	/* A reaper that throws is printed, never fatal: exit 0. */
	let out = "";
	try {
		out = runReapScript().trim();
	} catch (e) {
		/* First line only: execFileSync folds the child's whole stderr into
		 * `message`, which is a stack trace above the suite's output. */
		const msg = e instanceof Error ? e.message : String(e);
		out = `reap: did not run — ${msg.split("\n")[0]}`;
	}
	if (out) log(out);

	const after = availableMb();
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
