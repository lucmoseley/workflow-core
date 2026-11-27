#!/usr/bin/env node
const hookBlock = require("./lib/hook-block.js");
const { scriptPath } = require("./lib/script-path.js");
const { parseOrExit } = require("./lib/cli-args.js");
const jevLog = require("./lib/jev-log.js");
const { readJsonl } = require("./lib/jsonl.js");
const jevTrial = require("./lib/jev-trial.js");

const USAGE =
	`usage: node ${scriptPath("jev-verdict.js")} <hash> right|wrong ["why"]\n` +
	`       node ${scriptPath("jev-verdict.js")} --list`;

// guess, origin untraced, workflow-core#5621
const MIN_HASH_PREFIX_CHARS = 6;

/**
 * @param {string} root
 * @returns {{at: string, session: string, messageHash: string,
 *   inTrial: boolean, inLimb1Window: boolean, inLimb2Window: boolean}[]}
 */
function readFlaggedTurns(root) {
	/** @type {Record<string, unknown>[]} */
	const all = [];
	for (const file of [jevLog.previousLogPath(root), jevLog.logPath(root)])
		all.push(...(readJsonl(file)?.rows ?? []));
	const trial = new Set(jevTrial.sessionsInTrial(all));
	const limb1Window = new Set(jevTrial.limb1WindowSessions(all));
	const limb2Window = new Set(jevTrial.limb2WindowSessions(all));
	const out = [];
	for (const line of all) {
		if (line.outcome !== "flagged") continue;
		if (typeof line.messageHash !== "string") continue;
		const session = String(line.session ?? "unknown");
		out.push({
			at: String(line.at),
			session,
			messageHash: line.messageHash,
			inTrial: trial.has(session),
			inLimb1Window: limb1Window.has(session),
			inLimb2Window: limb2Window.has(session),
		});
	}
	return out;
}

/**
 * @param {string} root
 * @returns {number}
 */
function list(root) {
	const verdicts = jevTrial.readVerdicts(root);
	const turns = readFlaggedTurns(root);
	if (turns.length === 0) {
		process.stdout.write("no flagged turn on record.\n");
		return 0;
	}
	for (const turn of turns) {
		const verdict = verdicts.get(turn.messageHash)?.verdict ?? "unjudged";
		// workflow-core#288
		let limb1 = "pre-trial";
		if (turn.inLimb1Window) limb1 = "trial";
		else if (turn.inTrial) limb1 = "closed";
		let limb2 = "pre-trial";
		if (jevTrial.inOutageVoid(jevLog.whenOf(turn))) limb2 = "void";
		else if (turn.inLimb2Window) limb2 = "trial";
		process.stdout.write(
			`${turn.messageHash}  ${turn.at}  session ${turn.session.slice(0, 8)}  ${verdict}  (limb1 ${limb1}, limb2 ${limb2})\n`,
		);
	}
	return 0;
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
	const root = hookBlock.repoRoot();
	const { flags, positionals } = parseOrExit(argv, {
		usage: USAGE,
		flags: { "--list": "boolean" },
		max: 3,
	});
	if (flags["--list"]) return list(root);

	const [prefix, verdict, note] = positionals;
	if (!prefix || !verdict) {
		process.stderr.write(`${USAGE}\n`);
		return 2;
	}
	if (!jevTrial.VERDICTS.includes(verdict)) {
		process.stderr.write(
			`verdict must be one of ${jevTrial.VERDICTS.join(", ")}, not "${verdict}".\n`,
		);
		return 2;
	}
	if (prefix.length < MIN_HASH_PREFIX_CHARS) {
		process.stderr.write(
			`hash prefix must be at least ${MIN_HASH_PREFIX_CHARS} characters.\n`,
		);
		return 2;
	}

	const matches = readFlaggedTurns(root).filter((t) =>
		t.messageHash.startsWith(prefix),
	);
	const hashes = new Set(matches.map((t) => t.messageHash));
	const [messageHash, ...others] = hashes;
	if (messageHash === undefined) {
		process.stderr.write(
			`no flagged turn with hash "${prefix}" — node ${scriptPath("jev-verdict.js")} --list for the ones on record.\n`,
		);
		return 1;
	}
	if (others.length > 0) {
		process.stderr.write(
			`"${prefix}" matches ${hashes.size} flagged turns: ${[...hashes].join(", ")}.\n`,
		);
		return 1;
	}

	const was = jevTrial.readVerdicts(root).get(messageHash)?.verdict;
	jevTrial.recordVerdict({ root, messageHash, verdict, note });
	process.stdout.write(
		was
			? `${messageHash}: ${was} → ${verdict}.\n`
			: `${messageHash}: ${verdict}.\n`,
	);
	return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
