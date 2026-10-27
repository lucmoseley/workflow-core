/*
 * prose-blockers.js — `**Blocked on** #<n>` in an issue body, read and resolved
 * without a second `gh issue view` (mantahostels#1289); and the opening of a
 * not-ready comment, NOT_READY_OPENING.
 *
 * WHY IT EXISTS. GitHub's native dependency edge (`/dependencies/blocked_by`,
 * what `pick-next.js`'s own `blockedBy()` reads) is the readiness source of
 * record. Some issues instead hand-write the same claim in prose, with no
 * native edge to match, and the picker's dependency read never saw it.
 *
 * WHAT IT ANSWERS, AND HOW CHEAPLY. `pick-next.js` already fetches every OPEN
 * issue in one call before this runs. A prose blocker naming a number NOT in
 * that set is a blocker that is closed (or never existed) — resolved for free,
 * no second call. A number still in the open set is still blocking, exactly as
 * a native edge would be. judgeProseRefs answers an `owner/name#<n>` in the
 * same repo the same way; one in another repo costs its caller's issue read
 * (#3271).
 */

/*
 * ANCHORED TO THE HEAD OF ITS OWN LINE, same tolerance as `issue-gate.js`'s
 * `**Gated until:**` (`^[ \t]{0,3}`, CommonMark's un-indented-paragraph rule).
 * NOT anchor-free: a body quoting the marker mid-sentence as an example would
 * otherwise gate itself (mantahostels#1289).
 *
 * One or more `#<n>` or `owner/name#<n>` references, comma- or
 * space-separated (#2427).
 */
const { SPACE } = require("./gh-body.js");
const { requiredGroup } = require("./regex-group.js");
const { isInOtherRepo, refKey } = require("./issue-ref.js");

const BLOCKED_ON_RE =
	/^[ \t]{0,3}\*\*Blocked on\*\*[ \t]*((?:(?:[\w.-]+\/[\w.-]+)?#\d+(?:[ \t]*(?:,|and)[ \t]*)?)+)/gim;
const ISSUE_REF_RE = /(?:([\w.-]+\/[\w.-]+))?#(\d+)/g;

/*
 * DELIBERATELY NOT ANCHORED TO THE LINE HEAD, unlike `BLOCKED_ON_RE` above:
 * mantahostels#927's marker opens mid-sentence, so an anchored match misses the very case
 * this exists for. The anchor is what stops a body QUOTING the marker from
 * gating itself, and dropping it is safe here
 * for two reasons: a quotation of the canonical form carries its `#<n>` and so
 * is filtered out by the number test below, and nothing is ever excluded on an
 * unparsed hit — it is printed for a reader to judge.
 *
 * The bold span is `[^*]*` so it cannot run across a later `**` on the line.
 */
const BLOCKED_ON_LINE_RE = /\*\*Blocked on\b[^*]*\*\*[^\n]*/gi;

/*
 * A comment a launched session leaves on a ticket it found not ready, opening
 * `**Blocked` or `**Refused attempt` (#2309, #3111). check-issue-labels.js
 * reads it off the latest comment, lib/tracker-rules.js off a comment being
 * written. Not global, so `.test` keeps no lastIndex.
 */
const NOT_READY_OPENING = new RegExp(
	`^${SPACE}*\\*\\*(Blocked|Refused attempt)`,
);

/**
 * Every issue a `**Blocked on**` marker in `body` names, in marker order,
 * deduped. `repo` is null for a bare `#<n>`: the body's own repo.
 * @param {string} body
 * @returns {import("./issue-ref.js").IssueRef[]}
 */
function proseRefsOf(body) {
	/** @type {Map<string, import("./issue-ref.js").IssueRef>} */
	const out = new Map();
	for (const m of String(body || "").matchAll(BLOCKED_ON_RE))
		for (const r of requiredGroup(m, 1, BLOCKED_ON_RE).matchAll(ISSUE_REF_RE)) {
			const repo = r[1] ?? null;
			const number = Number(requiredGroup(r, 2, ISSUE_REF_RE));
			out.set(refKey({ repo, number }), { repo, number });
		}
	return [...out.values()];
}

/**
 * Every `**Blocked on ...**` line in `body` that names no issue number, trimmed.
 * @param {string} body
 */
function unparsedBlockersOf(body) {
	const out = [];
	for (const m of String(body || "").matchAll(BLOCKED_ON_LINE_RE)) {
		const line = m[0].trim();
		if (!/#\d+/.test(line)) out.push(line);
	}
	return out;
}

/**
 * The bare `#<n>` numbers a marker names, sorted, split against `openNumbers`
 * (a `Set<number>` of every currently open issue — `pick-next.js`'s own list,
 * at no extra call). `open` is what still blocks; `resolved` is what does not,
 * because the fetched open list does not contain it. `unparsed` is every
 * marker line that named no number at all. An `owner/name#<n>` reference is
 * judgeProseRefs's to answer.
 * @param {string} body
 * @param {Set<number>} openNumbers
 */
function resolveProseBlockers(body, openNumbers) {
	const named = proseRefsOf(body)
		.filter((r) => r.repo === null)
		.map((r) => r.number)
		.sort((a, b) => a - b);
	return {
		named,
		open: named.filter((n) => openNumbers.has(n)),
		resolved: named.filter((n) => !openNumbers.has(n)),
		unparsed: unparsedBlockersOf(body),
	};
}

/**
 * @typedef {(ref: import("./issue-ref.js").IssueRef) =>
 *   Promise<{ok: true, issue: {state: string}} | {ok: false, error: string}>} ReadIssue
 */

/**
 * `refs` split by state, each list in input order. A reference in `ownRepo`,
 * bare or `owner/name#<n>`, is answered from `openLocal` at no read; one in
 * another repo costs one `readIssue`. What an unreadable one means is its
 * caller's: lib/blocker-graph.js holds on it, check-issue-labels.js warns.
 * @param {import("./issue-ref.js").IssueRef[]} refs
 * @param {object} at
 * @param {Set<number>} at.openLocal every open issue in `ownRepo`
 * @param {string|null} at.ownRepo
 * @param {ReadIssue} at.readIssue
 * @param {<T, R>(items: T[], fn: (item: T) => Promise<R>) => Promise<R[]>} [at.each]
 *   bounded fan-out, results in input order; unbounded where absent
 */
async function judgeProseRefs(refs, { openLocal, ownRepo, readIssue, each }) {
	const fanOut = each ?? ((items, fn) => Promise.all(items.map(fn)));
	const verdicts = await fanOut(refs, async (ref) => {
		if (!isInOtherRepo(ref, ownRepo))
			return { ref, open: openLocal.has(ref.number), error: null };
		const r = await readIssue(ref);
		return r.ok
			? { ref, open: r.issue.state === "open", error: null }
			: { ref, open: false, error: r.error };
	});
	/** @type {ReturnType<typeof proseRefsOf>} */
	const open = [];
	/** @type {ReturnType<typeof proseRefsOf>} */
	const closed = [];
	/** @type {{ref: import("./issue-ref.js").IssueRef, error: string}[]} */
	const unreadable = [];
	for (const v of verdicts) {
		if (v.error === null) (v.open ? open : closed).push(v.ref);
		else unreadable.push({ ref: v.ref, error: v.error });
	}
	return { open, closed, unreadable };
}

module.exports = {
	NOT_READY_OPENING,
	judgeProseRefs,
	proseRefsOf,
	resolveProseBlockers,
};
