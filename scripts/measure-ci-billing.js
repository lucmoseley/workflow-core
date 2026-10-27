#!/usr/bin/env node
/*
 * measure-ci-billing.js — what a window of pushes cost in GitHub Actions
 * minutes, by the method settled at mantahostels#313.
 *
 * Usage:
 *   node scripts/measure-ci-billing.js --since 2026-08-01 --until 2026-08-14
 *        [--branch all|main] [--attempts latest|all] [--exclude-event <event>]
 *        [--cache <dir>] [--refresh] [--max-cache-age <days>] [--no-git] [--json]
 *
 * The scope that reproduces the recorded mantahostels#313 census, and the one the 28 August
 * fortnight re-measure should use:
 *   --branch all --exclude-event pull_request
 *
 * Why it exists (mantahostels#386): .github/workflows/scheduled-checks.yml's figures were measured twice by hand and the two
 * censuses disagree. This one caches every raw API response whose runs had
 * finished, so a re-run compares method against method rather than fetch
 * against fetch.
 *
 * --attempts is the knob that matters. GitHub's jobs endpoint defaults to
 * `filter=latest`, which hides the jobs of every superseded re-run attempt —
 * minutes that were billed and are simply not in the response.
 *
 * --branch is the OTHER knob.
 * The invoice covers every branch; `--branch main` prices only one, so it
 * under-reports the bill. `--branch all` is the like-for-like scope, and since
 * mantahostels#677 it is the default.
 *
 * `pull_request` runs are NOT excluded by default, deliberately (mantahostels#677): they
 * are billed, so a billing tool that hid them would understate the invoice.
 * They are reported as their own row in the event split.
 *
 * REPORTS ONLY.
 */

const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./lib/atomic-write.js");

const { ghApiSlurpAsync, parseErrLine } = require("./lib/gh");
const { CliExit, flagValue, parse, printExit } = require("./lib/cli-args");
const { requireKey } = require("./lib/workflow-core-config");
const { execGitAsync } = require("./lib/git.js");
const {
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
} = require("./lib/ci-billing");

/**
 * The parsed command line, and the cache options threaded through every fetch.
 *
 * @typedef {{branch: string, attempts: string, excludeEvents: string[],
 *   git: boolean, cache: string, json: boolean, refresh: boolean,
 *   "max-cache-age": string, since?: string, until?: string,
 *   maxCacheAgeMs?: number}} Args
 * @typedef {Args & {since: string, until: string,
 *   maxCacheAgeMs: number}} ParsedArgs
 * @typedef {{cache: string, refresh: boolean, maxCacheAgeMs: number}} CacheOpts
 * @typedef {import("./lib/ci-billing").Run} Run
 */

/* The config's `codeRepo`, where the runs are, read at the first request
 * rather than at load. */
/** @type {string | undefined} */
let codeRepoCache;
const codeRepo = () => {
	codeRepoCache ??= requireKey("codeRepo");
	return codeRepoCache;
};
const ATTEMPTS = ["latest", "all"];
const DEFAULT_MAX_CACHE_AGE_DAYS = 7;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const USAGE = `usage: node scripts/measure-ci-billing.js --since <YYYY-MM-DD> --until <YYYY-MM-DD>
       [--branch all|main] [--attempts latest|all] [--exclude-event <event>]...
       [--cache <dir>] [--refresh] [--max-cache-age <days>] [--no-git] [--json]`;

/**
 * Throws unless `--since` and `--until` are both real `YYYY-MM-DD` days, in
 * order.
 * @param {Args} args
 */
function checkWindow(args) {
	/* Validated rather than trusted: an unpadded or reversed date silently
	 * yields a NaN span, and a NaN span makes every projected figure NaN —
	 * a wrong answer printed with the confidence of a right one. */
	for (const key of /** @type {const} */ (["since", "until"])) {
		if (!args[key]) throw new Error(`--${key} is required (YYYY-MM-DD, UTC)`);
		if (!ISO_DAY.test(args[key])) {
			throw new Error(`--${key} must be YYYY-MM-DD, got "${args[key]}"`);
		}
		if (Number.isNaN(Date.parse(`${args[key]}T00:00:00Z`))) {
			throw new Error(`--${key} is not a real date: "${args[key]}"`);
		}
	}
	const { since, until } = /** @type {{since: string, until: string}} */ (args);
	if (since > until) {
		throw new Error(`--since ${since} is after --until ${until}`);
	}
}

