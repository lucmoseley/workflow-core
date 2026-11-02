/*
 * refill-goal.js — the refill loop's one loop-wide goal (#3864, spec #3596): the
 * form it was typed in, the text as typed, the repo-qualified issues it names
 * and when it was set. Its issues rank first in every ticked repo's frontier
 * read. A topic's refs are the set confirmed when it was resolved, and stay as
 * stored until the next `set`.
 *
 * A CORE: it reads nothing but its arguments. Whether a ref names an open issue
 * is refill-loop.js's `set` to read.
 */

const path = require("node:path");

/**
 * An issue the goal names; `repo`, its checkout's directory name.
 * @typedef {{repo: string, number: number}} GoalRef
 * @typedef {{repo: string|null, number: number}} AskedRef a ref as typed, `repo`
 *   null for a bare `#N`
 * @typedef {"issues"|"drain"|"unblock"|"topic"} GoalForm
 * @typedef {object} Goal
 * @property {GoalForm} form
 * @property {string} text as typed
 * @property {GoalRef[]} refs
 * @property {number} setAt ms; 0 on a goal from before this was kept
 */

/** @type {readonly GoalForm[]} */
const FORMS = ["issues", "drain", "unblock", "topic"];

/** @param {unknown} raw @returns {raw is Record<string, unknown>} */
const isRecord = (raw) => typeof raw === "object" && raw !== null;

/** @param {{repo: string|null, number: number}} ref */
const buildRefText = ({ repo, number }) => `${repo ?? ""}#${number}`;

/**
 * Each ref of a comma- or space-separated list: `N`, `#N` or `<repo>#N`. Null
 * where a word is none of them, or there are no words.
 * @param {string} text
 * @returns {AskedRef[]|null}
 */
function parseAskedRefs(text) {
	const words = text.split(/[,\s]+/).filter(Boolean);
	const refs = words.flatMap((word) => {
		const m = word.match(/^(?:([^#/]+)?#)?([1-9]\d*)$/);
		return m ? [{ repo: m[1] ?? null, number: Number(m[2]) }] : [];
	});
	return refs.length > 0 && refs.length === words.length ? refs : null;
}

/**
 * The refs in `roots`' repos, or why one is refused: a bare `#N` needs exactly
 * one repo ticked, and a named repo must be ticked.
 * @param {AskedRef[]} asked
 * @param {string[]} roots the ticked checkout roots
 * @returns {GoalRef[]|string}
 */
function qualifyRefs(asked, roots) {
	const names = roots.map((root) => path.basename(root));
	/** @type {Map<string, GoalRef>} */
	const refs = new Map();
	for (const { repo, number } of asked) {
		const name = repo ?? (names.length === 1 ? names[0] : undefined);
		if (name === undefined)
			return `#${number} names no repo with ${names.length} repos ticked: write <repo>#${number}`;
		if (!names.includes(name))
			return `${name}#${number} is in ${name}, which is not ticked: tick ${name} first`;
		refs.set(`${name}#${number}`, { repo: name, number });
	}
	return [...refs.values()];
}

/**
 * The goal's issues in the checkout at `root`.
 * @param {Goal|null} goal
 * @param {string} root
 * @returns {number[]}
 */
const goalNumbersIn = (goal, root) =>
	(goal?.refs ?? [])
		.filter((ref) => ref.repo === path.basename(root))
		.map((ref) => ref.number);

/**
 * Whether two goals say the same, whenever each was set.
 * @param {Goal|null} a
 * @param {Pick<Goal, "form" | "text" | "refs">} b
 */
const isSameGoal = (a, b) =>
	a !== null &&
	a.form === b.form &&
	a.text === b.text &&
	a.refs.map(buildRefText).join() === b.refs.map(buildRefText).join();

/** @param {Goal|null} goal */
const buildGoalLine = (goal) =>
	`goal:      ${goal ? `${goal.form} "${goal.text}": ${goal.refs.map(buildRefText).join(", ")}` : "none"}`;

/**
 * @param {unknown} raw
 * @returns {GoalRef[]}
 */
function parseRefs(raw) {
	return (Array.isArray(raw) ? raw : []).flatMap((r) =>
		isRecord(r) && typeof r.repo === "string" && Number.isInteger(r.number)
			? [{ repo: r.repo, number: /** @type {number} */ (r.number) }]
			: [],
	);
}

/**
 * The scope's per-checkout `goals` of a file from before #3864, as one goal. A
 * stopgap: #3933 removes it.
 * @param {Record<string, unknown>} goals keyed by checkout root
 * @returns {Goal|null}
 */
function parseGoalsByRoot(goals) {
	const refs = Object.entries(goals).flatMap(([root, issues]) =>
		(Array.isArray(issues) ? issues : [])
			.filter(Number.isInteger)
			.map((number) => ({ repo: path.basename(root), number })),
	);
	if (refs.length === 0) return null;
	return {
		form: "issues",
		text: refs.map(buildRefText).join(","),
		refs,
		setAt: 0,
	};
}

/**
 * The control file's goal: none where it is absent, garbled or names no issue,
 * so a garbled goal leaves the loop running bare.
 * @param {Record<string, unknown>} scope the raw scope
 * @returns {Goal|null}
 */
function parseGoal({ goal, goals }) {
	if (goal === undefined && isRecord(goals)) return parseGoalsByRoot(goals);
	if (!isRecord(goal)) return null;
	const form = FORMS.find((f) => f === goal.form);
	const refs = parseRefs(goal.refs);
	if (form === undefined || refs.length === 0) return null;
	return {
		form,
		text: typeof goal.text === "string" ? goal.text : "",
		refs,
		setAt: typeof goal.setAt === "number" ? goal.setAt : 0,
	};
}

module.exports = {
	buildGoalLine,
	buildRefText,
	goalNumbersIn,
	isSameGoal,
	parseAskedRefs,
	parseGoal,
	qualifyRefs,
};
