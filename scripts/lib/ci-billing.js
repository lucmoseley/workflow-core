const { cutAt } = require("./cut-at.js");

/**
 * @typedef {{started_at?: string|null, completed_at?: string|null,
 *   conclusion?: string|null, name?: string|null}} Job
 * @typedef {{id?: number, created_at?: string|null, name?: string|null,
 *   event?: string|null, run_attempt?: number, head_sha?: string|null}} Run
 * @typedef {{jobs: number, billed: number, pct?: number}} ShareRow
 * @typedef {{sha: string, files: string[]}} Commit
 * @typedef {{sha: string, commits: number, files: string[],
 *   docsOnly: boolean|null}} Push
 */

const RAN_NOTHING = new Set(["skipped"]);

/**
 * @param {Job} job
 * @returns {number|null}
 */
function jobSeconds(job) {
	if (!job.started_at || !job.completed_at) return null;
	const start = Date.parse(job.started_at);
	const end = Date.parse(job.completed_at);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	if (end < start) return null;
	return (end - start) / 1000;
}

/**
 * @param {Job} job
 * @returns {number}
 */
function billedMinutes(job) {
	if (RAN_NOTHING.has(job.conclusion ?? "")) return 0;
	const seconds = jobSeconds(job);
	if (seconds === null) return 0;
	return Math.ceil(seconds / 60);
}

/**
 * @param {string|null|undefined} iso
 * @returns {string|null}
 */
