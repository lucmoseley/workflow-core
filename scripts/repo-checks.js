#!/usr/bin/env node
// #5865

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const { writeFileAtomic } = require("./lib/atomic-write.js");
const path = require("node:path");
const { logError } = require("./lib/arbiter-core");
const { errMessage, now } = require("./lib/check");
const { parseEnvelope } = require("./lib/check-envelope");
const { parseErrLine, MAX_BUFFER: GH_MAX_BUFFER } = require("./lib/gh");
const { adoptHostRoot } = require("./lib/host-root");
const {
	readDeliveredKeys,
	isCompleted,
	isJudged,
	judgeKeys,
	keysOf,
} = require("./lib/key-delta");
const notify = require("./lib/notify-report");
const { periodicReading, buildSkipLine } = require("./lib/periodic-reading");
const { projectSlug } = require("./lib/project-slug");
const {
	FIRST_SINCE_DAYS,
	carriedArgs,
	carriedNext,
} = require("./lib/repo-checks-carry");
const {
	REPO_CHECKS,
	entryOf,
	gateFault,
	readHost,
} = require("./lib/repo-checks-registry");
const { coreRoot, scriptPath } = require("./lib/script-path");
const { reportOwner } = require("./lib/session-id");
const {
	fileOrRefresh,
	openTrackingIssue,
	refresh,
} = require("./lib/tracking-issue");
const {
	WHERE,
	buildHandCommand,
	reportName,
	resultFile,
} = require("./lib/repo-checks-reading");
const { gitCommonDirOrThrow } = require("./lib/git.js");
const { caught, orFallback } = require("./lib/caught.js");
const { originLabel } = require("./lib/issue-origin");
const { takesLabel } = require("./lib/takes-label");
const { RUN_MS } = require("./lib/repo-checks-run");

const STAMP = ".repo-checks-read";
const LOCK = ".repo-checks-read.lock";
const SINCE = ".repo-checks-since.json";
const RESCAN = ".repo-checks-rescan.json";
const ISSUE_SETS = ".repo-checks-issue.json";
const ISSUE_TITLE = "Repo checks: standing findings";
const ISSUE_LABELS = [takesLabel("triage"), originLabel("repo-checks-script")];
const DAY_MS = 24 * 3_600_000;
// guess, #1510
const CHECK_MS = 300_000;
const UNEXAMINED = "unexamined, not clean.";
// guess: one error line, short of flooding a summary, #1723
const STDERR_LINE_MAX_CHARS = 300;

/**
 * @typedef {import("./lib/repo-checks-registry").RepoCheck} RepoCheck
 * @typedef {import("./lib/repo-checks-carry").Kept} Kept
 * @typedef {import("./lib/check").Outcome | "MISSING"} JobOutcome
 * @typedef {{ job: string, outcome: JobOutcome, count: number, keys: string[],
 *   summary: string, [k: string]: unknown }} Job
 * @typedef {import("./lib/repo-checks-registry").Host} Host
 */

/** @param {string} key */
const tagOf = (key) => {
	const tab = key.indexOf("\t");
	return tab === -1 ? key : key.slice(0, tab);
};

/**
 * @param {string} id
 * @param {{ keys?: unknown } | null | undefined} job
 * @returns {string[]}
 */
function unsettledKeys(id, job) {
	const settled = new Set(entryOf(id).settled ?? []);
	return keysOf(job).filter((k) => !settled.has(tagOf(k)));
}

/** @param {Job} j */
const isJudgedCheck = (j) =>
	entryOf(j.job).kind === "check" && isJudged(j.outcome);

