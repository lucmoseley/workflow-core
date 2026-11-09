/*
 * actions-tester.js — the queue lander's Actions tester. It reads the suite
 * workflow's run that a push to a lander ref started at the exact sha,
 * through `gh` with the read access the token already has.
 *
 * Green only on a finished, successful run whose every Vitest shard job and
 * whose `Suite passed` job passed, naming the run and the files its in-job
 * retry cleared, the batch's flakes (#4558); red on a failed one, with
 * its failing jobs and the test files their logs name. A push run that
 * never appears is a red naming no file, marked `noRun`: the tree fires no
 * run on the ref (#4571). A run in progress at the wait bound, ended any
 * other way, or that cannot be read is no verdict, never green.
 *
 * A failed run where a job failed at a step that only readies the runner
 * (`RUNNER_STEPS`) is neither: its tests ran without their tools. Its failed
 * jobs are rerun, up to `RUNNER_RERUNS` times, and the last attempt still
 * failing so is no verdict, never a red to isolate.
 *
 * `queueTester`'s whole suite is the push run at the sha, read as above, on
 * the `lander/iso-suite-<k>` ref holding it, else on the `lander/batch-<k>`
 * one. Asked again, a failed run has its failed jobs rerun; any other run at
 * the sha, or a failed one GitHub refuses to retry, is never read, its ref
 * deleted and created again so a run starts after the ask (#4524, #4823). Where none at the sha is listed, as when its ref was
 * pushed while Actions fired nothing, the ref is pushed again once before
 * the tree is read as firing none (#4572). Named files at a sha a
 * `lander/iso-*` ref holds, an isolation commit or `main` pushed for its base
 * check, are run alone by named-rerun.yml. At any other sha a
 * `lander/batch-<k>` run covers they are read off that run, a failed one
 * rerunning its failed jobs; elsewhere they go to named-rerun.yml too, under
 * its daily cap. Its `cancel` cancels every unfinished run on a batch ref
 * but the one at the sha the lander is about to test, naming every sha the
 * ref lists a run at (#4556, #4576).
 */

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const { SHORT_SHA, gitBinary, gitSpawnOptions } = require("./git.js");
const { createRemoteRef, deleteRemoteRef } = require("./lander-git.js");
const { gh, ghJson } = require("./gh.js");
const { parseErrorText } = require("./caught.js");
const { isNetworkFault } = require("./network-fault.js");
const { parseFailingFiles, parseFailingTests } = require("./local-tester.js");
const { readJsonl } = require("./jsonl.js");
const { SUITE_WORKFLOW } = require("./suite-timings.js");
const { CLEARED, STILL_FAILING } = require("../retry-failed-files.js");
const {
	LANDER_BATCH_PREFIX,
	LANDER_ISO_PREFIX,
	LANDER_PREFIX,
	LANDER_ISO_SUITE_PREFIX,
	REMOTE,
	VERIFIED_BRANCH,
} = require("./landing-refs.js");
const { markersDir } = require("./marker-root.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");
const { writeFd } = require("./write-fd.js");

/** @typedef {import("./queue-lander.js").Verdict} Verdict */
/** @typedef {import("./queue-lander.js").QueueTester} QueueTester */

/* ci.yml's matrix names each shard job `Vitest (k/n)`. */
const SHARD_JOB = /\bVitest \((\d+)\/(\d+)\)$/;
/* The aggregate job #2414's ruleset on `main` requires. */
const SUITE_PASSED_JOB = "Suite passed";
/* Untraced: GitHub lists a push run within seconds; the rest is room for a
 * slow queue. Past it a run never listed is a red that can drop a member
 * (#4571), so it decides a drop, not only a wait. */
const APPEAR_MS = 3 * 60 * 1000;
/* Untraced: a sharded run is held under 3 min once its jobs start (#2413);
 * the rest is room for runners to queue. */
const RUN_BOUND_MS = 30 * 60 * 1000;
/* Untraced: a twelfth of a 3 min run, at four `gh` reads a minute. */
const POLL_MS = 15 * 1000;
/* Untraced: GitHub's newest push runs on a lander ref, deep enough to reach a
 * batch tip a few later pushes have buried. */
