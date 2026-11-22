const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const { SHORT_SHA, gitBinary, gitSpawnOptions } = require("./git.js");
const {
	createRemoteRef,
	deleteRemoteRef,
	pushRemote,
} = require("./lander-git.js");
const { gh, ghJson } = require("./gh.js");
const { parseErrorText } = require("./caught.js");
const { isNetworkFault } = require("./network-fault.js");
const { readJsonl } = require("./jsonl.js");
const { SUITE_WORKFLOW } = require("./suite-timings.js");
const {
	CLEARED,
	parseFailingFiles,
	parseFailingTests,
	STILL_FAILING,
} = require("./suite-output.js");
const {
	LANDER_ISO_PREFIX,
	LANDER_ISO_SUITE_PREFIX,
	VERIFIED_BRANCH,
	batchBranch,
} = require("./landing-refs.js");
const { markersDir } = require("./marker-root.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");
const { writeFd } = require("./write-fd.js");

/** @typedef {import("./queue-lander.js").Verdict} Verdict */
/** @typedef {import("./queue-lander.js").QueueTester} QueueTester */
/** @typedef {import("./queue-lander.js").Placement} Placement */

const SHARD_JOB = /\bVitest \((\d+)\/(\d+)\)$/;
const SUITE_PASSED_JOB = "Suite passed";
// guess, #4571
const APPEAR_MS = 3 * 60 * 1000;
// guess, #2413
const RUN_BOUND_MS = 30 * 60 * 1000;
// guess, #5529
const POLL_MS = 15 * 1000;
// guess, #5529
const RUN_LIST_LIMIT = 50;
const NAMED_WORKFLOW = "named-rerun.yml";
const NAMED_JOB = "Named files";
// guess, #1930
const NAMED_DAILY_CAP = 12;
const NAMED_RECORD = ".lander-named-runs.jsonl";
// guess, #5529
const NAMED_RECORD_RETAIN_MS = 30 * DAY_MS;
// guess, #5529
const NAMED_RUN_LIST_LIMIT = 50;
const RUNNER_STEPS = new Set([
	"Set up job",
	"Run actions/checkout@v4",
	"Run actions/setup-node@v4",
	"Install test tools",
	"Full history",
]);
const RETRY_STEP = "Retry failed files";
const TYPECHECK_STEP = "Typecheck";
const TYPE_ERROR = /\berror TS\d+: /;
const UNNAMED_STEP = "UNKNOWN STEP";
// guess, #5529
const TYPE_ERRORS_MAX = 10;
// guess, #5529
const RUNNER_RERUNS = 2;

/**
 * @typedef {{databaseId: number, headSha: string, attempt: number,
 *   conclusion: string|null}} Run
 * @typedef {{name: string, conclusion: string|null, databaseId?: number,
 *   steps?: {name: string, conclusion: string|null}[]}} Job
 * @typedef {object} Reads
 * @property {() => Run[]} runs
 * @property {(run: number) => Job[]} jobsOf
 * @property {(run: number) => string} failedLogOf
 * @property {(job: number) => string} jobLogOf
 * @property {(sha: string, files: string[]) => string[]} presentAt
 * @property {(run: number) => void} rerun
 * @property {(to: string, sha: string) => boolean} repush
 * @typedef {Verdict | {kind: "pending", run: number|null}} RunVerdict
 * @typedef {RunVerdict
 *   | {kind: "runner", run: number, attempt: number, reason: string}
 *   | {kind: "jobless", run: number, reason: string}} SuiteRunVerdict
 * @typedef {{databaseId: number, displayTitle: string,
 *   conclusion: string|null}} NamedRun
 * @typedef {Pick<Reads, "jobsOf" | "failedLogOf" | "presentAt"> & {
 *   namedRuns: () => NamedRun[],
 *   dispatch: (inputs: {sha: string, files: string[], nonce: string}) => void,
 * }} NamedReads
 * @typedef {Omit<Reads, "runs"> & Pick<NamedReads, "namedRuns" | "dispatch">
 *   & {
 *   push: (branch: string, sha: string) => void,
 *   runsOn: (branch: string) => Run[],
 *   cancel: (run: number) => void,
 * }} QueueReads
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

/** @param {readonly Job[]} jobs */
const isUnconcluded = (jobs) => jobs.some((j) => !j.conclusion);

