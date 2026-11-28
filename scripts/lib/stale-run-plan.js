const { AGE_UNIT_DAYS, WAITING_LABEL } = require("./frontier-order.js");
const { WATCH_CLOSED_LABEL } = require("./watch-label.js");
const { PARKED_LABEL } = require("./parked.js");
const { takesLabel } = require("./takes-label.js");
const { URGENT_LABEL } = require("./urgent-label.js");
const { parseVerdict } = require("./gate-check.js");
const {
	BOUND_DAYS,
	RATE_WINDOW_DAYS,
	hasFounderRound,
	parseCounts,
	project,
} = require("./gate-projection.js");
const { gateRefsOf, resolveGate } = require("./issue-gate.js");
const { refKey } = require("./issue-ref.js");
const { isTagRef, sameRelease } = require("./plugin-state.js");
const { DAY_MS } = require("./retained-jsonl.js");
const { buildStandaloneLine } = require("./standalone-line.js");

const FLOOR_DAYS = AGE_UNIT_DAYS;
// guess, #5857
const GATE_FRESH_DAYS = 7;
// guess, #5857
const OWED_FLOOR_DAYS = 7;
// guess, #5857
const EXTERNAL_DAYS = 14;
// guess, #5857
const URGENT_DAYS = 14;
// guess, #5857
const STAMP_ALARM_DAYS = 2;

const HUB_TITLE = "Stale tickets: daily report";
const HUB_TAKES = takesLabel("triage");
const HUB_STANDALONE = "the daily stale-ticket run's report (#5857).";
const FILING_STANDALONE = "a cause the daily stale-ticket run found.";
const CAUSE_PREFIX = "Stale-ticket cause: ";
const DATA_ROUTE_PREFIX = "Gate data not accruing: ";

const CONTAINER_LABEL = "takes:children";
const HUMAN_LABEL = "takes:human";
const ROUND = /❓ \*\*Q/;
const LABEL_TAGS = new Set([
	"NO-TAKES",
	"MANY-TAKES",
	"CONTRADICTED",
	"HUMAN-UNREVIEWED",
]);
const EDGE_TAGS = new Set(["SHIPPED-GATED", "PROSE-BLOCKED"]);
const CONTAINER_TAGS = new Set(["STALE-CONTAINER", "UNMARKED-CONTAINER"]);
const PLACEMENT_TAGS = new Set(["UNDISCHARGED-MAP", "UNPLACED"]);
const ABSENT_SOURCE =
	/no such file|ENOENT|not found|does not exist|cannot open|cannot access/i;
const QUESTION_CAUSES = new Set([undefined, "", "QUESTION"]);
const ISSUE_REF = /^(?:[\w.-]+\/[\w.-]+)?#\d+$/;
const CLOSURE_WORDS = new Set([
	"and",
	"closes",
	"closed",
	"is",
	"has",
	"lands",
	"landed",
]);

/** @param {string} condition */
const closesOnly = (condition) =>
	condition
		.split(/[\s,]+/)
		.map((w) => w.replace(/\.$/, ""))
		.every(
			(w) =>
				w === "" || ISSUE_REF.test(w) || CLOSURE_WORDS.has(w.toLowerCase()),
		);

const STALL_TITLES = [
	"Landing queue stalled: main has not moved for 2 h",
	"Landing alarm red: an off-machine queue alarm failed since main last moved",
];

/** @typedef {"C1"|"C2"|"C3"|"C4"|"C5"|"C6"|"C7"|"C8"|"C12"|"unclassified"} Cls */

/** @type {Record<Cls, string>} */
const CLASS_NAMES = {
	C1: "C1 gate can never fire, wrong measure or data never accrues",
	C2: "C2 met gate not discharged",
	C3: "C3 edge missing, wrong, cyclic or a stuck blocker",
	C4: "C4 container holds work",
	C5: "C5 a label hides it",
	C6: "C6 stale claim",
	C7: "C7 data never collected",
	C8: "C8 house decision unasked or unanswered",
	C12: "C12 other waits",
	unclassified: "Unclassified: takeable, over the floor, no class matches",
};
const CLASS_ORDER = /** @type {Cls[]} */ (Object.keys(CLASS_NAMES));