const RUN_LIST_LIMIT = 50;
const NAMED_WORKFLOW = "named-rerun.yml";
/* `gh run rerun`'s refusal of a run GitHub will not retry. */
const NOT_RETRIABLE = /cannot be retried/;
const NAMED_JOB = "Named files";
/* Untraced: a runaway's stop, minutes being free on the public repo (#1930). */
const NAMED_DAILY_CAP = 12;
/* Untraced: a month, far past the UTC day the cap reads. */
const NAMED_RECORD = ".lander-named-runs.jsonl";
const NAMED_RECORD_RETAIN_MS = 30 * DAY_MS;
/* Untraced: as RUN_LIST_LIMIT, deep enough for dispatches a cap of 12 a day
 * can bury a run under. */
const NAMED_RUN_LIST_LIMIT = 50;
/* The steps that ready a runner and judge no code. Every later step runs
 * under `!cancelled()`, so a download outage at one still runs the tests, on
 * a runner missing its tools. "Install dependencies" is not one: a broken
 * lockfile is the code's fault. */
const RUNNER_STEPS = new Set([
	"Set up job",
	"Run actions/checkout@v4",
	"Run actions/setup-node@v4",
	"Install test tools",
	"Full history",
]);
/* ci.yml's step re-running a lander batch's failed files once, and the lines
 * it ends on naming those it cleared and those still failing
 * (retry-failed-files.js, #4545). */
const RETRY_STEP = "Retry failed files";
/* New attempts of a run whose runner failed to ready, before no verdict. A
 * first guess, and stated as one. */
const RUNNER_RERUNS = 2;

/**
 * @typedef {{databaseId: number, headSha: string, attempt: number,
 *   conclusion: string|null}} Run a `gh run list` row
 * @typedef {{name: string, conclusion: string|null, databaseId?: number,
 *   steps?: {name: string, conclusion: string|null}[]}} Job
 * @typedef {object} Reads
 * @property {() => Run[]} runs the push runs on the tested branch
 * @property {(run: number) => Job[]} jobsOf
 * @property {(run: number) => string} failedLogOf `gh run view --log-failed`
 * @property {(job: number) => string} jobLogOf `gh run view --job <id> --log`
 * @property {(sha: string, files: string[]) => string[]} presentAt those of
 *   `files` the tree at `sha` holds
 * @property {(run: number) => void} rerun starts a new attempt of the run's
 *   failed jobs
 * @property {(to: string, sha: string) => boolean} repush deletes the
 *   remote's branch `to` where it holds `sha` or is gone, then creates it
 *   at `sha`; false where it moved
 * @typedef {Verdict | {kind: "pending", run: number|null}} RunVerdict
 * @typedef {RunVerdict
 *   | {kind: "runner", run: number, attempt: number, reason: string}} SuiteRunVerdict
 * @typedef {{databaseId: number, displayTitle: string,
 *   conclusion: string|null}} NamedRun
 * @typedef {Pick<Reads, "jobsOf" | "failedLogOf" | "presentAt"> & {
 *   namedRuns: () => NamedRun[],
 *   dispatch: (inputs: {sha: string, files: string[], nonce: string}) => void,
 * }} NamedReads
 * @typedef {Omit<Reads, "runs"> & Pick<NamedReads, "namedRuns" | "dispatch">
 *   & {
 *   landerRefs: () => {branch: string, sha: string}[],
 *   runsOn: (branch: string) => Run[],
 *   cancel: (run: number) => void,
 * }} QueueReads `landerRefs` the remote's `lander/*` refs and their heads;
 *   `runsOn` the push runs on `branch`
 */

/**
 * @param {string} sha
 * @param {readonly Run[]} runs
 * @returns {Run|undefined}
 */
const newestRun = (sha, runs) =>
	runs
		.filter((r) => r.headSha === sha)
		.sort((a, b) => b.databaseId - a.databaseId)[0];

/**
 * Whether a job still runs under a run GitHub has concluded, whatever the
 * conclusion: one lists `in_progress`, no conclusion, after the run reads
 * `success` (#4347), and a failed run's log is then partial too.
 * @param {readonly Job[]} jobs
 */
const isUnconcluded = (jobs) => jobs.some((j) => !j.conclusion);

