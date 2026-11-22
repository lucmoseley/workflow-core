const { isGhCommand, literal } = require("./shell-words.js");
const { trimEndRun } = require("./trim-run.js");

// Each `gh issue` subcommand's value-taking flags, as gh 2.95.0 lists them: https://cli.github.com/manual/gh_issue
const ISSUE_VALUE_FLAGS = {
	close: "-c --comment -r --reason --duplicate-of -R --repo",
	comment: "-b --body -F --body-file -R --repo",
	create:
		"-t --title -b --body -F --body-file -a --assignee -m --milestone -p --project " +
		"-T --template -l --label --blocked-by --blocking --parent --recover --type -R --repo",
	edit:
		"-t --title -b --body -F --body-file -m --milestone -R --repo " +
		"--add-assignee --remove-assignee --add-label --remove-label --add-project --remove-project " +
		"--add-blocked-by --remove-blocked-by --add-blocking --remove-blocking " +
		"--add-sub-issue --remove-sub-issue --parent --type",
};

/**
 * @param {string} word
 * @param {string[]} spans
 * @returns {{ number: string, repo: string } | null}
 */
function issueWord(word, spans) {
	const { text: raw, known } = literal(word, spans);
	if (!known) return null;
	let text = trimEndRun(raw, "\n").replace(/^#/, "");
	let repo = "";
	if (text.includes("/issues/")) {
		const m = /(?<![^/])([^/]+)\/([^/]+)\/issues\/([0-9]+)/.exec(text);
		if (!m) return null;
		repo = `${m[1]}/${m[2]}`;
		text = m[3] ?? "";
	}
	return /^[0-9]{1,9}$/.test(text) ? { number: text, repo } : null;
}

/** @param {string} text */
function repoOf(text) {
	const m = /(?<![^/:])([^/:]+)\/([^/]+)$/.exec(text.replace(/\.git$/, ""));
	return m ? `${m[1]}/${m[2]}` : "";
}

/** @param {{ payload: Record<string, unknown>, envSession: string }} ctx */
function sessionOf(ctx) {
	const own = ctx.payload.session_id;
	return typeof own === "string" && own ? own : ctx.envSession;
}

/** @param {string[]} words */
const isGh = (words) => isGhCommand(words[0] ?? "");

module.exports = { ISSUE_VALUE_FLAGS, issueWord, isGh, repoOf, sessionOf };
