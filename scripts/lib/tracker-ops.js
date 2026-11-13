/*
 * tracker-ops.js — the tracker operations claim-issue.js, file-issue.js,
 * resolve-ticket.js and promote-spec.js share (workflow-core#528, the spec for the first
 * three).
 *
 * Every gh call goes through lib/gh.js, so WFC_GH reaches it, and every one
 * names the tracker `.claude/workflow-core.json` declares rather than relying
 * on the working directory's remote.
 *
 * No hook sees a gh call a script makes, so what record-issue-claim.js does for
 * the hand spelling — the arbiter record — is done here, by claimIfFree, and
 * what record-acts.js does — the acts ledger line — by recordOwnAct.
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { parseErrLine, gh, ghApiSlurp, ghJson } = require("./gh.js");
const { requireKey } = require("./workflow-core-config.js");
const { listedSessionIds } = require("./agent-liveness.js");
const { buildArbiterCommand } = require("./build-arbiter-command.js");
const { similarOpen } = require("./similar-titles.js");
const { readTrackerTitles } = require("./closed-title-cache.js");
const issueClaims = require("./arbiter-issue-claims.js");
const { readHeldClean } = require("./arbiter-locks.js");
const ledger = require("./arbiter-ledger.js");
const { buildAct } = require("./act-line.js");
const { logError, repoRoot } = require("./arbiter-core.js");
const { fromEnv } = require("./session-id.js");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");
const { shellQuote } = require("./sh-quote.js");

/**
 * @typedef {{number: number, title: string, state: string, labels: string[],
 *   body: string, parentPath: string|null, isPullRequest: boolean}} Issue
 */

/**
 * Annotate the binding (`@type {ScriptIo}`): TypeScript narrows on a `never`
 * return only through an explicitly typed name.
 * @typedef {{out: (text: string) => void,
 *   warn: (text: string) => void,
 *   fail: (text: string, code: number) => never,
 *   trackerOrFail: () => string}} ScriptIo
 */

/** The tracker, as `owner/name`. */
const tracker = () => requireKey("tracker");

/**
 * What every tracker script opens with: stdout, a `<name>: <text>` line on
 * stderr, a refusal that writes one and exits `code`, and the tracker read
 * that refuses with exit 2.
 * @param {string} name
 * @returns {ScriptIo}
 */
function scriptIo(name) {
	/** @param {string} text */
	const warn = (text) => {
		writeFd(2, `${name}: ${text}\n`);
	};
	/** @type {(text: string, code: number) => never} */
	const fail = (text, code) => {
		warn(text);
		process.exit(code);
	};
	return {
		out: (text) => {
			writeFd(1, text);
		},
		warn,
		fail,
		trackerOrFail: () => {
			try {
				return tracker();
			} catch (e) {
				return fail(caught(e).message, 2);
			}
		},
	};
}

/**
 * Label names off a REST issue, whose labels are objects or bare strings.
 * @param {{labels?: Array<string|{name: string}>}} raw
 * @returns {string[]}
 */
const labelNames = (raw) =>
	(raw.labels || []).map((l) => (typeof l === "string" ? l : l.name));

/**
 * One issue off the REST API, which carries `parent_issue_url` where
 * `gh issue view --json` does not.
 * @param {string} apiPath
 * @returns {Issue}
 */