/**
 * Why a successful run's jobs do not show every shard and `Suite passed`
 * passed, or null where they do.
 * @param {Job[]} jobs
 * @returns {string|null}
 */
function greenGap(jobs) {
	const suite = jobs.find((j) => j.name === SUITE_PASSED_JOB);
	if (suite?.conclusion !== "success")
		return `its ${SUITE_PASSED_JOB} job is ${suite?.conclusion ?? "missing"}`;
	/** @type {Map<number, string|null>} */
	const passed = new Map();
	let count = 0;
	for (const j of jobs) {
		const m = j.name.match(SHARD_JOB);
		if (!m) continue;
		passed.set(Number(m[1]), j.conclusion);
		count = Number(m[2]);
	}
	if (count === 0) return "it lists no Vitest shard job";
	for (let k = 1; k <= count; k++)
		if (passed.get(k) !== "success")
			return `its Vitest shard ${k}/${count} is ${passed.get(k) ?? "missing"}`;
	return null;
}

/**
 * The verdict of the newest listed run at `sha`, reading its jobs and failed
 * logs only once it has finished.
 * @param {string} sha
 * @param {Reads} reads
 * @param {number} after
 * @returns {SuiteRunVerdict}
 */
function runVerdict(sha, reads, after) {
	const run = newestRun(sha, reads.runs());
	if (run === undefined) return { kind: "pending", run: null };
	/* A run has finished when it has a conclusion, never when `status` says
	 * so (ci-verdict.js). */
	if (run.attempt <= after || !run.conclusion)
		return { kind: "pending", run: run.databaseId };
	const id = run.databaseId;
	const jobs = reads.jobsOf(id);
	if (isUnconcluded(jobs)) return { kind: "pending", run: id };
	if (run.conclusion === "success") {
		/* GitHub concludes `success` over jobs that all skipped. */
		const gap = greenGap(jobs);
		if (gap !== null)
			return { kind: "unknown", reason: `run ${id} passed, but ${gap}` };
		const cleared = readCleared(sha, jobs, reads);
		return {
			kind: "green",
			run: id,
			...(cleared.length > 0 ? { cleared } : {}),
		};
	}
	if (run.conclusion !== "failure")
		return { kind: "unknown", reason: `run ${id} ended ${run.conclusion}` };
	const failed = jobs.filter((j) => j.conclusion === "failure");
	const fault = runnerFault(failed);
	if (fault !== null)
		return {
			kind: "runner",
			run: id,
			attempt: run.attempt,
			reason: `run ${id}'s ${fault}, which judges no code`,
		};
	const names = failed.map((j) => j.name);
	/* Every failed job red again at its in-job retry: the lander's own
	 * re-run would only repeat it, and the files are the retry's alone, the
	 * first run's failures it cleared dropped (#4545). A red naming no file
	 * re-ran nothing there, so the lander's whole-suite re-run stays.
	 * `Suite passed` fails beside any red shard and holds no retry step. */
	const shards = failed.filter((j) => j.name !== SUITE_PASSED_JOB);
	const atRetry =
		shards.length > 0 &&
		shards.every((j) =>
			(j.steps ?? []).some(
				(s) => s.conclusion === "failure" && s.name === RETRY_STEP,
			),
		);
	const read = readFailed(sha, id, reads, atRetry);
	const retried = atRetry && read.files.length > 0;
	return {
		kind: "red",
		...read,
		jobs: names,
		...(retried ? { retried } : {}),
	};
}

/**
 * The first failed job whose runner failed to ready, and the step, or null:
 * its tests, where they ran, ran without their tools, so pass or fail they
 * say nothing of the code.
 * @param {Job[]} failed
 * @returns {string|null}
 */
function runnerFault(failed) {
	for (const job of failed)
		for (const step of job.steps ?? [])
			if (step.conclusion === "failure" && RUNNER_STEPS.has(step.name))
				return `${job.name} job failed at its '${step.name}' step`;
	return null;
}

/**
 * The tree's files a failed run's log names, and the failing tests it names in
 * them: a test that prints a runner's output as its fixture logs FAIL lines
 * naming files the tree lacks (#2410).
 * @param {string} sha
 * @param {number} run
 * @param {Pick<Reads, "failedLogOf" | "presentAt">} reads
 * @param {boolean} [atRetry] every failed job failed at its retry step, so
 *   the files are those its last lines name still failing
 * @returns {{files: string[], failures?: import("./queue-lander.js").Failure[]}}
 */
