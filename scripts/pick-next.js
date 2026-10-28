#!/usr/bin/env node
/*
 * pick-next.js — the shortlist half of selection. Prints every issue takeable
 * right now, ordered, plus why each excluded issue was excluded.
 *
 * mantahostels#102 split selection into a script and a skill on "is there judgement in it".
 * The judgement — turning free text into a goal set, ordering the reach-0 tail,
 * saying why the top pick won — is `.claude/skills/pick-next/SKILL.md`. The seam
 * between them is `--goal`: a set of issue numbers, nothing the script parses.
 *
 * THIS SCRIPT NEVER WRITES. Not the `urgent` label, not an assignee, not a
 * comment. mantahostels#101 barred auto-stripping an `urgent` — two selection runs
 * would race to strip it — and mantahostels#111 rejected the skill applying one. Only
 * `gh api <path>` GETs and GraphQL `query` reads are issued below; a
 * `--method` or a `mutation` would breach both.
 *
 * The query is mantahostels#105's:
 *   1. One list call for open issues; PRs share the number space, so drop them.
 *   2. Readiness from each issue's canonical `blockedBy`, open blockers only,
 *      read in batches (lib/blocked-by-batch.js, #2685).
 *      `issue_dependencies_summary.blocked_by` is never read — the staleness
 *      trap (mantahostels#105).
 *   3. Parentage from `parent_issue_url`. /sub_issues is never walked: one call
 *      per issue, truncated at its per_page=30 default (mantahostels#105).
 *   4. An assigned issue drops out only where the session arbiter holds a claim
 *      on it AND that session is live (mantahostels#633, mantahostels#645);
 *      the assignee alone cannot name the session. A live claim on its parent
 *      drops it too (#2310),
 *      read off the same `parent_issue_url`, from the parent repo's own store
 *      where that is another repo (lib/parent-claims.js). No label is ever a
 *      filter for readiness, `takes:` included: nothing clears one on close
 *      (mantahostels#235).
 *   5. An open issue with >=1 open child is a heading, not work. Structural, not
 *      label-based (mantahostels#105).
 *   6. /dependencies/blocking is never called. Every blocking edge between two
 *      open issues is the inverse of some open issue's blocked_by, so inverting
 *      halves the call count.
 *
 * The sort, lexicographic (mantahostels#106, mantahostels#259, #2001, #2664, #3222):
 *   open `bug` -> `urgent`, own or inherited -> goal-set membership
 *   -> stalled wait -> ticket type
 *   -> chain depth -> transitive reach -> collision -> number
 *
 * Beneath the table sit three annotations, NONE a sort input: pairs of
 * shortlisted issues whose bodies name the same repo file (mantahostels#192), pairs of
 * a shortlisted issue with a claimed one naming the same file (mantahostels#384), and the
 * shortlisted issues predicted to write `docs/doc-map.md` (mantahostels#409).
 *
 * The machine is read too, and only read: `/proc/meminfo` and `ps`, for the
 * ADMISSION block that says whether one more session fits (mantahostels#384).
 *
 * "Never writes" is about the tracker. Three local, gitignored artefacts are
 * written: the `--dump-bodies` directory; the write-set cache under
 * `.pick-next/`, which this run reads, prunes against the open list, and writes
 * a PROVISIONAL entry into for every miss (`lib/write-set-cache.js`;
 * `lib/write-set-predict.js` derives them, `scripts/pick-next-cache.js` puts a
 * band read's);
 * and one line per run in the warm-fraction log beside it, which is the only
 * source of the churn figure mantahostels#385's 60-80% claim rests on (`lib/warm-fraction-log.js`;
 * `scripts/warm-fraction.js` reports it). A real run also mints the per-session
 * marker that arms `scripts/guard-selection-sum.js`, pinning the frontier size
 * it checks §5's sum against (`lib/selection-marker.js`, mantahostels#844) and the admission
 * slot count it checks §6's admission-cut line against (mantahostels#1321). `--no-log` skips
 * both.
 *
 * Usage: node scripts/pick-next.js [--goal 116,115] [--json] [--limit N] [--repo o/r]
 *                                  [--dump-bodies <dir>] [--no-log] [--no-prewarm]
 *
 * Exit codes:
 *   0  a shortlist was produced (possibly degraded — see DEGRADED below)
 *   1  no shortlist could be produced: the issue list itself was unreachable
 *
 * DEPARTS FROM §N7: `module.exports = { buildPayload, render, main }` (mantahostels#1794,
 * widened at mantahostels#1944) — reasons at each export's own site, above the
 * `module.exports` line.
 */

const { scriptPath } = require("./lib/script-path.js");
const fs = require("node:fs");
const nodePath = require("node:path");
const { writeFileAtomic } = require("./lib/atomic-write.js");
const { isOutcomeError } = require("./lib/check");
const {
	assertOpenRead,
	buildCollapsedFailureLine,
	parseErrLine,
	ghApiSlurpAsync,
	parseGhFailureReason,
	ghGetRetrying,
	ISSUE_READ_CONCURRENCY,
	groupByRepeatedError,
	mapLimit,
	unreachableRemedy,
} = require("./lib/gh");
const {
	listedSessionIds,
	TERMINAL_STATES: JOB_STATE_TERMINAL,
} = require("./lib/agent-liveness");
const { readJobs } = require("./lib/hung-jobs");
const { buildOverloadText } = require("./lib/cpu-sample");
const {
	NO_COMMAND_VALUES,
	TAKES_PREFIX,
	takesLabel,
	takesValue,
} = require("./lib/takes-label");
const arbiter = require("./lib/arbiter-store");
const writeSetCache = require("./lib/write-set-cache");
const writeSetPredict = require("./lib/write-set-predict");
const warmFractionLog = require("./lib/warm-fraction-log");
const selectionMarker = require("./lib/selection-marker");
const idSeam = require("./lib/session-id");
const { MAP_LABEL, resolveGate } = require("./lib/issue-gate");
const { holderName, parentVerdictOf } = require("./lib/parent-claims");
const { isInOtherRepo, parseIssueRef } = require("./lib/issue-ref");
const { unparsedBlockersOf } = require("./lib/prose-blockers");
const blockerGraph = require("./lib/blocker-graph");
const {
	blockedByMany,
	readBlockedByOne,
	edgeOf,
} = require("./lib/blocked-by-batch");
const {
	homeDir,
	readCheckoutTracking,
	readHostTracker,
} = require("./lib/refill-repos");
const conflictGraph = require("./lib/conflict-graph");
const strandedCount = require("./lib/stranded-count");
const {
	RETRO_BUNDLE_CAP,
	retroBundles,
	retroLaunches,
} = require("./lib/retro-bundles");
const { hostRoot } = require("./lib/host-root.js");
const { execGit, gitCommonDir, gitOrNull } = require("./lib/git.js");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const {
	readRecentEntries: recentDispatches,
	entryHolds,
	DEFAULT_WINDOW_HOURS: DISPATCH_WINDOW_HOURS,
} = require("./lib/dispatch-ledger");
const { compareLevels } = require("./lib/frontier-order.js");
const { labelAge } = require("./lib/label-age.js");
const { snapshotFile } = require("./lib/pick-next-snapshot.js");

const REPO_DEFAULT = "{owner}/{repo}";
/**
 * The tree whose tracked files decide whether a backticked token is a path: the
 * HOST repo, through the one seam (#1). WFC_REPO_ROOT stays in front of it as
 * the test-injection point. Script-relative before that, which in a plugin
 * install put this report's root and the arbiter's state directory in two
 * different trees — the disagreement `/pick-next` printed as CLAIMS DEGRADED.
 */
const REPO_ROOT = process.env.WFC_REPO_ROOT || hostRoot();
const URGENT_LABEL = "urgent";

/*
 * `waiting:external` — the action has been taken and now sits with someone
 * outside the project, so nobody here can move it (mantahostels#243).
 *
 * ESCALATES WITH AGE, NEVER DEMOTES. Sinking a waiting issue would make a stall
 * quieter the longer it ran, which is the failure mantahostels#85 (no working channel to
 * an outside partner) already suffered. So a wait at the threshold below climbs, and
 * one under it ranks exactly as it would with no label at all.
 *
 * 7 DAYS — the first of the three actions the evidence puts a date on, from
 * the wait-threshold research mantahostels#956 re-derived (75%, 65-85%, that 7
 * beats both 3 and 14), replacing the 14-day guess mantahostels#259 set;
 * docs/agents/triage-labels.md owns the figure. The research's later points — switch channel at
 * 21 days, non-responsive at 45 — need no threshold of their own: escalating is
 * a prompt to look rather than the action itself, and rank goes on climbing
 * with age past this one. A threshold rather than a curve because at most three
 * issues can carry this label, so a curve would tune invisible differences.
 *
 * Rejected — 14, which the same research also supports: its closest structural
 * match puts the modal first chase at 1-2 weeks, and a desk the adopter must
 * return to for the price-comparison consent makes being logged a nuisance an
 * asymmetric cost. 7 survives that because what fires here is the
 * receipt-confirmation chase the research separates out — a factual question an
 * inbox answers without deciding anything — not the decision chase.
 */
const WAITING_LABEL = "waiting:external";
const WAITING_STALL_DAYS = 7;

/*
 * `parked` — a session posted a house question round on the issue and ended
 * `needs input:`, so relaunching it re-asks the round (#2000, spec #1995); or
 * the refill loop stopped a blocked session on it, whatever the cause (#2699).
 * Writers: lib/parked.js. Choosable here (#2355, #2703); the refill loop is
 * what holds it out of a launch (lib/refill-decide.js). Listed under PARKED
 * with its age: the block is the label's reader, without which a park goes
 * quiet (mantahostels#243, mantahostels#259).
 */
const { PARKED_LABEL } = require("./lib/parked.js");

const args = process.argv.slice(2);
const { flags } = parseOrExit(args, {
	usage:
		"usage: node scripts/pick-next.js [--goal 116,115] [--json] [--limit N] [--repo o/r]\n" +
		"                                 [--dump-bodies <dir>] [--no-log] [--no-prewarm]",
	flags: {
		"--goal": "value",
		"--json": "boolean",
		"--limit": "value",
		"--repo": "value",
		"--dump-bodies": "value",
		"--no-log": "boolean",
		"--no-prewarm": "boolean",
	},
});
const asJson = flags["--json"] === true;
const REPO = flagValue(flags, "--repo") ?? REPO_DEFAULT;
/* A display cap: it slices the printed table and `shown`, never the frontier
 * any count, check or written report is taken over (mantahostels#1289, mantahostels#3363). */
const LIMIT = Number(flagValue(flags, "--limit") ?? 0) || 0;
const DUMP_DIR = flagValue(flags, "--dump-bodies");
/*
 * The warm-fraction log records real re-picks and nothing else (mantahostels#628), so a run
 * made to exercise the script rather than to pick work opts out here.
 */
const NO_LOG = flags["--no-log"] === true;
/*
 * For a run diagnosing why a ticket keeps going cold, which needs to see the
 * miss rather than have it filled in (mantahostels#1001).
 */
