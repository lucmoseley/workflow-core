/*
 * The seam between the Node scripts and the `gh` CLI: they route every call
 * through here and never name the binary themselves. The shell hooks
 * (guard-*.sh) and session-arbiter.js still resolve `gh` on their own.
 *
 * The binary is injected at one named point: WFC_GH, pointing at an
 * executable. Tests set it to a stub (scripts/lib/gh-stub.ts) instead of
 * prepending PATH.
 */

const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");

const { skipError, brokenError, isOutcomeError } = require("./check");
const { ISSUE_LIST_LIMIT } = require("./gh-limits.js");
const { codeRepoArgs } = require("./workflow-core-config.js");

const pExecFile = promisify(execFile);

/*
 * A full-tracker response runs to megabytes; Node's 1 MB default does not
 * truncate it, it kills the call with ENOBUFS. Measured at mantahostels#2466: the widest
 * query any checker makes — every issue's body and comments,
 * check-issue-citations.js's — was 26.67 MB across 2,456 issues, ~10.6 KiB per
 * issue, so 256 MB carries ~23,500.
 *
 * Memory is not the binding constraint: buffering and parsing the full 256 MB
 * costs ~2x payload in heap and ~3.6x in RSS, peaking at 925 MB RSS / 530 MB
 * heap — against ~/.bashrc's 4 GB node heap cap, that ceiling sits at ~1.9 GB
 * of payload, ~175,000 issues (mantahostels#2481). ISSUE_LIST_LIMIT, in
 * lib/gh-limits.js, fires first and loudly, and mantahostels#2481 ruled that raising
 * both constants together when it does is right — narrowing, scoping and
 * streaming the full-tracker reads were all priced there and declined as
 * premature. What degrades first is wall time, ~99% of it the GraphQL fetch —
 * mantahostels#2491 owns that, gated on the reading.
 */
const MAX_BUFFER = 256e6;

/*
 * Every call's wall-clock cap unless its caller sets its own (#2677). Under
 * load 32-52 on 8 cores, 114 measured calls took 8-187 s, the CPU starved
 * rather than GitHub slow; a cap of 120 s would have failed 13 of them. The
 * margin over 187 s is a guess, set level with the refill loop's shortlist
 * cap.
 */
const GH_TIMEOUT_MS = 300_000;

const ghBinary = () => process.env.WFC_GH || "gh";

/* The subcommands that read Actions runs and workflows. */
const RUNS_SUBCOMMANDS = new Set(["run", "workflow"]);

/**
 * `args` with `--repo <codeRepo>` added to a run or workflow call that names
 * no repo of its own. Runs live in the code repo, and gh's default repo is the
 * tracker, which holds none once the two differ (#1963).
 * @param {string[]} args
 */
function routed(args) {
	if (
		!RUNS_SUBCOMMANDS.has(args[0] ?? "") ||
		args.includes("--repo") ||
		args.includes("-R")
	)
		return args;
	return [...args, ...codeRepoArgs()];
}

/**
 * What every catch here actually reads off a failed call: `execFileSync`,
 * `execFile` and a plain thrown `Error` all agree on this shape closely
 * enough that one typedef covers all four readers below.
 * @typedef {Error & {stderr?: string|Buffer, code?: string}} ExecError
 */

/**
 * Every catch here starts from `unknown` (strict mode's own rule for a caught
 * value) and narrows to `ExecError` here rather than at each call site.
 * @param {unknown} e
 * @returns {ExecError}
 */
function asExecError(e) {
	return e instanceof Error
		? /** @type {ExecError} */ (e)
		: /** @type {ExecError} */ (new Error(String(e)));
}

/**
 * The one line carrying the reason: gh's is the LAST of stderr, under any
 * warnings; a thrown JS error's is the FIRST of its message, above the stack
 * and above whatever input it quoted back.
 * @param {unknown} raw
 */
const errLine = (raw) => {
	const e = asExecError(raw);
	const stderr = (e.stderr || "").toString().trim();
	if (stderr) return stderr.split("\n").pop() ?? "";
	return (e.message || "").toString().trim().split("\n")[0] ?? "";
};

/**
 * Run gh synchronously; return stdout. Throws execFileSync's error, with
 * stderr captured on `e.stderr` rather than echoed to the terminal.
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @returns {string}
 */
function gh(args, opts = {}) {
	return /** @type {string} */ (
		execFileSync(ghBinary(), routed(args), {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: MAX_BUFFER,
			timeout: GH_TIMEOUT_MS,
			...opts,
		})
	);
}

