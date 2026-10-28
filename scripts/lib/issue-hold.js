/*
 * issue-hold.js — whether anything pick-next.js skips a ticket on holds it:
 * an active `**Gated until:**` or well-formed `**Gated on:**` line, an open
 * native blocked-by edge, or an open `**Blocked on**` issue (#3263, #3293).
 * `rule:blocked-ticket-gate` names the two a not-ready ticket owes; this
 * accepts all four, as the shortlist does.
 */

const { ghDefaultRepo, ghGetRetrying, ghOpenIssues } = require("./gh");
const { resolveGate } = require("./issue-gate");
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
 * Whether what costs no read holds `iss`: a gate line, or an open
 * `**Blocked on**` issue in `at.ownRepo`.
 * @param {IssueBody} iss
 * @param {ProseAt} at
 */
async function isHeldWithoutReads(iss, at) {
	const gates = resolveGate(iss.body);
	if (gates.gateHolds || gates.gateOnHolds) return true;
	const local = proseRefsOf(iss.body).filter(
		(r) => !isInOtherRepo(r, at.ownRepo),
	);
	return (await judgeProseRefs(local, at)).open.length > 0;
}

/**
 * Whether what isHeldWithoutReads leaves holds `iss`: an open native edge,
 * or an open `**Blocked on**` issue in another repo. Every read is strict:
 * an empty answer would read as no blocker. An unreadable `**Blocked on**`
 * issue refuses only where nothing else holds; where lib/blocker-graph.js
 * holds on it, this refuses (#3262).
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
 * Whether anything the shortlist skips on holds `iss`, paying reads last.
 * @param {IssueBody} iss
 * @param {ProseAt} at
 * @returns {Promise<Hold>}
 */
async function readHold(iss, at) {
	if (await isHeldWithoutReads(iss, at)) return { ok: true, held: true };
	return readPaidHold(iss, at);
}

/**
 * readHold for an issue in the current repo.
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