const NO_PREWARM = flags["--no-prewarm"] === true;
const goalSet = new Set(
	String(flagValue(flags, "--goal") ?? "")
		.split(/[,\s]+/)
		.filter(Boolean)
		.map((s) => Number(s.replace(/^#/, "")))
		.filter(Number.isInteger),
);

/** @param {string} path */
async function ghGet(path) {
	// Deliberately no --jq: every projection happens in JS below, which keeps the
	// whole shape of the query visible in this file and testable against a stub
	// `gh` that would otherwise have to reimplement a jq filter to be exercised.
	return ghApiSlurpAsync([path]);
}

// ------------------------------------------------------------------ collection

/**
 * What the GitHub listing gives.
 * @typedef {object} RawIssue
 * @property {number} number
 * @property {string} title
 * @property {string} url
 * @property {string[]} assignees
 * @property {string[]} labels
 * @property {string} body
 * @property {string|null} parent
 * @property {string|null} repo the repo it lives in, `owner/name`
 */

/**
 * That, plus everything `main` hangs on it before anything reads one.
 *
 * EVERY FIELD IS OPTIONAL HERE, AND REQUIRED IN `Issue` BELOW, so a read placed
 * before the field is assigned does not compile (mantahostels#1637).
 *
 * IT DOES NOT CATCH ALL OF THEM. A field only used for its truthiness is not
 * protected, `undefined` being falsy like `false`: that is the booleans, the
 * two `unknown`s, and `urgency`/`urgentVia`/`wait`/`gate`/`gateOn`, whose types
 * already admit a falsy value.
 * @typedef {object} Enrichment
 * @property {string[]} [paths]
 * @property {import("./lib/blocker-graph").Edge[]} [blockedBy]
 * @property {unknown} [depsUnknown]
 * @property {ReturnType<typeof proseBlockedOf>} [proseBlocked]
 * @property {{label: string, native: boolean}[]} [openBlockers]
 * @property {number} [reach]
 * @property {ReturnType<typeof labelAge>|null} [urgency] the issue's own `urgent`'s age, null where the label is off
 * @property {import("./lib/blocker-graph").Via|null} [urgentVia] the held issue whose `urgent` it inherits, null where none does
 * @property {import("./lib/blocker-graph").Via|null} [bugVia] the held `bug` it inherits, null where none does
 * @property {import("./lib/blocker-graph").Via|null} [goalVia] the held goal-set member it inherits, null where none does
 * @property {number} [depth]
 * @property {boolean} [bug]
 * @property {boolean} [urgent]
 * @property {ReturnType<typeof waitFrom>|null} [wait]
 * @property {number} [stallDays]
 * @property {ReturnType<typeof labelAge>|null} [parked] `parked`'s age, null where the label is off
 * @property {boolean} [goal]
 * @property {number} [collision]
 * @property {boolean} [asksQuestions]
 * @property {string[]} [takes]
 * @property {string} [group]
 * @property {ReturnType<import("./lib/issue-gate").gateOf>} [gate]
 * @property {ReturnType<import("./lib/issue-gate").gateOnOf>} [gateOn]
 * @property {boolean} [gateConflict]
 * @property {boolean} [gateHolds]
 * @property {boolean} [gateOnHolds]
 * @property {unknown} [excluded]
 * @property {import("./lib/dispatch-ledger").DispatchRecord} [dispatchRec] the ledger entry holding it (#752)
 * @property {boolean} [dispatchHeld]
 * @property {boolean} [assignedUnclaimed]
 */

/**
 * Mid-enrichment: whatever `main` has assigned so far, nothing promised.
 * @typedef {RawIssue & Enrichment} Enriching
 */

/**
 * The first three fields resolved, the rest still pending. The passes that read
 * a blocker before the rest of enrichment has run take this rather than
 * `Enriching`.
 * @typedef {Enriching &
 *   Required<Pick<Enrichment, "blockedBy" | "depsUnknown" | "proseBlocked">>
 * } DepsResolved
 */

/**
 * Post-enrichment, which is what everything downstream of `main`'s enrichment
 * block reads.
 *
 * `paths` stays optional: `annotatePaths` returns it, on copies of `frontier`
 * and `inFlight` only, well below `enrichIssue`. So does `dispatchRec`, absent
 * wherever no ledger entry holds the issue.
 * @typedef {RawIssue & Required<Omit<Enrichment, "paths" | "dispatchRec">> & {paths?: string[], dispatchRec?: import("./lib/dispatch-ledger").DispatchRecord}} Issue
 */

/**
 * An issue `annotatePaths` has run over, which is the only place `paths` is
 * safe to read.
 * @typedef {Issue & {paths: string[]}} Pathed
 */

/*
 * Type-predicate filters, so a `.filter(...).map(...)` pair narrows the field
 * a `.filter((i) => i.gate)` truthy-check alone does not carry across.
 */
/** @type {(i: Issue) => i is Issue & {gate: NonNullable<Issue["gate"]>}} */
const hasGate = (i) => i.gate !== null;
/** @type {(i: Issue) => i is Issue & {gateOn: NonNullable<Issue["gateOn"]>}} */
const hasGateOn = (i) => i.gateOn !== null;
/** @type {(i: Issue) => i is Issue & {wait: NonNullable<Issue["wait"]>}} */
const hasWait = (i) => i.wait !== null;
/** @type {(i: Issue) => i is Issue & {parked: NonNullable<Issue["parked"]>}} */
const hasParked = (i) => i.parked !== null;

/** @typedef {{ok: true, files: string[]} | {ok: false, error: string}} TrackedFiles */

/**
 * The STORED half of a cache row: what `writeEntry` builds and `readEntry` hands
 * back, in `scripts/lib/write-set-cache.js`.
 *
 * `writeSet` is the one field guaranteed — `readEntry` returns null rather than
 * a row where `isPathList(e.writeSet)` fails. The rest are optional because it
 * validates neither their presence nor their type, so an entry written before a
 * field existed reads as undefined (mantahostels#1460).
 * @typedef {object} StoredEntry
 * @property {string[]} writeSet
 * @property {string|null} [sizeBand]
 * @property {string|null} [gist]
 * @property {string} [derivedAt]
 * @property {string|null} [predictedSize]
 */

/**
 * One cache row as a caller reads it: the stored entry, plus the fields
 * `lookupAll` and `prewarm` hang on it. `number`, `provisional` and
 * `unrevalidated` are set on every row by both; `replaced` is `prewarm`'s alone,
 * written on a provisional row and on nothing else.
 * @typedef {StoredEntry & {number: number, provisional: boolean, unrevalidated: boolean, replaced?: string|null}} CacheEntry
 */

/**
 * A cache miss: the issue, why it missed, and the key to store the band read's
 * answer back under.
 * @typedef {object} CacheMiss
 * @property {number} number
 * @property {string} state
 * @property {string} bodyHash
 * @property {string[]|null} gonePaths
 */

/** @typedef {{warm: CacheEntry[], cold: CacheMiss[]}} CacheSplit */

/**
 * What `listedSessionIds()` in `scripts/lib/agent-liveness.js` hands back. It
 * DEGRADES TO DOUBT, NEVER TO "DEAD": either the oracle answered and every map
 * is present, or it refused and `why` is the only field there is. Written as
 * two shapes rather than one all-optional shape so that a `listed.why` test
 * narrows, and a reader of `listed.ids` — the admission block's session count,
 * below — reads it without making one (mantahostels#1460).
 * @typedef {{why: string, ids?: undefined, names?: undefined, finished?: undefined, terminal?: undefined, pids?: undefined}} SessionsRefused
 * @typedef {{why?: undefined, ids: Set<string>, names: Map<string, string>, finished: Set<string>, terminal: Set<string>, pids: Map<string, number>}} SessionsListed
 * @typedef {SessionsRefused|SessionsListed} ListedSessions
 */

/**
 * Frontier issues whose body is empty or whitespace-only (mantahostels#3443): a failed
 * create, naming no parent for check-issue-orphans.js to catch. Display only:
 * it excludes nothing.
 * @param {{number: number, title: string, body: string}[]} frontier
 */
const emptyBodiedOf = (frontier) =>
	frontier
		.filter((i) => !i.body.trim())
		.map((i) => ({ number: i.number, title: i.title }));

/** The repo the open-issues list reads, `owner/name`, or null. */
function listRepo() {
	return REPO === REPO_DEFAULT ? readHostTracker(REPO_ROOT) : String(REPO);
}

async function openIssues() {
	const read = () => ghGet(`repos/${REPO}/issues?state=open&per_page=100`);
	let issues = await read();
	if (issues.length === 0) issues = assertOpenRead(await read(), REPO);
	return /** @type {Enriching[]} */ (
		issues
			.filter((/** @type {any} */ i) => !i.pull_request)
			.map((/** @type {any} */ i) => ({
				// The list's own repo where a row carries no repository_url, so a
				// same-repo parent is never read as another repo's.
				...edgeOf(i, listRepo()),
				assignees: (i.assignees || []).map((/** @type {any} */ a) => a.login),
				parent: i.parent_issue_url,
			}))
	);
}

/**
 * One issue in another repo, for a blocker only a `**Blocked on**` marker
 * names.
 * @param {import("./lib/issue-ref").IssueRef} ref
 * @returns {Promise<{ok: false, error: string} | {ok: true, issue: import("./lib/blocker-graph").Edge}>}
 */
async function readIssueIn(ref) {
	const r = await ghGetRetrying(`repos/${ref.repo}/issues/${ref.number}`);
	if (!r.ok) return r;
	const issue = r.out[0];
	if (!issue) return { ok: false, error: "gh printed no issue" };
	return { ok: true, issue: edgeOf(issue, ref.repo) };
}

/**
 * Both age-sensitive labels read the same timeline, so an issue carrying both
 * costs one call, not two.
 * @param {number} n
 * @returns {Promise<{ok: true, events: any[]} | {ok: false, error: string}>}
 */
async function readTimelineOf(n) {
	const r = await ghGetRetrying(
		`repos/${REPO}/issues/${n}/timeline?per_page=100`,
	);
	return r.ok ? { ok: true, events: r.out } : { ok: false, error: r.error };
}

/**
 * Each issue's inherited tiers and chain depth (#3222), read at selection
 * time and never written onto it. A `bug`, an `urgent` and a goal-set member
 * pass on from any issue held out, as a blocker or as a parent (#3250).
 * @param {import("./lib/blocker-graph").Graph} graph
 * @param {Map<number, RawIssue>} byNumber
 */
function inheritanceOf(graph, byNumber) {
	/** @param {number} n @param {string} label */
	const has = (n, label) => byNumber.get(n)?.labels.includes(label) === true;
	// In compareLevels' order: depth runs to the first of these an issue holds.
	return blockerGraph.inheritance(graph, {
		bug: (n) => has(n, "bug"),
		urgent: (n) => has(n, URGENT_LABEL),
		goal: (n) => goalSet.has(n),
	});
}

/**
 * The tier levels an issue ranks on: its own joined with what it inherits,
 * a `bug` urgent too (#2664).
 * @param {{bug: boolean, urgent: boolean, goal: boolean}} own
 * @param {ReturnType<ReturnType<typeof inheritanceOf>>} held
 */
function tiersOf(own, held) {
	const bug = own.bug || held.via.bug !== null;
	return {
		bug,
		urgent: bug || own.urgent || held.via.urgent !== null,
		goal: own.goal || held.via.goal !== null,
		depth: held.depth,
	};
}

/**
 * The wait reads the same timeline for the same reason `urgent` does: a
 * hand-written date in the body rots, and nothing updates it when the wait
 * resets.
 *
 * An unreadable start leaves the wait unranked rather than assumed stalled: the
 * worst case is a stall keeping the rank it has today and printing `?`.
 * @param {{ok: boolean, events?: any[], error?: any}} timeline
 * @returns {{unknown: true, error: any, ageDays?: undefined, appliedAt?: undefined, appliedBy?: undefined, stalled?: undefined}
 *   | {unknown?: false, error?: undefined, ageDays: number, appliedAt: string, appliedBy: string, stalled: boolean}}
 */
function waitFrom(timeline) {
	const age = labelAge(timeline, WAITING_LABEL);
	return age.unknown
		? age
		: { ...age, stalled: age.ageDays >= WAITING_STALL_DAYS };
}

// -------------------------------------------------------------------- analysis

/**
 * @param {RawIssue} issue
 * @param {Set<number>} mapNumbers
 * @param {Set<number>} specNumbers
 */
function groupOf(issue, mapNumbers, specNumbers) {
	if (issue.labels.includes("wayfinder:map")) return "map root";
	if (issue.labels.includes("kind:spec")) return "spec root";
	if (!issue.parent) return "standalone";
	const parent = parseIssueRef(issue.parent)?.number ?? null;
	if (parent !== null && mapNumbers.has(parent)) return `map #${parent}`;
	if (parent !== null && specNumbers.has(parent)) return `spec #${parent}`;
	return `child of #${parent}`;
}

/*
 * Collision estimate — the collision sort level (mantahostels#106), and its
 * weakest ruling (70%, band 55-82%). A `wayfinder:grilling` or `:research`
 * ticket resolves by writing a comment and closing an issue, touching no repo
 * file, so it cannot collide with a parallel session on `doc-map.md` or the
 * roadmap pair. Everything else is assumed to write. This reads labels applied
 * for other reasons — mantahostels#96 ruled out a label declaring what a
 * session will touch, because that is a promise agents break.
 */
const COMMENT_ONLY = ["wayfinder:grilling", "wayfinder:research"];
/** @param {RawIssue} issue */
const collisionOf = (issue) =>
	issue.labels.some((l) => COMMENT_ONLY.includes(l)) ? 0 : 1;

/*
 * Ticket type — #2001. A ticket that asks the founder questions ranks first,
 * so its round lands while the founder is present rather than behind a long
 * implement run. Untyped means no `wayfinder:` label at all: a `wayfinder:map`
 * asks nothing by itself. Every case needs `takes:wayfinder`, since a `takes:`
 * value overrides a type label that disagrees with it
 * (docs/agents/triage-labels.md §`takes:`).
 * Residual: labels are all it reads, so a ticket that asks questions without
 * one of these labels ranks as one that asks none.
 */
const QUESTION_TYPES = ["wayfinder:grilling", "wayfinder:prototype"];
const WAYFINDER_LABEL = takesLabel("wayfinder");
/** @param {RawIssue} issue */
const isQuestionType = (issue) =>
	issue.labels.includes(WAYFINDER_LABEL) &&
	(issue.labels.some((l) => QUESTION_TYPES.includes(l)) ||
		!issue.labels.some((l) => l.startsWith("wayfinder:")));

/*
 * The `takes:` values, shown so a batch says what to type per issue without
 * opening any of it (mantahostels#227). Never a filter, per rule 4 above, and
 * mantahostels#111 rejected selection writing one. Its one sort input is
 * `takes:wayfinder`, read by `isQuestionType` above (#2001). A missing
 * or duplicated value prints as it is; check-issue-labels.js reports it.
 *
 * `waiting:external` reaching the sort above does NOT contradict that (mantahostels#243).
 * Rule 4 bars a label from deciding whether an issue is takeable, because no
 * close clears one. This one removes nothing from the shortlist, and what the
 * sort reads is elapsed time on the timeline, which a stale label cannot fake.
 */
const HUMAN = takesValue("human");
const CHILDREN = takesValue("children");
const RETRO_LABEL = takesLabel("triage");
/** @param {RawIssue} issue */
const takesOf = (issue) =>
	issue.labels
		.filter((l) => l.startsWith(TAKES_PREFIX))
		.map((l) => l.slice(TAKES_PREFIX.length));
// "none" is a fault, not a state — every open issue carries one.
/** @param {string[]} takes */
const takesCell = (takes) => (takes.length > 0 ? takes.join("+") : "none");

/**
 * NO COMMAND OPENS IT (mantahostels#1622, built at mantahostels#1626) — the accounting line's third
 * term. `takes:human` is founder work, and `takes:children` is a container
 * whose last child has closed: both sit on the frontier takeable by nobody a
 * `/`-command can start.
 *
 * THE OPEN-CHILD COUNT IS A PARAMETER, NOT AN ASSUMPTION. A live container is
 * held off the frontier by the exclusion cascade below (`container — <n> open
 * children`), so on the frontier this arm fires only on the rotted case — but
 * any caller applying this to a different set owes the count itself. That is
 * the distinction against mantahostels#1507's `dispatchable` predicate, which subtracts
 * `children` unconditionally from `graph.proposed`: same two label values,
 * different rule, so the two deliberately do not share a body.
 *
 * SO THE `openChildCount === 0` CLAUSE IS UNVERIFIED. No frontier fixture can
 * present a non-zero count — the exclusion cascade got there first — so no test
 * distinguishes this from `takes.includes(CHILDREN)` alone. Do not delete it
 * on that reading: it is what keeps the term right if that cascade is reordered.
 *
 * @param {string[]} takes
 * @param {number} openChildCount
 */
const noCommandOpens = (takes, openChildCount) =>
	takes.includes(HUMAN) || (takes.includes(CHILDREN) && openChildCount === 0);

/**
 * The WAIT cell: whole days since `waiting:external` went on, `!` marking the
 * wait past the threshold — the only one the sort reads. `?` is the label on
 * with its start unreadable, which leaves the rank untouched.
 * @param {Issue} issue
 */
const waitCell = (issue) => {
	if (!issue.wait) return "";
	if (issue.wait.unknown) return "?";
	return `${Math.floor(issue.wait.ageDays)}d${issue.wait.stalled ? "!" : ""}`;
};

/**
 * Elapsed days, or null where the label is off or its start unreadable.
 * @param {Issue} issue
 */
const waitDays = (issue) =>
	issue.wait && !issue.wait.unknown ? issue.wait.ageDays : null;

/**
 * Days since `parked` went on; an unreadable start sorts as the oldest, since
 * an unknown age is the one a reader cannot rule out as stale.
 * @param {Issue} issue
 */
const parkedDays = (issue) =>
	issue.parked && !issue.parked.unknown
		? issue.parked.ageDays
		: Number.POSITIVE_INFINITY;

/*
 * Path intersection — mantahostels#192. The estimate above is one bit per issue and so can
 * never say two shortlisted tickets collide *with each other*, which is the
 * collision a batch-planning session actually trips over: measured 6 real pairs
 * in one session, 4 of them the same repo path written into both issue bodies.
 *
 * ADVISORY ONLY, and deliberately not a sort input or an exclusion. A body may
 * name a file as context rather than as an edit target, and inferring edit
 * *intent* from prose is where precision dies — mantahostels#185 measured a prose-content
 * detector at ~15% while its presence check was fine.
 */
/** @type {TrackedFiles|undefined} */
let trackedCache;
function readTrackedFiles() {
	if (trackedCache) return trackedCache;
	/** @type {TrackedFiles} */
	let read;
	try {
		// -z, because a tracked filename may hold a space or an accent (mantahostels#148).
		const out = execGit(["ls-files", "-z"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		});
		read = { ok: true, files: out.split("\0").filter(Boolean) };
	} catch (e) {
		read = { ok: false, error: parseErrLine(e) };
	}
	trackedCache = read;
	return read;
}

/*
 * Path resolution and the backtick scan live in `lib/write-set-predict.js`, so
 * the prediction this run STORES and the collisions it PRINTS are read off one
 * scanner rather than two that can drift (mantahostels#1001).
 */
const { pathsNamedIn } = writeSetPredict;

/**
 * Each issue with the tracked paths its body names; none if git failed.
 * @param {Issue[]} list
 * @param {TrackedFiles} tracked
 * @returns {Pathed[]}
 */
function annotatePaths(list, tracked) {
	return list.map((i) => ({
		...i,
		paths: tracked.ok ? pathsNamedIn(i.body, tracked.files) : [],
	}));
}

/**
 * The paths two annotated issues both name, in the first one's order.
 *
 * Typed on the one field it reads rather than on `Issue`: the second argument
 * is an in-flight record as often as a candidate, and those two agree on
 * `paths` and on nothing else worth asserting here (mantahostels#1460).
 * @param {{paths: string[]}} a
 * @param {{paths: string[]}} b
 */
const sharedPaths = (a, b) => a.paths.filter((p) => b.paths.includes(p));

/*
 * The doc-map queue — mantahostels#409. Most open issues would write `docs/doc-map.md`, at
 * the END of their run: it is a STAMP, so they queue there and run together,
 * and sharing it disqualifies nobody (mantahostels#422, .claude/skills/pick-next/SKILL.md). `pairwiseCollisions` above
 * cannot see them: their bodies name the entry (`§B56`), never a backticked
 * `docs/doc-map.md`.
 *
 * `scripts/lib/file-claim.js` stays the enforcement tier.
 */
const DOC_MAP_HINT = writeSetPredict.DOC_MAP_HINT;
/** @param {any[]} list */
const docMapQueueOf = (list) =>
	list.filter((i) => DOC_MAP_HINT.test(i.body)).map((i) => i.number);

/**
 * Fills every cache miss with a grep prediction and returns the run's THREE-WAY
 * split — band-read warm, provisional, and the misses no prediction could cover
 * (mantahostels#1001).
 *
 * WHY THIS RUN AND NOT THE NEXT. The prediction is stored AND folded into this
 * run's own split, so the run that discovers a miss is already the run that
 * stops paying for it (mantahostels#1001).
 *
 * `provisional` IS NEVER MERGED INTO `warm`. A band read is an agent's judgement
 * of one issue; this is a regex over its backticks.
 * @param {string} root
 * @param {Issue[]} frontier
 * @param {{ tracked: TrackedFiles, split: CacheSplit, enabled: boolean }} opts
 */
function prewarm(root, frontier, { tracked, split, enabled }) {
	const warm = split.warm.filter((w) => !w.provisional);
	const provisional = split.warm.filter((w) => w.provisional);
	if (!enabled)
		return { warm, provisional, cold: split.cold, skipped: [], enabled };

	const byNumber = new Map(frontier.map((i) => [i.number, i]));
	const cold = [];
	const skipped = [];
	for (const miss of split.cold) {
		const issue = byNumber.get(miss.number);
		const r = issue
			? writeSetPredict.storeProvisional(root, issue, tracked)
			: { ok: false, why: "not on the frontier this run read" };
		if (!r.ok) {
			// Unpredictable or unstorable: it stays cold, and the band read still
			// owns it.
			cold.push(miss);
			skipped.push({ number: miss.number, why: r.why });
			continue;
		}
		/* Cast on `r.entry` alone, so the four fields written here stay checked,
		 * and to `StoredEntry`, which is the half the store returns. Needed
		 * because `storeProvisional`'s `{ok, entry}` union does not narrow on
		 * `r.ok`; true because `writeEntry` builds `writeSet ?? []` on every
		 * entry and hands that same object back (mantahostels#1460).
		 */
		provisional.push({
			number: miss.number,
			.../** @type {StoredEntry} */ (r.entry),
			provisional: true,
			// Freshly derived against the tree this run listed, so the rename check
			// cannot be stale.
			unrevalidated: false,
			// What the prediction was written over: `cold` is a first sighting,
			// anything else a band read this body or this tree has outrun.
			replaced: miss.state,
		});
	}
	return { warm, provisional, cold, skipped, enabled };
}

/**
 * The bodies are already on the list payload, so dumping them costs no request —
 * never add one here (mantahostels#409). A failed dump is reported, never fatal.
 * @param {string} dir
 * @param {any[]} list
 */
function dumpBodies(dir, list) {
	try {
		fs.mkdirSync(dir, { recursive: true });
		for (const i of list)
			fs.writeFileSync(
				nodePath.join(dir, `${i.number}.md`),
				// The cache key rides along so a band read working only from this
				// directory can store its result back without recomputing it (mantahostels#385).
				`# #${i.number} — ${i.title}\n\n<!-- body-hash: ${writeSetCache.bodyHash(i.body)} -->\n\n${i.body}\n`,
			);
		return { ok: true, dir, count: list.length };
	} catch (e) {
		return { ok: false, dir, count: 0, error: parseErrLine(e) };
	}
}

/**
 * Every pair of the given issues sharing at least one named path, in list order.
 * @param {any[]} list
 */
function pairwiseCollisions(list) {
	const out = [];
	for (let a = 0; a < list.length; a++)
		for (let b = a + 1; b < list.length; b++) {
			const shared = sharedPaths(list[a], list[b]);
			if (shared.length > 0)
				out.push({ a: list[a].number, b: list[b].number, paths: shared });
		}
	return out;
}

/*
 * Every pair of a candidate and an in-flight (claimed) issue sharing a path.
 * The in-flight set is dropped from the shortlist, so `pairwiseCollisions`
 * above can never see it — yet it is the set someone is writing right now.
 */
/*
 * Printed pairs are capped; --json carries the lot. A hot file drives the count
 * quadratically — one live run gave 94 pairs, most of them `docs/doc-map.md`,
 * which nearly every open issue names — and a list that long buries the
 * shortlist above it.
 */
const INFLIGHT_PRINT_CAP = 20;

/** Graph rows printed per block; --json carries the lot. UNMEASURED, unlike INFLIGHT_PRINT_CAP. */
const GRAPH_PRINT_CAP = 20;
/** Files named in the graph's by-file summary. */
const GRAPH_FILE_CAP = 8;
/**
 * A session's name is its own header line, and this repo's runs to the issue
 * title — long enough to push the file that matters off the right of the row.
 * @param {string} s
 */
const sessionName = (s) =>
	String(s).length > 34 ? `${String(s).slice(0, 33)}…` : String(s);

/** Warm entries printed; --json carries the lot. UNMEASURED, unlike INFLIGHT_PRINT_CAP. */
const WRITE_SET_PRINT_CAP = 20;
/** NOT PROPOSED rows printed; --json carries the lot. UNMEASURED, set to match the caps beside it. */
const NOT_PROPOSED_PRINT_CAP = 20;
const DERIVE_PER_LINE = 12;

/**
 * The `... and N more` line under a capped list. Shared by all three cache
 * lists, so none of them can silently truncate while its neighbours say so.
 * @param {number} total
 * @param {string} label
 */
const printOverflow = (total, label) => {
	if (total > WRITE_SET_PRINT_CAP)
		console.log(
			`  ... and ${total - WRITE_SET_PRINT_CAP} more ${label} — --json carries every one.`,
		);
};

/**
 * One cache entry as `--json` reports it. `provisional` and `replaced` ride on
 * every row rather than on the list it sits in, so a consumer that flattens the
 * two lists still knows which kind each row is.
 * @param {CacheEntry} w
 */
const cacheEntryJson = (w) => ({
	number: w.number,
	writeSet: w.writeSet,
	sizeBand: w.sizeBand,
	// The coarse small/medium/large guess (mantahostels#1289) — provisional entries only,
	// null on a band read. Answers whether a band read is even needed for
	// `sizeBand`.
	predictedSize: w.predictedSize ?? null,
	gist: w.gist,
	derivedAt: w.derivedAt,
	provisional: w.provisional === true,
	// The lookup state the prediction was written over; null for a band read, and
	// for a prediction carried in from an earlier run's store.
	replaced: w.replaced ?? null,
	// git could not list the tree, so the rename check never ran.
	unrevalidated: w.unrevalidated === true,
});

/**
 * `n` per line, so a long derive list wraps on issue numbers, not mid-number.
 * @param {string[]} items
 * @param {number} n
 */
function chunk(items, n) {
	const rows = [];
	for (let i = 0; i < items.length; i += n)
		rows.push(items.slice(i, i + n).join(" "));
	return rows;
}

/**
 * Who holds a claim, for a reader. The assignee is what a person recognises; the
 * claim's own session is all there is where a session recorded without assigning
 * itself, and that claim is in flight all the same.
 *
 * NAMED, NOT NUMBERED. `names` is the oracle's id -> display name map, so the
 * row reads `session Implement 708` rather than a bare uuid. It falls back to a
 * short id where the oracle named nothing.
 *
 * A DEGRADED READ NEVER ASSERTS LIVENESS (mantahostels#708).
 * @param {string[]|null|undefined} assignees
 * @param {string|null|undefined} session
 * @param {boolean|undefined} kept
 * @param {Map<string, string>|null|undefined} names
 */
function claimHolder(assignees, session, kept, names) {
	const who =
		assignees && assignees.length > 0
			? assignees.join(", ")
			: `session ${holderName(names, session)}`;
	return kept ? `${who}, liveness unread` : who;
}

/**
 * @param {any[]} candidates
 * @param {any[]} inFlight
 * @param {Map<number, any>} held
 */
function crossCollisions(candidates, inFlight, held) {
	const out = [];
	for (const c of candidates)
		for (const r of inFlight) {
			const shared = sharedPaths(c, r);
			if (shared.length > 0)
				out.push({
					candidate: c.number,
					inFlight: r.number,
					// Joined only at the print; --json readers get the list.
					claimedBy: r.assignees,
					// The claim's own session (mantahostels#708): `claimedBy` is empty where a
					// session recorded without assigning.
					claimedSession: held.get(r.number) ?? null,
					paths: shared,
				});
		}
	return out;
}

// ------------------------------------------------------------------ admission

/*
 * Admission (mantahostels#384), not a batch: a fixed batch of sessions is a
 * synchronisation barrier the work does not have: members finish at
 * different times, so slots sit idle while later issues are already unblocked.
 *
 * The figures and the arithmetic live in `lib/admission.js` (mantahostels#1144), so the
 * dispatch-time re-read `.claude/skills/pick-next` §5 calls for
 * (`scripts/admission.js`) computes them exactly as this block does.
 */
const {
	machineAdmission,
	LAUNCH_SPARES,
	buildSessionDrawLine,
	buildSessionFloorLine,
	buildLiveDrawLine,
	admissionFrom,
	buildMemoryBreakdownLines,
	buildSessionCeilingText,
} = require("./lib/admission");
const { readLiveLanders } = require("./lib/local-tester.js");
/** @typedef {ReturnType<typeof machineAdmission>} Machine */

/**
 * The same directory named two ways, or `null` where either cannot be resolved.
 * Symlinks are followed: a worktree and its canonical checkout are genuinely
 * different trees, but `/home/x` and a symlink to it are one.
 * @param {string} dir
 */
function readRealOrNull(dir) {
	try {
		return fs.realpathSync(dir);
	} catch {
		return null;
	}
}

/**
 * The canonical checkout of the tree at `dir`, or null where git cannot say.
 *
 * `--git-common-dir` is the same `.git` from inside a linked worktree as from
 * inside the checkout that owns it, so its parent is the canonical tree —
 * which `--show-toplevel` is not, and cannot be made to be.
 *
 * BUT ONLY WHERE THE TWO GIT DIRS DIFFER, which is what makes a tree a linked
 * worktree. Taking the parent unconditionally misreads a submodule, whose
 * common dir is `<super>/.git/modules/<name>` — a real directory that is no
 * checkout, so the run would announce a "worktree of" a tree nobody has.
 * @param {string} dir
 */
function readCanonicalCheckoutOf(dir) {
	const common = gitCommonDir(dir);
	const gitDir =
		gitOrNull(["rev-parse", "--path-format=absolute", "--git-dir"], {
			cwd: dir,
		})?.trim() ?? null;
	if (!common || !gitDir) return null;
	return gitDir === common
		? readRealOrNull(dir)
		: readRealOrNull(nodePath.dirname(common));
}

/*
 * WHICH TREE THE CLAIMS CAME FROM (mantahostels#703).
 *
 * This script pins its repo with WFC_REPO_ROOT; the arbiter store derives its
 * own state directory from CLAUDE_PROJECT_DIR, falling back to `git rev-parse`
 * of the working directory.
 *
 * THE INVARIANT IS NOT THAT THE TWO ROOTS AGREE. It is that the store's tree is
 * the tree the claims were filed under. Neither variable is set in this
 * project's own environment, so a run from a throwaway worktree has both sides
 * resolving independently to that worktree; they agree, and the store is still
 * the wrong one, because every claim was filed under the slug of the canonical
 * checkout.
 *
 * The failure that matters is silence: a store resolving cleanly to the wrong
 * empty directory reads exactly like a genuinely unclaimed frontier, so the
 * fail-open mantahostels#633 chose happens without the announcement mantahostels#645 built for it.
 *
 * Returns `{why, use}` — the sentence, and the tree whose store holds the
 * claims this run should have read.
 */
function storeElsewhere() {
	const mine = readRealOrNull(REPO_ROOT);
	const theirs = readRealOrNull(arbiter.paths.repoRoot());
	if (!mine || !theirs) return null;
	/*
	 * ONE COMPARISON, NOT TWO. `want` is the tree this run's claims are filed
	 * under — the canonical checkout of the repo it pins, since a session
	 * claiming from a worktree files under that.
	 */
	const want = readCanonicalCheckoutOf(mine) || mine;
	if (want === theirs) return null;
	const canonical = readCanonicalCheckoutOf(theirs);
	return {
		why:
			canonical && canonical !== theirs
				? `the claim store is keyed on ${theirs}, a linked worktree of ${canonical} — claims are filed under the canonical checkout`
				: `the claim store resolves to ${theirs}, not the tree this run's claims are filed under (${want})`,
		use: want,
	};
}

/**
 * WHICH ASSIGNMENTS ARE REAL (mantahostels#645, on mantahostels#633's ruling).
 *
 * The assignee alone cannot answer it: every one on this repo is the founder's
 * login, whichever session set it, so an issue a finished session claimed
 * stayed excluded for good (mantahostels#633 measured how many).
 *
 * So an assignment excludes only where the session arbiter holds a matching
 * claim AND the recording session is live. NO MATCHING RECORD MEANS THE ISSUE
 * STAYS SELECTABLE — a session that assigns itself but never runs `claim-issue`
 * leaves its work in the shortlist.
 *
 * The claim is a READ here, like everything else in this script: nothing writes
 * one, and `claimIssue` is the working session's own call.
 * @param {ListedSessions} listed
 * @returns {{held: Map<number, any>, kept: boolean, why: string|null, claimsTree?: string|null}}
 */
function claimedIssues(listed) {
	try {
		const elsewhere = storeElsewhere();
		const claims = arbiter.heldIssues(listed);
		// Never overwrite `claims.why`: a corrupt record (mantahostels#1186) can set it
		// alongside `elsewhere`, and losing it here silently under-reports again.
		return elsewhere
			? {
					...claims,
					why: claims.why
						? `${elsewhere.why}; also, ${claims.why}`
						: elsewhere.why,
					claimsTree: elsewhere.use,
				}
			: claims;
	} catch (e) {
		// The store fails open on its own account; this catches a store that will
		// not load at all, which must not take the whole shortlist down.
		//
		// A MAP, AND ALL FOUR FIELDS, matching every other branch. A `Set` answers
		// `.has` false for everything, so nothing reaches the `claims.held.get(...)`
		// below today — but one line ever putting a member in turns a degraded read
		// into a TypeError inside the shortlist print (mantahostels#1394).
		//
		// GUARDED BY THE TYPE CHECKER, NOT BY A TEST: nothing in-process can make
		// this branch run, so putting a `Set` back is checked instead — it fails
		// `npm run typecheck` at the `claims.held.get(...)` below, naming the
		// missing `get`.
		return {
			held: new Map(),
			kept: false,
			why: parseErrLine(e),
			claimsTree: null,
		};
	}
}

/** @typedef {import("./lib/dispatch-ledger").DispatchRecord} DispatchRecord */

/**
 * The issues `scripts/dispatch-sessions.sh` has already launched, read off the
 * ledger it writes at launch (`.pick-next/dispatched.jsonl`) — the same file,
 * on the same window, that `check-duplicate-dispatch.js` drops a member on.
 *
 * WHY THIS RUN MUST READ IT (mantahostels#1528). Offering an already-dispatched issue is
 * not a harmless duplicate: the launcher deletes that member and does not
 * replace it, so the run starts fewer sessions than admission allowed, and the
 * frontier count §5 does its accounting against counts issues nothing can take.
 * On 26 Aug 2026 five of a frontier of 66 were already running and three of ten
 * dispatch lines were dropped at launch.
 *
 * THE LEDGER'S PATH, WINDOW AND ROOT ARE ALL THE SEAM'S, not restated here and
 * not passed in: `lib/dispatch-ledger.js` resolves WFC_DISPATCH_ROOT ahead of
 * WFC_REPO_ROOT, so a root supplied from this side would read a different
 * file from the one the launcher wrote whenever that variable is set.
 *
 * AN ENTRY HOLDS ON ISSUE AND COMMAND, FOR THE WHOLE WINDOW, LIVE SESSION OR
 * NOT (#752), unless the refill loop released it on a hand-off (#2744). It
 * excludes an issue only where its command matches the issue's
 * CURRENT `takes:` value — the command the launcher would be handed for it,
 * which drops on the same key. So `/triage 34` that relabelled #34
 * `takes:wayfinder` no longer holds it, and #34 meets the ordinary substrate,
 * admission and claim tests; a matching entry still holds whether its session
 * finished or not, because the launcher would still drop it. An entry whose
 * prompt has no readable `/<skill>` holds, and so does an issue carrying no
 * `takes:`.
 * `scripts/dispatch-sessions.sh --force` is the way past a stale entry, and the
 * block this feeds prints that.
 *
 * IT FAILS OPEN, like the gate it reads with: an unreadable ledger excludes
 * nothing and says so, rather than emptying the frontier on a bad read.
 * @returns {{byIssue: Map<number, DispatchRecord[]>, why: string|null}}
 */
function dispatchedIssues() {
	/** @type {Map<number, DispatchRecord[]>} */
	const byIssue = new Map();
	let res;
	try {
		res = recentDispatches(undefined, DISPATCH_WINDOW_HOURS);
	} catch (e) {
		return { byIssue, why: parseErrLine(e) };
	}
	if (!res.ok) return { byIssue, why: res.error || "unreadable" };
	for (const rec of res.entries)
		for (const n of rec.issues || [])
			byIssue.set(n, [...(byIssue.get(n) || []), rec]);
	return { byIssue, why: null };
}

/**
 * The ledger entry holding an issue whose `takes:` values are `takes`, or
 * `undefined` where none does. The most recent holder is the one reported,
 * rather than the oldest still inside the window.
 *
 * TWO GAPS. An issue carrying two `takes:` values is held where EITHER matches
 * — a label defect `check-issue-labels.js` reports, read here toward the hold.
 * And the picker compares with the issue's LABEL where the launcher compares
 * with the PROMPT's `/<skill>`: the two agree only because §7 builds each
 * prompt as `/<takes> <n>`, so a set line typed under another command is
 * judged here on the label alone.
 * @param {ReturnType<typeof dispatchedIssues>} dispatched
 * @param {number} n
 * @param {string[]} takes
 * @returns {DispatchRecord|undefined}
 */
function holdingDispatch(dispatched, n, takes) {
	return (dispatched.byIssue.get(n) || []).findLast(
		(rec) => takes.length === 0 || takes.some((t) => entryHolds(rec, t)),
	);
}

/**
 * One ledger entry as an exclusion reason, with the launch's age — a reader
 * judging whether an entry is stale needs the age, not the timestamp. An
 * unreadable or absent field says so rather than printing a plausible blank:
 * this line is what a `--force` gets decided on.
 * `undefined` is accepted because the caller reads it out of a Map: the two are
 * the same absence, and both print rather than throwing.
 * @param {DispatchRecord|undefined} rec
 */
function dispatchAge(rec) {
	const at = rec ? Date.parse(rec.ts) : Number.NaN;
	const age = Number.isNaN(at)
		? "at an unreadable time"
		: `${Math.max(0, (Date.now() - at) / 3_600_000).toFixed(1)}h ago`;
	return `${age} — ${rec?.prompt || "prompt not recorded"}`;
}

/*
 * Whether an ALREADY DISPATCHED launch's own job is still alive (mantahostels#3488). The
 * ledger holds an issue for the whole window REGARDLESS (`dispatchedIssues`'s
 * own header), which is what made a finished launch and a running one print
 * identically — this is the join that tells them apart.
 *
 * `JOB_STATE_TERMINAL` is `lib/agent-liveness.js#TERMINAL_STATES`, imported
 * under this name: the job's own `state.json` and the oracle's own session
 * record are two different files, but both are stamped by the SAME CLI code
 * path off the same three words (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-state-status-skew.md
 * §F1) — one constant, not two that could drift apart unnoticed.
 */

/**
 * @param {ReturnType<typeof readJobs>} jobs
 * @param {string} jobId
 */
function jobRecordOf(jobs, jobId) {
	if (!Array.isArray(jobs)) return null;
	return jobs.find((j) => j.job === jobId) || null;
}

/**
 * `{state: "live"}`, `{state: "finished", detail}` off the job's own
 * `state.json`, or `{state: "unknown", why}` — never a guess at liveness from
 * an absence.
 *
 * READS TWO SOURCES, NEITHER SUFFICIENT ALONE. The job's `state.json` can read
 * `working` for a session that has since died with no update (`lib/hung-jobs.js`'s
 * own HUNG-JOB case) — so `working` alone is not "live", it is "ask the
 * oracle". The oracle in turn is keyed by SESSION id, not the JOB id the
 * ledger records, so the job's own record is what supplies that session id to
 * look up.
 *
 * A reachable job record that already reads a terminal state is trusted
 * outright, with no oracle read at all: `done`/`failed`/`stopped` do not need
 * confirming, and a session the oracle no longer lists (finished long enough
 * ago to fall out of `claude agents --json`) would otherwise read as
 * "unknown" rather than "finished" (mantahostels#3488's own worked example, `e6736764` and
 * `4f9cd281`).
 *
 * @param {DispatchRecord|undefined} rec
 * @param {ListedSessions} listed
 * @param {ReturnType<typeof readJobs>} jobs
 */
function dispatchLiveness(rec, listed, jobs) {
	if (!rec?.jobId)
		return { state: "unknown", why: "no job id recorded on this entry" };
	const job = jobRecordOf(jobs, rec.jobId);
	if (!job)
		return {
			state: "unknown",
			why:
				jobs === null
					? "no job store could be read"
					: `no job record found for ${rec.jobId}`,
		};
	if (job.unreadable || !job.rec)
		return { state: "unknown", why: `job record for ${rec.jobId} unreadable` };
	const jobState = job.rec.state;
	if (JOB_STATE_TERMINAL.has(jobState))
		return {
			state: "finished",
			detail:
				typeof job.rec.detail === "string" && job.rec.detail
					? job.rec.detail
					: jobState,
		};
	const sessionId =
		typeof job.rec.sessionId === "string" ? job.rec.sessionId : null;
	if (!sessionId)
		return { state: "unknown", why: "the job record carries no session id" };
	// Narrowed on `.ids` rather than on `.why` (mantahostels#1460's own reasoning,
	// matching `reclaimableFrom` below): `why` is a plain `string` in the
	// refused shape, so a truthy check on it leaves an empty-string refusal
	// still typed as possibly-refused, and `.terminal`/`.ids` possibly
	// undefined below. `ids` is present only in the listed shape.
	if (!listed.ids)
		return {
			state: "unknown",
			why: `the oracle could not be read: ${listed.why}`,
		};
	if (listed.terminal.has(sessionId))
		return { state: "finished", detail: "oracle reads it terminal" };
	if (listed.ids.has(sessionId)) return { state: "live" };
	return {
		state: "unknown",
		why: "the oracle does not list this session, and its job record reads neither live nor terminal",
	};
}

/**
 * `live`, `finished: <detail>` or `unknown` — the exact text both the table
 * and `--json` print, so the two cannot drift on wording.
 * @param {ReturnType<typeof dispatchLiveness>} liveness
 */
function dispatchLivenessLabel(liveness) {
	return liveness.state === "finished"
		? `finished: ${liveness.detail}`
		: liveness.state;
}

/**
 * How much of the memory the admission arithmetic just called spent belongs to
 * sessions that have FINISHED and not exited (mantahostels#421, which measured the pool).
 *
 * REPORT ONLY — this run reaps nothing (mantahostels#1029). The reaper keeps its single
 * `SessionStart` trigger. The standing reason is the oracle spawn this would
 * pay against the very figure it is measuring (mantahostels#653). The second reason is now
 * MOOT, not weakened: `GRACE_MS` is 0 (mantahostels#1290), so a session that finishes
 * DURING this run is credited at the very next admission read and reaped by
 * the burst's own session starts — there is no pool left for a reap here to
 * decline. mantahostels#1029 stands on the spawn cost alone.
 * @param {ListedSessions} listed
 * @returns {{ok: false, error: string}|{ok: true, count: number, ids: string[]}}
 */
function reclaimableFrom(listed) {
	/* Tested on `finished` rather than on `why`: the two are the same condition
	 * — the reader answers with every set or with `why` alone — and `finished`
	 * is the field actually read below (mantahostels#1460). */
	if (!listed.finished) return { ok: false, error: listed.why };
	/*
	 * Without an id this run cannot tell itself apart from the pool, and a count
	 * that may include this very session promises headroom stopping it could
	 * never return. The reaper refuses on the same unset variable.
	 */
	const me = idSeam.fromEnv();
	if (!me)
		return {
			ok: false,
			error:
				"CLAUDE_CODE_SESSION_ID is unset, so this run cannot be told apart from the finished sessions it would count",
		};
	const finished = [...listed.finished].filter((id) => id !== me);
	return { ok: true, count: finished.length, ids: finished };
}

/*
 * Owed work at the fragment layer, ruled at mantahostels#1171: debt entries and stranded
 * file claims carry no issue number, so neither can be ranked into the
 * frontier above — this is a headline count, not a sort input. Both are
 * local reads; neither costs a network call.
 */
function debtCount() {
	const debts = arbiter.listDebts();
	if (debts === null)
		return { ok: false, error: "the debt store could not be read" };
	return { ok: true, count: debts.length };
}

/**
 * BOTH NUMBERS: most of the pile is inert, and the subset on a file carrying
 * uncommitted work is the part a reader can act on (mantahostels#1780). The cost and the
 * caveats are on lib/stranded-count.js, which owns the rule.
 *
 * The strict `listed` read's `terminal` field (mantahostels#2765, mantahostels#2774) keeps a holder
 * the oracle lists but has marked done, failed or stopped from being exempted
 * as live for ever. NOT its `finished` field, which is narrower and belongs to
 * `reclaimableFrom` above: that one must match what the reaper actually stops.
 *
 * @param {ListedSessions} listed
 */
function strandedClaimCount(listed) {
	return strandedCount.countStranded(
		arbiter.readLocks(),
		listed.ids,
		strandedCount.readDirtyPaths(),
		listed.terminal,
	);
}

// ------------------------------------------------------------------------ main

/**
 * EVERY RUN'S FULL REPORT, ON DISK. The text output runs to ~200 lines, so a
 * reader who tails it loses the ranking and admission blocks at the top — and
 * the only recovery was a second full run, ~30 s of GitHub calls for a report
 * this run had already computed. Written whether or not `--json` was asked for,
 * into `.claude/tmp/markers/.pick-next/`. One file, overwritten: a scratch copy of
 * the last run, never a history.
 *
 * A failure is reported and never thrown — the run's own answer is on stdout.
 * @param {unknown} payload
 */
function writeRunSnapshot(payload) {
	const file = snapshotFile(REPO_ROOT);
	// Atomic, because a concurrent picker may be reading this very file.
	try {
		writeFileAtomic(file, `${JSON.stringify(payload, null, 2)}\n`, {
			mkdir: true,
		});
		return { ok: true, file };
	} catch (e) {
		return { ok: false, file, error: parseErrLine(e) };
	}
}

/**
 * @typedef {object} State
 * @property {string} repo
 * @property {string[]} argv
 * @property {number[]} goal
 * @property {number} limit
 * @property {Issue[]} enriched
 * @property {Issue[]} frontier
 * @property {Issue[]} shown
 * @property {TrackedFiles} tracked
 * @property {Pathed[]} pathed
 * @property {ReturnType<typeof pairwiseCollisions>} collisions
 * @property {ReturnType<typeof crossCollisions>} inFlightCollisions
 * @property {number[]} docMapQueue
 * @property {ReturnType<typeof dumpBodies>|null} dumped
 * @property {{ok?: boolean, removed: number[]}} cachePruned
 * @property {ReturnType<typeof prewarm>} cacheState
 * @property {ReturnType<typeof conflictGraph.buildGraph>} graph
 * @property {number} dispatchableFloor
 * @property {import("./lib/retro-bundles.js").RetroLaunch[]} retroBundles
 * @property {boolean} bandReadRequired
 * @property {ReturnType<typeof warmFractionLog.appendRun>|null} warmLogged
 * @property {Machine["mem"]} mem
 * @property {Machine["procs"]} procs
 * @property {ReturnType<typeof admissionFrom>} admission
 * @property {Machine["memory"]} memory
 * @property {Machine["host"]} host
 * @property {Machine["live"]} live
 * @property {Machine["floorRead"]} floorRead
 * @property {ReturnType<typeof reclaimableFrom>} reclaimable
 * @property {ReturnType<typeof debtCount>} debts
 * @property {ReturnType<typeof strandedClaimCount>} stranded
 * `waitingAll`/`gatedAll`/`gatedOnAll` are `enriched.filter(hasWait|hasGate|hasGateOn)`
 * results — the type-predicate narrowing that gives `render` its
 * `i.wait`/`i.gate`/`i.gateOn` non-null reads is lost once the filtered array
 * crosses this plain-object boundary, so `any[]` here (not `Issue[]`) is what
 * keeps those reads type-checking downstream.
 * @property {any[]} waitingAll
 * @property {any[]} gatedAll
 * @property {any[]} gatedOnAll
 * @property {Issue[]} proseBlockedAll
 * @property {any[]} parkedAll
 * @property {ReturnType<typeof summaryOf>} summary
 * @property {ListedSessions} listed
 * @property {ReturnType<typeof claimedIssues>} claims
 * @property {Awaited<ReturnType<typeof parentClaims>>} parentHeld
 * @property {ReturnType<typeof dispatchedIssues>} dispatched
 * @property {ReturnType<typeof readJobs>} dispatchJobs
 * @property {Issue[]} degraded
 * @property {number[]} noCommand
 * @property {ReturnType<typeof pulledInRows>} pulledIn
 */

/**
 * WHY EACH FRONTIER ISSUE OUTSIDE THE SET DID NOT LAUNCH (#591), the reasons
 * this script can know. Earliest-applicable wins, in `NOT_LAUNCHED_REASONS`'
 * order; the skill adds the rest of the vocabulary (a prose gate, the
 * launcher's drops) and confirms or clears the provisional `shares a file`.
 *
 * A dropped issue in a merge-test pair with a set member rides that member's
 * line, so it is launched, not listed — and takes no slot of its own.
 * @param {State} state
 */
function notLaunchedOf(state) {
	const { frontier, graph, admission, noCommand } = state;
	const noCommandSet = new Set(noCommand);
	/* A retro bundle takes one slot, at its first-ranked member, and the rest
	 * ride it. Its members sit outside the conflict graph (#1105). */
	const bundleOf = new Map(
		state.retroBundles.flatMap((b, k) => b.issues.map((n) => [n, k])),
	);
	/** @type {Map<number, boolean>} bundle index -> whether it got a slot */
	const bundleSlotted = new Map();
	const dropped = new Map(graph.dropped.map((d) => [d.number, d]));
	const proposed = new Set(graph.proposed);
	/* Merged only onto the set member it clashed with: a pair partner elsewhere
	 * in the set does not carry it. */
	const partners = new Set(
		graph.mergeable.flatMap((p) => [`${p.a}:${p.b}`, `${p.b}:${p.a}`]),
	);
	/* The always-admit-one rule gives a slot where `freeSlots` reads 0 or
	 * unknown, so `admit` counts for one. */
	const slots = Math.max(admission.freeSlots ?? 0, admission.admit ? 1 : 0);
	let used = 0;
	const takeSlot = () => ++used <= slots;
	/**
	 * @param {number} number
	 * @returns {{number: number, reason: NotLaunchedReason, detail: object}}
	 */
	const noSlot = (number) => ({
		number,
		reason: "no admission slot",
		detail: { slots, freeSlots: admission.freeSlots },
	});
	/** @param {number} number */
	const slotRow = (number) => (takeSlot() ? null : noSlot(number));
	/**
	 * @param {number} bundle
	 * @param {number} number
	 */
	const bundleRow = (bundle, number) => {
		if (!bundleSlotted.has(bundle)) bundleSlotted.set(bundle, takeSlot());
		return bundleSlotted.get(bundle) ? null : noSlot(number);
	};
	const ctx = { noCommandSet, dropped, proposed, partners, slotRow };
	/** @type {{number: number, reason: NotLaunchedReason, detail: object}[]} */
	const out = [];
	for (const i of frontier) {
		const bundle = bundleOf.get(i.number);
		const row =
			bundle === undefined ? frontierRow(i, ctx) : bundleRow(bundle, i.number);
		if (row) out.push(row);
	}
	return out;
}

/**
 * `notLaunchedOf`'s verdict on one frontier issue outside a retro bundle:
 * its row, or null where it launches -- in the set on a slot of its own, or
 * riding a set member's merge-test line.
 * @param {Issue} i
 * @param {{noCommandSet: Set<number>, dropped: Map<number, State["graph"]["dropped"][number]>, proposed: Set<number>, partners: Set<string>, slotRow: (n: number) => {number: number, reason: NotLaunchedReason, detail: object} | null}} ctx
 * @returns {{number: number, reason: NotLaunchedReason, detail: object} | null}
 */
function frontierRow(i, ctx) {
	if (ctx.noCommandSet.has(i.number))
		return {
			number: i.number,
			reason: "no command",
			detail: { takes: i.takes },
		};
	const d = ctx.dropped.get(i.number);
	if (!d) return ctx.slotRow(i.number);
	if (d.kind === "held")
		return {
			number: i.number,
			reason: "file held by a running session",
			detail: { files: d.paths, session: d.heldBy, sessionId: d.sessionId },
		};
	if (
		d.kind === "clash" &&
		ctx.proposed.has(d.with) &&
		ctx.partners.has(`${i.number}:${d.with}`)
	)
		return null;
	return {
		number: i.number,
		reason: "shares a file",
		detail: { with: d.with, file: d.paths[0], provisional: true },
	};
}

/**
 * The reasons in precedence order, each with its printed detail; `render`
 * groups by that order.
 * @satisfies {Record<string, (d: any) => string>} `any`: each reason's detail
 * has its own shape, built one function up.
 */
const NOT_LAUNCHED_REASONS = {
	"no command": (d) => takesCell(d.takes),
	"file held by a running session": (d) =>
		`${d.session} holds ${d.files.join(", ")}`,
	"shares a file": (d) =>
		`with #${d.with} on ${d.file} (provisional — the band read confirms or clears it)`,
	"no admission slot": (d) =>
		`${d.freeSlots === null ? "free slots unknown" : `${d.slots} slot(s)`}, as of this run`,
};
const REASON_ORDER = Object.keys(NOT_LAUNCHED_REASONS);
/** @typedef {keyof typeof NOT_LAUNCHED_REASONS} NotLaunchedReason */

/*
 * The EXCLUDED table's own categories, read off the reason string the
 * exclusion cascade in `main` wrote, so the tally cannot drift from the table.
 */
/** @type {[string, string][]} */
const EXCLUSION_CATEGORIES = [
	["readiness unknown", "degraded"],
	["blocked by", "blocked"],
	["claimed by", "claimed"],
	["claimed through parent", "claimed"],
	["dispatched ", "already dispatched"],
	["container", "container"],
	["gated ", "gated"],
];
/** The spec's own figure (#575): names past it make the line too long to read. */
const TALLY_NAMES_AT_MOST = 3;

/**
 * Why the open issues outside the frontier were never takeable (#591).
 * @param {State} state
 */
function openTallyOf(state) {
	/** @type {Record<string, number[]>} */
	const by = {};
	for (const [, name] of EXCLUSION_CATEGORIES) by[name] = [];
	for (const i of state.enriched) {
		if (!i.excluded) continue;
		const hit = EXCLUSION_CATEGORIES.find(([prefix]) =>
			String(i.excluded).startsWith(prefix),
		);
		/* Fail-open: a new cascade limb with no row above is counted, not lost,
		 * and never crashes the run. */
		const name = hit ? hit[1] : "other";
		by[name] = [...(by[name] ?? []), i.number];
	}
	return {
		open: state.enriched.length,
		frontier: state.frontier.length,
		categories: Object.entries(by).map(([category, numbers]) => ({
			category,
			count: numbers.length,
			numbers: [...numbers].sort((a, b) => a - b),
		})),
	};
}

/** @param {ReturnType<typeof openTallyOf>} t */
const buildOpenTallyLine = (t) =>
	[
		`${t.open} open`,
		`${t.frontier} frontier`,
		...t.categories
			.filter((c) => c.count)
			.map(
				(c) =>
					`${c.count} ${c.category}${
						c.count <= TALLY_NAMES_AT_MOST
							? ` (${c.numbers.map((n) => `#${n}`).join(", ")})`
							: ""
					}`,
			),
	].join(", ");

/**
 * @param {State} state
 */
function admissionJson(state) {
	const { mem, procs, reclaimable, admission, host } = state;
	return {
		availableMb: mem.ok ? mem.mb : null,
		availableUnknown: mem.ok ? null : mem.error,
		sessions: procs.ok ? procs.sessions : null,
		claudeProcesses: procs.processes,
		claudeProcessesUnknown: procs.processesError,
		sessionsUnknown: procs.ok ? null : procs.error,
		sessionMeanMb: host.meanMb,
		sessionSigmaMb: host.sigmaMb,
		reclaimable: reclaimable.ok ? reclaimable.count : null,
		reclaimableError: reclaimable.ok ? null : reclaimable.error,
		reservedMb: admission.reservedMb,
		reservedError: admission.reservedError,
		budgetMb: admission.budgetMb,
		drawNeedMb: admission.drawNeedMb,
		freeSlots: admission.freeSlots,
		admit: admission.admit,
		reason: admission.reason,
	};
}

/**
 * @param {State} state
 */
function owedWorkJson(state) {
	const { debts, stranded } = state;
	return {
		debtEntries: debts.ok ? debts.count : null,
		debtEntriesUnknown: debts.ok ? null : debts.error,
		strandedClaims: stranded.ok ? stranded.stranded : null,
		strandedClaimsUnknown: stranded.ok ? null : stranded.error,
		strandedClaimsCarrying: stranded.ok ? stranded.carrying : null,
		// A null `carrying` two ways, and a consumer must not read either as
		// zero: the count was never read — `strandedClaimsUnknown` says so —
		// or it was read and git would not name the dirty files (mantahostels#1780).
		strandedClaimsCarryingUnknown:
			stranded.ok && stranded.carrying === null
				? "git would not report which files carry uncommitted work"
				: null,
	};
}

/**
 * Carried whether or not the gate is still holding: a lapsed one is
 * what a consumer has to act on.
 * @param {State["gatedAll"]} gatedAll
 */
function gatedJson(gatedAll) {
	return gatedAll.filter(hasGate).map((i) => ({
		number: i.number,
		title: i.title,
		until: i.gate.iso || null,
		daysLeft: i.gate.daysLeft ?? null,
		reason: i.gate.reason,
		active: i.gateHolds,
		malformed: i.gate.malformed ? i.gate.raw : null,
		/* Without this a two-marker issue is indistinguishable here from a
		 * lapsed date: `active` is false while `daysLeft` is still positive.
		 * It is also what moved `active`'s meaning — it now answers "is this
		 * gate holding", not "has the date passed". */
		bothMarkers: i.gateConflict,
	}));
}

/**
 * A sibling array, never a widened `gated[]` (mantahostels#1419): that one has a live
 * consumer asserting `{until, daysLeft, active, malformed}` across all its
 * rows.
 * @param {State["gatedOnAll"]} gatedOnAll
 */
function gatedOnJson(gatedOnAll) {
	return gatedOnAll.map((i) => ({
		number: i.number,
		title: i.title,
		condition: i.gateOn.condition || null,
		command: i.gateOn.command || null,
		abandonIf: i.gateOn.abandonIf || null,
		holding: i.gateOnHolds,
		malformed: i.gateOn.malformed ? i.gateOn.raw : null,
		// A separate key from `gated[]`'s `reason`: that one already carries
		// through malformed rows, but it's the free-text after the date's own
		// dash, not a cause — a date gate has exactly one way to be malformed,
		// so nothing there needs naming which one fired (mantahostels#1652).
		malformedReason: i.gateOn.malformed ? i.gateOn.reason : null,
		bothMarkers: i.gateConflict,
	}));
}

/**
 * @param {State["parkedAll"][number]} i
 */
function parkedJson(i) {
	return {
		number: i.number,
		title: i.title,
		days: i.parked.unknown ? null : Math.floor(i.parked.ageDays),
		appliedAt: i.parked.appliedAt || null,
		ageUnknown: i.parked.unknown ? i.parked.error : null,
	};
}

/**
 * @param {State["waitingAll"][number]} i
 */
function waitingJson(i) {
	return {
		number: i.number,
		title: i.title,
		days: waitDays(i),
		stalled: i.wait.stalled === true,
		appliedBy: i.wait.appliedBy || null,
		appliedAt: i.wait.appliedAt || null,
		ageUnknown: i.wait.unknown ? i.wait.error : null,
		excluded: i.excluded || null,
	};
}

/**
 * @param {Pathed} i
 */
function frontierJson(i) {
	const urgentApplied = i.urgency?.unknown ? null : i.urgency;
	return {
		number: i.number,
		title: i.title,
		url: i.url,
		bug: i.bug,
		urgent: i.urgent,
		urgentVia: i.urgentVia,
		bugVia: i.bugVia,
		goalVia: i.goalVia,
		urgentAppliedBy: urgentApplied?.appliedBy ?? null,
		urgentAppliedAt: urgentApplied?.appliedAt ?? null,
		goal: i.goal,
		waitingDays: waitDays(i),
		waitStalled: i.wait?.stalled === true,
		asksQuestions: i.asksQuestions,
		stallDays: i.stallDays,
		depth: i.depth,
		reach: i.reach,
		collision: i.collision ? "writes repo files" : "comment-only",
		// Always a list: an issue may carry none or, wrongly, several.
		takes: i.takes,
		pathsNamed: i.paths,
		group: i.group,
		labels: i.labels,
	};
}

/**
 * The launcher's ledger, as this run read it (mantahostels#1528). `degraded` non-null
 * means NOTHING was excluded on it, so a consumer must not read an empty
 * `issues` as "nothing is running".
 * @param {State} state
 */
function alreadyDispatchedJson(state) {
	const { enriched, dispatched, listed, dispatchJobs } = state;
	return {
		windowHours: DISPATCH_WINDOW_HOURS,
		degraded: dispatched.why,
		issues: enriched
			.filter((i) => i.dispatchHeld)
			.map((i) => {
				const rec = i.dispatchRec;
				const liveness = dispatchLiveness(rec, listed, dispatchJobs);
				return {
					number: i.number,
					title: i.title,
					dispatchedAt: rec?.ts ?? null,
					prompt: rec?.prompt ?? null,
					// live | finished: <detail> | unknown (mantahostels#3488) — the same string
					// the text report prints, off `dispatchLiveness`'s own read of
					// the ledger's `jobId` against the oracle and the job's own
					// `state.json`.
					liveness: dispatchLivenessLabel(liveness),
					// Only set on "unknown" — the text report has no room for it, so
					// this is the one place it's diagnosable (mantahostels#3488 Standards F3).
					livenessWhy: liveness.why ?? null,
				};
			}),
	};
}

/**
 * The `--json` envelope. Pure over `state` -- the data `main()` gathers
 * below -- so a ranking or admission assertion can call this directly with
 * no fake repo and no `gh` stub (mantahostels#1794).
 * @param {State} state
 */
function buildPayload(state) {
	const {
		repo,
		argv,
		goal,
		summary,
		enriched,
		frontier,
		memory,
		degraded,
		gatedAll,
		gatedOnAll,
		proseBlockedAll,
		waitingAll,
		parkedAll,
		pathed,
		claims,
		parentHeld,
		collisions,
		inFlightCollisions,
		docMapQueue,
		graph,
		dispatchableFloor,
		retroBundles: launches,
		bandReadRequired,
		cacheState,
		cachePruned,
		warmLogged,
		dumped,
		tracked,
	} = state;
	return {
		generatedAt: new Date().toISOString(),
		summary,
		/*
		 * PROVENANCE, because one file holds whatever ran last. A `--repo` run
		 * reports another tracker and a `--no-log` one dispatched nothing; both
		 * overwrite this file, and a reader told to trust it has no other way to tell.
		 */
		repo,
		argv,
		openIssues: enriched.length,
		/*
		 * `frontier` below now carries the whole frontier too (mantahostels#1289) — this stays
		 * the accounting field mantahostels#844's guard checks against, so a future truncation
		 * of `frontier` still has a figure to be caught by.
		 */
		frontierCount: frontier.length,
		emptyBody: emptyBodiedOf(frontier),
		admission: admissionJson(state),
		/* `admission.js --json`'s own key and shape (#590). */
		memory,
		owedWork: owedWorkJson(state),
		goal,
		reachIsLowerBound: degraded.length > 0,
		degraded: degraded.map((i) => ({
			number: i.number,
			title: i.title,
			error: i.depsUnknown,
		})),
		gated: gatedJson(gatedAll),
		gatedOn: gatedOnJson(gatedOnAll),
		// This repo's resolved against the open list this run already fetched
		// (mantahostels#1289). `open` and `unreadable` still exclude; `closed`
		// spares a reader confirming it by hand.
		proseBlocked: proseBlockedAll.map((i) => ({
			number: i.number,
			title: i.title,
			named: i.proseBlocked.named,
			open: i.proseBlocked.open,
			closed: i.proseBlocked.closed,
			unreadable: i.proseBlocked.unreadable,
			// Names no issue number, so it excludes nothing — §5's
			// disqualifier 2 is read off this (mantahostels#927).
			unparsed: i.proseBlocked.unparsed,
		})),
		waiting: waitingAll.map(waitingJson),
		parked: parkedAll.map(parkedJson),
		frontier: pathed.map(frontierJson),
		// Launch candidates in other repos, for lib/refill-frontier.js (#2427).
		pulledIn: state.pulledIn.rows,
		pulledInUnread: state.pulledIn.unread,
		// The fail-open case (mantahostels#645): assigned in GitHub, but no live session
		// recorded a claim, so this run treats it as takeable. An issue
		// excluded for any other reason is left out.
		assignedUnclaimed: enriched
			.filter((i) => i.assignedUnclaimed)
			.map((i) => ({
				number: i.number,
				title: i.title,
				assignees: i.assignees,
			})),
		claimsDegraded: claims.why
			? {
					why: claims.why,
					claimsKept: claims.kept,
					storeElsewhere: Boolean(claims.claimsTree),
					claimsTree: claims.claimsTree ?? null,
				}
			: null,
		// Parents whose claim store would not read (#2310).
		parentClaimsUnread: parentHeld.unread,
		possibleCollisions: collisions,
		inFlightCollisions,
		docMapQueue,
		conflictGraph: graph,
		// One `/triage <n>…` session each (#1105); §6 writes each as one line.
		retroBundles: launches,
		dispatchableFloor,
		bandReadRequired,
		writeSetCache: {
			dir: writeSetCache.CACHE_SUBDIR,
			warm: cacheState.warm.map(cacheEntryJson),
			// A SEPARATE LIST, not a flag inside `warm` (mantahostels#1001): a reader taking
			// `warm` as its band-read set gets the right answer whether or not it
			// knows predictions exist.
			provisional: cacheState.provisional.map(cacheEntryJson),
			cold: cacheState.cold,
			// Misses no prediction could cover, with the reason for each.
			prewarmSkipped: cacheState.skipped,
			prewarmed: cacheState.enabled,
			pruned: cachePruned.removed,
		},
		warmFractionLogged: warmLogged
			? { ok: warmLogged.ok, error: warmLogged.error ?? null }
			: null,
		bodiesDumped: dumped
			? {
					dir: dumped.dir,
					count: dumped.count,
					error: dumped.ok ? null : dumped.error,
				}
			: null,
		pathsUnavailable: tracked.ok ? null : tracked.error,
		alreadyDispatched: alreadyDispatchedJson(state),
		excluded: enriched
			.filter((i) => i.excluded)
			.map((i) => ({
				number: i.number,
				title: i.title,
				reason: i.excluded,
			})),
		notLaunched: notLaunchedOf(state),
		openTally: openTallyOf(state),
	};
}

/**
 * What a degraded claims read means for the report below it, as the advice
 * printed under the CLAIMS DEGRADED line.
 * @param {ReturnType<typeof claimedIssues>} claims
 * @returns {string}
 */
function buildClaimsDegradedAdvice(claims) {
	if (claims.claimsTree)
		return `Claims filed against ${claims.claimsTree} are invisible to this run, so an\n  issue a live session is on may be shown as takeable. Re-run from there, or\n  set CLAUDE_PROJECT_DIR to it.`;
	if (claims.kept)
		return "Every recorded claim was kept rather than narrowing the live set on a\n  partial read, so an issue excluded as claimed may be free.";
	if (claims.held.size > 0)
		return "A claim record could not be read, so what is shown as claimed below may\n  be incomplete — an issue not listed as claimed above may still be one.";
	return "No claim was read, so every assigned issue above is shown as takeable\n  whether or not a session is on it.";
}

/**
 * @param {unknown} s
 * @param {number} n
 */
const pad = (s, n) => String(s).padEnd(n);

/** @param {State} state */
function renderCounts(state) {
	const { enriched, frontier, limit, degraded, goal } = state;
	console.log(
		`\nOPEN ISSUES: ${enriched.length}   TAKEABLE NOW: ${frontier.length}${
			limit && frontier.length > limit ? `   (showing ${limit})` : ""
		}${degraded.length > 0 ? `   (${degraded.length} unread, see DEGRADED)` : ""}`,
	);
	if (goal.length > 0)
		console.log(
			`GOAL SET (${goal.length}): ${goal.map((n) => `#${n}`).join(", ")}`,
		);
}

/** @param {State["admission"]} admission */
function printCpuLimb(admission) {
	/* The HOLD below already counts it (#834); this line names the limb. */
	const load = admission.load;
	if (load.overloaded)
		console.log(
			`  cpu load           ${buildOverloadText(load)} — dispatch refuses each launch until it falls`,
		);
	/* Unknown is never calm (mantahostels#1206): the check fails open on it. */ else if (
		load.load1 === null
	)
		console.log(
			"  cpu load           unknown — /proc/loadavg unreadable, so no launch is held on load",
		);
	if (admission.cpu.full)
		console.log(
			`  cpu sessions       ${buildSessionCeilingText(admission.cpu)} — dispatch refuses each launch until one ends`,
		);
}

/** @param {State["reclaimable"]} reclaimable */
function printReclaimable(reclaimable) {
	/*
	 * Silent at zero, never at a failed probe (mantahostels#1237, on mantahostels#1206's unknown-never-
	 * zero rule): a row reading 0 changes nothing a reader does, but a probe that
	 * could not run would read as 0 to anyone who cannot see the JSON.
	 *
	 * The plain run is named, never `--dry-run`, which lists the sessions and no
	 * size: the real run's MB-returned total is where the reader gets the pool's
	 * size, and is why no footprint figure is quoted here.
	 */
	if (!reclaimable.ok)
		console.log(
			`  reclaimable        unknown (${reclaimable.error}) — some of the memory counted spent above may already be free`,
		);
	else if (reclaimable.count > 0)
		console.log(
			`  reclaimable        ${reclaimable.count} finished session${
				reclaimable.count === 1 ? "" : "s"
			} still resident, holding memory counted as spent above` +
				"\n                     `node scripts/reap-finished-sessions.js` stops those past its grace window now and reports the MB returned; the next session start does it anyway",
		);
}

/** @param {State} state */
function renderAdmission(state) {
	const {
		mem,
		procs,
		reclaimable,
		admission,
		memory,
		host,
		live,
		floorRead,
		dispatchableFloor,
	} = state;
	// An unread verdict applied no floor, so names none but a floor that went unread.
	const floorLine =
		(mem.ok && procs.ok) || floorRead.problem
			? buildSessionFloorLine(floorRead, admission)
			: null;
	console.log("\nADMISSION — measured headroom, not a fixed slot count\n");
	console.log(
		`  available memory   ${mem.ok ? `${mem.mb} MB` : `unknown (${mem.error})`}`,
	);
	console.log(
		`  live sessions      ${
			procs.ok
				? `${procs.sessions} alongside this one`
				: `unknown (${procs.error})`
		}${
			procs.processes === null
				? ` (process count unavailable: ${procs.processesError})`
				: ` (${procs.processes} claude processes, which include orphans)`
		}`,
	);
	printCpuLimb(admission);
	printReclaimable(reclaimable);
	console.log(`  session draw       ${buildSessionDrawLine(host)}`);
	if (floorLine) console.log(`  session floor      ${floorLine}`);
	console.log(`  live draw          ${buildLiveDrawLine(live)}`);
	console.log(
		`  free slots         ${admission.freeSlots === null ? "unknown" : admission.freeSlots}`,
	);
	console.log(`  DISPATCHABLE FLOOR: ${dispatchableFloor}`);
	console.log(
		`\n  ${admission.admit ? "START ONE NOW" : "HOLD"} — ${admission.reason}.`,
	);
	console.log(
		`\n${buildMemoryBreakdownLines(memory)
			.map((l) => `  ${l}`)
			.join("\n")}`,
	);
	console.log();
}

/** @param {State} state */
function renderOwedWork(state) {
	const { debts, stranded } = state;
	/*
	 * mantahostels#1171's fragment layer, one down from the issue layer this frontier
	 * ranks. A count that could not be read prints as unknown, never as
	 * zero (mantahostels#1206).
	 */
	console.log("OWED WORK — report only, never a filter or a sort input\n");
	console.log(
		`  debt entries       ${debts.ok ? debts.count : `unknown (${debts.error})`}` +
			"  — node scripts/session-arbiter.js debt list",
	);
	console.log(
		`  stranded claims    ${
			stranded.ok
				? `${stranded.stranded}, ${stranded.carrying ?? "unknown how many"} carrying uncommitted work`
				: `unknown (${stranded.error})`
		}  — node ${scriptPath("check-stranded-file-claims.js")}`,
	);
	console.log();
}

/**
 * The URG cell: `bug`, `yes` for the issue's own label, `via` for one it
 * inherits.
 * @param {Issue} i
 */
function urgentCell(i) {
	if (i.bug) return "bug";
	if (i.labels.includes(URGENT_LABEL)) return "yes";
	return i.urgentVia ? "via" : "";
}

/**
 * The GOAL cell: `yes` for a goal-set member, `via` for one holding a member out.
 * @param {Issue} i
 */
function goalCell(i) {
	if (goalSet.has(i.number)) return "yes";
	return i.goal ? "via" : "";
}

/** @param {State} state */
function renderShortlist(state) {
	const { shown } = state;
	const header = `${pad("#", 6)}${pad("URG", 5)}${pad("GOAL", 6)}${pad("WAIT", 6)}${pad("DEPTH", 7)}${pad("REACH", 7)}${pad("COLL", 6)}${pad("GROUP", 16)}${pad("TAKES", 12)}`;
	console.log(`${header}TITLE`);
	// The title column is cut at 42 characters below.
	console.log("-".repeat(header.length + 42));
	for (const i of shown)
		console.log(
			`${pad(`#${i.number}`, 6)}${pad(urgentCell(i), 5)}${pad(
				goalCell(i),
				6,
			)}${pad(waitCell(i), 6)}${pad(i.depth, 7)}${pad(i.reach, 7)}${pad(
				i.collision ? "w" : "-",
				6,
			)}${pad(i.group, 16)}${pad(takesCell(i.takes), 12)}${String(i.title).slice(0, 42)}`,
		);
}

/** @param {State} state */
function printCollisionPairs(state) {
	const { collisions, inFlightCollisions, docMapQueue, claims, listed } = state;
	/**
	 * A pair sharing only stamp paths (conflictGraph.STAMP_PATHS — a
	 * ruling that grows over time, mantahostels#1301) is one the skill tells the
	 * reader to discount — stamp-sharing, not a conflict
	 * (.claude/skills/pick-next/SKILL.md; mantahostels#593, mantahostels#1312). Text only;
	 * --json keeps every pair. The DOC-MAP QUEUE pointer names the
	 * stamps actually shared, never the whole allowlist (mantahostels#1312) — it is
	 * gated on a suppressed pair sharing docs/doc-map.md specifically,
	 * since that block explains nothing about a CLAUDE.md-only pair.
	 * @param {{paths: string[]}} c
	 */
	const isStampPair = (c) =>
		c.paths.every((p) => conflictGraph.STAMP_PATHS.includes(p));
	const printed = collisions.filter((c) => !isStampPair(c));
	const stampCollisions = collisions.filter(isStampPair);
	const suppressed = stampCollisions.length;
	const stampsShared = conflictGraph.STAMP_PATHS.filter((p) =>
		stampCollisions.some((c) => c.paths.includes(p)),
	);
	console.log(
		"\nPOSSIBLE FILE COLLISIONS — repo paths named in both issue bodies.\nAdvisory: the order above is unchanged, and a body may name a file it\nonly refers to. Bodies naming no file can still collide.\n`in flight` is a claimed issue: a session may be writing that file now.\n",
	);
	for (const c of printed)
		console.log(
			`  possible collision: #${c.a} <-> #${c.b} on ${c.paths.join(", ")}`,
		);
	if (suppressed) {
		const pointToQueue =
			docMapQueue.length > 0 && stampsShared.includes("docs/doc-map.md");
		console.log(
			`  ${suppressed} pair${suppressed === 1 ? "" : "s"} sharing only a stamp path (${stampsShared.join(", ")}) suppressed${
				pointToQueue ? " — see the DOC-MAP QUEUE below" : ""
			}; --json carries every pair.`,
		);
	}
	for (const c of inFlightCollisions.slice(0, INFLIGHT_PRINT_CAP))
		console.log(
			`  in flight: #${c.candidate} <-> #${c.inFlight} (claimed by ${claimHolder(c.claimedBy, c.claimedSession, claims.kept, listed.names)}) on ${c.paths.join(", ")}`,
		);
	if (inFlightCollisions.length > INFLIGHT_PRINT_CAP)
		console.log(
			`  ... and ${inFlightCollisions.length - INFLIGHT_PRINT_CAP} more in-flight pairs — --json carries every one.`,
		);
}

/** @param {State} state */
function renderCollisions(state) {
	const { tracked, collisions, inFlightCollisions } = state;
	if (!tracked.ok)
		console.log(
			`\nPOSSIBLE FILE COLLISIONS — unavailable: could not list tracked files\n  ${tracked.error}`,
		);
	else if (collisions.length > 0 || inFlightCollisions.length > 0)
		printCollisionPairs(state);
}

/** @param {State} state */
function renderDocMapQueue(state) {
	const { docMapQueue } = state;
	if (docMapQueue.length > 0)
		console.log(
			`\nDOC-MAP QUEUE (${docMapQueue.length}) — bodies naming a §B entry, so they` +
				" likely write\n`docs/doc-map.md` at the END of their run. That is a STAMP," +
				" not a substrate:\nsharing it disqualifies nobody (mantahostels#422), and a denial there" +
				" is the designed path —\nregister the debt, finish the ticket. Read down to" +
				" the admission figure, never\njust the top:\n" +
				`  ${docMapQueue.map((n) => `#${n}`).join(", ")}\n` +
				"Advisory: nothing is refused on a prediction.",
		);
}

/** @param {State} state */
function renderRetroBundles(state) {
	const { retroBundles: launches } = state;
	if (launches.length > 0) {
		console.log(
			`\nRETRO TRIAGE BUNDLES (${launches.length}) — retro-sweep findings, at most ${RETRO_BUNDLE_CAP} to a\n` +
				"session (#1105). Each is one §6 line and one §7 prompt; no file disqualifies a member:",
		);
		for (const b of launches)
			console.log(
				`  **${b.issues.join(", ")}** - ${RETRO_LABEL} · ${b.model}    → "${b.prompt}"`,
			);
	}
}

/** @param {State["graph"]} graph */
function printGraphInFlight(graph) {
	if (graph.inFlight.length > 0) {
		console.log("\n  ruled out by a running session:");
		for (const r of graph.inFlight.slice(0, GRAPH_PRINT_CAP))
			console.log(
				`    #${r.candidate} — ${sessionName(r.session)} holds ${r.paths.join(", ")}`,
			);
		if (graph.inFlight.length > GRAPH_PRINT_CAP)
			console.log(
				`    ... and ${graph.inFlight.length - GRAPH_PRINT_CAP} more — --json carries every one.`,
			);
	}
}

/** @param {State["graph"]} graph */
function printGraphConflicts(graph) {
	if (graph.conflicts.length > 0) {
		console.log(
			`\n  ${graph.conflicts.length} candidate pair${graph.conflicts.length === 1 ? " names" : "s name"} one file, by file:`,
		);
		for (const f of graph.conflictsByFile.slice(0, GRAPH_FILE_CAP))
			console.log(`    ${f.path} — ${f.pairs} pair${f.pairs === 1 ? "" : "s"}`);
		if (graph.conflictsByFile.length > GRAPH_FILE_CAP)
			console.log(
				`    ... and ${graph.conflictsByFile.length - GRAPH_FILE_CAP} more files — --json carries every one.`,
			);
		console.log("  the pairs themselves:");
		for (const c of graph.conflicts.slice(0, GRAPH_PRINT_CAP))
			console.log(`    #${c.a} <-> #${c.b} on ${c.paths.join(", ")}`);
		if (graph.conflicts.length > GRAPH_PRINT_CAP)
			console.log(
				`    ... and ${graph.conflicts.length - GRAPH_PRINT_CAP} more pairs — --json carries every one.`,
			);
	}
}

/** @param {State["graph"]} graph */
function printGraphStamps(graph) {
	// Summary, never a list: these pairs run together, so naming each one would
	// bury the pairs that do not (.claude/skills/pick-next/SKILL.md).
	if (graph.stampSharing.pairs)
		console.log(
			`\n  ${graph.stampSharing.pairs} pair${graph.stampSharing.pairs === 1 ? " shares" : "s share"} only ${graph.stampSharing.paths.join(", ")} — a STAMP, so they run\n` +
				"  together and none is a conflict.",
		);
	if (graph.stampQueued.length > 0)
		console.log(
			`  ${graph.stampQueued.length} candidate${graph.stampQueued.length === 1 ? " queues" : "s queue"} behind a held stamp — designed, not a conflict.`,
		);
}

/** @param {State["graph"]} graph */
function printGraphMergeable(graph) {
	if (graph.mergeable.length > 0) {
		console.log(
			"\n  merge-test pairs — same file and both sized small, which is TWO of the\n" +
				"  three limbs (mantahostels#503). The third, disjoint edit targets (§B15 vs §B17), is\n" +
				"  yours from the band read:",
		);
		for (const m of graph.mergeable.slice(0, GRAPH_PRINT_CAP))
			console.log(`    #${m.a} + #${m.b} on ${m.paths.join(", ")}`);
		if (graph.mergeable.length > GRAPH_PRINT_CAP)
			console.log(
				`    ... and ${graph.mergeable.length - GRAPH_PRINT_CAP} more — --json carries every one.`,
			);
	}
}

/** @param {State["graph"]} graph */
function printGraphNominations(graph) {
	/*
	 * Printed even at zero: silence would read as "no such block in this build",
	 * and §4 acts on the count either way.
	 */
	if (graph.candidates.length > 0) {
		console.log(
			`\n  BAND-READ NOMINATIONS (${graph.nominated.length}) — §4 derives a SIZE for these and no\n` +
				"  others (mantahostels#1484); it still reads the whole tie band to order it. Each has no\n" +
				"  size and shares a non-stamp path with another candidate, so it is the only\n" +
				"  kind whose size can still change the merge test above. Refuse and reorder\n" +
				"  nothing on it (mantahostels#588).",
		);
		for (const n of graph.nominated.slice(0, GRAPH_PRINT_CAP))
			console.log(
				`    #${n.number} on ${n.paths.join(", ")} — with ${n.with.map((/** @type {number} */ w) => `#${w}`).join(", ")}`,
			);
		if (graph.nominated.length > GRAPH_PRINT_CAP)
			console.log(
				`    ... and ${graph.nominated.length - GRAPH_PRINT_CAP} more — --json carries every one.`,
			);
	}
}

/** @param {State["graph"]} graph */
function printWriteSetSources(graph) {
	const bodySourced = graph.candidates.filter(
		(/** @type {any} */ c) => c.source === "body",
	).length;
	const grepSourced = graph.candidates.filter(
		(/** @type {any} */ c) => c.source === "grep",
	).length;
	const unrevalidated = graph.candidates.filter(
		(/** @type {any} */ c) => c.unrevalidated,
	).length;
	if (bodySourced || grepSourced || unrevalidated)
		console.log(
			`\n  ${bodySourced + grepSourced} of ${graph.candidates.length} write-sets above are the body's backticked\n` +
				"  paths rather than a band read's — the floor, not a judgement" +
				(grepSourced
					? `\n  (${grepSourced} PROVISIONAL, so absent from the merge test above).`
					: ".") +
				(unrevalidated
					? ` ${unrevalidated} warm\n  entr${unrevalidated === 1 ? "y is" : "ies are"} unrevalidated (git could not list the tree).`
					: ""),
		);
}

/** @param {State["graph"]} graph */
function printProposedSet(graph) {
	console.log(
		`\n  PROPOSED DISJOINT SET (${graph.proposed.length}) — greedy down the ranking above:\n` +
			`    ${graph.proposed.length > 0 ? graph.proposed.map((/** @type {number} */ n) => `#${n}`).join(", ") : "empty"}`,
	);
	// Re-spelled from the row: the stored reason carries the untruncated name.
	const inFlightOf = new Map(
		graph.inFlight.map((/** @type {any} */ r) => [r.candidate, r]),
	);
	for (const d of graph.dropped.slice(0, GRAPH_PRINT_CAP)) {
		const r = inFlightOf.get(d.number);
		console.log(
			`    not in it: #${d.number} — ${
				r ? `${sessionName(r.session)} holds ${r.paths.join(", ")}` : d.why
			}`,
		);
	}
	if (graph.dropped.length > GRAPH_PRINT_CAP)
		console.log(
			`    ... and ${graph.dropped.length - GRAPH_PRINT_CAP} more left out — --json carries every one.`,
		);
}

/** @param {State} state */
function renderConflictGraph(state) {
	const { graph, bandReadRequired } = state;
	console.log(
		"\nSUBSTRATE-CONFLICT GRAPH — which candidates cannot run alongside which,\n" +
			"and on which file. Advisory: naming one file is NOT a substrate call —\n" +
			"whether the work lives there or merely stamps it at the end is yours\n" +
			"(pick-next SKILL.md §5). Nothing here is refused; the set below is a\n" +
			"candidate for that test, never its verdict.",
	);
	printGraphInFlight(graph);
	printGraphConflicts(graph);
	printGraphStamps(graph);
	printGraphMergeable(graph);
	printGraphNominations(graph);
	console.log(
		bandReadRequired
			? "\n  BAND READ REQUIRED THIS RUN — nominated (above) and/or cold (see WRITE-SET\n" +
					"  CACHE below) entries are non-empty."
			: "\n  NO BAND READ REQUIRED THIS RUN (mantahostels#1485) — nothing nominated, nothing cold.\n" +
					"  §4's band-read stage is skipped outright: accept the provisional\n" +
					"  write-sets as given and go straight to §5 — any merge-test pairs above\n" +
					"  still merge on their already-known sizes; skipping only means no further\n" +
					"  candidate can acquire one.",
	);
	printWriteSetSources(graph);
	if (graph.noWriteSet.length > 0)
		console.log(
			`\n  no write-set predicted, so absent from every line above (${graph.noWriteSet.length}):\n` +
				`    ${chunk(
					graph.noWriteSet.map((/** @type {number} */ n) => `#${n}`),
					DERIVE_PER_LINE,
				).join("\n    ")}`,
		);
	printProposedSet(graph);
	if (graph.heldDegraded)
		console.log(
			`\n  CLAIMS DEGRADED — ${graph.heldDegraded.why}.\n  ${
				graph.heldDegraded.kept
					? "Every claim was kept rather than dropped on a partial read, so a file\n  named above may be free."
					: "No file claim was read, so a candidate a live session is writing may sit\n  in the proposed set."
			}`,
		);
}

/** @param {CacheEntry} w */
const warmRow = (w) =>
	`  warm  #${w.number}  ${w.writeSet.length} path(s)${w.sizeBand ? `, ${w.sizeBand}` : ""}${w.unrevalidated ? " (unrevalidated — git could not list the tree)" : ""}${w.gist ? ` — ${String(w.gist).slice(0, 60)}` : ""}`;

/** @param {CacheEntry} w */
const provisionalRow = (w) =>
	`  prov  #${w.number}  ${w.writeSet.length} path(s), no size (predicted: ${w.predictedSize || "unknown"})${w.unrevalidated ? " (unrevalidated — git could not list the tree)" : ""}${w.gist ? ` — ${String(w.gist).slice(0, 60)}` : ""}`;

/** @param {State} state */
function renderWriteSetCache(state) {
	const { cacheState, cachePruned } = state;
	if (
		cacheState.warm.length > 0 ||
		cacheState.provisional.length > 0 ||
		cacheState.cold.length > 0
	) {
		console.log(
			`\nWRITE-SET CACHE (${writeSetCache.CACHE_SUBDIR}) — ${cacheState.warm.length} warm, ` +
				`${cacheState.provisional.length} provisional, ${cacheState.cold.length} to derive` +
				(cachePruned.removed.length > 0
					? `, ${cachePruned.removed.length} pruned`
					: "") +
				"\nA PROVISIONAL row is this run's own grep over the body (mantahostels#1001), never an\n" +
				"agent's judgement. Band-read one where you need its size; refuse nothing\n" +
				"on one (mantahostels#588).\n",
		);
		for (const w of cacheState.warm.slice(0, WRITE_SET_PRINT_CAP))
			console.log(warmRow(w));
		printOverflow(cacheState.warm.length, "warm");
		for (const w of cacheState.provisional.slice(0, WRITE_SET_PRINT_CAP))
			console.log(provisionalRow(w));
		printOverflow(cacheState.provisional.length, "provisional");
		if (cacheState.cold.length > 0)
			console.log(
				`  derive ${chunk(
					cacheState.cold.map((/** @type {any} */ c) => `#${c.number}`),
					DERIVE_PER_LINE,
				).join("\n         ")}\n` +
					"  Store each back: node scripts/pick-next-cache.js put <n> --body-hash <hex>\n" +
					"  --json carries each hash; --dump-bodies writes it into the dumped file.",
			);
		// Why a miss stayed a miss — a `wayfinder:map` issue, an unlistable tree, an
		// unwritable store.
		for (const sk of cacheState.skipped.slice(0, WRITE_SET_PRINT_CAP))
			console.log(`  not predicted: #${sk.number} — ${sk.why}`);
		printOverflow(cacheState.skipped.length, "not predicted");
	}
}

