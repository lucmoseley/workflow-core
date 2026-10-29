#!/usr/bin/env node
/*
 * check-idle-efforts.js — the idle alarm (#3641, spec #3623): name, per
 * tracker, the open efforts nothing has launched for 2 days, the oldest, and
 * the loop's skip reason for it.
 *
 * Usage:  node scripts/check-idle-efforts.js [--json]
 *
 * READS every checkout the refill loop could serve (lib/refill-repos.js's
 * discoverRepos), each tracker once in one paged GraphQL query, and each
 * checkout's dispatch ledger as its launch log. A launch the ledger still
 * holds counts as running, as does each launch of a loop holding its pid
 * lock. A stopped loop serves no tracker and runs
 * nothing, so its stop is caught rather than masked.
 *
 * WARN, never FAIL. A tracker that will not read is its own line, never
 * "none idle".
 */

const { runCheck } = require("./lib/check");
const { ghAsync } = require("./lib/gh");
const { caught } = require("./lib/caught.js");
const {
	DEFAULT_WINDOW_HOURS,
	readLaunchTimes,
	readRecentEntries,
} = require("./lib/dispatch-ledger.js");
const { refKey } = require("./lib/issue-ref.js");
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
	buildIdleLines,
	findIdleEfforts,
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

/**
 * @param {(line: string) => void} reportDamaged
 */
function readLoop(reportDamaged) {
	const files = refillFiles.loopFiles();
	if (pidLock(files.pid, "refill-loop.js").holder() === null)
		return { running: false, served: [], launches: [] };
	const control = refillFiles.readControlFile(reportDamaged);
	const state = loop.parseState(
		refillFiles.readJson(files.state, reportDamaged),
	);
	return {
		running: true,
		served: control ? servedRoots(control.scope).roots : [],
		launches: loop.runningOf(state.launches),
	};
}

runCheck({
	name: "idle-efforts",
	usage: "node check-idle-efforts.js [--json]",
	async run(ctx) {
		const now = Date.now();
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
		/** @type {Map<string, number>} */
		const launches = new Map();
		/** @type {Set<string>} */
		const running = new Set();
		/** @param {string} root @param {number[]} issues */
		const markRunning = (root, issues) => {
			for (const [repo, roots] of rootsOf)
				if (roots.includes(root))
					for (const n of issues) running.add(refKey({ repo, number: n }));
		};
		for (const l of loopRead.launches) markRunning(l.root, l.issues);
		const trackers = await Promise.all(
			[...rootsOf].map(async ([repo, roots]) => {
				const served = roots.some((r) => loopRead.served.includes(r));
				try {
					for (const root of roots) {
						for (const [n, at] of readLaunchTimes(root)) {
							const key = refKey({ repo, number: n });
							launches.set(key, Math.max(launches.get(key) ?? 0, at));
						}
						const held = readRecentEntries(root, DEFAULT_WINDOW_HOURS);
						for (const e of held.entries) markRunning(root, e.issues);
					}
					const issues = await readIssues(repo, now);
					return { repo, served, issues, error: null };
				} catch (err) {
					const e = caught(err);
					const error = (e.stderr || e.message).trim().split("\n")[0] ?? "";
					return { repo, served, issues: [], error };
				}
			}),
		);
		const findings = findIdleEfforts({ trackers, launches, running, now });
		for (const line of buildIdleLines(findings, loopRead.running))
			ctx.say(line);
		for (const f of findings) {
			if (f.error !== null)
				ctx.warn("IDLE-EFFORTS-UNREAD", `${f.repo} would not read: ${f.error}`);
			else if (f.idle.length > 0)
				ctx.warn(
					"IDLE-EFFORTS",
					`${f.repo}: ${f.idle.length} effort(s) idle past ${IDLE_DAYS} days`,
					{ repo: f.repo, idle: f.idle },
				);
		}
		return {
			okLine: `no effort idle past ${IDLE_DAYS} days.`,
			noun: "tracker(s) with idle efforts or unread",
			data: { loopRunning: loopRead.running, trackers: findings },
		};
	},
});