/**
 * @typedef {{repo: string|null, number: number, state: string}} EdgeRow
 * @typedef {{event: string, created_at: string, body?: string, label?: {name: string}}} TimelineRow
 * @typedef {object} SnapIssue
 * @property {number} number
 * @property {string} title
 * @property {string[]} labels
 * @property {string} body
 * @property {string} createdAt
 * @property {string} [updatedAt]
 * @property {string[]} assignees
 * @property {EdgeRow[]} blockedBy
 * @property {EdgeRow[]} subIssues
 * @property {{repo: string, number: number}|null} [parent]
 * @property {TimelineRow[]} [timeline]
 * @typedef {{number: number, state: string, reading: string, closed: boolean, detail?: string|null,
 *   history?: import("./gate-projection.js").HistoryRow[]}} GateRow
 * @typedef {{issue: number, sessionId: string|null, claimedAt: string}} ClaimRecord
 * @typedef {object} SnapRepo
 * @property {string} root
 * @property {string|null} tracker
 * @property {string|null} fault
 * @property {boolean} served
 * @property {string|null} pin
 * @property {{number: number, assigned: boolean}[]} bumps
 * @property {number[] | {error: string}} frontier
 * @property {SnapIssue[]} issues
 * @property {SnapIssue[]} watched
 * @property {GateRow[]} gates
 * @property {{tag: string, number: number}[]} checkFindings
 * @property {number[]} containerRetags
 * @property {{number: number, ageDays: number, assignees: string[]}[]} staleClaims
 * @property {ClaimRecord[] | null} claims
 * @property {{sessionId: string, issues: number[], cause?: string}[]} parkMarkers
 * @property {string[]} closedRefs
 * @property {{members: {repo: string, number: number}[]}[]} cycles
 * @typedef {{reading: string, since: string}} GateSeen
 * @typedef {object} RunRow
 * @property {string} date
 * @property {string[]} repoLines
 * @property {{key: string, cls: Cls, firstListed: string}[]} listed
 * @property {OwedLine[]} owed
 * @property {string[]} acts
 * @property {string[]} filings
 * @property {{number: number|null, keys: string[]}} hub
 * @property {string[]} disposed
 * @property {Record<string, GateSeen>} gates
 * @typedef {object} Snapshot
 * @property {string} now
 * @property {string} coreTracker
 * @property {string|null} latestRelease
 * @property {string[]|null} liveSessions
 * @property {RunRow|null} previous
 * @property {{number: number, state: "open"|"closed"}|null} hub
 * @property {SnapRepo[]} repos
 * @typedef {{key: string, repo: string, number: number, cls: Cls, sig: string,
 *   text: string, restored: boolean}} Line
 * @typedef {{key: string, repo: string, number: number, text: string, url: string,
 *   ageDays: number}} OwedLine
 * @typedef {{kind: "discharge", root: string, repo: string, number: number, reading: string,
 *     seen: string, closed: boolean, body: string, wasBody: string}
 *   | {kind: "unblock", root: string, repo: string, number: number, blocker: {repo: string, number: number}}
 *   | {kind: "strip-gate", root: string, repo: string, number: number, blocker: string, body: string, wasBody: string}
 *   | {kind: "release", root: string, repo: string, number: number, assignees: string[], sessionId: string}
 *   | {kind: "retag", root: string, repo: string, numbers: number[]}} Act
 * @typedef {{kind: "cause" | "data-route", tracker: string, root: string|null, title: string, body: string}} Filing
 * @typedef {{action: "refresh", body: string} | {action: "close", number: number} | {action: "none"}} HubNext
 * @typedef {object} Plan
 * @property {string[]} repoLines
 * @property {Line[]} lines
 * @property {OwedLine[]} owed
 * @property {Act[]} acts
 * @property {Filing[]} filings
 * @property {HubNext} hub
 * @property {string[]} hubKeys
 * @property {string[]} disposed
 * @property {Record<string, GateSeen>} gates
 */

/** @param {string} from @param {number} now */
const daysSince = (from, now) => Math.floor((now - Date.parse(from)) / DAY_MS);

/** @param {number} ms */
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** @param {string} repo @param {number} n */
const issueUrl = (repo, n) => `https://github.com/${repo}/issues/${n}`;

/** @param {string} text */
const oneLine = (text) => {
	const first = text.split("\n").find((l) => l.trim()) ?? "";
	return first.length > 120 ? `${first.slice(0, 119)}…` : first;
};

/**
 * @param {TimelineRow[]} timeline
 * @param {string} label
 * @returns {string|null}
 */
function labelledAt(timeline, label) {
	const at = timeline
		.filter((e) => e.event === "labeled" && e.label?.name === label)
		.map((e) => e.created_at)
		.sort();
	return at.at(-1) ?? null;
}

/**
 * @param {SnapIssue} iss
 * @returns {string|null}
 */
function openRoundAt(iss) {
	const comments = (iss.timeline ?? [])
		.filter((e) => e.event === "commented")
		.sort((a, b) => a.created_at.localeCompare(b.created_at));
	const last = comments.at(-1);
	if (last) return ROUND.test(last.body ?? "") ? last.created_at : null;
	return ROUND.test(iss.body) ? iss.createdAt : null;
}

/**
 * @param {string} body
 * @returns {string}
 */
function withoutGate(body) {
	return body
		.split("\n")
		.filter((l) => !/\*\*Gated on:\*\*|\*\*Gate basis:\*\*/.test(l))
		.join("\n");
}

/** @param {string} body */
const partyOf = (body) =>
	/\*\*Waiting on:\*\*\s*(.+)/.exec(body)?.[1]?.trim() ?? "an outside party";

/**
 * @typedef {object} Ctx
 * @property {Snapshot} snap
 * @property {number} now
 * @property {Set<string>|null} live
 * @property {Record<string, GateSeen>} gates
 * @property {Line[]} lines
 * @property {OwedLine[]} owed
 * @property {Act[]} acts
 * @property {Filing[]} filings
 * @property {string[]} repoLines
 * @property {Map<string, number>} holdCount
 * @property {Map<string, RepoCtx>} repoCtx
 * @typedef {object} RepoCtx
 * @property {Ctx} ctx
 * @property {SnapRepo} r
 * @property {string} repo
 * @property {Map<number, SnapIssue>} byNumber
 * @property {Set<number>|null} takeable
 * @property {Map<number, Line[]>} found
 * @property {Set<number>} excluded
 * @property {Set<string>} closed
 * @typedef {{n: number, cls: Cls, sig: string, text: string, restored?: boolean}} Finding
 */

