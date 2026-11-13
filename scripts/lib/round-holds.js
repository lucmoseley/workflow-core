/*
 * round-holds.js — a PreToolUse dispatcher core (workflow-core#3858, spec workflow-core#3597, workflow-core#3195): one
 * question per founder-only block. It refuses, once a round, a background job's
 * `gh issue comment` that posts a question round, printing the checkout's open
 * repo holds.
 *
 * BEFORE THE POST, as a Stop guard's refusal comes once the round has reached
 * him. Refused rather than told: a PreToolUse context reaches the session with
 * the call's result, the round already out.
 *
 * WHETHER THE ROUND IS THE HOLD'S ACT IS THE SESSION'S JUDGEMENT. So it also
 * refuses a round about one ticket alone, whose re-send passes.
 *
 * A BACKGROUND JOB ONLY: nothing parks in an interactive session.
 *
 * LIMITS
 *  - Two jobs that both find no hold, within seconds, both raise and both ask.
 *  - A body it cannot read (`$(cat …)`, a file the same call writes, a missing
 *    file) passes, logged, and a round posted through `gh api` or a script's
 *    child `gh` is not seen.
 *  - A job that dies between raising and posting leaves a hold whose attachers
 *    wait on a round nobody posted.
 *  - Wired with `if: Bash(gh *)` (best-effort: a `timeout gh …` prefix or a
 *    path-spelled `gh` goes unjudged).
 *
 * IMPLICIT:  refuses, once per round body, a background job's `gh issue comment` whose body opens a `❓ **Qn**` round, printing this checkout's open repo holds and the attach and raise commands.
 * JUSTIFIED: fail-safe — once the round is posted the founder has the duplicate; this is the last moment before it (workflow-core#3597).
 * DEFEAT:    re-send the same call: the latch passes it.
 */

const { COMMENT_SPELLING, readIssueCall } = require("./gh-acts.js");
const { isGh } = require("./gh-issue-ref.js");
const { refuseOnce } = require("./refuse-once.js");
const { hasRoundMarker } = require("./round-marker.js");
const { parseCommand, walkCommands } = require("./shell-parse.js");

/**
 * @typedef {object} RoundHoldPorts
 * @property {string} home what a body path's leading `~` expands to
 * @property {(path: string) => string|undefined} readFile a body file's text,
 *   undefined where it is absent; throws where it cannot be read
 * @property {() => boolean} isLatchWritable
 * @property {() => string[]} readHoldLines what `repo-hold.js list` prints
 * @typedef {import("./kit-context.js").KitContext & RoundHoldPorts &
 *   { env: NodeJS.ProcessEnv }} RoundHoldContext
 */

/**
 * @param {string[]} holdLines
 * @param {string} issue  the issue the round was going to
 * @param {RoundHoldContext} ctx
 */
function buildRefusalText(holdLines, issue, ctx) {
	const cli = ctx.scriptPath("repo-hold.js");
	return [
		"Refused once: this posts a question round to the founder, and another session may already have asked him for the same act. An act only he can do on shared state, such as repairing the shared `main`, gets one question however many sessions meet it (workflow-core#3597).",
		"",
		"This checkout's repo holds:",
		...holdLines,
		"",
		"Then, by what your round asks:",
		`- A hold above names the same act: post no round. Run \`node ${cli} attach <id>\`; it prints how to end.`,
		`- No hold names it, and the act blocks work beyond your own ticket: run \`node ${cli} raise --act "<the act, in plain words>" --issue ${issue} --clear-issue ${issue}\`, then re-send this call.`,
		"- It concerns your own ticket alone: re-send this call.",
	].join("\n");
}

/**
 * @param {string} subject
 * @param {RoundHoldContext} ctx
 * @returns {{issue: string, body: string}[]}
 */
function readRounds(subject, ctx) {
	const parsed = parseCommand(subject);
	/** @type {{issue: string, body: string}[]} */
	const rounds = [];
	walkCommands(
		parsed,
		({ words, cwd }) => {
			if (!isGh(words) || words[1] !== "issue" || words[2] !== "comment")
				return;
			const call = readIssueCall("comment", words.slice(3), {
				spans: parsed.spans,
				subject,
				...COMMENT_SPELLING,
				cwd,
				home: ctx.home,
				readFile: ctx.readFile,
			});
			if (call.body.fault || call.body.hidden)
				ctx.log(`${call.body.fault || "body hidden"} — round unseen`);
			const [issue] = call.issues;
			if (
				issue !== undefined &&
				!call.noPost &&
				!call.body.hidden &&
				call.body.given &&
				hasRoundMarker(call.body.text)
			)
				rounds.push({ issue, body: call.body.text });
		},
		ctx,
	);
	return rounds;
}

/**
 * @param {string} command
 * @param {RoundHoldContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	if (!ctx.env.CLAUDE_JOB_DIR) return null;
	const rounds = readRounds(command, ctx);
	const [first] = rounds;
	if (!first) return null;
	return refuseOnce(
		{
			prefix: "round-holds",
			subject: rounds.map((r) => r.body).join("\n"),
			passed: "a round posted",
			buildDeny: () => buildRefusalText(ctx.readHoldLines(), first.issue, ctx),
		},
		ctx,
	);
}

module.exports = { field: "command", noun: "command", decide };
