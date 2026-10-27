#!/usr/bin/env node
/*
 * check-commit-message-closes.js — refuse a commit message that closes an
 * issue.
 *
 * NOT IN THE `check-*` FAMILY, despite the name: those report a survey, and
 * this refuses one commit. It exits 0 or 1, not the family's alphabet.
 *
 * Usage: check-commit-message-closes.js <message-file> <context>
 *   <context> names the seam for the refusal text: `commit-msg` or
 *   `prepare-commit-msg`. The git hooks reach it through
 *   check-commit-message-closes.sh, the path they run with `bash`.
 *
 * cli-args-exempt: a git hook's helper taking two positionals; parseOrExit's
 * exit 2 on an unknown flag would refuse the commit on a usage error.
 *
 * WHY A SECOND DETECTOR (#138). guard-commit-form.js denies the same pattern,
 * but it is a PreToolUse hook on the Bash tool and reads `-m`/`--message`
 * values alone. Four routes reach GitHub past it: `git commit -F <file>`, a
 * message reused with `-c`/`-C`, a message typed into $EDITOR, and any commit
 * made from the founder's own terminal. A git hook sees all four, because it
 * reads the finished message file. The pattern is lib/closing-keyword.js,
 * shared with that guard so the two cannot drift.
 *
 * WHAT IS STRIPPED BEFORE MATCHING, and why each would otherwise fire:
 *   - git's commentary, through lib/commit-message.js: `#` lines and the
 *     `--verbose` diff below the scissors line.
 *   - a `Revert "…"` line: `git revert` of a pre-#129 commit generates `Revert
 *     "Fixes #77 …"` verbatim, and refusing there strands a revert behind a
 *     message nobody wrote (measured at #138).
 *
 * THE RESIDUAL that last strip leaves: GitHub does honour a keyword inside the
 * quoted subject, so reverting a pre-rule commit re-closes its issue silently.
 */

const fs = require("node:fs");
const { closingMatch, closingRefusal } = require("./lib/closing-keyword.js");
const { strippedLines } = require("./lib/commit-message.js");

/**
 * @param {string} raw the message file's text
 */
function messageText(raw) {
	return strippedLines(raw)
		.filter((line) => !line.startsWith('Revert "'))
		.join("\n");
}

/**
 * @param {string[]} argv
 * @returns {{ code: 0 | 1, stderr: string }}
 */
function main(argv) {
	const [file = "", context = "commit"] = argv;
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return {
			code: 1,
			stderr: `${context}: cannot read the commit message file ('${file}').\n  Refusing rather than passing a message nothing has read (#138).\n`,
		};
	}
	const match = closingMatch(messageText(raw));
	if (match === null) return { code: 0, stderr: "" };
	return {
		code: 1,
		stderr: `${context}: this commit message closes an issue server-side the moment it is pushed.\n\n${closingRefusal(match)}\n`,
	};
}

if (require.main === module) {
	const { code, stderr } = main(process.argv.slice(2));
	if (stderr) process.stderr.write(stderr);
	process.exitCode = code;
}

module.exports = { main };
