/*
 * find-start.js — the guard-root-find core (#2801, #3227): a `find` whose start
 * point is `/`, at any depth, is refused, and the cheaper routes handed over
 * (#1006).
 *
 * DENY, NOT WARN (#1006 Q1): a warn cannot stop the call it fires on.
 *
 * NO ESCAPE VARIABLE: a self-spellable bypass would make the deny a warn (mantahostels#109).
 *
 * FAILS CLOSED on a throw, its manifest row's `failure`. Every input it cannot
 * resolve still fails open, recorded (mantahostels#103 §6, mantahostels#147).
 *
 * LIMITS
 *  - Its row's `Bash(*find *)` clause is unanchored, because the walk strips
 *    launchers (`timeout 120 find /`) that an anchored clause would miss. A
 *    command holding `find` with no space after it never reaches it.
 *  - A start point spelled with an unexpanded variable — `$HOME`, `"$dir"` —
 *    is unread, and passes.
 *  - `/` is recognised after collapsing `.`, `..` and doubled slashes. A symlink to `/` is not followed.
 *  - A RELATIVE start point, or none at all (`find` defaults to `.`), is
 *    resolved against the walk's cwd — the payload's, moved by any `cd` before
 *    it. So `cd / && find . -name x` is refused, and a session standing in `/`
 *    is refused `find . -name x`. Where the cwd is unknown, it passes.
 *  - The command word must be `find`, by basename, after shell-words.js's
 *    launcher unwrapping. `sh -c "find / …"`, a heredoc fed to a shell, `fd`,
 *    `locate`, `du /`, `ls -R /` and `grep -r … /` are all unjudged (#1006
 *    out of scope).
 *  - Only the first refused segment is named in the refusal.
 *  - A plugin root that will not resolve allows the find, recorded
 *    (mantahostels#147): the refusal's first route would name nothing.
 */

const { denyText } = require("./guard-verdict.js");
const {
	BASH_SPACE,
	normAbs,
	parseCommand,
	walkCommands,
} = require("./shell-parse.js");
const { findStarts, literal, unwrap } = require("./shell-words.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * The refusal: the ROOT placeholder takes the plugin's own root, the CMD one
 * the refused segment as typed.
 */
const REFUSAL = `Refused: \`@CMD@\` starts at \`/\`. A find over the whole disk under WSL2 ran to the 2-minute timeout in about half of 114 measured calls, and neither \`-maxdepth\` nor \`-xdev\` saved it (#1006). Cheapest route first:

1. This plugin's own files: @ROOT@ — its scripts/ and docs/agents/ are there.
2. The repo's scratch, .claude/tmp/, and the repo itself.
3. Named roots: \`find /usr /opt /home -xdev -name …\`. Name /mnt/c only when the Windows disk is meant.

\`~\` and $HOME are cheap (median 5 s) and pass.`;

/**
 * @typedef {object} FindStartPorts
 * @property {() => string | null} pluginRoot the plugin's own root, physical
 *   and literal — CLAUDE_PLUGIN_ROOT is not set in the Bash tool's
 *   environment, so a session hunting this plugin's scripts cannot spell it;
 *   null where it will not resolve
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
		({ segment, words, cwd }) => {
			if (refused === null && startsAtRoot(words, cwd, parsed.spans))
				refused = segment;
		},
		ctx,
	);
	if (refused === null) return null;
	const root = ctx.pluginRoot();
	if (root === null || !root.startsWith("/")) {
		ctx.log("the plugin root did not resolve — a find at / was allowed");
		return null;
	}
	/* Trailing whitespace off the segment, as bash's [[:space:]] strip. The
	 * cast undoes the narrowing to null the walk's closure hides from tsc. */
	const shown = trimEndRun(/** @type {string} */ (refused), BASH_SPACE);
	return {
		deny: denyText(
			ctx,
			shown,
			REFUSAL.replace("@ROOT@", () => root),
		),
	};
}

/**
 * @param {string[]} words the command's own words, masked
 * @param {string} cwd the directory it runs in; "" where unknown
 * @param {string[]} spans
 */
function startsAtRoot(words, cwd, spans) {
	const [head, ...rest] = unwrap(words, spans).words;
	if (head === undefined || head.slice(head.lastIndexOf("/") + 1) !== "find")
		return false;
	const starts = findStarts(rest, spans);
	return (starts.length > 0 ? starts : ["."]).some((start) =>
		isRoot(start, cwd, spans),
	);
}

/**
 * Whether a start point names `/`. A word that will not read — an unexpanded
 * variable or substitution — does not, nor a relative one from an unknown cwd.
 * @param {string} word masked
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
