#!/usr/bin/env node
/*
 * check-arbiter-commands.js — a printed session-arbiter command carrying a word
 * goes through buildArbiterCommand in lib/build-arbiter-command.js, which quotes it (#3990).
 *
 * Usage:
 *   node check-arbiter-commands.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]
 *
 * LEXICAL. A site, in the code of any non-test `.js`, `.cjs` or `.mjs` under
 * scripts/ but lib/build-arbiter-command.js, is one of: a scriptPath() or corePath()
 * of the arbiter; `node` on the arbiter, by name or through a variable whose
 * name holds "arbiter", then arguments and an interpolation or a `" +`; or a
 * shellQuote() inside the tag, which would quote the word twice. Text with no
 * word, such as `node scripts/session-arbiter.js list`, is no site.
 *
 * IMPLICIT:  on every commit staging a scripts/ program, refuses any arbiter command spelt by hand in the tree, naming the file, line and buildArbiterCommand.
 * JUSTIFIED: fail-safe — a session's shell splits a bare word with a space in it, so the recovery line it was handed fails.
 * DEFEAT:    --warn caps findings below the gating line; a program outside scripts/; a command assembled across lines, through .concat(), or through a variable whose name lacks "arbiter"; a string added to the tag's result.
 */

const { parseMatchSites, runHeresyCheck } = require("./lib/heresy-scan.js");

const ARBITER = "session-arbiter\\.js";
const NODE_ARBITER = `node (?:--?[\\w-]+ )*(?:["']?\\S*${ARBITER}["']?|\\$\\{\\w*[Aa][Rr][Bb][Ii][Tt][Ee][Rr]\\w*\\})`;
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
const BUILDER = "scripts/lib/build-arbiter-command.js";

const FIX = `print it through ${TAG} from ${BUILDER}, its words bare, as scripts/lib/tracker-ops.js does: \${${TAG}\`release \${path}\`}`;

runHeresyCheck({
	name: "arbiter-commands",
	skip: [BUILDER],
	breaches: [
		{
			tag: "HAND-SPELT",
			sites: (program) => parseMatchSites(program, HAND_SPELT),
			message: (rel, site) =>
				`${rel}:${site.line} spells an arbiter command by hand (\`${site.text}\`). Fix: ${FIX}`,
		},
	],
	summary: { phrase: "spell an arbiter command by hand", fix: FIX },
	finish(_ctx, scanned) {
		return {
			okLine: `${scanned} program(s), every arbiter command with a word goes through ${TAG}.`,
			noun: "hand-spelt arbiter command(s)",
		};
	},
});
