const fs = require("node:fs");
const path = require("node:path");

// guess, workflow-core#2199
const FALLBACK_MS = 300 * 1000;

// measured 6 s max over 3 launches, +4 s guess, workflow-core#2313
const RECHECK_MS = 10 * 1000;

/**
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
 * @typedef {{woken: boolean, sessions: string[], recheck?: boolean}} Wake
 */

/**
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
			offset = 0;
		}
		return text.split("\n").flatMap((line) => {
			const id = line.split(" ")[1];
			return id ? [id] : [];
		});
	}

	return {
		/**
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
 * @param {(wake: Wake) => Promise<TickResult>} tick
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
