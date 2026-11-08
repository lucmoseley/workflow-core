#!/usr/bin/env node
/*
 * repo-hold.js — raise, attach to, list and lift this checkout's repo holds, for
 * sessions and the founder (#3857, #3858, spec #3597). What a hold is,
 * lib/repo-holds.js says.
 *
 * Joins no §N3 family.
 *
 * A SESSION MAY NOT SET A COMMAND. The loop would run it each tick outside every
 * guard on a session's own Bash calls, the `main`-rewind guard among them. The
 * refusal stops the accident, not a session determined to write a record itself.
 *
 * Exit codes: 0; 1 where the store would not read or write, no open hold has the
 * id, or the hold has no issue yet to attach on; 2 on a command line it refuses.
 */

const { buildErrorText, caught } = require("./lib/caught.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { hostRoot } = require("./lib/host-root.js");
const { parseIssueNumbers } = require("./lib/issue-number.js");
const { parseJobDir } = require("./lib/job-paths.js");
const { appendLoopLog } = require("./lib/refill-files.js");
const holds = require("./lib/repo-holds.js");
const { scriptPath } = require("./lib/script-path.js");
const { fromEnv } = require("./lib/session-id.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("repo-hold.js")} raise | attach | list | lift
  raise --act "<the founder act>" --issue <n> (--clear-issue <n> | --clear-command "<shell>")
        --clear-issue clears the hold once that issue is closed
        --clear-command clears it once the command exits 0, run in this checkout each
        loop tick; refused from a session
  attach <id>                                  park this background job on a hold that
                                               names your act, and post no round
  list                                         this checkout's open holds
  lift <id>                                    end a hold, whatever its clear check reads`;

/**
 * Whether this runs inside a Claude session rather than the founder's terminal.
 * @param {NodeJS.ProcessEnv} env
 */
const isSession = (env) =>
	fromEnv(env) !== null || parseJobDir(env.CLAUDE_JOB_DIR) !== null;

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);

/**
 * @param {string} line
 * @returns {1|2}
 */
const refuse = (line, code = /** @type {1|2} */ (2)) => {
	writeFd(2, `${line}\n`);
	return code;
};

/**
 * The line in the loop's log, beside the tick's own. A log that will not take
 * it leaves the act done, and says so (#3857).
 * @param {string} line
 */
function logLine(line) {
	try {
		appendLoopLog(line);
	} catch (err) {
		writeFd(2, `not in the loop's log: ${caught(err).message}\n`);
	}
}

/**
 * @param {string|true|undefined} text
 */
function parseSoleIssue(text) {
	const words = parseIssueNumbers(String(text ?? ""));
	const [n] = words;
	return words.length === 1 && n && n > 0 ? n : null;
}

/** @param {import("./lib/cli-args").Parsed} parsed */
function raise({ flags }) {
	const act = String(flags["--act"] ?? "").trim();
	if (act === "") return refuse(`--act is required\n\n${USAGE}`);
	const issue = parseSoleIssue(flags["--issue"]);
	if (issue === null)
		return refuse(`--issue takes one issue number\n\n${USAGE}`);
	const command = flags["--clear-command"];
	const closed = flags["--clear-issue"];
	if ((command === undefined) === (closed === undefined))
		return refuse(
			`one of --clear-command and --clear-issue is required\n\n${USAGE}`,
		);
	if (command !== undefined && isSession(process.env))
		return refuse(
			`--clear-command is refused from a session: the loop would run it outside your guards. Use --clear-issue ${issue}, or have the founder raise it from a terminal`,
		);
	if (typeof command === "string" && command.trim() === "")
		return refuse(`--clear-command takes a command\n\n${USAGE}`);
	const issueClosed = parseSoleIssue(closed);
	const clearCheck =
		typeof command === "string" ? { command } : issueClosed && { issueClosed };
	if (!clearCheck)
		return refuse(`--clear-issue takes one issue number\n\n${USAGE}`);
	const hold = holds.raiseHold(holds.readCheckout(hostRoot()), {
		kind: "park",
		act,
		issue,
		clearCheck,
		session: parseJobDir(process.env.CLAUDE_JOB_DIR)?.jobId ?? null,
		now: Date.now(),
	});
	const line = holds.buildRaisedLine(hold);
	logLine(line);
	say(line);
	return 0;
}

/**
 * The ending that parks an attached session: lib/round-holds.js's refusal stops
 * at this command. It leaves out the hold's
 * act, whose own words could read to the stop guards as a question or an option.
 * @param {holds.RepoHold} hold
 */
const buildEndingText = (hold) =>
	[
		"Post no round. Post your hand-off on your own ticket, then end with this, its number for <yours>:",
		"",
		"waits on you:",
		`- #${hold.issue} (hold ${hold.id})`,
		`- #<yours> (parked on hold ${hold.id})`,
		"",
		`needs input: attached to hold ${hold.id} — waits on you: #${hold.issue}, #<yours>`,
	].join("\n");

/** @param {import("./lib/cli-args").Parsed} parsed */
function attach({ positionals: [id] }) {
	if (id === undefined) throw new Error("cli-args' min let no id through");
	const job = parseJobDir(process.env.CLAUDE_JOB_DIR)?.jobId;
	if (!job)
		return refuse(
			"attach parks a background job, and this is none: ask the founder here",
		);
	const root = holds.readCheckout(hostRoot());
	const attached = holds.attachHold(root, id, job);
	if (attached === null)
		return refuse(`no open repo hold ${id} in ${root}; \`list\` names them`, 1);
	if (attached.hold.issue === null)
		return refuse(
			`repo hold ${id} has no issue yet, so a park has none to name: the loop files it on a coming tick. Run this again then`,
			1,
		);
	const line = holds.buildAttachedLine(attached.hold, job);
	if (attached.isNew) logLine(line);
	say(line);
	say(buildEndingText(attached.hold));
	return 0;
}

function list() {
	const root = holds.readCheckout(hostRoot());
	for (const line of holds.buildHoldLines([root], Date.now())) say(line);
	return holds.readHolds(root).unread.length > 0 ? 1 : 0;
}

/** @param {import("./lib/cli-args").Parsed} parsed */
function lift({ positionals: [id] }) {
	if (id === undefined) throw new Error("cli-args' min let no id through");
	const root = holds.readCheckout(hostRoot());
	const line = holds.liftHold(root, id);
	if (line === null)
		return refuse(`no open repo hold ${id} in ${root}; \`list\` names them`, 1);
	logLine(line);
	say(line);
	return 0;
}

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: USAGE,
	commands: {
		raise: {
			usage: USAGE,
			flags: {
				"--act": "value",
				"--issue": "value",
				"--clear-command": "value",
				"--clear-issue": "value",
			},
		},
		attach: { usage: USAGE, min: 1 },
		list: { usage: USAGE },
		lift: { usage: USAGE, min: 1 },
	},
};

const COMMANDS = { raise, attach, list, lift };

function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	/* cli-args.js refuses a command not declared, so one is always named. */
	const command = /** @type {keyof typeof COMMANDS} */ (parsed.command);
	return COMMANDS[command](parsed);
}

if (require.main === module) {
	try {
		process.exitCode = main();
	} catch (err) {
		writeFd(2, `${buildErrorText(err)}\n`);
		process.exitCode = 1;
	}
}
