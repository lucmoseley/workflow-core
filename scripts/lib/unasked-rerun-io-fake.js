/*
 * unasked-rerun-io-fake.js — the one fake of lib/unasked-rerun.js's `JudgeIO`
 * (#2913), for its module cases. Each port serves the answer a test picks by
 * name from ANSWERS, every port defaulting to the first. Held to lib/unasked-rerun-io.js
 * by unasked-rerun-io.contract.test.ts (§G7).
 */

const HEAD = "1111111111111111111111111111111111111111";
const TIP = "2222222222222222222222222222222222222222";
const BASE = "3333333333333333333333333333333333333333";
const NEIGHBOUR = "4444444444444444444444444444444444444444";
const TREE = "5555555555555555555555555555555555555555";
const ROOT_GIT_DIR = "/repo/.git";

/** An admissible narrowed certificate on `sha`, named by its `at`. */
const narrowed = (/** @type {string} */ sha, /** @type {string} */ at) => ({
	sha,
	at,
	suite: "vitest",
	dirtyAtStart: false,
	foreign: [],
	scope: {
		modulesRun: 1,
		modulesTotal: 9,
		tests: 3,
		passed: 3,
		skipped: 0,
		failed: 0,
		nameFilter: null,
		fileFilters: [],
		changed: "x",
		admissible: true,
	},
	treeAtEnd: TREE,
	closure: ["a.js"],
	changedPaths: ["a.js"],
});

/** A narrowed red run on `sha` whose one failure was already red on its base. */
const classedRed = (/** @type {string} */ sha, /** @type {string} */ at) => {
	const run = narrowed(sha, at);
	return {
		...run,
		base: BASE,
		scope: {
			...run.scope,
			passed: 2,
			failed: 1,
			failures: [{ file: "a.test.ts", tests: ["t"] }],
			errors: 0,
		},
		alreadyRed: {
			base: BASE,
			allAlreadyRed: true,
			files: [
				{
					file: "a.test.ts",
					red: { sha: NEIGHBOUR, at: "RUN-EARLIER", by: "red store" },
				},
			],
		},
	};
};

/** @param {string} code */
const fault = (code) => Object.assign(new Error(code), { code });

