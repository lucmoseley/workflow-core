#!/usr/bin/env node
/*
 * check-idle-efforts.js — the idle alarm (#3641, spec #3623): name, per
 * tracker, the open efforts nothing has launched for 2 days, the oldest, the
 * loop's skip reason for it, and each ticket held at the limit-cap parks' cap.
 *
 * Usage:  node scripts/check-idle-efforts.js [--notify] [--json]
 *
 * READS every checkout the refill loop could serve (lib/refill-repos.js's
 * discoverRepos), each tracker once in one paged GraphQL query, and each
 * checkout's dispatch ledger as its launch log: the dispatcher writes each
 * fresh launch to it, and the refill loop each resume of a parked session
 * (lib/refill-batch.js's resumeParked, #3704). A launch the ledger still
 * holds counts as running, as does each launch of a loop holding its pid
 * lock, bar one waiting on a limit (#3838). The loop's state names the parked
 * issues it holds, and since when (#3680), and those waiting launches. A
 * stopped loop serves no tracker, runs and holds
 * nothing, so its stop is caught rather than masked: its last full-seat holds
 * are not named, as nothing reads whether those seats have reset and starting
 * the loop is the act either way; their state outlives the stop, so the next
 * tick's reading keeps their start (#3850). Each checkout's park
 * markers name the tickets held at the limit-cap parks' cap, and since when,
 * with or without a loop (#3840).
 *
 * WARN, never FAIL. A tracker that will not read is its own line, never
 * "none idle".
 *
 * ONCE PER FINDING PER DAY under `--notify` (#3644): a finding is an idle
 * issue or an unread tracker, and a session start names each tracker holding
 * one its delivery stamp (lib/delivery-stamp.js) does not record for that
 * machine-local day. The stamp is written only once a report is shown: by this
 * run under plain `--notify`, and under persist mode by the replay reader, from
 * the signature this run carries. So it is read under persist mode too, which
 * readSeenStamp declines: nothing it records went unshown. A dispatcher's or the
 * loop's job start is taken as unwatched, as is any job's resume, his own
 * included, since the loop wakes a parked job whoever launched it (#3841), so it
 * records nothing either: this report is among lib/background-start.js's
 * FOUNDER_NOTICES, which the replay holds back there, and a plain `--notify` run
 * there names what is unseen but writes no stamp, leaving the founder's own
 * start, in a terminal or from the agents view, to show it (#3707, #3725, #3772).
 * A plain run, the morning review's included, names every tracker and
 * records nothing. A compaction is no session start: it exits before a
 * persisted run opens, so it neither prints nor replaces a report not yet
 * shown.
 *
 * IMPLICIT:  at every session start, reads every adopting checkout's tracker and reports each tracker holding an effort idle past 2 days, or unread, whose finding was not yet shown that machine-local day; a dispatcher's or the loop's job start, or any job's resume, stamps none of it, and through the hooks shows none of it.
 * JUSTIFIED: fail-safe — a stopped loop, or a route it skips, strands an effort with nothing else to say so.
 * DEFEAT:    none needed — it never blocks; deleting its delivery stamp names today's findings again.
 */

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
const { localDate } = require("./lib/morning-review.js");
const { listParkMarkers } = require("./lib/parked.js");
const { pidLock } = require("./lib/pid-lock.js");
const loop = require("./lib/refill-loop.js");
const refillFiles = require("./lib/refill-files.js");
const {
	discoverRepos,
	homeDir,
	readHostTracker,
} = require("./lib/refill-repos.js");
const { servedRoots } = require("./lib/refill-tick.js");
const {
	IDLE_DAYS,
	QUERY,
	buildIdleReport,
	buildReadings,
	findIdleEfforts,
	buildFindingRecords,
	parseIssueNodes,
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
function report(ctx, { unseen, lines }) {
	for (const line of lines) ctx.say(line);
	for (const r of buildFindingRecords(unseen)) ctx.warn(r.code, r.text, r.data);
}

/**
 * @param {(line: string) => void} reportDamaged
 * @returns {import("./lib/idle-efforts.js").LoopReading & {running: boolean}}
 */
function readLoop(reportDamaged) {
	const files = refillFiles.loopFiles();
	if (pidLock(files.pid, "refill-loop.js").holder() === null)
		return { running: false, served: [], launches: [], held: [] };
	const control = refillFiles.readControlFile(reportDamaged);
	const state = refillFiles.readStateFile(reportDamaged);
	return {
		running: true,
		served: control ? servedRoots(control.scope).roots : [],
		launches: loop.workingOf(state.launches),
		held: [...state.held, ...loop.limitHoldsOf(state.launches)],
	};
}

/** @param {string} [source] the hook payload's `source`; absent on a plain run */
const buildSpec = (source) => ({
	name: CHECKER,
	usage: "node check-idle-efforts.js [--notify] [--json]",
	async run(/** @type {import("./lib/check").Ctx} */ ctx) {
		// Residual: the day stamp is written off this clock, so a stray WFC_NOW
		// skews it (check.js now(), mantahostels#2161).
		const now = clockNow();
		const loopRead = readLoop((line) =>
			ctx.warn("REFILL-LOOP-FILE-DAMAGED", line),
		);
		/** @type {Map<string, string[]>} tracker to its checkouts */
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
						/* Pushed before the recent read, so its launch times count
						 * even where that read throws. */
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
					const markers = roots.map(listParkMarkers);
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
			ctx.notify
				? {
						stamp: deliveryStamp.readStamp(CHECKER),
						day: localDate(new Date(now)),
						held: isFounderNoticeHeld(CHECKER, source),
					}
				: null,
		);
		const { signature, stampNow } = idleReport;
		report(ctx, idleReport);
		/* After the report is out, so a run killed between repeats rather than
		 * swallows it. */
		if (stampNow !== null) deliveryStamp.markDelivered(ctx, CHECKER, stampNow);
		return {
			...(signature !== null && { stamp: signature }),
			maxAgeMs: LONG_STALE_MS,
			okLine: `no effort idle past ${IDLE_DAYS} days.`,
			noun: "tracker(s) with idle efforts or unread",
			data: { loopRunning: loopRead.running, trackers: findings },
		};
	},
});

const main = () => {
	/* Read under --notify alone: a plain run's stdin may be a terminal.
	 * cli-args-exempt: a peek before runCheck, which parses the argv. */
	const source = process.argv.includes("--notify")
		? hookMessage.readPayload()?.source
		: undefined;
	if (source === "compact") return;
	return runCheck(buildSpec(source));
};

module.exports = { main };
if (require.main === module) main();
