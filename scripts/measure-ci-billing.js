#!/usr/bin/env node

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { writeFileAtomic } = require("./lib/atomic-write.js");
const { orFallback } = require("./lib/caught.js");

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
 * @typedef {{branch: string, attempts: string, excludeEvents: string[],
 *   git: boolean, cache: string, json: boolean, refresh: boolean,
 *   "max-cache-age": string, since?: string, until?: string,
 *   maxCacheAgeMs?: number}} Args
 * @typedef {Args & {since: string, until: string,
 *   maxCacheAgeMs: number}} ParsedArgs
 * @typedef {{cache: string, refresh: boolean, maxCacheAgeMs: number}} CacheOpts
 * @typedef {import("./lib/ci-billing").Run} Run
 */

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

/** @param {Args} args */
function checkWindow(args) {
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

/** @param {string[]} events */
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
	const { flags, lists } = parse(argv, {
		usage: USAGE,
		flags: {
			"--since": "value",
			"--until": "value",
			"--branch": "value",
			"--attempts": "value",
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
	return /** @type {ParsedArgs} */ (args);
}

/** @param {any} page */
const isJudgeablePage = (page) =>
	page !== null &&
	(Array.isArray(page.workflow_runs) || Array.isArray(page.jobs));

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

/**
 * @param {CacheOpts} opts
 * @param {string} apiPath
 * @returns {Promise<{pages: any[], inFlight: boolean}>}
 */
async function cachedGet(opts, apiPath) {
	const key = apiPath.replace(/[^\w.-]+/g, "_");
	const file = path.join(opts.cache, `${key}.json`);
	const usable = !opts.refresh;
	if (usable && fs.existsSync(file)) {
		const cached = orFallback(() => {
			const age = Date.now() - fs.statSync(file).mtimeMs;
			if (age > opts.maxCacheAgeMs) return;
			const entry = JSON.parse(fs.readFileSync(file, "utf8"));
			return responseIsFinal(entry) ? entry : undefined;
		}, undefined);
		if (cached !== undefined) return { pages: cached, inFlight: false };
	}
	const parsed = await ghApiSlurpAsync([apiPath, "--cache", "0"]);
	const inFlight = !responseIsFinal(parsed);
	if (!inFlight) {
		writeFileAtomic(file, JSON.stringify(parsed), { mkdir: true });
	}
	return { pages: parsed, inFlight };
}

/**
 * @param {string} since
 * @param {string} until
 */
async function commitLog(since, until) {
	const { stdout } = await execGitAsync([
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
 * @template {import("./lib/ci-billing").ShareRow & {pct: number}} T
 * @param {string} heading
 * @param {T[]} rows
 * @param {(r: T) => string} label
 * @param {number} [minPct]
 */
function printShare(heading, rows, label, minPct = 1) {
	const { shown, tail } = foldShareRows(rows, minPct);
	writeFd(1, `\n  ${heading.padEnd(30)}  jobs  billed   share\n`);
	for (const r of shown) {
		writeFd(
			1,
			`  ${label(r).slice(0, 30).padEnd(30)}  ${String(r.jobs).padStart(4)}  ${String(r.billed).padStart(6)}  ${`${r.pct.toFixed(1)}%`.padStart(6)}\n`,
		);
	}
	if (tail) {
		writeFd(
			1,
			`  ${`other (${tail.count} under ${minPct}%)`.padEnd(30)}  ${String(tail.jobs).padStart(4)}  ${String(tail.billed).padStart(6)}  ${`${tail.pct.toFixed(1)}%`.padStart(6)}\n`,
		);
	}
}

/**
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
 * @param {CacheOpts} opts
 * @param {{branch: string, since: string, until: string}} window
 */
async function fetchRuns(opts, { branch, since, until }) {
	const branchFilter = branch === "all" ? "" : `branch=${branch}&`;
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
		totalCount: daysCounted === days.length ? totalCount : null,
		duplicates,
		truncatedDays,
		truncated: truncatedDays.length > 0,
		inFlightSkipped,
	};
}

/** @param {Run[]} runs */
const pushShasOf = (runs) => [
	...new Set(
		runs.flatMap((r) =>
			PUSH_EVENTS.has(r.event ?? "") && r.head_sha ? [r.head_sha] : [],
		),
	),
];

/**
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
 * @param {Awaited<ReturnType<typeof commitsPerPush>>["pushCommits"]} pushCommits
 * @param {string | null} gitError
 */
function printCommitsPerPush(pushCommits, gitError) {
	if (pushCommits) {
		writeFd(
			1,
			`  commits ${pushCommits.commits} over ${pushCommits.pushes} matched pushes  mean ${pushCommits.mean.toFixed(2)}/push  median ${pushCommits.median}  single-commit ${pushCommits.singleCommitShare.toFixed(0)}%  docs-only ${pushCommits.docsOnlyShare.toFixed(1)}%\n`,
		);
		if (
			pushCommits.missingHeads ||
			pushCommits.unclassified ||
			pushCommits.truncatedFirstPush
		) {
			writeFd(
				1,
				`    (${pushCommits.missingHeads} push heads not in this checkout's history, ${pushCommits.unclassified} pushes with no file list, ${pushCommits.unpushedCommits} commits after the last push head, ${pushCommits.truncatedFirstPush} first push dropped as cut by the window)\n`,
			);
		}
	} else if (gitError) {
		writeFd(1, `  ⚠ commits-per-push unavailable: ${gitError}\n`);
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const { since } = args;
	const { until, clamped } = finalWindow(since, args.until);
	if (clamped) {
		writeFd(
			1,
			`  note: --until ${args.until} clamped to ${until}; later days have not finished billing\n`,
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
	const projection =
		/** @type {NonNullable<ReturnType<typeof monthlyProjection>>} */ (
			monthlyProjection(summary, spanDays)
		);
	const band = dailyMeanBand(dailySeries(summary.perDay, since, until));

	const { pushCommits, gitError } = args.git
		? await commitsPerPush(since, until, scoped)
		: { pushCommits: null, gitError: null };

	if (args.json) {
		writeFd(
			1,
			`${JSON.stringify(
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
			)}\n`,
		);
		return;
	}

	writeFd(
		1,
		`${args.branch} ${since}..${until}  (${spanDays.toFixed(2)} days, attempts=${args.attempts}${args.excludeEvents.length > 0 ? `, minus ${args.excludeEvents.join("/")} runs` : ""})\n`,
	);
	if (truncated) {
		writeFd(
			1,
			`  ⚠ TRUNCATED: GitHub returned ${runs.length} of ${totalCount} runs — every figure below is a floor. Over the 1,000-run cap on ${truncatedDays.join(", ")}, which a day at a time should not reach; check whether that day really ran that much.\n`,
		);
	}
	if (duplicates) {
		writeFd(
			1,
			`  ⚠ ${duplicates} run(s) came back on more than one day and were counted once; the per-day windows are overlapping.\n`,
		);
	}
	if (inFlightSkipped) {
		writeFd(
			1,
			`  ⚠ ${inFlightSkipped} response(s) covered runs that had not finished, so those were not cached — the billed and actual minutes below are a floor, and a re-run will fetch them again.\n`,
		);
	}
	writeFd(
		1,
		`  runs ${summary.runs}  jobs ${summary.jobs}  actual ${summary.actual.toFixed(1)} min  billed ${summary.billed} min  ratio ${summary.ratio.toFixed(2)}x\n`,
	);
	writeFd(
		1,
		`  unfinished jobs ${summary.unfinished}  skipped jobs ${summary.skipped}\n`,
	);
	writeFd(
		1,
		`  pushes ${summary.pushes}  billed/push ${summary.billedPerPush.toFixed(2)}  pushes/day ${projection.pushesPerDay.toFixed(1)}\n`,
	);
	writeFd(
		1,
		`  projected ${projection.perMonth.toFixed(0)} billed min / 30-day month — ${projection.usedPct.toFixed(0)}% of ${projection.allowance}\n`,
	);
	if (band) {
		writeFd(
			1,
			`  95% band on the daily mean (n=${band.n} days) ${band.lo.toFixed(1)}–${band.hi.toFixed(1)} min/day — ${band.monthlyLo.toFixed(0)}–${band.monthlyHi.toFixed(0)} a month\n`,
		);
	}
	writeFd(
		1,
		`  runs with a second attempt ${summary.rerunRuns} of ${summary.runs}\n`,
	);
	printCommitsPerPush(pushCommits, gitError);

	printShare("workflow", summary.perWorkflow, (w) => w.workflow);
	printShare("job", summary.perJob, (j) => j.job);
	printShare("event", summary.perEvent, (e) => e.event, 0);
	writeFd(1, "\n  day         runs  jobs  billed  pushes\n");
	for (const d of summary.perDay) {
		writeFd(
			1,
			`  ${d.day}  ${String(d.runs).padStart(4)}  ${String(d.jobs).padStart(4)}  ${String(d.billed).padStart(6)}  ${String(d.pushes).padStart(6)}\n`,
		);
	}
}

if (require.main === module) {
	main().catch((e) => {
		if (e instanceof CliExit) process.exit(printExit(e));
		writeFd(2, `${parseErrLine(e)}\n`);
		process.exit(1);
	});
}

module.exports = { main };
