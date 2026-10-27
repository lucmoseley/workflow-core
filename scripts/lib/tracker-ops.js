/*
 * tracker-ops.js — the tracker operations claim-issue.js, file-issue.js,
 * resolve-ticket.js and promote-spec.js share (#528, the spec for the first
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

const { parseErrLine, gh, ghApiSlurp, ghJson } = require("./gh.js");
const { requireKey } = require("./workflow-core-config.js");
const { listedSessionIds } = require("./agent-liveness.js");
const { scriptPath } = require("./script-path.js");
const { similarOpen } = require("./similar-titles.js");
const { readTrackerTitles } = require("./closed-title-cache.js");
const issueClaims = require("./arbiter-issue-claims.js");
const ledger = require("./arbiter-ledger.js");
const { logError } = require("./arbiter-core.js");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

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
			`releasing the arbiter claim on #${n} failed (${r.status}) — node ${scriptPath("session-arbiter.js")} release-issue ${n}.`,
		);
		return 1;
	}
	return 0;
}

/**
 * Add `act` to this session's acts ledger (#2308). Silent with no session id,
 * and on a failed write, which is logged: the act itself has landed, and a
 * missed line costs the refill loop one launch read as unproven.
 * @param {string} act e.g. `close lucmoseley/workflow-core-tracker#12`
 */
function recordOwnAct(act) {
	const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
	if (!sessionId) return;
	try {
		ledger.recordAct(act, sessionId);
	} catch (e) {
		logError("record act", e);
	}
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
	readParent,
	recordOwnAct,
	releaseOwnClaim,
	scriptIo,
};
