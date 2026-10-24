#!/usr/bin/env node
/*
 * record-delegated-decision.js — record one delegated decision in one call:
 * post its `**Delegated decision:**` comment on the ticket, then append the
 * same entry to the repo's delegated-decision ledger, which the morning review
 * issue lists from (#2002; spec #1995). Clear calls are recorded too.
 *
 *   node scripts/record-delegated-decision.js <n> --question "<q>"
 *     --taken "<option>" --taken-figure 70%
 *     --runner-up "<option>" --runner-up-figure 30%
 *     --rung-rulings "<fact found>|none" --rung-web "<fact>|none"
 *     --rung-subagent "<fact>|none" --still-caught yes|no
 *     --reverse "<commit sha, or the runner-up's first step>"
 *
 * ORDER: every refusal, then the comment, then the ledger line.
 *
 * RE-RUN FINISHES ONLY WHAT IS MISSING: a comment by this account with the
 * same body is not posted again, and a ledger line already keyed to that
 * comment's URL is not appended again.
 * A second decision with every field identical on the same ticket is therefore
 * read as the re-run, not recorded twice.
 *
 * Joins no §N3 family: its exits are the ones #528 gives all three tracker
 * scripts — 0 done or already done, 1 a write did not land, 2 a usage error or
 * a refusal.
 */

const { errLine, gh } = require("./lib/gh.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { caught } = require("./lib/caught.js");
const { ownComment, scriptIo } = require("./lib/tracker-ops.js");
const decision = require("./lib/delegated-decision.js");
const { LOW_TOP } = require("./lib/close-rivals.js");

const USAGE = `usage: node scripts/record-delegated-decision.js <n> --question "<q>" --taken "<option>" --taken-figure <n>% --runner-up "<option>" --runner-up-figure <n>% --rung-rulings "<fact>|none" --rung-web "<fact>|none" --rung-subagent "<fact>|none" --still-caught yes|no (yes: top two rivals still close, or no option above ${LOW_TOP}%) --reverse "<how>"`;

/** @type {import("./lib/tracker-ops.js").ScriptIo} */
const io = scriptIo("record-delegated-decision");

/**
 * @param {string} repo
 * @param {number} n
 * @param {string} comment
 * @returns {{url: string, at: string}}
 */
function postOnce(repo, n, comment) {
	let found;
	try {
		found = ownComment(repo, n, comment);
	} catch (e) {
		return io.fail(
			`could not read #${n}'s comments to rule out a second post (${errLine(e)}). Nothing written — re-run.`,
			1,
		);
	}
	if (found) {
		io.out(
			`#${n}: this decision's comment is there already — ${found.html_url}\n`,
		);
		return { url: found.html_url, at: found.created_at };
	}
	let printed;
	try {
		printed = gh(
			["issue", "comment", String(n), "--repo", repo, "--body-file", "-"],
			{ input: comment, stdio: ["pipe", "pipe", "pipe"] },
		);
	} catch (e) {
		return io.fail(
			`posting the comment on #${n} failed (${errLine(e)}). Nothing written — re-run.`,
			1,
		);
	}
	const url = /https:\/\/\S+#issuecomment-\d+/.exec(printed)?.[0];
	if (!url)
		return io.fail(
			`HALF DONE: the comment is on #${n}, but gh printed no comment URL, so the ledger line was not written and the morning review will not list this decision. Re-run the same command to write it.`,
			1,
		);
	io.out(`#${n}: comment posted — ${url}\n`);
	return { url, at: new Date().toISOString() };
}

function main() {
	const { flags, positionals } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: decision.FLAGS,
		min: 1,
	});
	const ticket = positionals[0] ?? "";
	if (!/^#?\d+$/.test(ticket))
		io.fail(`'${ticket}' is not an issue number. ${USAGE}`, 2);
	const n = Number(ticket.replace(/^#/, ""));

	const parsed = decision.entryFrom(flags);
	if ("faults" in parsed)
		io.fail(
			`refused, nothing written:\n${parsed.faults.map((f) => `  - ${f}`).join("\n")}\n${USAGE}`,
			2,
		);
	const { entry } = parsed;

	const repo = io.trackerOrFail();
	const file = decision.ledgerPath();
	const { url, at } = postOnce(repo, n, decision.renderComment(entry));

	try {
		if (decision.hasEntry(file, url)) {
			io.out(`#${n}: the ledger holds this decision already — ${file}\n`);
			return;
		}
		decision.appendEntry(file, {
			at,
			repo,
			issue: n,
			comment: url,
			session: process.env.CLAUDE_CODE_SESSION_ID ?? null,
			...entry,
		});
	} catch (e) {
		const { code, message } = caught(e);
		io.fail(
			`HALF DONE: the comment is on #${n} (${url}), but the ledger line was not written to ${file} (${code ?? message}). Re-run the same command once the ledger is writable.`,
			1,
		);
	}
	io.out(`#${n}: ledger line appended — ${file}\n`);
}

main();
