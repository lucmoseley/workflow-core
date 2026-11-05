/*
 * resume-io.js — the production adapter of lib/refill-resume.js's ResumeIo
 * port, which lib/refill-tick.js wires. Held to lib/resume-io-fake.ts by
 * resume-io.contract.test.ts (§G7).
 */

const fs = require("node:fs");
const path = require("node:path");
const { claudeBin } = require("./claude-bin.js");
const { CHILD_TIMEOUT_MS, spawnChild } = require("./child-spawn.js");
const { stopOn } = require("./claude-stop.js");
const { readOverflowLookup, record } = require("./dispatch-ledger.js");
const { jobDirPath, readJobRecord } = require("./job-paths.js");
const { launchAuthRefusal } = require("./launch-auth.js");
const { movePassMarkers } = require("./move-pass-markers.js");
const { buildKeySettings } = require("./overflow-key.js");
const { moveParkedBy } = require("./parked.js");
const { buildCheckoutEnv } = require("./refill-repos.js");
const { findResumed } = require("./resumed-copy.js");
const { copyTranscript } = require("./seat-move.js");
const { fileSpend, sessionSpendUsd } = require("./session-spend.js");

const SCRIPTS = path.dirname(__dirname);

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd: string, env: NodeJS.ProcessEnv}} opts
 */
const runChild = (file, args, opts) =>
	spawnChild(file, args, { timeout: CHILD_TIMEOUT_MS, ...opts });

/**
 * The ResumeIo that logs through `log`.
 * @param {(line: string) => void} log
 * @returns {import("./refill-resume.js").ResumeIo}
 */
const buildResumeIo = (log) => ({
	log,
	env: () => process.env,
	keySettings: buildKeySettings,
	authRefusal: (launch) => launchAuthRefusal({ bin: claudeBin(), ...launch }),
	runClaude: (args, opts) => runChild(claudeBin(), args, opts),
	readJobRecord,
	findResumed,
	copyTranscript,
	hasJobRecord: (seat, jobId) => fs.existsSync(jobDirPath(seat, jobId)),
	stop: stopOn,
	overflowLookup: (root) => readOverflowLookup([root]),
	recordLaunch: record,
	copySpendUsd: (file) => fileSpend(file).usd,
	sessionSpendUsd,
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
