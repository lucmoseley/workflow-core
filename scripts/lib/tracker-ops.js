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
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");
const { shellQuote } = require("./sh-quote.js");

/**
 * @typedef {{number: number, title: string, state: string, labels: string[],
 *   body: string, parentPath: string|null, isPullRequest: boolean}} Issue
 */

// TypeScript narrows on a `never` return only through an explicitly typed name. https://github.com/microsoft/TypeScript/pull/32695
/**
 * @typedef {{out: (text: string) => void,
 *  warn: (text: string) => void,
 *  fail: (text: string, code: number) => never,
 *  trackerOrFail: () => string}} ScriptIo
 */

const tracker = () => requireKey("tracker");

class IoExit extends Error {
	/** @param {number} code */
	constructor(code) {
		super(`exit ${code}`);
		this.code = code;
	}
}

/**
 * @typedef {ScriptIo & {err: (text: string) => void,
 *   exit: (code: number) => never,
 *   result: (status: number) => {status: number, stdout: string, stderr: string}}} BufferedIo
 */

/** @param {string} name @returns {BufferedIo} */
function bufferedIo(name) {
	let stdout = "";
	let stderr = "";
	/** @param {string} text */
	const err = (text) => {
		stderr += text;
	};
	/** @param {string} text */
	const warn = (text) => err(`${name}: ${text}\n`);
	/** @type {(code: number) => never} */
	const exit = (code) => {
		throw new IoExit(code);
	};
	/** @type {(text: string, code: number) => never} */
	const fail = (text, code) => {
		warn(text);
		return exit(code);
	};
	return {
		out: (text) => {
			stdout += text;
		},
		err,
		warn,
		fail,
		exit,
		trackerOrFail: () => {
			try {
				return tracker();
			} catch (e) {
				return fail(caught(e).message, 2);
			}
		},
		result: (status) => ({ status, stdout, stderr }),
	};
}

/** @param {BufferedIo} io @param {() => Promise<number | void> | number | void} body */
async function collectIo(io, body) {
	try {
		return io.result((await body()) ?? 0);
	} catch (e) {
		if (e instanceof IoExit) return io.result(e.code);
		throw e;
	}
}

/** @param {string} name @returns {ScriptIo} */
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

/** @param {{labels?: Array<string|{name: string}>}} raw @returns {string[]} */
const labelNames = (raw) =>
	(raw.labels || []).map((l) => (typeof l === "string" ? l : l.name));

/** @param {string} apiPath @param {import("./gh.js").GhRun} [run] @returns {Issue} */
function readIssueAt(apiPath, run = gh) {
	const raw = ghJson(["api", apiPath], {}, run);
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
 * @param {import("./gh.js").GhRun} [run]
 */
const readIssue = (repo, n, run = gh) =>
	readIssueAt(`repos/${repo}/issues/${n}`, run);

/**
 * @param {Issue} issue
 * @param {import("./gh.js").GhRun} [run]
 */
const readParent = (issue, run = gh) =>
	issue.parentPath ? readIssueAt(issue.parentPath, run) : null;

/** @param {Issue} issue */
const isCardOwnIssue = (issue) =>
	/^[a-z0-9][a-z0-9-]* — /.test(issue.title) &&
	!issue.parentPath &&
	!issue.labels.includes("wayfinder:map");

/** @param {string} s */
const same = (s) => s.replace(/\r\n/g, "\n").trim();

/** @param {string} repo @param {number} n @param {string} comment */
function alreadyCommented(repo, n, comment) {
	const mine = readOwnComments(repo, n);
	return mine.length > 0 && same(mine.at(-1)?.body ?? "") === same(comment);
}

/**
 * @typedef {{body: string, html_url: string, created_at: string}} Comment
 */

/** @param {string} repo @param {number} n @returns {Comment[]} */
function readOwnComments(repo, n) {
	const login = ghJson(["api", "user"]).login;
	return ghApiSlurp([`repos/${repo}/issues/${n}/comments`]).filter(
		(/** @type {{user?: {login?: string}}} */ c) => c.user?.login === login,
	);
}

/** @param {string} repo @param {number} n @param {string} comment @returns {Comment | null} */
const findOwnComment = (repo, n, comment) =>
	readOwnComments(repo, n).find((c) => same(c.body) === same(comment)) ?? null;

/** @param {ScriptIo} io @param {number} n */
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

/** @param {ScriptIo} io @returns {0|1} */
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
	const kept = readHeldClean(sessionId);
	if (kept !== null && kept.length === 0) return 0;
	io.warn(
		`${kept === null ? "the claim store would not read after the release, so" : `${kept.map(shellQuote).join(" ")}:`} still held on a clean file — ${buildArbiterCommand`release-committed ${kept ?? clean}`}`,
	);
	return 1;
}

/**
 * @param {number} n
 * @param {string} sessionId
 * @param {import("./agent-liveness.js").Opts} [oracle]
 */
function claimIfFree(n, sessionId, oracle) {
	const listedAt = Date.now();
	const listed = listedSessionIds(oracle);
	const result = issueClaims.claimIssueExclusive(
		n,
		{ sessionId },
		listed,
		listedAt,
	);
	return { ...result, names: listed.names };
}

/** @param {string} repo @param {number} n @param {import("./gh.js").GhRun} [run] */
function assignSelf(repo, n, run = gh) {
	try {
		run(["issue", "edit", String(n), "--repo", repo, "--add-assignee", "@me"]);
		return null;
	} catch (e) {
		return parseErrLine(e);
	}
}

/** @param {string} repo @param {string} query @param {import("./gh.js").GhRun} [run] */
function similarTitles(repo, query, run = gh) {
	const found = similarOpen(query, readTrackerTitles(repo, {}, run));
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
	bufferedIo,
	collectIo,
	claimIfFree,
	isCardOwnIssue,
	labelNames,
	findOwnComment,
	similarTitles,
	readIssue,
	readParent,
	releaseCleanFileClaims,
	releaseOwnClaim,
	scriptIo,
};
