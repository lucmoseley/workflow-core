const path = require("node:path");
const { readLastLaunchAt } = require("./dispatch-ledger.js");
const { joinInherited, mergeFrontiers } = require("./frontier-order.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { runGrouped } = require("./grouped-child.js");
const { parseShortlist } = require("./shortlist-parse.js");
const {
	buildCheckoutEnv,
	homeDir,
	readCandidates,
	readHostTracker,
} = require("./refill-repos.js");
const { ghAsync } = require("./gh.js");
const { caught } = require("./caught.js");
const { RELEASE_BUMP } = require("./refill-decide.js");
const { refKey } = require("./issue-ref.js");
const { buildGoalRead, buildShortlistGoal } = require("./refill-goal.js");
const { FALLBACK_MS } = require("./refill-wake.js");

const PICK_NEXT = path.join(__dirname, "..", "pick-next.js");

// measured 208.7 s and 276.9 s under load, #2677
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

/** @typedef {{root: string, repo: string, numbers: number[]} | {root: string, error: string}} OpenBumps */

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

/**
 * @param {string[]} roots
 * @returns {Promise<OpenBumps[]>}
 */
function readUntickedBumps(roots) {
	const unticked = readCandidates(homeDir()).filter(
		(c) => c.disabled === null && !roots.includes(c.root),
	);
	return Promise.all(
		unticked.map(async ({ root }) => {
			try {
				const repo = readHostTracker(root);
				if (repo === null) return { root, error: "no tracker set" };
				const out = await ghAsync(
					[
						"issue",
						"list",
						"-R",
						repo,
						"--state",
						"open",
						"--label",
						RELEASE_BUMP,
						"--json",
						"number",
					],
					{ cwd: root, env: buildCheckoutEnv(root) },
				);
				/** @type {{number: number}[]} */
				const issues = JSON.parse(out);
				return { root, repo, numbers: issues.map((i) => i.number) };
			} catch (err) {
				return { root, error: caught(err).message };
			}
		}),
	);
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

/** @typedef {Map<string, {repo: string, numbers: Set<number>}>} BumpsByRoot */

/**
 * @param {OpenBumps[]} found
 * @param {{root: string, error: string}[]} failed
 * @returns {BumpsByRoot}
 */
function bumpsByRootOf(found, failed) {
	/** @type {BumpsByRoot} */
	const byRoot = new Map();
	for (const b of found)
		if ("error" in b)
			failed.push({ root: b.root, error: `release bumps unread: ${b.error}` });
		else if (b.numbers.length > 0)
			byRoot.set(b.root, { repo: b.repo, numbers: new Set(b.numbers) });
	return byRoot;
}

/**
 * @param {{root: string, result: Shortlist}[]} served
 * @param {BumpsByRoot} bumpsByRoot
 * @param {Map<string, Map<number, PulledRow>>} pulledByRoot
 * @returns {Held[]}
 */
function unreturnedBumps(served, bumpsByRoot, pulledByRoot) {
	return served.flatMap(({ root, result }) => {
		const bumps = bumpsByRoot.get(root);
		if (!bumps) return [];
		const returned = new Set(result.rows.map((r) => r.number));
		return [...bumps.numbers]
			.filter((n) => !returned.has(n) && !pulledByRoot.get(root)?.has(n))
			.map((n) => ({
				ref: `${bumps.repo}#${n}`,
				why: `a release bump, not on ${bumps.repo}'s shortlist`,
				holds: [],
			}));
	});
}

/**
 * @param {string[]} roots
 * @param {import("./refill-goal.js").Goal|null} goal
 * @param {(root: string, goal: string|null) => Promise<Shortlist | {error: string}>} [readList]
 * @param {(roots: string[]) => Promise<OpenBumps[]>} [readBumps]
 */
async function refillFrontier(
	roots,
	goal,
	readList = readShortlist,
	readBumps = readUntickedBumps,
) {
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
	const bumpsByRoot = bumpsByRootOf(await readBumps(roots), failed);
	/** @param {string} root @param {number} n */
	const isBump = (root, n) => bumpsByRoot.get(root)?.numbers.has(n) === true;
	const foreign = [
		...new Set([...pulledByRoot.keys(), ...bumpsByRoot.keys()]),
	].filter((r) => !roots.includes(r));
	for (const { root, result } of await read(foreign, () => null))
		if ("error" in result) failed.push({ root, error: result.error });
		else
			served.push({
				root,
				result: {
					...result,
					rows: result.rows
						.filter(
							(r) =>
								pulledByRoot.get(root)?.has(r.number) || isBump(root, r.number),
						)
						.map((r) => ({ ...r, reach: 0, depth: 0, closes: 0 })),
					retroBundles: [],
				},
			});
	held.push(...unreturnedPulls(served, pulledByRoot));
	held.push(...unreturnedBumps(served, bumpsByRoot, pulledByRoot));

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

module.exports = { parseFailureLine, readUntickedBumps, refillFrontier };
