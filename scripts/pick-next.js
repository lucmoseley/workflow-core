#!/usr/bin/env node

const { scriptPath } = require("./lib/script-path.js");
const { buildArbiterCommand } = require("./lib/build-arbiter-command.js");
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
const { listedSessionIds } = require("./lib/agent-liveness");
const { readJobs } = require("./lib/hung-jobs");
const { buildOverloadText } = require("./lib/cpu-sample");
const { loneCommandOf, takesLabel } = require("./lib/takes-label");
const arbiter = require("./lib/arbiter-store");
const writeSetCache = require("./lib/write-set-cache");
const writeSetPredict = require("./lib/write-set-predict");
const warmFractionLog = require("./lib/warm-fraction-log");
const selectionMarker = require("./lib/selection-marker");
const idSeam = require("./lib/session-id");
const { MAP_LABEL } = require("./lib/issue-gate");
const { parentVerdictOf } = require("./lib/parent-claims");
const { URGENT_LABEL, isPassingDown } = require("./lib/urgent-label.js");
const { isInOtherRepo, parseIssueRef, refLabel } = require("./lib/issue-ref");
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
const { readState } = require("./lib/refill-state.js");
const {
	buildRowPrompt,
	unclosedLaunchOf,
} = require("./lib/unclosed-launch.js");
const { writeFd } = require("./lib/write-fd.js");
const conflictGraph = require("./lib/conflict-graph");
const strandedCount = require("./lib/stranded-count");
const {
	RETRO_BUNDLE_CAP,
	retroBundles,
	retroLaunches,
} = require("./lib/retro-bundles");
const { hostRoot } = require("./lib/host-root.js");
const { execGit } = require("./lib/git.js");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const {
	readRecentEntries: recentDispatches,
	DEFAULT_WINDOW_HOURS: DISPATCH_WINDOW_HOURS,
} = require("./lib/dispatch-ledger");
const { WAITING_LABEL } = require("./lib/frontier-order.js");
const { resolveGoal } = require("./lib/goal-set.js");
const { goalRefRepo } = require("./lib/goal-ref-repo.js");
const { buildGoalRefusal, parseGoalForm } = require("./lib/refill-goal.js");
const { snapshotFile } = require("./lib/pick-next-snapshot.js");
const {
	dispatchableFloorOf,
	noCommandOf,
	notLaunchedOf,
	notProposedLines,
	openTallyOf,
	summaryOf,
	takesCell,
} = require("./lib/pick-next-accounting.js");
const {
	bandReadRequiredOf,
	dumpBodies,
	prewarm,
} = require("./lib/pick-next-band-read.js");
const {
	annotatePaths,
	collisionBlockLines,
	collisionsOf,
} = require("./lib/pick-next-collisions.js");
const {
	dispatchAge,
	dispatchLiveness,
	dispatchLivenessCell,
	dispatchLivenessLabel,
} = require("./lib/pick-next-dispatched.js");
const {
	claimsFromStore,
	reclaimableFrom,
	storeElsewhere,
} = require("./lib/pick-next-sessions.js");
const {
	enrichAll,
	kindSetsOf,
	proseBlockedOf,
	rankFrontier,
	tiersOf,
	WAITING_STALL_DAYS,
	waitCell,
} = require("./lib/pick-next-verdict.js");

const REPO_DEFAULT = "{owner}/{repo}";
const REPO_ROOT = process.env.WFC_REPO_ROOT || hostRoot();

const { PARKED_LABEL } = require("./lib/parked.js");

const args = process.argv.slice(2);
const { flags } = parseOrExit(args, {
	usage:
		`usage: node ${scriptPath("pick-next.js")} [--goal '116,115'|'drain <ref>'|'unblock <ref>'] [--json] [--limit N] [--repo o/r]\n` +
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
/* lucmoseley/mantahostels#1289, lucmoseley/mantahostels#3363 */
const LIMIT = Number(flagValue(flags, "--limit") ?? 0) || 0;
const DUMP_DIR = flagValue(flags, "--dump-bodies");
const NO_LOG = flags["--no-log"] === true;
const NO_PREWARM = flags["--no-prewarm"] === true;
const GOAL_TEXT = String(flagValue(flags, "--goal") ?? "");
const GOAL_ASK = GOAL_TEXT === "" ? null : parseGoalForm(GOAL_TEXT);
if (GOAL_TEXT !== "" && GOAL_ASK === null) {
	writeFd(2, `${buildGoalRefusal(GOAL_TEXT)}\n`);
	process.exit(2);
}
/** @type {Set<number>} */
const goalRanked = new Set();

/** @param {string} path */
async function ghGet(path) {
	return ghApiSlurpAsync([path]);
}

/** @typedef {import("./lib/pick-next-verdict.js").RawIssue} RawIssue */
/** @typedef {import("./lib/pick-next-verdict.js").Enriching} Enriching */
/** @typedef {import("./lib/pick-next-verdict.js").DepsResolved} DepsResolved */
/** @typedef {import("./lib/pick-next-verdict.js").Issue} Issue */

/** @typedef {import("./lib/pick-next-collisions.js").Pathed} Pathed */

/**
 * @param {Issue} i
 * @returns {i is Issue & {gate: NonNullable<Issue["gate"]>}}
 */
function hasGate(i) {
	return i.gate !== null;
}
/**
 * @param {Issue} i
 * @returns {i is Issue & {gateOn: NonNullable<Issue["gateOn"]>}}
 */
function hasGateOn(i) {
	return i.gateOn !== null;
}
/**
 * @param {Issue} i
 * @returns {i is Issue & {wait: NonNullable<Issue["wait"]>}}
 */
function hasWait(i) {
	return i.wait !== null;
}
/**
 * @param {Issue} i
 * @returns {i is Issue & {parked: NonNullable<Issue["parked"]>}}
 */
function hasParked(i) {
	return i.parked !== null;
}

/** @typedef {{ok: true, files: string[]} | {ok: false, error: string}} TrackedFiles */

/** @typedef {import("./lib/pick-next-band-read.js").CacheEntry} CacheEntry */

/** @typedef {import("./lib/agent-liveness.js").ListedSessions} ListedSessions */

/** @param {{number: number, title: string, body: string}[]} frontier */
const emptyBodiedOf = (frontier) =>
	frontier
		.filter((i) => !i.body.trim())
		.map((i) => ({ number: i.number, title: i.title }));

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
				...edgeOf(i, listRepo()),
				createdAt: i.created_at,
				assignees: (i.assignees || []).map((/** @type {any} */ a) => a.login),
				parent: i.parent_issue_url,
				openSubIssues:
					(i.sub_issues_summary?.total ?? 0) -
					(i.sub_issues_summary?.completed ?? 0),
			}))
	);
}

/**
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
 * @param {import("./lib/issue-ref").IssueRef} ref
 * @returns {Promise<import("./lib/blocker-graph").EdgesRead>}
 */
async function readSubIssuesOf(ref) {
	const r = await ghGetRetrying(
		`repos/${REPO}/issues/${ref.number}/sub_issues?per_page=100`,
		{ strict: true },
	);
	if (!r.ok) return r;
	return { ok: true, edges: r.out.map((i) => edgeOf(i, ref.repo)) };
}

/**
 * @param {number} n
 * @returns {Promise<{ok: true, events: any[]} | {ok: false, error: string}>}
 */
