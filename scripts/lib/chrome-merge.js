const { deny, walkVerdict } = require("./guard-verdict.js");
const { parseCommand } = require("./shell-parse.js");
const { literal, nodeScriptArgs } = require("./shell-words.js");

/**
 * @typedef {import("./kit-context.js").KitContext} ChromeMergeContext
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {import("./shell-parse.js").Redirect} Redirect
 */

const LAUNCHER = "claude-child.js";

const REASON =
	"Read the launcher's stdout alone: it is exactly one JSON line on every end path, and its `claude-child:` notes are mirrored inside that line under `notes`, so stderr need not be merged (#5381). Merged, the notes reach the JSON reader as extra lines and the parse fails. Run it again without the `2>&1`, `&>` or `|&`.";

/**
 * @param {string} command
 * @param {ChromeMergeContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	if (!command.includes(LAUNCHER)) return null;
	const parsed = parseCommand(command);
	return (
		walkVerdict(
			parsed,
			(cmd) => {
				if (!isChromeLaunch(cmd, parsed.spans)) return;
				if (
					cmd.redirects().some(isStderrMerge) ||
					isStderrPiped(parsed.masked, cmd.segment)
				)
					deny(
						ctx,
						cmd.segment,
						`This launches a Chrome child with its stderr merged into stdout: @CMD@\n\n${REASON}`,
					);
			},
			ctx,
		) ?? null
	);
}

/**
 * @param {Command} cmd
 * @param {string[]} spans
 */
function isChromeLaunch(cmd, spans) {
	return cmd.runs().some(({ words }) => {
		const [head] = words;
		if (head === undefined) return false;
		const args = isLauncher(head, spans)
			? words.slice(1)
			: nodeScriptArgs(words, spans, LAUNCHER);
		return args?.[0] !== undefined && literal(args[0], spans).text === "chrome";
	});
}

/** @param {string} word @param {string[]} spans */
const isLauncher = (word, spans) => {
	const text = literal(word, spans).text;
	return text.slice(text.lastIndexOf("/") + 1) === LAUNCHER;
};

/** @param {Redirect} r */
const isStderrMerge = (r) =>
	r.fd === "&" || (r.fd === "2" && r.kind === "copy" && /^1-?$/.test(r.target));

/**
 * @param {string} masked
 * @param {string} segment
 */
function isStderrPiped(masked, segment) {
	const own = segment.trim();
	if (!own) return false;
	for (
		let at = masked.indexOf(own);
		at !== -1;
		at = masked.indexOf(own, at + 1)
	) {
		const before = masked.slice(0, at).trimEnd();
		const after = masked.slice(at + own.length).trimStart();
		if (/(^|[;&|(){\n])$/.test(before) && after.startsWith("|&")) return true;
	}
	return false;
}

module.exports = { field: "command", noun: "command", decide };