const ANSWERS = {
	latched: { no: false, yes: true },
	latch: { written: null, unwritable: fault("EACCES") },
	logRefusal: { written: null, unwritable: fault("EISDIR") },
	gitDir: {
		/* The repository root's checkout. */
		root: { dir: ROOT_GIT_DIR, timedOut: false },
		/* Another checkout: a linked worktree. */
		elsewhere: { dir: `${ROOT_GIT_DIR}/worktrees/elsewhere`, timedOut: false },
		unresolved: { dir: null, timedOut: false },
		timedOut: { dir: null, timedOut: true },
	},
	rootGitDir: {
		resolved: { dir: ROOT_GIT_DIR, timedOut: false },
		unresolved: { dir: null, timedOut: false },
		timedOut: { dir: null, timedOut: true },
	},
	head: {
		sha: { sha: HEAD, timedOut: false },
		unresolved: { sha: null, timedOut: false },
		timedOut: { sha: null, timedOut: true },
	},
	ledger: {
		readable: { readable: true, timedOut: false },
		unreadable: { readable: false, timedOut: false },
		/* The store fails open to the cwd, so a path still reads. */
		timedOut: { readable: true, timedOut: true },
	},
	selection: {
		head: {
			selection: {
				base: BASE,
				tip: HEAD,
				mine: [],
				uncommitted: [],
				net: ["a.js"],
				scoped: null,
				unread: null,
			},
			timedOut: false,
		},
		/* An own uncommitted edit, carried in the overlay's commit. */
		edit: {
			selection: {
				base: BASE,
				tip: TIP,
				mine: ["c.js"],
				uncommitted: ["c.js"],
				net: ["c.js"],
				scoped: null,
				unread: null,
			},
			timedOut: false,
		},
		/* An own commit under a neighbour's, which is left out. */
		neighbour: {
			selection: {
				base: BASE,
				tip: HEAD,
				mine: [],
				uncommitted: [],
				net: ["a.js", "b.js"],
				scoped: { paths: ["a.js"], dropped: [NEIGHBOUR] },
				unread: null,
			},
			timedOut: false,
		},
		/* An own uncommitted edit, its own commit under a neighbour's. */
		editUnderNeighbour: {
			selection: {
				base: BASE,
				tip: TIP,
				mine: ["c.js"],
				uncommitted: ["c.js"],
				net: ["c.js"],
				scoped: { paths: ["c.js"], dropped: [NEIGHBOUR] },
				unread: null,
			},
			timedOut: false,
		},
		/* Every commit in the range a neighbour's, so the run selects nothing. */
		allNeighbours: {
			selection: {
				base: BASE,
				tip: HEAD,
				mine: [],
				uncommitted: [],
				net: ["a.js", "b.js"],
				scoped: { paths: [], dropped: [HEAD, NEIGHBOUR] },
				unread: null,
			},
			timedOut: false,
		},
		/* Own commits that could not be told from a neighbour's. */
		unread: {
			selection: {
				base: BASE,
				tip: HEAD,
				mine: [],
				uncommitted: [],
				net: ["a.js"],
				scoped: null,
				unread:
					"this session's own commits could not be told from a neighbour's (commit ledger or git unreadable), so attestation was judged on the whole range",
			},
			timedOut: false,
		},
		unreadable: { selection: null, timedOut: false },
		timedOut: { selection: null, timedOut: true },
	},
	storeFault: { readable: null, absent: "ENOENT", unreadable: "EISDIR" },
	attestation: {
		attested: {
			verdict: {
				judged: true,
				base: BASE,
				range: ["a.js"],
				within: true,
				suites: [
					{
						suite: "vitest",
						attested: true,
						members: [
							{ marker: narrowed(HEAD, "RUN-A"), match: { by: "sha" } },
						],
						note: null,
					},
				],
			},
			timedOut: false,
			redFault: null,
		},
		/* The overlay's commit, carrying an own edit, attested by its tree. */
		attestedEdit: {
			verdict: {
				judged: true,
				base: BASE,
				range: ["c.js"],
				within: true,
				suites: [
					{
						suite: "vitest",
						attested: true,
						members: [
							{
								marker: narrowed(HEAD, "RUN-C"),
								match: { by: "tree", tree: TREE, closureSize: 1 },
							},
						],
						note: null,
					},
				],
			},
			timedOut: false,
			redFault: null,
		},
		/* A red run whose every failure was already red on its base (#3633). */
		attestedRed: {
			verdict: {
				judged: true,
				base: BASE,
				range: ["a.js"],
				within: true,
				suites: [
					{
						suite: "vitest",
						attested: true,
						members: [
							{ marker: classedRed(HEAD, "RUN-R"), match: { by: "sha" } },
						],
						note: null,
					},
				],
			},
			timedOut: false,
			redFault: null,
		},
		/* Two such reds, each covering a file the other does not. */
		attestedTwoReds: {
			verdict: {
				judged: true,
				base: BASE,
				range: ["a.js", "b.js"],
				within: true,
				suites: [
					{
						suite: "vitest",
						attested: true,
						members: [
							{ marker: classedRed(HEAD, "RUN-S"), match: { by: "sha" } },
							{ marker: classedRed(HEAD, "RUN-R"), match: { by: "sha" } },
						],
						note: null,
					},
				],
			},
			timedOut: false,
			redFault: null,
		},
		pytestOwed: {
			verdict: {
				judged: true,
				base: BASE,
				range: ["a.js", "b.py"],
				suites: [
					{
						suite: "vitest",
						attested: true,
						members: [
							{ marker: narrowed(HEAD, "RUN-A"), match: { by: "sha" } },
						],
						note: null,
					},
					{
						suite: "pytest",
						attested: false,
						unattested: [{ path: "b.py", commit: HEAD }],
					},
				],
			},
			timedOut: false,
			redFault: null,
		},
		unattested: {
			verdict: {
				judged: true,
				base: BASE,
				range: ["a.js"],
				suites: [
					{
						suite: "vitest",
						attested: false,
						unattested: [{ path: "a.js", commit: HEAD }],
					},
				],
			},
			timedOut: false,
			redFault: null,
		},
		/* Nothing attests, and the red store is torn. */
		unattestedRedFault: {
			verdict: {
				judged: true,
				base: BASE,
				range: ["a.js"],
				within: true,
				suites: [
					{
						suite: "vitest",
						attested: false,
						unattested: [{ path: "a.js", commit: HEAD }],
					},
				],
			},
			timedOut: false,
			redFault: "the red store could not be read (1 malformed line(s))",
		},
		unjudged: {
			verdict: {
				judged: false,
				why: `git could not resolve the merge-base of ${HEAD.slice(0, 12)} with origin/main`,
			},
			timedOut: false,
			redFault: null,
		},
		timedOut: {
			verdict: {
				judged: false,
				why: `git could not resolve the merge-base of ${HEAD.slice(0, 12)} with origin/main`,
			},
			timedOut: true,
			redFault: null,
		},
	},
	malformed: { none: 0, some: 1 },
};

/**
 * @typedef {{ [P in keyof typeof ANSWERS]?: keyof (typeof ANSWERS)[P] }} Picks
 */

/**
 * A `JudgeIO` serving the picked answers, and what its latch and refusal log
 * were handed.
 *
 * @param {Picks} [picks]
 */
function fakeIO(picks = {}) {
	/* `any`: each port reads its own table's answer type, which one generic
	 * return over every table cannot name. The contract holds each answer's shape. */
	/** @type {<P extends keyof typeof ANSWERS>(port: P) => any} */
	const answer = (port) => {
		const named = /** @type {Record<string, unknown>} */ (ANSWERS[port]);
		return named[/** @type {string} */ (picks[port] ?? Object.keys(named)[0])];
	};
	/** @type {{ sessionId: string, at: string }[]} */
	const latches = [];
	/** @type {object[]} */
	const refusals = [];
	/** @type {import("./unasked-rerun.js").JudgeIO} */
	const io = {
		latched: () => answer("latched"),
		latch: (sessionId, at) => {
			const e = answer("latch");
			if (e) throw e;
			latches.push({ sessionId, at });
		},
		logRefusal: (record) => {
			const e = answer("logRefusal");
			if (e) throw e;
			refusals.push(record);
		},
		gitDir: () => answer("gitDir"),
		rootGitDir: () => answer("rootGitDir"),
		head: () => answer("head"),
		ledger: () => answer("ledger"),
		selection: () => answer("selection"),
		storeFault: () => answer("storeFault"),
		attestation: () => answer("attestation"),
		malformed: () => answer("malformed"),
		now: () => "2026-10-26T00:00:00.000Z",
	};
	return { io, latches, refusals };
}

module.exports = { ANSWERS, BASE, fakeIO, HEAD, NEIGHBOUR, ROOT_GIT_DIR };
