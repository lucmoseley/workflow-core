/*
 * actions-tester.js — the landing queue's Actions tester (#2413, spec #2261):
 * the core's tester, its repo being public. It reads the suite workflow's run
 * that a push to `landing` started at the exact sha, through `gh` with the
 * read access the token already has.
 *
 * Green only on a finished, successful run whose every Vitest shard job and
 * whose `Suite passed` job passed, naming the run; red on a failed one, with
 * its failing jobs and the test files their logs name. A batch's run that is
 * missing, in progress at the wait bound, ended any other way, or cannot be
 * read is no verdict, never green.
 *
 * A whole-suite rerun, or one whose green would move `main`, at a sha whose
 * run failed reruns its failed jobs, `Suite passed` with them (#3329). Any
 * other rerun of named files, and one at a sha no push ran, goes to the
 * fallback tester where one is given, its green naming no run: a rerun of a
 * run's failed jobs judges more than the named files, and a red elsewhere
 * would move a bisect.
 *
 * A set of CI jobs it reads on `main` takes each job's conclusion from the
 * newest finished run there that ran it to a pass or a fail: `main`'s runs
 * are the schedule's, a push to `main` starting none (#3526). One it cannot
 * read, or that no run there settled, is unread, never green there. `Suite
 * passed` is never read there: it fails with any job, so would name a red
 * `main` the culprit's own jobs are green on.
 *
 * `namedRerun` is the local tester's way out when memory shuts its slot
 * (#3764): it dispatches named-rerun.yml for the named files alone.
 */

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const { gitBinary, gitSpawnOptions } = require("./git.js");
const { gh, ghJson } = require("./gh.js");
const { parseErrorText } = require("./caught.js");
const { failingFiles } = require("./local-tester.js");
const { readJsonl } = require("./jsonl.js");
const { markersDir } = require("./marker-root.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");
const { writeFd } = require("./write-fd.js");

/** @typedef {import("./lander.js").Verdict} Verdict */
/** @typedef {import("./lander.js").Tester} Tester */

/* scheduled-checks.yml carries the `landing` push trigger, as it calls every
 * job `main`'s sweep judges by. */
const SUITE_WORKFLOW = "scheduled-checks.yml";
const LANDING = "landing";
const MAIN = "main";
/* ci.yml's matrix names each shard job `Vitest (k/n)`. */
const SHARD_JOB = /\bVitest \((\d+)\/(\d+)\)$/;
/* The aggregate job #2414's ruleset on `main` requires. */
const SUITE_PASSED_JOB = "Suite passed";
/* Untraced: GitHub lists a push run within seconds; the rest is room for a
 * slow queue. */
const APPEAR_MS = 3 * 60 * 1000;
/* Untraced: a sharded run is held under 3 min once its jobs start (#2413);
 * the rest is room for runners to queue. */
const RUN_BOUND_MS = 30 * 60 * 1000;
/* Untraced: a twelfth of a 3 min run, at four `gh` reads a minute. */
const POLL_MS = 15 * 1000;
/* Untraced: GitHub's newest push runs on `landing`, deep enough to reach a
 * batch tip a few later pushes have buried. */
const RUN_LIST_LIMIT = 50;
/* Untraced: two and a half days of `main`'s four sweeps a day. */
const MAIN_RUN_LIMIT = 10;
const NAMED_WORKFLOW = "named-rerun.yml";
const NAMED_JOB = "Named files";
/* Untraced: a runaway's stop, minutes being free on the public repo (#1930). */
const NAMED_DAILY_CAP = 12;
/* Untraced: a month, far past the UTC day the cap reads. */
const NAMED_RECORD = ".lander-named-runs.jsonl";
const NAMED_RECORD_RETAIN_MS = 30 * DAY_MS;
/* Untraced: as RUN_LIST_LIMIT, deep enough for dispatches a cap of 12 a day
 * can bury a run under. */
const NAMED_RUN_LIST_LIMIT = 50;