/** @param {RepoCtx} rc @param {Finding} f */
function add(rc, { n, cls, sig, text, restored = false }) {
	const line = {
		key: `${rc.repo}#${n}:${cls}`,
		repo: rc.repo,
		number: n,
		cls,
		sig: `${cls} ${sig}`,
		text: `${rc.repo}#${n} ${text}`,
		restored,
	};
	rc.found.set(n, [...(rc.found.get(n) ?? []), line]);
}

/** @param {RepoCtx} rc @param {number} n @param {string} text @param {number} ageDays */
function owe(rc, n, text, ageDays) {
	if (ageDays <= OWED_FLOOR_DAYS) return;
	rc.ctx.owed.push({
		key: `${rc.repo}#${n}:owed`,
		repo: rc.repo,
		number: n,
		text: `${rc.repo}#${n} ${text}`,
		url: issueUrl(rc.repo, n),
		ageDays,
	});
}

/** @param {Snapshot} snap @returns {Map<string, number>} */
function countHolds(snap) {
	/** @type {Map<string, number>} */
	const held = new Map();
	for (const r of snap.repos) {
		const self = r.tracker;
		if (!self) continue;
		for (const iss of r.issues) {
			const refs = [
				...iss.blockedBy
					.filter((b) => b.state === "open")
					.map((b) => refKey({ repo: b.repo ?? self, number: b.number })),
				...gateRefsOf(iss.body, self).map(refKey),
			];
			for (const k of new Set(refs)) held.set(k, (held.get(k) ?? 0) + 1);
		}
	}
	return held;
}

/**
 * @param {Snapshot} snap
 * @returns {Plan}
 */
function planStaleRun(snap) {
	/** @type {Ctx} */
	const ctx = {
		snap,
		now: Date.parse(snap.now),
		live: snap.liveSessions === null ? null : new Set(snap.liveSessions),
		gates: {},
		lines: [],
		owed: [],
		acts: [],
		filings: [],
		repoLines: [],
		holdCount: countHolds(snap),
		repoCtx: new Map(),
	};
	/** @type {{rc: RepoCtx, listed: SnapIssue[]}[]} */
	const planned = [];
	for (const r of snap.repos) {
		if (r.fault !== null || !r.tracker)
			ctx.repoLines.push(
				`${r.tracker ?? r.root}: 0 takeable, oldest 0 d, unserved because config or tracker fault: ${r.fault ?? "no tracker resolves"}`,
			);
		else planned.push(planRepo(ctx, r, r.tracker));
	}
	planAllStuckBlockers(planned);
	for (const { rc } of planned) flushLines(rc);
	planCauses(ctx);
	return { ...planHub(ctx), gates: ctx.gates };
}

/** @param {Ctx} ctx @param {SnapRepo} r @param {string} repo */
function planRepo(ctx, r, repo) {
	/** @type {RepoCtx} */
	const rc = {
		ctx,
		r,
		repo,
		byNumber: new Map([...r.watched, ...r.issues].map((i) => [i.number, i])),
		takeable: "error" in r.frontier ? null : new Set(r.frontier),
		found: new Map(),
		excluded: new Set(),
		closed: new Set(r.closedRefs.map((k) => k.toLowerCase())),
	};
	ctx.repoCtx.set(repo.toLowerCase(), rc);
	ctx.repoLines.push(buildRepoLine(rc));
	const open = r.gates.filter((g) => !planMetGate(rc, g));
	for (const iss of r.issues) planClosedEdges(rc, iss);
	const restored = new Set(
		ctx.acts.flatMap((a) =>
			a.root === r.root && (a.kind === "discharge" || a.kind === "strip-gate")
				? [a.number]
				: [],
		),
	);
	for (const g of open) if (!restored.has(g.number)) planGate(rc, g);
	const listed = r.issues.filter(
		(iss) => !restored.has(iss.number) && planIssue(rc, iss),
	);
	const held = new Set(
		listed.flatMap((i) => (rc.takeable?.has(i.number) ? [] : [i.number])),
	);
	ctx.acts = ctx.acts.filter(
		(a) => a.kind !== "unblock" || a.root !== r.root || held.has(a.number),
	);
	if (r.containerRetags.length > 0)
		ctx.acts.push({
			kind: "retag",
			root: r.root,
			repo,
			numbers: r.containerRetags,
		});
	planCycles(rc);
	return { rc, listed };
}

/** @param {RepoCtx} rc */
function flushLines(rc) {
	for (const ls of rc.found.values()) {
		const seen = new Set();
		for (const l of ls) {
			if (seen.has(l.text)) continue;
			seen.add(l.text);
			rc.ctx.lines.push(l);
		}
	}
}