async function readTimelineOf(n) {
	const r = await ghGetRetrying(
		`repos/${REPO}/issues/${n}/timeline?per_page=100`,
	);
	return r.ok ? { ok: true, events: r.out } : { ok: false, error: r.error };
}

const RETRO_LABEL = takesLabel("triage");

/** @param {Issue} issue */
const waitDays = (issue) =>
	issue.wait && !issue.wait.unknown ? issue.wait.ageDays : null;

/** @param {Issue} issue */
const parkedDays = (issue) =>
	issue.parked && !issue.parked.unknown
		? issue.parked.ageDays
		: Number.POSITIVE_INFINITY;

/** @type {TrackedFiles|undefined} */
let trackedCache;
function readTrackedFiles() {
	if (trackedCache) return trackedCache;
	/** @type {TrackedFiles} */
	let read;
	try {
		// lucmoseley/mantahostels#148
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

const DOC_MAP_HINT = writeSetPredict.DOC_MAP_HINT;
/** @param {any[]} list */
const docMapQueueOf = (list) =>
	list.filter((i) => DOC_MAP_HINT.test(i.body)).map((i) => i.number);

const GRAPH_PRINT_CAP = 20;
const GRAPH_FILE_CAP = 8;
/** @param {string} s */
const sessionName = (s) =>
	String(s).length > 34 ? `${String(s).slice(0, 33)}…` : String(s);

const WRITE_SET_PRINT_CAP = 20;
const DERIVE_PER_LINE = 12;

/**
 * @param {number} total
 * @param {string} label
 */
const printOverflow = (total, label) => {
	if (total > WRITE_SET_PRINT_CAP)
		writeFd(
			1,
			`  ... and ${total - WRITE_SET_PRINT_CAP} more ${label} — --json carries every one.\n`,
		);
};

/** @param {CacheEntry} w */
const cacheEntryJson = (w) => ({
	number: w.number,
	writeSet: w.writeSet,
	sizeBand: w.sizeBand,
	predictedSize: w.predictedSize ?? null,
	gist: w.gist,
	derivedAt: w.derivedAt,
	provisional: w.provisional === true,
	replaced: w.replaced ?? null,
	unrevalidated: w.unrevalidated === true,
});

/**
 * @param {string[]} items
 * @param {number} n
 */
function chunk(items, n) {
	const rows = [];
	for (let i = 0; i < items.length; i += n)
		rows.push(items.slice(i, i + n).join(" "));
	return rows;
}

const {
	selectionAdmission,
	buildSessionDrawLine,
	buildLiveDrawLine,
	buildMemoryBreakdownLines,
	buildSessionCeilingText,
} = require("./lib/admission");
const { readReserves } = require("./lib/admission-reserves.js");
/** @typedef {ReturnType<typeof selectionAdmission>} Machine */

/**
 * @param {ListedSessions} listed
 * @returns {{held: Map<number, any>, kept: boolean, why: string|null, claimsTree?: string|null}}
 */
function claimedIssues(listed) {
	try {
		const elsewhere = storeElsewhere(REPO_ROOT, arbiter.paths.repoRoot());
		return claimsFromStore(arbiter.heldIssues(listed), elsewhere);
	} catch (e) {
		return {
			held: new Map(),
			kept: false,
			why: parseErrLine(e),
			claimsTree: null,
		};
	}
}

/** @typedef {import("./lib/dispatch-ledger").DispatchRecord} DispatchRecord */

/** @returns {{byIssue: Map<number, DispatchRecord[]>, why: string|null}} */
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

/** @param {ListedSessions} listed */
function strandedClaimCount(listed) {
	const { found } = strandedCount.readDirtyWorktrees();
	return strandedCount.countStranded(arbiter.readLocks(), listed.ids, {
		dirty: strandedCount.readDirtyPaths(),
		terminal: listed.terminal,
		found,
		attributed: strandedCount.attributeWorktreeDirt(found, listed),
	});
}

/** @param {unknown} payload */
function writeRunSnapshot(payload) {
	const file = snapshotFile(REPO_ROOT);
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
 * @property {import("./lib/refill-goal.js").ShortlistGoal|null} goalSet
 * @property {string|null} ownRepo
 * @property {number[]} running
 * @property {number} limit
 * @property {Issue[]} enriched
 * @property {Issue[]} frontier
 * @property {Issue[]} shown
 * @property {TrackedFiles} tracked
 * @property {Pathed[]} pathed
 * @property {ReturnType<typeof collisionsOf>["collisions"]} collisions
 * @property {ReturnType<typeof collisionsOf>["inFlightCollisions"]} inFlightCollisions
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
 * @property {Machine["admission"]} admission
 * @property {Machine["memory"]} memory
 * @property {Machine["host"]} host
 * @property {Machine["live"]} live
 * @property {ReturnType<typeof reclaimableFrom>} reclaimable
 * @property {ReturnType<typeof strandedClaimCount>} stranded
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

const TALLY_NAMES_AT_MOST = 3;

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
	const { stranded } = state;
	return {
		strandedClaims: stranded.ok ? stranded.stranded : null,
		strandedClaimsUnknown: stranded.ok ? null : stranded.error,
		strandedClaimsCarrying: stranded.ok ? stranded.carrying : null,
		strandedWorktrees: stranded.ok ? stranded.strandedWorktrees : null,
		strandedClaimsCarryingUnknown:
			stranded.ok && stranded.carrying === null
				? "git would not report which files carry uncommitted work"
				: null,
	};
}

/** @param {State["gatedAll"]} gatedAll */
function gatedJson(gatedAll) {
	return gatedAll.filter(hasGate).map((i) => ({
		number: i.number,
		title: i.title,
		until: i.gate.iso || null,
		daysLeft: i.gate.daysLeft ?? null,
		reason: i.gate.reason,
		active: i.gateHolds,
		malformed: i.gate.malformed ? i.gate.raw : null,
		bothMarkers: i.gateConflict,
	}));
}

/**
 * lucmoseley/mantahostels#1419
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
		createdAt: i.createdAt,
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
		closes: i.closes,
		reach: i.reach,
		collision: i.collision ? "writes repo files" : "comment-only",
		takes: i.takes,
		pathsNamed: i.paths,
		group: i.group,
		labels: i.labels,
		parkedAt: i.parked && !i.parked.unknown ? i.parked.appliedAt : null,
	};
}

/**
 * @template {{number: number, takes: string[]}} R
 * @param {R[]} rows
 */
function withLaunchPrompt(rows) {
	const { launches } = readState((line) => writeFd(2, `pick-next: ${line}\n`));
	const root = arbiter.paths.repoRoot();
	return rows.map((row) => {
		const l = unclosedLaunchOf(launches, root, row.number);
		return {
			...row,
			unclosedLaunch: l && {
				launchedAt: new Date(l.launchedAt).toISOString(),
				sessionId: l.sessionId ?? null,
				acts: l.acts,
			},
			prompt:
				loneCommandOf(row.takes) === null
					? null
					: buildRowPrompt({ ...row, root }, launches),
		};
	});
}

/** @param {State} state */
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
					liveness: dispatchLivenessLabel(liveness),
					livenessWhy: liveness.why ?? null,
				};
			}),
	};
}