/**
 * Throws on an `--exclude-event` that is empty or is itself a flag.
 * @param {string[]} events
 */
function checkExcludeEvents(events) {
	for (const event of events) {
		if (!event || event.startsWith("--")) {
			throw new Error("--exclude-event needs an event name, e.g. pull_request");
		}
	}
}

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
function parseArgs(argv) {
	/* lib/cli-args.js refuses a value that is itself a declared flag —
	 * swallowing one would price a scope nobody asked for — by throwing a
	 * CliExit, which main prints. */
	const { flags, lists } = parse(argv, {
		usage: USAGE,
		flags: {
			"--since": "value",
			"--until": "value",
			"--branch": "value",
			"--attempts": "value",
			// Repeatable rather than comma-separated: one flag per event keeps a
			// typo from silently excluding nothing and printing a
			// differently-scoped census under the same command line.
			"--exclude-event": "list",
			"--cache": "value",
			"--refresh": "boolean",
			"--max-cache-age": "value",
			"--no-git": "boolean",
			"--json": "boolean",
		},
	});
	/** @type {Args} */
	const args = {
		branch: flagValue(flags, "--branch") ?? "all",
		attempts: flagValue(flags, "--attempts") ?? "latest",
		excludeEvents: lists["--exclude-event"] ?? [],
		git: flags["--no-git"] !== true,
		cache:
			flagValue(flags, "--cache") ??
			path.join(process.env.CLAUDE_JOB_DIR || "/tmp", "ci-billing-cache"),
		json: flags["--json"] === true,
		refresh: flags["--refresh"] === true,
		"max-cache-age":
			flagValue(flags, "--max-cache-age") ?? String(DEFAULT_MAX_CACHE_AGE_DAYS),
		since: flagValue(flags, "--since"),
		until: flagValue(flags, "--until"),
	};
	checkWindow(args);
	if (!ATTEMPTS.includes(args.attempts)) {
		throw new Error(
			`--attempts must be one of ${ATTEMPTS.join("|")}, got "${args.attempts}"`,
		);
	}
	const maxAge = Number(args["max-cache-age"]);
	if (!Number.isFinite(maxAge) || maxAge < 0) {
		throw new Error(
			`--max-cache-age must be a non-negative number of days, got "${args["max-cache-age"]}"`,
		);
	}
	checkExcludeEvents(args.excludeEvents);
	args.maxCacheAgeMs = maxAge * 86_400_000;
	/* Every field `ParsedArgs` promises over `Args` was validated above: the two
	 * dates by the ISO loop, the cache age by the finite check, and all three
	 * throw rather than fall through. */
	return /** @type {ParsedArgs} */ (args);
}

/** A page this predicate can actually judge: one carrying the run or job list
 *  it reads finality from. */
/** @param {any} page */
const isJudgeablePage = (page) =>
	page !== null &&
	(Array.isArray(page.workflow_runs) || Array.isArray(page.jobs));

/**
 * Whether everything a response describes has finished running.
 *
 * An in-flight run's jobs carry no `completed_at`, so `summarise` counts them
 * `unfinished` and the minutes it reports are a floor. Caching that answer
 * freezes the floor and hands it back to every census inside --max-cache-age
 * as if it were final.
 *
 * The --until clamp keeps today out of the window, so this is not about the
 * window's end date: what it catches is a run STARTED on an earlier day that
 * was still going when the census ran. Judging the response rather than the
 * window also keeps the rest of the cache — one in-flight run costs a refetch
 * of its own day and its own jobs call, not of the fortnight.
 *
 * Fails closed on anything it cannot judge — an error body, an empty slurp.
 *
 * It does not catch every job `summarise` calls unfinished: a job reading
 * `completed` with an unparseable timestamp counts there too, and its response
 * is final by this test. That one is a bad payload, not a race.
 */