/** @param {RepoCtx} rc */
function buildRepoLine({ ctx, r, repo, byNumber, takeable }) {
	const ages = [...(takeable ?? [])].flatMap((n) => {
		const iss = byNumber.get(n);
		return iss ? [daysSince(iss.createdAt, ctx.now)] : [];
	});
	const count = takeable === null ? "?" : String(takeable.size);
	const head = `${repo}: ${count} takeable, oldest ${ages.length > 0 ? Math.max(...ages) : 0} d`;
	return `${head}, ${servedText(ctx, r)}`;
}

/** @param {Ctx} ctx @param {SnapRepo} r */
function servedText(ctx, r) {
	if ("error" in r.frontier)
		return `unserved because config or tracker fault: pick-next ${r.frontier.error}`;
	if (r.served) return "served";
	const latest = ctx.snap.latestRelease;
	if (r.pin && isTagRef(r.pin) && latest && !sameRelease(r.pin, latest))
		return `unserved because pin ${r.pin} is behind latest release ${latest}`;
	const bump = r.bumps.find((b) => !b.assigned);
	if (bump)
		return `unserved because release bump #${bump.number} is open and unlaunched`;
	return "unserved because not in the served set";
}

/** @param {number} n @param {string} one @param {string} many */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** @param {RepoCtx} rc @param {GateRow} g */
function gateSince(rc, g) {
	const { ctx, repo } = rc;
	const key = `${repo}#${g.number}`;
	const prev = ctx.snap.previous?.gates?.[key];
	const changed = prev !== undefined && prev.reading !== g.reading;
	const since = prev && !changed ? prev.since : ctx.snap.now;
	ctx.gates[key] = { reading: g.reading, since };
	return { since, changed };
}

/** @param {Ctx} ctx @param {SnapIssue} iss */
function overFloor(ctx, iss) {
	if (daysSince(iss.createdAt, ctx.now) <= FLOOR_DAYS) return false;
	const { gate } = resolveGate(iss.body, ctx.now);
	return !(gate && !gate.malformed && gate.active && gate.reason);
}

/** @param {RepoCtx} rc @param {GateRow} g @returns {boolean} */
function planMetGate(rc, g) {
	if (g.state !== "READING" || parseVerdict(g.reading) !== "met") return false;
	gateSince(rc, g);
	discharge(rc, g, rc.byNumber.get(g.number)?.body ?? "");
	return true;
}

/** @param {RepoCtx} rc @param {GateRow} g */
function planGate(rc, g) {
	const { ctx } = rc;
	const { since, changed } = gateSince(rc, g);
	const iss = rc.byNumber.get(g.number);
	if (g.closed || !iss || !overFloor(ctx, iss)) return;
	const d = daysSince(since, ctx.now);
	if (g.state === "READING") planReading(rc, { g, iss, d, changed });
	else planRepair(rc, g, iss, d);
}

/** @param {RepoCtx} rc @param {GateRow} g @param {string} body */
function discharge(rc, g, body) {
	rc.ctx.acts.push({
		kind: "discharge",
		root: rc.r.root,
		repo: rc.repo,
		number: g.number,
		reading: oneLine(g.reading),
		seen: g.reading,
		closed: g.closed,
		body: withoutGate(body),
		wasBody: body,
	});
	rc.excluded.add(g.number);
}

/** @param {RepoCtx} rc @param {GateRow} g @param {SnapIssue} iss @param {number} d */
function planRepair(rc, g, iss, d) {
	const shown = oneLine(g.reading);
	const absent =
		g.state === "DEAD" && ABSENT_SOURCE.test(`${g.reading} ${g.detail ?? ""}`);
	if (!absent) {
		add(rc, {
			n: g.number,
			cls: "C1",
			sig: `gate ${g.state}`,
			text: `gate ${g.state}: ${shown}`,
		});
		return;
	}
	add(rc, {
		n: g.number,
		cls: "C7",
		sig: "check source absent",
		text: `data not accruing (${shown}, ${d} d)`,
	});
	const detail = g.detail ? ` (${oneLine(g.detail)})` : "";
	fileDataRoute(
		rc,
		iss,
		`gate check reads DEAD because its data source is absent: \`${shown}\`${detail}, for ${d} d`,
	);
}

/** @param {RepoCtx} rc @param {SnapIssue} iss @param {string} why */
function fileDataRoute(rc, iss, why) {
	rc.ctx.filings.push({
		kind: "data-route",
		tracker: rc.repo,
		root: rc.r.root,
		title: `${DATA_ROUTE_PREFIX}#${iss.number}`,
		body: buildDataRouteBody(rc.repo, iss, why),
	});
}

