/*
 * gh-issue-ref.js — which issue a bare word of a `gh issue` call names, read
 * off the command (#2796); the value-flag map every gh-issue core reads; and
 * the repo and session helpers the gh recorders share (#2920).
 *
 * A CORE: it reads nothing but its arguments.
 */

const { isGhCommand, literal } = require("./shell-words.js");

/* The flags each `gh issue` subcommand takes a value for, short and long
 * together, as gh 2.95.0's `gh issue <sub> --help` lists them. Leave one out
 * and its value is read as an issue number or a bare word (mantahostels#477).
 * `create --recover` loads a saved title, body and labels no core can see. */
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
 * One bare word, which gh takes as an issue number or an issue URL: its
 * number and, for a URL, the URL's own repo ("" for a bare number). Null for
 * a word that is neither — a leftover expansion, a stray path, a pull-request
 * URL.
 * @param {string} word masked, as lib/shell-parse.js hands it over
 * @param {string[]} spans
 * @returns {{ number: string, repo: string } | null}
 */
function issueWord(word, spans) {
	const { text: raw, known } = literal(word, spans);
	if (!known) return null;
	/* A command substitution's capture, which gi_issue_word reads through. */
	let text = raw.replace(/\n+$/, "").replace(/^#/, "");
	let repo = "";
	if (text.includes("/issues/")) {
		const m = /([^/]+)\/([^/]+)\/issues\/([0-9]+)/.exec(text);
		if (!m) return null;
		repo = `${m[1]}/${m[2]}`;
		text = m[3] ?? "";
	}
	return /^[0-9]{1,9}$/.test(text) ? { number: text, repo } : null;
}

/**
 * The `owner/name` a remote URL or `--repo` value names; "" where
 * it names none.
 * @param {string} text
 */
function repoOf(text) {
	const m = /([^/:]+)\/([^/]+)$/.exec(text.replace(/\.git$/, ""));
	return m ? `${m[1]}/${m[2]}` : "";
}

/**
 * The session a record is filed under: the payload's, else the environment's.
 * @param {{ payload: Record<string, unknown>, envSession: string }} ctx
 */
function sessionOf(ctx) {
	const own = ctx.payload.session_id;
	return typeof own === "string" && own ? own : ctx.envSession;
}

/** @param {string[]} words */
const isGh = (words) => isGhCommand(words[0] ?? "");

module.exports = { ISSUE_VALUE_FLAGS, issueWord, isGh, repoOf, sessionOf };