/** @param {State} state */
function renderWarmLogged(state) {
	const { warmLogged } = state;
	// Outside the block above: a run with nothing to derive still appends a line,
	// and a failure nobody is told about is how a fortnight of collection ends up
	// empty.
	if (warmLogged?.ok === false)
		console.log(
			`\nThis run went unrecorded for mantahostels#628's warm fraction: ${warmLogged.error}`,
		);
}

/** @param {State} state */
function renderDumped(state) {
	const { dumped } = state;
	if (dumped)
		console.log(
			dumped.ok
				? `\nBODIES DUMPED — ${dumped.count} to ${dumped.dir}, from the list call already made.\nRead the band read's bodies from there, never with \`gh issue view\`.`
				: `\nBODIES — could not dump to ${dumped.dir}: ${dumped.error}\n  The shortlist above is unaffected.`,
		);
}

/**
 * Each source of an issue's urgency, for the URGENT block.
 * @param {Issue} i
 */
function urgencySources(i) {
	const why = [];
	if (i.bug) why.push("bug");
	const u = i.urgency;
	if (u && !u.unknown)
		why.push(
			`applied by ${u.appliedBy} ${Math.floor(u.ageDays)}d ago (${u.appliedAt})`,
		);
	else if (i.labels.includes(URGENT_LABEL))
		why.push("URGENT — start unrecorded");
	if (i.bugVia) why.push(viaText("bug", i.bugVia));
	if (i.urgentVia) why.push(viaText("urgent", i.urgentVia));
	return why;
}

