#!/usr/bin/env node
/**
 * burn-off-sessions.js — move every live background session still running on
 * Fable back to Opus, for `scripts/burn-mode.sh off` (#4992).
 *
 * Claude Code reads its model once, at startup, so `off` alone leaves a
 * session launched under burn mode on Fable until it ends, handing Fable to
 * its forks. Each one found is resumed under its own id through the refill
 * loop's own resume (lib/refill-resume.js `resumeOwnId`): its job stopped and
 * retired, then `claude --bg --resume` with its saved launch flags, whose
 * `--model` the burn table moves to Opus now the marker is gone. Its
 * conversation, name and id carry over, and so do its issue claims.
 *
 *   node scripts/burn-off-sessions.js [--dry-run]
 *
 * A session is judged by the model its transcript last answered on. The
 * session running this is never moved — it cannot resume itself — and is
 * named instead. Refuses with exit 2 while the marker still exists. Exit 1
 * where a session found could not be moved; each is named with why.
 */
const { listing } = require("./lib/burn-off-listing.js");
const { isFable, markerPath } = require("./lib/burn-mode.js");
const { buildResumeIo } = require("./lib/resume-io.js");
const { resumeSteps } = require("./lib/refill-resume.js");
const { writeFd } = require("./lib/write-fd.js");
const fs = require("node:fs");
const { parseArgs } = require("node:util");

const USAGE = "usage: node scripts/burn-off-sessions.js [--dry-run]\n";

const PROMPT =
	"Burn mode is off, so this session moved from Fable 5.2 to Opus 5.5 and resumed under its own id (scripts/burn-off-sessions.js, #4992). Carry on exactly where you left off.";

/**
 * The command line, or the exit code it ends on: 0 for --help, 2 refused.
 * @returns {{dryRun: boolean} | number}
 */
function readArgs() {
	try {
		const { values } = parseArgs({
			options: {
				"dry-run": { type: "boolean" },
				help: { type: "boolean" },
			},
			strict: true,
		});
		if (!values.help) return { dryRun: values["dry-run"] === true };
		writeFd(1, USAGE);
		return 0;
	} catch (e) {
		writeFd(
			2,
			`burn-off-sessions: ${/** @type {Error} */ (e).message}\n${USAGE}`,
		);
		return 2;
	}
}

/**
 * Move one Fable session to Opus, or say why not.
 * @param {import("./lib/burn-off-listing.js").LiveSession} s
 * @param {{dryRun: boolean, self: string,
 *   resume: () => ReturnType<typeof resumeSteps>}} how
 * @returns {boolean} false where a move was tried and failed
 */
function moveOne(s, { dryRun, self, resume }) {
	const label = `${s.name || s.sessionId} (${s.seat})`;
	if (s.sessionId === self) {
		writeFd(
			1,
			`left on Fable: ${label} is the session running this — restart it to move it\n`,
		);
		return true;
	}
	if (dryRun) {
		writeFd(1, `would move to Opus: ${label}\n`);
		return true;
	}
	const r = resume().resumeOwnId(
		{ root: s.cwd, seat: s.seat, issues: [] },
		PROMPT,
		{ sessionId: s.sessionId, cwd: s.cwd },
	);
	if (r.failed === null) {
		writeFd(1, `moved to Opus: ${label}\n`);
		return true;
	}
	writeFd(2, `error: ${label} not moved: ${r.failed}\n`);
	return false;
}

function main() {
	const args = readArgs();
	if (typeof args === "number") return args;
	if (fs.existsSync(markerPath())) {
		writeFd(
			2,
			"burn-off-sessions: burn mode is on — run scripts/burn-mode.sh off, which runs this\n",
		);
		return 2;
	}
	const { sessions, faults } = listing(process.env.HOME ?? "");
	for (const f of faults) writeFd(2, `warning: ${f}\n`);
	const onFable = sessions.filter((s) => isFable(s.model));
	if (onFable.length === 0) {
		writeFd(1, "no live background session runs on Fable\n");
		return 0;
	}
	/** @type {ReturnType<typeof resumeSteps> | undefined} */
	let steps;
	const how = {
		dryRun: args.dryRun,
		self: process.env.CLAUDE_CODE_SESSION_ID ?? "",
		resume: () => {
			steps ??= resumeSteps(buildResumeIo((what) => writeFd(2, `  ${what}\n`)));
			return steps;
		},
	};
	const failed = onFable.filter((s) => !moveOne(s, how)).length;
	return failed ? 1 : 0;
}

if (require.main === module) process.exitCode = main();
