const { isBackgroundJob } = require("./job-paths.js");
const { carriesVar, typedWord } = require("./shell-words.js");
const { parseCommand, walkCommands } = require("./shell-parse.js");
const {
	buildCallsWrapperScript,
	isSnapshotLaunch,
	suiteLaunchKind,
} = require("./suite-launch.js");
const {
	MOVED_RUN_WAIT,
	SNAPSHOT_RUN_TIMEOUT_MS,
	SUBAGENT_WAIT,
} = require("./wait-text.js");

/**
 * @typedef {import("./core-contract.js").CoreContext
 *   & import("./suite-background.js").BackgroundPorts} Ctx
 */

const TIMEOUT_ESCAPE_VAR = "WFC_TEST_TIMEOUT";

/**
 * @param {string} command
 * @param {Ctx} ctx
 */
function isOnlySnapshotLaunch(command, ctx) {
	const parsed = parseCommand(command);
	const callsWrapper = buildCallsWrapperScript(ctx.tree, ctx.log);
	const ports = { runners: ctx.runners, isWrapperScript: callsWrapper };
	let snapshot = false;
	let other = false;
	walkCommands(
		parsed,
		(cmd) => {
			for (const { words, wrapperWords } of cmd.runs()) {
				const ws = words.map((w) => typedWord(w, parsed.spans));
				const launch = suiteLaunchKind(ws, ports);
				if (!launch) continue;
				const own =
					isSnapshotLaunch(launch, ws) &&
					(launch.kind === "wrapper" || callsWrapper(launch.script)) &&
					!carriesVar(TIMEOUT_ESCAPE_VAR, cmd.leading, wrapperWords);
				if (own) snapshot = true;
				else other = true;
			}
		},
		ctx,
	);
	return snapshot && !other;
}

/** @param {Ctx} ctx */
function buildOverrunText(ctx) {
	if (ctx.agent) return `Then ${SUBAGENT_WAIT}`;
	const idle = isBackgroundJob(ctx.env)
		? `hold the turn on ${MOVED_RUN_WAIT}`
		: "end the turn with NO tool call";
	return `Then keep working on independent work; with none left, ${idle}.`;
}

/**
 * @param {string} command
 * @param {Ctx} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const { input } = ctx;
	if (input.run_in_background === true) return null;
	const asked = input.timeout;
	if (typeof asked === "number" && asked <= SNAPSHOT_RUN_TIMEOUT_MS)
		return null;
	if (!isOnlySnapshotLaunch(command, ctx)) return null;
	const given =
		typeof asked === "number" ? `\`timeout: ${asked}\`` : "no `timeout`";
	return {
		deny: ctx.corePaths(
			`This test run reads a launch snapshot of your tree, so it runs in the foreground with the Bash tool's \`timeout: ${SNAPSHOT_RUN_TIMEOUT_MS}\`, not ${given}: past ${SNAPSHOT_RUN_TIMEOUT_MS / 1000} s it moves to the background and notifies, and your edits meanwhile cannot touch its verdict (workflow-core#5716). Re-send the same command with \`timeout: ${SNAPSHOT_RUN_TIMEOUT_MS}\`. ${buildOverrunText(ctx)} A \`--full=<cause>\` or \`--queue\` run keeps \`timeout: 600000\`. Genuinely need the longer foreground wait? Prefix the command with \`${TIMEOUT_ESCAPE_VAR}=1\`.`,
		),
	};
}

module.exports = { field: "command", noun: "test launch", decide };
