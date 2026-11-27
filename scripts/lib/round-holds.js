const { isBackgroundJob } = require("./job-paths.js");
const { COMMENT_SPELLING, readIssueCall } = require("./gh-acts.js");
const { isGh } = require("./gh-issue-ref.js");
const { refuseOnce } = require("./refuse-once.js");
const { hasRoundMarker } = require("./round-marker.js");
const { parseCommand, walkCommands } = require("./shell-parse.js");

/**
 * @typedef {object} RoundHoldPorts
 * @property {string} home
 * @property {(path: string) => string|undefined} readFile
 * @property {() => boolean} isLatchWritable
 * @property {() => string[]} readHoldLines
 * @typedef {import("./kit-context.js").KitContext & RoundHoldPorts &
 *   { env: NodeJS.ProcessEnv }} RoundHoldContext
 */

/**
 * @param {string[]} holdLines
 * @param {string} issue
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
	if (!isBackgroundJob(ctx.env)) return null;
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
