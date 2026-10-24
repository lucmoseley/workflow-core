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
const { adopterCheckouts, homeDir } = require("./refill-repos.js");
const { resolveKey } = require("./workflow-core-config.js");
const { caught } = require("./caught.js");
const { MAP_LABEL } = require("./issue-gate.js");

/** @param {unknown} e */
const errMessage = (e) => caught(e).code || caught(e).message;

/** @typedef {{repo: string|null, number: number}} IssueRef */
/** @typedef {ReturnType<typeof heldIssues>} Held */
/** @typedef {Parameters<typeof heldIssues>[0]} Listed */

/**
 * The issue an API issue URL names. `repo` is null where the URL carries no
 * `/repos/<owner>/<name>/` part, read as the candidate's own repo.
 * @param {string|null|undefined} url
 * @returns {IssueRef|null}
 */
function issueRef(url) {
	if (!url) return null;
	const m = String(url).match(/\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/?$/);
	if (m) return { repo: m[1] ?? null, number: Number(m[2]) };
	const n = Number(String(url).split("/").pop());
	return Number.isInteger(n) && n > 0 ? { repo: null, number: n } : null;
}

/**
 * `owner/name` from a `repository_url`, or null.
 * @param {string|null|undefined} url
 */
function repoOfUrl(url) {
	const m = url ? String(url).match(/\/repos\/([^/]+\/[^/]+)\/?$/) : null;
	return m?.[1] ?? null;
}

/**
 * Whether an API issue is a wayfinder map, its labels as the API gives them.
 * @param {{labels?: (string|{name?: string})[]}|null|undefined} issue
 */
const isMap = (issue) =>
	(issue?.labels ?? []).some(
		(l) => (typeof l === "string" ? l : l?.name) === MAP_LABEL,
	);

/** @param {string|null} a @param {string|null} b */
const isSameRepo = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Whether `ref` lives in a repo other than `childRepo`. A ref naming no repo
 * is the child's own.
 * @param {IssueRef} ref
 * @param {string|null} childRepo
 */
const isInOtherRepo = (ref, childRepo) =>
	!!ref.repo && !isSameRepo(ref.repo, childRepo);

/**
 * How a reader sees `ref` from an issue in `childRepo`: `#n` in the same repo,
 * `owner/name#n` in another.
 * @param {IssueRef} ref
 * @param {string|null} childRepo
 */
const refLabel = (ref, childRepo) =>
	isInOtherRepo(ref, childRepo)
		? `${ref.repo}#${ref.number}`
		: `#${ref.number}`;

/**
 * One key per issue across repos, case-folded as GitHub folds a repo name; a
 * ref naming no repo keys as `#n`.
 * @param {IssueRef} ref
 */
const refKey = (ref) => `${(ref.repo ?? "").toLowerCase()}#${ref.number}`;

/**
 * A session for a reader: its listed name, else the first 8 characters of its
 * id, the length a job directory's own short id takes.
 * @param {Map<string, string>|null|undefined} names session id -> name
 * @param {string|null|undefined} sessionId
 */
const sessionName = (names, sessionId) =>
	(sessionId && names?.get(sessionId)) || String(sessionId).slice(0, 8);

/**
 * The tracker of the host checkout, where the candidates' own claims live.
 * @param {string} [root]
 */
function hostTracker(root) {
	const tracker = resolveKey("tracker", root ? { root } : {});
	return typeof tracker === "string" ? tracker : null;
}

/** @type {Map<string, {root: string} | {why: string}>} */
const checkoutMemo = new Map();

/**
 * The main checkout under `home` whose tracker is `repo`, as `{root}`, or
 * `{why}` where none tracks it or `home` will not read.
 * @param {string} repo
 * @param {string} home
 * @returns {{root: string} | {why: string}}
 */
function checkoutOf(repo, home) {
	const key = `${home}\0${repo.toLowerCase()}`;
	const memo = checkoutMemo.get(key);
	if (memo) return memo;
	/** @type {{root: string} | {why: string}} */
	let found;
	try {
		const root = adopterCheckouts(home).included.find((r) =>
			isSameRepo(hostTracker(r), repo),
		);
		found = root
			? { root }
			: { why: `no checkout under ${home} tracks ${repo}` };
	} catch (e) {
		found = { why: `${home} could not be read (${errMessage(e)})` };
	}
	checkoutMemo.set(key, found);
	return found;
}

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
		const checkout = checkoutOf(parent.repo, homeDir());
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

module.exports = {
	checkoutOf,
	hostTracker,
	isInOtherRepo,
	isMap,
	issueRef,
	parentClaim,
	refKey,
	refLabel,
	repoOfUrl,
	sessionName,
};