/**
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
 * @param {string} sha
 * @param {Reads} reads
 * @param {number} after
 * @returns {SuiteRunVerdict}
 */
function runVerdict(sha, reads, after) {
	const run = newestRun(sha, reads.runs());
	if (run === undefined) return { kind: "pending", run: null };
	if (run.attempt <= after || !run.conclusion)
		return { kind: "pending", run: run.databaseId };
	const id = run.databaseId;
	const jobs = reads.jobsOf(id);
	if (isUnconcluded(jobs)) return { kind: "pending", run: id };
	if (run.conclusion === "success") {
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
	if (
		jobs.every(
			(j) =>
				j.name === SUITE_PASSED_JOB ||
				j.conclusion === "success" ||
				j.conclusion === "skipped",
		)
	)
		return {
			kind: "jobless",
			run: id,
			reason: `run ${id} failed listing no failed job, which judges no code`,
		};
	const failed = jobs.filter((j) => j.conclusion === "failure");
	const fault = runnerFault(failed);
	if (fault !== null)
		return {
			kind: "runner",
			run: id,
			attempt: run.attempt,
			reason: `run ${id}'s ${fault}, which judges no code`,
		};
	return readRed(sha, id, failed, reads);
}

/**
 * @param {string} sha
 * @param {number} id
 * @param {Job[]} failed
 * @param {Pick<Reads, "failedLogOf" | "presentAt">} reads
 * @returns {Extract<SuiteRunVerdict, {kind: "red"}>}
 */
function readRed(sha, id, failed, reads) {
	const names = failed.map((j) => j.name);
	const shards = failed.filter((j) => j.name !== SUITE_PASSED_JOB);
	const atRetry =
		shards.length > 0 && shards.every((j) => hasFailedStep(j, RETRY_STEP));
	const raw = reads.failedLogOf(id);
	const typed = failed
		.filter((j) => hasFailedStep(j, TYPECHECK_STEP))
		.map((j) => j.name);
	const read = readFailed(sha, stripLogPrefix(raw), reads, atRetry);
	const retried = atRetry && read.files.length > 0;
	return {
		kind: "red",
		...read,
		run: id,
		jobs: names,
		...(retried ? { retried } : {}),
		...(typed.length > 0 ? { typecheck: parseTypeErrors(raw, typed) } : {}),
	};
}

/**
 * @param {Job} job
 * @param {string} name
 */
const hasFailedStep = (job, name) =>
	(job.steps ?? []).some((s) => s.conclusion === "failure" && s.name === name);

/**
 * @param {string} log
 * @param {readonly string[]} jobs
 */
const parseTypeErrors = (log, jobs) =>
	stripLogPrefix(
		log
			.split("\n")
			.filter((l) => {
				const [job = "", step] = l.split("\t");
				return (
					jobs.includes(job) &&
					(step === TYPECHECK_STEP || step === UNNAMED_STEP)
				);
			})
			.join("\n"),
	)
		.split("\n")
		.filter((l) => TYPE_ERROR.test(l))
		.slice(0, TYPE_ERRORS_MAX)
		.map((l) => l.trim());

/**
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
 * @param {string} sha
 * @param {string} log
 * @param {Pick<Reads, "presentAt">} reads
 * @param {boolean} [atRetry]
 * @returns {{files: string[], failures?: import("./queue-lander.js").Failure[]}}
 */
function readFailed(sha, log, reads, atRetry = false) {
	const files = reads.presentAt(
		sha,
		atRetry ? parseRetryLine(log, STILL_FAILING) : parseFailingFiles(log),
	);
	const failures = parseFailingTests(log).filter((t) => files.includes(t.file));
	return { files, ...(failures.length > 0 ? { failures } : {}) };
}

/**
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
 * @param {string} branch
 * @param {number} limit
 * @param {string[]} [filter]
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
 * @param {string} root
 * @returns {Omit<Reads, "runs">}
 */
function liveReads(root) {
	return {
		jobsOf: (run) =>
			JSON.parse(gh(["run", "view", String(run), "--json", "jobs"])).jobs,
		failedLogOf: (run) => gh(["run", "view", String(run), "--log-failed"]),
		jobLogOf: (job) => gh(["run", "view", "--job", String(job), "--log"]),
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

const RERUN_REFUSED = /cannot be rerun/;

/** @param {unknown} err */
const isRerunRefused = (err) => RERUN_REFUSED.test(parseErrorText(err));

/** @param {unknown} err @returns {Verdict} */
const unreadable = (err) => ({
	kind: "unknown",
	reason: `${SUITE_WORKFLOW} runs unreadable: ${parseErrorText(err)}`,
});

/**
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
 * @param {string} sha
 * @param {number} after
 * @param {{reads: Reads, branch: string} & Poll} suite
 * @param {{reruns?: number, repushed?: boolean}} [ask]
 * @returns {Promise<Verdict>}
 */
async function suiteVerdict(
	sha,
	after,
	suite,
	{ reruns = 0, repushed = false } = {},
) {
	const { reads } = suite;
	const v = await pollRun(
		() => runVerdict(sha, reads, after),
		unreadable,
		suite,
	);
	if (v.kind === "jobless") {
		if (repushed)
			return {
				kind: "unknown",
				reason: `${v.reason}, after ${suite.branch} was pushed again`,
			};
		const next = await repushedVerdict(sha, suite, v.run);
		return next.kind === "red" && next.noRun
			? {
					kind: "unknown",
					reason: `${v.reason}, and no run followed ${suite.branch} pushed again`,
				}
			: next;
	}
	if (v.kind !== "runner") return settle(v);
	if (reruns >= RUNNER_RERUNS)
		return {
			kind: "unknown",
			reason: `${v.reason}, on ${reruns + 1} attempts`,
		};
	try {
		reads.rerun(v.run);
	} catch (err) {
		if (!isRerunRefused(err)) return unreadable(err);
		return repushedVerdict(sha, suite, v.run, reruns + 1);
	}
	return suiteVerdict(sha, v.attempt, suite, { reruns: reruns + 1, repushed });
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
		const job = jobs.find((j) => j.name === NAMED_JOB);
		return job?.conclusion === "success"
			? { kind: "green", named: id }
			: {
					kind: "unknown",
					reason: `run ${id} passed, but its ${NAMED_JOB} job is ${job?.conclusion ?? "missing"}`,
				};
	}
	if (run.conclusion !== "failure")
		return { kind: "unknown", reason: `run ${id} ended ${run.conclusion}` };
	const failed = readFailed(sha, stripLogPrefix(reads.failedLogOf(id)), reads);
	return failed.files.length > 0
		? { kind: "red", ...failed, run: id }
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
	push: (branch, sha) => {
		pushRemote(root, ["--force", `${sha}:refs/heads/${branch}`]);
	},
	runsOn: (branch) => listRuns(branch, RUN_LIST_LIMIT, ["--event", "push"]),
	cancel: (run) => {
		gh(["run", "cancel", String(run)]);
	},
});

/**
 * @typedef {object} QueueTesterOptions
 * @property {string} root
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
		repeatsGates: true,
		start(place, sha) {
			reads.push(suiteRef(place), sha);
		},
		async verdict(place, sha, files = [], again = false) {
			const alone = files.length > 0 && place.kind === "iso";
			const branch = alone ? `${LANDER_ISO_PREFIX}${place.k}` : suiteRef(place);
			if (alone || files.length === 0) {
				try {
					reads.push(branch, sha);
				} catch (err) {
					return unpushed(branch, sha, err);
				}
			}
			if (alone) return namedVerdict(named, sha, files, true);
			const on = {
				...poll,
				branch,
				reads: { ...reads, runs: () => reads.runsOn(branch) },
			};
			if (files.length === 0 && !again) return suiteVerdict(sha, 0, on);
			const { cleared: _, ...v } =
				/** @type {Verdict & {cleared?: string[]}} */ (
					await rerunVerdict(sha, files, on, named)
				);
			return v;
		},
		cancel(place, keep) {
			const listed = reads.runsOn(suiteRef(place));
			for (const r of listed)
				if (!r.conclusion && r.headSha !== keep) reads.cancel(r.databaseId);
			return [...new Set(listed.map((r) => r.headSha))];
		},
	};
}

