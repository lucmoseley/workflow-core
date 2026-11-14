/*
 * commit-subject.js — refuse a commit whose subject runs over 72 characters
 * (#2332, ruled at #2172), for .husky/commit-msg's dispatcher to run
 * in-process (#5207).
 *
 * THE SUBJECT is the first non-blank line git will record, with trailing
 * whitespace dropped. Which `#` lines git keeps, and the scissors cut, are
 * lib/commit-message.js's (#3075): `-m` and `-F` keep a `#2332 …` line as the
 * subject, and the editor drops it.
 *
 * LENGTH IS COUNTED IN CHARACTERS: UTF-8 bytes less continuation bytes.
 *
 * FAILS CLOSED on an unreadable message file: a commit nothing has measured
 * would land a subject of any length.
 *
 * EXEMPT: git-generated subjects, which wrap a subject nobody typed —
 * `Revert "…"`, `Reapply "…"`, git's `Merge branch|branches|tag|commit|
 * remote-tracking branch|pull request …` forms, `fixup! …`, `squash! …` and
 * `amend! …` (docs/practice/ci-and-repo-quality-gates.md), and the queue
 * lander's `Merge queue/<branch> … into the batch`, whose branch name has no
 * length bound (#4547). `Revert`/`Reapply` must end on git's closing `"`
 * (#3357). Residual: a typed `Revert "a" b "c"` still ends on one, and nothing
 * tells it from git's nested `Revert "Revert "x""`.
 */

const { recordedLines } = require("./commit-message.js");
const { readText } = require("./file-read.js");
const { readRuleTextOr } = require("./rule-text.js");

/* Why 72: docs/practice/ci-and-repo-quality-gates.md. */
const LIMIT = 72;

const MERGE_FORMS = [
	"Merge branch ",
	"Merge branches ",
	"Merge tag ",
	"Merge commit ",
	"Merge remote-tracking branch ",
	"Merge pull request ",
];

/** @param {string} subject */
function generated(subject) {
	for (const word of ["Revert", "Reapply"]) {
		const open = `${word} "`;
		if (
			subject.startsWith(open) &&
			subject.endsWith('"') &&
			subject.length > open.length
		)
			return true;
	}
	if (MERGE_FORMS.some((form) => subject.startsWith(form))) return true;
	if (
		subject.startsWith("Merge queue/") &&
		subject.endsWith(" into the batch") &&
		subject.length >= "Merge queue/ into the batch".length
	)
		return true;
	return ["fixup! ", "squash! ", "amend! "].some((p) => subject.startsWith(p));
}

/* POSIX [[:space:]]: the trailing run the subject drops. */
const SPACE = " \t\n\v\f\r";

/**
 * @param {string} line
 */
function trimSpace(line) {
	let end = line.length;
	while (end > 0 && SPACE.includes(line.charAt(end - 1))) end--;
	return line.slice(0, end);
}

/** @param {string} subject */
const charCount = (subject) =>
	[...Buffer.from(subject, "utf8")].filter((b) => b < 0x80 || b > 0xbf).length;

/**
 * @param {string} context
 * @param {string} why
 */
const unmeasured = (context, why) => ({
	code: /** @type {1} */ (1),
	stderr: `${context}: ${why}\n  Refusing rather than passing a subject nothing has measured (#2332).\n`,
});

/**
 * The subject check over `<message-file> [<context>]`.
 * @param {string[]} argv
 * @returns {{ code: 0 | 1, stderr: string }}
 */
function checkSubject(argv) {
	const [file = "", context = "commit"] = argv;
	const read = readText(file);
	if (read.state !== "read")
		return unmeasured(
			context,
			`cannot read the commit message file ('${file}').`,
		);
	const lines = recordedLines(read.data);
	const subject = trimSpace(lines.find((l) => trimSpace(l) !== "") ?? "");
	if (generated(subject)) return { code: 0, stderr: "" };
	const length = charCount(subject);
	if (length <= LIMIT) return { code: 0, stderr: "" };
	const rule = readRuleTextOr(
		"commit-message",
		"A commit subject is at most 72 characters",
		"commit-subject",
	);
	return {
		code: 1,
		stderr: `${context}: this commit's subject is ${length} characters, over the ${LIMIT}-character limit.\n\nSubject: ${subject}\n\n${rule}\n\nShorten the subject, move the why into the body, and commit again.\n`,
	};
}

module.exports = { checkSubject };
