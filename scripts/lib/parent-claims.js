const { heldIssues } = require("./arbiter-issue-claims.js");
const { homeDir, readCheckoutTracking } = require("./refill-repos.js");
const { MAP_LABEL } = require("./issue-gate.js");
const { isInOtherRepo, parseIssueRef, refLabel } = require("./issue-ref.js");

/** @typedef {import("./issue-ref.js").IssueRef} IssueRef */
/** @typedef {ReturnType<typeof heldIssues>} Held */
/** @typedef {Parameters<typeof heldIssues>[0]} Listed */

/** @param {{labels?: (string|{name?: string})[]}|null|undefined} issue */
const isMap = (issue) =>
	(issue?.labels ?? []).some(
		(l) => (typeof l === "string" ? l : l?.name) === MAP_LABEL,
	);

/**
 * @param {Map<string, string>|null|undefined} names
 * @param {string|null|undefined} sessionId
 */
const holderName = (names, sessionId) =>
	(sessionId && names?.get(sessionId)) || String(sessionId).slice(0, 8);

/** @type {Map<string, Held>} */
const storeMemo = new Map();

/**
 * @param {string} root
 * @param {Listed} listed
 */
function storeHeld(root, listed) {
	const held = storeMemo.get(root) ?? heldIssues(listed, root);
	storeMemo.set(root, held);
	return held;
}

/**
 * @param {IssueRef} parent
 * @param {{childRepo: string|null, listed: Listed, hostHeld: Held}} ctx
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
 * @param {number} n
 * @param {{url?: string, labels?: (string|{name?: string})[]} | {error: string} | null} parentRead
 * @param {{childRepo: string|null, listed: Listed, hostHeld: Held}} ctx
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
