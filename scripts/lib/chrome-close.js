/*
 * chrome-close.js — claude-child.js's `chrome-close`: the one closer of a
 * Chrome child's tab group once its launcher is gone (workflow-core#5385). Three things
 * run it: the launcher's own SIGTERM trap (`--session <uuid> --trap`), the
 * founder's "done" on a held hand-over (`--session <uuid>`), and the
 * session-start sweep (`--sweep`), the backstop.
 *
 * A close waits up to 5 s for the child to exit, then SIGKILLs it: a kill
 * keeps the group, a clean exit would drop it (workflow-core#5352). It then resumes the
 * child's session on the record's own seat (another seat answers "No
 * conversation found") with only the two tab tools, and reads the outcome off
 * the extension's own tool-result text, never the model's reply.
 *
 * Every form prints one JSON line on stdout.
 */

/* Every record, closed-log and sweep time here is written from now(), so an
 * exported WFC_NOW skews it (clock.js RESIDUAL). */
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

/* Untraced: how long a closer waits for a still-live child to exit. */
const CHILD_WAIT_MS = 5000;
/* workflow-core#5350's census: the close stretch took 2–5 calls and up to 56.2 s. */
const CLOSE_CAP_ASSISTANTS = 5;
const CLOSE_CAP_MS = 60_000;
/* Untraced: how long an interrupted turn has to give its result row. */
const INTERRUPT_WAIT_MS = 10_000;
/* Untraced: how often a wait re-reads /proc, and how long a SIGKILLed child
 * gets to be reaped before the resume starts anyway. */
const POLL_MS = 100;
const KILLED_WAIT_MS = 1000;

/**
 * Whether a resume left the group empty or found none left.
 * @param {string | undefined} outcome
 */
const isSettled = (outcome) => outcome === "closed" || outcome === "gone";

const RESUME_TOOLS = [
	"mcp__claude-in-chrome__tabs_context_mcp",
	"mcp__claude-in-chrome__tabs_close_mcp",
];

/**
 * @typedef {import("./chrome-child-store.js").ChildRecord} ChildRecord
 * @typedef {"closed" | "gone" | "not-connected" | "failed"} CloseOutcome
 * @typedef {{bin: string, env: NodeJS.ProcessEnv, cwd: string}} Launch
 * @typedef {(seat: string) => Launch | string} LaunchFor what to run a
 *   resume on `seat` with, or why it may not run
 */

/** The close turn's caps, a test's shorter where it sets them. */
const closeCaps = () => ({
	capMs: Number(process.env.WFC_CHROME_CLOSE_CAP_MS) || CLOSE_CAP_MS,
	capAssistants: CLOSE_CAP_ASSISTANTS,
	graceMs:
		Number(process.env.WFC_CHROME_INTERRUPT_WAIT_MS) || INTERRUPT_WAIT_MS,
});

/**
 * Wait up to `ms` for the process `pid` started at `start` to end.
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

/**
 * End a child still running: SIGKILL after CHILD_WAIT_MS, its group first.
 * @param {ChildRecord} record
 */
function endChild({ childPid, childStart }) {
	if (waitGone(childPid, childStart, CHILD_WAIT_MS) || !childPid) return;
	for (const target of [-childPid, childPid])
		try {
			process.kill(target, "SIGKILL");
		} catch {
			/* not a group leader, or already gone */
		}
	waitGone(childPid, childStart, KILLED_WAIT_MS);
}

/**
 * Resume `record`'s session and close its group.
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

/**
 * A notify report naming a given-up record's tabs.
 * @param {import("./chrome-child-store.js").GivenUpRecord} gone
 */
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
 * Write what a resume's outcome leaves of `record`: none on a close, the
 * closed-log line written; else the record, an attempt counted where the
 * resume failed, none where the bridge was not connected.
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
 * Close one record's group, the record's lock held throughout.
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
 * `--session <uuid>`: close that record's group now, its hold ignored.
 * Refused (exit 2) while its launcher lives, which a trap closer first waits
 * out.
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

/**
 * `--sweep`: resume, one after another, every record whose launcher is dead,
 * that no closer holds, that is not held or is past its hold, and outside its
 * back-off: an hour after a not-connected resume, 6 h after a failed one.
 * @param {{launchFor: LaunchFor}} opts
 */
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

/** `--held`: every held record, for a session told "done" without the id. */
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
