#!/usr/bin/env node
/*
 * log-late-signature.js — the outcome review's late-signature backstop
 * (#4796): a ticket that closed fault-shaped with no signature gets one after
 * the fact, checked as file-issue.js checks a filing's, and logged
 * `late: true` so its verdicts are reported apart. The ticket gains the
 * `fault-signature` label and the line in its body section first, as a filing
 * does, so a lost late line is caught by the same rule (#4861).
 *
 *   node scripts/log-late-signature.js --issue <owner/name>#<n>
 *     --filed-at <iso> --fault-signature <file>
 *   node scripts/log-late-signature.js --restore <owner/name>#<n>
 *
 * `--filed-at` is the ticket's own `createdAt`. `--restore` appends the line a
 * ticket's body section records, unchanged: the outcome review's
 * `lostLines` names the tickets owing one. The line lands in the worktree's
 * docs/data/outcome-signatures.jsonl, for the caller to commit.
 * Exits: 0 logged, 1 a tracker read or write failed or the section is gone,
 * 2 a usage error or a signature refused.
 */

const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const { scriptPath } = require("./lib/script-path.js");
const {
	appendSignatureLine,
	buildSignatureLine,
	readDeclared,
	readSignatureSection,
	withSignatureSection,
} = require("./lib/fault-signature.js");
const { SIGNATURE_LABEL } = require("./lib/signature-label.js");
const { gh, ghJson, parseErrLine } = require("./lib/gh.js");
const { hostRoot, worktreeRoot } = require("./lib/host-root.js");
const { parseQualifiedRef } = require("./lib/issue-ref.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("log-late-signature.js")} --issue <owner/name>#<n> --filed-at <iso> --fault-signature <file>
       node ${scriptPath("log-late-signature.js")} --restore <owner/name>#<n>`;

/** @param {string} msg @param {number} [code] @returns {never} */
function refuse(msg, code = 2) {
	writeFd(2, `log-late-signature: ${msg}\n`);
	process.exit(code);
}

/**
 * The ticket's body, or exit 1 naming the failed read.
 * @param {{repo: string, number: number}} ref
 */
function readBody({ repo, number }) {
	try {
		return String(
			ghJson([
				"issue",
				"view",
				String(number),
				"--repo",
				repo,
				"--json",
				"body",
			]).body ?? "",
		);
	} catch (e) {
		return refuse(`${repo}#${number} unread: ${parseErrLine(e)}`, 1);
	}
}

/** @param {string} issue */
function restore(issue) {
	const ref = parseQualifiedRef(issue);
	if (!ref) refuse(`--restore is <owner/name>#<n>. ${USAGE}`);
	const line = readSignatureSection(issue, readBody(ref));
	if (!line)
		refuse(
			`${issue} has no readable "## Fault signature" section, so its line is unrecoverable: re-declare it late with --issue, --filed-at and --fault-signature.`,
			1,
		);
	const logged = appendSignatureLine(worktreeRoot(), line);
	writeFd(1, `Restored ${issue}'s line in ${logged}.\n`);
}

/**
 * @param {string} issue
 * @param {string} filedAt
 * @param {string} file
 */
function logLate(issue, filedAt, file) {
	const ref = parseQualifiedRef(issue);
	if (!ref) refuse(`--issue is <owner/name>#<n>. ${USAGE}`);
	if (Number.isNaN(Date.parse(filedAt)))
		refuse(`--filed-at is the ticket's createdAt, an ISO time. ${USAGE}`);
	const read = readDeclared(file, { root: hostRoot() });
	if ("error" in read) refuse(read.error);
	const line = buildSignatureLine({
		issue,
		filedAt,
		declared: read.declared,
		late: true,
	});
	const body = withSignatureSection(readBody(ref), line);
	try {
		gh(
			[
				"issue",
				"edit",
				String(ref.number),
				"--repo",
				ref.repo,
				"--add-label",
				SIGNATURE_LABEL,
				"--body-file",
				"-",
			],
			{ input: body, stdio: ["pipe", "pipe", "pipe"] },
		);
	} catch (e) {
		refuse(
			`${issue} was not marked (${parseErrLine(e)}), so nothing was logged. Run it again.`,
			1,
		);
	}
	const logged = appendSignatureLine(worktreeRoot(), line);
	writeFd(1, `Logged ${issue} late in ${logged}.\n`);
}

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: {
			"--issue": "value",
			"--filed-at": "value",
			"--fault-signature": "value",
			"--restore": "value",
		},
	});
	const restoring = flagValue(flags, "--restore");
	const issue = flagValue(flags, "--issue");
	const filedAt = flagValue(flags, "--filed-at");
	const file = flagValue(flags, "--fault-signature");
	if (restoring !== undefined) {
		if (issue || filedAt || file)
			refuse(`--restore takes no other flag. ${USAGE}`);
		return restore(restoring);
	}
	if (!issue) refuse(`--issue is <owner/name>#<n>. ${USAGE}`);
	if (!filedAt)
		refuse(`--filed-at is the ticket's createdAt, an ISO time. ${USAGE}`);
	if (!file) refuse(`--fault-signature is required. ${USAGE}`);
	logLate(issue, filedAt, file);
}

main();
