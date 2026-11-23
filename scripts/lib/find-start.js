const { spliceCmd } = require("./guard-verdict.js");
const {
	BASH_SPACE,
	normAbs,
	parseCommand,
	walkCommands,
} = require("./shell-parse.js");
const { findStarts, literal } = require("./shell-words.js");
const { trimEndRun } = require("./trim-run.js");

const REFUSAL = `Refused: \`@CMD@\` starts at \`/\`. A find over the whole disk under WSL2 ran to the 2-minute timeout in about half of 114 measured calls, and neither \`-maxdepth\` nor \`-xdev\` saved it (#1006). Cheapest route first:

1. This plugin's own files: @ROOT@ — its scripts/ and docs/agents/ are there.
2. The repo's scratch, .claude/tmp/, and the repo itself.
3. Named roots: \`find /usr /opt /home -xdev -name …\`. Name /mnt/c only when the Windows disk is meant.

\`~\` and $HOME are cheap (median 5 s) and pass.`;

/**
 * @typedef {object} FindStartPorts
 * @property {() => string | null} pluginRoot
 * @typedef {import("./kit-context.js").KitContext & FindStartPorts} FindStartContext
 */

/**
 * @param {string} command
 * @param {FindStartContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	/** @type {string | null} */
	let refused = null;
	walkCommands(
		parsed,
		(cmd) => {
			if (refused === null && startsAtRoot(cmd, parsed.spans))
				refused = cmd.segment;
		},
		ctx,
	);
	if (refused === null) return null;
	const root = ctx.pluginRoot();
	if (root === null || !root.startsWith("/")) {
		ctx.log("the plugin root did not resolve — a find at / was allowed");
		return null;
	}
	const shown = trimEndRun(/** @type {string} */ (refused), BASH_SPACE);
	return {
		deny: spliceCmd(
			shown,
			REFUSAL.replace("@ROOT@", () => root),
		),
	};
}

/**
 * @param {import("./shell-parse.js").Command} cmd
 * @param {string[]} spans
 */
function startsAtRoot(cmd, spans) {
	return cmd.runs().some(({ words: [head, ...rest], dirs }) => {
		if (head === undefined || head.slice(head.lastIndexOf("/") + 1) !== "find")
			return false;
		const cwds = dirs();
		const starts = findStarts(rest, spans);
		return (starts.length > 0 ? starts : ["."]).some((start) =>
			cwds.some((cwd) => isRoot(start, cwd, spans)),
		);
	});
}

/**
 * @param {string} word
 * @param {string} cwd
 * @param {string[]} spans
 */
function isRoot(word, cwd, spans) {
	const { text, known } = literal(word, spans);
	if (!known) return false;
	if (text.startsWith("/")) return normAbs(text) === "/";
	if (!cwd.startsWith("/")) return false;
	return normAbs(`${cwd}/${text}`) === "/";
}

module.exports = { field: "command", noun: "command", decide };
