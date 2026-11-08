/*
 * refill-goal.js — the refill loop's one loop-wide goal (workflow-core#3864, spec workflow-core#3596). Its
 * issues rank first in every served repo's frontier read. A topic's refs are the
 * set confirmed when it was resolved, and stay as stored until the next `set`.
 * A `drain` or `unblock` is stored as its one ref and worked out again by every
 * frontier read (workflow-core#3866).
 *
 * A CORE: it reads nothing but its arguments.
 */

const path = require("node:path");
const { refKey } = require("./issue-ref.js");
const { buildNotice, isNotice } = require("./refill-notice.js");

/** @typedef {import("./refill-notice.js").Notice} Notice */

/**
 * An issue the goal names; `repo`, its checkout's directory name.
 * @typedef {{repo: string, number: number}} GoalRef
 * @typedef {{repo: string|null, number: number}} AskedRef a ref as typed, `repo`
 *   null for a bare `#N`
 * @typedef {"issues"|"drain"|"unblock"|"topic"} GoalForm
 * @typedef {{form: "issues", refs: AskedRef[]}|{form: "drain"|"unblock", ref: AskedRef}}
 *   AskedGoal a typed goal: a walk names one ref
 * @typedef {object} Goal
 * @property {GoalForm} form
 * @property {string} text as typed
 * @property {GoalRef[]} refs
 * @property {number} setAt ms; 0 where unset
 * @typedef {{state: string}|{unread: string}} IssueRead an issue's state, or why
 *   it would not read
 * @typedef {{repo: string|null, number: number, title: string|null}} GoalMember
 *   an open issue the goal names; `repo`, its `owner/name`
 * @typedef {{members: GoalMember[]}} ShortlistGoal what one checkout's shortlist
 *   found of the goal
 * @typedef {object} GoalRead what one tick's frontier read found of the goal
 * @property {number} setAt the goal it read
 * @property {GoalMember[]} set
 * @property {number} takeable
 * @property {number} running
 * @property {boolean} complete whether every shortlist that could name a member
 *   read, without which an empty set finishes nothing
 * @typedef {Omit<GoalRead, "complete"> & {readAt: number, doneAt: number|null}}
 *   GoalProgress the last read's counts, kept in the loop's state
 */

/** @type {readonly GoalForm[]} */
const FORMS = ["issues", "drain", "unblock", "topic"];

/** @param {unknown} raw @returns {raw is Record<string, unknown>} */
const isRecord = (raw) => typeof raw === "object" && raw !== null;

/** @param {unknown} raw */
const parseStrings = (raw) =>
	Array.isArray(raw) ? raw.filter((s) => typeof s === "string") : [];

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
 * The ticked roots the loop serves, and why each other ticked root is not.
 * @typedef {ReturnType<import("./refill-loop.js")["scopeRoots"]>} Served
 */

/**
 * The refs in `served`'s repos, or why one is refused: a bare `#N` needs exactly
 * one repo served, and a named repo must be ticked and served — the set the
 * panel counts "on".
 * @param {AskedRef[]} asked
 * @param {Served} served
 * @returns {GoalRef[]|Notice}
 */
function qualifyRefs(asked, { roots, dropped }) {
	const names = roots.map((root) => path.basename(root));
	/** @type {Map<string, GoalRef>} */
	const refs = new Map();
	for (const { repo, number } of asked) {
		const name = repo ?? (names.length === 1 ? names[0] : undefined);
		if (name === undefined)
			return buildNotice(
				`#${number} names no repo with ${names.length} repos served`,
				`write <repo>#${number}`,
			);
		const unserved = dropped.find((d) => path.basename(d.root) === name);
		if (unserved)
			return buildNotice(
				`${name}#${number} is in ${name}, which the loop does not serve: ${unserved.why}`,
				"name an issue in a served repo",
				name,
			);
		if (!names.includes(name))
			return buildNotice(
				`${name}#${number} is in ${name}, which is not ticked`,
				`tick ${name} first`,
				name,
			);
		refs.set(`${name}#${number}`, { repo: name, number });
	}
	return [...refs.values()];
}

/**
 * A goal as typed: `drain <ref>`, `unblock <ref>`, or a list of refs.
 * @param {string} text
 * @returns {AskedGoal|null} null where it is none of them
 */