/** @param {Placement} place */
const suiteRef = (place) =>
	place.kind === "batch"
		? batchBranch(place.slot)
		: `${LANDER_ISO_SUITE_PREFIX}${place.k}`;

/**
 * @param {string} branch
 * @param {string} sha
 * @param {unknown} err
 * @param {boolean} [again]
 * @returns {Verdict}
 */
const unpushed = (branch, sha, err, again = false) => ({
	kind: "unknown",
	reason: `${branch} not pushed${again ? " again" : ""} at ${sha.slice(0, SHORT_SHA)}: ${parseErrorText(err)}`,
	...(isNetworkFault(err) ? { transient: true } : {}),
});

/**
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
	if (run?.conclusion === "failure") {
		try {
			reads.rerun(run.databaseId);
		} catch (err) {
			if (!isRerunRefused(err)) return unreadable(err);
			return repushedVerdict(sha, on, newestId(listed));
		}
		return suiteVerdict(sha, run.attempt, on);
	}
	if (files.length > 0)
		return run === undefined
			? namedVerdict(named, sha, files, false)
			: suiteVerdict(sha, 0, on);
	if (run !== undefined) return repushedVerdict(sha, on, newestId(listed));
	const v = await newerVerdict(sha, on, newestId(listed));
	if (v.kind !== "red" || !v.noRun) return v;
	/** @type {Run[]} */
	let again;
	try {
		again = reads.runs();
	} catch (err) {
		return unreadable(err);
	}
	return repushedVerdict(sha, on, newestId(again));
}