/**
 * @typedef {{databaseId: number, headSha: string, attempt: number,
 *   conclusion: string|null}} Run a `gh run list` row
 * @typedef {{name: string, conclusion: string|null}} Job
 * @typedef {object} Reads
 * @property {() => Run[]} runs the push runs on `landing`
 * @property {() => Run[]} mainRuns the runs on `main`
 * @property {(run: number) => Job[]} jobsOf
 * @property {(run: number) => string} failedLogOf `gh run view --log-failed`
 * @property {(sha: string, files: string[]) => string[]} presentAt those of
 *   `files` the tree at `sha` holds
 * @property {(run: number) => void} rerun starts a new attempt of the run's
 *   failed jobs
 * @typedef {Verdict | {kind: "pending", run: number|null}} RunVerdict
 * @typedef {{databaseId: number, displayTitle: string,
 *   conclusion: string|null}} NamedRun
 * @typedef {Pick<Reads, "jobsOf" | "failedLogOf" | "presentAt"> & {
 *   namedRuns: () => NamedRun[],
 *   dispatch: (inputs: {sha: string, files: string[], nonce: string}) => void,
 * }} NamedReads
 */

/**
 * @param {string} sha
 * @param {Reads} reads
 * @returns {Run|undefined}
 */
const newestRun = (sha, reads) =>
	reads
		.runs()
		.filter((r) => r.headSha === sha)
		.sort((a, b) => b.databaseId - a.databaseId)[0];

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
 * @returns {RunVerdict}
 */
function runVerdict(sha, reads, after) {
	const run = newestRun(sha, reads);
	if (run === undefined) return { kind: "pending", run: null };
	/* A run has finished when it has a conclusion, never when `status` says
	 * so (ci-verdict.js). */
	if (run.attempt <= after || !run.conclusion)
		return { kind: "pending", run: run.databaseId };
	const id = run.databaseId;
	if (run.conclusion === "success") {
		/* GitHub concludes `success` over jobs that all skipped. */
		const gap = greenGap(reads.jobsOf(id));
		return gap === null
			? { kind: "green", run: id }
			: { kind: "unknown", reason: `run ${id} passed, but ${gap}` };
	}
	if (run.conclusion !== "failure")
		return { kind: "unknown", reason: `run ${id} ended ${run.conclusion}` };
	const jobs = reads
		.jobsOf(id)
		.filter((j) => j.conclusion === "failure")
		.map((j) => j.name);
	return { kind: "red", files: readFailedFiles(sha, id, reads), jobs };
}

/**
 * The tree's files a failed run's log names: a test that prints a runner's
 * output as its fixture logs FAIL lines naming files the tree lacks (#2410).
 * @param {string} sha
 * @param {number} run
 * @param {Pick<Reads, "failedLogOf" | "presentAt">} reads
 * @returns {string[]}
 */
const readFailedFiles = (sha, run, reads) =>
	reads.presentAt(sha, failingFiles(stripLogPrefix(reads.failedLogOf(run))));

/**
 * Which of `asked` failed in the newest finished run on `main` to pass or fail
 * each, and the shas those runs tested, or why none settled where none
 * failed.
 * @param {string[]} asked
 * @param {Reads} reads
 * @returns {import("./lander.js").JobsOnMain}
 */
function readJobsOnMain(asked, reads) {
	const jobs = asked.filter((j) => j !== SUITE_PASSED_JOB);
	const settled = readSettledOnMain(jobs, reads);
	const failed = [...settled].filter(([, s]) => s.conclusion === "failure");
	const red = failed.map(([j]) => j);
	const unsettled = jobs.filter((j) => !settled.has(j));
	if (jobs.length === 0)
		return {
			kind: "unread",
			reason: `it names no job but ${SUITE_PASSED_JOB}`,
		};
	if (red.length === 0 && unsettled.length > 0)
		return {
			kind: "unread",
			reason: `no finished ${SUITE_WORKFLOW} run on ${MAIN} passed or failed ${unsettled.map((j) => `'${j}'`).join(", ")}`,
		};
	return {
		kind: "read",
		red,
		notRed: jobs.filter((j) => !red.includes(j)),
		shas: [...new Set(failed.map(([, s]) => s.headSha))],
	};
}

/**
 * Each of `jobs` with its conclusion in the newest finished run on `main`
 * that passed or failed it, and that run's sha.
 * @param {string[]} jobs
 * @param {Reads} reads
 * @returns {Map<string, {conclusion: string, headSha: string}>}
 */