/**
 * A tier and the chain it comes down.
 * @param {string} tier
 * @param {import("./lib/blocker-graph").Via} via
 */
const viaText = (tier, via) =>
	`${tier} via ${via.path.at(-1)} (holds ${via.path.join(" → ")})`;

/** @param {State} state */
function renderUrgent(state) {
	const { enriched } = state;
	// Display duty over `urgent`, per mantahostels#111: where it came from, who
	// applied it and when, never a write.
	const urgentShown = enriched.filter((i) => i.urgent);
	if (urgentShown.length > 0) {
		console.log(
			"\nURGENT (holds until the issue closes or the label comes off)\n",
		);
		for (const i of urgentShown)
			console.log(`  #${i.number}  ${urgencySources(i).join("; ")}`);
	}
}

/** @param {State} state */
function renderWaiting(state) {
	const { waitingAll } = state;
	if (waitingAll.length > 0) {
		console.log(
			`\nWAITING ON SOMEONE OUTSIDE THE PROJECT — ranked up from ${WAITING_STALL_DAYS}d, never down\n`,
		);
		for (const i of waitingAll) {
			const age = i.wait.unknown
				? `age unknown (${i.wait.error}) — rank untouched`
				: `${Math.floor(i.wait.ageDays)}d, since ${i.wait.appliedAt} by ${i.wait.appliedBy}${
						i.wait.stalled ? " — STALLED, ranked up" : ""
					}`;
			console.log(
				`  #${i.number}  ${age}${i.excluded ? `\n    not in the shortlist: ${i.excluded} — chase it anyway` : ""}`,
			);
		}
		console.log(
			"\n  The label goes on by hand at the moment the work is handed off, and\n" +
				"  comes off by hand when it lands.",
		);
	}
}

