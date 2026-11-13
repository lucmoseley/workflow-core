#!/usr/bin/env node
/*
 * check-arbiter-commands.js — a printed session-arbiter command goes through
 * buildArbiterCommand in lib/build-arbiter-command.js, which quotes its words
 * (workflow-core#3990) and spells the arbiter where an install can run it (workflow-core#3992).
 *
 * Usage:
 *   node check-arbiter-commands.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]
 *
 * LEXICAL. A site, in the code of any non-test `.js`, `.cjs` or `.mjs` under
 * scripts/ but lib/build-arbiter-command.js, is one of: a scriptPath() or corePath()
 * of the arbiter; `node` on the arbiter, by name or through a variable whose
 * name holds "arbiter", then arguments and an interpolation or a `" +`; a
 * shellQuote() inside the tag, which would quote the word twice; or `node` on
 * the arbiter's literal relative path, whatever follows.
 *
 * THE OPT-OUT, for that last site alone, is an `arbiter-literal-exempt: <why>`
 * comment on its line or the line above, for text a core with no I/O of its own
 * hands to ctx.corePaths, which spells the path in an install.
 *
 * IMPLICIT:  on every commit staging a scripts/ program, refuses any arbiter command spelt by hand in the tree, naming the file, line and buildArbiterCommand.
 * JUSTIFIED: fail-safe — a session's shell splits a bare word with a space in it, and an install holds no scripts/session-arbiter.js, so the recovery line it was handed fails.
 * DEFEAT:    the `arbiter-literal-exempt: <why>` marker; --warn caps findings below the gating line; a program outside scripts/; a shell program; a command assembled across lines, through .concat(), or through a variable whose name lacks "arbiter"; a string added to the tag's result; a wordless command through a variable, at an absolute path, or with no `node` before its path.
 */

const {
	parseLineSites,
	parseMatchSites,
	runHeresyCheck,
} = require("./lib/heresy-scan.js");

const ARBITER = "session-arbiter\\.js";
const NODE = "node +(?:--?[\\w=.-]+ +)*";
const NODE_ARBITER = `${NODE}(?:["']?\\S*${ARBITER}["']?|\\$\\{\\w*[Aa][Rr][Bb][Ii][Tt][Ee][Rr]\\w*\\})`;
const TOKEN = "[\\w<>./#:=-]";
const ARGUMENTS = `(?: +(?:"[^"\\n]*"|${TOKEN}+))*`;
const TAG = "buildArbiterCommand";
const QUOTE = "[\"'`]";
const HAND_SPELT = new RegExp(
	[
		`(?:scriptPath|corePath)\\(\\s*${QUOTE}(?:\\./|scripts/)?${ARBITER}${QUOTE}\\s*\\)`,
		`${NODE_ARBITER}${ARGUMENTS} +["']?${TOKEN}*\\$\\{`,
		`${NODE_ARBITER}${ARGUMENTS} ${QUOTE}\\s*\\+`,
		`${TAG}\`[^\`]*\\$\\{\\s*shellQuote\\(`,
	].join("|"),
	"g",
);
const LITERAL_PATH = new RegExp(
	`${NODE}["']?(?:\\.{1,2}/)*(?:scripts/)?${ARBITER}`,
);
const EXEMPT = /arbiter-literal-exempt:\s*\w/;
const BUILDER = "scripts/lib/build-arbiter-command.js";

const FIX = `print it through ${TAG} from ${BUILDER}, its words bare, as scripts/lib/tracker-ops.js does: \${${TAG}\`release \${path}\`}`;

/**
 * A line carrying a word is reported once, and no marker excuses it.
 * @param {import("./lib/heresy-scan.js").Program} program
 */
function findHandSpelt(program) {
	const withWord = parseMatchSites(program, HAND_SPELT);
	const wordLines = new Set(withWord.map((site) => site.line));
	const literal = parseLineSites(
		program,
		(line, i) => LITERAL_PATH.test(line) && !wordLines.has(i + 1),
		EXEMPT,
	);
	return [...withWord, ...literal];
}

runHeresyCheck({
	name: "arbiter-commands",
	skip: [BUILDER],
	breaches: [
		{
			tag: "HAND-SPELT",
			sites: findHandSpelt,
			message: (rel, site) =>
				`${rel}:${site.line} spells an arbiter command by hand (\`${site.text}\`). Fix: ${FIX}`,
		},
	],
	summary: { phrase: "spell an arbiter command by hand", fix: FIX },
	finish(_ctx, scanned) {
		return {
			okLine: `${scanned} program(s), no arbiter command spelt by hand but a marked literal.`,
			noun: "hand-spelt arbiter command(s)",
		};
	},
});
