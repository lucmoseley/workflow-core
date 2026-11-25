#!/usr/bin/env node
const { caught } = require("./lib/caught.js");
const { readLiveSessions } = require("./lib/burn-off-listing.js");
const { isBurnMarkerOn } = require("./lib/burn-mode.js");
const { isRoutedAway } = require("./lib/model-table.js");
const { buildResumeIo } = require("./lib/resume-io.js");
const { resumeSteps } = require("./lib/refill-resume.js");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const { parseArgs } = require("node:util");

const USAGE = `usage: node ${scriptPath("burn-off-sessions.js")} [--dry-run]\n`;

const PROMPT = `Burn mode is off, so this session moved off burn mode's model to the standard one and resumed under its own id (${scriptPath("burn-off-sessions.js")}, workflow-core#4992). Carry on exactly where you left off.`;

/**
 * @typedef {import("./lib/burn-off-listing.js").LiveSession} LiveSession
 * @typedef {{dryRun: boolean, self: string,
 *   resume: () => Pick<ReturnType<typeof resumeSteps>, "resumeOwnId">,
 *   out: (line: string) => void, err: (line: string) => void}} MoveContext
 */

/** @returns {{dryRun: boolean} | number} */
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
 * @param {LiveSession} s
 * @param {MoveContext} how
 * @returns {boolean}
 */
function moveOne(s, how) {
	const label = `${s.name || s.sessionId} (${s.seat})`;
	if (s.sessionId === how.self) {
		how.err(
			`error: ${label} is the session running this — it stays on ${s.model} until restarted`,
		);
		return false;
	}
	if (!s.cwd) {
		how.err(`error: ${label} not moved: its listing names no directory`);
		return false;
	}
	if (how.dryRun) {
		how.out(`would move to the standard model: ${label}`);
		return true;
	}
	const r = how
		.resume()
		.resumeOwnId({ root: s.cwd, seat: s.seat, issues: [] }, PROMPT, {
			sessionId: s.sessionId,
			cwd: s.cwd,
		});
	if (r.failed === null) {
		how.out(`moved to the standard model: ${label}`);
		return true;
	}
	how.err(`error: ${label} not moved: ${r.failed}`);
	return false;
}

/**
 * @param {LiveSession[]} sessions
 * @param {(line: string) => void} err
 * @returns {{routedAway: LiveSession[], unread: number}}
 */
function sortSessions(sessions, err) {
	const unread = sessions.filter((s) => !s.model);
	for (const s of unread)
		err(
			`error: ${s.name || s.sessionId} (${s.seat}): no model read off its transcript — check it by hand`,
		);
	return {
		routedAway: sessions.filter((s) => isRoutedAway(s.model)),
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
	const { routedAway, unread } = sortSessions(sessions, err);
	if (routedAway.length === 0 && unread === 0)
		out("no live background session runs on a model only burn mode uses");
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
	const failed = routedAway.filter((s) => !moveOne(s, how)).length;
	return failed + unread ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { moveOne };
