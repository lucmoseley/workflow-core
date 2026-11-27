const { SPACE } = require("./gh-body.js");
const {
	REF_FORMS,
	isInOtherRepo,
	refKey,
	scanIssueRefs,
} = require("./issue-ref.js");

const BLOCKED_ON_HEAD = /^[ \t]{0,3}\*\*Blocked on\*\*[ \t]*/gim;
const BLOCKED_ON_REF = /(?:[\w.-]+\/[\w.-]+)?#\d+(?:[ \t]*(?:,|and)[ \t]*)?/iy;

/**
 * @param {string} body
 */
function* blockedOnLists(body) {
	for (const head of body.matchAll(BLOCKED_ON_HEAD)) {
		const start = head.index + head[0].length;
		let end = start;
		BLOCKED_ON_REF.lastIndex = start;
		while (BLOCKED_ON_REF.test(body)) end = BLOCKED_ON_REF.lastIndex;
		if (end > start) yield body.slice(start, end);
	}
}

/* lucmoseley/mantahostels#927 */
const BLOCKED_ON_LINE_RE = /\*\*Blocked on\b[^*]*\*\*[^\n]*/gi;

const NOT_READY_OPENING = new RegExp(
	`^${SPACE}*\\*\\*(Blocked|Refused attempt)`,
);

/**
 * @param {string} body
 * @returns {import("./issue-ref.js").IssueRef[]}
 */
function proseRefsOf(body) {
	/** @type {Map<string, import("./issue-ref.js").IssueRef>} */
	const out = new Map();
	for (const list of blockedOnLists(String(body || "")))
		for (const r of scanIssueRefs(list, REF_FORMS.blocker)) {
			const repo = r.owner === null ? null : `${r.owner}/${r.name}`;
			out.set(refKey({ repo, number: r.number }), { repo, number: r.number });
		}
	return [...out.values()];
}

/** @param {string} body */
function unparsedBlockersOf(body) {
	const out = [];
	for (const m of String(body || "").matchAll(BLOCKED_ON_LINE_RE)) {
		const line = m[0].trim();
		if (!/#\d+/.test(line)) out.push(line);
	}
	return out;
}

/**
 * @typedef {(ref: import("./issue-ref.js").IssueRef) =>
 *   Promise<{ok: true, issue: {state: string}} | {ok: false, error: string}>} ReadIssue
 */

/**
 * @param {import("./issue-ref.js").IssueRef[]} refs
 * @param {object} at
 * @param {Set<number>} at.openLocal
 * @param {string|null} at.ownRepo
 * @param {ReadIssue} at.readIssue
 * @param {<T, R>(items: T[], fn: (item: T) => Promise<R>) => Promise<R[]>} [at.each]
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
	unparsedBlockersOf,
};