function readSettledOnMain(jobs, reads) {
	/** @type {Map<string, {conclusion: string, headSha: string}>} */
	const settled = new Map();
	const finished = reads
		.mainRuns()
		.filter((r) => r.conclusion)
		.sort((a, b) => b.databaseId - a.databaseId);
	for (const run of finished) {
		if (settled.size === jobs.length) break;
		for (const { name, conclusion } of reads.jobsOf(run.databaseId))
			if (
				jobs.includes(name) &&
				!settled.has(name) &&
				(conclusion === "success" || conclusion === "failure")
			)
				settled.set(name, { conclusion, headSha: run.headSha });
	}
	return settled;
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
 * @returns {Reads}
 */
function liveReads(root) {
	return {
		runs: () => listRuns(LANDING, RUN_LIST_LIMIT, ["--event", "push"]),
		mainRuns: () => listRuns(MAIN, MAIN_RUN_LIMIT),
		jobsOf: (run) =>
			JSON.parse(gh(["run", "view", String(run), "--json", "jobs"])).jobs,
		failedLogOf: (run) => gh(["run", "view", String(run), "--log-failed"]),
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
 * @param {() => RunVerdict} read
 * @param {(err: unknown) => Verdict} unread
 * @param {Poll} poll
 * @returns {Promise<RunVerdict>}
 */
async function pollRun(read, unread, { wait, now }) {
	const start = now();
	for (;;) {
		/** @type {RunVerdict} */
		let v;
		try {
			v = read();
		} catch (err) {
			return unread(err);
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
	reason: unreadableReason(err),
});

/** @param {unknown} err */
const unreadableReason = (err) =>
	`${SUITE_WORKFLOW} runs unreadable: ${parseErrorText(err)}`;

/**
 * @param {RunVerdict} v
 * @param {string} sha
 * @returns {Verdict}
 */
function settle(v, sha) {
	if (v.kind !== "pending") return v;
	return {
		kind: "unknown",
		reason:
			v.run === null
				? `no ${SUITE_WORKFLOW} push run on ${LANDING} at ${sha.slice(0, 9)}`
				: `run ${v.run} unfinished after ${RUN_BOUND_MS / 60_000} min`,
	};
}

/**
 * @typedef {object} ActionsTesterOptions
 * @property {string} root the canonical checkout
 * @property {Tester} [fallback] tests what no push run covers; absent, that
 *   is no verdict
 * @property {Reads} [reads]
 * @property {(ms: number) => Promise<void>} [wait]
 * @property {() => number} [now]
 */

/**
 * @param {ActionsTesterOptions} options
 * @returns {Tester}
 */
function actionsTester({
	root,
	fallback,
	reads = liveReads(root),
	wait = sleep,
	now = Date.now,
}) {
	/**
	 * @param {string} sha
	 * @param {number} after
	 */
	const polled = async (sha, after) =>
		settle(
			await pollRun(() => runVerdict(sha, reads, after), unreadable, {
				wait,
				now,
			}),
			sha,
		);
	/** @param {string} sha @param {string[]} files @param {string} why */
	const handOff = (sha, files, why) =>
		fallback
			? fallback.verdict(sha, files)
			: Promise.resolve(
					/** @type {Verdict} */ ({ kind: "unknown", reason: why }),
				);
	/**
	 * A rerun at `sha`: of named files that do not land, the fallback; else a
	 * new attempt of its run's failed jobs where it failed, its run read again
	 * where it did not, and the fallback where no push ran it.
	 * @param {string} sha
	 * @param {string[]} files
	 * @param {boolean} lands
	 * @returns {Promise<Verdict>}
	 */
	async function rerunAt(sha, files, lands) {
		if (files.length > 0 && !lands)
			return handOff(sha, files, "a push run tests no named files");
		/** @type {Run|undefined} */
		let run;
		try {
			run = newestRun(sha, reads);
			if (run?.conclusion === "failure") reads.rerun(run.databaseId);
		} catch (err) {
			return unreadable(err);
		}
		if (run?.conclusion === "failure") return polled(sha, run.attempt);
		if (files.length > 0)
			return handOff(sha, files, "a push run tests no named files");
		if (run === undefined)
			return handOff(sha, [], `no ${SUITE_WORKFLOW} push run ran it`);
		return polled(sha, 0);
	}
	return {
		requiresRun: true,
		async verdict(sha, files, lands = false) {
			if (files === undefined) return polled(sha, 0);
			return rerunAt(sha, files, lands);
		},
		async readJobsOnMain(jobs) {
			try {
				return readJobsOnMain(jobs, reads);
			} catch (err) {
				return { kind: "unread", reason: unreadableReason(err) };
			}
		},
	};
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
	if (run.conclusion === "success") {
		/* GitHub concludes `success` over a job its `if:` skipped. */
		const job = reads.jobsOf(id).find((j) => j.name === NAMED_JOB);
		return job?.conclusion === "success"
			? { kind: "green" }
			: {
					kind: "unknown",
					reason: `run ${id} passed, but its ${NAMED_JOB} job is ${job?.conclusion ?? "missing"}`,
				};
	}
	if (run.conclusion !== "failure")
		return { kind: "unknown", reason: `run ${id} ended ${run.conclusion}` };
	const files = readFailedFiles(sha, id, reads);
	/* A failed checkout or install fails the run naming no test. */
	return files.length > 0
		? { kind: "red", files }
		: {
				kind: "unknown",
				reason: `run ${id} failed naming no failing file in the tree`,
			};
}

/**
 * @param {string} file
 * @param {number} nowMs
 * @returns {number}
 */
function readDispatchesToday(file, nowMs) {
	const day = new Date(nowMs).toISOString().slice(0, 10);
	const rows = readJsonl(file)?.rows ?? [];
	return rows.filter((r) => String(r.at).startsWith(day)).length;
}

/**
 * @param {string} root
 * @returns {NamedReads}
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
			MAIN,
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
 * @typedef {object} NamedRerunOptions
 * @property {string} root the canonical checkout
 * @property {NamedReads} [reads]
 * @property {(ms: number) => Promise<void>} [wait]
 * @property {() => number} [now]
 */

/**
 * The verdict on `files` at `sha` from a dispatched run of them alone; no
 * verdict, carrying `shut`, the local slot's refusal, where the day's cap is
 * spent or the dispatch or its run reaches none.
 * @param {NamedRerunOptions} options
 * @returns {(sha: string, files: string[], shut: string) => Promise<Verdict>}
 */
function namedRerun({
	root,
	reads = liveNamedReads(root),
	wait = sleep,
	now = Date.now,
}) {
	const record = path.join(markersDir(root), NAMED_RECORD);
	/** @type {(shut: string, why: string) => Verdict} */
	const noVerdict = (shut, why) => ({
		kind: "unknown",
		reason: `${shut}; off the machine, ${why}`,
	});
	return async (sha, files, shut) => {
		if (readDispatchesToday(record, now()) >= NAMED_DAILY_CAP)
			return noVerdict(
				shut,
				`${NAMED_WORKFLOW}'s ${NAMED_DAILY_CAP}-a-day cap is spent`,
			);
		const nonce = crypto.randomUUID();
		try {
			reads.dispatch({ sha, files, nonce });
		} catch (err) {
			return noVerdict(
				shut,
				`${NAMED_WORKFLOW} did not dispatch: ${parseErrorText(err)}`,
			);
		}
		const entry = { at: new Date(now()).toISOString(), sha, files, nonce };
		/* Said and gone on (#3764): the run is already spent, so the only loss is
		 * this one going uncounted against the cap. */
		if (!appendRetained(record, entry, NAMED_RECORD_RETAIN_MS))
			writeFd(2, `lander: named-run record unwritten: ${record}\n`);
		const title = `named-rerun ${sha} ${nonce}`;
		const v = await pollRun(
			() => namedRunVerdict(sha, title, reads),
			(err) => ({
				kind: "unknown",
				reason: `${NAMED_WORKFLOW} runs unreadable: ${parseErrorText(err)}`,
			}),
			{ wait, now },
		);
		if (v.kind === "unknown") return noVerdict(shut, v.reason);
		if (v.kind !== "pending") return v;
		return noVerdict(
			shut,
			v.run === null
				? `${NAMED_WORKFLOW} listed no run titled ${title}`
				: `run ${v.run} unfinished after ${RUN_BOUND_MS / 60_000} min`,
		);
	};
}

module.exports = { actionsTester, namedRerun };