const utcDay = (iso) => {
	const t = Date.parse(iso ?? "");
	return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

/**
 * @template {Run} T
 * @param {T[]} runs
 * @param {string[]} [excluded]
 * @returns {T[]}
 */
function filterRuns(runs, excluded = []) {
	if (excluded.length === 0) return runs;
	const drop = new Set(excluded);
	return runs.filter((run) => !drop.has(run.event ?? ""));
}

const PUSH_EVENTS = new Set(["push"]);

/**
 * @template {ShareRow & Record<string, any>} T
 * @param {T[]} rows
 * @param {number} billed
 * @param {string} key
 * @returns {(T & {pct: number})[]}
 */
function withShares(rows, billed, key) {
	return [...rows]
		.sort(
			(a, b) =>
				b.billed - a.billed || String(a[key]).localeCompare(String(b[key])),
		)
		.map((r) => ({ ...r, pct: billed > 0 ? (r.billed / billed) * 100 : 0 }));
}

/**
 * @template {ShareRow & {pct: number}} T
 * @param {T[]} rows
 * @param {number} minPct
 * @returns {{shown: T[], tail: {count: number, jobs: number, billed: number,
 *   pct: number}|null}}
 */
function foldShareRows(rows, minPct) {
	const shown = rows.filter((r) => r.pct >= minPct);
	const tail = rows.filter((r) => r.pct < minPct);
	if (tail.length === 0) return { shown, tail: null };
	return {
		shown,
		tail: {
			count: tail.length,
			jobs: tail.reduce((a, r) => a + r.jobs, 0),
			billed: tail.reduce((a, r) => a + r.billed, 0),
			pct: tail.reduce((a, r) => a + r.pct, 0),
		},
	};
}

/**
 * @typedef {{day: string, runs: number, jobs: number, billed: number,
 *   pushes: Set<string>}} DayRow
 * @typedef {{workflow: string, runs: number, jobs: number, billed: number}} WorkflowRow
 * @typedef {{event: string, runs: number, jobs: number, billed: number}} EventRow
 * @typedef {{job: string, workflow: string, jobs: number, billed: number}} JobRow
 * @typedef {{jobs: number, actualSeconds: number, billed: number,
 *   unfinished: number, skipped: number, rerunRuns: number,
 *   pushShas: Set<string>, days: Map<string, DayRow>,
 *   workflows: Map<string, WorkflowRow>, jobNames: Map<string, JobRow>,
 *   events: Map<string, EventRow>}} Tally
 * @typedef {{bucket: DayRow, wf: WorkflowRow, ev: EventRow, name: string}} RunRows
 */

/** @returns {Tally} */
function newTally() {
	return {
		jobs: 0,
		actualSeconds: 0,
		billed: 0,
		unfinished: 0,
		skipped: 0,
		rerunRuns: 0,
		pushShas: new Set(),
		days: new Map(),
		workflows: new Map(),
		jobNames: new Map(),
		events: new Map(),
	};
}

/**
 * @param {Tally} tally
 * @param {Run} run
 * @returns {RunRows}
 */
function tallyRun(tally, run) {
	const day = utcDay(run.created_at);
	const bucket = (day && tally.days.get(day)) || {
		day: day ?? "",
		runs: 0,
		jobs: 0,
		billed: 0,
		pushes: new Set(),
	};
	if (day) tally.days.set(day, bucket);
	bucket.runs += 1;

	const name = run.name || "(unnamed)";
	const wf = tally.workflows.get(name) || {
		workflow: name,
		runs: 0,
		jobs: 0,
		billed: 0,
	};
	tally.workflows.set(name, wf);
	wf.runs += 1;

	const eventName = run.event || "(unknown)";
	const ev = tally.events.get(eventName) || {
		event: eventName,
		runs: 0,
		jobs: 0,
		billed: 0,
	};
	tally.events.set(eventName, ev);
	ev.runs += 1;

	if ((run.run_attempt ?? 0) > 1) tally.rerunRuns += 1;

	if (PUSH_EVENTS.has(run.event ?? "") && run.head_sha) {
		tally.pushShas.add(run.head_sha);
		bucket.pushes.add(run.head_sha);
	}
	return { bucket, wf, ev, name };
}

/**
 * @param {Tally} tally
 * @param {RunRows} rows
 * @param {Job} job
 */
function tallyJob(tally, { bucket, wf, ev, name }, job) {
	tally.jobs += 1;
	bucket.jobs += 1;
	wf.jobs += 1;
	ev.jobs += 1;
	const jobName = job.name || "(unnamed)";
	const jn = tally.jobNames.get(jobName) || {
		job: jobName,
		workflow: name,
		jobs: 0,
		billed: 0,
	};
	tally.jobNames.set(jobName, jn);
	jn.jobs += 1;
	if (RAN_NOTHING.has(job.conclusion ?? "")) {
		tally.skipped += 1;
		return;
	}
	const seconds = jobSeconds(job);
	if (seconds === null) {
		tally.unfinished += 1;
		return;
	}
	tally.actualSeconds += seconds;
	const minutes = billedMinutes(job);
	tally.billed += minutes;
	bucket.billed += minutes;
	wf.billed += minutes;
	ev.billed += minutes;
	jn.billed += minutes;
}

/**
 * @param {Run[]} runs
 * @param {(run: Run) => Job[]} jobsOf
 */
function summarise(runs, jobsOf) {
	const tally = newTally();
	for (const run of runs) {
		const rows = tallyRun(tally, run);
		for (const job of jobsOf(run)) tallyJob(tally, rows, job);
	}
	const {
		jobs,
		actualSeconds,
		billed,
		unfinished,
		skipped,
		rerunRuns,
		pushShas,
		days,
		workflows,
		jobNames,
		events,
	} = tally;

	const pushes = pushShas.size;
	const actual = actualSeconds / 60;
	return {
		runs: runs.length,
		jobs,
		actual,
		billed,
		ratio: actual > 0 ? billed / actual : 0,
		unfinished,
		skipped,
		rerunRuns,
		perWorkflow: withShares([...workflows.values()], billed, "workflow"),
		perEvent: withShares([...events.values()], billed, "event"),
		perJob: withShares([...jobNames.values()], billed, "job"),
		pushes,
		billedPerPush: pushes > 0 ? billed / pushes : 0,
		perDay: [...days.values()]
			.sort((a, b) => a.day.localeCompare(b.day))
			.map(({ pushes: p, ...rest }) => ({ ...rest, pushes: p.size })),
	};
}

const MONTHLY_ALLOWANCE_MINUTES = 2000;

/**
 * @param {{billed: number, pushes: number}} summary
 * @param {number} days
 * @param {number} [allowance]
 */
function monthlyProjection(
	summary,
	days,
	allowance = MONTHLY_ALLOWANCE_MINUTES,
) {
	if (!(days > 0)) return null;
	const perMonth = (summary.billed / days) * 30;
	return {
		perMonth,
		pushesPerDay: summary.pushes / days,
		allowance,
		headroomPct: ((allowance - perMonth) / allowance) * 100,
		usedPct: (perMonth / allowance) * 100,
	};
}

const DOCS_ONLY_PREFIXES = ["docs/", ".claude/"];

/**
 * @param {string[]} files
 * @returns {boolean|null}
 */
function isDocsOnly(files) {
	if (files.length === 0) return null;
	return files.every(
		(f) => f.endsWith(".md") || DOCS_ONLY_PREFIXES.some((p) => f.startsWith(p)),
	);
}

/**
 * @param {string} text
 * @returns {Commit[]}
 */
function parseCommitLog(text) {
	return text
		.split("\0")
		.map((chunk) => {
			const [sha, body] = cutAt(chunk, "\n");
			return {
				sha: sha.trim(),
				files: body.split("\n").filter((l) => l.trim()),
			};
		})
		.filter((c) => c.sha);
}

/**
 * @param {Commit[]} commits
 * @param {Iterable<string>} pushShas
 */
function foldPushes(commits, pushShas) {
	const heads = new Set(pushShas);
	/** @type {Set<string>} */
	const seen = new Set();
	/** @type {Push[]} */
	const pushes = [];
	/** @type {Commit[]} */
	let pending = [];
	for (const commit of commits) {
		pending.push(commit);
		if (!heads.has(commit.sha)) continue;
		seen.add(commit.sha);
		const files = pending.flatMap((c) => c.files);
		const unknown = pending.some((c) => c.files.length === 0);
		pushes.push({
			sha: commit.sha,
			commits: pending.length,
			files,
			docsOnly: unknown ? null : isDocsOnly(files),
		});
		pending = [];
	}
	return {
		pushes,
		unpushedCommits: pending.length,
		missingHeads: [...heads].filter((sha) => !seen.has(sha)),
	};
}

/** @param {Push[]} pushes */
function pushCommitStats(pushes) {
	const n = pushes.length;
	if (!n) {
		return {
			pushes: 0,
			commits: 0,
			mean: 0,
			median: 0,
			singleCommitShare: 0,
			docsOnlyShare: 0,
			unclassified: 0,
		};
	}
	const counts = pushes.map((p) => p.commits).sort((a, b) => a - b);
	const commits = counts.reduce((a, b) => a + b, 0);
	const mid = Math.floor(n / 2);
	const middle = counts.slice(n % 2 ? mid : mid - 1, mid + 1);
	const median = middle.reduce((a, b) => a + b, 0) / middle.length;
	const classified = pushes.filter((p) => p.docsOnly !== null);
	return {
		pushes: n,
		commits,
		mean: commits / n,
		median,
		singleCommitShare: (counts.filter((c) => c === 1).length / n) * 100,
		docsOnlyShare:
			classified.length > 0
				? (classified.filter((p) => p.docsOnly).length / classified.length) *
					100
				: 0,
		unclassified: n - classified.length,
	};
}

/**
 * @param {string} since
 * @param {string} until
 * @returns {string[]}
 */
function dayWindows(since, until) {
	/** @type {string[]} */
	const days = [];
	for (
		let t = Date.parse(`${since}T00:00:00Z`);
		t <= Date.parse(`${until}T00:00:00Z`);
		t += 86_400_000
	) {
		days.push(new Date(t).toISOString().slice(0, 10));
	}
	return days;
}

/**
 * @param {{day: string, billed: number}[]} perDay
 * @param {string} since
 * @param {string} until
 * @returns {number[]}
 */
function dailySeries(perDay, since, until) {
	const billedByDay = new Map(perDay.map((d) => [d.day, d.billed]));
	return dayWindows(since, until).map((day) => billedByDay.get(day) || 0);
}

/**
 * @param {string} until
 * @param {Date} [now]
 */
function clampUntil(until, now = new Date()) {
	const last = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
	return until > last ? last : until;
}

/**
 * @param {string} since
 * @param {string} until
 */
function windowSpanDays(since, until) {
	return (
		(Date.parse(`${until}T23:59:59Z`) - Date.parse(`${since}T00:00:00Z`)) /
		86_400_000
	);
}

const T_95 = [
	12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201,
	2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074,
	2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

/** @param {number[]} values */
function dailyMeanBand(values) {
	const n = values.length;
	if (n < 2) return null;
	const mean = values.reduce((a, b) => a + b, 0) / n;
	const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1);
	const sd = Math.sqrt(variance);
	const t = T_95[n - 2] ?? 1.96;
	const halfWidth = t * (sd / Math.sqrt(n));
	const lo = Math.max(0, mean - halfWidth);
	const hi = mean + halfWidth;
	return {
		n,
		mean,
		sd,
		t,
		halfWidth,
		lo,
		hi,
		monthlyLo: lo * 30,
		monthlyHi: hi * 30,
	};
}

module.exports = {
	PUSH_EVENTS,
	clampUntil,
	dayWindows,
	windowSpanDays,
	summarise,
	monthlyProjection,
	filterRuns,
	foldShareRows,
	parseCommitLog,
	foldPushes,
	pushCommitStats,
	dailySeries,
	dailyMeanBand,
};
