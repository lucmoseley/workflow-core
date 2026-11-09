#!/usr/bin/env node
/*
 * log-late-signature.js — the outcome review's late-signature backstop
 * (#4796): a ticket that closed fault-shaped with no signature gets one after
 * the fact, checked as file-issue.js checks a filing's, and logged
 * `late: true` so its verdicts are reported apart.
 *
 *   node scripts/log-late-signature.js --issue <owner/name>#<n>
 *     --filed-at <iso> --fault-signature <file>
 *
 * `--filed-at` is the ticket's own `createdAt`. The line lands in the worktree's
 * docs/data/outcome-signatures.jsonl, for the caller to commit.
 * Exits: 0 logged, 2 a usage error or a signature refused.
 */

const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const {
	appendSignatureLine,
	buildSignatureLine,
	readDeclared,
} = require("./lib/fault-signature.js");
const { hostRoot, worktreeRoot } = require("./lib/host-root.js");
const { parseQualifiedRef } = require("./lib/issue-ref.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE =
	"usage: node scripts/log-late-signature.js --issue <owner/name>#<n> --filed-at <iso> --fault-signature <file>";

/** @param {string} msg @returns {never} */
function refuse(msg) {
	writeFd(2, `log-late-signature: ${msg}\n`);
	process.exit(2);
}

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: {
			"--issue": "value",
			"--filed-at": "value",
			"--fault-signature": "value",
		},
	});
	const issue = flagValue(flags, "--issue");
	const filedAt = flagValue(flags, "--filed-at");
	const file = flagValue(flags, "--fault-signature");
	if (!issue || !parseQualifiedRef(issue))
		refuse(`--issue is <owner/name>#<n>. ${USAGE}`);
	if (!filedAt || Number.isNaN(Date.parse(filedAt)))
		refuse(`--filed-at is the ticket's createdAt, an ISO time. ${USAGE}`);
	if (!file) refuse(`--fault-signature is required. ${USAGE}`);
	const read = readDeclared(file, { root: hostRoot() });
	if ("error" in read) refuse(read.error);
	const { declared } = read;
	const logged = appendSignatureLine(
		worktreeRoot(),
		buildSignatureLine({ issue, filedAt, declared, late: true }),
	);
	writeFd(1, `Logged ${issue} late in ${logged}.\n`);
}

main();
