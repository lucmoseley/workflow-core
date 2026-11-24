const { ghDefaultRepo, ghGetRetrying, ghOpenIssues } = require("./gh");
const { isGateHolding } = require("./issue-gate");
const { isInOtherRepo } = require("./issue-ref");
const { judgeProseRefs, proseRefsOf } = require("./prose-blockers");

/** @typedef {Parameters<typeof judgeProseRefs>[1]} ProseAt */
/** @typedef {{number: number, body: string}} IssueBody */
/** @typedef {{ok: true, held: boolean} | {ok: false, what: string, fix: string}} Hold */

/** @type {import("./prose-blockers").ReadIssue} */
async function readIssueStrict(ref) {
	const r = await ghGetRetrying(`repos/${ref.repo}/issues/${ref.number}`, {
		strict: true,
	});
	if (!r.ok) return { ok: false, error: r.error };
	const issue = r.out[0];
	return issue ? { ok: true, issue } : { ok: false, error: "empty answer" };
}

/**
 * @param {IssueBody} iss
 * @param {ProseAt} at
 */
async function isHeldWithoutReads(iss, at) {
	if (isGateHolding(iss.body)) return true;
	const local = proseRefsOf(iss.body).filter(
		(r) => !isInOtherRepo(r, at.ownRepo),
	);
	return (await judgeProseRefs(local, at)).open.length > 0;
}

/**
 * @param {IssueBody} iss
 * @param {ProseAt} at
 * @returns {Promise<Hold>}
 */
async function readPaidHold(iss, at) {
	const edges = await ghGetRetrying(
		`repos/{owner}/{repo}/issues/${iss.number}/dependencies/blocked_by`,
		{ strict: true },
	);
	if (!edges.ok)
		return {
			ok: false,
			what: `its blockers are unreadable (${edges.error})`,
			fix: `re-run, or read them yourself: gh api repos/{owner}/{repo}/issues/${iss.number}/dependencies/blocked_by`,
		};
	if (
		edges.out.some((/** @type {{state?: unknown}} */ b) => b.state === "open")
	)
		return { ok: true, held: true };
	const foreign = await judgeProseRefs(
		proseRefsOf(iss.body).filter((r) => isInOtherRepo(r, at.ownRepo)),
		at,
	);
	if (foreign.open.length > 0) return { ok: true, held: true };
	const unread = foreign.unreadable[0];
	if (unread)
		return {
			ok: false,
			what: `its **Blocked on** ${unread.ref.repo}#${unread.ref.number} is unreadable (${unread.error})`,
			fix: `re-run, or read it yourself: gh issue view ${unread.ref.number} --repo ${unread.ref.repo}`,
		};
	return { ok: true, held: false };
}

/**
 * @param {IssueBody} iss
 * @param {ProseAt} at
 * @returns {Promise<Hold>}
 */
async function readHold(iss, at) {
	if (await isHeldWithoutReads(iss, at)) return { ok: true, held: true };
	return readPaidHold(iss, at);
}

/**
 * @param {IssueBody} iss
 * @returns {Promise<Hold>}
 */
async function readOwnHold(iss) {
	const refs = proseRefsOf(iss.body);
	try {
		const ownRepo = refs.some((r) => r.repo) ? ghDefaultRepo() : null;
		const openLocal = refs.some((r) => !isInOtherRepo(r, ownRepo))
			? new Set(ghOpenIssues().map((i) => i.number))
			: new Set();
		return readHold(iss, { openLocal, ownRepo, readIssue: readIssueStrict });
	} catch (e) {
		return {
			ok: false,
			what: `its **Blocked on** issues are unreadable (${e instanceof Error ? e.message.split("\n")[0] : e})`,
			fix: "re-run, or read them yourself: gh issue list --state open",
		};
	}
}

module.exports = {
	isHeldWithoutReads,
	readIssueStrict,
	readOwnHold,
	readPaidHold,
};
