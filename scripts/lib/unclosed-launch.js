/*
 * unclosed-launch.js — a ticket whose latest loop launch committed and ended
 * without closing it (#3782): its session may have finished the work and died
 * before its close. Pure, over the loop's launch records.
 *
 * Only a lone `/implement` launch reads this way: a `/wayfinder`, `/to-spec` or
 * `/triage` session rightly commits and leaves its issue open, and a retro
 * bundle's acts cannot be told apart by member. The next launch of the ticket
 * supersedes the record, whatever it did, unless a gate judgement's, which
 * builds nothing.
 *
 * Residual: acts are counted per session and kind, so a session that closed
 * some other issue reads as having closed this one, and is not caught.
 *
 * Callers: lib/refill-decide.js (the launch prompt), lib/refill-loop.js (what a
 * tick's state keeps), pick-next.js and check-unclosed-launches.js (the report).
 */

const IMPLEMENT_PREFIX = "/implement ";

/**
 * @typedef {object} UnclosedRecord
 * @property {string} root
 * @property {number[]} issues
 * @property {string} [prompt]
 * @property {number|null} finishedAt
 * @property {Record<string, number>|string} [acts]
 * @property {true} [gate]
 */

/** @param {UnclosedRecord} l */
function isUnclosed(l) {
	if (l.finishedAt === null || l.issues.length !== 1) return false;
	if (!l.prompt?.startsWith(IMPLEMENT_PREFIX)) return false;
	if (typeof l.acts !== "object") return false;
	return (l.acts.commit ?? 0) > 0 && !l.acts.close;
}

/**
 * @template {UnclosedRecord} L
 * @param {L[]} launches in launch order
 * @returns {L[]}
 */
function unclosedLaunches(launches) {
	/** @type {Map<string, L>} */
	const latest = new Map();
	for (const l of launches.filter((x) => !x.gate))
		for (const n of l.issues) latest.set(`${l.root}#${n}`, l);
	return launches.filter(
		(l) => isUnclosed(l) && latest.get(`${l.root}#${l.issues[0]}`) === l,
	);
}

/**
 * @template {UnclosedRecord} L
 * @param {L[]} launches in launch order
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
 * It names no number but the issue's, since the dispatcher reads every integer
 * in a prompt as an issue it holds.
 * @param {number} n
 */
const buildVerifyPrompt = (n) =>
	`/implement ${n} — its last loop launch committed and ended without closing it. Before building anything, find that work (git log --all --grep=#${n}) and read it against the acceptance criteria. Finished: close with that evidence. Not finished: say on the ticket what remains, then build only that.`;

module.exports = { buildVerifyPrompt, unclosedLaunchOf, unclosedLaunches };
