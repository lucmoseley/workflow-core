/*
 * goal-set.js — the open issues a goal names, worked out afresh from one
 * shortlist run's own reads (workflow-core#3866, ruling workflow-core#2524), and the numbers its tier
 * ranks on.
 *
 * A CORE: it reads nothing but its arguments, the checkout lookup included.
 */

const { holdersOf } = require("./blocker-graph.js");
const {
	isInOtherRepo,
	parseIssueRef,
	refKey,
	refLabel,
} = require("./issue-ref.js");

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

/**
 * A goal resolved for one run: its open members and the numbers its tier ranks
 * on, with a `notice` for stderr; or a `refusal`, which the shell turns into
 * exit 2.
 * @typedef {{members: import("./refill-goal.js").GoalMember[], ranked: number[], notice: string|null} | {refusal: string}} ResolvedGoal
 */

/**
 * The goal's open members, and the numbers its tier ranks on: `drain` as the
 * ref's open descendants, `unblock` as the ref and everything holding it out,
 * children and other repos' blockers included, which take its tier by
 * inheritance. A ref to a checkout gone from this machine ranks nothing. An
 * `unblock` or issue list in another repo is refused: that repo's run walks it.
 * @template {{number: number, title: string, parent?: string|null}} I
 * @param {ReturnType<typeof import("./refill-goal.js").parseGoalForm>} ask
 * @param {I[]} issues every open issue in the graph's own repo
 * @param {import("./blocker-graph.js").Graph} graph
 * @param {(ref: import("./refill-goal.js").AskedRef, ownRepo: string|null) => string|null|undefined} repoOf
 *   the repo a typed ref's checkout tracks; undefined where no checkout bears the name
 * @returns {ResolvedGoal|null}
 */
function resolveGoal(ask, issues, graph, repoOf) {
	if (ask === null) return null;
	const { ownRepo } = graph;
	/**
	 * The ref's issue, or nothing ranked where its checkout is gone.
	 * @param {import("./refill-goal.js").AskedRef} asked
	 * @returns {IssueRef|ResolvedGoal}
	 */
	const locate = ({ repo: name, number }) => {
		const repo = repoOf({ repo: name, number }, ownRepo);
		return repo === undefined
			? {
					members: [],
					ranked: [],
					notice: `--goal names ${name}#${number}: no checkout named ${name}`,
				}
			: { repo, number };
	};
	/** @param {IssueRef} ref @returns {ResolvedGoal} */
	const refuse = (ref) => ({
		refusal: `--goal names ${refLabel(ref, ownRepo)}, another repo's: run it there`,
	});
	/** @param {I} i */
	const memberOf = (i) => ({
		repo: ownRepo,
		number: i.number,
		title: i.title,
	});
	if (ask.form !== "issues") {
		const ref = locate(ask.ref);
		if (!("number" in ref)) return ref;
		if (ask.form === "drain") {
			const members = openDescendants(issues, ref, ownRepo).map(memberOf);
			return { members, ranked: members.map((m) => m.number), notice: null };
		}
		if (isInOtherRepo(ref, ownRepo)) return refuse(ref);
		const titles = new Map(issues.map((i) => [i.number, i.title]));
		const members = holdersOf(graph, refKey(ref)).map(
			({ served, ref: holder, info }) => ({
				repo: holder.repo,
				number: holder.number,
				title: (served ? titles.get(holder.number) : info?.title) ?? null,
			}),
		);
		return { members, ranked: [ref.number], notice: null };
	}
	/** @type {IssueRef[]} */
	const refs = [];
	for (const asked of ask.refs) {
		const ref = locate(asked);
		if (!("number" in ref)) return ref;
		refs.push(ref);
	}
	const elsewhere = refs.find((r) => isInOtherRepo(r, ownRepo));
	if (elsewhere) return refuse(elsewhere);
	const ranked = refs.map((r) => r.number);
	return {
		members: issues.filter((i) => ranked.includes(i.number)).map(memberOf),
		ranked,
		notice: null,
	};
}

module.exports = { openDescendants, resolveGoal };
