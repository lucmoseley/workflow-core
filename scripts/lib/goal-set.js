/*
 * goal-set.js — the open issues a `drain` or `unblock` goal names, worked out
 * afresh from one shortlist run's own reads (#3866, ruling #2524). pick-next.js
 * calls it for `--goal 'drain <ref>'` and `--goal 'unblock <ref>'`, whether a
 * /pick-next run or the refill loop's tick passed the text.
 *
 * A CORE: it reads nothing but its arguments.
 */

const { parseIssueRef, refKey } = require("./issue-ref.js");

/** @typedef {import("./issue-ref.js").IssueRef} IssueRef */

/**
 * The open issues of `issues` descending from `target` through parent links.
 * `target` may be in another repo: a child here whose parent is there counts. A
 * chain leaving this repo part way down is not followed, and neither is one
 * through a closed parent, as neither parent is on this repo's open list.
 * @template {{number: number, parent?: string|null}} I
 * @param {I[]} issues every open issue in `ownRepo`
 * @param {IssueRef} target
 * @param {string|null} ownRepo
 * @returns {I[]} in list order
 */
function openDescendants(issues, target, ownRepo) {
	/** @type {Map<string, I[]>} parent's key -> its open children here */
	const children = new Map();
	for (const issue of issues) {
		const parent = parseIssueRef(issue.parent);
		if (parent === null) continue;
		const key = refKey({ repo: parent.repo ?? ownRepo, number: parent.number });
		children.set(key, [...(children.get(key) ?? []), issue]);
	}
	/** @type {Set<I>} */
	const found = new Set();
	const stack = [...(children.get(refKey(target)) ?? [])];
	for (let issue = stack.pop(); issue !== undefined; issue = stack.pop()) {
		if (found.has(issue)) continue;
		found.add(issue);
		stack.push(
			...(children.get(refKey({ repo: ownRepo, number: issue.number })) ?? []),
		);
	}
	return issues.filter((issue) => found.has(issue));
}

module.exports = { openDescendants };
