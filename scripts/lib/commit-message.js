/*
 * commit-message.js — a commit message file's lines as git will record them:
 * the one scissors cut and comment rule for the readers .husky/commit-msg runs
 * (#2884, #3075).
 *
 * THE COMMENT RULE FOLLOWS git's CLEANUP MODE. `strip` drops every `#` line;
 * `whitespace`, `verbatim` and `scissors` keep them. Unset or `default`, git
 * strips when the editor runs and keeps them when it does not, so `-m "#123 …"`
 * and `-F` record `#123 …` as the subject. A hook sees no editor as
 * GIT_EDITOR=`:` (#3075) and reads `commit.cleanup`
 * from config. Two corners no hook signal separates: a `--cleanup` flag
 * reaches no hook, so it is read as unset; and an exported GIT_EDITOR=`:` on
 * the editor route reads as no editor, keeping `#` lines git drops.
 * `#` is hard-coded, so a repository setting `core.commentChar` elsewhere has
 * its template block kept.
 *
 * THE SCISSORS CUT applies in `strip` and `scissors` modes alone. Git cuts in
 * `strip` only under `--verbose`, which no hook sees, but there the line is
 * git's own, with the diff below it UNPREFIXED, so a commit editing a rule's
 * own text would match its own diff.
 *
 * Run as `node commit-message.js <file>`, it prints those lines, for
 * scripts/check-commit-subject.sh.
 */

const fs = require("node:fs");
const { gitOrNull } = require("./git.js");

const SCISSORS = /^# -+ >8 -+/;

/**
 * The commit's cleanup mode as far as it bears here, `keep` standing for the
 * modes that keep `#` lines and cut nothing.
 * @returns {"strip" | "scissors" | "keep"}
 */
function cleanupMode() {
	const configured =
		gitOrNull(["config", "--get", "commit.cleanup"])?.trim() || "default";
	if (configured === "strip" || configured === "scissors") return configured;
	if (configured !== "default") return "keep";
	return process.env.GIT_EDITOR === ":" ? "keep" : "strip";
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
function recordedLines(raw) {
	const mode = cleanupMode();
	/** @type {string[]} */
	const kept = [];
	for (const line of raw.split("\n")) {
		if (mode !== "keep" && SCISSORS.test(line)) break;
		if (!(mode === "strip" && line.startsWith("#"))) kept.push(line);
	}
	return kept;
}

if (require.main === module) {
	const file = process.argv[2];
	if (file === undefined) {
		process.stderr.write("usage: node commit-message.js <message-file>\n");
		process.exitCode = 2;
	} else {
		process.stdout.write(
			recordedLines(fs.readFileSync(file, "utf8"))
				.map((line) => `${line}\n`)
				.join(""),
		);
	}
}

module.exports = { recordedLines };