/** @param {State} state */
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
	const frontierRows = withLaunchPrompt(pathed.map(frontierJson));
	return {
		generatedAt: new Date().toISOString(),
		summary: {
			...summary,
			proposed: summary.proposed.map((/** @type {{number: number}} */ p) => ({
				...p,
				prompt: frontierRows.find((f) => f.number === p.number)?.prompt ?? null,
			})),
		},
		repo,
		argv,
		openIssues: enriched.length,
		/* lucmoseley/mantahostels#1289, lucmoseley/mantahostels#844 */
		frontierCount: frontier.length,
		emptyBody: emptyBodiedOf(frontier),
		admission: admissionJson(state),
		/* #590 */
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
		proseBlocked: proseBlockedAll.map((i) => ({
			number: i.number,
			title: i.title,
			named: i.proseBlocked.named,
			open: i.proseBlocked.open,
			closed: i.proseBlocked.closed,
			unreadable: i.proseBlocked.unreadable,
			unparsed: i.proseBlocked.unparsed,
		})),
		waiting: waitingAll.map(waitingJson),
		parked: parkedAll.map(parkedJson),
		frontier: frontierRows,
		pulledIn: state.pulledIn.rows,
		pulledInUnread: state.pulledIn.unread,
		ownRepo: state.ownRepo,
		goalSet: state.goalSet,
		running: state.running,
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
		parentClaimsUnread: parentHeld.unread,
		possibleCollisions: collisions,
		inFlightCollisions,
		docMapQueue,
		conflictGraph: graph,
		retroBundles: launches,
		dispatchableFloor,
		bandReadRequired,
		writeSetCache: {
			dir: writeSetCache.CACHE_SUBDIR,
			warm: cacheState.warm.map(cacheEntryJson),
			// lucmoseley/mantahostels#1001
			provisional: cacheState.provisional.map(cacheEntryJson),
			cold: cacheState.cold,
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
	const {
		enriched,
		frontier,
		limit,
		degraded,
		goalSet: asked,
		ownRepo,
	} = state;
	writeFd(
		1,
		`\nOPEN ISSUES: ${enriched.length}   TAKEABLE NOW: ${frontier.length}${
			limit && frontier.length > limit ? `   (showing ${limit})` : ""
		}${degraded.length > 0 ? `   (${degraded.length} unread, see DEGRADED)` : ""}\n`,
	);
	if (asked !== null)
		writeFd(
			1,
			`GOAL SET (${asked.members.length}): ${asked.members.map((m) => refLabel(m, ownRepo)).join(", ") || "none open"}\n`,
		);
}

/** @param {State["admission"]} admission */
function printCpuLimb(admission) {
	const load = admission.load;
	if (load.overloaded)
		writeFd(
			1,
			`  cpu load           ${buildOverloadText(load)} — dispatch refuses each launch until it falls\n`,
		);
	/* lucmoseley/mantahostels#1206 */ else if (load.load1 === null)
		writeFd(
			1,
			"  cpu load           unknown — /proc/loadavg unreadable, so no launch is held on load\n",
		);
	if (admission.cpu.full)
		writeFd(
			1,
			`  cpu sessions       ${buildSessionCeilingText(admission.cpu)} — dispatch refuses each launch until one ends\n`,
		);
}

/** @param {State["reclaimable"]} reclaimable */
function printReclaimable(reclaimable) {
	/* lucmoseley/mantahostels#1237, lucmoseley/mantahostels#1206 */
	if (!reclaimable.ok)
		writeFd(
			1,
			`  reclaimable        unknown (${reclaimable.error}) — some of the memory counted spent above may already be free\n`,
		);
	else if (reclaimable.count > 0)
		writeFd(
			1,
			`  reclaimable        ${reclaimable.count} finished session${
				reclaimable.count === 1 ? "" : "s"
			} still resident, holding memory counted as spent above` +
				"\n                     `node " +
				scriptPath("reap-finished-sessions.js") +
				"` stops those past its grace window now and reports the MB returned; the next session start does it anyway\n",
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
		dispatchableFloor,
	} = state;
	writeFd(1, "\nADMISSION — measured headroom, not a fixed slot count\n\n");
	writeFd(
		1,
		`  available memory   ${mem.ok ? `${mem.mb} MB` : `unknown (${mem.error})`}\n`,
	);
	writeFd(
		1,
		`  live sessions      ${
			procs.ok
				? `${procs.sessions} alongside this one`
				: `unknown (${procs.error})`
		}${
			procs.processes === null
				? ` (process count unavailable: ${procs.processesError})`
				: ` (${procs.processes} claude processes, which include orphans)`
		}\n`,
	);
	printCpuLimb(admission);
	printReclaimable(reclaimable);
	writeFd(1, `  session draw       ${buildSessionDrawLine(host)}\n`);
	writeFd(1, `  live draw          ${buildLiveDrawLine(live)}\n`);
	writeFd(
		1,
		`  free slots         ${admission.freeSlots === null ? "unknown" : admission.freeSlots}\n`,
	);
	writeFd(1, `  DISPATCHABLE FLOOR: ${dispatchableFloor}\n`);
	writeFd(
		1,
		`\n  ${admission.admit ? "START ONE NOW" : "HOLD"} — ${admission.reason}.\n`,
	);
	writeFd(
		1,
		`\n${buildMemoryBreakdownLines(memory)
			.map((l) => `  ${l}`)
			.join("\n")}\n`,
	);
	writeFd(1, "\n");
}

/** @param {State} state */
function renderOwedWork(state) {
	const { stranded } = state;
	writeFd(1, "OWED WORK — report only, never a filter or a sort input\n\n");
	writeFd(
		1,
		`  stranded claims    ${
			stranded.ok
				? `${stranded.stranded}, ${stranded.carrying ?? "unknown how many"} carrying uncommitted work; ${stranded.strandedWorktrees ?? "unknown how many (a job store would not read)"} finished session worktree(s) carrying it`
				: `unknown (${stranded.error})`
		}  — node ${scriptPath("check-stranded-file-claims.js")}\n`,
	);
	writeFd(1, "\n");
}

/** @param {Issue} i */
function urgentCell(i) {
	if (i.bug) return "bug";
	if (i.labels.includes(URGENT_LABEL)) return "yes";
	return i.urgentVia ? "via" : "";
}

/** @param {Issue} i */
function goalCell(i) {
	if (goalRanked.has(i.number)) return "yes";
	return i.goal ? "via" : "";
}

/** @param {State} state */
function renderShortlist(state) {
	const { shown } = state;
	const header = `${pad("#", 6)}${pad("URG", 5)}${pad("GOAL", 6)}${pad("WAIT", 6)}${pad("DEPTH", 7)}${pad("CLOSES", 8)}${pad("REACH", 7)}${pad("COLL", 6)}${pad("GROUP", 16)}${pad("TAKES", 12)}`;
	writeFd(1, `${header}TITLE\n`);
	writeFd(1, `${"-".repeat(header.length + 42)}\n`);
	for (const i of shown)
		writeFd(
			1,
			`${pad(`#${i.number}`, 6)}${pad(urgentCell(i), 5)}${pad(
				goalCell(i),
				6,
			)}${pad(waitCell(i), 6)}${pad(i.depth, 7)}${pad(i.closes, 8)}${pad(i.reach, 7)}${pad(
				i.collision ? "w" : "-",
				6,
			)}${pad(i.group, 16)}${pad(takesCell(i.takes), 12)}${String(i.title).slice(0, 42)}\n`,
		);
}

/** @param {State} state */
function renderCollisions(state) {
	for (const line of collisionBlockLines(state)) writeFd(1, `${line}\n`);
}

/** @param {State} state */
function renderDocMapQueue(state) {
	const { docMapQueue } = state;
	if (docMapQueue.length > 0)
		writeFd(
			1,
			`\nDOC-MAP QUEUE (${docMapQueue.length}) — bodies naming a §B entry, so they` +
				" likely write\n`docs/doc-map.md` at the END of their run. That is a STAMP," +
				" not a substrate:\nsharing it disqualifies nobody (mantahostels#422): a write there to a" +
				" file a neighbour\nholds goes ahead with a merge-conflict warning (#4249). Read down to" +
				" the admission\nfigure, never just the top:\n" +
				`  ${docMapQueue.map((n) => `#${n}`).join(", ")}\n` +
				"Advisory: nothing is refused on a prediction.\n",
		);
}

/** @param {State} state */
function renderRetroBundles(state) {
	const { retroBundles: launches } = state;
	if (launches.length > 0) {
		writeFd(
			1,
			`\nRETRO TRIAGE BUNDLES (${launches.length}) — retro-sweep findings, at most ${RETRO_BUNDLE_CAP} to a\n` +
				"session (#1105). Each is one §6 line and one §7 prompt; no file disqualifies a member:\n",
		);
		for (const b of launches)
			writeFd(
				1,
				`  **${b.issues.join(", ")}** - ${RETRO_LABEL} · ${b.model}    → "${b.prompt}"\n`,
			);
	}
}

/** @param {State["graph"]} graph */
function printGraphInFlight(graph) {
	if (graph.inFlight.length > 0) {
		writeFd(1, "\n  ruled out by a running session:\n");
		for (const r of graph.inFlight.slice(0, GRAPH_PRINT_CAP))
			writeFd(
				1,
				`    #${r.candidate} — ${sessionName(r.session)} holds ${r.paths.join(", ")}\n`,
			);
		if (graph.inFlight.length > GRAPH_PRINT_CAP)
			writeFd(
				1,
				`    ... and ${graph.inFlight.length - GRAPH_PRINT_CAP} more — --json carries every one.\n`,
			);
	}
}

