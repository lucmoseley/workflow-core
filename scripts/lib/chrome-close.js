const { ignoreFailure } = require("./caught.js");
const { now } = require("./clock.js");
const { sleepSync } = require("./sleep-sync.js");
const { writeReport } = require("./notify-report.js");
const { reportOwner } = require("./session-id.js");
const {
	GIVE_UP_MS,
	HOLD_MS,
	appendClosed,
	deleteRecord,
	giveUp,
	isSpent,
	listRecords,
	isProcessLive,
	readRecord,
	recordLock,
	sweepSkip,
	writeLastSweep,
	writeRecord,
} = require("./chrome-child-store.js");
const {
	RESUME_PROMPT,
	createCloseReader,
	named,
} = require("./chrome-child.js");
const { STREAM_ARGS, startStreamChild } = require("./chrome-stream.js");

// guess, workflow-core#5529
const CHILD_WAIT_MS = 5000;
// 2–5 calls and 56.2 s measured, workflow-core#5350
const CLOSE_CAP_ASSISTANTS = 5;
const CLOSE_CAP_MS = 60_000;
// guess, workflow-core#5529
const INTERRUPT_WAIT_MS = 10_000;
// guess, workflow-core#5529
const POLL_MS = 100;
const KILLED_WAIT_MS = 1000;

/** @param {string | undefined} outcome */
const isSettled = (outcome) => outcome === "closed" || outcome === "gone";

const RESUME_TOOLS = [
	"mcp__claude-in-chrome__tabs_context_mcp",
	"mcp__claude-in-chrome__tabs_close_mcp",
];

/**
 * @typedef {import("./chrome-child-store.js").ChildRecord} ChildRecord
 * @typedef {"closed" | "gone" | "not-connected" | "failed"} CloseOutcome
 * @typedef {{bin: string, env: NodeJS.ProcessEnv, cwd: string}} Launch
 * @typedef {(seat: string) => Launch | string} LaunchFor
 */

const closeCaps = () => ({
	capMs: Number(process.env.WFC_CHROME_CLOSE_CAP_MS) || CLOSE_CAP_MS,
	capAssistants: CLOSE_CAP_ASSISTANTS,
	graceMs:
		Number(process.env.WFC_CHROME_INTERRUPT_WAIT_MS) || INTERRUPT_WAIT_MS,
});

/**
 * @param {number | null} pid
 * @param {string | null} start
 * @param {number} ms
 */
function waitGone(pid, start, ms) {
	const deadline = Date.now() + ms;
	while (isProcessLive(pid, start)) {
		if (Date.now() > deadline) return false;
		sleepSync(POLL_MS);
	}
	return true;
}

/** @param {ChildRecord} record */
function endChild({ childPid, childStart }) {
	if (waitGone(childPid, childStart, CHILD_WAIT_MS) || !childPid) return;
	for (const target of [-childPid, childPid])
		ignoreFailure(() => process.kill(target, "SIGKILL"));
	waitGone(childPid, childStart, KILLED_WAIT_MS);
}

/**
 * @param {ChildRecord} record
 * @param {LaunchFor} launchFor
 * @returns {Promise<{outcome: CloseOutcome, reason: string}>}
 */
async function resume(record, launchFor) {
	const launch = launchFor(record.seat);
	if (typeof launch === "string") return { outcome: "failed", reason: launch };
	const reader = createCloseReader();
	const run = startStreamChild(
		launch.bin,
		[
			"-p",
			"--resume",
			record.sessionId,
			"--chrome",
			"--tools",
			"",
			"--allowedTools",
			RESUME_TOOLS.join(","),
			...STREAM_ARGS,
		],
		{ env: launch.env, cwd: launch.cwd },
		(row) => reader.read(row),
	);
	run.send(RESUME_PROMPT);
	const end = await run.turn(closeCaps());
	const outcome = reader.outcome();
	if (isSettled(outcome)) await run.finish();
	else await run.stop();
	const said =
		typeof end.result?.result === "string" ? end.result.result : undefined;
	const reason =
		outcome === "failed"
			? (said ??
				(end.capped
					? "the resume hit its close cap"
					: "the resume gave no result row"))
			: outcome;
	return { outcome, reason };
}

/** @param {import("./chrome-child-store.js").GivenUpRecord} gone */
function reportGivenUp(gone) {
	const tabs = gone.heldTab ? [gone.heldTab] : (gone.tabs ?? []);
	const listed =
		tabs.length > 0
			? tabs.map(named).join(", ")
			: "tabs the record does not name";
	writeReport(`chrome-give-up-${gone.sessionId}`, {
		outcome: "WARN",
		text: `A Chrome child's tab group could not be closed and was given up (${gone.reason}): ${listed}, seat ${gone.seat}, session ${gone.sessionId}. Tell the founder to close it in Chrome by hand.`,
		owner: reportOwner(process.env),
	});
}