/** @param {RepoCtx} rc @param {GateRow} g @param {SnapIssue} iss @param {string} basis */
function planCount(rc, g, iss, basis) {
	const p = project(g.history ?? [], parseCounts(g.reading), rc.ctx.now);
	const unmoved =
		p.verdict === "unreachable" && p.unmovedDays >= RATE_WINDOW_DAYS;
	if (p.verdict !== "unreachable" || (!unmoved && hasFounderRound(basis))) {
		rc.excluded.add(g.number);
		return;
	}
	const shown = oneLine(g.reading);
	const d = Math.floor(unmoved ? p.unmovedDays : p.spanDays);
	const met = p.metAt === null ? "never" : isoDate(p.metAt);
	add(rc, {
		n: g.number,
		cls: "C1",
		sig: unmoved ? "count gate unmoved" : "count gate projected past bound",
		text: `gate READING: ${shown}; ${unmoved ? `unmoved ${d} d` : `projected met ${met}`}`,
	});
	add(rc, {
		n: g.number,
		cls: "C7",
		sig: "count data not accruing",
		text: `data not accruing (${shown}, ${d} d)`,
	});
	fileDataRoute(
		rc,
		iss,
		unmoved
			? `count gate reads \`${shown}\` and has not moved for ${d} d`
			: `count gate reads \`${shown}\` and, at its rate over the last ${d} d, is projected to be met ${met}, past the ${BOUND_DAYS}-day bound`,
	);
}

/** @param {RepoCtx} rc @param {{g: GateRow, iss: SnapIssue, d: number, changed: boolean}} at */
function planReading(rc, { g, iss, d, changed }) {
	const shown = oneLine(g.reading);
	const n = g.number;
	const { basis } = resolveGate(iss.body, rc.ctx.now);
	if (changed && parseVerdict(g.reading) === null)
		add(rc, {
			n,
			cls: "C2",
			sig: "changed, no verdict",
			text: "gate reading changed, needs a judge",
		});
	else if (!basis)
		add(rc, {
			n,
			cls: "C1",
			sig: "gate states no basis",
			text: `gate READING states no basis: ${shown}`,
		});
	else if (parseCounts(g.reading).length > 0) planCount(rc, g, iss, basis);
	else if (d < GATE_FRESH_DAYS) rc.excluded.add(n);
	else
		add(rc, {
			n,
			cls: "C1",
			sig: "gate unmoved",
			text: `gate READING: ${shown}; unmoved ${d} d`,
		});
}

/** @param {RepoCtx} rc @param {SnapIssue} iss */
function planClosedEdges(rc, iss) {
	const { ctx, r, repo } = rc;
	const n = iss.number;
	for (const b of iss.blockedBy.filter((e) => e.state === "closed"))
		ctx.acts.push({
			kind: "unblock",
			root: r.root,
			repo,
			number: n,
			blocker: { repo: b.repo ?? repo, number: b.number },
		});
	if (
		ctx.acts.some(
			(a) => a.kind === "discharge" && a.root === r.root && a.number === n,
		)
	)
		return;
	const refs = gateRefsOf(iss.body, repo);
	const gateOn = resolveGate(iss.body, ctx.now).gateOn;
	if (!gateOn || gateOn.malformed || refs.length === 0) return;
	if (!refs.every((ref) => rc.closed.has(refKey(ref)))) return;
	if (!closesOnly(gateOn.condition)) return;
	ctx.acts.push({
		kind: "strip-gate",
		root: r.root,
		repo,
		number: n,
		blocker: refs.map((ref) => `${ref.repo}#${ref.number}`).join(", "),
		body: withoutGate(iss.body),
		wasBody: iss.body,
	});
}

/**
 * @param {RepoCtx} rc
 * @param {SnapIssue} iss
 * @returns {boolean}
 */
function planIssue(rc, iss) {
	const { ctx } = rc;
	const n = iss.number;
	if (daysSince(iss.createdAt, ctx.now) <= FLOOR_DAYS || rc.excluded.has(n))
		return false;
	const { gate } = resolveGate(iss.body, ctx.now);
	const dated = gate && !gate.malformed && gate.active;
	if (dated && gate.reason) return false;
	if (dated)
		add(rc, {
			n,
			cls: "C1",
			sig: "gated until, no reason",
			text: `gated until ${gate.iso} with no reason stated`,
		});
	const tags = rc.r.checkFindings
		.filter((f) => f.number === n)
		.map((f) => f.tag);
	planPlacement(rc, iss, tags);
	if (planContainer(rc, iss, tags)) return false;
	for (const t of tags.filter((x) => LABEL_TAGS.has(x)))
		add(rc, { n, cls: "C5", sig: t, text: t });
	for (const t of tags.filter((x) => EDGE_TAGS.has(x)))
		add(rc, { n, cls: "C3", sig: t, text: t });
	const owedDays = planOwed(rc, iss);
	planWaits(rc, iss, owedDays);
	const stale = rc.r.staleClaims.find((c) => c.number === n);
	if (stale) planClaim(rc, iss, stale);
	planUnclassified(rc, iss, owedDays);
	return true;
}

/** @param {RepoCtx} rc @param {SnapIssue} iss @param {string[]} tags */
function planContainer(rc, iss, tags) {
	const n = iss.number;
	const kids = iss.subIssues.filter((k) => k.state === "open");
	if (!iss.labels.includes(CONTAINER_LABEL) && kids.length === 0) return false;
	if (kids.length > 0)
		add(rc, {
			n,
			cls: "C4",
			sig: "container held",
			text: `container held by ${count(kids.length, "open child", "open children")}: ${kids.map((k) => `${k.repo ?? rc.repo}#${k.number}`).join(", ")}`,
		});
	for (const t of tags.filter((x) => CONTAINER_TAGS.has(x)))
		add(rc, { n, cls: "C4", sig: t, text: t });
	return true;
}

