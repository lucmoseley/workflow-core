const path = require("node:path");
const { readLastLaunchAt } = require("./dispatch-ledger.js");
const { joinInherited, mergeFrontiers } = require("./frontier-order.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { runGrouped } = require("./grouped-child.js");
const { parseShortlist } = require("./shortlist-parse.js");
const { buildCheckoutEnv } = require("./refill-repos.js");
const { refKey } = require("./issue-ref.js");
const { buildGoalRead, buildShortlistGoal } = require("./refill-goal.js");
const { FALLBACK_MS } = require("./refill-wake.js");

const PICK_NEXT = path.join(__dirname, "..", "pick-next.js");

// measured 208.7 s and 276.9 s under load, workflow-core#2677
const SHORTLIST_TIMEOUT_MS = FALLBACK_MS;

/** @typedef {import("./frontier-order.js").RepoFrontier} RepoFrontier */

/**
 * @typedef {object} PulledRow
 * @property {string} repo
 * @property {number} number
 * @property {number} reach
 * @property {boolean} bug
 * @property {boolean} urgent
 * @property {boolean} goal
 * @property {number} depth
 * @property {string[]} holds
 * @property {string|null} root
 * @property {string|null} held
 */

/** @typedef {{ref: string, error: string, holds: string[]}} UnreadPull */

/**
 * @typedef {Omit<RepoFrontier, "root" | "lastLaunchAt"> &
 *   {pulledIn: PulledRow[], pulledInUnread: UnreadPull[], ownRepo: string|null,
 *    goalSet: import("./refill-goal.js").ShortlistGoal|null, running: number[]}} Shortlist
 */

/**
 * @param {string} root
 * @param {string|null} goal
 * @returns {Promise<Shortlist | {error: string}>}
 */
async function readShortlist(root, goal) {
	const run = await runGrouped(
		process.execPath,
		[PICK_NEXT, "--json", ...(goal === null ? [] : ["--goal", goal])],
		{
			cwd: root,
			env: buildCheckoutEnv(root),
			timeoutMs: SHORTLIST_TIMEOUT_MS,
			maxBuffer: CHILD_MAX_BUFFER,
		},
	);
	if (run.killedFor) return { error: run.killedFor };
	if (run.code !== 0)
		return {
			error:
				`exited ${run.code ?? run.signal} ${parseFailureLine(run.stderr)}`.trim(),
		};
	return parseShortlist(run.stdout);
}

/** @param {string} stderr */
function parseFailureLine(stderr) {
	const lines = stderr.trim().split("\n");
	return lines.findLast((l) => l.startsWith("FAILED:")) ?? lines.pop() ?? "";
}

/** @param {Shortlist[]} served */
function pulledAcross(served) {
	/** @type {Map<string, PulledRow>} */
	const pulled = new Map();
	for (const p of served.flatMap((s) => s.pulledIn)) {
		const key = refKey(p);
		const seen = pulled.get(key);
		pulled.set(
			key,
			seen ? { ...withPulled(seen, p), holds: [...seen.holds, ...p.holds] } : p,
		);
	}
	return [...pulled.values()];
}

/**
 * @template {import("./frontier-order.js").Inherited & {reach: number}} R
 * @param {R} row
 * @param {PulledRow} p
 * @returns {R}
 */
const withPulled = (row, p) => ({
	...joinInherited(row, p),
	reach: row.reach + p.reach,
});

/** @typedef {{ref: string, why: string, holds: string[]}} Held */

/**
 * @param {PulledRow} p
 * @param {string} why
 * @returns {Held}
 */
const heldPull = (p, why) => ({
	ref: `${p.repo}#${p.number}`,
	why,
	holds: p.holds,
});

/**
 * @param {{root: string, result: Shortlist}[]} served
 * @param {Map<string, Map<number, PulledRow>>} pulledByRoot
 * @returns {Held[]}
 */
function unreturnedPulls(served, pulledByRoot) {
	return served.flatMap(({ root, result }) => {
		const returned = new Set(result.rows.map((r) => r.number));
		return [...(pulledByRoot.get(root)?.values() ?? [])]
			.filter((p) => !returned.has(p.number))
			.map((p) => heldPull(p, `not on ${p.repo}'s shortlist`));
	});
}

/**
 * @param {string[]} roots
 * @param {import("./refill-goal.js").Goal|null} goal
 * @param {(root: string, goal: string|null) => Promise<Shortlist | {error: string}>} [readList]
 */
async function refillFrontier(roots, goal, readList = readShortlist) {
	/** @param {string[]} of @param {(root: string) => string|null} goalIn */
	const read = (of, goalIn) =>
		Promise.all(
			of.map(async (root) => ({
				root,
				result: await readList(root, goalIn(root)),
			})),
		);
	const results = await read(roots, (root) => buildShortlistGoal(goal, root));
	/** @type {{root: string, result: Shortlist}[]} */
	const served = [];
	/** @type {{root: string, error: string}[]} */
	const failed = [];
	for (const { root, result } of results)
		if ("error" in result) failed.push({ root, error: result.error });
		else served.push({ root, result });

	const pulled = pulledAcross(served.map((s) => s.result));
	const held = [
		...pulled.flatMap((p) =>
			p.root ? [] : [heldPull(p, p.held ?? "no checkout")],
		),
		...served.flatMap((s) =>
			s.result.pulledInUnread.map((u) => ({
				ref: u.ref,
				why: `its blockers could not be read: ${u.error}`,
				holds: u.holds,
			})),
		),
	];
	/** @type {Map<string, Map<number, PulledRow>>} */
	const pulledByRoot = new Map();
	for (const p of pulled) {
		if (!p.root) continue;
		const of = pulledByRoot.get(p.root) ?? new Map();
		of.set(p.number, p);
		pulledByRoot.set(p.root, of);
	}
	const foreign = [...pulledByRoot.keys()].filter((r) => !roots.includes(r));
	for (const { root, result } of await read(foreign, () => null))
		if ("error" in result) failed.push({ root, error: result.error });
		else
			served.push({
				root,
				result: {
					...result,
					rows: result.rows
						.filter((r) => pulledByRoot.get(root)?.has(r.number))
						.map((r) => ({ ...r, reach: 0, depth: 0, closes: 0 })),
					retroBundles: [],
				},
			});
	held.push(...unreturnedPulls(served, pulledByRoot));

	/** @type {RepoFrontier[]} */
	const merged = served.map(({ root, result }) => ({
		root,
		lastLaunchAt: readLastLaunchAt(root),
		rows: result.rows.map((r) => {
			const p = pulledByRoot.get(root)?.get(r.number);
			return p ? withPulled(r, p) : r;
		}),
		retroBundles: result.retroBundles,
	}));
	const order = mergeFrontiers(merged);
	return {
		failed,
		held,
		goal: buildGoalRead(
			goal,
			served.map(({ root, result }) => ({
				root,
				repo: result.ownRepo,
				goalSet: result.goalSet,
				running: result.running,
			})),
			{ failed: failed.length, frontier: order.frontier },
		),
		...order,
	};
}

module.exports = { parseFailureLine, refillFrontier };
