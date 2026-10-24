#!/usr/bin/env node
/*
 * adopter-consent.js — CLI over lib/adopter-consent.js, for a live session to
 * record the founder's yes/no once he has answered the priced upgrade
 * question in chat (#238, #245).
 *
 * Usage:
 *   node scripts/adopter-consent.js decline <repo> <tag>
 *   node scripts/adopter-consent.js accept  <repo> <tag>
 *   node scripts/adopter-consent.js status  <repo> <tag>
 *
 * `repo` is the adopter root the session is running in (an absolute path is
 * fine and is what a session already has as its cwd); `tag` is the pin ref
 * named in check-plugin-gap.js's report.
 *
 * `accept` prints the line #238 user story 8 requires: the yes does not
 * materialise anything now.
 */

const { parseOrCode } = require("./lib/cli-args.js");
const { writeFd } = require("./lib/write-fd.js");
const {
	decline,
	setPendingConsent,
	isDeclined,
	readPendingConsent,
} = require("./lib/adopter-consent.js");

const USAGE = "usage: adopter-consent.js <decline|accept|status> <repo> <tag>";
const COMMAND = { usage: USAGE, min: 2 };
const CLI = {
	usage: USAGE,
	commands: { decline: COMMAND, accept: COMMAND, status: COMMAND },
};

/** @param {string[]} argv */
function main(argv) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	const {
		command: cmd,
		positionals: [repo, tag],
	} = parsed;
	if (repo === undefined || tag === undefined)
		throw new Error(
			"parseOrCode's min: 2 let a missing <repo> or <tag> through",
		);

	if (cmd === "decline") {
		const ok = decline(repo, tag);
		writeFd(
			1,
			ok
				? `declined ${repo}@${tag} — the reporter stays silent for this tag.\n`
				: "failed to write the decline record\n",
		);
		return ok ? 0 : 1;
	}

	if (cmd === "accept") {
		const ok = setPendingConsent(repo, tag);
		writeFd(
			1,
			ok
				? `pending ${repo}@${tag} — this session keeps the plugin it started with; the next session will be current.\n`
				: "failed to write the pending consent\n",
		);
		return ok ? 0 : 1;
	}

	writeFd(
		1,
		`${JSON.stringify({
			repo,
			tag,
			declined: isDeclined(repo, tag),
			pending: readPendingConsent(repo, tag),
		})}\n`,
	);
	return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main };