function parseGoalForm(text) {
	const walk = text.trim().match(/^(drain|unblock)\s+(\S+)$/);
	const refs = parseAskedRefs(walk?.[2] ?? text);
	if (refs === null) return null;
	const form = walk?.[1];
	if (form !== "drain" && form !== "unblock") return { form: "issues", refs };
	const [ref, ...more] = refs;
	return ref && more.length === 0 ? { form, ref } : null;
}

/** @param {string} typed what `parseGoalForm` could not read */
const buildGoalRefusal = (typed) =>
	`--goal takes issue refs, #N or <dir>#N, or drain or unblock with one: ${typed}`;

/**
 * `qualifyRefs`, each ref then read as an open issue.
 * @param {AskedRef[]} asked
 * @param {Served} served
 * @param {(ref: GoalRef) => IssueRead} readIssue
 * @returns {GoalRef[]|Notice}
 */
function qualifyOpenRefs(asked, served, readIssue) {
	const refs = qualifyRefs(asked, served);
	if (isNotice(refs)) return refs;
	for (const ref of refs) {
		const read = readIssue(ref);
		if ("unread" in read)
			return buildNotice(
				`${buildRefText(ref)} will not read as an open issue: ${read.unread}`,
			);
		if (read.state !== "OPEN")
			return buildNotice(
				`${buildRefText(ref)} is ${read.state.toLowerCase()}`,
				"name an open issue",
			);
	}
	return refs;
}

/**
 * The `--goal` a shortlist in the checkout at `root` takes, null for none. A
 * `drain` goes to every checkout, as a child may be in another repo from its
 * parent. An `unblock` goes to its ref's own, whose blocker walk crosses repos.
 * @param {Goal|null} goal
 * @param {string} root
 * @returns {string|null}
 */
function buildShortlistGoal(goal, root) {
	if (goal === null) return null;
	if (goal.form === "drain")
		return `drain ${goal.refs.map(buildRefText).join(" ")}`;
	const here = goal.refs
		.filter((ref) => ref.repo === path.basename(root))
		.map((ref) => ref.number);
	const [first] = here;
	if (first === undefined) return null;
	return goal.form === "unblock" ? `unblock #${first}` : here.join(",");
}

/**
 * The members the shortlists name, once each, and how many of those are on the
 * merged frontier or held by a live session.
 * @param {Goal|null} goal
 * @param {{root: string, repo: string|null, goalSet: ShortlistGoal|null, running: number[]}[]} reads
 *   the shortlists that read
 * @param {{failed: number, frontier: {root: string, number: number}[]}} merged
 * @returns {GoalRead|null}
 */
function buildGoalRead(goal, reads, { failed, frontier }) {
	if (goal === null) return null;
	const repoOf = new Map(reads.map((r) => [r.root, r.repo]));
	const onFrontier = new Set(
		frontier.map((row) =>
			refKey({ repo: repoOf.get(row.root) ?? null, number: row.number }),
		),
	);
	const held = new Set(
		reads.flatMap((r) =>
			r.running.map((number) => refKey({ repo: r.repo, number })),
		),
	);
	/** @type {Map<string, GoalMember>} */
	const members = new Map();
	for (const member of reads.flatMap((r) => r.goalSet?.members ?? []))
		members.set(refKey(member), member);
	const keys = [...members.keys()];
	const readNames = reads.map((r) => path.basename(r.root));
	return {
		setAt: goal.setAt,
		set: [...members.values()],
		takeable: keys.filter((k) => onFrontier.has(k)).length,
		running: keys.filter((k) => held.has(k)).length,
		complete:
			failed === 0 && goal.refs.every((ref) => readNames.includes(ref.repo)),
	};
}

/**
 * The state's goal progress after a frontier read. A goal finishes at the first
 * complete read with no open issue, keeps that time while none reopens, and
 * revives at the first read with one.
 * @param {GoalProgress|null} before
 * @param {GoalRead|null} read
 * @param {number} now
 * @returns {GoalProgress|null}
 */
function buildGoalProgress(before, read, now) {
	if (read === null) return null;
	const { complete, ...counts } = read;
	const doneBefore = before?.setAt === read.setAt ? before.doneAt : null;
	return {
		...counts,
		readAt: now,
		doneAt:
			read.set.length > 0 ? null : (doneBefore ?? (complete ? now : null)),
	};
}

/**
 * `status --json`'s goal: as stored, with the last read's set and counts, null
 * until a read reaches it.
 * @param {Goal|null} goal
 * @param {GoalProgress|null} progress
 */