/** @param {RepoCtx} rc @param {SnapIssue} iss @param {string[]} tags */
function planPlacement(rc, iss, tags) {
	const n = iss.number;
	for (const t of tags.filter((x) => PLACEMENT_TAGS.has(x)))
		add(rc, { n, cls: "C4", sig: t, text: t });
	const { parent } = iss;
	if (parent && rc.closed.has(refKey(parent)))
		add(rc, {
			n,
			cls: "C4",
			sig: "parent closed",
			text: `open under closed parent ${parent.repo}#${parent.number}`,
		});
}

/**
 * @param {RepoCtx} rc
 * @param {SnapIssue} iss
 * @returns {number|null}
 */
function planOwed(rc, iss) {
	const n = iss.number;
	const tl = iss.timeline ?? [];
	const holds = rc.ctx.holdCount.get(refKey({ repo: rc.repo, number: n })) ?? 0;
	/** @param {string} at */
	const asked = (at) => {
		const d = daysSince(at, rc.ctx.now);
		owe(
			rc,
			n,
			`asked ${at.slice(0, 10)}, ${d} d, holds ${count(holds, "issue", "issues")}`,
			d,
		);
		return d;
	};
	const roundAt = openRoundAt(iss);
	if (roundAt) return asked(roundAt);
	if (iss.labels.includes(HUMAN_LABEL))
		return asked(labelledAt(tl, HUMAN_LABEL) ?? iss.createdAt);
	if (!iss.labels.includes(PARKED_LABEL)) return null;
	const marker = rc.r.parkMarkers.find((m) => m.issues.includes(n));
	if (!marker)
		add(rc, {
			n,
			cls: "C5",
			sig: "parked, marker gone",
			text: "parked, its park marker is gone",
		});
	else if (!QUESTION_CAUSES.has(marker.cause))
		add(rc, {
			n,
			cls: "C12",
			sig: `parked ${marker.cause}`,
			text: `parked (${marker.cause})`,
		});
	else if (answeredAfter(tl, labelledAt(tl, PARKED_LABEL)))
		add(rc, {
			n,
			cls: "C5",
			sig: "parked, answered",
			text: "parked, its question has a later comment",
		});
	else return asked(labelledAt(tl, PARKED_LABEL) ?? iss.createdAt);
	return null;
}

/** @param {{event: string, created_at: string}[]} tl @param {string|null} since */
const answeredAfter = (tl, since) =>
	since !== null &&
	tl.some((e) => e.event === "commented" && e.created_at > since);

/** @param {RepoCtx} rc @param {SnapIssue} iss @param {number|null} owedDays */
function planWaits(rc, iss, owedDays) {
	const n = iss.number;
	const tl = iss.timeline ?? [];
	const ageOf = (/** @type {string} */ label) =>
		daysSince(labelledAt(tl, label) ?? iss.createdAt, rc.ctx.now);
	if (iss.labels.includes(WAITING_LABEL)) {
		const d = ageOf(WAITING_LABEL);
		if (d > EXTERNAL_DAYS)
			owe(rc, n, `waiting on ${partyOf(iss.body)} ${d} d`, d);
	}
	if (iss.labels.includes(URGENT_LABEL) && owedDays !== null) {
		const d = ageOf(URGENT_LABEL);
		if (d > URGENT_DAYS)
			add(rc, {
				n,
				cls: "C5",
				sig: "urgent held outside",
				text: `urgent, held on an answer ${d} d`,
			});
	}
	if (STALL_TITLES.includes(iss.title))
		add(rc, {
			n,
			cls: "C12",
			sig: "lander stall",
			text: "lander stall alarm open",
		});
}

/**
 * @param {RepoCtx} rc
 * @param {SnapIssue} iss
 * @param {{number: number, ageDays: number, assignees: string[]}} stale
 */
function planClaim(rc, iss, stale) {
	const { ctx, r } = rc;
	const n = iss.number;
	const idle = Math.floor(stale.ageDays);
	const named = (r.claims ?? []).filter((c) => c.issue === n && c.sessionId);
	const [first] = named;
	if (r.claims === null || !first?.sessionId) {
		add(rc, {
			n,
			cls: "C6",
			sig: "no arbiter record",
			text: `claim has no arbiter record, idle ${idle} d`,
		});
		return;
	}
	const { live } = ctx;
	if (live === null || named.some((c) => live.has(String(c.sessionId)))) {
		add(rc, {
			n,
			cls: "C6",
			sig: "claim live",
			text: `claim live, idle ${idle} d`,
		});
		return;
	}
	ctx.acts.push({
		kind: "release",
		root: r.root,
		repo: rc.repo,
		number: n,
		assignees: stale.assignees,
		sessionId: first.sessionId,
	});
}

/** @param {RepoCtx} rc @param {SnapIssue} iss @param {number|null} owedDays */
function planUnclassified(rc, iss, owedDays) {
	const n = iss.number;
	if (rc.found.has(n) || owedDays !== null || !rc.r.served) return;
	if (!rc.takeable?.has(n)) return;
	const claims = (iss.timeline ?? []).filter(
		(e) => e.event === "assigned",
	).length;
	const age = daysSince(iss.createdAt, rc.ctx.now);
	add(rc, {
		n,
		cls: "unclassified",
		sig: "never picked",
		text: `takeable ${age} d, never picked (claims: ${claims})`,
	});
}

