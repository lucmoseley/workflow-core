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
 * `--filed-at` is the ticket's own `createdAt`, so the baseline is read over
 * the weeks before it was filed. The line lands in the worktree's
 * docs/data/outcome-signatures.jsonl, for the caller to commit.
 * Exits: 0 logged, 2 a usage error or a signature refused.
 */

const fs = require("node:fs");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const { caught } = require("./lib/caught.js");
const {
	appendSignatureLine,
	buildSignatureLine,
	checkDeclared,
	matchesCase,
	readCaseRecord,
	readRegistry,
} = require("./lib/fault-signature.js");
const { hostRoot, worktreeRoot } = require("./lib/host-root.js");
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
	if (!issue || !/^[\w.-]+\/[\w.-]+#\d+$/.test(issue))
		refuse(`--issue is <owner/name>#<n>. ${USAGE}`);
	if (!filedAt || Number.isNaN(Date.parse(filedAt)))
		refuse(`--filed-at is the ticket's createdAt, an ISO time. ${USAGE}`);
	if (!file) refuse(`--fault-signature is required. ${USAGE}`);
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		refuse(`could not read ${file} (${caught(e).code ?? caught(e).message}).`);
	}
	const registry = readRegistry(hostRoot());
	const checked = checkDeclared(raw, registry);
	if ("error" in checked) refuse(`${file}: ${checked.error}`);
	const { declared } = checked;
	if (declared.signature !== null) {
		const at = readCaseRecord(declared.case);
		if ("error" in at) refuse(`${file}: its case cannot be read — ${at.error}`);
		if (!matchesCase(declared.signature, at, registry))
			refuse(
				`${file}: the signature does not match its case, ${at.file} line ${declared.case.line}, so it would count nothing. Fix the signature.`,
			);
	}
	const logged = appendSignatureLine(
		worktreeRoot(),
		buildSignatureLine({ issue, filedAt, declared, late: true }),
	);
	writeFd(1, `Logged ${issue} late in ${logged}.\n`);
}

main();
