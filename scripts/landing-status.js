#!/usr/bin/env node
/*
 * landing-status.js — where this session's commits stand on the landing route:
 * each commit its commit ledger names is landed (on `main`), queued (on the
 * session's queue ref, not yet on `main`), or unpushed. Fetches `main` and
 * the queue refs first. Then, where the session runs in a worktree, each stay
 * of its queue ref, queued, testing, landed or dropped
 * (lib/queue-ref-status.js). Its last line is the landing queue's
 * (lib/queue-gauge.js).
 *
 *   node scripts/landing-status.js [--session <id>] [--wait]
 *
 * `--wait` re-reads until every sha the session had queued has landed or been
 * dropped, or a bound under the 15-minute Bash wait, then prints the last
 * reading and a `wait:` line naming which (lib/landing-wait.js).
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
const { isNetworkFault } = require("./lib/network-fault.js");
const { sleepSync } = require("./lib/sleep-sync.js");
const {
	WAIT_BOUND_MS,
	WAIT_POLL_MS,
	buildWaitLine,
	shaState,
	waitForLanding,
} = require("./lib/landing-wait.js");

/**
 * @typedef {import("./lib/landing-wait.js").Reading} Reading
 * @typedef {import("./lib/landing-wait.js").ShaState} ShaState
 */

const USAGE = `usage: node ${scriptPath("landing-status.js")} [--session <id>] [--wait]
  the session defaults to CLAUDE_CODE_SESSION_ID
  --wait  re-read every ${WAIT_POLL_MS / 1000} s until nothing of the session's is queued, or
          ${WAIT_BOUND_MS / 60_000} min; run it with run_in_background to be told when it lands`;

/** @type {import("./lib/cli-args.js").CliSpec} */
const CLI = {
	usage: USAGE,
	flags: { "--session": "value", "--wait": "boolean" },
};

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
	const read = () => readLanding(root, sessionId);
	if (parsed.flags["--wait"] === undefined) {
		const r = read();
		if ("fault" in r) return r.fault;
		for (const line of r.lines) say(line);
		return 0;
	}
	/* The real clock, not check.js's now(): a pinned WFC_NOW would stop the
	 * bound from ever arriving. */
	const t0 = Date.now();
	const o = waitForLanding(read, {
		sleep: sleepSync,
		elapsed: () => Date.now() - t0,
	});
	if (o.kind === "fault") return o.code;
	for (const line of o.reading.lines) say(line);
	say(buildWaitLine(o));
	return 0;
}

/**
 * One reading of the session's landing route, or the exit code of a read
 * that failed, named on stderr.
 * @param {string} root
 * @param {string} sessionId
 * @returns {Reading|import("./lib/landing-wait.js").Fault}
 */
function readLanding(root, sessionId) {
	const ledgerRoot = arbiterLedger.ledgerRoot();
	const commits = ledgerRoot
		? arbiterLedger.readCommitsBy(sessionId, ledgerRoot)
		: null;
	if (!commits) {
		fail(
			`the commit ledger of session ${sessionId} would not read; no state claimed`,
		);
		return { fault: 1, network: false };
	}
	/** @type {string[]} */
	const lines = [];
	/** @type {Map<string, import("./lib/landing-status.js").CommitState["kind"]>} */
	const commitKinds = new Map();
	/** @type {Map<string, import("./lib/queue-ref-status.js").RefState["state"]>} */
	const refKinds = new Map();
	if (commits.length === 0)
		lines.push(`Session ${sessionId} made no commit here.`);
	else
		try {
			const tree = readTopLevel(process.cwd()) ?? root;
			const queue = queueRefOf(root, tree);
			const git = fetchedGit(root, tree);
			for (const entry of commitStates(commits, git)) {
				lines.push(buildStateLine(entry, git.subjectOf(entry.sha), queue));
				commitKinds.set(entry.sha, entry.state.kind);
			}
		} catch (err) {
			const e = caught(err);
			fail(
				`could not read origin's main and queue refs: ${String(e.stderr || e.message).trim()}\nNo state claimed. Check \`git fetch origin\` works.`,
			);
			return { fault: 1, network: isNetworkFault(err) };
		}
	try {
		const refs = queueGit(root).refs();
		const rows = readQueueRows(queueLogFile(root));
		const tree = readTopLevel(process.cwd());
		for (const s of readQueueRefStates(root, tree, refs, rows)) {
			lines.push(buildQueueRefLine(s));
			refKinds.set(s.sha, s.state);
		}
		lines.push(buildQueueLine(queueGaugeOf(refs.queue, rows, now())));
	} catch (err) {
		/* Fail-open (#4485). */
		fail(`could not read the landing queue: ${parseErrorText(err)}`);
	}
	/** @type {Map<string, ShaState>} */
	const states = new Map();
	for (const sha of new Set([...commitKinds.keys(), ...refKinds.keys()])) {
		const s = shaState(commitKinds.get(sha), refKinds.get(sha));
		if (s) states.set(sha, s);
	}
	return { lines, states };
}

if (require.main === module) process.exit(main());

module.exports = { main };
