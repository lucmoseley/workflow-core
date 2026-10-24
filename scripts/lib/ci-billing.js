/*
 * The arithmetic behind .github/workflows/scheduled-checks.yml — what a window of GitHub Actions
 * runs actually costs. Separated from the fetching so the sums are testable
 * without a network: measure-ci-billing.js does the I/O and hands the shapes
 * below straight in.
 *
 * Actions bills per JOB, rounded up to a whole minute, off the job's own
 * started_at/completed_at. Never the /timing endpoint, which returns
 * total_ms: 0 on this repo.
 */

const { cutAt } = require("./cut-at.js");

/**
 * The two API shapes this prices, and the split rows it folds them into. Both
 * come from GitHub's REST bodies, where every field this reads may be absent.
 *
 * @typedef {{started_at?: string|null, completed_at?: string|null,
 *   conclusion?: string|null, name?: string|null}} Job
 * @typedef {{id?: number, created_at?: string|null, name?: string|null,
 *   event?: string|null, run_attempt?: number, head_sha?: string|null}} Run
 * @typedef {{jobs: number, billed: number, pct?: number}} ShareRow
 * @typedef {{sha: string, files: string[]}} Commit
 * @typedef {{sha: string, commits: number, files: string[],
 *   docsOnly: boolean|null}} Push
 */

/** A job GitHub never gave a runner to costs nothing, whatever its timestamps
 *  say. `skipped` is the `if:` guard declining; `null` is still in flight. */
const RAN_NOTHING = new Set(["skipped"]);

/** Seconds a job held a runner, or null where it cannot be known — an
 *  unfinished job, or one whose timestamps GitHub left unset. Never zero:
 *  a zero would be counted as billed. */
/**
 * @param {Job} job
 * @returns {number|null}
 */
function jobSeconds(job) {
	if (!job.started_at || !job.completed_at) return null;
	const start = Date.parse(job.started_at);
	const end = Date.parse(job.completed_at);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	/* Finishing before it started is bad data, not a zero-second job. */
	if (end < start) return null;
	return (end - start) / 1000;
}

/** Whole minutes billed for one job. */
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

/** UTC calendar day, the unit the per-day table buckets on. Null for a run
 *  GitHub gave no timestamp. */
/**
 * @param {string|null|undefined} iso
 * @returns {string|null}
 */
const utcDay = (iso) => {
	const t = Date.parse(iso ?? "");
	return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

/**
 * Drop the run events a census does not price. The scope that reproduces the
 * recorded mantahostels#313 census is every branch MINUS `pull_request` runs (mantahostels#386): a PR
 * run duplicates the push run on the same commits, so counting both prices work
 * that was billed under a branch this repo does not use.
 *
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

/*
 * This measures the world before mantahostels#910, when a push fired the workflows and was
 * therefore the billable unit. One push fires several, so runs are collapsed to
 * their head_sha, and only push-triggered runs count: a schedule or a
 * workflow_dispatch costs minutes but is not a push anyone could have held
 * back. Since mantahostels#910 nothing runs on push at all and the sweep is the billable
 * unit, so a window after it has no push-triggered runs to collapse —
 * .github/workflows/scheduled-checks.yml carries the live pricing.
 */
const PUSH_EVENTS = new Set(["push"]);

/**
 * Rank a split's rows by billed minutes and give each its share of the total.
 * `key` is the row's own label field, breaking ties so the order is stable.
 * A zero-billed window gets shares of zero rather than NaN.
 *
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
 * The rows a share table should print. Rows under `minPct` fold into one
 * `other` line so single-run workflows do not bury the rows the census is read
 * from; `minPct: 0` folds nothing (mantahostels#677).
 *
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
		/* Billed minutes by workflow, and by job name. A path filter skips jobs,
		 * not workflows, so the job split is the one that prices one (mantahostels#386). */
		workflows: new Map(),
		jobNames: new Map(),
		/* Billed minutes by trigger event: the row that prices what the census
		 * scope's `--exclude-event pull_request` leaves out (mantahostels#677). */
		events: new Map(),
	};
}

/**
 * Count one run into its day, workflow and event rows, returning those rows
 * for its jobs to add to.
 *
 * @param {Tally} tally accumulator: the run is counted into its day, workflow and event rows and the totals
 * @param {Run} run
 * @returns {RunRows}
 */
function tallyRun(tally, run) {
	const day = utcDay(run.created_at);
	/* A run GitHub gave no readable timestamp gets a bucket that is never
	 * filed, so it lands in no day rather than in the wrong one. */
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

	/* A superseded attempt's jobs are billed and invisible under
	 * `filter=latest` (mantahostels#386). */
	if ((run.run_attempt ?? 0) > 1) tally.rerunRuns += 1;

	if (PUSH_EVENTS.has(run.event ?? "") && run.head_sha) {
		tally.pushShas.add(run.head_sha);
		bucket.pushes.add(run.head_sha);
	}
	return { bucket, wf, ev, name };
}

/**
 * Count one job into the totals, its job-name row and its run's rows.
 *
 * @param {Tally} tally accumulator: the job is counted into the totals and its job-name row
 * @param {RunRows} rows accumulator: the run's day, workflow and event rows, each counting the job
 * @param {Job} job
 */