/** @param {{rc: RepoCtx, listed: SnapIssue[]}[]} planned */
function planAllStuckBlockers(planned) {
	/** @type {Set<string>} */
	const named = new Set();
	let grew = true;
	while (grew) {
		grew = false;
		for (const { rc, listed } of planned)
			for (const iss of listed)
				if (planStuckBlockers(rc, iss, named)) grew = true;
	}
}

/**
 * @param {RepoCtx} rc
 * @param {SnapIssue} iss
 * @param {Set<string>} named
 * @returns {boolean}
 */
function planStuckBlockers(rc, iss, named) {
	const refs = new Map(
		[
			...iss.blockedBy
				.filter((e) => e.state === "open")
				.map((b) => ({ repo: b.repo ?? rc.repo, number: b.number })),
			...gateRefsOf(iss.body, rc.repo),
		].map((ref) => [refKey(ref), ref]),
	);
	let grew = false;
	for (const [key, ref] of refs) {
		const edge = `${refKey({ repo: rc.repo, number: iss.number })}>${key}`;
		const theirs = rc.ctx.repoCtx.get(ref.repo.toLowerCase());
		const blocker = theirs?.byNumber.get(ref.number);
		const cls = theirs?.found.get(ref.number)?.[0]?.cls;
		if (named.has(edge) || !blocker || !cls) continue;
		named.add(edge);
		grew = true;
		add(rc, {
			n: iss.number,
			cls: "C3",
			sig: "stuck blocker",
			text: `blocked by ${theirs.repo}#${ref.number} (${cls}, ${daysSince(blocker.createdAt, rc.ctx.now)} d)`,
		});
	}
	return grew;
}

/** @param {RepoCtx} rc */
function planCycles(rc) {
	for (const c of rc.r.cycles) {
		const [first] = c.members;
		if (!first || first.repo.toLowerCase() !== rc.repo.toLowerCase()) continue;
		const path = [...c.members, first]
			.map((m) => `${m.repo}#${m.number}`)
			.join(" → ");
		rc.found.set(first.number, [
			...(rc.found.get(first.number) ?? []),
			{
				key: `${rc.repo}#${first.number}:C3`,
				repo: rc.repo,
				number: first.number,
				cls: "C3",
				sig: "C3 cycle",
				text: `cycle: ${path}`,
				restored: false,
			},
		]);
	}
}

/** @param {Ctx} ctx */
function planCauses(ctx) {
	/** @type {Map<string, Line[]>} */
	const causes = new Map();
	for (const l of ctx.lines) {
		if (l.cls === "unclassified" || l.restored) continue;
		causes.set(l.sig, [...(causes.get(l.sig) ?? []), l]);
	}
	for (const [sig, ls] of causes)
		if (new Set(ls.map((l) => l.key.split(":")[0])).size > 1)
			ctx.filings.push({
				kind: "cause",
				tracker: ctx.snap.coreTracker,
				root: null,
				title: `${CAUSE_PREFIX}${sig}`,
				body: buildCauseBody(sig, ls),
			});
}

/** @param {Ctx} ctx */
function planHub(ctx) {
	const { snap, lines, owed, acts, filings, repoLines } = ctx;
	const keys = [...lines.map((l) => l.key), ...owed.map((o) => o.key)];
	const current = new Set(keys);
	const prevHub = snap.previous?.hub ?? { number: null, keys: [] };
	const closedNow =
		snap.hub?.state === "closed" && prevHub.number === snap.hub.number;
	const disposed = [
		...new Set([
			...(snap.previous?.disposed ?? []),
			...(closedNow ? prevHub.keys : []),
		]),
	]
		.filter((k) => current.has(k))
		.sort();
	const disposedSet = new Set(disposed);
	/** @type {HubNext} */
	let hub = { action: "none" };
	if (lines.some((l) => !disposedSet.has(l.key)))
		hub = {
			action: "refresh",
			body: buildHubBody({
				repoLines,
				lines,
				owed,
				acts,
				disposed: disposedSet,
			}),
		};
	else if (snap.hub?.state === "open")
		hub = { action: "close", number: snap.hub.number };
	return {
		repoLines,
		lines,
		owed,
		acts,
		filings,
		hub,
		hubKeys: hub.action === "refresh" ? keys : [],
		disposed,
	};
}

/**
 * @param {Act} a
 * @returns {string}
 */
function actText(a) {
	switch (a.kind) {
		case "discharge":
			return `discharged: ${a.repo}#${a.number} (${a.reading})`;
		case "unblock":
			return `cleared: ${a.repo}#${a.number} blocked by ${a.blocker.repo}#${a.blocker.number}, which has closed`;
		case "strip-gate":
			return `cleared: ${a.repo}#${a.number} gated on ${a.blocker}, which has closed`;
		case "release":
			return `released: ${a.repo}#${a.number}, its holder session ${a.sessionId} has ended`;
		case "retag":
			return `retagged containers: ${a.numbers.map((n) => `${a.repo}#${n}`).join(", ")}`;
	}
}