/** @param {string} name @param {number} fallback */
function parseCeiling(name, fallback) {
	const n = Number(process.env[name]);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * @param {Pick<Job, "job" | "outcome" | "summary">} job
 * @returns {Job}
 */
const buildJob = ({ job, outcome, summary }) => ({
	job,
	outcome,
	count: 0,
	keys: [],
	summary,
});

// #2480
const STACK_FRAME = /^at\s/;
const ERROR_LINE = /^(?:Uncaught\s+)?[A-Z]?\w*Error(?:\s\[[A-Z_]+\])?:/;
// guess: a module-load stack in full, #2480
const STDERR_KEPT_MAX_CHARS = 8000;

/** @param {string | undefined} stderr */
function because(stderr) {
	const lines = (stderr ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const line =
		lines.find((l) => ERROR_LINE.test(l)) ??
		lines.findLast((l) => !STACK_FRAME.test(l)) ??
		lines.at(-1);
	return line ? `: ${clip(line, STDERR_LINE_MAX_CHARS)}` : "";
}

/**
 * @param {string} text
 * @param {number} max
 */
const clip = (text, max) =>
	text.length > max ? `${text.slice(0, max)}…` : text;

/**
 * @param {Job} job
 * @param {string | undefined} stderr
 * @returns {Job}
 */
function withStderr(job, stderr) {
	const text = (stderr ?? "").trim();
	if (!text) return job;
	return {
		...job,
		stderr: clip(text, STDERR_KEPT_MAX_CHARS),
	};
}

/**
 * @param {RepoCheck} entry
 * @param {Launcher} launcher
 * @param {{ ms: number, by: string }} limit
 * @param {string[]} extra
 * @returns {Job}
 */
function launch(entry, { root, spawn }, limit, extra) {
	const json = entry.kind === "check";
	const r = spawn(
		process.execPath,
		[
			path.join(coreRoot(), "scripts", entry.script),
			...(entry.args ?? []),
			...extra,
			...(json ? ["--json"] : []),
		],
		{
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: limit.ms,
			killSignal: "SIGKILL",
			maxBuffer: GH_MAX_BUFFER,
		},
	);
	const job = entry.id;
	if (caught(r.error).code === "ETIMEDOUT")
		return buildJob({
			job,
			outcome: "BROKEN",
			summary: `BROKEN: ${job} was killed at ${limit.by} — ${UNEXAMINED}`,
		});
	if (r.error || r.status === null)
		return buildJob({
			job,
			outcome: "BROKEN",
			summary: `BROKEN: ${job} did not run to an exit (${r.error?.message ?? `signal ${r.signal}`}).`,
		});
	const why = because(r.stderr);
	if (json) {
		const envelope = parseEnvelope(r.stdout);
		if (envelope) return { job, ...envelope };
		return withStderr(
			buildJob({
				job,
				outcome: "MISSING",
				summary: `MISSING: ${job} printed no readable --json envelope (exit ${r.status}${why}) — ${UNEXAMINED}`,
			}),
			r.stderr,
		);
	}
	if (r.status === 0)
		return buildJob({ job, outcome: "OK", summary: `OK: ${job} exited 0.` });
	return withStderr(
		buildJob({
			job,
			outcome: "BROKEN",
			summary: `BROKEN: ${job} exited ${r.status}${why || "."}`,
		}),
		r.stderr,
	);
}

/**
 * @param {string} file
 * @param {string} consequence
 * @returns {Record<string, unknown> | null}
 */
function readJsonObject(file, consequence) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (caught(e).code !== "ENOENT") logError(WHERE, e);
		return null;
	}
	const value = orFallback(() => JSON.parse(text), undefined);
	if (value && typeof value === "object" && !Array.isArray(value)) return value;
	logError(WHERE, `${file} is not a JSON object; ${consequence}`);
	return null;
}

// #1551
/**
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
const readLastStarts = (file) =>
	readJsonObject(file, `windows restart at ${FIRST_SINCE_DAYS} days`) ?? {};

/**
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
const readRescans = (file) =>
	readJsonObject(file, "nothing is re-scanned") ?? {};

/**
 * @param {Host} host
 * @param {Kept} kept
 * @param {Spawn} spawn
 * @returns {Job[]}
 */
function runAll(host, kept, spawn) {
	const checkMs = parseCeiling("WFC_REPO_CHECKS_CHECK_MS", CHECK_MS);
	const deadline = Date.now() + parseCeiling("WFC_REPO_CHECKS_RUN_MS", RUN_MS);
	return REPO_CHECKS.map((entry) => {
		const fault = gateFault(entry, host);
		if (fault)
			return buildJob({
				job: entry.id,
				outcome: "SKIP",
				summary: `SKIP: ${fault}`,
			});
		const left = deadline - Date.now();
		if (left <= 0)
			return buildJob({
				job: entry.id,
				outcome: "MISSING",
				summary: `MISSING: ${entry.id} was not reached inside the run's ceiling — ${UNEXAMINED}`,
			});
		const ms = checkMs * (entry.ceilingScale ?? 1);
		const job = launch(
			entry,
			{ root: host.root, spawn },
			left < ms
				? { ms: left, by: "the run's ceiling" }
				: { ms, by: `its ${Math.round(ms / 1000)} s ceiling` },
			carriedArgs(entry, kept),
		);
		if (entry.kind === "reporter" && job.outcome === "BROKEN")
			logError(WHERE, job.summary);
		return job;
	});
}

/**
 * @param {{ starts: string, rescans: string }} files
 * @param {Kept} kept
 * @param {Job[]} jobs
 */