/**
 * @param {ChildRecord} record
 * @param {{outcome: CloseOutcome, reason: string}} resumed
 * @param {"trap" | "done" | "sweep"} by
 * @param {Date} at
 * @returns {ChildRecord | null}
 */
function settle(record, { outcome, reason }, by, at) {
	const { sessionId, heldSince } = record;
	if (isSettled(outcome)) {
		deleteRecord(sessionId);
		if (outcome === "closed")
			appendClosed({
				sessionId,
				...(heldSince ? { heldSince } : {}),
				closedAt: at.toISOString(),
				by,
			});
		return null;
	}
	const next = {
		...record,
		attempts: record.attempts + (outcome === "failed" ? 1 : 0),
		lastAttemptAt: at.toISOString(),
		lastReason: outcome === "failed" ? reason : outcome,
	};
	writeRecord(next);
	return next;
}

/**
 * @param {ChildRecord} record
 * @param {"trap" | "done" | "sweep"} by
 * @param {LaunchFor} launchFor
 * @returns {Promise<{sessionId: string, outcome: CloseOutcome | "given-up" | "locked", reason?: string}>}
 */
async function closeRecord(record, by, launchFor) {
	const { sessionId } = record;
	const lock = recordLock(sessionId);
	if (!lock.acquire()) return { sessionId, outcome: "locked" };
	try {
		const fresh = readRecord(sessionId);
		if (!fresh) return { sessionId, outcome: "gone" };
		if (isSpent(fresh, now()))
			return giveUpRecord(
				fresh,
				fresh.lastReason
					? `past its limits, last: ${fresh.lastReason}`
					: `past its ${GIVE_UP_MS / 86_400_000} days`,
			);
		endChild(fresh);
		const resumed = await resume(fresh, launchFor);
		const { outcome, reason } = resumed;
		const next = settle(fresh, resumed, by, new Date(now()));
		if (next && isSpent(next, now())) return giveUpRecord(next, reason);
		return { sessionId, outcome, reason };
	} finally {
		lock.release();
	}
}

/**
 * @param {ChildRecord} record
 * @param {string} reason
 */
function giveUpRecord(record, reason) {
	reportGivenUp(giveUp(record, reason, new Date(now())));
	return {
		sessionId: record.sessionId,
		outcome: /** @type {const} */ ("given-up"),
		reason,
	};
}

/**
 * @param {string} sessionId
 * @param {{trap: boolean, launchFor: LaunchFor}} opts
 * @returns {Promise<{line: Record<string, unknown>, exit: number}>}
 */
async function closeSession(sessionId, { trap, launchFor }) {
	const record = readRecord(sessionId);
	if (!record)
		return {
			line: { sessionId, outcome: "no-record" },
			exit: 0,
		};
	const launcherGone = trap
		? waitGone(record.launcherPid, record.launcherStart, CHILD_WAIT_MS)
		: !isProcessLive(record.launcherPid, record.launcherStart);
	if (!launcherGone)
		return {
			line: {
				sessionId,
				outcome: "refused",
				reason: "its launcher still runs; it closes its own tabs",
			},
			exit: 2,
		};
	const done = await closeRecord(record, trap ? "trap" : "done", launchFor);
	return {
		line: done,
		exit: isSettled(done.outcome) ? 0 : 1,
	};
}

/** @param {{launchFor: LaunchFor}} opts */
async function sweep({ launchFor }) {
	writeLastSweep(new Date(now()));
	const closed = [];
	const skipped = [];
	for (const record of listRecords()) {
		const why = sweepSkip(record, now(), {
			launcherLive: isProcessLive(record.launcherPid, record.launcherStart),
			locked: recordLock(record.sessionId).holder() !== null,
		});
		if (why) skipped.push({ sessionId: record.sessionId, why });
		else closed.push(await closeRecord(record, "sweep", launchFor));
	}
	return { line: { swept: closed, skipped }, exit: 0 };
}

function listHeld() {
	const held = listRecords()
		.filter((r) => r.heldSince)
		.map((r) => ({
			sessionId: r.sessionId,
			seat: r.seat,
			heldSince: r.heldSince,
			holdEndsAt: new Date(
				Date.parse(r.heldSince ?? "") + HOLD_MS,
			).toISOString(),
			title: r.heldTab?.title ?? null,
			url: r.heldTab?.url ?? null,
		}));
	return { line: { held }, exit: 0 };
}

module.exports = {
	INTERRUPT_WAIT_MS,
	closeCaps,
	closeSession,
	listHeld,
	sweep,
};
