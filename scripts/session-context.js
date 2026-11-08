#!/usr/bin/env node
/*
 * session-context.js — how much standing context is this session carrying?
 *
 * mantahostels#1094 caps a dispatch bundle on ACCUMULATED CONTEXT rather than on member
 * count. https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/allowance-burn-measurement.md (mantahostels#830) found spend is
 * `turns x standing context`, so the cost of continuing a bundle is set by how
 * much context the session is already carrying.
 *
 * NOT IN A PREFIX FAMILY, per §N3. It is neither a gate nor a reporter: it
 * answers one question about the calling session and the caller decides what to
 * do, so `check-*`'s five-outcome alphabet would misdescribe a reading as a
 * finding. It borrows only exit 2 for BROKEN.
 *
 * WHERE THE FIGURE COMES FROM. Every assistant message in the session's own
 * transcript carries `message.usage`; fresh input + cache write + cache read is
 * what the model was sent for that turn. The last such record on the main chain
 * is the live figure — `scripts/lib/transcript.js` does the reading.
 *
 * IT UNDER-READS BY ONE TURN. The record describes the request already made, so
 * whatever has landed since — this command's own output included — is not in
 * it. At a member boundary that is the right direction to be wrong in: the
 * reading is a floor.
 *
 * REPORTS ONLY. Nothing is enforced on the cap — the merge rule lives in
 * `.claude/skills/pick-next/SKILL.md`, and mantahostels#506 kept the scripts out of the
 * merge decision deliberately. Exit 0 on a reading, over the cap or under it.
 * Exit 2 ONLY where no figure can be had, which must never be confused with a
 * low one: a session reading an unreadable transcript as 0 tokens would merge
 * on for ever.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const { configDir } = require("./lib/config-dir.js");
const {
	findTranscript,
	isSubagentTranscript,
	lastStandingContext,
} = require("./lib/transcript.js");
const { errMessage } = require("./lib/check.js");
const { flagValue, parseOrCode } = require("./lib/cli-args");

/*
 * 200,000 tokens, derived at mantahostels#1094.
 *
 * Continuing a member in-bundle costs `T x C` where C is the context already
 * standing; running it in a fresh session costs `(T + O) x 110k` — 110k being
 * the median mean context-per-turn of a single-member session, and O the
 * orientation turns a fresh session re-pays. Break-even is `C = 110k x
 * (1 + O/T)`. At the measured T of 12-30 turns for a `small` member, and
 * O ~ 15, the band runs 165k-250k; 200k sits inside it.
 *
 * ⚠ O IS AN ESTIMATE, NOT A MEASUREMENT, and it alone sets the band's width:
 * at O = 8 the band closes to 139k-183k and 200k sits above it. Re-derive
 * before treating 200k as anything firmer than the right order of magnitude.
 *
 * WHY THE CAP IS NOT UNDERCUT BY THE 206k MEDIAN PEAK of a five-member bundle:
 * this is read at member boundaries, where the median five-member bundle sits
 * at 165k. The 206k is a mid-member peak, which nothing here samples.
 */
const CAP = 200_000;

/** Human text goes to stderr, machine output to stdout (§N6). */
const out = (/** @type {string} */ text) => writeFd(1, `${text}\n`);

/**
 * @param {string} message
 * @returns {never}
 */
function die(message) {
	writeFd(
		2,
		`${message}\n\nThis is NOT a low reading — no figure was read at all.\n`,
	);
	process.exit(2);
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
	const parsed = parseOrCode(argv, {
		usage:
			"usage: node scripts/session-context.js [<session-id>] [--cap <tokens>] [--json]",
		flags: { "--cap": "value", "--json": "boolean" },
		max: 1,
	});
	if (typeof parsed === "number") return parsed;
	const json = parsed.flags["--json"] === true;
	const capFlag = flagValue(parsed.flags, "--cap");
	const cap = capFlag === undefined ? CAP : Number(capFlag);
	const positional = parsed.positionals;
	if (!Number.isFinite(cap) || cap <= 0) die("--cap needs a positive number.");

	const sessionId = positional[0] || process.env.CLAUDE_CODE_SESSION_ID;
	if (!sessionId)
		die(
			"No session to read: CLAUDE_CODE_SESSION_ID is unset and no session id was given.",
		);

	const { file, read } = readStanding(sessionId);
	if (json) {
		out(
			JSON.stringify(
				{
					sessionId,
					tokens: read.tokens,
					cap,
					overCap: read.tokens > cap,
					at: read.at,
					transcript: file,
				},
				null,
				2,
			),
		);
		return 0;
	}
	printReading(read, cap);
	return 0;
}

/**
 * The session's transcript and its last standing context, or a die.
 *
 * @param {string} sessionId
 */
function readStanding(sessionId) {
	const root = configDir();
	const file = findTranscript(root, sessionId);
	if (!file)
		die(`No transcript for session ${sessionId} under ${root}/projects.`);

	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		die(`${file} cannot be read: ${errMessage(e)}`);
	}

	const read = lastStandingContext(
		text,
		isSubagentTranscript(file) ? "subagent" : "main",
	);
	if (!read)
		die(
			`${file} carries no assistant turn with a usage record, so no context size can be read.`,
		);
	return { file, read };
}

/**
 * @param {{tokens: number, at: string|null}} read
 * @param {number} cap
 */
function printReading(read, cap) {
	const overCap = read.tokens > cap;
	const n = (/** @type {number} */ v) => v.toLocaleString("en-GB");
	out(
		`Live standing context: ${n(read.tokens)} tokens (last turn${read.at ? ` at ${read.at}` : ""}; one turn stale, so a floor).`,
	);
	out(
		overCap
			? `OVER the ${n(cap)}-token cap by ${n(read.tokens - cap)}. Stop the bundle at this member boundary: finish the member in flight, release your claims on the unstarted members, and leave the rest open.`
			: `UNDER the ${n(cap)}-token cap by ${n(cap - read.tokens)}. The next bundle member may start.`,
	);
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