function readFailed(sha, run, reads, atRetry = false) {
	const log = stripLogPrefix(reads.failedLogOf(run));
	const files = reads.presentAt(
		sha,
		atRetry ? parseRetryLine(log, STILL_FAILING) : parseFailingFiles(log),
	);
	const failures = parseFailingTests(log).filter((t) => files.includes(t.file));
	return { files, ...(failures.length > 0 ? { failures } : {}) };
}

/**
 * The tree's files the in-job retry cleared on a passed run's shards, read
 * off the log of each shard whose retry step ran and passed. A read that
 * fails costs the record, never the green (#4558), and says so on stderr,
 * which the lander's log takes.
 * @param {string} sha
 * @param {readonly Job[]} jobs
 * @param {Pick<Reads, "jobLogOf" | "presentAt">} reads
 * @returns {string[]}
 */
function readCleared(sha, jobs, reads) {
	const retried = jobs.filter((j) =>
		(j.steps ?? []).some(
			(s) => s.conclusion === "success" && s.name === RETRY_STEP,
		),
	);
	if (retried.length === 0) return [];
	try {
		const files = retried.flatMap((j) => {
			if (j.databaseId === undefined)
				throw new Error(`job ${j.name} lists no id`);
			/* The retry step's own lines: a test's output can print the
			 * cleared line as its fixture. */
			const own = reads
				.jobLogOf(j.databaseId)
				.split("\n")
				.filter((line) => line.split("\t")[1] === RETRY_STEP)
				.join("\n");
			return parseRetryLine(stripLogPrefix(own), CLEARED);
		});
		return files.length > 0 ? reads.presentAt(sha, [...new Set(files)]) : [];
	} catch (err) {
		writeFd(
			2,
			`lander: flakes at ${sha.slice(0, SHORT_SHA)} unread: ${parseErrorText(err)}\n`,
		);
		return [];
	}
}

/**
 * The files each retry step's line opening `prefix` names, across shards.
 * @param {string} log
 * @param {string} prefix
 * @returns {string[]}
 */
function parseRetryLine(log, prefix) {
	const files = log.split("\n").flatMap((line) => {
		const at = line.indexOf(prefix);
		if (at === -1) return [];
		const named = line.slice(at + prefix.length).trim();
		return named === "none" ? [] : named.split(", ");
	});
	return [...new Set(files)];
}

/**
 * `gh run view --log-failed` output as the runner printed it: each line's
 * job, step and timestamp columns dropped, and the escape codes gh prints as
 * literal `^[[…` text (#3529).
 * @param {string} log
 * @returns {string}
 */
