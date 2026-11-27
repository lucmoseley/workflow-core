const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const {
	skipError,
	brokenError,
	isOutcomeError,
} = require("./outcome-error.js");
const {
	ghBinary,
	ghUnrouted,
	MAX_BUFFER,
	GH_TIMEOUT_MS,
} = require("./gh-binary.js");
const { spawnTimeout } = require("./hook-deadline.js");
const { codeRepoArgs } = require("./workflow-core-config.js");

const pExecFile = promisify(execFile);

// guess, lucmoseley/mantahostels#2481
const ISSUE_LIST_LIMIT = 20_000;

// https://docs.github.com/en/rest/search/search#about-search
const SEARCH_CAP = 1000;

const RUNS_SUBCOMMANDS = new Set(["run", "workflow"]);

/** @param {string[]} args */
function routed(args) {
	if (
		!RUNS_SUBCOMMANDS.has(args[0] ?? "") ||
		args.includes("--repo") ||
		args.includes("-R")
	)
		return args;
	return [...args, ...codeRepoArgs()];
}

/** @typedef {Error & {stderr?: string|Buffer, code?: string}} ExecError */

/**
 * @param {unknown} e
 * @returns {ExecError}
 */
function asExecError(e) {
	return e instanceof Error
		? /** @type {ExecError} */ (e)
		: /** @type {ExecError} */ (new Error(String(e)));
}

/** @param {unknown} raw */
const parseErrLine = (raw) => {
	const e = asExecError(raw);
	const stderr = (e.stderr || "").toString().trim();
	if (stderr) return stderr.split("\n").pop() ?? "";
	return (e.message || "").toString().trim().split("\n")[0] ?? "";
};

/** @param {unknown} raw */
const isNotFound = (raw) =>
	/\(HTTP 404\)/.test(String(asExecError(raw).stderr ?? ""));

/** @param {unknown} raw */
const isGone = (raw) =>
	/\(HTTP (?:404|410)\)/.test(String(asExecError(raw).stderr ?? ""));

/** @param {unknown} raw */
const isForbidden = (raw) =>
	/\(HTTP 403\)/.test(String(asExecError(raw).stderr ?? ""));

/**
 * @typedef {(args: string[], opts?: import("node:child_process").ExecFileSyncOptions) => string} GhRun
 */

/**
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @returns {string}
 */
function gh(args, opts = {}) {
	return ghUnrouted(routed(args), opts);
}

/**
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileOptions} [opts]
 * @returns {Promise<string>}
 */
async function ghAsync(args, opts = {}) {
	const { stdout } = await pExecFile(ghBinary(), routed(args), {
		encoding: "utf8",
		maxBuffer: MAX_BUFFER,
		...opts,
		timeout: spawnTimeout(opts.timeout ?? GH_TIMEOUT_MS),
	});
	return /** @type {string} */ (/** @type {unknown} */ (stdout));
}

/**
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @param {GhRun} [run]
 * @returns {any}
 */
function ghJson(args, opts = {}, run = gh) {
	return buildGhReaders(run).ghJson(args, opts);
}

/**
 * @param {(args: string[], opts?: import("node:child_process").ExecFileSyncOptions) => string} run
 */
function buildGhReaders(run) {
	/** @type {(args: string[], opts?: import("node:child_process").ExecFileSyncOptions) => any} */
	const json = (args, opts = {}) => JSON.parse(run(args, opts));
	return {
		ghJson: json,
		/** @type {(apiArgs: string[], opts?: import("node:child_process").ExecFileSyncOptions) => any[]} */
		ghApiSlurp: (apiArgs, opts = {}) =>
			json(["api", ...apiArgs, "--paginate", "--slurp"], opts).flat(),
		/** @type {(what: string, args: string[], opts?: import("node:child_process").ExecFileSyncOptions) => any[]} */
		ghIssueListAll: (what, args, opts = {}) =>
			assertWholeTracker(
				json(
					["issue", "list", ...args, "--limit", String(ISSUE_LIST_LIMIT)],
					opts,
				),
				what,
			),
	};
}

/**
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @returns {string}
 */
const ghDefaultRepo = (opts = {}) =>
	ghJson(["repo", "view", "--json", "nameWithOwner"], opts).nameWithOwner;

/**
 * @param {string[]} apiArgs
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @param {GhRun} [run]
 * @returns {any[]}
 */
function ghApiSlurp(apiArgs, opts = {}, run = gh) {
	return buildGhReaders(run).ghApiSlurp(apiArgs, opts);
}

/**
 * @param {string[]} apiArgs
 * @param {import("node:child_process").ExecFileOptions} [opts]
 * @returns {Promise<any[]>}
 */
async function ghApiSlurpAsync(apiArgs, opts = {}) {
	const out = await ghAsync(["api", ...apiArgs, "--paginate", "--slurp"], opts);
	return out.trim() ? JSON.parse(out).flat() : [];
}

