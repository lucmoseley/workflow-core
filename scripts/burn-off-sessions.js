#!/usr/bin/env node
/**
 * burn-off-sessions.js — move every live background session still running on
 * Fable back to Opus, for `scripts/burn-mode.sh off` (#4992). A program of
 * its own rather than a lib/burn-mode.js mode: it stops and launches
 * sessions, which the table module never does.
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
 * A session is judged by the model its transcript last answered on; a
 * finished job is never woken. Refuses with exit 2 while the marker still
 * exists. Exit 1 where any session may still be on Fable: one not moved, the
 * session running this (it cannot resume itself), or one whose model will not
 * read — each named with why.
 */
const { caught } = require("./lib/caught.js");
const { readLiveSessions } = require("./lib/burn-off-listing.js");
const { isBurnMarkerOn, isFable } = require("./lib/burn-mode.js");
const { buildResumeIo } = require("./lib/resume-io.js");
const { resumeSteps } = require("./lib/refill-resume.js");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const { parseArgs } = require("node:util");

const USAGE = `usage: node ${scriptPath("burn-off-sessions.js")} [--dry-run]\n`;

const PROMPT = `Burn mode is off, so this session moved from Fable 5.2 to Opus 5.5 and resumed under its own id (${scriptPath("burn-off-sessions.js")}, #4992). Carry on exactly where you left off.`;

/**
 * @typedef {import("./lib/burn-off-listing.js").LiveSession} LiveSession
 * @typedef {{dryRun: boolean, self: string,
 *   resume: () => Pick<ReturnType<typeof resumeSteps>, "resumeOwnId">,
 *   out: (line: string) => void, err: (line: string) => void}} MoveContext
 */

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
		writeFd(2, `burn-off-sessions: ${caught(e).message}\n${USAGE}`);
		return 2;
	}
}

/**
 * Move one Fable session to Opus, or say why not.
 * @param {LiveSession} s
 * @param {MoveContext} how
 * @returns {boolean} false where the session may still be on Fable
 */
function moveOne(s, how) {
	const label = `${s.name || s.sessionId} (${s.seat})`;
	if (s.sessionId === how.self) {
		how.err(
			`error: ${label} is the session running this — it stays on Fable until restarted`,
		);
		return false;
	}
	if (!s.cwd) {
		how.err(`error: ${label} not moved: its listing names no directory`);
		return false;
	}
	if (how.dryRun) {
		how.out(`would move to Opus: ${label}`);
		return true;
	}
	const r = how
		.resume()
		.resumeOwnId({ root: s.cwd, seat: s.seat, issues: [] }, PROMPT, {
			sessionId: s.sessionId,
			cwd: s.cwd,
		});
	if (r.failed === null) {
		how.out(`moved to Opus: ${label}`);
		return true;
	}
	how.err(`error: ${label} not moved: ${r.failed}`);
	return false;
}

/**
 * Every live session that may be on Fable: on it, or of a model unread.
 * @param {LiveSession[]} sessions
 * @param {(line: string) => void} err
 * @returns {{onFable: LiveSession[], unread: number}}
 */
function sortSessions(sessions, err) {
	const unread = sessions.filter((s) => !s.model);
	for (const s of unread)
		err(
			`error: ${s.name || s.sessionId} (${s.seat}): no model read off its transcript — check it by hand`,
		);
	return {
		onFable: sessions.filter((s) => isFable(s.model)),
		unread: unread.length,
	};
}

function main() {
	const args = readArgs();
	if (typeof args === "number") return args;
	const out = (/** @type {string} */ line) => writeFd(1, `${line}\n`);
	const err = (/** @type {string} */ line) => writeFd(2, `${line}\n`);
	if (isBurnMarkerOn(process.env)) {
		err(
			`burn-off-sessions: burn mode is on — run ${scriptPath("burn-mode.sh")} off, which runs this`,
		);
		return 2;
	}
	const { sessions, faults } = readLiveSessions(process.env.HOME ?? "");
	for (const f of faults) err(`warning: ${f}`);
	const { onFable, unread } = sortSessions(sessions, err);
	if (onFable.length === 0 && unread === 0)
		out("no live background session runs on Fable");
	/** @type {ReturnType<typeof resumeSteps> | undefined} */
	let steps;
	/** @type {MoveContext} */
	const how = {
		dryRun: args.dryRun,
		self: process.env.CLAUDE_CODE_SESSION_ID ?? "",
		resume: () => {
			steps ??= resumeSteps(buildResumeIo((what) => err(`  ${what}`)));
			return steps;
		},
		out,
		err,
	};
	const failed = onFable.filter((s) => !moveOne(s, how)).length;
	return failed + unread ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { moveOne };