const stripLogPrefix = (log) =>
	log
		.split("\n")
		.map((line) =>
			line
				.slice(line.lastIndexOf("\t") + 1)
				.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "")
				.replace(/\^\[\[[0-9;]*[A-Za-z]/g, ""),
		)
		.join("\n");

/**
 * The suite workflow's newest `limit` runs on `branch`.
 * @param {string} branch
 * @param {number} limit
 * @param {string[]} [filter] further `gh run list` flags
 * @returns {Run[]}
 */
const listRuns = (branch, limit, filter = []) =>
	JSON.parse(
		gh([
			"run",
			"list",
			"--workflow",
			SUITE_WORKFLOW,
			"--branch",
			branch,
			...filter,
			"--limit",
			String(limit),
			"--json",
			"databaseId,headSha,attempt,conclusion",
		]),
	);

/**
 * The live reads, over `gh` routed to the code repo and git in `root`.
 * @param {string} root
 * @returns {Omit<Reads, "runs">}
 */
function liveReads(root) {
	return {
		jobsOf: (run) =>
			JSON.parse(gh(["run", "view", String(run), "--json", "jobs"])).jobs,
		failedLogOf: (run) => gh(["run", "view", String(run), "--log-failed"]),
		jobLogOf: (job) => gh(["run", "view", "--job", String(job), "--log"]),
		/* ls-tree lists only the paths present and exits 0 either way, so a
		 * throw is a failed read, never a missing file. */
		presentAt: (sha, files) => {
			if (files.length === 0) return [];
			const listed = execFileSync(
				gitBinary(),
				["ls-tree", "--name-only", sha, "--", ...files],
				{ ...gitSpawnOptions(), cwd: root, encoding: "utf8" },
			);
			const present = new Set(listed.split("\n"));
			return files.filter((f) => present.has(f));
		},
		rerun: (run) => {
			gh(["run", "rerun", String(run), "--failed"]);
		},
		repush: (to, sha) => {
			if (!deleteRemoteRef(root, to, sha)) return false;
			createRemoteRef(root, to, sha);
			return true;
		},
	};
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @typedef {object} Poll
 * @property {(ms: number) => Promise<void>} wait
 * @property {() => number} now
 */

/**
 * `read`'s verdict once it has one; still `pending` where no run was listed by
 * APPEAR_MS, or none finished by RUN_BOUND_MS.
 * @template {SuiteRunVerdict} T
 * @param {() => T} read
 * @param {(err: unknown) => Verdict} unread
 * @param {Poll} poll
 * @returns {Promise<T | Verdict>}
 */
async function pollRun(read, unread, { wait, now }) {
	const start = now();
	for (;;) {
		/** @type {T} */
		let v;
		try {
			v = read();
		} catch (err) {
			/* A network fault is retried to the run's bound, never read as
			 * no verdict. */
			if (!isNetworkFault(err) || now() - start >= RUN_BOUND_MS)
				return unread(err);
			await wait(POLL_MS);
			continue;
		}
		const waited = now() - start;
		if (
			v.kind !== "pending" ||
			(v.run === null && waited >= APPEAR_MS) ||
			waited >= RUN_BOUND_MS
		)
			return v;
		await wait(POLL_MS);
	}
}

/** @param {unknown} err @returns {Verdict} */
const unreadable = (err) => ({
	kind: "unknown",
	reason: `${SUITE_WORKFLOW} runs unreadable: ${parseErrorText(err)}`,
});

/**
 * A push run still unlisted APPEAR_MS into the ask, the push before it, is a
 * verdict about the tree, whose workflow fires no run on the ref: a red
 * naming no file, so the lander's red path ends its batch (#4571).
 * Residual: a listing GitHub delays past APPEAR_MS on both the ask and its
 * rerun, but not on `main`'s base check, drops a member on a false red,
 * which the verdict ledger keeps.
 * @param {RunVerdict} v
 * @returns {Verdict}
 */
function settle(v) {
	if (v.kind !== "pending") return v;
	return v.run === null
		? { kind: "red", files: [], noRun: true }
		: {
				kind: "unknown",
				reason: `run ${v.run} unfinished after ${RUN_BOUND_MS / 60_000} min`,
			};
}

/**
 * The verdict of the push run at `sha` on `branch`, judging only an attempt
 * after `after`; a runner that failed to ready has its failed jobs rerun, up
 * to RUNNER_RERUNS times, before it is no verdict.
 * @param {string} sha
 * @param {number} after
 * @param {{reads: Reads, branch: string} & Poll} suite
 * @param {number} [reruns] attempts started for a runner that failed to ready
 * @returns {Promise<Verdict>}
 */
async function suiteVerdict(sha, after, suite, reruns = 0) {
	const { reads } = suite;
	const v = await pollRun(
		() => runVerdict(sha, reads, after),
		unreadable,
		suite,
	);
	if (v.kind !== "runner") return settle(v);
	if (reruns >= RUNNER_RERUNS)
		return {
			kind: "unknown",
			reason: `${v.reason}, on ${reruns + 1} attempts`,
		};
	try {
		reads.rerun(v.run);
	} catch (err) {
		return unreadable(err);
	}
	return suiteVerdict(sha, v.attempt, suite, reruns + 1);
}

/**
 * @param {string} sha
 * @param {string} title
 * @param {NamedReads} reads
 * @returns {RunVerdict}
 */
function namedRunVerdict(sha, title, reads) {
	const run = reads.namedRuns().find((r) => r.displayTitle === title);
	if (run === undefined) return { kind: "pending", run: null };
	if (!run.conclusion) return { kind: "pending", run: run.databaseId };
	const id = run.databaseId;
	const jobs = reads.jobsOf(id);
	if (isUnconcluded(jobs)) return { kind: "pending", run: id };
	if (run.conclusion === "success") {
		/* GitHub concludes `success` over a job its `if:` skipped. */
		const job = jobs.find((j) => j.name === NAMED_JOB);
		return job?.conclusion === "success"
			? { kind: "green" }
			: {
					kind: "unknown",
					reason: `run ${id} passed, but its ${NAMED_JOB} job is ${job?.conclusion ?? "missing"}`,
				};
	}
	if (run.conclusion !== "failure")
		return { kind: "unknown", reason: `run ${id} ended ${run.conclusion}` };
	const failed = readFailed(sha, id, reads);
	/* A failed checkout or install fails the run naming no test. */
	return failed.files.length > 0
		? { kind: "red", ...failed }
		: {
				kind: "unknown",
				reason: `run ${id} failed naming no failing file in the tree`,
			};
}

/**
 * The day's dispatches counted against the cap: an isolation one is not
 * (#4458).
 * @param {string} file
 * @param {number} nowMs
 * @returns {number}
 */
function readDispatchesToday(file, nowMs) {
	const day = new Date(nowMs).toISOString().slice(0, 10);
	const rows = readJsonl(file)?.rows ?? [];
	return rows.filter((r) => String(r.at).startsWith(day) && !r.isolation)
		.length;
}

/**
 * @param {string} root
 * @returns {Omit<Reads, "runs"> & NamedReads}
 */
const liveNamedReads = (root) => ({
	...liveReads(root),
	namedRuns: () =>
		ghJson([
			"run",
			"list",
			"--workflow",
			NAMED_WORKFLOW,
			"--event",
			"workflow_dispatch",
			"--limit",
			String(NAMED_RUN_LIST_LIMIT),
			"--json",
			"databaseId,displayTitle,conclusion",
		]),
	dispatch: ({ sha, files, nonce }) => {
		gh([
			"workflow",
			"run",
			NAMED_WORKFLOW,
			"--ref",
			VERIFIED_BRANCH,
			"-f",
			`sha=${sha}`,
			"-f",
			`files=${files.join("\n")}`,
			"-f",
			`nonce=${nonce}`,
		]);
	},
});

/**
 * The verdict on `files` at `sha` from a dispatched run of those its tree
 * holds alone, green where it holds none; no verdict where the day's cap is
 * spent, unless `isolation` exempts it, or
 * the dispatch or its run reaches none.
 * @param {{record: string, reads: NamedReads} & Poll} named
 * @param {string} sha
 * @param {string[]} files
 * @param {boolean} isolation
 * @returns {Promise<Verdict>}
 */
async function namedVerdict(
	{ record, reads, wait, now },
	sha,
	files,
	isolation,
) {
	/** @type {(reason: string) => Verdict} */
	const unknown = (reason) => ({ kind: "unknown", reason });
	/* A file the tree at `sha` lacks has no test to fail there: the base
	 * check of a test file new in the tip (#4347). local-tester.js's
	 * readRunsAt holds the same rule. Residual: a path misnamed by the red that asked reads
	 * green here, never no verdict. */
	/** @type {string[]} */
	let present;
	try {
		present = reads.presentAt(sha, files);
	} catch (err) {
		return unknown(
			`tree at ${sha.slice(0, SHORT_SHA)} unread: ${parseErrorText(err)}`,
		);
	}
	if (present.length === 0) return { kind: "green" };
	if (!isolation && readDispatchesToday(record, now()) >= NAMED_DAILY_CAP)
		return unknown(`${NAMED_WORKFLOW}'s ${NAMED_DAILY_CAP}-a-day cap is spent`);
	const nonce = crypto.randomUUID();
	try {
		reads.dispatch({ sha, files: present, nonce });
	} catch (err) {
		return unknown(
			`${NAMED_WORKFLOW} did not dispatch: ${parseErrorText(err)}`,
		);
	}
	const entry = {
		at: new Date(now()).toISOString(),
		sha,
		files: present,
		nonce,
		...(isolation ? { isolation } : {}),
	};
	/* Said and gone on (#3764): the run is already spent, so the only loss is
	 * this one going uncounted against the cap. */
	if (!appendRetained(record, entry, NAMED_RECORD_RETAIN_MS))
		writeFd(2, `lander: named-run record unwritten: ${record}\n`);
	const title = `named-rerun ${sha} ${nonce}`;
	const v = await pollRun(
		() => namedRunVerdict(sha, title, reads),
		(err) =>
			unknown(`${NAMED_WORKFLOW} runs unreadable: ${parseErrorText(err)}`),
		{ wait, now },
	);
	if (v.kind !== "pending") return v;
	return unknown(
		v.run === null
			? `${NAMED_WORKFLOW} listed no run titled ${title}`
			: `run ${v.run} unfinished after ${RUN_BOUND_MS / 60_000} min`,
	);
}

/**
 * @param {string} root
 * @returns {QueueReads}
 */
const liveQueueReads = (root) => ({
	...liveNamedReads(root),
	landerRefs: () =>
		execFileSync(
			gitBinary(),
			["ls-remote", REMOTE, `refs/heads/${LANDER_PREFIX}*`],
			{ ...gitSpawnOptions(), cwd: root, encoding: "utf8" },
		)
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [sha = "", ref = ""] = line.split("\t");
				return { branch: ref.replace(/^refs\/heads\//, ""), sha };
			}),
	runsOn: (branch) => listRuns(branch, RUN_LIST_LIMIT, ["--event", "push"]),
	cancel: (run) => {
		gh(["run", "cancel", String(run)]);
	},
});

/**
 * @typedef {object} QueueTesterOptions
 * @property {string} root the canonical checkout
 * @property {QueueReads} [reads]
 * @property {(ms: number) => Promise<void>} [wait]
 * @property {() => number} [now]
 */

/**
 * @param {QueueTesterOptions} options
 * @returns {QueueTester}
 */
function queueTester({
	root,
	reads = liveQueueReads(root),
	wait = sleep,
	now = Date.now,
}) {
	const poll = { wait, now };
	const named = {
		record: path.join(markersDir(root), NAMED_RECORD),
		reads,
		wait,
		now,
	};
	return {
		requiresRun: true,
		parallel: true,
		async verdict(sha, files = [], again = false) {
			/** @type {string[]} */
			let held;
			try {
				held = heldBy(reads, sha);
			} catch (err) {
				return {
					kind: "unknown",
					reason: `${LANDER_PREFIX}* refs unread: ${parseErrorText(err)}`,
					transient: true,
				};
			}
			if (files.length > 0 && held.some((b) => b.startsWith(LANDER_ISO_PREFIX)))
				return namedVerdict(named, sha, files, true);
			const branch = suiteBranch(held, files);
			if (branch === undefined)
				return files.length > 0
					? namedVerdict(named, sha, files, false)
					: {
							kind: "unknown",
							reason: `no ${LANDER_BATCH_PREFIX}* or ${LANDER_ISO_SUITE_PREFIX}* ref holds ${sha.slice(0, SHORT_SHA)}`,
						};
			const on = {
				...poll,
				branch,
				reads: { ...reads, runs: () => reads.runsOn(branch) },
			};
			if (files.length === 0 && !again) return suiteVerdict(sha, 0, on);
			/* The batch's flakes are its first whole-suite ask's to record: a
			 * later ask read off the same run would record them again. */
			const { cleared: _, ...v } =
				/** @type {Verdict & {cleared?: string[]}} */ (
					await rerunVerdict(sha, files, on, named)
				);
			return v;
		},
		cancel(branch, keep) {
			const listed = reads.runsOn(branch);
			for (const r of listed)
				if (!r.conclusion && r.headSha !== keep) reads.cancel(r.databaseId);
			return [...new Set(listed.map((r) => r.headSha))];
		},
	};
}

/**
 * The ref whose push runs judge a sha the `lander/*` refs `held` hold: for
 * the whole suite an iso-suite one, else a batch one.
 * @param {readonly string[]} held
 * @param {readonly string[]} files
 */
const suiteBranch = (held, files) =>
	(files.length > 0
		? undefined
		: held.find((b) => b.startsWith(LANDER_ISO_SUITE_PREFIX))) ??
	held.find((b) => b.startsWith(LANDER_BATCH_PREFIX));

/**
 * The `lander/*` refs holding `sha`.
 * @param {QueueReads} reads
 * @param {string} sha
 * @returns {string[]}
 */
const heldBy = (reads, sha) =>
	reads
		.landerRefs()
		.filter((r) => r.sha === sha)
		.map((r) => r.branch);

/**
 * The verdict at `sha` asked again on `on`'s branch, the newest run at `sha`
 * rerun where it failed: on `files`, which it judges too, else the whole
 * suite. Files at a sha no run covers are run alone. The whole suite is
 * never read off a run listed before the ask (#4524): any other run at
 * `sha` has the branch pushed again, and only a run newer than every one
 * the branch listed is judged. Where no run at `sha` was listed and none
 * newer appears, the branch is pushed again and waited on once more before
 * a no-run red (#4572). Residual: a run the lander's own push started
 * and GitHub listed by the ask is run twice.
 * @param {string} sha
 * @param {string[]} files
 * @param {{reads: Reads, branch: string} & Poll} on
 * @param {{record: string, reads: NamedReads} & Poll} named
 * @returns {Promise<Verdict>}
 */
async function rerunVerdict(sha, files, on, named) {
	const { reads } = on;
	/** @type {Run[]} */
	let listed;
	try {
		listed = reads.runs();
	} catch (err) {
		return unreadable(err);
	}
	const run = newestRun(sha, listed);
	if (run?.conclusion === "failure")
		return failedRunVerdict(sha, run, on, listed);
	if (files.length > 0)
		return run === undefined
			? namedVerdict(named, sha, files, false)
			: suiteVerdict(sha, 0, on);
	if (run !== undefined) {
		return repushFailure(on, sha) ?? newerVerdict(sha, on, listed);
	}
	const v = await newerVerdict(sha, on, listed);
	if (v.kind !== "red" || !v.noRun) return v;
	/** @type {Run[]} */
	let again;
	try {
		again = reads.runs();
	} catch (err) {
		return unreadable(err);
	}
	return repushFailure(on, sha) ?? newerVerdict(sha, on, again);
}

/**
 * The verdict at `sha` off the failed `run` with its failed jobs rerun, or,
 * where GitHub will not retry it, as a run that failed before some of its
 * jobs were created, off a fresh push run: read as no verdict, the lander
 * asks again forever (#4823).
 * @param {string} sha
 * @param {Run} run
 * @param {{reads: Reads, branch: string} & Poll} on
 * @param {readonly Run[]} listed
 * @returns {Promise<Verdict>}
 */
async function failedRunVerdict(sha, run, on, listed) {
	try {
		on.reads.rerun(run.databaseId);
	} catch (err) {
		if (!NOT_RETRIABLE.test(parseErrorText(err))) return unreadable(err);
		return repushFailure(on, sha) ?? newerVerdict(sha, on, listed);
	}
	return suiteVerdict(sha, run.attempt, on);
}

/**
 * The whole suite at `sha` read off a run on `on`'s branch newer than every
 * one in `listed`.
 * @param {string} sha
 * @param {{reads: Reads, branch: string} & Poll} on
 * @param {readonly Run[]} listed
 * @returns {Promise<Verdict>}
 */
function newerVerdict(sha, on, listed) {
	const bound = Math.max(0, ...listed.map((r) => r.databaseId));
	const { reads } = on;
	return suiteVerdict(sha, 0, {
		...on,
		reads: {
			...reads,
			runs: () => reads.runs().filter((r) => r.databaseId > bound),
		},
	});
}

/**
 * Deletes and creates `on`'s branch again at `sha`: null where it did, else the no verdict naming why not.
 * @param {{reads: Reads, branch: string}} on
 * @param {string} sha
 * @returns {Verdict|null}
 */
function repushFailure({ reads, branch }, sha) {
	/** @type {boolean} */
	let pushed;
	try {
		pushed = reads.repush(branch, sha);
	} catch (err) {
		return {
			kind: "unknown",
			reason: `${branch} not pushed again at ${sha.slice(0, SHORT_SHA)}: ${parseErrorText(err)}`,
			...(isNetworkFault(err) ? { transient: true } : {}),
		};
	}
	return pushed
		? null
		: {
				kind: "unknown",
				reason: `${branch} moved off ${sha.slice(0, SHORT_SHA)} before it was pushed again`,
			};
}

module.exports = { queueTester };