/** @param {State} state */
function renderParked(state) {
	const { parkedAll } = state;
	if (parkedAll.length === 0) return;
	console.log(
		"\nPARKED — a question round, or a session the refill loop stopped, waits on the founder\n",
	);
	for (const i of parkedAll) {
		const age = i.parked.unknown
			? `age unknown (${i.parked.error})`
			: `${Math.floor(i.parked.ageDays)}d, since ${i.parked.appliedAt}`;
		console.log(`  #${i.number}  ${age}  ${String(i.title).slice(0, 50)}`);
	}
	console.log(
		"\n  Choosable here; the refill loop never launches it." +
			"\n  A loop-stopped park's cause is commented on its ticket. Cleared when the\n" +
			"  founder types in a session the Stop hook parked, or a session claims the issue.",
	);
}

/** @param {State["gatedAll"][number]} i */
function printGatedRow(i) {
	if (i.gateConflict) {
		console.log(
			`  #${i.number}  TWO GATE LINES, a date and a condition — GATING NOTHING, in the batch as normal; delete one`,
		);
		return;
	}
	if (i.gate) {
		const why = i.gate.reason || "no reason given";
		/** @type {string} */
		let line;
		if (i.gate.malformed)
			line = `  #${i.number}  UNREADABLE DATE \`${i.gate.raw}\` — GATING NOTHING, in the batch as normal`;
		else if (i.gate.active)
			line = `  #${i.number}  held until ${i.gate.iso}, ${i.gate.daysLeft}d left — ${why}`;
		else
			line = `  #${i.number}  LAPSED ${i.gate.iso} — back in the batch, act or re-gate (${why})`;
		console.log(line);
		return;
	}
	// `gatedAll` carries `i.gate || i.gateOn`; the `i.gate` branch above
	// having fallen through proves this one non-null.
	const gateOn = i.gateOn;
	if (!gateOn) return;
	console.log(
		gateOn.malformed
			? `  #${i.number}  MALFORMED GATE (${gateOn.reason}) \`${gateOn.raw}\` — GATING NOTHING, in the batch as normal`
			: `  #${i.number}  held on ${gateOn.condition} — check: ${gateOn.command || "none stated"} — abandon if: ${gateOn.abandonIf}`,
	);
}