/** @param {any[]} pages */
const responseIsFinal = (pages) =>
	pages.length > 0 &&
	pages.every(
		(page) =>
			isJudgeablePage(page) &&
			[...(page.workflow_runs || []), ...(page.jobs || [])].every(
				(item) => item.status === "completed",
			),
	);

/** One cached GET. The cache key is the path, so a window re-measured with a
 *  different --attempts refetches only the jobs calls. */
/**
 * @param {CacheOpts} opts
 * @param {string} apiPath
 * @returns {Promise<{pages: any[], inFlight: boolean}>} `pages` holds one
 *   entry per `--slurp` page, as GitHub's REST bodies stand — a runs listing
 *   and a jobs listing carry different fields, and each caller reads its own.
 *   `inFlight` is true where the response covered unfinished runs and so was
 *   not cached.
 */
async function cachedGet(opts, apiPath) {
	const key = apiPath.replace(/[^\w.-]+/g, "_");
	const file = path.join(opts.cache, `${key}.json`);
	const usable = !opts.refresh;
	if (usable && fs.existsSync(file)) {
		try {
			const age = Date.now() - fs.statSync(file).mtimeMs;
			if (age <= opts.maxCacheAgeMs) {
				const entry = JSON.parse(fs.readFileSync(file, "utf8"));
				/* Read-side too, not just write-side: entries written before this
				 * guard existed hold partial answers and stay servable for
				 * --max-cache-age days. */
				if (responseIsFinal(entry)) return { pages: entry, inFlight: false };
			}
		} catch {
			/* A truncated or unreadable entry is refetched, never fatal — the
			 * cache is an optimisation. */
		}
	}
	const parsed = await ghApiSlurpAsync([apiPath, "--cache", "0"]);
	const inFlight = !responseIsFinal(parsed);
	if (!inFlight) {
		/* Atomic: a kill mid-write leaves the old entry or none, never a
		 * half-written one. */
		writeFileAtomic(file, JSON.stringify(parsed), { mkdir: true });
	}
	return { pages: parsed, inFlight };
}

/**
 * The window's commits, oldest first, each with the paths it touched. Actions
 * knows a run's head commit and nothing about how many commits arrived with it,
 * so commits-per-push and the docs-only share can only come from git.
 *
 * Reads THIS CHECKOUT's history, so a push on a branch it does not have shows
 * up as a missing head rather than a wrong count.
 *
 * @param {string} since
 * @param {string} until
 */
async function commitLog(since, until) {
	const { stdout } = await execGitAsync([
		/* Without this a non-ASCII path arrives quoted and escaped, so the
		 * `.md` test fails and the push reads as code. */
		"-c",
		"core.quotePath=false",
		"log",
		"--reverse",
		"--pretty=format:%x00%H",
		"--name-only",
		`--since=${since}T00:00:00Z`,
		`--until=${until}T23:59:59Z`,
		"HEAD",
	]);
	return parseCommitLog(stdout);
}

/**
 * A billed-share table, tail-folded at `minPct` so single-run Dependabot
 * workflows do not bury the rows the census is read from. `minPct: 0` folds
 * nothing.
 *
 * @template {import("./lib/ci-billing").ShareRow & {pct: number}} T
 * @param {string} heading
 * @param {T[]} rows
 * @param {(r: T) => string} label
 * @param {number} [minPct] the share below which a row is folded; 1% is a
 *   guess, never measured
 */
