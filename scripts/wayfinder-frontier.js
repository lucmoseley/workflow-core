#!/usr/bin/env node
/*
 * wayfinder-frontier.js — the issues `/wayfinder`'s frontier query must drop,
 * and the only ones it may.
 *
 * WHY THIS EXISTS (mantahostels#702, on mantahostels#633's measurement and mantahostels#645's ruling).
 *
 * The frontier query dropped any child issue carrying an assignee. Every
 * assignee on this repo is the founder's login, whichever session set it, so
 * a finished session's leftover hid its issue from the query for good (mantahostels#633
 * measured how far). mantahostels#645 fixed the same defect in pick-next.js
 * alone; the frontier is the other reader, and `/wayfinder` is hash-locked, so
 * the fix it can be told to run is a command rather than a patch to the skill.
 *
 * SAME JUDGEMENT AS pick-next.js, DELIBERATELY: an assignment excludes only
 * where the arbiter holds a matching claim AND the recording session is live.
 * NO MATCHING RECORD MEANS THE ISSUE STAYS ON THE FRONTIER — a session that
 * assigns itself but never runs `claim-issue` leaves its work visible.
 *
 * EVERY FAILURE IS LOUD, because both of this command's silences are dangerous
 * in opposite directions: printing nothing reads as "the frontier is clear", and
 * printing everything reads as "it is all taken". A store that will not open
 * exits 1 and prints nothing. AN UNREADABLE ORACLE IS THE ONE THAT EXITS 0: it
 * prints every claim, warning on stderr only, because mantahostels#702's third criterion
 * says claims stand on doubt. So a caller redirecting stderr away loses that
 * warning and drops issues whose holders may be long gone. Read stderr.
 *
 * THE ARBITER IS PER-MACHINE AND THE TRACKER IS SHARED — mantahostels#270's objection: run
 * on a second machine this drops nothing, because no claim was ever recorded
 * there. This project runs its sessions on one machine.
 *
 * IT NEVER WRITES: `claim-issue` is the working session's own call.
 *
 * `--map <n>` DOES THE WHOLE FRONTIER QUERY (mantahostels#1145): resolve the map's open
 * children, drop the untyped, read the remaining children's blockers in
 * batches (lib/blocked-by-batch.js), drop the blocked, the live-claimed and
 * the body-GATED, print the rest in map order.
 *
 * THE TYPE FILTER (#579): only a decision ticket belongs on the frontier, and a
 * decision ticket carries a `wayfinder:` label — any, as `check-issue-labels.js`'s
 * `isRouteStep` reads it, so a nested map stays. A child without one — a
 * `kind:spec` whose work sits on its tickets, a `kind:brief` awaiting its spec,
 * or a child nobody typed — is dropped and named on stderr, so a missing label
 * shows rather than hiding its issue. THESE DROP NOTES ARE NOT WARNINGS: they
 * leave the printed list usable, unlike every other stderr line below.
 *
 * THE GATE FILTER (mantahostels#2706) reads the same two body markers `pick-next.js` reads,
 * through the same `lib/issue-gate.js`. It costs no extra call: the sub-issues
 * endpoint returns each child's body already. An unparseable marker gates
 * NOTHING and warns — see `gatedChildren`. That makes it the second
 * warn-and-answer case beside the oracle above, and the only one that can
 * LENGTHEN the frontier against the invariant below.
 *
 * `--map` FAILS CLOSED, more tightly than `--numbers` does. Every read it
 * cannot complete refuses the whole run — exit 1, nothing on stdout.
 *
 * THE ONE INVARIANT: a frontier printed may be SHORTER than the truth, never
 * longer. An unreadable liveness oracle only shortens it, so that one warns and
 * answers; anything that would lengthen it refuses, where `--numbers` merely
 * warns. A single corrupt record inside a readable claim store is reported by
 * `arbiter-store.listIssueClaims` as its own `why` (mantahostels#1186), and
 * `heldIssues` exits `kept: false` on it — the same admission-refusing verdict a store that would not open at all gets,
 * even though (unlike that case) `held` may still carry a partial read.
 */