/** @param {State["graph"]} graph */
function printGraphConflicts(graph) {
	if (graph.conflicts.length > 0) {
		writeFd(
			1,
			`\n  ${graph.conflicts.length} candidate pair${graph.conflicts.length === 1 ? " names" : "s name"} one file, by file:\n`,
		);
		for (const f of graph.conflictsByFile.slice(0, GRAPH_FILE_CAP))
			writeFd(
				1,
				`    ${f.path} — ${f.pairs} pair${f.pairs === 1 ? "" : "s"}\n`,
			);
		if (graph.conflictsByFile.length > GRAPH_FILE_CAP)
			writeFd(
				1,
				`    ... and ${graph.conflictsByFile.length - GRAPH_FILE_CAP} more files — --json carries every one.\n`,
			);
		writeFd(1, "  the pairs themselves:\n");
		for (const c of graph.conflicts.slice(0, GRAPH_PRINT_CAP))
			writeFd(1, `    #${c.a} <-> #${c.b} on ${c.paths.join(", ")}\n`);
		if (graph.conflicts.length > GRAPH_PRINT_CAP)
			writeFd(
				1,
				`    ... and ${graph.conflicts.length - GRAPH_PRINT_CAP} more pairs — --json carries every one.\n`,
			);
	}
}

/** @param {State["graph"]} graph */
function printGraphStamps(graph) {
	if (graph.stampSharing.pairs)
		writeFd(
			1,
			`\n  ${graph.stampSharing.pairs} pair${graph.stampSharing.pairs === 1 ? " shares" : "s share"} only ${graph.stampSharing.paths.join(", ")} — a STAMP, so they run\n` +
				"  together and none is a conflict.\n",
		);
	if (graph.stampQueued.length > 0)
		writeFd(
			1,
			`  ${graph.stampQueued.length} candidate${graph.stampQueued.length === 1 ? " queues" : "s queue"} behind a held stamp — designed, not a conflict.\n`,
		);
}

/** @param {State["graph"]} graph */
function printGraphMergeable(graph) {
	if (graph.mergeable.length > 0) {
		writeFd(
			1,
			"\n  merge-test pairs — same file and both sized small, which is TWO of the\n" +
				"  three limbs (mantahostels#503). The third, disjoint edit targets (§B15 vs §B17), is\n" +
				"  yours from the band read:\n",
		);
		for (const m of graph.mergeable.slice(0, GRAPH_PRINT_CAP))
			writeFd(1, `    #${m.a} + #${m.b} on ${m.paths.join(", ")}\n`);
		if (graph.mergeable.length > GRAPH_PRINT_CAP)
			writeFd(
				1,
				`    ... and ${graph.mergeable.length - GRAPH_PRINT_CAP} more — --json carries every one.\n`,
			);
	}
}