function printShare(heading, rows, label, minPct = 1) {
	const { shown, tail } = foldShareRows(rows, minPct);
	console.log(`\n  ${heading.padEnd(30)}  jobs  billed   share`);
	for (const r of shown) {
		console.log(
			`  ${label(r).slice(0, 30).padEnd(30)}  ${String(r.jobs).padStart(4)}  ${String(r.billed).padStart(6)}  ${`${r.pct.toFixed(1)}%`.padStart(6)}`,
		);
	}
	if (tail) {
		console.log(
			`  ${`other (${tail.count} under ${minPct}%)`.padEnd(30)}  ${String(tail.jobs).padStart(4)}  ${String(tail.billed).padStart(6)}  ${`${tail.pct.toFixed(1)}%`.padStart(6)}`,
		);
	}
}

/**
 * The window that can actually be measured today.
 *
 * Today is still accruing minutes, so a window reaching it would average the
 * daily rate over days that had not finished — deflating both the projection
 * and its band. Clamping can empty the window outright, which asking for today
 * alone does: that holds no finished day, so it would fetch nothing and print a
 * confident census of zero.
 *
 * @param {string} since
 * @param {string} until
 */
function finalWindow(since, until) {
	const clamped = clampUntil(until);
	if (clamped < since) {
		throw new Error(
			`--since ${since} is after ${clamped}, the last day whose billing is final — today is still accruing minutes`,
		);
	}
	return { until: clamped, clamped: clamped !== until };
}

/**
 * Every run in the window, fetched one UTC day at a time and concatenated.
 *
 * A single `created=since..until` request is capped at 1,000 runs, which a
 * fortnight at this repo's rate reaches (mantahostels#676, and `dayWindows` for the
 * arithmetic). Per-day requests stay far below it, and each day is its own
 * cache key.
 *
 * A day is still reported truncated if it alone exceeds the cap.
 *
 * @param {CacheOpts} opts
 * @param {{branch: string, since: string, until: string}} window
 */
async function fetchRuns(opts, { branch, since, until }) {
	const branchFilter = branch === "all" ? "" : `branch=${branch}&`;
	/* Keyed by run id rather than concatenated: one request could not return a
	 * run twice, but fourteen can, and a double-counted run inflates the billed
	 * minutes with nothing to show it did (mantahostels#676). Insertion order is day
	 * order, which the concatenation test asserts.
	 *
	 * The UTC day split is exact — checked against a single whole-window
	 * request, mantahostels#676 carrying the figures — so this counter is insurance against
	 * that behaviour changing rather than a defect being worked around: a
	 * non-zero `duplicates` is news, not routine. */
	/** @type {Map<Run["id"], Run>} */
	const byId = new Map();
	let duplicates = 0;
	let totalCount = 0;
	let daysCounted = 0;
	let inFlightSkipped = 0;
	/** @type {string[]} */
	const truncatedDays = [];
	const days = dayWindows(since, until);
	for (const day of days) {
		const { pages, inFlight } = await cachedGet(
			opts,
			`repos/${codeRepo()}/actions/runs?${branchFilter}per_page=100&created=${day}..${day}`,
		);
		if (inFlight) inFlightSkipped += 1;
		/* --slurp gives one object per page, each with its own workflow_runs. */
		/** @type {Run[]} */
		const dayRuns = pages.flatMap(
			(/** @type {any} */ p) => p.workflow_runs || [],
		);
		const dayTotal = pages[0]?.total_count;
		if (Number.isFinite(dayTotal)) {
			totalCount += dayTotal;
			daysCounted += 1;
			if (dayRuns.length < dayTotal) truncatedDays.push(day);
		}
		for (const run of dayRuns) {
			if (byId.has(run.id)) duplicates += 1;
			byId.set(run.id, run);
		}
	}
	return {
		runs: [...byId.values()],
		/* Null unless EVERY day reported a count. A total summed over some days
		 * and compared against runs from all of them reads as a truncation that
		 * did not happen — or hides one that did. */
		totalCount: daysCounted === days.length ? totalCount : null,
		duplicates,
		truncatedDays,
		truncated: truncatedDays.length > 0,
		inFlightSkipped,
	};
}

/** The push head shas a scoped run set implies. */
/** @param {Run[]} runs */
const pushShasOf = (runs) => [
	...new Set(
		runs.flatMap((r) =>
			PUSH_EVENTS.has(r.event ?? "") && r.head_sha ? [r.head_sha] : [],
		),
	),
];