/** @param {State} state */
function renderGated(state) {
	const { gatedAll } = state;
	if (gatedAll.length > 0) {
		console.log(
			"\nGATED BY A LINE IN THE BODY — `**Gated until:** YYYY-MM-DD — why`, or\n" +
				"`**Gated on:** <condition> — check: <command> — abandon if: <clause>`\n",
		);
		for (const i of gatedAll) {
			printGatedRow(i);
		}
		console.log("\n  Move the date or delete the line; nothing expires it.");
		console.log(
			"  The `check:` on a condition gate is yours to run and judge: run\n" +
				"  `check-gates.js --issue <n>`, and on met comment the evidence and strip\n" +
				"  the marker. The refill loop also sweeps them, launching `/triage <n>`\n" +
				"  on a changed reading. `abandon if:` alone retires one unmet.",
		);
	}
}

/** @param {Issue} i */
function printProseBlockedRow(i) {
	const { named, open, unreadable } = i.proseBlocked;
	const verdicts = [
		open.length > 0 ? `still blocked by ${open.join(", ")}` : "",
		...unreadable.map((u) => `${u.ref} unreadable, held (${u.error})`),
	].filter(Boolean);
	if (named.length > 0)
		console.log(
			`  #${i.number}  names ${named.join(", ")} — ` +
				(verdicts.length > 0
					? verdicts.join("; ")
					: "every named issue is closed, resolved"),
		);
	/*
	 * NAMES NO NUMBER (mantahostels#927). Nothing here resolves against the open
	 * list, so it prints the sentence rather than a verdict.
	 */
	for (const raw of i.proseBlocked.unparsed)
		console.log(
			`  #${i.number}  NAMES NO ISSUE NUMBER — read it before dispatching:\n` +
				`           ${raw.length > 160 ? `${raw.slice(0, 157)}...` : raw}`,
		);
}

/** @param {State} state */
function renderProseBlocked(state) {
	const { proseBlockedAll } = state;
	if (proseBlockedAll.length > 0) {
		console.log(
			"\nPROSE SELF-GATES — `**Blocked on** #<n>` in the body, this repo's resolved\n" +
				"against the open list this run already fetched (mantahostels#1289). Folded into\n" +
				"`blocked by` above where still open or unreadable; a closed one in this\n" +
				"repo needed no read.\n",
		);
		for (const i of proseBlockedAll) {
			printProseBlockedRow(i);
		}
	}
}

/**
 * A pulled-in row's inherited tiers and depth, or "" where it inherits none.
 * @param {{bug: boolean, urgent: boolean, goal: boolean, depth: number}} r
 */
function pulledTiers(r) {
	const tiers = [
		r.bug ? "bug" : "",
		r.urgent && !r.bug ? "urgent" : "",
		r.goal ? "goal" : "",
		r.depth > 0 ? `depth ${r.depth}` : "",
	].filter(Boolean);
	return tiers.length > 0 ? `${tiers.join(" ")}  ` : "";
}

/* The title's room on an 80-column terminal after the row's 11-column indent. */
const PULLED_TITLE_CHARS = 80 - 11;

/** @param {State} state */
function renderPulledIn(state) {
	const { rows, unread } = state.pulledIn;
	if (rows.length === 0 && unread.length === 0) return;
	console.log(
		"\nPULLED IN FROM OTHER REPOS — open, unblocked, and holding an issue here out\n" +
			"through the blocked-by chain; launched from its own checkout (#2427)\n",
	);
	for (const r of rows)
		console.log(
			`  ${r.repo}#${r.number}  ${pulledTiers(r)}reach ${r.reach}  holds ${r.holds.join(", ")}` +
				`${r.held ? `  HELD OUTSIDE THE LOOP: ${r.held}` : ""}\n           ${String(r.title).slice(0, PULLED_TITLE_CHARS)}`,
		);
	for (const u of unread)
		console.log(
			`  ${u.ref}  blockers unread, not offered: ${u.error}\n           holds ${u.holds.join(", ")}`,
		);
}

/** @param {State} state */
function renderEmptyBody(state) {
	const { frontier } = state;
	const emptyBodied = emptyBodiedOf(frontier);
	if (emptyBodied.length > 0) {
		console.log(
			"\nEMPTY BODY — on the frontier with nothing to work from; most likely a failed\ncreate, so check for a duplicate before taking it (mantahostels#3443)\n",
		);
		for (const i of emptyBodied) console.log(`  #${i.number}  ${i.title}`);
	}
}

/** @param {State} state */
function renderDegraded(state) {
	const { degraded, repo } = state;
	if (degraded.length > 0) {
		console.log(
			`\nDEGRADED (${degraded.length}) — readiness unknown, held out of the shortlist\n`,
		);
		const { expanded, collapsed } = groupByRepeatedError(degraded, (i) =>
			String(i.depsUnknown),
		);
		for (const i of expanded)
			console.log(
				`  #${i.number}  ${String(i.title).slice(0, 60)}\n    ${i.depsUnknown}`,
			);
		for (const g of collapsed) console.log(buildCollapsedFailureLine(g));
		console.log(
			"\n  These may or may not be takeable, and every REACH above is a lower\n" +
				"  bound: edges into a degraded issue are invisible, so whatever blocks\n" +
				"  one is under-ranked. Check by hand before concluding the shortlist is\n" +
				"  the whole frontier, or that its order is right:\n" +
				`    gh api repos/${repo}/issues/<n>/dependencies/blocked_by`,
		);
	}
}

/** @param {State} state */
function renderAssignedUnclaimed(state) {
	const { enriched } = state;
	/*
	 * The fail-open case, said out loud (mantahostels#645). An assignment nothing backs is
	 * treated as free, and a reader who saw the assignee in GitHub needs to know
	 * this run decided against it — silently ignoring a claim would be the
	 * unaccountable answer a bare assignee gives.
	 */
	const assignedUnclaimed = enriched.filter((i) => i.assignedUnclaimed);
	if (assignedUnclaimed.length > 0) {
		console.log(
			`\nASSIGNED BUT UNCLAIMED (${assignedUnclaimed.length}) — treated as takeable\n`,
		);
		for (const i of assignedUnclaimed.sort((a, b) => a.number - b.number))
			console.log(
				`  #${i.number}  ${i.assignees.join(", ")}  ${String(i.title).slice(0, 50)}`,
			);
		console.log(
			"\n  No live session recorded a claim on these, so the assignee is taken to\n" +
				"  be a finished session's leftover. A session that IS on one of these\n" +
				"  should have run:  node scripts/session-arbiter.js claim-issue <n>",
		);
	}
}

/** @param {State} state */
function renderClaimsDegraded(state) {
	const { claims, parentHeld } = state;
	if (claims.why)
		console.log(
			`\nCLAIMS DEGRADED — ${claims.why}.\n  ${buildClaimsDegradedAdvice(claims)}`,
		);
	for (const why of parentHeld.unread)
		console.log(
			`\nWARN: ${why}.\n  Its children are shown as takeable whether or not a session holds it.`,
		);
}

/**
 * @param {State} state
 * @returns {Issue[]} the issues held as already dispatched, which EXCLUDED counts
 */
function renderDispatched(state) {
	const { enriched, dispatched, listed, dispatchJobs } = state;
	/*
	 * A BLOCK OF ITS OWN, never folded into EXCLUDED (mantahostels#1528). These are the only
	 * exclusions a reader can lift themselves — the launcher's own `--force` —
	 * and a stale ledger entry is invisible unless its age is printed.
	 */
	const dispatchedShown = enriched
		.filter((i) => i.dispatchHeld)
		.sort((a, b) => a.number - b.number);
	if (dispatchedShown.length > 0) {
		console.log(
			`\nALREADY DISPATCHED (${dispatchedShown.length}) — held out of the frontier, not offered\n`,
		);
		for (const i of dispatchedShown) {
			const rec = i.dispatchRec;
			const rawLiveness = dispatchLiveness(rec, listed, dispatchJobs);
			const liveness = dispatchLivenessLabel(rawLiveness);
			// pad() pads a short label but never truncates a long one (mantahostels#3488
			// Standards, the "finished: <detail>" case) — `pad(…, 14) + " "`
			// keeps a separator even where the cell overruns the column.
			const livenessCell = rawLiveness.why
				? `${liveness} (${rawLiveness.why})`
				: liveness;
			console.log(
				`  #${i.number}  ${dispatchAge(rec)}  ${pad(livenessCell, 14)} ${String(i.title).slice(0, 40)}`,
			);
		}
		console.log(
			"\n  scripts/dispatch-sessions.sh drops any set member running the same command on one of these\n" +
				`  for ${DISPATCH_WINDOW_HOURS}h after launching it (mantahostels#1337, #752), alive or not, so a set built on one loses\n` +
				"  that member and gains nothing back. A relabelled issue is not held. Past a stale entry:\n" +
				"    scripts/dispatch-sessions.sh --force ...",
		);
	}
	if (dispatched.why)
		console.log(
			`\nDISPATCH LEDGER DEGRADED — ${dispatched.why}.\n` +
				`  Nothing was excluded on it, so an issue launched in the last ${DISPATCH_WINDOW_HOURS}h may be\n` +
				"  shown as takeable and then dropped at launch.",
		);
	return dispatchedShown;
}

/**
 * @param {State} state
 * @param {Issue[]} dispatchedShown
 */
function renderExcluded(state, dispatchedShown) {
	const { enriched } = state;
	console.log("\nEXCLUDED\n");
	for (const i of enriched
		// The dispatched ones have a block of their own above, so printing them
		// here too would report the same exclusion twice (mantahostels#1528).
		.filter((x) => x.excluded && !x.dispatchHeld)
		.sort((a, b) => a.number - b.number))
		console.log(
			`${pad(`#${i.number}`, 6)}${pad(i.group, 16)}${pad(i.excluded, 40)}${String(i.title).slice(0, 40)}`,
		);
	if (dispatchedShown.length > 0)
		console.log(
			`\n  ${dispatchedShown.length} more excluded as already dispatched — ALREADY DISPATCHED, above.`,
		);
}

/** @param {State} state */
function renderNotProposed(state) {
	const notLaunched = notLaunchedOf(state).sort(
		(a, b) => REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason),
	);
	console.log(
		`\nNOT PROPOSED (${notLaunched.length}) — frontier issues outside the set, by the first reason that applies\n`,
	);
	if (notLaunched.length === 0) console.log("  none");
	/** @type {NotLaunchedReason | null} */
	let shownReason = null;
	for (const e of notLaunched.slice(0, NOT_PROPOSED_PRINT_CAP)) {
		if (e.reason !== shownReason) console.log(`  ${e.reason}:`);
		shownReason = e.reason;
		console.log(
			`    #${e.number}  ${NOT_LAUNCHED_REASONS[e.reason](e.detail)}`,
		);
	}
	if (notLaunched.length > NOT_PROPOSED_PRINT_CAP)
		console.log(
			`  ... and ${notLaunched.length - NOT_PROPOSED_PRINT_CAP} more — --json carries every one.`,
		);
}

