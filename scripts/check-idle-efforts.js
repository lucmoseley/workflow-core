#!/usr/bin/env node

const { now: clockNow, runCheck } = require("./lib/check");
const { ghAsync } = require("./lib/gh");
const { caught } = require("./lib/caught.js");
const {
	DEFAULT_WINDOW_HOURS,
	readLaunchTimes,
	readRecentEntries,
} = require("./lib/dispatch-ledger.js");
const hookMessage = require("./lib/hook-message");
const { LONG_STALE_MS } = require("./lib/notify-report");
const deliveryStamp = require("./lib/delivery-stamp.js");
const { isFounderNoticeHeld } = require("./lib/background-start.js");
const { localDate } = require("./lib/local-date.js");
const { readParkMarkersOrThrow } = require("./lib/parked.js");
const { pidLock } = require("./lib/pid-lock.js");
const loop = require("./lib/refill-loop.js");
const refillFiles = require("./lib/refill-files.js");
const { readState } = require("./lib/refill-state.js");
const {
	discoverRepos,
	homeDir,
	readHostTracker,
} = require("./lib/refill-repos.js");
const { readTickHolds } = require("./lib/repo-holds.js");
const { servedRoots } = require("./lib/refill-io.js");
const {
	IDLE_DAYS,
	QUERY,
	buildIdleReport,
	buildLiveLoopWait,
	buildReadings,
	findIdleEfforts,
	buildFindingRecords,
	parseIssueNodes,
	stoppedRunOf,
} = require("./lib/idle-efforts.js");

/**
 * @param {string} repo
 * @param {number} now
 */
async function readIssues(repo, now) {
	const [owner = "", name = ""] = repo.split("/");
	const out = await ghAsync([
		"api",
		"graphql",
		"--paginate",
		"--slurp",
		"-f",
		`owner=${owner}`,
		"-f",
		`name=${name}`,
		"-f",
		`query=${QUERY}`,
	]);
	return parseIssueNodes(JSON.parse(out), now);
}

const CHECKER = "idle-efforts";

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {import("./lib/idle-efforts.js").IdleReport} idleReport
 */
function report(ctx, { unseen, stopUnseen, damagedUnseen, lines }) {
	for (const line of lines) ctx.say(line);
	for (const r of buildFindingRecords(unseen, stopUnseen, damagedUnseen))
		ctx.warn(r.code, r.text, r.data);
}

/**
 * @param {(line: string) => void} reportDamaged
 * @returns {import("./lib/idle-efforts.js").LoopReading & {running: boolean, stoppedRun: number|null}}
 */
function readLoop(reportDamaged) {
	const files = refillFiles.loopFiles();
	if (pidLock(files.pid, "refill-loop.js").holder() === null) {
		const lastControl = refillFiles.readControlFile(() => undefined);
		const { launchCount } = readState(() => undefined);
		return {
			running: false,
			stoppedRun: stoppedRunOf(lastControl, launchCount),
			served: [],
			launches: [],
			held: [],
			repoHolds: [],
			loopWait: null,
			repoPaused: {},
			holdsUnreadRoots: [],
		};
	}
	const control = refillFiles.readControlFile(reportDamaged);
	const state = readState(reportDamaged);
	const served = control ? servedRoots(control.scope).roots : [];
	const { holds: repoHolds, unread } = readTickHolds(
		served,
		state.probeBrokenRoots,
	);
	for (const { lines } of unread) for (const line of lines) reportDamaged(line);
	return {
		running: true,
		stoppedRun: null,
		served,
		launches: loop.runningOffLimitOf(state.launches),
		held: [...state.held, ...loop.limitHoldsOf(state.launches)],
		repoHolds,
		loopWait: buildLiveLoopWait(control?.paused, state.lastTick?.idle),
		repoPaused: control?.repoPaused ?? {},
		holdsUnreadRoots: unread.map(({ root }) => root),
	};
}

/** @param {string} [source] */
const buildSpec = (source) => ({
	name: CHECKER,
	usage: "node check-idle-efforts.js [--notify] [--json]",
	async run(/** @type {import("./lib/check").Ctx} */ ctx) {
		const now = clockNow();
		/** @type {string[]} */
		const damaged = [];
		const loopRead = readLoop((line) => damaged.push(line));
		/** @type {Map<string, string[]>} */
		const rootsOf = new Map();
		for (const root of discoverRepos(homeDir()).included) {
			const repo = readHostTracker(root);
			if (repo) rootsOf.set(repo, [...(rootsOf.get(repo) ?? []), root]);
			else ctx.say(`${root}: no tracker configured, not read.`);
		}
		const trackers = await Promise.all(
			[...rootsOf].map(async ([repo, roots]) => {
				/** @type {import("./lib/idle-efforts.js").LedgerReading[]} */
				const ledgers = [];
				try {
					for (const root of roots) {
						/** @type {import("./lib/idle-efforts.js").LedgerReading} */
						const ledger = {
							root,
							launchTimes: readLaunchTimes(root),
							recent: [],
						};
						ledgers.push(ledger);
						ledger.recent = readRecentEntries(root, DEFAULT_WINDOW_HOURS)
							.entries.filter((e) => !e.heldUntil)
							.map((e) => e.issues);
					}
					const markers = roots.map(readParkMarkersOrThrow);
					const issues = await readIssues(repo, now);
					return { repo, issues, error: null, ledgers, markers };
				} catch (err) {
					const e = caught(err);
					const error = (e.stderr || e.message).trim().split("\n")[0] ?? "";
					return { repo, issues: [], error, ledgers, markers: [] };
				}
			}),
		);
		const findings = findIdleEfforts(
			buildReadings({ rootsOf, trackers, loop: loopRead, now }),
		);
		const idleReport = buildIdleReport(
			findings,
			loopRead.running,
			damaged,
			ctx.notify
				? {
						stamp: deliveryStamp.readStamp(CHECKER),
						day: localDate(new Date(now)),
						held: isFounderNoticeHeld(CHECKER, source),
						stoppedRun: loopRead.stoppedRun,
					}
				: null,
		);
		const { signature, stampNow } = idleReport;
		report(ctx, idleReport);
		if (stampNow !== null) deliveryStamp.markDelivered(ctx, CHECKER, stampNow);
		return {
			...(signature !== null && { stamp: signature }),
			maxAgeMs: LONG_STALE_MS,
			okLine: `no effort idle past ${IDLE_DAYS} days.`,
			noun: "finding(s): a stopped loop, a damaged loop file, or a tracker with idle efforts or unread",
			data: { loopRunning: loopRead.running, trackers: findings, damaged },
		};
	},
});

const main = () => {
	// cli-args-exempt: workflow-core#5540
	const source = process.argv.includes("--notify")
		? hookMessage.readPayload()?.source
		: undefined;
	if (source === "compact") return;
	return runCheck(buildSpec(source));
};

module.exports = { main };
if (require.main === module) main();
