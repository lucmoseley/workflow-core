const { takesValue } = require("./takes-label.js");

const IMPLEMENT = takesValue("implement");
const IMPLEMENT_PREFIX = `/${IMPLEMENT} `;

/**
 * @typedef {object} UnclosedRecord
 * @property {string} root
 * @property {number[]} issues
 * @property {string} [prompt]
 * @property {number|null} finishedAt
 * @property {Record<string, number>|string} [acts]
 * @property {true} [gate]
 */

/** @param {UnclosedRecord} l @returns {Record<string, number>|null} */
function readImplementActs(l) {
	if (l.finishedAt === null || l.issues.length !== 1) return null;
	if (!l.prompt?.startsWith(IMPLEMENT_PREFIX)) return null;
	return typeof l.acts === "object" ? l.acts : null;
}

/** @param {UnclosedRecord} l */
function isUnclosed(l) {
	const acts = readImplementActs(l);
	return acts !== null && (acts.commit ?? 0) > 0 && !acts.close;
}

/** @param {UnclosedRecord} l */
function isActless(l) {
	const acts = readImplementActs(l);
	return acts !== null && Object.values(acts).every((n) => n === 0);
}

/**
 * @template {UnclosedRecord} L
 * @param {L[]} launches
 * @param {(l: L) => boolean} is
 * @returns {L[]}
 */
function latestWhere(launches, is) {
	/** @type {Map<string, L>} */
	const latest = new Map();
	for (const l of launches.filter((x) => !x.gate))
		for (const n of l.issues) latest.set(`${l.root}#${n}`, l);
	return launches.filter(
		(l) => is(l) && latest.get(`${l.root}#${l.issues[0]}`) === l,
	);
}

/** @template {UnclosedRecord} L @param {L[]} launches @returns {L[]} */
const unclosedLaunches = (launches) => latestWhere(launches, isUnclosed);

/** @param {UnclosedRecord[]} launches @param {string} root @param {number} n */
const hasActlessLaunch = (launches, root, n) => {
	const own = launches.filter((l) => l.root === root && l.issues.includes(n));
	return (
		latestWhere(own, isActless).some((l) => l.issues[0] === n) &&
		!own.some((l) => (readImplementActs(l)?.commit ?? 0) > 0)
	);
};

/**
 * @template {UnclosedRecord} L
 * @param {L[]} launches
 * @param {string} root
 * @param {number} n
 * @returns {L|null}
 */
function unclosedLaunchOf(launches, root, n) {
	return (
		unclosedLaunches(launches).find(
			(l) => l.root === root && l.issues[0] === n,
		) ?? null
	);
}

/**
 * @param {number} n
 */
const buildVerifyPrompt = (n) =>
	`${IMPLEMENT_PREFIX}${n} — its last loop launch committed and ended without closing it. Before building anything, find that work (git log --all --grep=#${n}) and read it against the acceptance criteria. Finished: close with that evidence. Not finished: say on the ticket what remains, then build only that.`;

/**
 * @param {number} n
 */
const buildGateFirstPrompt = (n) =>
	`${IMPLEMENT_PREFIX}${n} — its last loop launch ended with no act. Read its latest comment first. Where it found the ticket could not start yet and that still holds, write its gate (scripts/lib/rule-text.sh blocked-ticket-gate) and end. Otherwise build it.`;

/**
 * @param {{root: string, number: number, takes: string[]}} row
 * @param {UnclosedRecord[]} launches
 */
function buildRowPrompt(row, launches) {
	if (row.takes[0] === IMPLEMENT) {
		if (unclosedLaunchOf(launches, row.root, row.number))
			return buildVerifyPrompt(row.number);
		if (hasActlessLaunch(launches, row.root, row.number))
			return buildGateFirstPrompt(row.number);
	}
	return `/${row.takes[0]} ${row.number}`;
}

module.exports = {
	buildRowPrompt,
	buildVerifyPrompt,
	unclosedLaunchOf,
	unclosedLaunches,
};