/**
 * @param {string} apiPath
 * @param {{strict?: boolean}} [opts]
 * @returns {Promise<{ok: true, out: any[]} | {ok: false, error: string, reason: "unreachable"|"broken"}>}
 */
async function ghGetRetrying(apiPath, { strict = false } = {}) {
	return retryingOnce(async () => {
		const out = await ghAsync(["api", apiPath, "--paginate", "--slurp"]);
		if (!out.trim()) {
			if (strict) throw new Error("gh exited 0 having printed nothing");
			return [];
		}
		return JSON.parse(out).flat();
	});
}

/**
 * @template T
 * @param {() => Promise<T>} once
 * @returns {Promise<{ok: true, out: T} | {ok: false, error: string, reason: "unreachable"|"broken"}>}
 */
async function retryingOnce(once) {
	try {
		return { ok: true, out: await once() };
	} catch {
		try {
			return { ok: true, out: await once() };
		} catch (e) {
			return buildFailedRead(e);
		}
	}
}

/**
 * @template T
 * @param {() => T} once
 * @returns {{ok: true, out: T} | {ok: false, error: string, reason: "unreachable"|"broken"}}
 */
function retryingOnceSync(once) {
	try {
		return { ok: true, out: once() };
	} catch {
		try {
			return { ok: true, out: once() };
		} catch (e) {
			return buildFailedRead(e);
		}
	}
}

/**
 * @param {unknown} e
 * @returns {{ok: false, error: string, reason: "unreachable"|"broken"}}
 */
const buildFailedRead = (e) => ({
	ok: false,
	error: parseErrLine(e),
	reason: parseGhFailureReason(e),
});

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	const queue = items.entries();
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			for (const [idx, item] of queue) out[idx] = await fn(item);
		}),
	);
	return out;
}

// guess, workflow-core#2309
const ISSUE_READ_CONCURRENCY = 8;

/** @param {unknown} raw */
const errStderr = (raw) => (asExecError(raw).stderr ?? "").toString();

const NO_CREDENTIALS = [
	/gh auth login/i,
	/not logged in/i,
	/not authenticated/i,
	/authentication (failed|required)/i,
	/authentication token/i,
	/GH_TOKEN/,
	/bad credentials/i,
	/HTTP 401/,
];
const NO_NETWORK = [
	/dial tcp/i,
	/no such host/i,
	/could not resolve host/i,
	/temporary failure in name resolution/i,
	/connection refused/i,
	/network is unreachable/i,
	/i\/o timeout/i,
	/TLS handshake/i,
	/EAI_AGAIN/,
];
const RATE_LIMITED = /rate limit/i;
const UNREACHABLE = [...NO_CREDENTIALS, ...NO_NETWORK, RATE_LIMITED];

/** @param {unknown} raw */
function parseGhFailureReason(raw) {
	if (asExecError(raw).code === "ENOENT") return "unreachable";
	return UNREACHABLE.some((re) => re.test(errStderr(raw)))
		? "unreachable"
		: "broken";
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function unreachableRemedy(raw) {
	return RATE_LIMITED.test(errStderr(raw))
		? "GitHub's rate-limit budget is exhausted, not a credential problem."
		: "Needs an authenticated `gh`.";
}

/**
 * @param {unknown} raw
 * @param {string} [conclusion]
 * @returns {never}
 */
function raiseGhFailure(raw, conclusion = "No conclusion drawn.") {
	if (isOutcomeError(raw)) throw raw;
	if (parseGhFailureReason(raw) === "unreachable") {
		throw skipError(
			`could not query GitHub issues (${parseErrLine(raw)}).\n      ${unreachableRemedy(raw)} ${conclusion}`,
		);
	}
	const hint =
		asExecError(raw).code === "ENOBUFS"
			? "\n        gh's output exceeded maxBuffer — raise MAX_BUFFER in scripts/lib/gh-binary.js."
			: "";
	throw brokenError(
		`the gh call failed, and not because GitHub was unreachable (${parseErrLine(raw)}).\n` +
			`        ${conclusion} This is a fault in the check, not a finding about the tracker.${hint}`,
	);
}

// guess, workflow-core#93
const COLLAPSE_ABOVE = 3;

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} errorOf
 * @returns {{expanded: T[], collapsed: {error: string, items: T[]}[]}}
 */
function groupByRepeatedError(items, errorOf) {
	/** @type {Map<string, T[]>} */
	const byError = new Map();
	for (const item of items) {
		const error = errorOf(item);
		const group = byError.get(error) ?? [];
		group.push(item);
		byError.set(error, group);
	}
	const expanded = [];
	const collapsed = [];
	for (const [error, group] of byError)
		if (group.length > COLLAPSE_ABOVE) collapsed.push({ error, items: group });
		else expanded.push(...group);
	return { expanded, collapsed };
}

/**
 * @param {{error: string, items: {number: number}[]}} group
 * @returns {string}
 */
