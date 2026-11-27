const { recordedLines } = require("./commit-message.js");
const { readText } = require("./file-read.js");
const { readRuleTextOr } = require("./rule-text.js");

// guess, workflow-core#2332
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
	stderr: `${context}: ${why}\n  Refusing rather than passing a subject nothing has measured (workflow-core#2332).\n`,
});

/**
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
