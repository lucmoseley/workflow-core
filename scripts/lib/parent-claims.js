/*
 * parent-claims.js — whether a live session holds an arbiter claim on an
 * issue's parent, in whichever repo that parent lives (#2310, spec #2245).
 *
 * A charting session holds its map from the moment it files it, so a ticket
 * under a claimed map is still being wired and is not to be launched (#2211).
 * Only a `wayfinder:map` parent holds its children: a spec's claimant is
 * filing tickets for others to take, so its claim holds nothing.
 *
 * A PARENT IN ANOTHER REPO is read from that repo's own claim store: the main
 * checkout under the home directory whose `tracker` is that repo. Where no
 * checkout tracks it, or its store will not read, the answer is a `why` and
 * the caller passes the ticket with a WARN, the gate's fail-open stance.
 *
 * Each store is read once a process, through heldIssues, so its liveness and
 * keep-on-doubt rules are the ones a ticket's own claim is read by.
 */

const { heldIssues } = require("./arbiter-issue-claims.js");
const { homeDir, readCheckoutTracking } = require("./refill-repos.js");
const { MAP_LABEL } = require("./issue-gate.js");
const { isInOtherRepo, parseIssueRef, refLabel } = require("./issue-ref.js");

/** @typedef {import("./issue-ref.js").IssueRef} IssueRef */
/** @typedef {ReturnType<typeof heldIssues>} Held */
/** @typedef {Parameters<typeof heldIssues>[0]} Listed */

/**
 * Whether an API issue is a wayfinder map, its labels as the API gives them.
 * @param {{labels?: (string|{name?: string})[]}|null|undefined} issue
 */
const isMap = (issue) =>
	(issue?.labels ?? []).some(
		(l) => (typeof l === "string" ? l : l?.name) === MAP_LABEL,
	);

/**
 * A session for a reader: its listed name, else the first 8 characters of its
 * id, the length a job directory's own short id takes.
 * @param {Map<string, string>|null|undefined} names session id -> name
 * @param {string|null|undefined} sessionId
 */
const holderName = (names, sessionId) =>
	(sessionId && names?.get(sessionId)) || String(sessionId).slice(0, 8);

/** @type {Map<string, Held>} */
const storeMemo = new Map();

/**
 * heldIssues over `root`'s claim store.
 * @param {string} root
 * @param {Listed} listed
 */
function storeHeld(root, listed) {
	const held = storeMemo.get(root) ?? heldIssues(listed, root);
	storeMemo.set(root, held);
	return held;
}

/**
 * The live claim on `parent`, as `{sessionId, kept}`; null where none stands;
 * `{why}` where the parent's store could not be read.
 * `kept` is heldIssues' own: the holder was kept on doubt about liveness.
 * @param {IssueRef} parent
 * @param {{childRepo: string|null, listed: Listed, hostHeld: Held}} ctx
 *   `childRepo` is the repo the candidate lives in; `hostHeld` its store's
 *   heldIssues, which a same-repo parent is read from.
 * @returns {{sessionId: string, kept: boolean} | {why: string} | null}
 */
function parentClaim(parent, ctx) {
	const label = refLabel(parent, ctx.childRepo);
	let held = ctx.hostHeld;
	if (parent.repo && isInOtherRepo(parent, ctx.childRepo)) {
		const checkout = readCheckoutTracking(parent.repo, homeDir());
		if ("why" in checkout)
			return {
				why: `${checkout.why}, so the claim on parent ${label} was not read`,
			};
		held = storeHeld(checkout.root, ctx.listed);
		// A store read in part may have dropped this very parent's record.
		if (held.why && !held.kept && !held.held.has(parent.number))
			return { why: `the claim on parent ${label} was not read: ${held.why}` };
	}
	const sessionId = held.held.get(parent.number);
	return sessionId ? { sessionId, kept: held.kept } : null;
}

/**
 * @typedef {{state: "claimed", label: string, sessionId: string, kept: boolean}
 *   | {state: "unread", why: string}
 *   | {state: "free"}} ParentVerdict
 */

/**
 * Whether issue `n` is held through its parent map, from the caller's read of
 * its parent: the `issues/<n>/parent` payload, null where it has none, or
 * `{error}` where the read failed. A caller may answer from data it already
 * holds, so long as the payload carries the parent's url and labels.
 * @param {number} n
 * @param {{url?: string, labels?: (string|{name?: string})[]} | {error: string} | null} parentRead
 * @param {{childRepo: string|null, listed: Listed, hostHeld: Held}} ctx as parentClaim's
 * @returns {ParentVerdict}
 */
function parentVerdictOf(n, parentRead, ctx) {
	if (!parentRead) return { state: "free" };
	if ("error" in parentRead)
		return {
			state: "unread",
			why: `the parent of #${n} could not be read (${parentRead.error}), so a claim on it was not checked`,
		};
	const ref = parseIssueRef(parentRead.url);
	if (!ref)
		return {
			state: "unread",
			why: `the parent of #${n} named no issue (${parentRead.url})`,
		};
	if (!isMap(parentRead)) return { state: "free" };
	const claim = parentClaim(ref, ctx);
	if (!claim) return { state: "free" };
	if ("why" in claim) return { state: "unread", why: claim.why };
	return {
		state: "claimed",
		label: refLabel(ref, ctx.childRepo),
		...claim,
	};
}

module.exports = {
	holderName,
	parentVerdictOf,
};
