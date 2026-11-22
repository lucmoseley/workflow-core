#!/usr/bin/env node

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const { configDir } = require("./lib/config-dir.js");
const {
	findTranscript,
	isSubagentTranscript,
	lastStandingContext,
} = require("./lib/transcript.js");
const { errMessage } = require("./lib/check.js");
const { flagValue, parseOrCode } = require("./lib/cli-args");

// lucmoseley/mantahostels#1094 measured a break-even band of 165k-250k; its orientation-turn count is a guess
const CAP = 200_000;

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
		usage: `usage: node ${scriptPath("session-context.js")} [<session-id>] [--cap <tokens>] [--json]`,
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

/** @param {string} sessionId */
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
