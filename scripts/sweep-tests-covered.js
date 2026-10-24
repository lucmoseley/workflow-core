#!/usr/bin/env node
/*
 * sweep-tests-covered.js — mantahostels#3502 (the ticket that stopped a sweep re-testing a
 * commit an earlier sweep had already taken green).
 *
 * WHAT IT ANSWERS: does an EARLIER run of scheduled-checks.yml on THIS head sha
 * carry a fully green `Full suite`? It writes covered=true or covered=false to
 * $GITHUB_OUTPUT; scheduled-checks.yml keys the suite job's `if:` on it.
 *
 * IT READS THE JOBS, NOT THE RUN — report-red-suite.js's rule and for its
 * reason: a sweep is three jobs, so a run conclusion goes red when `Document
 * guards` fails over a perfectly green suite.
 *
 * EVERY `Full suite` ROW MUST BE GREEN, which is where this PARTS FROM
 * report-red-suite.js. That file steps over a cancelled or skipped row, because
 * its question is "is the suite red" and a row that never judged the tree
 * cannot make it red. The question here is the stronger one — "was this tree
 * fully tested" — and a run whose Python job was cancelled did not test it. So
 * a row that is not GOOD does not cover, whatever it says. That also makes the
 * skip idempotent for free: a sweep this gate skipped carries `Full suite /
 * Lint and tests` at `skipped`, so it covers nothing and a chain of skips can
 * never root in anything but a run that really ran the tests.
 *
 * IT FAILS OPEN, ALWAYS. Every error path answers covered=false at exit 0: the
 * cost of a needless suite run is ~12 billed minutes, and the cost of a wrongly
 * skipped one is a commit nothing ever tested.
 *
 * NOT A `check-*` OR A `guard-*`: it never gates and never refuses a command.
 *
 * THE ROUTE PAST THIS GATE IS `gh workflow run ci.yml`, which calls the suite
 * directly and never reaches this file. That is what to fire when the question
 * is "run the tests again on this same tree" — and it spends the same 3-a-day
 * sweep budget (`guard-sweep-fire.sh`, mantahostels#3514).
 */

const fs = require("node:fs");

const { gh, errLine } = require("./lib/gh");

/* The workflow whose earlier runs count, spelled as the API's `workflow_id`
 * path segment takes it — the file name, not the display name. */
const WORKFLOW = "scheduled-checks.yml";

/* The job whose verdict decides. A reusable-workflow call fans this out into
 * `<job name> / <inner job>`, one row per inner job, so it is matched as a
 * PREFIX and EVERY matching row must be good. */
const SUITE_JOB = "Full suite";

/* THE GOOD CONCLUSIONS ARE LISTED, NEVER THE BAD ONES — check-ci-status.js's
 * convention: a conclusion GitHub adds later then reads as not-green and costs
 * a suite run, rather than passing as green unnoticed. */
const GOOD = new Set(["success", "neutral"]);

/* How many earlier runs on this sha are opened, and how many the listing asks
 * for — one number, because a candidate this does not open is a re-test.
 *
 * NOT A SMALLER NUMBER. The sweeps this gate has already skipped sit
 * NEWEST-FIRST in front of the green one and cover nothing by design, so on a
 * tree nobody has pushed to, the green run sinks one place per sweep. Twenty
 * covers five quiet days at this cadence. A candidate costs one cheap API read against
 * that, so the bound is set by the listing's page rather than by call budget.
 */
const MAX_CANDIDATES = 20;

/**
 * What GitHub told the job about itself.
 */
function context() {
	const { env } = process;
	return {
		repo: env.GITHUB_REPOSITORY || "",
		sha: env.GITHUB_SHA || "",
		runId: String(env.GITHUB_RUN_ID || ""),
		output: env.GITHUB_OUTPUT || "",
	};
}

/**
 * Parsed `gh api <path>`, or null where the call failed or the answer was not
 * an object. Never throws — every caller here fails open.
 *
 * `any` because the two endpoints share nothing: each caller names the one
 * field it wants and shape-checks it there.
 * @param {string} apiPath
 * @returns {any}
 */
function api(apiPath) {
	try {
		const parsed = JSON.parse(gh(["api", apiPath]));
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch (e) {
		process.stdout.write(`  could not read ${apiPath}: ${errLine(e)}\n`);
		return null;
	}
}

/**
 * Whether one earlier run's `Full suite` covers this tree.
 *
 * False where the run carries no matching row at all: a sweep with no suite in
 * it tested nothing.
 *
 * @param {string} repo
 * @param {number|string} runId
 * @returns {boolean}
 */
function suiteCovers(repo, runId) {
	/* per_page=100 against a sweep's four jobs: one page. */
	const body = api(`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`);
	/** @type {{name?: string, conclusion?: string|null}[]|null} */
	const jobs = Array.isArray(body?.jobs) ? body.jobs : null;
	if (!jobs) return false;
	const suite = jobs.filter((j) => String(j?.name || "").startsWith(SUITE_JOB));
	return suite.length > 0 && suite.every((j) => GOOD.has(String(j.conclusion)));
}

/**
 * The id of an earlier sweep on this sha whose suite covers it, or null.
 *
 * @param {ReturnType<typeof context>} ctx
 * @returns {number|null}
 */
function coveringRun(ctx) {
	const body = api(
		`repos/${ctx.repo}/actions/workflows/${WORKFLOW}/runs` +
			`?head_sha=${encodeURIComponent(ctx.sha)}&status=completed` +
			`&per_page=${MAX_CANDIDATES}`,
	);
	/** @type {{id?: number}[]|null} */
	const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : null;
	if (!runs) return null;
	/* This run itself is excluded by id, not by status: it is `in_progress`
	 * while this gate executes, and `status=completed` above already drops it —
	 * but only for as long as that filter keeps working. */
	const candidates = runs
		.flatMap((r) => (typeof r?.id === "number" ? [r.id] : []))
		.filter((id) => String(id) !== ctx.runId)
		.slice(0, MAX_CANDIDATES);
	for (const id of candidates) if (suiteCovers(ctx.repo, id)) return id;
	return null;
}

/**
 * @param {string} outputPath
 * @param {boolean} covered
 */
function emit(outputPath, covered) {
	process.stdout.write(`covered=${covered}\n`);
	if (!outputPath) return;
	try {
		fs.appendFileSync(outputPath, `covered=${covered}\n`);
	} catch (e) {
		/* An unwritable $GITHUB_OUTPUT leaves the suite job reading an empty
		 * output and running, which is the fail-open answer already. */
		process.stdout.write(`  could not write the output: ${errLine(e)}\n`);
	}
}

function main() {
	const ctx = context();
	if (!ctx.repo || !ctx.sha) {
		process.stdout.write(
			"GITHUB_REPOSITORY or GITHUB_SHA is unset — testing this tree.\n",
		);
		emit(ctx.output, false);
		return;
	}
	const covering = coveringRun(ctx);
	process.stdout.write(
		covering
			? `${ctx.sha.slice(0, 7)} was already taken green by run ${covering} — skipping the suite.\n`
			: `No earlier sweep has a green suite on ${ctx.sha.slice(0, 7)} — testing it.\n`,
	);
	emit(ctx.output, Boolean(covering));
}

if (require.main === module) main();
