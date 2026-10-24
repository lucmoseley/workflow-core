/*
 * refill-frontier.js — the refill loop's one frontier across the checkouts
 * its scope serves (#2003, #2123, spec #1995).
 *
 * pick-next.js runs once per checkout, in that checkout, with that
 * checkout's goal as its `--goal`, and the rows merge through
 * lib/frontier-order.js, whose goal level then ranks goal rows first across
 * every repo. The rows are unfiltered: which `takes:` kinds launch is the
 * loop's call. A checkout whose shortlist fails is returned under `failed`
 * with its error and contributes no rows; the others still merge.
 *
 * A served shortlist also names its PULLED-IN rows (#2427): open issues in
 * other repos that hold one of its issues out through the blocked-by chain
 * and that nothing open holds. A pulled-in repo the scope does not serve has
 * its shortlist read too, and only the pulled-in issues kept, so whatever
 * holds a ticket there (a claim, a gate, a dispatch) still holds it; a served
 * one already ranks the row, and gains the reach. Either way a row's reach
 * counts the served issues it holds out, never its own repo's. A pulled-in
 * issue whose repo has no checkout here, or sets `refillLoop: false`, is
 * returned under `held`, never launched.
 *
 * Caller: scripts/refill-loop.js's tick.
 */

const path = require("node:path");
const { lastLaunchAt } = require("./dispatch-ledger.js");
const { mergeFrontiers } = require("./frontier-order.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { caught } = require("./caught.js");
const { runGrouped } = require("./grouped-child.js");
const { checkoutEnv } = require("./refill-repos.js");
const { refKey } = require("./parent-claims.js");
const { FALLBACK_MS } = require("./refill-wake.js");

const PICK_NEXT = path.join(__dirname, "..", "pick-next.js");

/*
 * One checkout's shortlist read at most, after which its whole process group
 * is killed and the checkout is unread for the tick (#2677). It is the loop's
 * fallback wake interval, so a held tick delays the next relief by one
 * cadence at most; reads measured 208.7 s and 276.9 s under load on
 * 23 Oct 2026.
 */
const SHORTLIST_TIMEOUT_MS = FALLBACK_MS;

/** @typedef {import("./frontier-order.js").RepoFrontier} RepoFrontier */

/**
 * @typedef {object} PulledRow
 * @property {string} repo
 * @property {number} number
 * @property {number} reach
 * @property {string[]} holds the served issues it holds out, `owner/name#n`
 * @property {string|null} root the checkout it launches from
 * @property {string|null} held why it is held outside the loop
 */

/**
 * A pulled-in issue whose own blockers would not read.
 * @typedef {{ref: string, error: string, holds: string[]}} UnreadPull
 */

/**
 * @typedef {Omit<RepoFrontier, "root" | "lastLaunchAt"> &
 *   {pulledIn: PulledRow[], pulledInUnread: UnreadPull[]}} Shortlist
 */

/**
 * A shortlist's `--json` output, parsed.
 * @param {string} stdout
 * @returns {Shortlist | {error: string}}
 */
function parsedShortlist(stdout) {
	try {
		const out = JSON.parse(stdout);
		if (!Array.isArray(out.pulledIn) || !Array.isArray(out.pulledInUnread))
			throw new Error("no pulledIn or pulledInUnread list");
		return {
			rows: out.frontier,
			retroBundles: out.retroBundles,
			pulledIn: out.pulledIn,
			pulledInUnread: out.pulledInUnread,
		};
	} catch (parseErr) {
		return { error: `unparseable --json: ${caught(parseErr).message}` };
	}
}

/**
 * One checkout's shortlist frontier, read with the checkout as its root, its
 * `gh` calls inside the group the cap kills.
 * @param {string} root
 * @param {number[]} goal
 * @returns {Promise<Shortlist | {error: string}>}
 */
async function shortlistOf(root, goal) {
	const run = await runGrouped(
		process.execPath,
		[
			PICK_NEXT,
			"--json",
			...(goal.length > 0 ? ["--goal", goal.join(",")] : []),
		],
		{
			cwd: root,
			env: checkoutEnv(root),
			timeoutMs: SHORTLIST_TIMEOUT_MS,
			maxBuffer: CHILD_MAX_BUFFER,
		},
	);
	if (run.killedFor) return { error: run.killedFor };
	if (run.code !== 0) {
		const tail = run.stderr.trim().split("\n").pop() ?? "";
		return { error: `exited ${run.code ?? run.signal} ${tail}`.trim() };
	}
	return parsedShortlist(run.stdout);
}

/**
 * Every served shortlist's pulled-in rows, one per issue: its reach summed and
 * what it holds named across every served repo that pulled it in.
 * @param {Shortlist[]} served
 */
function pulledAcross(served) {
	/** @type {Map<string, PulledRow>} */
	const pulled = new Map();
	for (const p of served.flatMap((s) => s.pulledIn)) {
		const key = refKey(p);
		const seen = pulled.get(key) ?? { ...p, reach: 0, holds: [] };
		seen.reach += p.reach;
		seen.holds.push(...p.holds);
		pulled.set(key, seen);
	}
	return [...pulled.values()];
}

/**
 * @param {string[]} roots
 * @param {Record<string, number[]>} goals keyed by root
 * @param {(root: string, goal: number[]) => Promise<Shortlist | {error: string}>} [shortlist]
 */
async function refillFrontier(roots, goals, shortlist = shortlistOf) {
	/** @param {string[]} of @param {(root: string) => number[]} goal */
	const read = (of, goal) =>
		Promise.all(
			of.map(async (root) => ({
				root,
				result: await shortlist(root, goal(root)),
			})),
		);
	const results = await read(roots, (root) => goals[root] ?? []);
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
			p.held || !p.root
				? [
						{
							ref: `${p.repo}#${p.number}`,
							why: p.held ?? "no checkout",
							holds: p.holds,
						},
					]
				: [],
		),
		...served.flatMap((s) =>
			s.result.pulledInUnread.map((u) => ({
				ref: u.ref,
				why: `its blockers could not be read: ${u.error}`,
				holds: u.holds,
			})),
		),
	];
	/** @type {Map<string, Map<number, number>>} root -> number -> pulled reach */
	const reachByRoot = new Map();
	for (const p of pulled) {
		if (p.held || !p.root) continue;
		const of = reachByRoot.get(p.root) ?? new Map();
		of.set(p.number, p.reach);
		reachByRoot.set(p.root, of);
	}
	const foreign = [...reachByRoot.keys()].filter((r) => !roots.includes(r));
	for (const { root, result } of await read(foreign, () => []))
		if ("error" in result) failed.push({ root, error: result.error });
		else
			served.push({
				root,
				result: {
					...result,
					rows: result.rows
						.filter((r) => reachByRoot.get(root)?.has(r.number))
						.map((r) => ({ ...r, reach: 0 })),
					retroBundles: [],
				},
			});

	/** @type {RepoFrontier[]} */
	const merged = served.map(({ root, result }) => ({
		root,
		lastLaunchAt: lastLaunchAt(root),
		rows: result.rows.map((r) => ({
			...r,
			reach: r.reach + (reachByRoot.get(root)?.get(r.number) ?? 0),
		})),
		retroBundles: result.retroBundles,
	}));
	return { failed, held, ...mergeFrontiers(merged) };
}

module.exports = { refillFrontier };
