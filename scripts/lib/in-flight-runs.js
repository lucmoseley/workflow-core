const fs = require("node:fs");
const path = require("node:path");
const { pidAlive } = require("./arbiter-proc.js");
const { ignoreFailure } = require("./caught.js");
const { noop } = require("./noop.js");
const { launchRoute } = require("./launch-route.js");
const { shellQuote } = require("./sh-quote.js");
const {
	defaultQueueDir,
	isMarkerStale,
	readStartTimeOf,
} = require("./suite-queue.js");

const RUN_PREFIX = "run-";

/**
 * @typedef {"touched" | "named" | "changed" | "full" | "shared"} RunLane
 * @typedef {{ pid: number, startedAt: number, command: string, lane: RunLane }} InFlightRun
 * @typedef {{ pid: number, at: number, start?: number, session?: string, args?: string[] }} RunRecord
 * @typedef {{ queueDir?: string, queueFs?: typeof fs, alive?: (pid: number) => boolean, startTime?: (pid: number) => number }} InFlightOptions
 */

/**
 * @param {string[]} args
 * @returns {RunLane}
 */
function laneOf(args) {
	if (args.includes("--shared")) return "shared";
	return launchRoute(args, null).kind;
}

/**
 * @param {string[]} args
 * @returns {string}
 */
const commandOf = (args) =>
	[
		"npm run test",
		...(args.length > 0 ? ["--", ...args.map(shellQuote)] : []),
	].join(" ");

/**
 * @param {{ session: string, args: string[], queueDir?: string, queueFs?: typeof fs, pid?: number, clock?: () => number }} run
 * @returns {() => void}
 */
function recordRun({
	session,
	args,
	queueDir = defaultQueueDir(),
	queueFs = fs,
	pid = process.pid,
	clock = Date.now,
}) {
	const file = path.join(queueDir, `${RUN_PREFIX}${pid}.json`);
	try {
		queueFs.mkdirSync(queueDir, { recursive: true });
		queueFs.writeFileSync(
			file,
			JSON.stringify({
				pid,
				at: clock(),
				start: readStartTimeOf(pid),
				session,
				args,
			}),
		);
	} catch {
		return noop;
	}
	return () => ignoreFailure(() => queueFs.rmSync(file, { force: true }));
}

/**
 * @param {string} file
 * @param {typeof fs} queueFs
 * @returns {RunRecord | null}
 */
function readRunRecord(file, queueFs) {
	try {
		const record = JSON.parse(String(queueFs.readFileSync(file, "utf8")));
		return typeof record?.pid === "number" && typeof record?.at === "number"
			? record
			: null;
	} catch {
		return null;
	}
}

/**
 * @param {string} session
 * @param {InFlightOptions} [options]
 * @returns {InFlightRun[] | null}
 */
function readInFlightRuns(
	session,
	{
		queueDir = defaultQueueDir(),
		queueFs = fs,
		alive = pidAlive,
		startTime = readStartTimeOf,
	} = {},
) {
	/** @type {string[]} */
	let names;
	try {
		names = queueFs.readdirSync(queueDir).map(String);
	} catch (error) {
		if (/** @type {{ code?: string }} */ (error)?.code === "ENOENT") return [];
		return null;
	}
	/** @type {InFlightRun[]} */
	const runs = [];
	for (const name of names) {
		if (!name.startsWith(RUN_PREFIX)) continue;
		const record = readRunRecord(path.join(queueDir, name), queueFs);
		if (!record || record.session !== session) continue;
		if (isMarkerStale(record, { alive, startTime })) continue;
		const args = Array.isArray(record.args) ? record.args.map(String) : [];
		runs.push({
			pid: record.pid,
			startedAt: record.at,
			command: commandOf(args),
			lane: laneOf(args),
		});
	}
	return runs.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
}

/** @param {InFlightRun[]} runs */
const touchedRuns = (runs) => runs.filter((r) => r.lane === "touched");

const WAITED_LANES = new Set(["touched", "named", "changed"]);

/** @param {InFlightRun[]} runs */
const waitedRuns = (runs) => runs.filter((r) => WAITED_LANES.has(r.lane));

/** @param {InFlightRun[]} runs */
const runList = (runs) =>
	runs
		.map(
			(r) =>
				`PID ${r.pid}, started ${new Date(r.startedAt).toISOString()}, \`${r.command}\``,
		)
		.join("; ");

/**
 * @param {InFlightRun[]} runs
 * @returns {string}
 */
function rerunRefusal(runs) {
	const one = runs.length === 1;
	return `Not run: this session's own touched test run${one ? " is" : "s are"} still in flight — ${runList(runs)}. A second bare \`npm run test\` reads the same files and repeats ${one ? "it" : "them"}. Wait for ${one ? "that run's notification" : "each run's notification"}, which brings its verdict, and act on that (#5716).`;
}

/**
 * @param {InFlightRun[]} runs
 * @param {string} command
 * @returns {string}
 */
function commitRefusal(runs, command) {
	const one = runs.length === 1;
	return `pre-commit: this session's own touched test run${one ? " is" : "s are"} still in flight — ${runList(runs)} — so this commit is refused before '${command}' runs beside ${one ? "it" : "them"} (#5716).\n  Commit again once ${one ? "that run ends" : "they end"}: its notification brings its verdict.\n`;
}

// guess, #5716: copied from rule:job-holds-turn's 540 s waits
const WAIT_CEILING_S = 540;
// guess, #5716: bg-run.sh wait polls every 2 s
const WAIT_POLL_MS = 2000;

/**
 * @typedef {{ verdict: "DONE" } | { verdict: "CEILING", runs: InFlightRun[] } | { verdict: "UNREAD" }} WaitResult
 */

/**
 * @param {() => InFlightRun[] | null} read
 * @param {{ ceilingS?: number, pollMs?: number, clock?: () => number, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<WaitResult>}
 */
async function waitForRuns(
	read,
	{
		ceilingS = WAIT_CEILING_S,
		pollMs = WAIT_POLL_MS,
		clock = Date.now,
		sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	} = {},
) {
	const start = clock();
	for (;;) {
		const runs = read();
		if (runs === null) return { verdict: "UNREAD" };
		const held = waitedRuns(runs);
		if (held.length === 0) return { verdict: "DONE" };
		if (clock() - start >= ceilingS * 1000)
			return { verdict: "CEILING", runs: held };
		await sleep(pollMs);
	}
}

module.exports = {
	WAIT_CEILING_S,
	recordRun,
	commitRefusal,
	readInFlightRuns,
	rerunRefusal,
	runList,
	touchedRuns,
	waitForRuns,
};