/** @param {State["graph"]} graph */
function printGraphNominations(graph) {
	if (graph.candidates.length > 0) {
		writeFd(
			1,
			`\n  BAND-READ NOMINATIONS (${graph.nominated.length}) — §4 derives a SIZE for these and no\n` +
				"  others (mantahostels#1484); it still reads the whole tie band to order it. Each has no\n" +
				"  size and shares a non-stamp path with another candidate, so it is the only\n" +
				"  kind whose size can still change the merge test above. Refuse and reorder\n" +
				"  nothing on it (mantahostels#588).\n",
		);
		for (const n of graph.nominated.slice(0, GRAPH_PRINT_CAP))
			writeFd(
				1,
				`    #${n.number} on ${n.paths.join(", ")} — with ${n.with.map((/** @type {number} */ w) => `#${w}`).join(", ")}\n`,
			);
		if (graph.nominated.length > GRAPH_PRINT_CAP)
			writeFd(
				1,
				`    ... and ${graph.nominated.length - GRAPH_PRINT_CAP} more — --json carries every one.\n`,
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
		writeFd(
			1,
			`${
				`\n  ${bodySourced + grepSourced} of ${graph.candidates.length} write-sets above are the body's backticked\n` +
				"  paths rather than a band read's — the floor, not a judgement" +
				(
					grepSourced
						? `\n  (${grepSourced} PROVISIONAL, so absent from the merge test above).`
						: "."
				) +
				(unrevalidated
					? ` ${unrevalidated} warm\n  entr${unrevalidated === 1 ? "y is" : "ies are"} unrevalidated (git could not list the tree).`
					: "")
			}\n`,
		);
}

/** @param {State["graph"]} graph */
function printProposedSet(graph) {
	writeFd(
		1,
		`\n  PROPOSED DISJOINT SET (${graph.proposed.length}) — greedy down the ranking above:\n` +
			`    ${graph.proposed.length > 0 ? graph.proposed.map((/** @type {number} */ n) => `#${n}`).join(", ") : "empty"}\n`,
	);
	const inFlightOf = new Map(
		graph.inFlight.map((/** @type {any} */ r) => [r.candidate, r]),
	);
	for (const d of graph.dropped.slice(0, GRAPH_PRINT_CAP)) {
		const r = inFlightOf.get(d.number);
		writeFd(
			1,
			`    not in it: #${d.number} — ${
				r ? `${sessionName(r.session)} holds ${r.paths.join(", ")}` : d.why
			}\n`,
		);
	}
	if (graph.dropped.length > GRAPH_PRINT_CAP)
		writeFd(
			1,
			`    ... and ${graph.dropped.length - GRAPH_PRINT_CAP} more left out — --json carries every one.\n`,
		);
}

/** @param {State} state */
function renderConflictGraph(state) {
	const { graph, bandReadRequired } = state;
	writeFd(
		1,
		"\nSUBSTRATE-CONFLICT GRAPH — which candidates cannot run alongside which,\n" +
			"and on which file. Advisory: naming one file is NOT a substrate call —\n" +
			"whether the work lives there or merely stamps it at the end is yours\n" +
			"(pick-next SKILL.md §5). Nothing here is refused; the set below is a\n" +
			"candidate for that test, never its verdict.\n",
	);
	printGraphInFlight(graph);
	printGraphConflicts(graph);
	printGraphStamps(graph);
	printGraphMergeable(graph);
	printGraphNominations(graph);
	writeFd(
		1,
		`${
			bandReadRequired
				? "\n  BAND READ REQUIRED THIS RUN — nominated (above) and/or cold (see WRITE-SET\n" +
					"  CACHE below) entries are non-empty."
				: "\n  NO BAND READ REQUIRED THIS RUN (mantahostels#1485) — nothing nominated, nothing cold.\n" +
					"  §4's band-read stage is skipped outright: accept the provisional\n" +
					"  write-sets as given and go straight to §5 — any merge-test pairs above\n" +
					"  still merge on their already-known sizes; skipping only means no further\n" +
					"  candidate can acquire one."
		}\n`,
	);
	printWriteSetSources(graph);
	if (graph.noWriteSet.length > 0)
		writeFd(
			1,
			`\n  no write-set predicted, so absent from every line above (${graph.noWriteSet.length}):\n` +
				`    ${chunk(
					graph.noWriteSet.map((/** @type {number} */ n) => `#${n}`),
					DERIVE_PER_LINE,
				).join("\n    ")}\n`,
		);
	printProposedSet(graph);
	if (graph.heldDegraded)
		writeFd(
			1,
			`\n  CLAIMS DEGRADED — ${graph.heldDegraded.why}.\n  ${
				graph.heldDegraded.kept
					? "Every claim was kept rather than dropped on a partial read, so a file\n  named above may be free."
					: "No file claim was read, so a candidate a live session is writing may sit\n  in the proposed set."
			}\n`,
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
		writeFd(
			1,
			`\nWRITE-SET CACHE (${writeSetCache.CACHE_SUBDIR}) — ${cacheState.warm.length} warm, ` +
				`${cacheState.provisional.length} provisional, ${cacheState.cold.length} to derive` +
				(cachePruned.removed.length > 0
					? `, ${cachePruned.removed.length} pruned`
					: "") +
				"\nA PROVISIONAL row is this run's own grep over the body (mantahostels#1001), never an\n" +
				"agent's judgement. Band-read one where you need its size; refuse nothing\n" +
				"on one (mantahostels#588).\n\n",
		);
		for (const w of cacheState.warm.slice(0, WRITE_SET_PRINT_CAP))
			writeFd(1, `${warmRow(w)}\n`);
		printOverflow(cacheState.warm.length, "warm");
		for (const w of cacheState.provisional.slice(0, WRITE_SET_PRINT_CAP))
			writeFd(1, `${provisionalRow(w)}\n`);
		printOverflow(cacheState.provisional.length, "provisional");
		if (cacheState.cold.length > 0)
			writeFd(
				1,
				`  derive ${chunk(
					cacheState.cold.map((/** @type {any} */ c) => `#${c.number}`),
					DERIVE_PER_LINE,
				).join("\n         ")}\n` +
					`  Store each back: node ${scriptPath("pick-next-cache.js")} put <n> --body-hash <hex>\n` +
					"  --json carries each hash; --dump-bodies writes it into the dumped file.\n",
			);
		for (const sk of cacheState.skipped.slice(0, WRITE_SET_PRINT_CAP))
			writeFd(1, `  not predicted: #${sk.number} — ${sk.why}\n`);
		printOverflow(cacheState.skipped.length, "not predicted");
	}
}

/** @param {State} state */
function renderWarmLogged(state) {
	const { warmLogged } = state;
	if (warmLogged?.ok === false)
		writeFd(
			1,
			`\nThis run went unrecorded for mantahostels#628's warm fraction: ${warmLogged.error}\n`,
		);
}

/** @param {State} state */
function renderDumped(state) {
	const { dumped } = state;
	if (dumped)
		writeFd(
			1,
			`${
				dumped.ok
					? `\nBODIES DUMPED — ${dumped.count} to ${dumped.dir}, from the list call already made.\nRead the band read's bodies from there, never with \`gh issue view\`.`
					: `\nBODIES — could not dump to ${dumped.dir}: ${dumped.error}\n  The shortlist above is unaffected.`
			}\n`,
		);
}

/** @param {Issue} i */
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
 * @param {string} tier
 * @param {import("./lib/blocker-graph").Via} via
 */
const viaText = (tier, via) =>
	`${tier} via ${via.path.at(-1)} (holds ${via.path.join(" → ")})`;

/** @param {State} state */
function renderUrgent(state) {
	const { enriched } = state;
	const urgentShown = enriched.filter((i) => i.urgent);
	if (urgentShown.length > 0) {
		writeFd(
			1,
			"\nURGENT (holds until the issue closes or the label comes off)\n\n",
		);
		for (const i of urgentShown)
			writeFd(1, `  #${i.number}  ${urgencySources(i).join("; ")}\n`);
	}
}

/** @param {State} state */
function renderWaiting(state) {
	const { waitingAll } = state;
	if (waitingAll.length > 0) {
		writeFd(
			1,
			`\nWAITING ON SOMEONE OUTSIDE THE PROJECT — ranked up from ${WAITING_STALL_DAYS}d, never down\n\n`,
		);
		for (const i of waitingAll) {
			const age = i.wait.unknown
				? `age unknown (${i.wait.error}) — rank untouched`
				: `${Math.floor(i.wait.ageDays)}d, since ${i.wait.appliedAt} by ${i.wait.appliedBy}${
						i.wait.stalled ? " — STALLED, ranked up" : ""
					}`;
			writeFd(
				1,
				`  #${i.number}  ${age}${i.excluded ? `\n    not in the shortlist: ${i.excluded} — chase it anyway` : ""}\n`,
			);
		}
		writeFd(
			1,
			"\n  The label goes on by hand at the moment the work is handed off, and\n" +
				"  comes off by hand when it lands.\n",
		);
	}
}

/** @param {State} state */
function renderParked(state) {
	const { parkedAll } = state;
	if (parkedAll.length === 0) return;
	writeFd(
		1,
		"\nPARKED — a question round, or a session the refill loop stopped, waits on the founder\n\n",
	);
	for (const i of parkedAll) {
		const age = i.parked.unknown
			? `age unknown (${i.parked.error})`
			: `${Math.floor(i.parked.ageDays)}d, since ${i.parked.appliedAt}`;
		writeFd(1, `  #${i.number}  ${age}  ${String(i.title).slice(0, 50)}\n`);
	}
	writeFd(
		1,
		"\n  Choosable here. An away-mode refill loop skips it; a normal-mode one resumes" +
			"\n  it ahead of new work, oldest park first." +
			"\n  A loop-stopped park's cause is commented on its ticket. Cleared when the\n" +
			"  founder types in the parked session, or a session claims the issue.\n",
	);
}