/**
 * Async variant, for callers that fan out calls in parallel.
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileOptions} [opts]
 * @returns {Promise<string>}
 */
async function ghAsync(args, opts = {}) {
	const { stdout } = await pExecFile(ghBinary(), routed(args), {
		encoding: "utf8",
		maxBuffer: MAX_BUFFER,
		timeout: GH_TIMEOUT_MS,
		...opts,
	});
	return /** @type {string} */ (/** @type {unknown} */ (stdout));
}

/**
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @returns {any}
 */
function ghJson(args, opts = {}) {
	return JSON.parse(gh(args, opts));
}

/**
 * `gh api … --paginate --slurp`, parsed. --slurp wraps each page's array so
 * multi-page output stays parseable; older gh returns one flat array.
 * `.flat()` normalises both.
 * @param {string[]} apiArgs
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @returns {any[]}
 */
function ghApiSlurp(apiArgs, opts = {}) {
	return ghJson(["api", ...apiArgs, "--paginate", "--slurp"], opts).flat();
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
 * `gh api <path> --paginate --slurp`, retried once, never throwing (mantahostels#1145).
 *
 * One retry because a transient 502 from the dependencies endpoint is common
 * enough that failing on the first would make a fan-out unusable. What a
 * PERSISTENT failure means is the caller's policy, not this function's:
 * pick-next.js drops that one issue, wayfinder-frontier.js refuses its whole
 * run. Both read the same `{ ok }`.
 *
 * `strict` treats a gh that exits 0 with no output as a failure. Without it an
 * empty stdout parses as `[]`, which on the `dependencies/blocked_by` endpoint
 * is indistinguishable from "this issue has no blockers" — a blocked issue
 * reported as free. Callers whose empty answer is a real answer leave it off.
 *
 * Deliberately no `--jq`: every projection stays in the caller's JS, which
 * keeps the shape of the query visible there and testable against a stub `gh`
 * that would otherwise have to reimplement a jq filter.
 * @param {string} apiPath
 * @param {{strict?: boolean}} [opts]
 * @returns {Promise<{ok: true, out: any[]} | {ok: false, error: string}>}
 */
async function ghGetRetrying(apiPath, { strict = false } = {}) {
	const once = async () => {
		const out = await ghAsync(["api", apiPath, "--paginate", "--slurp"]);
		if (!out.trim()) {
			if (strict) throw new Error("gh exited 0 having printed nothing");
			return [];
		}
		return JSON.parse(out).flat();
	};
	try {
		return { ok: true, out: await once() };
	} catch {
		try {
			return { ok: true, out: await once() };
		} catch (e) {
			return { ok: false, error: errLine(e) };
		}
	}
}

/**
 * Run `fn` over `items` with at most `limit` in flight — in every caller here
 * the per-issue gh calls dominate the run time, and an unbounded fan-out is a
 * self-inflicted rate limit.
 *
 * Results come back in INPUT order, which both callers rely on to pair a result
 * with the issue it describes. `limit` is clamped to `items.length`. A `fn`
 * that rejects rejects the whole call, which is why callers pass one that
 * resolves to `{ ok: false }` instead of throwing.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	// One iterator shared by every worker, so each item is taken exactly once.
	const queue = items.entries();
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			for (const [idx, item] of queue) out[idx] = await fn(item);
		}),
	);
	return out;
}

/* The fan-out every per-issue mapLimit caller here passes. A guess, never
 * measured. */
const ISSUE_READ_CONCURRENCY = 8;

/**
 * Everything gh said on stderr, not just the last line — a reason can be
 * printed above a trailing hint.
 *
 * Deliberately NOT e.message: execFileSync puts the whole argv in there, so a
 * query whose own arguments contain "rate limit" or "GH_TOKEN" would classify
 * itself unreachable and exit 0.
 * @param {unknown} raw
 */
const errStderr = (raw) => (asExecError(raw).stderr ?? "").toString();

/*
 * Only three causes make a failed gh call an environment fact: no binary, no
 * credentials, no network. Anything else — an overrun buffer, a malformed
 * request, unparseable output — is a fault in the call (mantahostels#164).
 */
const UNREACHABLE = [
	// no credentials. Several spellings because gh words it differently per
	// surface: `gh auth status` logged out, `gh api` with no token, and the
	// Actions runner with GH_TOKEN unset.
	/gh auth login/i,
	/not logged in/i,
	/not authenticated/i,
	/authentication (failed|required)/i,
	/authentication token/i,
	/GH_TOKEN/,
	/bad credentials/i,
	/HTTP 401/,
	// no network
	/dial tcp/i,
	/no such host/i,
	/could not resolve host/i,
	/temporary failure in name resolution/i,
	/connection refused/i,
	/network is unreachable/i,
	/i\/o timeout/i,
	/TLS handshake/i,
	/EAI_AGAIN/,
	// GitHub is up and refusing everyone for a while; as unconcludable as no
	// network. Matched on the phrase, never on 403, which is also the code for
	// a token missing a scope — a configuration fault, and loud.
	/rate limit/i,
];

/**
 * "unreachable" — nothing to conclude; "broken" — the call itself is at fault.
 * @param {unknown} raw
 */
function ghFailureReason(raw) {
	if (asExecError(raw).code === "ENOENT") return "unreachable"; // no gh binary on PATH
	return UNREACHABLE.some((re) => re.test(errStderr(raw)))
		? "unreachable"
		: "broken";
}

/**
 * The one-line remedy for an unreachable GitHub, for raiseGhFailure and for
 * the callers that build their own message.
 * @param {unknown} raw
 * @returns {string}
 */
function unreachableRemedy(raw) {
	/* A rate limit is a spent budget, not a missing credential — telling the
	 * reader to authenticate `gh` sends them to fix the wrong thing (#93). */
	return /rate limit/i.test(errStderr(raw))
		? "GitHub's rate-limit budget is exhausted, not a credential problem."
		: "Needs an authenticated `gh`.";
}

/**
 * The outcome of a failed gh call in a REPORTING check. An unreachable GitHub
 * must not read as "all clear" but must not block anything either, so it SKIPs
 * at exit 0. Every other failure is BROKEN at exit 2, distinct from the 1 a
 * checker uses for a finding.
 *
 * It THROWS rather than exiting: check.js is the one place a checker's process
 * ends (mantahostels#155 — the checker family's exit-code and severity model —
 * decision 6). A caller with its own exit rule — such as
 * check-ci-status.js, which must never block a session start, or pick-next.js,
 * where no shortlist is never a success — reads ghFailureReason directly.
 * @param {unknown} raw
 * @param {string} [conclusion]
 * @returns {never}
 */
function raiseGhFailure(raw, conclusion = "No conclusion drawn.") {
	if (isOutcomeError(raw)) throw raw;
	if (ghFailureReason(raw) === "unreachable") {
		throw skipError(
			`could not query GitHub issues (${errLine(raw)}).\n      ${unreachableRemedy(raw)} ${conclusion}`,
		);
	}
	const hint =
		asExecError(raw).code === "ENOBUFS"
			? "\n        gh's output exceeded maxBuffer — raise MAX_BUFFER in scripts/lib/gh.js."
			: "";
	throw brokenError(
		`the gh call failed, and not because GitHub was unreachable (${errLine(raw)}).\n` +
			`        ${conclusion} This is a fault in the check, not a finding about the tracker.${hint}`,
	);
}

// Same figure as the fantasy-books module's ENUMERATE_CAP (#81, #93).
const COLLAPSE_ABOVE = 3;

/**
 * Splits a same-shaped-failure list into full detail and a one-line-per-group
 * collapse, once more than COLLAPSE_ABOVE items share the exact same error
 * string — the enumeration a reporter prints one block per issue otherwise
 * runs to the length of the outage (#93).
 *
 * Grouping is by exact string equality on whatever `errorOf` returns —
 * callers here pass `errLine`'s output, which is gh's LAST stderr line and so
 * carries no per-issue path (see errLine's own doc above); an error string
 * that DOES embed the issue number defeats the grouping silently.
 *
 * Report text only: a caller's `--json` still carries every item, from the
 * array it read this from.
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
 * The one line a collapsed group prints, shared so pick-next.js's DEGRADED
 * block and check-stale-claims.js's UNREADABLE block render it identically
 * (#93).
 * @param {{error: string, items: {number: number}[]}} group
 * @returns {string}
 */
function collapsedFailureLine(group) {
	return `  ${group.items.length} failing the same way — ${group.error}\n    ${group.items.map((i) => `#${i.number}`).join(", ")}`;
}

/**
 * Refuses a `gh issue list` that came back exactly at ISSUE_LIST_LIMIT, which
 * gh reports as a full answer.
 *
 * It stays in this module, not in lib/gh-limits.js beside the ceiling, because
 * `brokenError` is what makes it a guard: the class it throws is how check.js
 * tells a fault in the check from a finding about the tracker. A caller that
 * cannot load check.js (lib/arbiter-debts.js) also cannot use a throw — it must
 * fail toward keeping its register, so it logs and returns null instead (mantahostels#2512).
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
			"        Raise ISSUE_LIST_LIMIT in scripts/lib/gh-limits.js, and re-check\n" +
			"        MAX_BUFFER in scripts/lib/gh.js against the measurement in its comment.",
	);
}

/**
 * Every issue in the repo — open and closed, bodies and labels included — in
 * one paginated call.
 *
 * Each row carries `parent_issue_url`, which is why both callers read parentage
 * from here rather than walking each issue's /sub_issues: that is one call per
 * issue and defaults to per_page=30, silently truncating (the incident that
 * proved it: check-issue-orphans.js's header).
 */
function ghAllIssues() {
	return ghIssuesInState("all");
}

/**
 * The issues list in one state, `--paginate`d, with any extra `-f` pairs the
 * caller adds — the shared body under ghAllIssues and the scoped reads below.
 *
 * An empty answer is re-run once before it is believed, the tracker rule for
 * any empty `gh` result (#2565). Residual: a closed or filtered read can be empty
 * for real, so one that fails silently twice running still reads as none.
 * @param {"all"|"open"|"closed"} state
 * @param {string[]} [extra]
 * @returns {any[]}
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
 * `rows`, unless they are empty and the repo itself counts open issues — then
 * BROKEN, never an empty tracker (#2565). Call it on the RE-RUN of a whole
 * open-issue read whose first answer was empty.
 *
 * The repo's `open_issues_count` counts pull requests too, as the issues
 * list's rows do.
 * @param {any[]} rows
 * @param {string} repo `owner/name`, or gh's `{owner}/{repo}` placeholder
 * @returns {any[]}
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

/**
 * The OPEN issues alone, same rows and same `parent_issue_url` as ghAllIssues.
 *
 * Paying one page instead of the whole tracker is why this exists (mantahostels#1899).
 * It cannot replace ghAllIssues where closed rows are the subject.
 * @returns {any[]}
 */
function ghOpenIssues() {
	return ghIssuesInState("open");
}

/**
 * The OPEN issues carrying `label`.
 * @param {string} label
 * @returns {any[]}
 */
function ghOpenIssuesWithLabel(label) {
	return ghIssuesInState("open", ["-f", `labels=${label}`]);
}

/**
 * The CLOSED issues carrying `label` — the cheap way to reach the few closed
 * rows a scan of open issues still needs, a closed parent among them, without
 * paginating the whole tracker to find them (mantahostels#1899).
 * @param {string} label
 * @returns {any[]}
 */
function ghClosedIssuesWithLabel(label) {
	return ghIssuesInState("closed", ["-f", `labels=${label}`]);
}

/**
 * A whole-tracker `gh issue list`, ceiling-checked. `what` names the rows in
 * the truncation message.
 * @param {string} what
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @returns {any[]}
 */
function ghIssueListAll(what, args, opts = {}) {
	return assertWholeTracker(
		ghJson(
			["issue", "list", ...args, "--limit", String(ISSUE_LIST_LIMIT)],
			opts,
		),
		what,
	);
}

module.exports = {
	ghBinary,
	gh,
	ghJson,
	ghApiSlurp,
	ghApiSlurpAsync,
	ghGetRetrying,
	mapLimit,
	ISSUE_READ_CONCURRENCY,
	errLine,
	ghFailureReason,
	raiseGhFailure,
	groupByRepeatedError,
	collapsedFailureLine,
	unreachableRemedy,
	/* Exported for repo-checks.js, which spawns checkers reading through here
	 * (#1566). */
	MAX_BUFFER,
	/* Re-exported for gh.js's own callers and tests. lib/gh-limits.js OWNS it:
	 * a new caller imports from there, or it takes check.js with it (mantahostels#2512). */
	ISSUE_LIST_LIMIT,
	assertWholeTracker,
	assertOpenRead,
	ghIssueListAll,
	ghAllIssues,
	ghOpenIssues,
	ghOpenIssuesWithLabel,
	ghClosedIssuesWithLabel,
};