function tallyJob(tally, { bucket, wf, ev, name }, job) {
	tally.jobs += 1;
	bucket.jobs += 1;
	wf.jobs += 1;
	ev.jobs += 1;
	/* One job name can appear under several workflows; the first that
	 * used it labels the row, so `workflow` is a hint, not a key. */
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
 * Fold a window of runs into the figures .github/workflows/scheduled-checks.yml quotes.
 *
 * `runs` are the runs API's objects; `jobsOf(run)` returns that run's jobs.
 * Returns actual minutes unrounded alongside billed; their ratio is the
 * round-up cost.
 *
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
		/* The round-up cost: billed minutes per minute of compute. */
		ratio: actual > 0 ? billed / actual : 0,
		unfinished,
		skipped,
		rerunRuns,
		perWorkflow: withShares([...workflows.values()], billed, "workflow"),
		perEvent: withShares([...events.values()], billed, "event"),
		perJob: withShares([...jobNames.values()], billed, "job"),
		pushes,
		billedPerPush: pushes > 0 ? billed / pushes : 0,
		/* A push whose runs straddle UTC midnight is active on both days, so the
		 * per-day pushes column sums ABOVE `pushes`. Per-day-active, not a
		 * partition. */
		perDay: [...days.values()]
			.sort((a, b) => a.day.localeCompare(b.day))
			.map(({ pushes: p, ...rest }) => ({ ...rest, pushes: p.size })),
	};
}

/** GitHub Free's included private-repo Actions minutes a month — the account's
 *  plan since 13 Sep 2026 (.github/workflows/scheduled-checks.yml, THE
 *  ALLOWANCE ITSELF SHRANK; #405). A plan change edits this and its pinning
 *  test. */
const MONTHLY_ALLOWANCE_MINUTES = 2000;

/**
 * Project a window onto a 30-day month. `days` is the window's real span in
 * days — a fraction is the point, since a 2.6-day window is what .github/workflows/scheduled-checks.yml's thin
 * reading was.
 *
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

/*
 * Commits, pushes and docs-only pushes. These come from `git log`, not the
 * runs API — Actions knows a run's head commit and nothing about how many
 * commits arrived with it.
 */

/** A push touching only these skips nothing the CI runs. `.md` covers
 *  CLAUDE.md and AGENTS.md at the root. */
const DOCS_ONLY_PREFIXES = ["docs/", ".claude/"];

/** True, false, or null where no file list is available at all — a merge commit
 *  lists none under `--name-only`. */
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
 * Parse `git log --reverse --pretty=format:%x00%H --name-only` — a NUL, the
 * sha, then that commit's paths. Oldest first, which is the order foldPushes
 * walks.
 *
 * @param {string} text
 * @returns {Commit[]}
 */
function parseCommitLog(text) {
	/* The first chunk is whatever preceded the first NUL — empty for real git
	 * output. */
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
 * Attribute commits to the push that carried them: a push head owns every
 * commit since the previous push head. `pushShas` is `summarise`'s push set —
 * unordered, so history is what orders them.
 *
 * Commits after the last push head are not yet pushed, and a push head absent
 * from this history is reported rather than dropped: it sits on a branch this
 * checkout does not have, or was rebased away.
 *
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
		/* One commit with no file list makes the whole push unclassifiable. */
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

/** Commits per push, and the two shares read off it. */
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
		/* Denominated on the pushes whose files are known, so an unclassifiable
		 * push neither inflates nor deflates the share. */
		docsOnlyShare:
			classified.length > 0
				? (classified.filter((p) => p.docsOnly).length / classified.length) *
					100
				: 0,
		unclassified: n - classified.length,
	};
}

/**
 * The window as single UTC days, oldest first — the unit the runs listing is
 * fetched in, and the axis the daily series is taken over.
 *
 * GitHub caps that listing at 1,000 runs however many pages are asked for, and
 * a fortnight at this repo's rate reaches it, so a single request for the whole
 * window would under-count in silence (mantahostels#676, which measured the rate).
 *
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

/** Every UTC day in the window, billed minutes each — a day with no runs is a
 *  zero, not a gap, or the mean is taken over the wrong denominator. */
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
 * The last UTC day whose billing is final: yesterday, since today is still
 * accruing. A window running past it pads `dailySeries` with zero-billed days
 * that never happened. Returns the unchanged `until` when it is already past.
 *
 * @param {string} until
 * @param {Date} [now]
 */
function clampUntil(until, now = new Date()) {
	const last = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
	return until > last ? last : until;
}

/** Days spanned by an inclusive since..until window — the denominator every
 *  projected figure divides by. */
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

/** Two-sided 95% t critical values by degrees of freedom; 1.96 beyond 30. */
const T_95 = [
	12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201,
	2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074,
	2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

/**
 * A 95% band on the mean daily billed minutes, and its 30-day projection.
 *
 * Divides by n-1, not by n as mantahostels#386 did, so it reports a wider band than mantahostels#386
 * published for the same days. Do not "correct" it back to match.
 */
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