const fs = require("node:fs");
const { listedSessionIds } = require("./lib/agent-liveness");
const { scriptPath } = require("./lib/script-path.js");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const { parseIssueNumber } = require("./lib/issue-number.js");
const { parseErrLine, ghGetRetrying } = require("./lib/gh");
const { blockedByMany } = require("./lib/blocked-by-batch");
const { resolveGate } = require("./lib/issue-gate");
const store = require("./lib/arbiter-store");
const { execGit } = require("./lib/git.js");

/** @param {string} msg */
const say = (msg) => process.stderr.write(`wayfinder-frontier: ${msg}\n`);

/** gh expands this from the checkout's own remote. */
const REPO = "{owner}/{repo}";

/**
 * The same directory named two ways, or `null` where it cannot be resolved.
 * @param {string} dir
 * @returns {string | null}
 */
function readRealOrNull(dir) {
	try {
		return fs.realpathSync(dir);
	} catch {
		return null;
	}
}

/**
 * How the claim store's tree relates to the one the caller is standing in.
 * `null` where they are confirmed the same; `{ store, cwd }` where they differ
 * — the shape mantahostels#703 found in pick-next.js, a store resolving cleanly to the
 * wrong, empty directory, which reads exactly like an unclaimed frontier; and
 * `{ unknown }` where it cannot be told either way.
 *
 * `unknown` is not `null`. A caller printing a KEEP-list cannot use a claim
 * filter it cannot vouch for, and treating doubt as "same tree" is what would
 * let it offer work a live session already holds.
 */
