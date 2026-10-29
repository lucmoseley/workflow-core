#!/usr/bin/env node
/*
 * jev-verdict.js — record whether a Jev advisory flag was right or wrong, so
 * #175's first limb is countable at all (#253).
 *
 * Usage:  npm run jev:verdict -- <hash> right|wrong ["why"]
 *         npm run jev:verdict -- --list
 *
 * WHEN IT CAN BE RUN. The guard stores the outgoing text on a `flagged` log
 * line (#285), and `check-jev-flags.js` quotes it back on `npm run status`
 * with the command below, so such a flag is judgeable by anybody at any later
 * time. A LINE LOGGED BEFORE #285 CARRIES A DIGEST AND NOTHING ELSE, and a
 * flag of that vintage not judged while its turn was still on screen cannot be
 * judged at all — `--list` still shows it, unjudged for ever.
 *
 * IT REFUSES AN UNKNOWN HASH. A typo recorded as a verdict is a verdict lost
 * silently and a flag left counting as unjudged for ever; a refusal costs one
 * retype. The hash may be given as any prefix of six characters or more, so
 * long as exactly one flagged turn matches it.
 *
 * CORRECTING A VERDICT IS RECORDING IT AGAIN. The store is append-only and
 * `lib/jev-trial.js` reads the last line per hash, so the earlier judgement
 * stays on disk as an audit trail rather than being edited away.
 *
 * IT WRITES THE VERDICT STORE AND NOTHING ELSE — never the guard's own log,
 * which stays the guard's to append to.
 *
 * IT JOINS NO `scripts/` FAMILY, AND TAKES NONE OF THEIR CONTRACTS (§N3, §G4).
 * It answers on its own three-code alphabet — 0 recorded or listed, 1 the hash
 * names no flagged turn, 2 the invocation itself was wrong.
 */

const hookBlock = require("./lib/hook-block.js");
const { scriptPath } = require("./lib/script-path.js");
const { parseOrExit } = require("./lib/cli-args.js");
const jevLog = require("./lib/jev-log.js");
const jevTrial = require("./lib/jev-trial.js");

const USAGE =
	`usage: node ${scriptPath("jev-verdict.js")} <hash> right|wrong ["why"]\n` +
	`       node ${scriptPath("jev-verdict.js")} --list`;

/**
 * The shortest prefix that may stand in for a full 12-character digest. Six
 * hex characters is 24 bits, so two of the log's few hundred flagged turns
 * collide with probability under one in a hundred thousand.
 */
const MIN_PREFIX = 6;

/**
 * Every flagged turn on record, live log and rotated half both. A missing file
 * is no turns; an unreadable one throws, so "no flag by that hash" is never
 * said about a log that simply would not open.
 * @param {string} root
 * @returns {{at: string, session: string, messageHash: string,
 *   inTrial: boolean, inLimb1Window: boolean, inLimb2Window: boolean}[]}
 */
function readFlaggedTurns(root) {
	/** @type {Record<string, unknown>[]} */
	const all = [];
	for (const file of [jevLog.previousLogPath(root), jevLog.logPath(root)])
		all.push(...(jevLog.readJsonl(file)?.lines ?? []));
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
 * @returns {number} the process exit code
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
		/* Two boundaries, not one (#288): a session can sit past `OUTAGE_START`
		 * and still be "pre-trial" against `TRIAL_START`, so a single era word
		 * read as "outside the experiment" when it was live evidence for limb 2.
		 * `closed` marks a trial session past limb 1's first-20-sessions window —
		 * counted by neither `trial` nor `pre-trial`. */
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
 * @returns {number} the process exit code
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
	if (prefix.length < MIN_PREFIX) {
		process.stderr.write(
			`hash prefix must be at least ${MIN_PREFIX} characters.\n`,
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