function buildCollapsedFailureLine(group) {
	return `  ${group.items.length} failing the same way — ${group.error}\n    ${group.items.map((i) => `#${i.number}`).join(", ")}`;
}

/**
 * @template T
 * @param {T[]} rows
 * @param {string} [what]
 * @returns {T[]}
 */
function assertWholeTracker(rows, what = "issues") {
	if (rows.length < ISSUE_LIST_LIMIT) return rows;
	throw brokenError(
		`gh returned ${rows.length} ${what} — exactly the --limit ceiling, so\n` +
			"        the tracker has outgrown it and this check saw only part of it.\n" +
			"        Raise ISSUE_LIST_LIMIT in scripts/lib/gh.js, and re-check\n" +
			"        MAX_BUFFER in scripts/lib/gh-binary.js against the measurement in its comment.",
	);
}

/**
 * @typedef {object} IssueRow
 * @property {number} number
 * @property {string} title
 * @property {"open"|"closed"} state
 * @property {string | null} body
 * @property {{name: string}[]} labels
 * @property {{login: string}[]} assignees
 * @property {string | null} [parent_issue_url]
 * @property {object} [pull_request]
 * @property {string} html_url
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string | null} closed_at
 */

function ghAllIssues() {
	return ghIssuesInState("all");
}

/**
 * @param {"all"|"open"|"closed"} state
 * @param {string[]} [extra]
 * @returns {IssueRow[]}
 */
function ghIssuesInState(state, extra = []) {
	const read = () =>
		ghApiSlurp([
			"repos/{owner}/{repo}/issues",
			"-X",
			"GET",
			"-f",
			`state=${state}`,
			"-f",
			"per_page=100",
			...extra,
		]);
	const rows = read();
	if (rows.length > 0) return rows;
	const again = read();
	return state === "closed" || extra.length > 0
		? again
		: assertOpenRead(again, "{owner}/{repo}");
}

/**
 * @template T
 * @param {T[]} rows
 * @param {string} repo
 * @returns {T[]}
 */
function assertOpenRead(rows, repo) {
	if (rows.length > 0) return rows;
	const counted = ghJson(["api", `repos/${repo}`]).open_issues_count;
	if (!counted) return rows;
	throw brokenError(
		`gh listed no issues twice, but GitHub counts ${counted} open on the repo,\n` +
			"        so the list read failed silently. No conclusion drawn from it.",
	);
}

/** @returns {IssueRow[]} */
function ghOpenIssues() {
	return ghIssuesInState("open");
}

/**
 * @param {string} label
 * @returns {IssueRow[]}
 */
function ghOpenIssuesWithLabel(label) {
	return ghIssuesInState("open", ["-f", `labels=${label}`]);
}

/**
 * @param {string} label
 * @returns {IssueRow[]}
 */
function ghClosedIssuesWithLabel(label) {
	return ghIssuesInState("closed", ["-f", `labels=${label}`]);
}

// guess, workflow-core#5355
const SINCE_SKEW_MS = 5 * 60 * 1000;

/**
 * @param {string} repo
 * @param {string} since
 * @param {GhRun} [run]
 * @returns {IssueRow[]}
 */
function ghIssuesUpdatedSince(repo, since, run = gh) {
	const read = () =>
		ghApiSlurp(
			[
				`repos/${repo}/issues`,
				"-X",
				"GET",
				"-f",
				"state=all",
				"-f",
				`since=${since}`,
				"-f",
				"per_page=100",
			],
			{},
			run,
		);
	const rows = read();
	return (rows.length > 0 ? rows : read()).filter((i) => !i.pull_request);
}

/**
 * @param {string} what
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @param {GhRun} [run]
 * @returns {any[]}
 */
function ghIssueListAll(what, args, opts = {}, run = gh) {
	return buildGhReaders(run).ghIssueListAll(what, args, opts);
}

module.exports = {
	ghBinary,
	gh,
	ghAsync,
	ghJson,
	ghDefaultRepo,
	ghApiSlurp,
	ghApiSlurpAsync,
	ghIssuesUpdatedSince,
	SINCE_SKEW_MS,
	ghGetRetrying,
	retryingOnce,
	retryingOnceSync,
	mapLimit,
	ISSUE_READ_CONCURRENCY,
	parseErrLine,
	isForbidden,
	isGone,
	isNotFound,
	parseGhFailureReason,
	raiseGhFailure,
	groupByRepeatedError,
	buildCollapsedFailureLine,
	unreachableRemedy,
	MAX_BUFFER,
	GH_TIMEOUT_MS,
	ISSUE_LIST_LIMIT,
	SEARCH_CAP,
	assertWholeTracker,
	assertOpenRead,
	ghIssueListAll,
	buildGhReaders,
	ghAllIssues,
	ghOpenIssues,
	ghOpenIssuesWithLabel,
	ghClosedIssuesWithLabel,
};
