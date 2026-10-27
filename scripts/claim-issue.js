#!/usr/bin/env node
/*
 * claim-issue.js — claim a ticket in one call: refuse if a live session holds
 * it, record the arbiter claim, assign it to the caller, print it and its
 * parent (workflow-core#530; spec workflow-core#528, ruled at workflow-core#481).
 *
 *   node scripts/claim-issue.js <n>
 *
 * The check and the arbiter record are one step under the arbiter's
 * per-issue mutex, so two sessions racing for one ticket cannot both pass.
 *
 * ORDER: check-and-record, then assign, then unpark, then print.
 *
 * UNPARKS: a claimed issue loses its `parked` label (lib/parked.js, workflow-core#2000) —
 * the claiming session answers the round, or carries the founder's answer.
 * A failed removal warns and does not fail the claim.
 *
 * FAILS CLOSED on an unreadable claim store or liveness read, the frontier's
 * keep-on-doubt rule: a claim taken on doubt may put a second session on work
 * already in flight. No session id (the founder's terminal) assigns only, and
 * says no record was written.
 *
 * No override flag: taking over a frozen session's ticket (workflow-core#503) stops the
 * holder first, after which the plain check passes: a holder the oracle
 * lists as terminal does not block (workflow-core#619).
 *
 * Joins no §N3 family: its exits are the three the spec gives all three
 * tracker scripts — 0 done or already done, 1 retry (a gh read, the lock or
 * the assignment did not answer), 2 fix the input (a usage error or a
 * refusal). Every refusal comes before the first write.
 */

const {
	assignSelf,
	claimIfFree,
	readIssue,
	readParent,
	scriptIo,
} = require("./lib/tracker-ops.js");
const { parseOrExit } = require("./lib/cli-args");
const { parseErrLine } = require("./lib/gh.js");
const { PARKED_LABEL, setParked } = require("./lib/parked.js");

/** @type {import("./lib/tracker-ops.js").ScriptIo} */
const io = scriptIo("claim-issue");
const USAGE = "usage: node scripts/claim-issue.js <issue-number>";

/** @param {import("./lib/tracker-ops.js").Issue} i */
const buildLabelLine = (i) =>
	`labels: ${i.labels.length > 0 ? i.labels.join(", ") : "(none)"}`;

function main() {
	const [arg] = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		max: 1,
	}).positionals;
	if (!arg || !/^#?\d+$/.test(arg)) io.fail(USAGE, 2);
	const n = Number(arg.replace(/^#/, ""));

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
 * The issue, refused unless it is an open issue rather than a pull request.
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
 * Checks and records the arbiter claim, refusing on a live holder or doubt;
 * returns the line saying what was recorded.
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
 * Takes `parked` off `n`, saying so, or warning where it would not come off.
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
 * Prints the issue's parent, or says it has none.
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
