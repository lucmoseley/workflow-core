#!/usr/bin/env node

const { parkTargets } = require("./guard-inventory");
const { readOverflowLookup } = require("./lib/dispatch-ledger");
const { readJobCwd, readJobRef } = require("./lib/job-paths");
const { readParkedBy, setParked, writeParkedBy } = require("./lib/parked");
const stopGuard = require("./lib/stop-guard");
const { trackerOf } = require("./lib/outstanding-line");

/**
 * @param {string} sessionId
 * @returns {import("./lib/parked").ParkJob|null}
 */
function readOwnJob(sessionId) {
	const job = readJobRef(process.env);
	if (!job) return null;
	let launch;
	try {
		launch = readOverflowLookup()({ jobId: job.jobId, sessionId });
	} catch {
		/* #4147 */
		return null;
	}
	return {
		...job,
		...(launch ? { keyVar: launch.keyVar } : {}),
		cwd: readJobCwd(job.seat, job.jobId),
	};
}

/** @param {{sessionId: string, message: string}} ctx */
function review({ sessionId, message }) {
	const targets = parkTargets(message, sessionId);
	const tracker = trackerOf();
	if (targets.length === 0 || !tracker) return;
	const parked = targets.filter((n) => setParked(tracker, n, true) === null);
	if (parked.length > 0)
		writeParkedBy(sessionId, [...readParkedBy(sessionId), ...parked], {
			job: readOwnJob(sessionId),
		});
}

if (require.main === module) stopGuard.onMessage({ review });
