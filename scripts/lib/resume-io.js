/*
 * resume-io.js — the production adapter of lib/refill-resume.js's ResumeIo
 * port, which lib/refill-tick.js wires (#4386). Its own module so its
 * contract test, resume-io.contract.test.ts, builds it without loading the
 * tick, and holds lib/resume-io-fake.ts to it (§G7).
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught, readLogged } = require("./caught.js");
const { carryJobFiles, readUserTurnsNaming } = require("./carry-job-files.js");
const { transcriptPath } = require("./project-slug.js");
const { claudeBin } = require("./claude-bin.js");
const { runTickChild: runChild } = require("./child-spawn.js");
const { stopOn } = require("./claude-stop.js");
const { readOverflowLookup, record } = require("./dispatch-ledger.js");
const { writeJobName } = require("./job-name.js");
const { jobDirPath, readJobRecord } = require("./job-paths.js");
const { findRunSince, readRunAsJob } = require("./headless-runs.js");
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
	authRefusal: (launch) =>
		launchAuthRefusal({ bin: claudeBin(launch.env), ...launch }),
	launchHeadless,
	findHeadlessRun: findRunSince,
	readRunAsJob,
	runClaude,
	/* A record that will not read is logged and read as none, never fatal to
	 * the tick (#4704). */
	readJobRecord: (seat, jobId) =>
		readLogged(log, `job ${jobId} on ${seat}`, () =>
			readJobRecord(seat, jobId),
		),
	findResumed,
	copyTranscript,
	hasJobRecord: (seat, jobId) => fs.existsSync(jobDirPath(seat, jobId)),
	carryJobFiles: (seat, jobId, cwd) => {
		try {
			const rec = readJobRecord(seat, jobId);
			const turns =
				typeof rec?.sessionId === "string"
					? readUserTurnsNaming(
							transcriptPath(
								seat,
								typeof rec.cwd === "string" ? rec.cwd : cwd,
								rec.sessionId,
							),
							jobId,
						)
					: "";
			const intent = typeof rec?.intent === "string" ? rec.intent : "";
			const { carried } = carryJobFiles({
				text: `${intent}\n${turns}`,
				jobDir: jobDirPath(seat, jobId),
				jobId,
				checkout: cwd,
			});
			return { carried };
		} catch (e) {
			return { why: caught(e).message };
		}
	},
	writeJobName,
	stop: stopOn,
	overflowLookup: (root) => readOverflowLookup([root]),
	recordLaunch: record,
	copySpendUsd: (file) => fileSpend(file).usd,
	sessionSpendUsd,
	sessionName: readSessionName,
	moveIssueClaim: (root, n, from, to) =>
		runChild(
			process.execPath,
			[path.join(SCRIPTS, "session-arbiter.js"), "move-issue", String(n), to],
			{
				cwd: root,
				env: { ...buildCheckoutEnv(root), CLAUDE_CODE_SESSION_ID: from },
			},
		),
	movePassMarkers,
	moveParkedBy,
});

module.exports = { buildResumeIo };
