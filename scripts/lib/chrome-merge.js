/*
 * chrome-merge.js — the guard-chrome-merge core (workflow-core#5386, spec workflow-core#5385): a Chrome
 * child's launch is read on stdout alone.
 *
 * Why: `claude-child.js chrome` prints exactly one JSON line on stdout on
 * every end path, and mirrors its `claude-child:` stderr notes inside it under
 * `notes` (workflow-core#5381). A caller that merges stderr in hands its JSON reader extra
 * lines and the parse fails (workflow-core#5349).
 *
 * WHAT IT REFUSES: a command that runs `claude-child.js chrome` — through
 * `node`, by any path, behind any wrapper unwrap strips — whose own segment
 * carries `2>&1`, `&>`, `&>>` or `>&<file>`, or is piped on by `|&`. Another
 * mode of the launcher (`chrome-close`, `usage`) passes.
 *
 * A CORE: it does no I/O. It fails open: a crash here would otherwise refuse
 * every launch, where a merge it misses costs one report, the record and the
 * sweep still closing the tabs.
 *
 * Its lib/guard-cores.json row runs it only on a call
 * `if: Bash(*claude-child*)` admits.
 *
 * LIMITS — lexical, one command string:
 *  - a merge made for the whole shell or a group — `exec 2>&1` before the
 *    launch, `{ …; } 2>&1`, `( … ) 2>&1` — is not the launcher's segment's,
 *    and passes;
 *  - a launch inside a `-c` string reads that string's redirections as
 *    words, so a merge there passes;
 *  - a node flag taking a value outside shell-words.js's NODE_VALUE_FLAGS
 *    hides the script, and the launch passes;
 *  - a launch from a script file, or a variable naming the script, passes.
 */

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
	"Read the launcher's stdout alone: it is exactly one JSON line on every end path, and its `claude-child:` notes are mirrored inside that line under `notes`, so stderr need not be merged (workflow-core#5381). Merged, the notes reach the JSON reader as extra lines and the parse fails. Run it again without the `2>&1`, `&>` or `|&`.";

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
 * Whether any run of the command is the launcher in its `chrome` mode, run
 * through node or as the script itself.
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

/**
 * `2>&1`, or a redirection sending both streams to one file (`&>`, `&>>`,
 * `>&<file>`).
 * @param {Redirect} r
 */
const isStderrMerge = (r) =>
	r.fd === "&" || (r.fd === "2" && r.kind === "copy" && /^1-?$/.test(r.target));

/**
 * Whether the segment, standing as a command of its own in the quote-masked
 * subject, is followed by `|&`.
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