function readIssueAt(apiPath) {
	const raw = ghJson(["api", apiPath]);
	return {
		number: raw.number,
		title: raw.title,
		state: raw.state,
		labels: labelNames(raw),
		body: raw.body || "",
		parentPath: raw.parent_issue_url
			? raw.parent_issue_url.replace(/^https:\/\/api\.github\.com\//, "")
			: null,
		isPullRequest: Boolean(raw.pull_request),
	};
}

/**
 * @param {string} repo
 * @param {number} n
 */
const readIssue = (repo, n) => readIssueAt(`repos/${repo}/issues/${n}`);

/**
 * @param {Issue} issue
 */
const readParent = (issue) =>
	issue.parentPath ? readIssueAt(issue.parentPath) : null;

/**
 * A roadmap card's own issue, by the guard-issue-close core's discriminator: a
 * `<card-id> — ` title, no parent (a child borrows the prefix), no
 * `wayfinder:map` label (a map borrows it too).
 * @param {Issue} issue
 */
const isCardOwnIssue = (issue) =>
	/^[a-z0-9][a-z0-9-]* — /.test(issue.title) &&
	!issue.parentPath &&
	!issue.labels.includes("wayfinder:map");

/** @param {string} s */
const same = (s) => s.replace(/\r\n/g, "\n").trim();

/**
 * Whether this account's latest comment on `n` is `comment` already — the
 * re-run after a comment landed and the close did not.
 * @param {string} repo
 * @param {number} n
 * @param {string} comment
 */
function alreadyCommented(repo, n, comment) {
	const mine = readOwnComments(repo, n);
	return mine.length > 0 && same(mine.at(-1)?.body ?? "") === same(comment);
}

/**
 * @typedef {{body: string, html_url: string, created_at: string}} Comment
 */

/**
 * This account's comments on `n`, oldest first.
 * @param {string} repo
 * @param {number} n
 * @returns {Comment[]}
 */
function readOwnComments(repo, n) {
	const login = ghJson(["api", "user"]).login;
	return ghApiSlurp([`repos/${repo}/issues/${n}/comments`]).filter(
		(/** @type {{user?: {login?: string}}} */ c) => c.user?.login === login,
	);
}

/**
 * Any comment by this account on `n` whose body is `comment`, or null — the
 * re-run after a comment landed and what followed it did not.
 * @param {string} repo
 * @param {number} n
 * @param {string} comment
 * @returns {Comment | null}
 */
const findOwnComment = (repo, n, comment) =>
	readOwnComments(repo, n).find((c) => same(c.body) === same(comment)) ?? null;

/**
 * Release this session's arbiter claim on `n`, saying so. 0, or 1 where the
 * release failed.
 * @param {ScriptIo} io
 * @param {number} n
 */
function releaseOwnClaim(io, n) {
	const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
	if (!sessionId) {
		io.out(
			"No session id (CLAUDE_CODE_SESSION_ID is unset), so no arbiter claim was released.\n",
		);
		return 0;
	}
	const r = issueClaims.releaseIssue(n, { sessionId });
	if (r.status === "released")
		io.out(`#${n}: released this session's arbiter claim.\n`);
	else if (r.status === "none")
		io.out(`#${n}: this session held no arbiter claim on it.\n`);
	else {
		io.warn(
			`releasing the arbiter claim on #${n} failed (${r.status}) — ${buildArbiterCommand`release-issue ${n}`}.`,
		);
		return 1;
	}
	return 0;
}

/**
 * Release every whole-file claim this session holds on a file with no
 * uncommitted change, through the arbiter's `release-committed`, whose report
 * names each (workflow-core#3565). The session's next write to the file re-takes it.
 * Returns the exit
 * code to fold into the caller's: 1 where the store would not read or a clean
 * claim is still held after the release.
 * @param {ScriptIo} io
 * @returns {0|1}
 */
function releaseCleanFileClaims(io) {
	const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
	if (!sessionId) return 0;
	const clean = readHeldClean(sessionId);
	if (clean === null) {
		io.warn(
			`the claim store would not read, so no file claim was released — ${buildArbiterCommand`list`}.`,
		);
		return 1;
	}
	if (clean.length === 0) return 0;
	const r = spawnSync(
		process.execPath,
		[
			path.join(__dirname, "..", "session-arbiter.js"),
			"release-committed",
			...clean,
		],
		{ encoding: "utf8" },
	);
	io.out(r.stdout ?? "");
	if (r.stderr) writeFd(2, r.stderr);
	// Re-read, never trust the exit: release-committed exits 0 on every claim
	// it keeps.
	const kept = readHeldClean(sessionId);
	if (kept !== null && kept.length === 0) return 0;
	io.warn(
		`${kept === null ? "the claim store would not read after the release, so" : `${kept.map(shellQuote).join(" ")}:`} still held on a clean file — ${buildArbiterCommand`release-committed ${kept ?? clean}`}`,
	);
	return 1;
}

/** The store recordOwnAct writes to and readOwnFilings reads. */
const actRoot = () => ledger.ledgerRoot() ?? repoRoot();

/**
 * Add a `kind` act on issue `n` of `repo` to this session's acts ledger
 * (workflow-core#2308). Silent with no session id, and on a failed write, which is logged:
 * the act itself has landed, and a missed line costs the refill loop one launch
 * read as unproven.
 * @param {import("./act-line.js").BareActKind} kind
 * @param {string} repo `owner/name`
 * @param {number|string} n
 */
function recordOwnAct(kind, repo, n) {
	const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
	if (!sessionId) return;
	try {
		ledger.recordAct(buildAct(kind, repo, n), sessionId, actRoot());
	} catch (e) {
		logError("record act", e);
	}
}

/**
 * The issues of `repo` this session filed, by its acts ledger; none with no
 * session id. `unreadable` where the ledger would not read, which is not
 * "filed nothing".
 * @param {string} repo `owner/name`
 * @returns {{numbers: number[], unreadable: boolean}}
 */
function readOwnFilings(repo) {
	const sessionId = fromEnv();
	if (!sessionId) return { numbers: [], unreadable: false };
	const { acts, unreadable } = ledger.readActsBy(sessionId, [actRoot()]);
	const prefix = buildAct("file", repo, "");
	const numbers = acts
		.filter((a) => a.startsWith(prefix))
		.map((a) => Number(a.slice(prefix.length)));
	return { numbers: [...new Set(numbers)], unreadable: unreadable.length > 0 };
}

/**
 * The arbiter's check-and-record for `sessionId` on issue `n`, liveness read
 * here. What each status means: claimIssueExclusive in arbiter-issue-claims.js.
 * @param {number} n
 * @param {string} sessionId
 */
function claimIfFree(n, sessionId) {
	const listedAt = Date.now();
	const listed = listedSessionIds();
	const result = issueClaims.claimIssueExclusive(
		n,
		{ sessionId },
		listed,
		listedAt,
	);
	return { ...result, names: listed.names };
}

/**
 * Assign `n` to the caller. Null on success, else gh's reason.
 * @param {string} repo
 * @param {number} n
 */
function assignSelf(repo, n) {
	try {
		gh(["issue", "edit", String(n), "--repo", repo, "--add-assignee", "@me"]);
		return null;
	} catch (e) {
		return parseErrLine(e);
	}
}

/**
 * The similar-title list for `query`, off the open issues read live and the
 * closed titles' cache: the matches, and the list as printed text. Throws
 * where the open issues cannot be read, or the whole tracker with no cache.
 * @param {string} repo
 * @param {string} query
 */
function similarTitles(repo, query) {
	const found = similarOpen(query, readTrackerTitles(repo));
	const text =
		found.length > 0
			? `Open issues whose titles resemble this one — a duplicate, or its natural parent?\n${found
					.map((c) => `  #${c.number} (${c.score.toFixed(1)}) ${c.title}\n`)
					.join("")}`
			: "No open issue's title resembles this one.\n";
	return { found, text };
}

module.exports = {
	alreadyCommented,
	assignSelf,
	claimIfFree,
	isCardOwnIssue,
	labelNames,
	findOwnComment,
	similarTitles,
	readIssue,
	readOwnFilings,
	readParent,
	recordOwnAct,
	releaseCleanFileClaims,
	releaseOwnClaim,
	scriptIo,
};
