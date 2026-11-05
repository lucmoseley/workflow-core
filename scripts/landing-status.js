#!/usr/bin/env node
/*
 * landing-status.js — where this session's commits stand on the landing route
 * (#2407, spec #2261; #4458): each commit its commit ledger names is landed
 * (on `main`), queued (on the session's queue ref, not yet on `main`),
 * reverted by a revert the old lander made on `landing`, or unpushed. Fetches
 * `main`, `landing` and the queue refs first. Then, where the
 * session runs in a worktree, each stay of its queue ref, queued, testing,
 * landed or dropped (lib/queue-ref-status.js). Its last line is the landing queue's
 * (lib/queue-gauge.js).
 *
 *   node scripts/landing-status.js [--session <id>]
 *
 * Joins no §N3 family: it gates nothing and is no hook.
 *
 * Exit codes: 0 on a report, or where the `landing` module is off; 1 where the
 * remote or the commit ledger cannot be read; 2 on a command line it refuses
 * or no session id. Queue lines it cannot read are named on stderr, and
 * change no exit code.
 */

const { caught, parseErrorText } = require("./lib/caught.js");
const { now } = require("./lib/check.js");
const arbiterLedger = require("./lib/arbiter-ledger.js");
const { flagValue, parseOrCode } = require("./lib/cli-args.js");
const { readTopLevel } = require("./lib/git-tree.js");
const {
	commitStates,
	fetchedGit,
	buildStateLine,
} = require("./lib/landing-status.js");
const { queueRefOf } = require("./lib/landing-refs.js");
const { buildQueueLine, queueGaugeOf } = require("./lib/queue-gauge.js");
const { queueGit } = require("./lib/queue-lander-adapters.js");
const { queueLogFile, readQueueRows } = require("./lib/queue-log.js");
const {
	buildQueueRefLine,
	readQueueRefStates,
} = require("./lib/queue-ref-status.js");
const { scriptPath } = require("./lib/script-path.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const { moduleOn } = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("landing-status.js")} [--session <id>]
  the session defaults to CLAUDE_CODE_SESSION_ID`;

/** @type {import("./lib/cli-args.js").CliSpec} */
const CLI = { usage: USAGE, flags: { "--session": "value" } };

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);

/** @param {string} line */
const fail = (line) => writeFd(2, `landing-status: ${line}\n`);

/** @param {string[]} [argv] @returns {number} */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	const root = repoRoot();
	if (root === null) {
		fail("not in a git checkout");
		return 1;
	}
	if (!moduleOn("landing", { root })) {
		say(
			"The landing module is off: this repo lands straight on main, so a pushed commit is on main.",
		);
		return 0;
	}
	const sessionId =
		flagValue(parsed.flags, "--session") || process.env.CLAUDE_CODE_SESSION_ID;
	if (!sessionId) {
		fail(
			`no session id: pass --session <id> or run inside a session\n${USAGE}`,
		);
		return 2;
	}
	const ledgerRoot = arbiterLedger.ledgerRoot();
	const commits = ledgerRoot
		? arbiterLedger.readCommitsBy(sessionId, ledgerRoot)
		: null;
	if (!commits) {
		fail(
			`the commit ledger of session ${sessionId} would not read; no state claimed`,
		);
		return 1;
	}
	if (commits.length === 0) {
		say(`Session ${sessionId} made no commit here.`);
		sayQueueLines(root);
		return 0;
	}
	/** @type {string[]} */
	let lines;
	try {
		const tree = readTopLevel(process.cwd()) ?? root;
		const queue = queueRefOf(root, tree);
		const git = fetchedGit(root, tree);
		lines = commitStates(commits, git).map((entry) =>
			buildStateLine(entry, git.subjectOf(entry.sha), queue),
		);
	} catch (err) {
		const e = caught(err);
		fail(
			`could not read origin's main and queue refs: ${String(e.stderr || e.message).trim()}\nNo state claimed. Check \`git fetch origin\` works.`,
		);
		return 1;
	}
	for (const line of lines) say(line);
	sayQueueLines(root);
	return 0;
}

/**
 * The session's queue ref's stays, then the queue's line, off one read of
 * the remote and the queue log.
 * @param {string} root
 */
function sayQueueLines(root) {
	try {
		const refs = queueGit(root).refs();
		const rows = readQueueRows(queueLogFile(root));
		const tree = readTopLevel(process.cwd());
		for (const s of readQueueRefStates(root, tree, refs, rows))
			say(buildQueueRefLine(s));
		say(buildQueueLine(queueGaugeOf(refs.queue, rows, now())));
	} catch (err) {
		/* Fail-open (#4485). */
		fail(`could not read the landing queue: ${parseErrorText(err)}`);
	}
}

if (require.main === module) process.exit(main());

module.exports = { main };
