#!/usr/bin/env node

const {
	assignSelf,
	claimIfFree,
	readIssue,
	readParent,
	scriptIo,
} = require("./lib/tracker-ops.js");
const { parseOrExit } = require("./lib/cli-args");
const { scriptPath } = require("./lib/script-path.js");
const { parseIssueNumber } = require("./lib/issue-number.js");
const { parseErrLine } = require("./lib/gh.js");
const { PARKED_LABEL, setParked } = require("./lib/parked.js");

/** @type {import("./lib/tracker-ops.js").ScriptIo} */
const io = scriptIo("claim-issue");
const USAGE = `usage: node ${scriptPath("claim-issue.js")} <issue-number>`;

/** @param {import("./lib/tracker-ops.js").Issue} i */
const buildLabelLine = (i) =>
	`labels: ${i.labels.length > 0 ? i.labels.join(", ") : "(none)"}`;

function main() {
	const [arg] = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		max: 1,
	}).positionals;
	const n = parseIssueNumber(arg);
	if (n === null) io.fail(USAGE, 2);

	const repo = io.trackerOrFail();

	const issue = readOpenIssue(repo, n);

	const recorded = recordClaim(n, process.env.CLAUDE_CODE_SESSION_ID);

	const assignError = assignSelf(repo, n);
	if (assignError)
		io.fail(
			`${recorded} But assigning #${n} failed (${assignError}) — re-run to assign; the record expires with the session.`,
			1,
		);

	io.out(`${recorded} Assigned #${n} to @me.\n`);
	if (issue.labels.includes(PARKED_LABEL)) unpark(repo, n);
	io.out("\n");
	io.out(
		`#${issue.number} ${issue.title}\nstate: ${issue.state}\n${buildLabelLine(issue)}\n\n${issue.body}\n\n`,
	);

	printParent(issue, n);
}

/**
 * @param {string} repo
 * @param {number} n
 * @returns {import("./lib/tracker-ops.js").Issue}
 */
function readOpenIssue(repo, n) {
	let issue;
	try {
		issue = readIssue(repo, n);
	} catch (e) {
		io.fail(`could not read #${n} from ${repo} (${parseErrLine(e)})`, 1);
	}
	if (issue.isPullRequest) io.fail(`#${n} is a pull request, not an issue.`, 2);
	if (issue.state !== "open")
		io.fail(`#${n} is ${issue.state} — nothing to claim. Nothing written.`, 2);
	return issue;
}

/**
 * @param {number} n
 * @param {string | undefined} sessionId
 * @returns {string}
 */
function recordClaim(n, sessionId) {
	if (!sessionId)
		return "No session id (CLAUDE_CODE_SESSION_ID is unset), so no arbiter record was written — assigned only.";
	const r = claimIfFree(n, sessionId);
	if (r.status === "held") {
		const who = r.names?.get(String(r.holder.sessionId));
		io.fail(
			`#${n} is held by live session ${r.holder.sessionId}${who ? ` (${who})` : ""}, claimed ${r.holder.claimedAt}. Nothing written — take other work, or escalate a frozen holder.`,
			2,
		);
	}
	if (r.status === "busy")
		io.fail(
			`another claim on #${n} held the arbiter's lock past its wait. Nothing written — re-run.`,
			1,
		);
	if (r.status === "unreadable")
		io.fail(`${r.why}. Nothing written — a claim is never taken on doubt.`, 2);
	if (r.status !== "claimed" && r.status !== "reclaimed")
		io.fail(`the arbiter would not record #${n} (${r.status}).`, 2);
	return r.status === "claimed"
		? `Recorded the arbiter claim for session ${sessionId}.`
		: `Already held by this session (${sessionId}) since ${r.record.claimedAt}; no second record.`;
}

/**
 * @param {string} repo
 * @param {number} n
 */
function unpark(repo, n) {
	const error = setParked(repo, n, false);
	if (error)
		io.warn(
			`could not remove \`${PARKED_LABEL}\` from #${n} (${error}) — run \`gh issue edit ${n} --remove-label ${PARKED_LABEL}\`, or the refill loop keeps skipping it once you hand it on.`,
		);
	else io.out(`Removed \`${PARKED_LABEL}\` from #${n}.\n`);
}

/**
 * @param {import("./lib/tracker-ops.js").Issue} issue
 * @param {number} n
 */
function printParent(issue, n) {
	let parent;
	try {
		parent = readParent(issue);
	} catch (e) {
		io.fail(
			`#${n} is claimed, but its parent (${issue.parentPath}) could not be read (${parseErrLine(e)}).`,
			1,
		);
	}
	io.out(
		parent
			? `Parent #${parent.number} ${parent.title}\n${buildLabelLine(parent)}\n\n${parent.body}\n`
			: `No parent: #${n} is standalone.\n`,
	);
}

main();