/** @param {State["summary"]} summary */
function printSummaryFlags(summary) {
	/*
	 * A failed probe prints `unknown` and its reason, not silence (mantahostels#1237, on
	 * mantahostels#1206): §6's *Headroom understated* line fires on this count, so a probe
	 * that could not run would otherwise remove that line and leave the reader
	 * concluding the headroom is honest.
	 *
	 * The rows below are silent at zero on purpose — each is a §6 line that
	 * prints only where it applies.
	 */
	if (summary.reclaimableUnknown)
		console.log(
			`  ${pad("reclaimable", 19)}unknown (${summary.reclaimableUnknown}) — headroom may be understated and nothing here can say by how much`,
		);
	else if ((summary.reclaimable ?? 0) > 0)
		console.log(
			`  ${pad("reclaimable", 19)}${summary.reclaimable} finished session${summary.reclaimable === 1 ? "" : "s"} still resident — headroom understated`,
		);
	if (summary.degraded)
		console.log(
			`  ${pad("degraded", 19)}${summary.degraded} readiness unknown — the shortlist is not the whole frontier`,
		);
	/*
	 * Printed even at zero where the ledger read, unlike the rows around it:
	 * §5's accounting denominator moved on this count (mantahostels#1528), so a reader
	 * reconciling `frontier` against the tracker needs to see it was applied.
	 */
	if (summary.dispatchHeldUnknown)
		console.log(
			`  ${pad("dispatched", 19)}unknown (${summary.dispatchHeldUnknown}) — the frontier may hold issues the launcher will drop`,
		);
	else
		console.log(
			`  ${pad("dispatched", 19)}${summary.dispatchHeld} held out on a launch in the last ${DISPATCH_WINDOW_HOURS}h`,
		);
	// Over the whole frontier, never the shown slice: an issue below the
	// `--limit` cut can still be a proposed member (mantahostels#3363).
	if (summary.labelDefects.length > 0)
		console.log(
			`  ${pad("labelling", 19)}${summary.labelDefects
				.map((/** @type {any} */ d) => `#${d.number} (${takesCell(d.takes)})`)
				.join(", ")} — node ${scriptPath("check-issue-labels.js")}`,
		);
}

/** @param {State} state */
function renderRunSummary(state) {
	const { summary } = state;
	/*
	 * Counted from the blocks above, and printed after them: a reader who tails
	 * this output lands here, and §6's message is what they write next.
	 */
	console.log("\nRUN SUMMARY — the figures §6's message is written from\n");
	console.log(`  ${pad("open issues", 19)}${summary.openIssues}`);
	console.log(
		`  ${pad("frontier", 19)}${summary.frontierCount} — §5's accounting denominator, never the shown slice`,
	);
	console.log(`  ${pad("shown", 19)}${summary.shown}`);
	console.log(
		`  ${pad("open tally", 19)}${buildOpenTallyLine(openTallyOf(state))}`,
	);
	/*
	 * Printed at zero too, unlike the silent-at-zero rows further down: §6's
	 * line carries this term whether or not it is 0.
	 */
	console.log(
		`  ${pad("no command", 19)}${summary.noCommand} — §5's third term: takes:human, plus a rotted takes:children container`,
	);
	if (summary.rottedContainers.length > 0)
		console.log(
			`  ${pad("", 19)}rotted containers: ${summary.rottedContainers
				.map((/** @type {number} */ n) => `#${n}`)
				.join(
					", ",
				)} — takes:children with no open child left; retag them, node ${scriptPath("check-issue-labels.js")}`,
		);
	console.log(
		`  ${pad("admission", 19)}${summary.admit ? "START ONE NOW" : "HOLD"} — ${
			summary.freeSlots === null
				? "free slots unknown"
				: `${summary.freeSlots} free slot(s)`
		}, as of this run — re-read it with node scripts/admission.js before starting anything (mantahostels#1144)`,
	);
	console.log(
		`  ${pad("write-sets", 19)}${summary.writeSets.warm} warm, ${summary.writeSets.provisional} provisional, ${summary.writeSets.cold} to derive`,
	);
	console.log(
		// A count, never the list: the numbers run to a line long enough to bury
		// every row under it, and the block above already prints them.
		`  ${pad("proposed set", 19)}${
			summary.proposed.length > 0
				? `${summary.proposed.length} candidate${summary.proposed.length === 1 ? "" : "s"} — the numbers are in the graph block above, and each member's takes: and write-set in \`summary.proposed\``
				: "empty"
		}`,
	);
	console.log(
		// `carrying` is null two ways, and saying "unknown how many carrying"
		// where the count itself was never read claims git was asked.
		`  ${pad("owed work", 19)}${summary.debtEntries ?? "unknown"} debt entries, ${
			summary.strandedClaims === null
				? "unknown stranded claims"
				: `${summary.strandedClaims} stranded claims (${summary.strandedClaimsCarrying ?? "unknown how many"} carrying uncommitted work)`
		}`,
	);
	printSummaryFlags(summary);
}

/** @param {{ok: boolean, file: string, error?: string}} snapshot */
function renderFooter(snapshot) {
	/*
	 * GENUINELY LAST: tailing this output is what loses the top of it, so a
	 * pointer anywhere else is lost by exactly the reader it is for.
	 *
	 * The failure line prescribes the `--json` re-run the skill otherwise bars —
	 * with no file on disk, that re-run is the only copy.
	 */
	console.log("\nAdvisory only; nothing here was written back to the tracker.");

	console.log(
		snapshot.ok
			? `\nFULL JSON OF THIS RUN: ${snapshot.file}\n  Every block above, machine-readable. Read it rather than re-running for --json.\n  Check its generatedAt and repo before trusting it: a --no-log or --repo run overwrites this same file.`
			: `\nFULL JSON NOT WRITTEN — ${snapshot.error}\n  ${snapshot.file} holds an older run or none, so a --json re-run is the only copy.`,
	);
}

/**
 * The text report printed when `--json` was not asked for. Reads `state`
 * alone -- everything `buildPayload` puts in the envelope is data this
 * already has, so nothing here reads the payload it produced.
 * @param {State} state
 * @param {{ok: boolean, file: string, error?: string}} snapshot
 */
function render(state, snapshot) {
	renderCounts(state);
	renderAdmission(state);
	renderOwedWork(state);
	renderShortlist(state);
	renderCollisions(state);
	renderDocMapQueue(state);
	renderRetroBundles(state);
	renderConflictGraph(state);
	renderWriteSetCache(state);
	renderWarmLogged(state);
	renderDumped(state);
	renderUrgent(state);
	renderWaiting(state);
	renderParked(state);
	renderGated(state);
	renderProseBlocked(state);
	renderPulledIn(state);
	renderEmptyBody(state);
	renderDegraded(state);
	renderAssignedUnclaimed(state);
	renderClaimsDegraded(state);
	const dispatchedShown = renderDispatched(state);
	renderExcluded(state, dispatchedShown);
	renderNotProposed(state);
	renderRunSummary(state);
	renderFooter(snapshot);
}

/**
 * @returns {Promise<Enriching[]>}
 */
async function listOpenIssuesOrExit() {
	try {
		return await openIssues();
	} catch (e) {
		/*
		 * The list call is the one failure with no degraded mode: without it there
		 * is no candidate set at all, and printing an empty shortlist would read as
		 * "the tracker is drained".
		 */
		/* An outcome error is lib/gh.js's own refusal, whole, never a gh fault. */
		let why;
		if (isOutcomeError(e))
			why = `FAILED: could not list open issues: ${/** @type {Error} */ (e).message}\n`;
		else
			why =
				`FAILED: could not list open issues (${parseErrLine(e)}).\n` +
				(parseGhFailureReason(e) === "unreachable"
					? `        ${unreachableRemedy(e)}\n`
					: "        GitHub was reachable — this is a fault in the query, not your auth.\n");
		console.error(
			`${why}        No shortlist produced — do not read this as an empty frontier.`,
		);
		process.exit(1);
	}
}

/** @param {Enriching[]} issues */
const ownRepoOf = (issues) => issues.find((i) => i.repo)?.repo ?? listRepo();

/**
 * @param {Enriching[]} issues
 * @param {Map<number, Enriching>} byNumber
 * @returns {Promise<{withDeps: DepsResolved[], blockers: import("./lib/blocker-graph").Graph}>}
 */
async function resolveBlockers(issues, byNumber) {
	const ownRepo = ownRepoOf(issues);
	const reads = await blockedByMany(issues, { repo: REPO, home: ownRepo });
	const withEdges = reads.map(({ issue, read }) => ({
		...issue,
		blockedBy: read.ok ? read.edges : [],
		depsUnknown: read.ok ? null : read.error,
	}));
	const graph = await blockerGraph.blockerGraph(
		withEdges.map((i) => {
			const parent = parseIssueRef(i.parent);
			return {
				number: i.number,
				edges: i.blockedBy,
				body: i.body,
				parent:
					parent &&
					!isInOtherRepo(parent, i.repo) &&
					byNumber.has(parent.number)
						? parent.number
						: null,
			};
		}),
		ownRepo,
		{
			// The few foreign nodes the walk reaches, read one by one (#2427).
			blockedBy: (ref) =>
				readBlockedByOne(ref.repo ?? REPO, ref.number, { home: ref.repo }),
			issue: readIssueIn,
			each: (items, fn) => mapLimit(items, ISSUE_READ_CONCURRENCY, fn),
		},
	);

	return {
		withDeps: withEdges.map((i) => ({
			...i,
			proseBlocked: proseBlockedOf(graph, i),
		})),
		blockers: graph,
	};
}

/**
 * PROSE SELF-GATES (mantahostels#1289): `i`'s `**Blocked on**` references as
 * the graph judged them — this repo's against every open issue, already
 * fetched, at no extra call — and the marker lines that name no number.
 * @param {import("./lib/blocker-graph").Graph} graph
 * @param {{number: number, body: string}} i
 */
function proseBlockedOf(graph, i) {
	return {
		...blockerGraph.proseOf(graph, i.number),
		unparsed: unparsedBlockersOf(i.body),
	};
}

/**
 * lib/blocker-graph.js's launch candidates in other repos, each with the
 * checkout it launches from, `root`, and `held`: why it is held outside the
 * loop, no checkout tracking its repo, else null. An opted-out checkout's
 * issues that hold a served one out still launch (#3281). Each carries the
 * tiers and depth it
 * inherits from what it holds here, for the refill merge to rank it by (#3222).
 * @param {import("./lib/blocker-graph").Graph} graph
 * @param {ReturnType<typeof inheritanceOf>} inherit
 */
function pulledInRows(graph, inherit) {
	const { rows, unread } = blockerGraph.pulledInOf(graph);
	return {
		rows: rows.map((r) => {
			const checkout = readCheckoutTracking(r.repo, homeDir());
			const root = "root" in checkout ? checkout.root : null;
			return {
				...r,
				...tiersOf({ bug: false, urgent: false, goal: false }, inherit(r)),
				root,
				held: root ? null : /** @type {{why: string}} */ (checkout).why,
			};
		}),
		unread,
	};
}

/**
 * @param {Enriching[]} issues
 */
function openChildrenOf(issues) {
	const openChildren = new Map(issues.map((i) => [i.number, 0]));
	for (const i of issues) {
		const ref = parseIssueRef(i.parent);
		// A parent in another repo shares only its number with one here.
		if (!ref || isInOtherRepo(ref, i.repo)) continue;
		if (openChildren.has(ref.number))
			openChildren.set(ref.number, (openChildren.get(ref.number) ?? 0) + 1);
	}
	return openChildren;
}

/**
 * @param {Enriching[]} issues
 */
async function timelinesByIssue(issues) {
	// Only issues actually carrying an age-sensitive label cost a timeline call.
	const timelineCandidates = issues.filter(
		(i) =>
			i.labels.includes(URGENT_LABEL) ||
			i.labels.includes(WAITING_LABEL) ||
			i.labels.includes(PARKED_LABEL),
	);
	const timelines = await mapLimit(
		timelineCandidates,
		ISSUE_READ_CONCURRENCY,
		(/** @type {RawIssue} */ i) => readTimelineOf(i.number),
	);
	return new Map(
		timelineCandidates.map((i, idx) => [i.number, timelines[idx]]),
	);
}

/**
 * What `enrichIssue` reads besides the issue itself.
 * @typedef {object} EnrichContext
 * @property {import("./lib/blocker-graph").Graph} blockers
 * @property {Awaited<ReturnType<typeof timelinesByIssue>>} timelineByIssue
 * @property {ReturnType<typeof inheritanceOf>} inherit
 * @property {Set<number>} mapNumbers
 * @property {Set<number>} specNumbers
 * @property {ListedSessions} listed
 * @property {ReturnType<typeof claimedIssues>} claims
 * @property {Awaited<ReturnType<typeof parentClaims>>} parentHeld
 * @property {ReturnType<typeof dispatchedIssues>} dispatched
 * @property {Map<number, number>} openChildren
 */

/**
 * Why an issue is held out of the frontier, earliest-applicable first, or
 * null where nothing holds it.
 * @param {DepsResolved} i
 * @param {EnrichContext} ctx
 * @param {{openBlockers: {label: string, native: boolean}[], dispatchReason: string|null, resolved: ReturnType<typeof resolveGate>}} facts
 */
function exclusionOf(i, ctx, facts) {
	const { openBlockers, dispatchReason, resolved } = facts;
	const { claims, parentHeld, listed, openChildren } = ctx;
	// `gateHolds`/`gateOnHolds` already prove non-null and non-malformed;
	// these locals carry that proof where the flag alone cannot.
	const gate = resolved.gate;
	const gateOn = resolved.gateOn;
	if (i.depsUnknown) return `readiness unknown — ${i.depsUnknown}`;
	if (openBlockers.length > 0)
		return `blocked by ${openBlockers
			.map((b) => (b.native ? b.label : `${b.label} (prose only)`))
			.join(", ")}`;
	if (claims.held.has(i.number))
		return `claimed by ${claimHolder(i.assignees, claims.held.get(i.number), claims.kept, listed.names)}`;
	const parent = parentHeld.held.get(i.number);
	if (parent)
		return `claimed through parent map ${parent.label} by ${claimHolder([], parent.sessionId, parent.kept, listed.names)}`;
	if (dispatchReason) return dispatchReason;
	if (openChildren.get(i.number))
		return `container — ${openChildren.get(i.number)} open children`;
	if (resolved.gateHolds && gate && !gate.malformed)
		return `gated until ${gate.iso} (${gate.daysLeft}d) — ${gate.reason || "no reason given"}`;
	if (resolved.gateOnHolds && gateOn && !gateOn.malformed)
		return `gated on ${gateOn.condition}`;
	return null;
}

/**
 * The issues whose parent map a live session holds a claim on (#2310), as
 * `held` (issue number -> the parent and its holder), and `unread`, one
 * sentence per parent whose kind or store could not be read, each of which
 * holds nothing. A same-repo parent's kind is read off `mapNumbers`; a parent
 * in another repo costs one `issues/<n>/parent` call, whose payload carries it.
 * @param {RawIssue[]} issues
 * @param {Set<number>} mapNumbers
 * @param {ReturnType<typeof claimedIssues>} claims
 * @param {ListedSessions} listed
 */
async function parentClaims(issues, mapNumbers, claims, listed) {
	/** @type {Map<number, {label: string, sessionId: string, kept: boolean}>} */
	const held = new Map();
	const unread = new Set();
	const withParent = issues.flatMap((i) => {
		const ref = parseIssueRef(i.parent);
		return ref ? [{ i, ref }] : [];
	});
	const reads = await mapLimit(
		withParent,
		ISSUE_READ_CONCURRENCY,
		async ({ i, ref }) => {
			if (!isInOtherRepo(ref, i.repo))
				return {
					url: i.parent,
					labels: mapNumbers.has(ref.number) ? [MAP_LABEL] : [],
				};
			const r = await ghGetRetrying(`repos/${REPO}/issues/${i.number}/parent`);
			if (r.ok) return r.out[0];
			return { error: r.error };
		},
	);
	for (const [idx, { i }] of withParent.entries()) {
		const verdict = parentVerdictOf(i.number, reads[idx], {
			childRepo: i.repo,
			listed,
			hostHeld: claims,
		});
		if (verdict.state === "unread") unread.add(verdict.why);
		if (verdict.state === "claimed") {
			const { state: _, ...claim } = verdict;
			held.set(i.number, claim);
		}
	}
	return { held, unread: [...unread] };
}

/**
 * @param {DepsResolved} i
 * @param {EnrichContext} ctx
 * @returns {Issue}
 */
function enrichIssue(i, ctx) {
	const openBlockers = blockerGraph.openBlockersOf(ctx.blockers, i.number);
	const timeline = ctx.timelineByIssue.get(i.number);
	const urgency =
		i.labels.includes(URGENT_LABEL) && timeline
			? labelAge(timeline, URGENT_LABEL)
			: null;
	const held = ctx.inherit({ repo: ctx.blockers.ownRepo, number: i.number });
	const { bug: bugVia, urgent: urgentVia, goal: goalVia } = held.via;
	const tiers = tiersOf(
		{
			bug: i.labels.includes("bug"),
			urgent: i.labels.includes(URGENT_LABEL),
			goal: goalSet.has(i.number),
		},
		held,
	);
	// Null unless the label is on: absence of a wait, distinct from a wait
	// whose start could not be read.
	const wait =
		i.labels.includes(WAITING_LABEL) && timeline ? waitFrom(timeline) : null;
	const parked =
		i.labels.includes(PARKED_LABEL) && timeline
			? labelAge(timeline, PARKED_LABEL)
			: null;
	const takes = takesOf(i);
	const resolved = resolveGate(i.body);
	/*
	 * Computed before the chain so the flag below can say whether THIS limb
	 * is the one that fired. An issue that is also blocked or claimed keeps
	 * that reason, and is reported there rather than in two blocks at once.
	 */
	const dispatchRec = holdingDispatch(ctx.dispatched, i.number, takes);
	const dispatchReason = dispatchRec
		? `dispatched ${dispatchAge(dispatchRec)}`
		: null;
	const excluded = exclusionOf(i, ctx, {
		openBlockers,
		dispatchReason,
		resolved,
	});
	return {
		...i,
		openBlockers,
		reach: blockerGraph.reachOf(ctx.blockers, i.number),
		depth: tiers.depth,
		urgency,
		urgentVia,
		bugVia,
		goalVia,
		bug: tiers.bug,
		urgent: tiers.urgent,
		wait,
		// The one number the sort reads: 0 for everything that is not a stalled
		// wait, an unreadable age included.
		stallDays: wait && !wait.unknown && wait.stalled ? wait.ageDays : 0,
		parked,
		goal: tiers.goal,
		collision: collisionOf(i),
		asksQuestions: isQuestionType(i),
		takes,
		group: groupOf(i, ctx.mapNumbers, ctx.specNumbers),
		gate: resolved.gate,
		gateOn: resolved.gateOn,
		gateConflict: resolved.conflict,
		gateHolds: resolved.gateHolds,
		gateOnHolds: resolved.gateOnHolds,
		dispatchRec,
		excluded,
		dispatchHeld: dispatchReason !== null && excluded === dispatchReason,
		// Assigned, but no live session recorded a claim: fail open, and say so
		// under the shortlist rather than silently. Excluded issues are left out —
		// this run is not offering them.
		assignedUnclaimed:
			i.assignees.length > 0 && !ctx.claims.held.has(i.number) && !excluded,
	};
}

/**
 * @param {Issue[]} enriched
 */
function rankFrontier(enriched) {
	return enriched
		.filter((i) => !i.excluded)
		.sort((a, b) => compareLevels(a, b) || a.number - b.number);
}

/**
 * The write-set cache (mantahostels#385).
 *
 * Pruned against every open issue, not the frontier: a claimed or blocked
 * issue is still open, and its entry is what makes the *next* re-pick warm.
 * @param {Issue[]} frontier
 * @param {Issue[]} enriched
 * @param {TrackedFiles} tracked
 */
function writeSetCacheOf(frontier, enriched, tracked) {
	/*
	 * Skipped against any repo but this tree's own: the store is keyed on
	 * REPO_ROOT alone, so another tracker's #7 would read this one's entry, and
	 * pruning would delete every entry that tracker has no open issue for.
	 */
	const cacheUsable = REPO === REPO_DEFAULT;
	const cacheSplit = cacheUsable
		? writeSetCache.lookupAll(REPO_ROOT, frontier, tracked)
		: { warm: [], cold: [] };
	const cachePruned = cacheUsable
		? writeSetCache.prune(
				REPO_ROOT,
				enriched.map((i) => i.number),
			)
		: { removed: [] };

	/*
	 * PRE-WARMING (mantahostels#1001). Every miss the lookup found is filled with a grep
	 * prediction and folded back in, so this run's band read need only cover what
	 * no prediction could reach.
	 */
	const cacheState = prewarm(REPO_ROOT, frontier, {
		tracked,
		split: cacheSplit,
		enabled: cacheUsable && !NO_PREWARM,
	});
	return { cacheUsable, cachePruned, cacheState };
}

/**
 * How many entries were put since the last run recorded, which is what tells
 * a genuine re-pick from a second record of one run where the frontier has
 * not moved (mantahostels#667). Counted before the append, so the interval ends here.
 * @param {boolean} cacheUsable
 */
function putsSinceLastRun(cacheUsable) {
	return cacheUsable && !NO_LOG
		? writeSetCache.countDerivedSince(
				REPO_ROOT,
				warmFractionLog.readLastRunAt(REPO_ROOT),
			)
		: { ok: false, count: null };
}

/**
 * THE SUBSTRATE-CONFLICT GRAPH (mantahostels#1002).
 *
 * Over the whole frontier, like the collisions it refines. It says which candidates name
 * one file, never which of those files is a substrate: that call is the
 * skill's (mantahostels#506). Retro-bundle members are left out: `/triage`
 * writes no repo file, so they can neither lose a slot to a clash nor cost
 * another issue one (#1105).
 * @param {Issue[]} frontier
 * @param {Enriching[]} issues
 * @param {ReturnType<typeof listedSessionIds>} listed
 * @param {State["cacheState"]} cacheState
 */
function conflictGraphOf(frontier, issues, listed, cacheState) {
	const bundles = retroBundles(frontier);
	const bundled = new Set(bundles.flat());
	const unbundled = frontier.filter((i) => !bundled.has(i.number));
	/*
	 * The whole open-issue set this run already fetched (`issues`, above) — no
	 * extra request needed to tell a claim's holder is stranded on an issue that
	 * has since closed (mantahostels#2764).
	 */
	const openIssueNumbers = new Set(issues.map((i) => i.number));
	const heldFiles = conflictGraph.readHeldFiles(listed, openIssueNumbers);
	const graph = conflictGraph.buildGraph({
		candidates: conflictGraph.writeSetsFor(unbundled, [
			...cacheState.warm,
			...cacheState.provisional,
		]),
		held: heldFiles,
	});
	return { bundles, graph };
}

/**
 * DISPATCHABLE FLOOR (mantahostels#1507, mantahostels#1621). The numerator only — `graph.proposed`
 * minus every member whose `takes:` is `human` or `children`, the two
 * values no command opens (docs/agents/triage-labels.md §`takes:`). Never
 * folded against `admission.freeSlots` here: that figure is minutes stale
 * by the time §6 is written, so §5 takes `min(floor, a fresh admission.js
 * read)` instead. It over-counts by construction — a candidate with an
 * empty predicted write-set is admitted with nothing to clash on, and
 * conflict detection sees only predicted write-sets, never real ones
 * (mantahostels#1506) — deliberately left unrepaired, per mantahostels#1507.
 *
 * Plus one per retro bundle, which is one session (#1105).
 * @param {State["graph"]} graph
 * @param {Issue[]} frontier
 * @param {ReturnType<typeof retroBundles>} bundles
 */
function dispatchableFloorOf(graph, frontier, bundles) {
	return (
		graph.proposed.filter((n) => {
			const i = frontier.find((x) => x.number === n);
			const takes = i ? i.takes : [];
			return !takes.some((t) => NO_COMMAND_VALUES.includes(t));
		}).length + bundles.length
	);
}

/**
 * One line per real re-pick, for mantahostels#628 — the warm fraction that mantahostels#611's
 * per-ticket saving multiplies. Skipped against another repo, where there is
 * no split to record rather than a cold one.
 * @param {boolean} cacheUsable
 * @param {{frontier: Issue[], cacheState: State["cacheState"], degraded: Issue[], putsSince: ReturnType<typeof putsSinceLastRun>}} run
 */
function logWarmFraction(cacheUsable, run) {
	const { frontier, cacheState, degraded, putsSince } = run;
	return cacheUsable && !NO_LOG
		? warmFractionLog.appendRun(REPO_ROOT, {
				frontier: frontier.length,
				warm: cacheState.warm,
				provisional: cacheState.provisional,
				cold: cacheState.cold,
				degraded: degraded.length,
				session: idSeam.fromEnv(),
				puts: putsSince.ok ? putsSince.count : null,
			})
		: null;
}

/**
 * The machine's admission readings and the lenient verdict over them.
 *
 * The reclaimable credit (`reclaimableMb`, reading the reaper's own
 * `--dry-run --json` plan) is NOT wired here: it would spawn a second node
 * process and a second oracle read against the very figure this run is
 * measuring — the standing reason `reclaimableFrom` already declines to
 * reap here (mantahostels#653, quoted above). `admission.js`'s dispatch-time re-read is
 * where the credit applies (mantahostels#1288); §5 sends the reader there immediately
 * before the dispatch lines regardless. How many the next reap takes is
 * `reclaimableFrom`'s count, which matches the reaper's plan without running
 * it; the MB it would return stays uncredited.
 * @param {ListedSessions} listed
 */
function admissionOf(listed) {
	const reclaimable = reclaimableFrom(listed);
	const {
		mem,
		procs,
		overhead,
		host,
		live,
		load,
		cpu,
		landerMb,
		floorRead,
		swapHold,
		launchMb,
		memory,
	} = machineAdmission({
		listed,
		reclaimable: reclaimable.ok
			? { ok: true, mb: 0, count: reclaimable.count }
			: reclaimable,
		/* Each slot counted here is a launch `dispatch-sessions.sh` re-reads
		 * with `--launch`, so it is priced with the pair that launch warms (#2568). */
		pendingSpares: LAUNCH_SPARES,
		landers: readLiveLanders(),
	});
	/*
	 * A second verdict over the same readings, kept deliberately: the
	 * breakdown's slot row takes `strictAdmission`'s, which fails closed and
	 * carries the arithmetic, while selection wants `admissionFrom`'s lenient
	 * one, which still admits where memory or the session count is unreadable,
	 * so a full run degrades rather than dying (`lib/admission.js`'s header).
	 * Where both read, they agree on the slots selected, the session floor
	 * included: this run credits no reclaim.
	 */
	const admission = admissionFrom(mem, procs, {
		overhead,
		live,
		host,
		load,
		cpu,
		landerMb,
		sessionFloor: floorRead.sessions,
		swapHold,
		launchMb,
	});
	return {
		reclaimable,
		mem,
		procs,
		host,
		live,
		floorRead,
		memory,
		admission,
	};
}

/**
 * @param {Issue[]} enriched
 */
function bannersOf(enriched) {
	/*
	 * Every waiting issue, shortlisted or not, longest first. An excluded one —
	 * claimed, or blocked — is the case the rank level above cannot reach, and
	 * the EXCLUDED table shows no age.
	 */
	const waitingAll = enriched
		.filter(hasWait)
		.sort((a, b) => (waitDays(b) || 0) - (waitDays(a) || 0));

	/* Every issue carrying either marker, gating or not — one banner. */
	const gatedAll = enriched
		.filter((i) => i.gate || i.gateOn)
		.sort((a, b) => a.number - b.number);
	const gatedOnAll = gatedAll.filter(hasGateOn);

	/*
	 * Every issue carrying a `**Blocked on**` marker (mantahostels#1289), whether or not the
	 * number it names is still open.
	 */
	const proseBlockedAll = enriched
		.filter(
			(i) =>
				i.proseBlocked.named.length > 0 || i.proseBlocked.unparsed.length > 0,
		)
		.sort((a, b) => a.number - b.number);
	/* Every parked issue, oldest park first, whatever else excludes it. */
	const parkedAll = enriched
		.filter(hasParked)
		.sort((a, b) => parkedDays(b) - parkedDays(a));
	return { waitingAll, gatedAll, gatedOnAll, proseBlockedAll, parkedAll };
}

/**
 * Every figure the skill's §6 message needs, in one place (mantahostels#1001). Nothing
 * here is new; it is the `render*` blocks, counted.
 *
 * Over the whole frontier, never `shown`: the dispatch set is drawn from
 * the frontier, so a defect on a proposed member `--limit` cut off the
 * printed table went unreported (mantahostels#3363).
 * @param {Pick<State, "enriched" | "frontier" | "shown" | "admission" | "reclaimable" | "cacheState" | "graph" | "degraded" | "dispatched" | "debts" | "stranded"> & {noCommandCount: number, rottedContainers: number[]}} run
 */
function summaryOf(run) {
	const {
		enriched,
		frontier,
		shown,
		admission,
		reclaimable,
		cacheState,
		graph,
		degraded,
		dispatched,
		debts,
		stranded,
	} = run;
	const labelDefects = frontier
		.filter((i) => i.takes.length !== 1)
		.map((i) => ({ number: i.number, takes: i.takes }));
	return {
		openIssues: enriched.length,
		// `frontierCount` and `payload.frontier.length` agree (mantahostels#1289).
		frontierCount: frontier.length,
		shown: shown.length,
		/*
		 * §5's third term, and its rotted members by number (mantahostels#1626). A count,
		 * not a judgement: `<U>` says no command opens these issues as they
		 * stand, which is a band rather than a fourth disqualifier.
		 */
		noCommand: run.noCommandCount,
		rottedContainers: run.rottedContainers,
		/*
		 * As of this run, and STALE by the time §6 is written: §5 sends the
		 * reader to `node scripts/admission.js` immediately before the dispatch
		 * lines (mantahostels#1144), because an over-admission freezes the machine. Carried
		 * so the summary reports what the run decided, never so §6 is written
		 * off it.
		 */
		admit: admission.admit,
		freeSlots: admission.freeSlots,
		reclaimable: reclaimable.ok ? reclaimable.count : null,
		reclaimableUnknown: reclaimable.ok ? null : reclaimable.error,
		writeSets: {
			warm: cacheState.warm.length,
			provisional: cacheState.provisional.length,
			cold: cacheState.cold.length,
		},
		/*
		 * Each member carries what §6's line is written from: its `takes:`
		 * value, and its write-set.
		 */
		proposed: graph.proposed.map((n) => {
			const c = graph.candidates.find((/** @type {any} */ x) => x.number === n);
			/*
			 * `frontier`, never `shown`: `graph.proposed` is built over the whole
			 * frontier, so a proposed member below the `--limit` cut missed this
			 * lookup and reported `takes: []`, indistinguishable from a genuinely
			 * unlabelled issue (mantahostels#3363).
			 */
			const i = frontier.find((/** @type {any} */ x) => x.number === n);
			return {
				number: n,
				takes: i ? i.takes : [],
				writeSet: c ? c.writeSet : [],
			};
		}),
		degraded: degraded.length,
		dispatchHeld: dispatched.why
			? null
			: enriched.filter((i) => i.dispatchHeld).length,
		dispatchHeldUnknown: dispatched.why,
		labelDefects,
		debtEntries: debts.ok ? debts.count : null,
		strandedClaims: stranded.ok ? stranded.stranded : null,
		strandedClaimsCarrying: stranded.ok ? stranded.carrying : null,
	};
}

async function main() {
	const issues = await listOpenIssuesOrExit();

	const byNumber = new Map(issues.map((i) => [i.number, i]));
	const { withDeps, blockers } = await resolveBlockers(issues, byNumber);
	const openChildren = openChildrenOf(issues);

	const mapNumbers = new Set(
		issues
			.filter((i) => i.labels.includes("wayfinder:map"))
			.map((i) => i.number),
	);
	const specNumbers = new Set(
		issues.filter((i) => i.labels.includes("kind:spec")).map((i) => i.number),
	);

	const timelineByIssue = await timelinesByIssue(issues);

	/*
	 * One STRICT oracle read for the whole run: it costs ~465 ms (mantahostels#317), and
	 * the claim test below, the stranded-claims headline and the admission
	 * block's session count all need it. Undercounting a live session here
	 * risks over-admission, so the self-test that refuses on doubt stays on.
	 */
	const listed = listedSessionIds();
	const claims = claimedIssues(listed);
	const parentHeld = await parentClaims(withDeps, mapNumbers, claims, listed);
	/* One read for the whole run; the seam resolves which tree it reads. */
	const dispatched = dispatchedIssues();
	/*
	 * Read once for the whole run, for `dispatchLiveness` (mantahostels#3488) — every
	 * ALREADY DISPATCHED row's job lookup shares this one scan of the local
	 * `jobs/` stores rather than re-reading disk per row. `null` where no store
	 * could be opened at all, which `dispatchLiveness` reads as "unknown"
	 * rather than "no jobs exist".
	 */
	const dispatchJobs = readJobs();

	/** @type {EnrichContext} */
	const ctx = {
		blockers,
		timelineByIssue,
		inherit: inheritanceOf(blockers, byNumber),
		mapNumbers,
		specNumbers,
		listed,
		claims,
		parentHeld,
		dispatched,
		openChildren,
	};
	const enriched = withDeps.map((i) => enrichIssue(i, ctx));

	/*
	 * An issue whose blocked_by call failed twice is held out of the shortlist
	 * rather than assumed takeable: presenting it as ready is the one error the
	 * tool cannot recover from, since a session would claim work something else
	 * still gates.
	 *
	 * It also costs the *other* issues accuracy: a failed call leaves `blockedBy`
	 * empty, and reach is built by inverting `blockedBy`, so every edge into a
	 * degraded issue disappears and whatever blocks it loses a reach point. Every
	 * reach on a degraded run is therefore a lower bound.
	 */
	const degraded = enriched.filter((i) => i.depsUnknown);

	/*
	 * Paths over the whole frontier, not the printed slice: the skill's own
	 * invocation passes `--limit`, so pairing `shown` would hide exactly the
	 * collisions a long frontier creates. Annotated after the sort, so they
	 * can never reach the ordering.
	 */
	const tracked = readTrackedFiles();
	const frontier = annotatePaths(rankFrontier(enriched), tracked);
	const shown = LIMIT ? frontier.slice(0, LIMIT) : frontier;
	const collisions = tracked.ok ? pairwiseCollisions(frontier) : [];

	/*
	 * The in-flight set is the issues a live session is on — the arbiter claim
	 * alone (mantahostels#270, narrowed at mantahostels#645), never the assignee, so a claim recorded by a
	 * session that never assigned counts. They are excluded from the shortlist, so
	 * nothing else here ever pairs them; a candidate that shares a file with one is
	 * a candidate whose session would be writing under a live one.
	 *
	 * An assignment with no live claim is deliberately NOT in flight: this run
	 * offers that issue as takeable, so pairing it here would warn against work it
	 * is simultaneously recommending — and pairwiseCollisions already covers it.
	 */
	const inFlight = enriched.filter((i) => claims.held.has(i.number));
	const inFlightPathed = annotatePaths(inFlight, tracked);
	const inFlightCollisions = tracked.ok
		? crossCollisions(frontier, inFlightPathed, claims.held)
		: [];

	// Over the whole frontier: a queue the `--limit` cut hides is a queue the
	// band read walks into.
	const docMapQueue = docMapQueueOf(frontier);
	// Every open issue, not just the shortlist: an excluded issue's body is what
	// says whether its exclusion still holds.
	const dumped = DUMP_DIR ? dumpBodies(String(DUMP_DIR), enriched) : null;

	const { cacheUsable, cachePruned, cacheState } = writeSetCacheOf(
		frontier,
		enriched,
		tracked,
	);
	const putsSince = putsSinceLastRun(cacheUsable);
	const { bundles, graph } = conflictGraphOf(
		frontier,
		issues,
		listed,
		cacheState,
	);
	const dispatchableFloor = dispatchableFloorOf(graph, frontier, bundles);

	/*
	 * THE ACCOUNTING LINE'S THIRD TERM (mantahostels#1622, built at mantahostels#1626) — the frontier
	 * work no `/`-command opens, which the sum would otherwise force into
	 * `disqualified` though it matches none of the three named disqualifiers.
	 *
	 * Counted here rather than left to the session because both inputs are
	 * already computed per issue — the `takes:` value the TAKES column prints,
	 * and the open-child count the exclusion cascade derives — so the session
	 * copies a printed figure and the marker can pin it.
	 */
	const noCommand = frontier.filter((i) =>
		noCommandOpens(i.takes, openChildren.get(i.number) ?? 0),
	);
	/*
	 * Named by number, not merely counted: a `takes:children` issue on the
	 * frontier is mislabelled by construction. Retagging mid-selection was
	 * rejected (mantahostels#1622) — that is triage, not selection — so the band is put in
	 * front of the session every run instead, to be drained.
	 * `scripts/check-issue-labels.js` detects the same case and retires nothing.
	 */
	const rottedContainers = noCommand
		.filter((i) => i.takes.includes(CHILDREN))
		.map((i) => i.number);

	/*
	 * §4 of `.claude/skills/pick-next/SKILL.md` band-reads two things: the
	 * nominated candidates (sizes that could still change the merge test) and
	 * the cold entries (no gist yet). Where neither exists, the whole band-read
	 * stage buys nothing, and mantahostels#1485 has the session skip it outright rather than
	 * spin up subagents to confirm an empty list. Residual: `graph.mergeable`'s
	 * existing pairs (both sides already sized `small`) still merge — this only
	 * forecloses a *further* candidate acquiring a size, so a pair beyond that
	 * set can never qualify this run
	 * (`.claude/skills/pick-next/references/measured-figures.md`: 2 of 5
	 * recorded runs hit this empty case — not rare, though 5 runs cannot tell
	 * 40% from 10%, mantahostels#1485).
	 */
	const bandReadRequired =
		graph.nominated.length > 0 || cacheState.cold.length > 0;

	const warmLogged = logWarmFraction(cacheUsable, {
		frontier,
		cacheState,
		degraded,
		putsSince,
	});

	const { reclaimable, mem, procs, host, live, floorRead, memory, admission } =
		admissionOf(listed);

	/*
	 * Rides `--no-log` for the same reason the warm-fraction line does: a Stop
	 * hook must not start asking a tooling run for §5's sum. Unlike that line it
	 * runs against another repo too — the guard reads the message, not the cache.
	 *
	 * Minted here rather than beside the warm-fraction log because it carries the
	 * slot count too (mantahostels#1321), and that is not known until the admission
	 * arithmetic above has run.
	 */
	if (!NO_LOG) {
		selectionMarker.recordFromEnv(REPO_ROOT, {
			frontier: frontier.length,
			slots: admission.freeSlots,
			noCommand: noCommand.length,
		});
	}

	const debts = debtCount();
	const stranded = strandedClaimCount(listed);

	const { waitingAll, gatedAll, gatedOnAll, proseBlockedAll, parkedAll } =
		bannersOf(enriched);

	const summary = summaryOf({
		enriched,
		frontier,
		shown,
		admission,
		reclaimable,
		cacheState,
		graph,
		degraded,
		dispatched,
		debts,
		stranded,
		noCommandCount: noCommand.length,
		rottedContainers,
	});

	const state = {
		repo: String(REPO),
		argv: args,
		goal: [...goalSet],
		limit: LIMIT,
		enriched,
		frontier,
		shown,
		tracked,
		pathed: frontier,
		collisions,
		inFlightCollisions,
		docMapQueue,
		dumped,
		cachePruned,
		cacheState,
		graph,
		dispatchableFloor,
		retroBundles: retroLaunches(bundles),
		bandReadRequired,
		warmLogged,
		mem,
		procs,
		admission,
		memory,
		host,
		live,
		floorRead,
		reclaimable,
		debts,
		stranded,
		waitingAll,
		gatedAll,
		gatedOnAll,
		proseBlockedAll,
		parkedAll,
		summary,
		listed,
		claims,
		parentHeld,
		dispatched,
		dispatchJobs,
		degraded,
		noCommand: noCommand.map((i) => i.number),
		pulledIn: pulledInRows(blockers, ctx.inherit),
	};
	const payload = buildPayload(state);
	const snapshot = writeRunSnapshot(payload);

	if (asJson) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	render(state, snapshot);
}

/* `buildPayload` is a §N7 departure mantahostels#1794 ruled: it lets a ranking or admission
 * assertion run on a plain `state` object, no fake repo and no `gh` stub.
 * `main` is a second departure, mantahostels#1944's: it is the live GitHub fan-out entry
 * point, exported only so `scripts/lib/run-in-process.js`'s `runInProcessAsync`
 * can call and await it directly in `pick-next.test.ts` — requiring the module
 * never runs it, since it fires only under `require.main === module` or where
 * a caller invokes the export itself. */
module.exports = { main };

if (require.main === module) {
	main().catch((e) => {
		console.error(`FAILED: ${parseErrLine(e)}`);
		process.exit(1);
	});
}