/** @param {State["gatedAll"][number]} i */
function printGatedRow(i) {
	if (i.gateConflict) {
		writeFd(
			1,
			`  #${i.number}  TWO GATE LINES, a date and a condition — GATING NOTHING, in the batch as normal; delete one\n`,
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
		writeFd(1, `${line}\n`);
		return;
	}
	const gateOn = i.gateOn;
	if (!gateOn) return;
	writeFd(
		1,
		`${
			gateOn.malformed
				? `  #${i.number}  MALFORMED GATE (${gateOn.reason}) \`${gateOn.raw}\` — GATING NOTHING, in the batch as normal`
				: `  #${i.number}  held on ${gateOn.condition} — check: ${gateOn.command || "none stated"} — abandon if: ${gateOn.abandonIf}`
		}\n`,
	);
}

/** @param {State} state */
function renderGated(state) {
	const { gatedAll } = state;
	if (gatedAll.length > 0) {
		writeFd(
			1,
			"\nGATED BY A LINE IN THE BODY — `**Gated until:** YYYY-MM-DD — why`, or\n" +
				"`**Gated on:** <condition> — check: <command> — abandon if: <clause>`\n\n",
		);
		for (const i of gatedAll) {
			printGatedRow(i);
		}
		writeFd(1, "\n  Move the date or delete the line; nothing expires it.\n");
		writeFd(
			1,
			"  The `check:` on a condition gate is yours to run and judge: run\n" +
				"  `check-gates.js --issue <n>`, and on met comment the evidence and strip\n" +
				"  the marker. The refill loop also sweeps them, launching `/triage <n>`\n" +
				"  on a changed reading. `abandon if:` alone retires one unmet.\n",
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
		writeFd(
			1,
			`${
				`  #${i.number}  names ${named.join(", ")} — ` +
				(verdicts.length > 0
					? verdicts.join("; ")
					: "every named issue is closed, resolved")
			}\n`,
		);
	for (const raw of i.proseBlocked.unparsed)
		writeFd(
			1,
			`  #${i.number}  NAMES NO ISSUE NUMBER — read it before dispatching:\n` +
				`           ${raw.length > 160 ? `${raw.slice(0, 157)}...` : raw}\n`,
		);
}

/** @param {State} state */
function renderProseBlocked(state) {
	const { proseBlockedAll } = state;
	if (proseBlockedAll.length > 0) {
		writeFd(
			1,
			"\nPROSE SELF-GATES — `**Blocked on** #<n>` in the body, this repo's resolved\n" +
				"against the open list this run already fetched (mantahostels#1289). Folded into\n" +
				"`blocked by` above where still open or unreadable; a closed one in this\n" +
				"repo needed no read.\n\n",
		);
		for (const i of proseBlockedAll) {
			printProseBlockedRow(i);
		}
	}
}

/** @param {{bug: boolean, urgent: boolean, goal: boolean, depth: number}} r */
function pulledTiers(r) {
	const tiers = [
		r.bug ? "bug" : "",
		r.urgent && !r.bug ? "urgent" : "",
		r.goal ? "goal" : "",
		r.depth > 0 ? `depth ${r.depth}` : "",
	].filter(Boolean);
	return tiers.length > 0 ? `${tiers.join(" ")}  ` : "";
}

const PULLED_TITLE_CHARS = 80 - 11;

/** @param {State} state */
function renderPulledIn(state) {
	const { rows, unread } = state.pulledIn;
	if (rows.length === 0 && unread.length === 0) return;
	writeFd(
		1,
		"\nPULLED IN FROM OTHER REPOS — open, unblocked, and holding an issue here out\n" +
			"through the blocked-by chain; launched from its own checkout (#2427)\n\n",
	);
	for (const r of rows)
		writeFd(
			1,
			`  ${r.repo}#${r.number}  ${pulledTiers(r)}reach ${r.reach}  holds ${r.holds.join(", ")}` +
				`${r.held ? `  HELD OUTSIDE THE LOOP: ${r.held}` : ""}\n           ${String(r.title).slice(0, PULLED_TITLE_CHARS)}\n`,
		);
	for (const u of unread)
		writeFd(
			1,
			`  ${u.ref}  blockers unread, not offered: ${u.error}\n           holds ${u.holds.join(", ")}\n`,
		);
}

/** @param {State} state */
function renderEmptyBody(state) {
	const { frontier } = state;
	const emptyBodied = emptyBodiedOf(frontier);
	if (emptyBodied.length > 0) {
		writeFd(
			1,
			"\nEMPTY BODY — on the frontier with nothing to work from; most likely a failed\ncreate, so check for a duplicate before taking it (mantahostels#3443)\n\n",
		);
		for (const i of emptyBodied) writeFd(1, `  #${i.number}  ${i.title}\n`);
	}
}

/** @param {State} state */
function renderDegraded(state) {
	const { degraded, repo } = state;
	if (degraded.length > 0) {
		writeFd(
			1,
			`\nDEGRADED (${degraded.length}) — readiness unknown, held out of the shortlist\n\n`,
		);
		const { expanded, collapsed } = groupByRepeatedError(degraded, (i) =>
			String(i.depsUnknown),
		);
		for (const i of expanded)
			writeFd(
				1,
				`  #${i.number}  ${String(i.title).slice(0, 60)}\n    ${i.depsUnknown}\n`,
			);
		for (const g of collapsed) writeFd(1, `${buildCollapsedFailureLine(g)}\n`);
		writeFd(
			1,
			"\n  These may or may not be takeable, and every REACH above is a lower\n" +
				"  bound: edges into a degraded issue are invisible, so whatever blocks\n" +
				"  one is under-ranked. Check by hand before concluding the shortlist is\n" +
				"  the whole frontier, or that its order is right:\n" +
				`    gh api repos/${repo}/issues/<n>/dependencies/blocked_by\n`,
		);
	}
}

/** @param {State} state */
function renderAssignedUnclaimed(state) {
	const { enriched } = state;
	const assignedUnclaimed = enriched.filter((i) => i.assignedUnclaimed);
	if (assignedUnclaimed.length > 0) {
		writeFd(
			1,
			`\nASSIGNED BUT UNCLAIMED (${assignedUnclaimed.length}) — treated as takeable\n\n`,
		);
		for (const i of assignedUnclaimed.sort((a, b) => a.number - b.number))
			writeFd(
				1,
				`  #${i.number}  ${i.assignees.join(", ")}  ${String(i.title).slice(0, 50)}\n`,
			);
		writeFd(
			1,
			"\n  No live session recorded a claim on these, so the assignee is taken to\n" +
				"  be a finished session's leftover. A session that IS on one of these\n" +
				`  should have run:  ${buildArbiterCommand`claim-issue <n>`}\n`,
		);
	}
}

/** @param {State} state */
function renderClaimsDegraded(state) {
	const { claims, parentHeld } = state;
	if (claims.why)
		writeFd(
			1,
			`\nCLAIMS DEGRADED — ${claims.why}.\n  ${buildClaimsDegradedAdvice(claims)}\n`,
		);
	for (const why of parentHeld.unread)
		writeFd(
			1,
			`\nWARN: ${why}.\n  Its children are shown as takeable whether or not a session holds it.\n`,
		);
}

/**
 * @param {State} state
 * @returns {Issue[]}
 */
