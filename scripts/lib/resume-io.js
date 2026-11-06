/*
 * resume-io.js — the production adapter of lib/refill-resume.js's ResumeIo
 * port, which lib/refill-tick.js wires (#4386). Its own module so its
 * contract test, resume-io.contract.test.ts, builds it without loading the
 * tick, and holds lib/resume-io-fake.ts to it (§G7).
 */

const fs = require("node:fs");
const path = require("node:path");
const { claudeBin } = require("./claude-bin.js");
const { runTickChild: runChild } = require("./child-spawn.js");
const { stopOn } = require("./claude-stop.js");
const { readOverflowLookup, record } = require("./dispatch-ledger.js");
const { jobDirPath, readJobRecord } = require("./job-paths.js");
const { findRunSince, runOf } = require("./headless-runs.js");
const { launch: launchHeadless } = require("./headless-sessions.js");
const { launchAuthRefusal } = require("./launch-auth.js");
const { movePassMarkers } = require("./move-pass-markers.js");
const { moveParkedBy } = require("./parked.js");
const { buildCheckoutEnv } = require("./refill-repos.js");
const { findResumed } = require("./resumed-copy.js");
const { runClaude } = require("./seat-claude.js");
const { copyTranscript } = require("./seat-move.js");
const { readSessionName } = require("./session-name.js");
const { fileSpend, sessionSpendUsd } = require("./session-spend.js");

const SCRIPTS = path.dirname(__dirname);

/**
 * @param {(line: string) => void} log
 * @returns {import("./refill-resume.js").ResumeIo}
 */
const buildResumeIo = (log) => ({
	log,
	env: () => process.env,
	authRefusal: (launch) => launchAuthRefusal({ bin: claudeBin(), ...launch }),
	launchHeadless,
	findHeadlessRun: findRunSince,
	readHeadlessRun: runOf,
	runClaude,
	readJobRecord,
	findResumed,
	copyTranscript,
	hasJobRecord: (seat, jobId) => fs.existsSync(jobDirPath(seat, jobId)),
	stop: stopOn,
	overflowLookup: (root) => readOverflowLookup([root]),
	recordLaunch: record,
	copySpendUsd: (file) => fileSpend(file).usd,
	sessionSpendUsd,
	sessionName: readSessionName,
	runArbiter: (root, cmd, n, sessionId) =>
		runChild(
			process.execPath,
			[path.join(SCRIPTS, "session-arbiter.js"), cmd, String(n)],
			{
				cwd: root,
				env: { ...buildCheckoutEnv(root), CLAUDE_CODE_SESSION_ID: sessionId },
			},
		),
	movePassMarkers,
	moveParkedBy,
});

module.exports = { buildResumeIo };
