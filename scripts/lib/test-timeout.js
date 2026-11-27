const { isBackgroundJob } = require("./job-paths.js");
const { QUOTED, carriesVar, literal } = require("./shell-words.js");
const { parseCommand, walkCommands } = require("./shell-parse.js");
const {
	buildIsWrapperScript,
	isSnapshotLaunch,
	suiteLaunchKind,
} = require("./suite-launch.js");
const {
	MOVED_RUN_WAIT,
	SNAPSHOT_RUN_TIMEOUT_MS,
	SUBAGENT_WAIT,
} = require("./wait-text.js");

const ESCAPE = "WFC_TEST_TIMEOUT";

/**
 * @param {string} command
 * @param {import("./core-contract.js").CoreContext} ctx
 * @returns {"snapshot" | "held" | null}
 */
function classifyLaunches(command, ctx) {
	const parsed = parseCommand(command);
	/** @param {string} w */
	const typed = (w) => {
		if (!w.includes(QUOTED)) return w;
		const lit = literal(w, parsed.spans);
		return lit.known ? lit.text : w;
	};
	const isWrapperScript = buildIsWrapperScript(ctx.tree, ctx.log);
	const ports = { runners: () => [], isWrapperScript };
	let snapshot = false;
	let held = false;
	walkCommands(
		parsed,
		(cmd) => {
			for (const { words, wrapperWords } of cmd.runs()) {
				const ws = words.map(typed);
				const launch = suiteLaunchKind(ws, ports);
				if (!launch) continue;
				const own =
					isSnapshotLaunch(launch, ws) &&
					(launch.kind === "wrapper" || isWrapperScript(launch.script));
				if (!own || carriesVar(ESCAPE, cmd.leading, wrapperWords)) held = true;
				else snapshot = true;
			}
		},
		ctx,
	);
	if (held) return "held";
	return snapshot ? "snapshot" : null;
}

/** @param {import("./core-contract.js").CoreContext} ctx */
function buildOverrunText(ctx) {
	if (ctx.agent) return `Then ${SUBAGENT_WAIT}`;
	const idle = isBackgroundJob(ctx.env)
		? `hold the turn on ${MOVED_RUN_WAIT}`
		: "end the turn with NO tool call";
	return `Then keep working on independent work; with none left, ${idle}.`;
}

/**
 * @param {string} command
 * @param {import("./core-contract.js").CoreContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const { input } = ctx;
	if (input.run_in_background === true) return null;
	const asked = input.timeout;
	if (typeof asked === "number" && asked <= SNAPSHOT_RUN_TIMEOUT_MS)
		return null;
	if (classifyLaunches(command, ctx) !== "snapshot") return null;
	const given =
		typeof asked === "number" ? `\`timeout: ${asked}\`` : "no `timeout`";
	return {
		deny: ctx.corePaths(
			`This test run reads a launch snapshot of your tree, so it runs in the foreground with the Bash tool's \`timeout: ${SNAPSHOT_RUN_TIMEOUT_MS}\`, not ${given}: past ${SNAPSHOT_RUN_TIMEOUT_MS / 1000} s it moves to the background and notifies, and your edits meanwhile cannot touch its verdict (#5716). Re-send the same command with \`timeout: ${SNAPSHOT_RUN_TIMEOUT_MS}\`. ${buildOverrunText(ctx)} A \`--full=<cause>\` or \`--queue\` run keeps \`timeout: 600000\`. Genuinely need the longer foreground wait? Prefix the command with \`${ESCAPE}=1\`.`,
		),
	};
}

module.exports = { field: "command", noun: "test launch", decide };