function storeElsewhere() {
	let cwdRoot;
	try {
		cwdRoot = execGit(["rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			// git's own "not a git repository" goes to stderr, where it would read
			// as this command's complaint rather than a fact about the caller.
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return {
			unknown:
				"you are not in a git repository, so the claim store's tree cannot be compared with yours",
		};
	}
	const a = readRealOrNull(store.paths.repoRoot());
	const b = readRealOrNull(cwdRoot);
	if (!a)
		return {
			unknown: `the claim store's root (${store.paths.repoRoot()}) does not resolve`,
		};
	if (!b)
		return {
			unknown: `your own repository root (${cwdRoot}) does not resolve`,
		};
	return a === b ? null : { store: a, cwd: b };
}

const USAGE =
	"usage: wayfinder-frontier.js [--numbers | --map <n>]\n" +
	"  (no flag)  one line per claim: #issue, holding session, claimed-at\n" +
	"  --numbers  bare issue numbers, one per line, for a shell step\n" +
	"  --map <n>  the frontier of map <n>: its open, typed, unblocked,\n" +
	"             unclaimed children, bare numbers in map order\n";

/**
 * `[--numbers, --map <n>]` out of parseOrExit's flags, or `{ error }` naming
 * the first thing wrong with them.
 * @param {Record<string, string | true>} flags
 * @returns {{ error: string } | { numbers: boolean, map: number | null }}
 */
function parseArgs(flags) {
	const numbers = flags["--numbers"] === true;
	const raw = flagValue(flags, "--map");
	if (raw === undefined) return { numbers, map: null };
	// A non-number here would otherwise be pasted straight into an API path,
	// where GitHub's 404 reads as "the map has no children".
	const map = parseIssueNumber(raw);
	if (map === null) return { error: `--map wants an issue number, not ${raw}` };
	if (numbers)
		return { error: "--numbers and --map are alternatives, not a pair" };
	return { numbers, map };
}

/**
 * The map's open children, in map order — the order the sub-issues endpoint
 * returns, which is the order the map lists them. `{ error }` where the call
 * failed, never an empty list: a map whose children cannot be read has an
 * unknown frontier, not an empty one.
 * Each child carries its own body, which the sub-issues endpoint returns for
 * nothing — that is what makes the gate filter below cost no extra call.
 * @param {number} map
 * @returns {Promise<{ error: string } | { total: number, children: {number: number, body: string, labels: string[]}[] }>}
 */
async function openChildren(map) {
	const r = await ghGetRetrying(`repos/${REPO}/issues/${map}/sub_issues`, {
		strict: true,
	});
	if (!r.ok)
		return { error: `could not read the children of #${map} (${r.error})` };
	return {
		total: r.out.length,
		children: r.out
			.filter(
				/** @param {{ state: string, pull_request?: unknown }} i */
				(i) => i.state === "open" && !i.pull_request,
			)
			.map(
				/** @param {{ number: number, body?: string | null, labels?: {name: string}[] }} i */
				(i) => ({
					number: i.number,
					body: i.body ?? "",
					labels: (i.labels ?? []).map((l) => l.name),
				}),
			),
	};
}

/**
 * The children carrying no `wayfinder:<type>` label, each named on stderr.
 * @param {{number: number, labels: string[]}[]} children
 * @returns {Set<number>}
 */
function untypedChildren(children) {
	const untyped = new Set();
	for (const { number, labels } of children) {
		if (labels.some((l) => l.startsWith("wayfinder:"))) continue;
		untyped.add(number);
		if (labels.includes("kind:spec"))
			say(
				`#${number} is a kind:spec, whose work sits on its tickets, so it is left off the frontier.`,
			);
		else if (labels.includes("kind:brief"))
			say(
				`#${number} is a kind:brief, awaiting its spec, so it is left off the frontier.`,
			);
		else
			say(
				`#${number} carries no wayfinder:<type> label, so it is left off the frontier — label it if it is a decision.`,
			);
	}
	return untyped;
}

/**
 * The children held out by an active body gate — `**Gated until:**` a date not
 * yet reached, or `**Gated on:**` a condition. The same two markers
 * `scripts/pick-next.js` reads, through the same library, so the two readers
 * agree about what is takeable (mantahostels#2706).
 *
 * FAIL OPEN, DELIBERATELY: a marker that will not parse gates nothing and warns.
 * `lib/issue-gate.js` rules that for every unreadable case, and failing closed
 * here would hide an issue on a typo with nothing saying so — mantahostels#633's
 * hide-forever defect.
 *
 * Dropping these only ever SHORTENS the printed frontier, which the invariant
 * in this file's header permits without a refuse path.
 *
 * @param {{number: number, body: string}[]} children
 * @returns {Set<number>}
 */
function gatedChildren(children) {
	const gated = new Set();
	for (const { number, body } of children) {
		const {
			gate: until,
			gateOn: on,
			conflict,
			gateHolds,
			gateOnHolds,
		} = resolveGate(body);
		/* One gate line per issue (mantahostels#1333). Two lines are two reasons and a reader
		 * cannot tell which is true, so a body carrying both gates nothing and is
		 * reported — the reading pick-next.js and check-gates.js already take,
		 * now shared through `lib/issue-gate.js`'s `resolveGate` (mantahostels#2706). */
		if (conflict) {
			say(
				`#${number} carries both **Gated until:** and **Gated on:**, so neither gates and it stays on the frontier — one gate line per issue.`,
			);
			continue;
		}
		if (until?.malformed) {
			say(
				`#${number} carries a **Gated until:** line that does not parse (${until.raw}), so it is left on the frontier — repair the marker.`,
			);
			continue;
		}
		if (gateHolds) {
			gated.add(number);
			continue;
		}
		if (on?.malformed) {
			say(
				`#${number} carries a **Gated on:** line that does not parse (${on.reason}: ${on.raw}), so it is left on the frontier — repair the marker.`,
			);
			continue;
		}
		// A condition gate has no expiry: well-formed, it holds until someone
		// judges the condition met and deletes the line.
		if (gateOnHolds) gated.add(number);
	}
	return gated;
}

/**
 * The children with an open blocker. `{ error }` where any child's blockers
 * could not be read — see the fail-closed note in the header.
 *
 * Read from the canonical blocked-by connection, NEVER from
 * `issue_dependencies_summary.blocked_by` on the issue payload, which is
 * documented as the open-blocker count and is stale in practice.
 * @param {number[]} children
 * @returns {Promise<{ error: string } | { blocked: Set<number> }>}
 */
async function blockedChildren(children) {
	// strict: an empty stdout would parse as `[]` — "no blockers" — and put a
	// blocked issue on the frontier.
	const reads = await blockedByMany(
		children.map((number) => ({ number })),
		{ repo: REPO, home: REPO, strict: true },
	);
	const results = reads.map(({ issue, read }) => ({
		n: issue.number,
		r: read,
	}));
	const failed = results.filter((x) => !x.r.ok);
	const first = failed[0];
	if (first && !first.r.ok)
		return {
			error:
				`could not read the blockers of #${first.n} (${first.r.error})` +
				(failed.length > 1 ? `, and ${failed.length - 1} more` : ""),
		};
	return {
		blocked: new Set(
			results
				.filter((x) => x.r.ok && x.r.edges.some((b) => b.state === "open"))
				.map((x) => x.n),
		),
	};
}

/**
 * The frontier of `map`, given the issues a live session already holds.
 * @param {number} map
 * @param {Set<number>} liveIssues
 */
async function frontier(map, liveIssues) {
	const kids = await openChildren(map);
	if ("error" in kids) {
		say(
			`${kids.error}, so the frontier is unknown — not empty. Drop nothing on this answer.`,
		);
		return 1;
	}
	// No sub-issues AT ALL is not a cleared map, it is almost always the wrong
	// number — a non-map issue, or a map whose children were never linked.
	if (!kids.total) {
		say(
			`#${map} has no sub-issues at all, so it is either not a map or its children were never linked. Refusing rather than reading that as an empty frontier.`,
		);
		return 1;
	}
	// Children, but none of them open: the map really is worked out.
	if (kids.children.length === 0) return 0;

	const untyped = untypedChildren(kids.children);
	const typed = kids.children.filter((c) => !untyped.has(c.number));
	// Every open child dropped as untyped: the map's decisions are worked out and
	// its hand-offs are filed — the Exhausted map shape, not an unknown frontier.
	if (typed.length === 0) return 0;

	const numbers = typed.map((c) => c.number);
	const blocked = await blockedChildren(numbers);
	if ("error" in blocked) {
		say(
			`${blocked.error}, so the frontier is unknown — not empty. Drop nothing on this answer.`,
		);
		return 1;
	}
	const gated = gatedChildren(typed);

	for (const n of numbers)
		if (!blocked.blocked.has(n) && !liveIssues.has(n) && !gated.has(n))
			process.stdout.write(`${n}\n`);
	return 0;
}

/** @param {string[]} argv */
async function main(argv) {
	/* An unknown flag is refused rather than ignored: ignoring it feeds the
	 * human format into a shell step expecting bare numbers. */
	const { flags } = parseOrExit(argv, {
		usage: USAGE.trimEnd(),
		flags: { "--numbers": "boolean", "--map": "value" },
	});
	const args = parseArgs(flags);
	if ("error" in args) {
		say(args.error);
		process.stderr.write(USAGE);
		return 2;
	}
	const { numbers: numbersOnly, map } = args;

	const elsewhere = storeElsewhere();
	if (elsewhere?.store)
		say(
			`the claim store belongs to ${elsewhere.store}, not the tree you are in (${elsewhere.cwd}), so an empty list here means the wrong store was read — not that nothing is claimed.`,
		);
	// `--numbers` prints a DROP-list: a claim filter it cannot vouch for drops
	// nothing, and the warning above is enough. `--map` prints a KEEP-list,
	// where the same unvouched-for filter puts issues another live session is
	// working ON the frontier. So the keep-list refuses, on a store that is
	// merely unverifiable as much as on one that is demonstrably wrong (mantahostels#1145).
	if (elsewhere && map !== null) {
		say(
			`${elsewhere.unknown ?? "the claim store belongs to another tree"}, so the claim filter cannot be vouched for and a frontier built on it could offer work another session is already doing. Refusing.`,
		);
		return 1;
	}

	const live = liveClaims();
	if (typeof live === "number") return live;

	// The same set `--numbers` prints, applied here rather than by the caller.
	if (map !== null) return frontier(map, new Set(live.map((c) => c.issue)));
	printLive(live, numbersOnly);
	return 0;
}

/**
 * The live sessions' issue claims, oldest issue first, or exit code 1 where
 * what is claimed cannot be known.
 */
function liveClaims() {
	const { held, kept, why } = store.heldIssues(listedSessionIds());
	// `heldIssues` reports an unreadable claim store the same way it reports an
	// unreadable oracle — as a `why` — but the two need opposite answers, and
	// only `kept` tells them apart. Never an empty exclusion set on a store that
	// would not open (mantahostels#174).
	if (why && !kept) {
		say(
			`${why}, so what is claimed is unknown — not nothing. Drop nothing on this answer. See: node ${scriptPath("check-guard-errors.js")}`,
		);
		return 1;
	}
	// Keep-on-doubt, as pick-next does: a partial read of what is live may never
	// narrow the live set, so an unreadable oracle excludes every claim rather
	// than none.
	if (kept)
		say(
			`${why}, so every claim below stands and an issue excluded as claimed may in fact be free.`,
		);

	// Read again for the records themselves: heldIssues answers which issue and
	// which session, but not since when. It read the store first, so this guard only
	// trips if the store stopped opening between the two reads — untested, being
	// unreachable in-process.
	const listedClaims = store.listIssueClaims();
	if (listedClaims === null) {
		say(
			`could not read the issue-claim store at ${store.paths.issueClaimsDir()}, so what is claimed is unknown — not nothing. Drop nothing on this answer.`,
		);
		return 1;
	}
	if (listedClaims.why) {
		// heldIssues already refused on this signal above (why && !kept) —
		// untested, unreachable in-process, like the null check above it.
		say(`${listedClaims.why}. Drop nothing on this answer.`);
		return 1;
	}
	const claims = listedClaims.claims;

	return claims
		.filter((c) => held.has(c.issue))
		.sort((a, b) => a.issue - b.issue);
}

/**
 * @param {{ issue: number, sessionId: string, claimedAt: string }[]} live
 * @param {boolean} numbersOnly
 */
function printLive(live, numbersOnly) {
	if (numbersOnly) {
		// Nothing else on stdout, so an empty run is genuinely empty. Deduped:
		// the store holds one record per session per issue, so two sessions
		// claiming one issue would otherwise print it twice.
		for (const issue of new Set(live.map((c) => c.issue)))
			process.stdout.write(`${issue}\n`);
		return;
	}
	if (live.length === 0) {
		process.stdout.write("No issues are claimed by a live session.\n");
		return;
	}
	for (const c of live)
		process.stdout.write(`#${c.issue}\t${c.sessionId}\tsince ${c.claimedAt}\n`);
}

// `process.exitCode` rather than `process.exit`, which discards whatever stdout
// has buffered — `--numbers | head` would lose lines.
main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(e) => {
		// Fail closed on anything unforeseen: an unhandled rejection would exit 0
		// with an empty stdout.
		say(
			`${parseErrLine(e)} — an unexpected failure, so nothing above is an answer. Drop nothing.`,
		);
		process.exitCode = 1;
	},
);
