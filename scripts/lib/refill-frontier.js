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
const { RELEASE_BUMP_LABEL } = require("./issue-origin.js");
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
 * @param {string} [script]
 * @returns {Promise<Shortlist | {error: string}>}
 */
async function readShortlist(root, goal, script = PICK_NEXT) {
	const run = await runGrouped(
		process.execPath,
		[script, "--json", ...(goal === null ? [] : ["--goal", goal])],
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
function readUnservedBumps(roots) {
	const unserved = readCandidates(homeDir()).filter(
		(c) => c.disabled === null && !roots.includes(c.root),
	);
	return Promise.all(
		unserved.map(async ({ root }) => {
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
						RELEASE_BUMP_LABEL,
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
 * @param {Map<string, Map<number, Held>>} wantedByRoot
 * @returns {Held[]}
 */
function unreturnedOf(served, wantedByRoot) {
	return served.flatMap(({ root, result }) => {
		const returned = new Set(result.rows.map((r) => r.number));
		return [...(wantedByRoot.get(root) ?? [])]
			.filter(([n]) => !returned.has(n))
			.map(([, h]) => h);
	});
}

/** @typedef {Map<string, {repo: string, numbers: Set<number>}>} BumpsByRoot */

/**
 * @param {OpenBumps[]} found
 * @returns {{byRoot: BumpsByRoot, unread: {root: string, error: string}[]}}
 */
function bumpsByRootOf(found) {
	/** @type {BumpsByRoot} */
	const byRoot = new Map();
	/** @type {{root: string, error: string}[]} */
	const unread = [];
	for (const b of found)
		if ("error" in b) unread.push(b);
		else if (b.numbers.length > 0)
			byRoot.set(b.root, { repo: b.repo, numbers: new Set(b.numbers) });
	return { byRoot, unread };
}

/**
 * @param {Map<string, Map<number, PulledRow>>} pulledByRoot
 * @param {BumpsByRoot} bumpsByRoot
 * @returns {Map<string, Map<number, Held>>}
 */
function wantedOf(pulledByRoot, bumpsByRoot) {
	/** @type {Map<string, Map<number, Held>>} */
	const wanted = new Map();
	for (const [root, { repo, numbers }] of bumpsByRoot)
		wanted.set(
			root,
			new Map(
				[...numbers].map((n) => [
					n,
					{
						ref: `${repo}#${n}`,
						why: `a release bump, not on ${repo}'s shortlist`,
						holds: [],
					},
				]),
			),
		);
	for (const [root, pulls] of pulledByRoot) {
		const of = wanted.get(root) ?? new Map();
		for (const [n, p] of pulls)
			of.set(n, heldPull(p, `not on ${p.repo}'s shortlist`));
		wanted.set(root, of);
	}
	return wanted;
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
	readBumps = readUnservedBumps,
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
	const bumps = bumpsByRootOf(await readBumps(roots));
	const wanted = wantedOf(pulledByRoot, bumps.byRoot);
	const foreign = [...wanted.keys()].filter((r) => !roots.includes(r));
	for (const { root, result } of await read(foreign, () => null))
		if ("error" in result) failed.push({ root, error: result.error });
		else
			served.push({
				root,
				result: {
					...result,
					rows: result.rows
						.filter((r) => wanted.get(root)?.has(r.number))
						.map((r) => ({ ...r, reach: 0, depth: 0, closes: 0 })),
					retroBundles: [],
				},
			});
	held.push(...unreturnedOf(served, wanted));

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
		bumpsUnread: bumps.unread,
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

module.exports = { parseFailureLine, readShortlist, refillFrontier };