function renderDispatched(state) {
	const { enriched, dispatched, listed, dispatchJobs } = state;
	/* lucmoseley/mantahostels#1528 */
	const dispatchedShown = enriched
		.filter((i) => i.dispatchHeld)
		.sort((a, b) => a.number - b.number);
	if (dispatchedShown.length > 0) {
		writeFd(
			1,
			`\nALREADY DISPATCHED (${dispatchedShown.length}) — held out of the frontier, not offered\n\n`,
		);
		for (const i of dispatchedShown) {
			const rec = i.dispatchRec;
			const livenessCell = dispatchLivenessCell(
				dispatchLiveness(rec, listed, dispatchJobs),
			);
			writeFd(
				1,
				`  #${i.number}  ${dispatchAge(rec, Date.now())}  ${pad(livenessCell, 14)} ${String(i.title).slice(0, 40)}\n`,
			);
		}
		writeFd(
			1,
			"\n  scripts/dispatch-sessions.js drops any set member running the same command on one of these\n" +
				`  for ${DISPATCH_WINDOW_HOURS}h after launching it (mantahostels#1337, #752), alive or not, so a set built on one loses\n` +
				"  that member and gains nothing back. A relabelled issue is not held. Past a stale entry:\n" +
				`    ${scriptPath("dispatch-sessions.js")} --force ...\n`,
		);
	}
	if (dispatched.why)
		writeFd(
			1,
			`\nDISPATCH LEDGER DEGRADED — ${dispatched.why}.\n` +
				`  Nothing was excluded on it, so an issue launched in the last ${DISPATCH_WINDOW_HOURS}h may be\n` +
				"  shown as takeable and then dropped at launch.\n",
		);
	return dispatchedShown;
}

/**
 * @param {State} state
 * @param {Issue[]} dispatchedShown
 */
function renderExcluded(state, dispatchedShown) {
	const { enriched } = state;
	writeFd(1, "\nEXCLUDED\n\n");
	for (const i of enriched
		// lucmoseley/mantahostels#1528
		.filter((x) => x.excluded && !x.dispatchHeld)
		.sort((a, b) => a.number - b.number))
		writeFd(
			1,
			`${pad(`#${i.number}`, 6)}${pad(i.group, 16)}${pad(i.excluded, 40)}${String(i.title).slice(0, 40)}\n`,
		);
	if (dispatchedShown.length > 0)
		writeFd(
			1,
			`\n  ${dispatchedShown.length} more excluded as already dispatched — ALREADY DISPATCHED, above.\n`,
		);
}

/** @param {State} state */
function renderNotProposed(state) {
	for (const line of notProposedLines(notLaunchedOf(state)))
		writeFd(1, `${line}\n`);
}