/**
 * @param {string} live
 * @param {string} was
 */
const bodyUnchanged = (live, was) => live.trim() === was.trim();

/**
 * @param {Extract<Act, {kind: "discharge"}>} a
 * @returns {string[][]}
 */
const reopenSteps = (a) =>
	a.closed ? [["reopen"], ["edit", "--remove-label", WATCH_CLOSED_LABEL]] : [];

const KEPT =
	"The issue's body changed after this run read it, so the marker is left for a session to strip.";

/**
 * @param {Act} a
 * @param {{stripped: boolean}} done
 * @returns {{number: number, text: string}|null}
 */
function actComment(a, { stripped }) {
	/** @param {string} text */
	const on = (text) => ("number" in a ? { number: a.number, text } : null);
	switch (a.kind) {
		case "discharge":
			return on(
				`Discharged by the daily stale-ticket run: the gate's \`check:\` reads met — \`${a.reading}\`. ${stripped ? "The `**Gated on:**` marker is stripped." : KEPT}`,
			);
		case "unblock":
			return on(
				`Cleared by the daily stale-ticket run: blocker ${a.blocker.repo}#${a.blocker.number} has closed, so its \`blocked_by\` edge is removed.`,
			);
		case "strip-gate":
			return stripped
				? on(
						`Cleared by the daily stale-ticket run: ${a.blocker} has closed, so the \`**Gated on:**\` marker waiting on it is stripped.`,
					)
				: null;
		case "release":
		case "retag":
			return null;
	}
}

/**
 * @param {Plan} p
 * @param {Snapshot} snap
 * @param {{acts: string[], filings: string[], hub: number|null}} done
 * @returns {RunRow}
 */
function buildRunRow(p, snap, done) {
	const first = new Map(
		(snap.previous?.listed ?? []).map((l) => [l.key, l.firstListed]),
	);
	return {
		date: snap.now,
		repoLines: p.repoLines,
		listed: p.lines.map((l) => ({
			key: l.key,
			cls: l.cls,
			firstListed: first.get(l.key) ?? snap.now,
		})),
		owed: p.owed,
		acts: done.acts,
		filings: done.filings,
		hub: { number: done.hub, keys: p.hubKeys },
		disposed: p.disposed,
		gates: p.gates,
	};
}

/**
 * @param {HubNext} hub
 * @param {{filed: number|null, before: number|null}} at
 * @returns {number|null}
 */
const hubAfter = (hub, { filed, before }) =>
	hub.action === "refresh" ? (filed ?? before) : null;

/**
 * @param {{repoLines: string[], lines: Line[], owed: OwedLine[], acts: Act[],
 *   disposed: Set<string>}} parts
 */
function buildHubBody({ repoLines, lines, owed, acts, disposed }) {
	const byClass = CLASS_ORDER.flatMap((cls) => {
		const ls = lines.filter((l) => l.cls === cls);
		return ls.length === 0
			? []
			: [
					`### ${CLASS_NAMES[cls]}`,
					"",
					...ls.map((l) => `- ${l.text}${disposed.has(l.key) ? "" : " (new)"}`),
					"",
				];
	});
	return [
		"Rewritten once a day by `scripts/stale-ticket-run.js`; edits to this body are overwritten. Close this issue once every line marked (new) is fixed at its cause or filed: the close disposes every line here, and a line returns only when its class changes.",
		"",
		"## Repos",
		"",
		...repoLines.map((l) => `- ${l}`),
		"",
		"## Session-owed lines",
		"",
		...byClass,
		"## Waits no session can clear",
		"",
		...(owed.length === 0 ? ["None."] : owed.map((o) => `- ${o.text}`)),
		"",
		"## Restored this run",
		"",
		...(acts.length === 0 ? ["None."] : acts.map((a) => `- ${actText(a)}`)),
		"",
		buildStandaloneLine(HUB_STANDALONE),
	].join("\n");
}

/** @param {string} sig @param {Line[]} ls */
function buildCauseBody(sig, ls) {
	return [
		`The daily stale-ticket run (\`scripts/stale-ticket-run.js\`) found the cause signature \`${sig}\` on ${ls.length} issues in one run. Fix the cause at its source, so that it stops recurring, rather than each issue in turn.`,
		"",
		"## Issues",
		"",
		...ls.map((l) => `- ${l.text}`),
		"",
		buildStandaloneLine(FILING_STANDALONE),
	].join("\n");
}

/** @param {string} repo @param {SnapIssue} iss @param {string} why */
function buildDataRouteBody(repo, iss, why) {
	return [
		`${repo}#${iss.number}'s ${why}. Build the route that collects the data the gate counts, or re-measure the gate if it counts the wrong thing.`,
		"",
		buildStandaloneLine(FILING_STANDALONE),
	].join("\n");
}

module.exports = {
	FLOOR_DAYS,
	OWED_FLOOR_DAYS,
	HUB_TAKES,
	HUB_TITLE,
	STAMP_ALARM_DAYS,
	actComment,
	actText,
	bodyUnchanged,
	buildRunRow,
	hubAfter,
	planStaleRun,
	reopenSteps,
};