function buildGoalStatus(goal, progress) {
	if (goal === null) return null;
	const read = goalProgressOf(goal, progress);
	return {
		...goal,
		set: read?.set ?? null,
		open: read?.set.length ?? null,
		takeable: read?.takeable ?? null,
		running: read?.running ?? null,
		readAt: read?.readAt ?? null,
		doneAt: read?.doneAt ?? null,
	};
}

/**
 * `progress`, where it is this goal's.
 * @param {Goal|null} goal
 * @param {GoalProgress|null} progress
 * @returns {GoalProgress|null}
 */
const goalProgressOf = (goal, progress) =>
	goal !== null && progress?.setAt === goal.setAt ? progress : null;

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

/**
 * What the goal has come to, nothing until a read reaches it.
 * @param {{set: GoalMember[]|null, takeable: number|null, running: number|null,
 *   doneAt: number|null}|null} progress `GoalProgress`, or `buildGoalStatus`'s goal
 * @param {(at: number) => string} [showTime]
 */
function buildProgressText(
	progress,
	showTime = (at) => new Date(at).toISOString(),
) {
	if (!progress?.set) return "";
	const { doneAt, set, takeable, running } = progress;
	return doneAt === null
		? ` — ${set.length} open, ${takeable} takeable, ${running} running`
		: ` — done ${showTime(doneAt)}; running bare`;
}

/**
 * @param {Goal|null} goal
 * @param {GoalProgress|null} [progress] the state's, where the caller read it
 */
const buildGoalLine = (goal, progress = null) =>
	`goal:      ${goal ? `${goal.form} "${goal.text}": ${goal.refs.map(buildRefText).join(", ")}${buildProgressText(goalProgressOf(goal, progress))}` : "none"}`;

/**
 * @param {unknown} raw
 * @returns {GoalRef[]|null} null where any ref is garbled
 */
function parseRefs(raw) {
	if (!Array.isArray(raw)) return null;
	const refs = raw.flatMap((r) =>
		isRecord(r) && typeof r.repo === "string" && Number.isInteger(r.number)
			? [{ repo: r.repo, number: /** @type {number} */ (r.number) }]
			: [],
	);
	return refs.length === raw.length ? refs : null;
}

/** @param {unknown} raw @returns {raw is GoalMember} */
const isGoalMember = (raw) =>
	isRecord(raw) &&
	Number.isInteger(raw.number) &&
	(typeof raw.repo === "string" || raw.repo === null) &&
	(typeof raw.title === "string" || raw.title === null);

/**
 * The state file's goal progress: none where it is absent or garbled, which the
 * next frontier read rewrites.
 * @param {unknown} raw
 * @returns {GoalProgress|null}
 */
function parseGoalProgress(raw) {
	if (!isRecord(raw) || !Array.isArray(raw.set)) return null;
	const { setAt, takeable, running, readAt, doneAt } = raw;
	const set = raw.set.filter(isGoalMember);
	return set.length === raw.set.length &&
		typeof setAt === "number" &&
		typeof takeable === "number" &&
		typeof running === "number" &&
		typeof readAt === "number"
		? {
				setAt,
				set,
				takeable,
				running,
				readAt,
				doneAt: typeof doneAt === "number" ? doneAt : null,
			}
		: null;
}

/**
 * The control file's goal: none where it is absent, garbled or names no issue.
 * Fails open (workflow-core#3864): a garbled goal costs its ranking, where stopping the loop
 * as control-damaged would cost every launch. readControlChecked logs it.
 * @param {Record<string, unknown>} scope the raw scope
 * @returns {Goal|null}
 */
function parseGoal({ goal }) {
	if (!isRecord(goal)) return null;
	const form = FORMS.find((f) => f === goal.form);
	const refs = parseRefs(goal.refs);
	if (form === undefined || refs === null || refs.length === 0) return null;
	return {
		form,
		text: typeof goal.text === "string" ? goal.text : "",
		refs,
		setAt: typeof goal.setAt === "number" ? goal.setAt : 0,
	};
}

module.exports = {
	buildGoalLine,
	buildGoalProgress,
	buildGoalRead,
	buildGoalStatus,
	buildProgressText,
	buildShortlistGoal,
	buildGoalRefusal,
	isRecord,
	parseStrings,
	isSameGoal,
	parseAskedRefs,
	parseGoal,
	parseGoalForm,
	parseGoalProgress,
	qualifyOpenRefs,
	qualifyRefs,
};