/** @param {State["summary"]} summary */
function printSummaryFlags(summary) {
	/* lucmoseley/mantahostels#1237, lucmoseley/mantahostels#1206 */
	if (summary.reclaimableUnknown)
		writeFd(
			1,
			`  ${pad("reclaimable", 19)}unknown (${summary.reclaimableUnknown}) — headroom may be understated and nothing here can say by how much\n`,
		);
	else if ((summary.reclaimable ?? 0) > 0)
		writeFd(
			1,
			`  ${pad("reclaimable", 19)}${summary.reclaimable} finished session${summary.reclaimable === 1 ? "" : "s"} still resident — headroom understated\n`,
		);
	if (summary.degraded)
		writeFd(
			1,
			`  ${pad("degraded", 19)}${summary.degraded} readiness unknown — the shortlist is not the whole frontier\n`,
		);
	if (summary.dispatchHeldUnknown)
		writeFd(
			1,
			`  ${pad("dispatched", 19)}unknown (${summary.dispatchHeldUnknown}) — the frontier may hold issues the launcher will drop\n`,
		);
	else
		writeFd(
			1,
			`  ${pad("dispatched", 19)}${summary.dispatchHeld} held out on a launch in the last ${DISPATCH_WINDOW_HOURS}h\n`,
		);
	// lucmoseley/mantahostels#3363
	if (summary.labelDefects.length > 0)
		writeFd(
			1,
			`  ${pad("labelling", 19)}${summary.labelDefects
				.map((/** @type {any} */ d) => `#${d.number} (${takesCell(d.takes)})`)
				.join(", ")} — node ${scriptPath("check-issue-labels.js")}\n`,
		);
}

/** @param {State} state */
function renderRunSummary(state) {
	const { summary } = state;
	writeFd(1, "\nRUN SUMMARY — the figures §6's message is written from\n\n");
	writeFd(1, `  ${pad("open issues", 19)}${summary.openIssues}\n`);
	writeFd(
		1,
		`  ${pad("frontier", 19)}${summary.frontierCount} — §5's accounting denominator, never the shown slice\n`,
	);
	writeFd(1, `  ${pad("shown", 19)}${summary.shown}\n`);
	writeFd(
		1,
		`  ${pad("open tally", 19)}${buildOpenTallyLine(openTallyOf(state))}\n`,
	);
	writeFd(
		1,
		`  ${pad("no command", 19)}${summary.noCommand} — §5's third term: takes:human, plus a rotted takes:children container\n`,
	);
	if (summary.rottedContainers.length > 0)
		writeFd(
			1,
			`  ${pad("", 19)}rotted containers: ${summary.rottedContainers
				.map((/** @type {number} */ n) => `#${n}`)
				.join(
					", ",
				)} — takes:children with no open child left; retag them, node ${scriptPath("check-issue-labels.js")}\n`,
		);
	writeFd(
		1,
		`  ${pad("admission", 19)}${summary.admit ? "START ONE NOW" : "HOLD"} — ${
			summary.freeSlots === null
				? "free slots unknown"
				: `${summary.freeSlots} free slot(s)`
		}, as of this run — re-read it with node ${scriptPath("admission.js")} before starting anything (mantahostels#1144)\n`,
	);
	writeFd(
		1,
		`  ${pad("write-sets", 19)}${summary.writeSets.warm} warm, ${summary.writeSets.provisional} provisional, ${summary.writeSets.cold} to derive\n`,
	);
	writeFd(
		1,
		`  ${pad("proposed set", 19)}${
			summary.proposed.length > 0
				? `${summary.proposed.length} candidate${summary.proposed.length === 1 ? "" : "s"} — the numbers are in the graph block above, and each member's takes: and write-set in \`summary.proposed\``
				: "empty"
		}\n`,
	);
	writeFd(
		1,
		`  ${pad("owed work", 19)}${
			summary.strandedClaims === null
				? "unknown stranded claims"
				: `${summary.strandedClaims} stranded claims (${summary.strandedClaimsCarrying ?? "unknown how many"} carrying uncommitted work), ${summary.strandedWorktrees ?? "unknown"} stranded worktrees`
		}\n`,
	);
	printSummaryFlags(summary);
}

/** @param {{ok: boolean, file: string, error?: string}} snapshot */
function renderFooter(snapshot) {
	writeFd(
		1,
		"\nAdvisory only; nothing here was written back to the tracker.\n",
	);

	writeFd(
		1,
		`${
			snapshot.ok
				? `\nFULL JSON OF THIS RUN: ${snapshot.file}\n  Every block above, machine-readable. Read it rather than re-running for --json.\n  Check its generatedAt and repo before trusting it: a --no-log or --repo run overwrites this same file.`
				: `\nFULL JSON NOT WRITTEN — ${snapshot.error}\n  ${snapshot.file} holds an older run or none, so a --json re-run is the only copy.`
		}\n`,
	);
}

/**
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
		let why;
		if (isOutcomeError(e))
			why = `FAILED: could not list open issues: ${/** @type {Error} */ (e).message}\n`;
		else
			why =
				`FAILED: could not list open issues (${parseErrLine(e)}).\n` +
				(parseGhFailureReason(e) === "unreachable"
					? `        ${unreachableRemedy(e)}\n`
					: "        GitHub was reachable — this is a fault in the query, not your auth.\n");
		writeFd(
			2,
			`${why}        No shortlist produced — do not read this as an empty frontier.\n`,
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
					isPassingDown({
						state: byNumber.get(parent.number)?.state ?? "closed",
					})
						? parent.number
						: null,
				openSubIssues: i.openSubIssues,
				map: i.labels.includes(MAP_LABEL),
			};
		}),
		ownRepo,
		{
			blockedBy: (ref) =>
				readBlockedByOne(ref.repo ?? REPO, ref.number, { home: ref.repo }),
			issue: readIssueIn,
			subIssues: readSubIssuesOf,
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
 * @param {import("./lib/blocker-graph").Graph} graph
 * @param {ReturnType<typeof enrichAll>["inherit"]} inherit
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
async function timelinesByIssue(issues) {
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
 * @param {Issue[]} frontier
 * @param {Issue[]} enriched
 * @param {TrackedFiles} tracked
 */
function writeSetCacheOf(frontier, enriched, tracked) {
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

	const cacheState = prewarm(REPO_ROOT, frontier, {
		tracked,
		split: cacheSplit,
		enabled: cacheUsable && !NO_PREWARM,
	});
	return { cacheUsable, cachePruned, cacheState };
}

/** @param {boolean} cacheUsable */
function putsSinceLastRun(cacheUsable) {
	return cacheUsable && !NO_LOG
		? writeSetCache.countDerivedSince(
				REPO_ROOT,
				warmFractionLog.readLastRunAt(REPO_ROOT),
			)
		: { ok: false, count: null };
}

/**
 * @param {Issue[]} frontier
 * @param {Enriching[]} issues
 * @param {ReturnType<typeof listedSessionIds>} listed
 * @param {State["cacheState"]} cacheState
 */
function conflictGraphOf(frontier, issues, listed, cacheState) {
	const bundles = retroBundles(frontier);
	const bundled = new Set(bundles.flat());
	const unbundled = frontier.filter((i) => !bundled.has(i.number));
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

/** @param {ListedSessions} listed */
function admissionOf(listed) {
	const reclaimable = reclaimableFrom(listed, idSeam.fromEnv());
	const { mem, procs, host, live, memory, admission } = selectionAdmission({
		listed,
		reclaimable,
		reserves: readReserves(),
	});
	return {
		reclaimable,
		mem,
		procs,
		host,
		live,
		memory,
		admission,
	};
}

/**
 * @param {Issue[]} enriched
 */
function bannersOf(enriched) {
	const waitingAll = enriched
		.filter(hasWait)
		.sort((a, b) => (waitDays(b) || 0) - (waitDays(a) || 0));

	const gatedAll = enriched
		.filter((i) => i.gate || i.gateOn)
		.sort((a, b) => a.number - b.number);
	const gatedOnAll = gatedAll.filter(hasGateOn);

	const proseBlockedAll = enriched
		.filter(
			(i) =>
				i.proseBlocked.named.length > 0 || i.proseBlocked.unparsed.length > 0,
		)
		.sort((a, b) => a.number - b.number);
	const parkedAll = enriched
		.filter(hasParked)
		.sort((a, b) => parkedDays(b) - parkedDays(a));
	return { waitingAll, gatedAll, gatedOnAll, proseBlockedAll, parkedAll };
}

async function main() {
	const issues = await listOpenIssuesOrExit();

	const byNumber = new Map(issues.map((i) => [i.number, i]));
	const { withDeps, blockers } = await resolveBlockers(issues, byNumber);
	const { openChildren } = blockers;
	const resolvedGoal = resolveGoal(GOAL_ASK, issues, blockers, (ref, own) =>
		goalRefRepo(ref, own, REPO_ROOT),
	);
	if (resolvedGoal && "refusal" in resolvedGoal) {
		writeFd(2, `${resolvedGoal.refusal}\n`);
		process.exit(2);
	}
	if (resolvedGoal?.notice) writeFd(2, `${resolvedGoal.notice}\n`);
	for (const n of resolvedGoal?.ranked ?? []) goalRanked.add(n);

	const { mapNumbers, specNumbers } = kindSetsOf(issues);

	const timelineByIssue = await timelinesByIssue(issues);

	const listed = listedSessionIds();
	const claims = claimedIssues(listed);
	const parentHeld = await parentClaims(withDeps, mapNumbers, claims, listed);
	const dispatched = dispatchedIssues();
	const dispatchJobs = readJobs();

	/** @type {Omit<import("./lib/pick-next-verdict.js").EnrichContext, "inherit">} */
	const ctx = {
		blockers,
		timelineByIssue,
		mapNumbers,
		specNumbers,
		listed,
		claims,
		parentHeld,
		dispatched,
		openChildren,
		goalRanked,
		now: Date.now,
	};
	const { enriched, inherit } = enrichAll(withDeps, byNumber, ctx);

	const degraded = enriched.filter((i) => i.depsUnknown);

	const tracked = readTrackedFiles();
	const frontier = annotatePaths(rankFrontier(enriched), tracked);
	const shown = LIMIT ? frontier.slice(0, LIMIT) : frontier;
	const { collisions, inFlightCollisions } = collisionsOf(
		frontier,
		enriched,
		claims.held,
		tracked,
	);

	const docMapQueue = docMapQueueOf(frontier);
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

	const { noCommand, rottedContainers } = noCommandOf(frontier, openChildren);

	const warmLogged = logWarmFraction(cacheUsable, {
		frontier,
		cacheState,
		degraded,
		putsSince,
	});

	const { reclaimable, mem, procs, host, live, memory, admission } =
		admissionOf(listed);

	if (!NO_LOG) {
		selectionMarker.recordFromEnv(REPO_ROOT, {
			frontier: frontier.length,
			slots: admission.freeSlots,
			noCommand: noCommand.length,
		});
	}

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
		stranded,
		noCommandCount: noCommand.length,
		rottedContainers,
	});

	const state = {
		repo: String(REPO),
		argv: args,
		goal: [...goalRanked],
		goalSet: resolvedGoal && { members: resolvedGoal.members },
		ownRepo: blockers.ownRepo,
		running: enriched
			.filter((i) => claims.held.has(i.number) || i.dispatchHeld)
			.map((i) => i.number),
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
		bandReadRequired: bandReadRequiredOf(graph, cacheState),
		warmLogged,
		mem,
		procs,
		admission,
		memory,
		host,
		live,
		reclaimable,
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
		pulledIn: pulledInRows(blockers, inherit),
	};
	const payload = buildPayload(state);
	const snapshot = writeRunSnapshot(payload);

	if (asJson) {
		writeFd(1, `${JSON.stringify(payload, null, 2)}\n`);
		return;
	}

	render(state, snapshot);
}

// lucmoseley/mantahostels#1944
module.exports = { main };

if (require.main === module) {
	main().catch((e) => {
		writeFd(2, `FAILED: ${parseErrLine(e)}\n`);
		process.exit(1);
	});
}