/**
 * Commits per push over the window, from this checkout's history; a failed
 * `git log` comes back as `gitError` rather than throwing.
 * @param {string} since
 * @param {string} until
 * @param {Run[]} scoped
 */
async function commitsPerPush(since, until, scoped) {
	try {
		const folded = foldPushes(
			await commitLog(since, until),
			pushShasOf(scoped),
		);
		/* The window's first push carries commits made before `since`, which
		 * the log does not reach, so its count is a floor rather than a
		 * measurement. Widening the log does not help: those earlier commits
		 * belong to pushes before the window whose heads are not in scope, so
		 * they would all pile onto this one push instead. */
		const measurable = folded.pushes.slice(1);
		return {
			pushCommits: {
				...pushCommitStats(measurable),
				truncatedFirstPush: folded.pushes.length - measurable.length,
				unpushedCommits: folded.unpushedCommits,
				missingHeads: folded.missingHeads.length,
			},
			gitError: null,
		};
	} catch (e) {
		return { pushCommits: null, gitError: parseErrLine(e) };
	}
}

/**
 * The commits-per-push lines, or why there are none.
 * @param {Awaited<ReturnType<typeof commitsPerPush>>["pushCommits"]} pushCommits
 * @param {string | null} gitError
 */
function printCommitsPerPush(pushCommits, gitError) {
	if (pushCommits) {
		console.log(
			`  commits ${pushCommits.commits} over ${pushCommits.pushes} matched pushes  mean ${pushCommits.mean.toFixed(2)}/push  median ${pushCommits.median}  single-commit ${pushCommits.singleCommitShare.toFixed(0)}%  docs-only ${pushCommits.docsOnlyShare.toFixed(1)}%`,
		);
		if (
			pushCommits.missingHeads ||
			pushCommits.unclassified ||
			pushCommits.truncatedFirstPush
		) {
			console.log(
				`    (${pushCommits.missingHeads} push heads not in this checkout's history, ${pushCommits.unclassified} pushes with no file list, ${pushCommits.unpushedCommits} commits after the last push head, ${pushCommits.truncatedFirstPush} first push dropped as cut by the window)`,
			);
		}
	} else if (gitError) {
		console.log(`  ⚠ commits-per-push unavailable: ${gitError}`);
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const { since } = args;
	const { until, clamped } = finalWindow(since, args.until);
	if (clamped) {
		console.log(
			`  note: --until ${args.until} clamped to ${until}; later days have not finished billing`,
		);
	}
	/** @type {CacheOpts} */
	const opts = {
		cache: args.cache,
		refresh: args.refresh,
		maxCacheAgeMs: args.maxCacheAgeMs,
	};

	const fetched = await fetchRuns(opts, {
		branch: args.branch,
		since,
		until,
	});
	const { runs, totalCount, truncated, truncatedDays, duplicates } = fetched;
	let { inFlightSkipped } = fetched;

	/* Each jobs response is cached under its own run id, so a later census at a
	 * wider scope refetches only the runs this one skipped. */
	const scoped = filterRuns(runs, args.excludeEvents);

	/** @type {Map<Run["id"], any[]>} */
	const jobsByRun = new Map();
	for (const run of scoped) {
		const { pages: jobs, inFlight } = await cachedGet(
			opts,
			`repos/${codeRepo()}/actions/runs/${run.id}/jobs?filter=${args.attempts}&per_page=100`,
		);
		if (inFlight) inFlightSkipped += 1;
		jobsByRun.set(
			run.id,
			jobs.flatMap((/** @type {any} */ p) => p.jobs || []),
		);
	}

	const summary = summarise(scoped, (run) => jobsByRun.get(run.id) || []);
	const spanDays = windowSpanDays(since, until);
	/* `finalWindow` above refuses a window whose end precedes its start, so the
	 * span is at least one day and the projection is never null. */
	const projection =
		/** @type {NonNullable<ReturnType<typeof monthlyProjection>>} */ (
			monthlyProjection(summary, spanDays)
		);
	const band = dailyMeanBand(dailySeries(summary.perDay, since, until));

	const { pushCommits, gitError } = args.git
		? await commitsPerPush(since, until, scoped)
		: { pushCommits: null, gitError: null };

	if (args.json) {
		console.log(
			JSON.stringify(
				{
					args,
					spanDays,
					truncated,
					truncatedDays,
					totalCount,
					duplicates,
					inFlightSkipped,
					summary,
					projection,
					band,
					pushCommits,
					gitError,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(
		`${args.branch} ${since}..${until}  (${spanDays.toFixed(2)} days, attempts=${args.attempts}${args.excludeEvents.length > 0 ? `, minus ${args.excludeEvents.join("/")} runs` : ""})`,
	);
	if (truncated) {
		console.log(
			`  ⚠ TRUNCATED: GitHub returned ${runs.length} of ${totalCount} runs — every figure below is a floor. Over the 1,000-run cap on ${truncatedDays.join(", ")}, which a day at a time should not reach; check whether that day really ran that much.`,
		);
	}
	if (duplicates) {
		console.log(
			`  ⚠ ${duplicates} run(s) came back on more than one day and were counted once; the per-day windows are overlapping.`,
		);
	}
	if (inFlightSkipped) {
		console.log(
			`  ⚠ ${inFlightSkipped} response(s) covered runs that had not finished, so those were not cached — the billed and actual minutes below are a floor, and a re-run will fetch them again.`,
		);
	}
	console.log(
		`  runs ${summary.runs}  jobs ${summary.jobs}  actual ${summary.actual.toFixed(1)} min  billed ${summary.billed} min  ratio ${summary.ratio.toFixed(2)}x`,
	);
	console.log(
		`  unfinished jobs ${summary.unfinished}  skipped jobs ${summary.skipped}`,
	);
	console.log(
		`  pushes ${summary.pushes}  billed/push ${summary.billedPerPush.toFixed(2)}  pushes/day ${projection.pushesPerDay.toFixed(1)}`,
	);
	console.log(
		`  projected ${projection.perMonth.toFixed(0)} billed min / 30-day month — ${projection.usedPct.toFixed(0)}% of ${projection.allowance}`,
	);
	if (band) {
		console.log(
			`  95% band on the daily mean (n=${band.n} days) ${band.lo.toFixed(1)}–${band.hi.toFixed(1)} min/day — ${band.monthlyLo.toFixed(0)}–${band.monthlyHi.toFixed(0)} a month`,
		);
	}
	console.log(
		`  runs with a second attempt ${summary.rerunRuns} of ${summary.runs}`,
	);
	printCommitsPerPush(pushCommits, gitError);

	printShare("workflow", summary.perWorkflow, (w) => w.workflow);
	/* The split mantahostels#386 argued path-filtering from: a path filter skips jobs, so
	 * the workflow rollup above cannot price one. */
	printShare("job", summary.perJob, (j) => j.job);
	/* Unfolded: `pull_request` is the row a reader comparing against the mantahostels#313
	 * census has to see, and it can be well under the 1% the other tables fold
	 * away (mantahostels#677). */
	printShare("event", summary.perEvent, (e) => e.event, 0);
	console.log("\n  day         runs  jobs  billed  pushes");
	for (const d of summary.perDay) {
		console.log(
			`  ${d.day}  ${String(d.runs).padStart(4)}  ${String(d.jobs).padStart(4)}  ${String(d.billed).padStart(6)}  ${String(d.pushes).padStart(6)}`,
		);
	}
}

if (require.main === module) {
	main().catch((e) => {
		if (e instanceof CliExit) process.exit(printExit(e));
		/* parseErrLine, not e.message: execFile puts the whole argv in the message,
		 * so a token in the command line would be echoed to the terminal. */
		console.error(parseErrLine(e));
		process.exit(1);
	});
}

module.exports = { main };