/** @param {readonly Pick<Run, "databaseId">[]} listed */
const newestId = (listed) => Math.max(0, ...listed.map((r) => r.databaseId));

/**
 * @param {string} sha
 * @param {{reads: Reads, branch: string} & Poll} on
 * @param {number} bound
 * @param {number} [reruns]
 * @returns {Promise<Verdict>}
 */
const repushedVerdict = async (sha, on, bound, reruns = 0) =>
	repushFailure(on, sha) ??
	newerVerdict(sha, on, bound, { reruns, repushed: true });

/**
 * @param {string} sha
 * @param {{reads: Reads, branch: string} & Poll} on
 * @param {number} bound
 * @param {{reruns?: number, repushed?: boolean}} [ask]
 * @returns {Promise<Verdict>}
 */
function newerVerdict(sha, on, bound, ask) {
	const { reads } = on;
	return suiteVerdict(
		sha,
		0,
		{
			...on,
			reads: {
				...reads,
				runs: () => reads.runs().filter((r) => r.databaseId > bound),
			},
		},
		ask,
	);
}

/**
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
		return unpushed(branch, sha, err, true);
	}
	return pushed
		? null
		: {
				kind: "unknown",
				reason: `${branch} moved off ${sha.slice(0, SHORT_SHA)} before it was pushed again`,
			};
}

module.exports = { queueTester };