function writeCarried(files, kept, jobs) {
	for (const [name, value] of carriedNext(jobs, kept))
		writeJson(files[name], value);
}

/**
 * @param {string} file
 * @param {unknown} value
 */
function writeJson(file, value) {
	writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {string} file
 * @param {Job[]} jobs
 * @param {string} repo
 */
function writeResult(file, jobs, repo) {
	const result = {
		workflow: WHERE,
		repo,
		collectedAt: new Date(now()).toISOString(),
		jobs,
	};
	writeJson(file, result);
}

/** @param {Job[]} jobs */
function tally(jobs) {
	/** @type {Record<string, number>} */
	const by = {};
	for (const j of jobs) by[j.outcome] = (by[j.outcome] ?? 0) + 1;
	return Object.entries(by)
		.map(([outcome, n]) => `${n} ${outcome}`)
		.join(", ");
}

/** @param {Host} host */
function repoKey(host) {
	const tracker = host.tracker();
	return (tracker ? tracker.replace("/", ".") : projectSlug(host.root)).replace(
		/[^A-Za-z0-9_.-]/g,
		"-",
	);
}

/**
 * @param {string} repo
 * @param {string} job
 */
const stampName = (repo, job) => `${reportName(repo)}.${job}`;

/**
 * @param {Job[]} jobs
 * @param {string} repo
 * @param {number} startMs
 */
function judgeGains(jobs, repo, startMs) {
	/** @type {string[]} */
	const lines = [];
	/** @type {Record<string, string>} */
	const stamps = {};
	for (const j of jobs) {
		if (!isJudgedCheck(j)) continue;
		const name = stampName(repo, j.job);
		const countedKeys = unsettledKeys(j.job, j);
		const { stamp, added } = judgeKeys(j, {
			countedKeys,
			// #1553
			delivered: readDeliveredKeys(name, (s) =>
				logError(
					WHERE,
					`delivery stamp ${s} will not parse; its keys read as new`,
				),
			),
			tag: startMs,
		});
		stamps[name] = stamp;
		if (added === null) lines.push(`  ${j.job} — ${j.summary}`);
		else if (added.length > 0)
			lines.push(
				`  ${j.job} — ${added.length} new finding(s), ${countedKeys.length} standing`,
			);
	}
	return { lines, stamps };
}

/**
 * @param {Host} host
 * @param {Job[]} jobs
 * @param {{ startMs: number, result: string }} reading
 */
function writeNotifyReport(host, jobs, { startMs, result }) {
	const repo = repoKey(host);
	const { lines, stamps } = judgeGains(jobs, repo, startMs);
	const text =
		lines.length === 0
			? ""
			: [
					`REPO-CHECKS (${lines.length}) — ${repo}'s daily checks of ${new Date(startMs).toISOString()}, each gained a finding since the last report or drew no conclusion:`,
					...lines,
					`  Every check's result: ${result}`,
				].join("\n");
	const landed = notify.writeReport(reportName(repo), {
		outcome: lines.length === 0 ? "OK" : "WARN",
		text,
		stamps,
		owner: reportOwner(),
		maxAgeMs: notify.LONG_STALE_MS,
	});
	if (!landed)
		logError(
			WHERE,
			`the notify report for ${repo} did not land in ${notify.base()}`,
		);
}

/**
 * @param {string} file
 * @returns {Record<string, unknown> | null}
 */
const readIssueSets = (file) =>
	readJsonObject(file, "the standing issue is rewritten");

/**
 * @param {Job[]} jobs
 * @param {Record<string, unknown> | null} recorded
 */
function standingSets(jobs, recorded) {
	/** @type {Record<string, string[]>} */
	const sets = {};
	for (const j of jobs) {
		if (!isJudgedCheck(j)) continue;
		sets[j.job] = unsettledKeys(
			j.job,
			isCompleted(j.outcome) ? j : { keys: recorded?.[j.job] },
		);
	}
	return sets;
}

/** @param {Record<string, unknown>} a @param {Record<string, string[]>} b */
const isSameSets = (a, b) => {
	const held = (/** @type {Record<string, unknown>} */ sets) =>
		JSON.stringify(
			Object.entries(sets)
				.filter(([, keys]) => Array.isArray(keys) && keys.length > 0)
				.sort(),
		);
	return held(a) === held(b);
};

/**
 * @param {Job[]} jobs
 * @param {Record<string, string[]>} sets
 * @param {number} startMs
 */
function buildStandingBody(jobs, sets, startMs) {
	const date = new Date(startMs).toISOString().slice(0, 10);
	const lines = [
		`Filed automatically by \`${scriptPath("repo-checks.js")}\`, which runs this repo's own checks once a day at session start and rewrites this body whenever a check's findings change. **Edit it by hand and the next change silently overwrites it** — put anything you want kept in a comment.`,
		"",
	];
	const held = jobs.flatMap((j) => {
		const n = sets[j.job]?.length ?? 0;
		if (n === 0) return [];
		const nothingSettled = isCompleted(j.outcome) && keysOf(j).length === n;
		return [{ ...j, n: nothingSettled ? j.count : n }];
	});
	const unexamined = jobs
		.filter((j) => j.job in sets && !isCompleted(j.outcome))
		.map((j) => `\`${j.job}\``);
	if (held.length === 0) {
		lines.push(
			`As of ${date}, every check is clear: none holds a finding. This issue can be closed; the daily run files it again when a check gains one.`,
		);
		if (unexamined.length > 0)
			lines.push(
				"",
				`Drew no conclusion at that reading, so clear only as of its last one that did: ${unexamined.join(", ")}.`,
			);
		return lines.join("\n");
	}
	lines.push(`As of ${date}, ${held.length} check(s) hold findings:`, "");
	for (const { n, ...j } of held) {
		const state = isCompleted(j.outcome)
			? `${j.outcome}, ${n} finding(s)`
			: `${j.outcome} at this reading; ${n} finding(s) standing from its last that completed`;
		lines.push(
			`- \`${j.job}\` — ${state}. List them: \`${buildHandCommand(entryOf(j.job))}\``,
		);
	}
	return lines.join("\n");
}

/**
 * @param {Host} host
 * @param {Job[]} jobs
 * @param {{ file: string, startMs: number }} reading
 */
function writeStandingIssue(host, jobs, { file, startMs }) {
	if (!host.tracker()) return;
	const recorded = readIssueSets(file);
	const sets = standingSets(jobs, recorded);
	if (recorded && isSameSets(recorded, sets)) return;
	const body = buildStandingBody(jobs, sets, startMs);
	try {
		if (Object.values(sets).some((keys) => keys.length > 0))
			fileOrRefresh({ title: ISSUE_TITLE, labels: ISSUE_LABELS, body });
		else {
			const open = openTrackingIssue({ title: ISSUE_TITLE });
			if (open) refresh(open.number, body);
		}
		writeJson(file, sets);
	} catch (e) {
		logError(
			WHERE,
			`could not file or refresh "${ISSUE_TITLE}": ${parseErrLine(e)}; the next reading retries`,
		);
	}
}

/**
 * @typedef {{ root: string, spawn: Spawn }} Launcher
 * @typedef {(file: string, args: string[],
 *   options: import("node:child_process").SpawnSyncOptionsWithStringEncoding)
 *   => import("node:child_process").SpawnSyncReturns<string>} Spawn
 */

// #5734
/** @param {Spawn} [spawn] */
function main(spawn = spawnSync) {
	try {
		const root = adoptHostRoot();
		const dir = gitCommonDirOrThrow(root);
		// #1554
		process.chdir(root);
		const result = resultFile(dir);
		const startMs = now();
		const gate = periodicReading(
			{
				stamp: path.join(dir, STAMP),
				lock: path.join(dir, LOCK),
				nowMs: startMs,
				everyMs: DAY_MS,
				script: path.basename(__filename),
			},
			() => {
				const files = {
					starts: path.join(dir, SINCE),
					rescans: path.join(dir, RESCAN),
				};
				const kept = {
					lastStarts: readLastStarts(files.starts),
					rescans: readRescans(files.rescans),
					startMs,
				};
				const host = readHost(root);
				const jobs = runAll(host, kept, spawn);
				writeResult(result, jobs, repoKey(host));
				writeCarried(files, kept, jobs);
				writeNotifyReport(host, jobs, { startMs, result });
				writeStandingIssue(host, jobs, {
					file: path.join(dir, ISSUE_SETS),
					startMs,
				});
				return `${jobs.length} checks: ${tally(jobs)}. Result in ${result}.`;
			},
		);
		writeFd(2, `${gate.ran ? gate.value : buildSkipLine(gate, "a day")}\n`);
	} catch (e) {
		// #1548
		logError(WHERE, e);
		writeFd(
			2,
			`FAILED OPEN: ${errMessage(e)} — recorded in the guard-error log; the next day's reading retries.\n`,
		);
	}
}

module.exports = { main };

if (require.main === module) main();
