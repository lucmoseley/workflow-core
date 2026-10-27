/*
 * refill-wake.js — the refill loop's wake (workflow-core#2313, spec workflow-core#2245 §Waking). A
 * session the loop launched ends; refill-wake.sh, the plugin's Stop hook,
 * appends `<ms> <session id>` to the wake file beside the
 * loop's pidfile; the loop, sleeping between ticks, sees the change and ticks.
 * `stop` and `start` append a line with no id, so a stop is seen within one
 * tick's work.
 *
 * The directory is watched, not the file: a watch on the file's inode would
 * miss a wake file deleted and written afresh.
 */

const fs = require("node:fs");
const path = require("node:path");

/* The fallback poll between ticks, for every cause of free room no wake
 * reports: memory freed by sessions the loop did not launch, a seat's
 * allowance turning fresh, founder presence, new frontier work. Untraced:
 * ruled on workflow-core#2199. */
const FALLBACK_MS = 300 * 1000;

/* The re-check after a woken tick still listing its waking session working
 * or unreaped: the listing read `done` at most ~6 s after a session's last
 * `Stop`, over three launches measured on workflow-core#2313; the 4 s above that is a
 * guess. */
const RECHECK_MS = 10 * 1000;

/**
 * Append one wake line: `<ms>`, then the waking session's id where one woke it.
 * @param {string} file
 * @param {string} [sessionId]
 */
function touchWake(file, sessionId) {
	fs.appendFileSync(
		file,
		`${[Date.now(), sessionId].filter(Boolean).join(" ")}\n`,
	);
}

/**
 * `recheck` marks the tick runTicks runs again on the same wake.
 * @typedef {{woken: boolean, sessions: string[], recheck?: boolean}} Wake
 */

/**
 * A watch on the wake file that holds at most one pending wake: wakes that
 * land during a tick set the flag once. The file is emptied first, so a line written before this
 * loop ran wakes nothing. A watch that cannot start, or that fails later,
 * is logged and leaves the fallback poll alone to end each sleep.
 * @param {string} file
 * @param {{log: (line: string) => void, watch?: typeof fs.watch}} opts
 */
function wakeWatcher(file, { log, watch = fs.watch }) {
	fs.writeFileSync(file, "");
	const name = path.basename(file);
	let pending = false;
	let offset = 0;
	/** @type {(() => void)|null} */
	let wakeWaiter = null;
	/** @type {fs.FSWatcher|null} */
	let watcher = null;
	/** @param {unknown} err */
	const pollOnly = (err) => {
		log(`wake watch failed, polling only: ${String(err)}`);
		watcher?.close();
		watcher = null;
	};
	try {
		watcher = watch(path.dirname(file), (_event, changed) => {
			/* A platform that names no file wakes the loop: one spare tick. */
			if (changed && String(changed) !== name) return;
			pending = true;
			wakeWaiter?.();
		});
		watcher.on("error", pollOnly);
	} catch (err) {
		pollOnly(err);
	}

	function readNewSessions() {
		let text = "";
		try {
			const all = fs.readFileSync(file);
			text = all.subarray(Math.min(offset, all.length)).toString("utf8");
			offset = all.length;
		} catch {
			/* Fails open (workflow-core#2313): a wake file gone or unreadable names no
			 * session, so the woken tick runs without a re-check. */
			offset = 0;
		}
		return text.split("\n").flatMap((line) => {
			const id = line.split(" ")[1];
			return id ? [id] : [];
		});
	}

	return {
		/**
		 * The first of a wake (one already pending included) or `ms` passing.
		 * @param {number} ms
		 * @returns {Promise<Wake>}
		 */
		async next(ms) {
			if (!pending) {
				/** @type {ReturnType<typeof setTimeout>|undefined} */
				let timer;
				await new Promise((resolve) => {
					wakeWaiter = () => resolve(undefined);
					timer = setTimeout(resolve, ms);
				});
				clearTimeout(timer);
				wakeWaiter = null;
			}
			const woken = pending;
			pending = false;
			return { woken, sessions: woken ? readNewSessions() : [] };
		},
		close: () => watcher?.close(),
	};
}

/**
 * Whether a woken tick's listing still shows one of its waking sessions
 * resident, so the room it frees is not yet seen: `working`, its `Stop` having
 * fired before the listing caught up; or `done` after the tick's reap, which
 * held it because the `Stop` hooks that woke the loop, or the turn one of them
 * forced, had not yet written the turn's end (workflow-core#2980).
 * @param {string[]} sessions
 * @param {import("./agent-liveness.js").AgentRecord[]|null} agents
 */
const isWakerStillResident = (sessions, agents) =>
	(agents ?? []).some(
		(a) =>
			(a.state === "working" || a.state === "done") &&
			sessions.includes(String(a.sessionId)),
	);

/**
 * @typedef {{done: boolean, agents:
 *   import("./agent-liveness.js").AgentRecord[]|null}} TickResult
 */

/**
 * Run `tick` until it answers done, sleeping between ticks on `watcher` for a
 * wake or the fallback poll, the sleep measured from a tick's end. A woken
 * tick whose listing still shows a waking session resident is followed, once,
 * by another after the re-check delay.
 * @param {(wake: Wake) => Promise<TickResult>} tick given the wake that began it
 * @param {{next: (ms: number) => Promise<Wake>}} watcher
 * @param {{fallbackMs?: number, recheckMs?: number,
 *   sleep?: (ms: number) => Promise<unknown>}} [seams]
 */
async function runTicks(
	tick,
	watcher,
	{
		fallbackMs = FALLBACK_MS,
		recheckMs = RECHECK_MS,
		sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	} = {},
) {
	/** @type {Wake} */
	let wake = { woken: false, sessions: [] };
	let rechecking = false;
	for (;;) {
		const { done, agents } = await tick(wake);
		if (done) return;
		if (
			!rechecking &&
			wake.woken &&
			isWakerStillResident(wake.sessions, agents)
		) {
			rechecking = true;
			await sleep(recheckMs);
			wake = { ...wake, recheck: true };
			continue;
		}
		rechecking = false;
		wake = await watcher.next(fallbackMs);
	}
}

module.exports = {
	runTicks,
	touchWake,
	wakeWatcher,
	FALLBACK_MS,
};
