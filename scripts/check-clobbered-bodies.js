#!/usr/bin/env node
/*
 * check-clobbered-bodies.js — periodic report on issue bodies where one
 * session's write silently erased another's.
 *
 * Usage:
 *   node check-clobbered-bodies.js [--warn] [--json] [--since <days>]
 *     [--rescan <n,n,…>] [--all]
 *   (--since defaults to 30 days and narrows an ad-hoc run; `npm run
 *    check:clobbers` passes --all, which refuses --since and --rescan; the
 *    daily repo-checks.js run passes a --since that widens across gaps, #1551,
 *    and --rescan, below)
 *
 * A body write is download-whole/upload-whole, so two sessions editing one issue
 * means the second erases the first and GitHub reports success to both. mantahostels#128
 * (the ruling that established there is no conditional write) measured the API's
 * side of it: every conditional-request header is refused outright, GraphQL's
 * updateIssue carries no version field, and `updated_at` has one-second
 * resolution — the race window itself. `scripts/issue-body.js` and its guard
 * `scripts/guard-dispatch.js` (its `guard-issue-body` core) prevent the common spellings; `gh api graphql`
 * with an updateIssue mutation, and any writer outside the local lock, are not
 * covered by either.
 *
 * THE SIGNAL IS A STALE BASE, NOT A SHRINK. "The body got smaller" was the
 * obvious rule and it cries wolf: nearly every shorter body is an ordinary
 * concision pass or fog graduating out of a map (measured at mantahostels#141,
 * the ticket that built this check).
 *
 * What separates a clobber is where the writer's copy came from. For three
 * consecutive body states A -> B -> C, a clobbering C was built on a base
 * fetched before B landed, so:
 *
 *   1. B introduced lines A did not have, and
 *   2. ALL of them are absent from C — absent as text, not merely edited in
 *      place, which is the check that kills most false positives, and
 *   3. all of A survives in C — C's base was A. This is the stale-base test, and
 *   4. C introduced content of its own — a write, not a revert or a deletion.
 *
 * No content-reading detector, for its precision (mantahostels#185, the rule
 * that a close's Outstanding line is checked for presence, never content);
 * these four conditions' false-positive count, and the corpus it was measured
 * on, are at mantahostels#141.
 *
 * A fifth condition decides what is worth SAYING: the vanished text must still
 * be absent from the live body, so a fixed finding goes quiet without anyone
 * recording that it was fixed. That absence is judged on two windows, not one
 * (see `tailKey`).
 *
 * A windowed run judges it only on the issues it scans, and an unfixed finding
 * on an issue nobody edits again falls out of the window. So --rescan names
 * issues to scan whatever their last edit: the daily run passes the issues of
 * its last completed reading's findings (#1573, #1600).
 *
 * What it reports:
 *   CLOBBERED  all four structural conditions, and the text never came back.
 *              Counts toward the exit code.
 *   SUSPECT    text vanished and never came back, but the transition misses a
 *              condition — C dropped some of A too, or kept some of B — AND it
 *              landed within 15 minutes of the edit it dropped. WARN, because
 *              telling a race from a deliberate rewrite is a judgement (the
 *              two on record: mantahostels#302).
 *   SUSPECT-REVIEWED  a SUSPECT judged a deliberate rewrite in the host's
 *              docs/clobber-reviewed.json (#1700). WARN, reported only.
 *   REVIEWED-STALE  an entry in that file matching no SUSPECT on an issue this
 *              run scanned. WARN: the edit it names no longer reads as one.
 *              An entry whose issue went unscanned is not judged.
 *
 * THE REVIEWED FILE IS THE HOST'S OWN, read by lib/host-settled-file.js.
 * Each key is a SUSPECT's identity, `#N<TAB><edit time>`, and each value the
 * reason, so a later SUSPECT on the same issue still reports. A CLOBBERED finding is
 * never accepted.
 *
 * Outside that 15-minute window a partial overlap is an ordinary edit — someone
 * reworking a section a day later — and is not reported at all.
 *
 * THIS SCRIPT NEVER WRITES. Restoring clobbered text means judging whether the
 * lost ruling is still true: the two findings on mantahostels#8 included a doc-map
 * figure to re-derive rather than paste back.
 *
 * Its input is GraphQL `Issue.userContentEdits`: despite the field name, `diff`
 * is the whole body as it stood, newest first. So the text of anything it
 * reports is already in hand.
 *
 * Cost. Histories are fetched up to 25 issues a call (BATCH_ISSUES), fewer
 * where their estimated size would pass BATCH_BYTES, so the cost is the bytes
 * of past bodies, at ~1 MB/s; a windowed listing stops at its cutoff
 * (measured at #1628).
 *
 * A window loses findings outright once runs gap for longer than it, where a
 * whole-history sweep only delays them (#1551). Re-measure when a 30-day
 * window nears 300 s.
 *
 * No incremental per-issue state file (mantahostels#285): it would
 * give up this script's never-writes property, and classifying an A -> B -> C
 * transition needs two full prior bodies per issue, which an editedAt cursor
 * does not supply.
 *
 * Outcomes follow the family alphabet in scripts/lib/check.js: an unreachable
 * GitHub is SKIP (exit 0), any other gh failure BROKEN (exit 2).
 */

const { now, runCheck } = require("./lib/check");

/**
 * One body as some revision left it, the two derivations of the live body a
 * restoration test needs, and one finding.
 *
 * @typedef {import("./lib/check").CheckContext} Ctx
 * @typedef {{at: string|null, body: string|null, live?: boolean}} BodyState
 * @typedef {{editedAt?: string|null, diff?: string|null}} Revision
 * @typedef {{keys: Set<string>, lines: string[]}} LiveIndex
 * @typedef {{clobbered: boolean, at: string, gapMin: number|null,
 *   lostLines: number, lostChars: number, sample: string[],
 *   aKept: number}} Hit
 * @typedef {Hit & {number: number, title: string, url: string}} Row
 * @typedef {{number: number, title: string, url: string, body: string|null,
 *   lastEditedAt: string|null, updatedAt?: string,
 *   userContentEdits?: {totalCount?: number}}} IssueNode
 *   one node of listQuery, the fields it selects
 * @typedef {{type?: string, message: string}} GraphQLError
 *   every error is a map carrying a message (GraphQL spec §7.1.2)
 */
const { caught } = require("./lib/caught");
const { ghJson, raiseGhFailure } = require("./lib/gh");
const { loadSettledFile } = require("./lib/host-settled-file");
const { requireKey } = require("./lib/workflow-core-config");

/* The config's `tracker` as GraphQL variables, read at the first query. */
/** @type {{owner: string, repo: string} | undefined} */
let trackerCache;
const trackerVars = () => {
	if (!trackerCache) {
		const tracker = requireKey("tracker");
		const [owner, repo] = tracker.split("/");
		if (owner === undefined || repo === undefined)
			throw new Error(`the config's tracker "${tracker}" is not owner/name`);
		trackerCache = { owner, repo };
	}
	return trackerCache;
};

/* Lines shorter than this are headings, bullets and separators — shared by every
 * revision of every issue, so they carry no evidence either way and matching on
 * them would make a heading's removal look like lost content. */
const SUBSTANTIAL = 40;

/* How close two edits must be for a PARTIAL overlap to still read as a race —
 * a first cut from three events, not a measurement (mantahostels#141). Only
 * SUSPECT uses it — the four structural conditions need no help from timing. */
const SUSPECT_WINDOW_MIN = 15;

/* Revisions per GraphQL page. Bodies here run to 80 KB, so a page of 100 is a
 * multi-megabyte response for one issue. */
const REV_PAGE = 20;

/* A history call fetches up to BATCH_ISSUES issues' first pages, and stops
 * growing before their estimated size — live body times revisions on that page
 * — would pass BATCH_BYTES; an issue whose estimate alone passes it gets a call
 * to itself (#1628). 25 ordinary histories come back in ~2 s (#1574). The
 * estimate is within 10% of the real response and GitHub serves ~1 MB/s, so
 * 4 MB holds a call near 4 s — a first choice inside that, not a measured
 * limit. */
const BATCH_ISSUES = 25;
const BATCH_BYTES = 4e6;

const REVIEWED_FILE = "docs/clobber-reviewed.json";

/**
 * A finding's identity, as `identityOf` writes it, split back into its
 * issue (`#N`) and edit time; null where `id` is not one.
 *
 * @param {string} id
 * @returns {{ issue: string, at: string } | null}
 */
function parseIdentity(id) {
	const m = /^(#[1-9]\d*)\t(\S+)$/.exec(id);
	return m?.[1] && m[2] ? { issue: m[1], at: m[2] } : null;
}

/** @param {string} id @returns {string} `#N at <edit time>`, for a reader */
const showIdentity = (id) => {
	const parsed = parseIdentity(id);
	return parsed ? `${parsed.issue} at ${parsed.at}` : id;
};

/**
 * The host's reviewed SUSPECTs, identity to reason; empty where it keeps none.
 *
 * @param {Ctx} ctx
 * @returns {Map<string, string>}
 */
function loadReviewed(ctx) {
	const data = loadSettledFile(ctx, {
		file: REVIEWED_FILE,
		keyedBy: "finding",
		entryFault: (id, reason) => {
			if (!parseIdentity(id))
				return `key ${JSON.stringify(id)} is no "#N\\t<edit time>" identity`;
			if (typeof reason !== "string" || reason.trim() === "")
				return `${JSON.stringify(id)} needs a reason`;
			return null;
		},
	});
	return new Map(Object.entries(data).map(([k, v]) => [k, String(v)]));
}

// --- comparing bodies -------------------------------------------------------

/**
 * @param {string|null|undefined} body
 * @returns {string[]}
 */
const lines = (body) =>
	(body || "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

/*
 * A line's identity for matching. Two normalisations:
 *
 *   checkbox state  `- [x] foo` and `- [ ] foo` are the same line ticked and
 *                   unticked. Without this, every tick reads as one line lost
 *                   and another gained.
 *   first 60 chars  an entry edited in place — a resolution line extended, a
 *                   figure corrected — is the same entry, not a loss and an
 *                   unrelated addition.
 */
const KEY_LEN = 60;

/** @param {string} l */
const withoutCheckbox = (l) => l.replace(/^-\s*\[[ xX]\]\s*/, "");

/** @param {string} l */
const key = (l) => withoutCheckbox(l).slice(0, KEY_LEN);

/** @param {string|null|undefined} body */
const lineKeysOf = (body) => new Set(lines(body).map(key));

/**
 * Both derivations `isRestored` needs of the live body, taken once per issue.
 *
 * @param {string|null|undefined} body
 * @returns {LiveIndex}
 */
const liveIndex = (body) => ({ keys: lineKeysOf(body), lines: lines(body) });

/**
 * A second window, KEY_LEN chars in from the start, used ONLY to recognise that
 * a lost line is back in the live body — never in the A/B/C comparison above.
 *
 * Restoring clobbered text routinely rewords its opening, which defeats a
 * first-60-chars match — mantahostels#302, the ticket that found the check FAILing every
 * week on a finding already put right. The number-first citation rule in
 * docs/agents/issue-tracker.md makes that reword compulsory for exactly the
 * Decisions-so-far lines that get clobbered, so "restore it verbatim" is not a
 * route around this.
 *
 * Substring, not equality at a fixed offset: prepending a citation like `#14 — `
 * shifts the rest of the line, so the window is searched for, not indexed to.
 *
 * @param {string} l
 * @returns {string|null}
 */
const tailKey = (l) => {
	const s = withoutCheckbox(l);
	return s.length >= KEY_LEN * 2 ? s.slice(KEY_LEN, KEY_LEN * 2) : null;
};

/** Is a line B introduced and C dropped nonetheless present in the live body? */
/**
 * @param {string} l
 * @param {LiveIndex} live
 */
const isRestored = (l, live) => {
	if (live.keys.has(key(l))) return true;
	const t = tailKey(l);
	return t !== null && live.lines.some((liveLine) => liveLine.includes(t));
};

/** Consecutive body states, oldest first. The newest revision is byte-identical
 *  to the live body, so appending it again would invent an empty transition.
 *
 * @param {Revision[]} revisions
 * @param {string|null} current
 * @returns {BodyState[]}
 */
function bodyStates(revisions, current) {
	/** @type {BodyState[]} */
	const states = revisions.map((r) => ({
		at: r.editedAt ?? null,
		body: r.diff ?? null,
	}));
	const last = states.at(-1);
	if (!last || last.body !== current)
		states.push({ at: null, body: current, live: true });
	return states;
}

/**
 * Classify one A -> B -> C transition. Returns null where nothing vanished.
 * `live` is the live body, so a loss already put back stays silent.
 *
 * @param {BodyState} A
 * @param {BodyState} B
 * @param {BodyState} C
 * @param {LiveIndex} live
 * @returns {Hit|null}
 */
function classify(A, B, C, live) {
	const aText = new Set(lines(A.body));
	const aKeys = lineKeysOf(A.body);
	const bLines = lines(B.body);
	const bKeys = lineKeysOf(B.body);
	const cText = new Set(lines(C.body));
	const cKeys = lineKeysOf(C.body);

	// What B introduced: absent from A both as text and as an edited-in-place line.
	const added = bLines.filter(
		(l) => l.length >= SUBSTANTIAL && !aText.has(l) && !aKeys.has(key(l)),
	);
	if (added.length === 0) return null;

	// Of those, what is gone from C AND still gone today.
	const lost = added.filter(
		(l) => !cText.has(l) && !cKeys.has(key(l)) && !isRestored(l, live),
	);
	if (lost.length === 0) return null;

	const aKept =
		aKeys.size > 0
			? [...aKeys].filter((k) => cKeys.has(k)).length / aKeys.size
			: 1;
	/* Same length floor as `added` above: a new heading or bullet is shared by
	 * every revision of every issue, so it is no evidence that C wrote anything
	 * of its own. */
	const bText = new Set(bLines);
	const cAdded = lines(C.body).filter(
		(l) => l.length >= SUBSTANTIAL && !bText.has(l) && !bKeys.has(key(l)),
	).length;
	const gapMin =
		B.at && C.at
			? (new Date(C.at).getTime() - new Date(B.at).getTime()) / 60_000
			: null;

	/* The four conditions. `aKept` is compared at 0.99 rather than 1 — the
	 * threshold the rule was measured at — so one incidental line, a timestamp or
	 * a count in a heading, does not excuse a clobber of a 300-line map body. */
	const clobbered = lost.length === added.length && aKept >= 0.99 && cAdded > 0;

	if (!clobbered && !(gapMin !== null && gapMin <= SUSPECT_WINDOW_MIN))
		return null;

	return {
		clobbered,
		/* The newest revision is the live body, so a transition ending there has
		 * no edit timestamp of its own. */
		at: C.at || "the live body",
		gapMin: gapMin === null ? null : Math.round(gapMin * 10) / 10,
		lostLines: lost.length,
		lostChars: lost.reduce((n, l) => n + l.length, 0),
		sample: lost.map((l) => l.slice(0, 120)),
		aKept: Math.round(aKept * 1000) / 1000,
	};
}

// --- fetching ---------------------------------------------------------------

const ISSUE_FIELDS =
	"number title url body lastEditedAt updatedAt userContentEdits(first:1){totalCount}";

/** @param {boolean} recentFirst most recently updated first, or GitHub's default */
const listQuery = (
	recentFirst,
) => `query($owner:String!,$repo:String!,$cursor:String){
  repository(owner:$owner,name:$repo){
    issues(first:100, after:$cursor, states:[OPEN,CLOSED]${recentFirst ? ", orderBy:{field:UPDATED_AT, direction:DESC}" : ""}){
      pageInfo{hasNextPage endCursor}
      nodes{ ${ISSUE_FIELDS} }
    }
  }
}`;

const EDITS_PAGE = "pageInfo{hasNextPage endCursor} nodes{ editedAt diff }";

const HISTORY_QUERY = `query($owner:String!,$repo:String!,$n:Int!,$cursor:String!){
  repository(owner:$owner,name:$repo){
    issue(number:$n){ userContentEdits(first:${REV_PAGE}, after:$cursor){ ${EDITS_PAGE} } }
  }
}`;

/* Issue numbers come from GitHub's own listing or --rescan's integer check,
 * so inlining them is safe. */
/**
 * @param {number[]} numbers
 * @param {string} fields what each issue selects
 */
const batchQuery = (numbers, fields) => `query($owner:String!,$repo:String!){
  repository(owner:$owner,name:$repo){
${numbers.map((n) => `    i${n}: issue(number:${n}){ ${fields} }`).join("\n")}
  }
}`;

/**
 * @param {string} query
 * @param {Record<string, string|number>} vars
 * @param {{ notFound?: boolean }} [opts] `notFound` accepts an issue that does
 *   not resolve, leaving its alias null
 * @returns {any} GitHub's own GraphQL `data` object. `any` because the shape is
 *   the query's: each caller destructures the fields its own query selected.
 */
function graphql(query, vars, { notFound = false } = {}) {
	const args = ["api", "graphql", "-f", `query=${query}`];
	for (const [k, v] of Object.entries(vars)) args.push("-F", `${k}=${v}`);
	let body;
	try {
		body = ghJson(args);
	} catch (e) {
		/* gh exits 1 on any GraphQL error, but still prints the response,
		 * whose NOT_FOUND aliases rescanIssues drops (#1600). */
		const printed = notFound ? parsedOutput(e) : null;
		if (!printed) throw e;
		body = printed;
	}
	const errors = /** @type {GraphQLError[]} */ (
		Array.isArray(body.errors) ? body.errors : []
	).filter((e) => !(notFound && e.type === "NOT_FOUND"));
	if (errors.length === 0) return body.data;

	/* GraphQL refuses on a 200 with an `errors` array, so gh exits 0 and nothing
	 * reaches stderr — an unchecked read reports "nothing found" over data GitHub
	 * declined to serve.
	 *
	 * The reason goes on `.stderr` because that is the only field
	 * parseGhFailureReason() reads, deliberately: e.message carries the whole argv, so
	 * a query whose own text says "rate limit" would classify itself. Putting it
	 * there is what lets a rate-limited sweep SKIP rather than report this
	 * checker broken. */
	const reason = errors.map((e) => e.message).join("; ");
	const err = /** @type {Error & {stderr?: string}} */ (
		new Error(`GraphQL: ${reason}`)
	);
	err.stderr = reason;
	throw err;
}

/**
 * The response a failed gh call printed, where it is one carrying `data`.
 *
 * @param {unknown} e
 * @returns {{data: unknown, errors?: unknown} | null}
 */
function parsedOutput(e) {
	try {
		const body = JSON.parse(caught(e).stdout ?? "");
		return body?.data ? body : null;
	} catch {
		return null;
	}
}

/**
 * Pages a listing until its end, or until a page's last node `isPast`.
 *
 * @param {string} query
 * @param {(node: IssueNode) => boolean} isPast
 * @returns {IssueNode[]}
 */
function listing(query, isPast) {
	/** @type {IssueNode[]} */
	const out = [];
	/** @type {string|null} */
	let cursor = null;
	do {
		const d = graphql(
			query,
			cursor ? { ...trackerVars(), cursor } : trackerVars(),
		);
		const conn = d.repository.issues;
		out.push(...conn.nodes);
		const last = conn.nodes.at(-1);
		cursor =
			conn.pageInfo.hasNextPage && !(last && isPast(last))
				? conn.pageInfo.endCursor
				: null;
	} while (cursor);
	return out;
}

/**
 * The issues updated since `cutoff`, most recent first (#1628).
 *
 * The listing stops at the first page reaching past the cutoff: `updatedAt` is
 * never earlier than `lastEditedAt`, so nothing beyond it is a candidate. An
 * issue updated while it pages jumps to the front, already passed — and a
 * comment moves it without moving `lastEditedAt`, so the next run's narrower
 * window may never reach it. So the top is listed again, down to the newest
 * update the first pass saw, and the two merged by number.
 *
 * @param {Date} cutoff
 * @returns {IssueNode[]}
 */
function recentIssues(cutoff) {
	const query = listQuery(true);
	const first = listing(query, (n) => new Date(n.updatedAt ?? 0) < cutoff);
	const newest = new Date(first[0]?.updatedAt ?? 0);
	const moved = listing(query, (n) => new Date(n.updatedAt ?? 0) < newest);
	return [...new Map([...first, ...moved].map((i) => [i.number, i])).values()];
}

/**
 * The tracker's issues — under a cutoff, only as far back as it. `--all`
 * keeps GitHub's default order, which no update reorders.
 *
 * @param {Ctx} ctx
 * @param {Date | null} cutoff
 * @returns {IssueNode[]}
 */
function allIssues(ctx, cutoff) {
	const out = cutoff
		? recentIssues(cutoff)
		: listing(listQuery(false), () => false);
	ctx.say(`Read ${out.length} issue(s).`);
	return out;
}

/**
 * The --rescan issues the listing did not reach, fetched by number,
 * BATCH_ISSUES a call: each selects its body, so the history calls' bound
 * holds. One that no longer resolves — deleted, or transferred away — is
 * named and dropped (#1600): its finding leaves the next completed
 * reading's keys, and with them the re-scan list, so a transferred issue's
 * unfixed clobber is never reported again.
 *
 * @param {Ctx} ctx
 * @param {number[]} numbers
 * @param {IssueNode[]} listed
 * @returns {IssueNode[]}
 */
function rescanIssues(ctx, numbers, listed) {
	const have = new Set(listed.map((i) => i.number));
	const missing = numbers.filter((n) => !have.has(n));
	/** @type {IssueNode[]} */
	const out = [];
	for (let k = 0; k < missing.length; k += BATCH_ISSUES) {
		const chunk = missing.slice(k, k + BATCH_ISSUES);
		const d = graphql(batchQuery(chunk, ISSUE_FIELDS), trackerVars(), {
			notFound: true,
		});
		for (const n of chunk) {
			const node = d.repository[`i${n}`];
			if (node) out.push(node);
			else ctx.say(`#${n} no longer resolves, so it is not re-scanned.`);
		}
	}
	return out;
}

/**
 * Candidates grouped into history calls, in order — see BATCH_ISSUES.
 *
 * @param {IssueNode[]} issues
 * @returns {IssueNode[][]}
 */
function batches(issues) {
	/** @type {IssueNode[][]} */
	const out = [];
	/** @type {IssueNode[]} */
	let group = [];
	let bytes = 0;
	for (const iss of issues) {
		const est =
			(iss.body?.length ?? 0) *
			Math.min(iss.userContentEdits?.totalCount ?? 0, REV_PAGE);
		if (
			group.length > 0 &&
			(group.length === BATCH_ISSUES || bytes + est > BATCH_BYTES)
		) {
			out.push(group);
			group = [];
			bytes = 0;
		}
		group.push(iss);
		bytes += est;
	}
	if (group.length > 0) out.push(group);
	return out;
}

/**
 * Every past body of each issue, oldest first. One call takes every issue's
 * first page; an issue with more is paged on alone.
 *
 * @param {number[]} numbers
 * @returns {Map<number, Revision[]>}
 */
function historiesOf(numbers) {
	const d = graphql(
		batchQuery(numbers, `userContentEdits(first:${REV_PAGE}){ ${EDITS_PAGE} }`),
		trackerVars(),
	);
	const out = new Map();
	for (const n of numbers) {
		let conn = d.repository[`i${n}`].userContentEdits;
		const revisions = [...conn.nodes];
		while (conn.pageInfo.hasNextPage) {
			conn = graphql(HISTORY_QUERY, {
				...trackerVars(),
				n,
				cursor: conn.pageInfo.endCursor,
			}).repository.issue.userContentEdits;
			revisions.push(...conn.nodes);
		}
		out.set(n, revisions.reverse()); // the API is newest-first
	}
	return out;
}

/**
 * The --since/--all window: whole history, or issues edited since `cutoff`.
 *
 * @param {Ctx} ctx
 * @returns {{ all: boolean, days: number, cutoff: Date | null }}
 */
function parseWindow(ctx) {
	const all = ctx.has("--all");
	/* Refused rather than ignored, because `npm run check:clobbers` passes
	 * --all: `npm run check:clobbers -- --since 7` reads like a narrowed run
	 * and would silently be a full one. */
	if (all && ctx.value("--since") !== null)
		ctx.usageError("--since and --all contradict each other; pass one");
	const sinceArg = ctx.value("--since", "30");
	const days = Number(sinceArg);
	if (!Number.isFinite(days) || days <= 0)
		ctx.usageError(`--since needs a positive number of days, got ${sinceArg}`);
	/* Unread on the --all path, so a malformed WFC_NOW must not reach
	 * now() there — an --all run would otherwise go BROKEN over a clock value
	 * it never consults. */
	const cutoff = all ? null : new Date(now() - days * 86_400_000);
	return { all, days, cutoff };
}

/**
 * --rescan's issue numbers, or none.
 *
 * @param {Ctx} ctx
 * @param {boolean} all
 * @returns {number[]}
 */
function parseRescan(ctx, all) {
	const arg = ctx.value("--rescan");
	if (arg === null) return [];
	if (all)
		ctx.usageError(
			"--rescan and --all contradict each other: --all already scans every issue; pass one",
		);
	const numbers = arg.split(",").map(Number);
	if (!numbers.every((n) => Number.isInteger(n) && n > 0))
		ctx.usageError(`--rescan needs issue numbers, comma-separated, got ${arg}`);
	return [...new Set(numbers)];
}

/**
 * Whether an issue has a transition to examine, inside the window or named
 * by --rescan.
 *
 * @param {IssueNode} i
 * @param {boolean} all
 * @param {Date | null} cutoff
 * @param {Set<number>} rescan
 */
function isCandidate(i, all, cutoff, rescan) {
	if ((i.userContentEdits?.totalCount || 0) < 2) return false;
	if (all || rescan.has(i.number)) return true;
	// cutoff is set whenever !all (the branch above returns first otherwise).
	return (
		i.lastEditedAt && new Date(i.lastEditedAt) >= /** @type {Date} */ (cutoff)
	);
}

/**
 * Walks one issue's body history, pushing each lossy transition to `out`.
 *
 * @param {IssueNode} iss
 * @param {Revision[]} revisions oldest first
 * @param {{ clobbered: Row[], suspect: Row[] }} out accumulator: one list per
 *   finding kind
 * @returns {number} the transitions examined
 */
function scanIssue(iss, revisions, out) {
	let transitions = 0;
	const states = bodyStates(revisions, iss.body);
	const live = liveIndex(iss.body);
	/** @type {BodyState | undefined} */
	let twoBack;
	/** @type {BodyState | undefined} */
	let oneBack;
	for (const state of states) {
		const [a, b] = [twoBack, oneBack];
		twoBack = oneBack;
		oneBack = state;
		if (!a || !b) continue;
		transitions++;
		const hit = classify(a, b, state, live);
		if (!hit) continue;
		const row = {
			number: iss.number,
			title: iss.title,
			url: iss.url,
			...hit,
		};
		(hit.clobbered ? out.clobbered : out.suspect).push(row);
	}
	return transitions;
}

/**
 * @param {Ctx} ctx
 * @param {Row[]} clobbered
 */
function reportClobbered(ctx, clobbered) {
	if (clobbered.length === 0) return;
	ctx.say(
		`CLOBBERED (${clobbered.length}) — one write erased another, and the text never came back:`,
	);
	for (const i of clobbered) {
		ctx.say(`  #${i.number} ${i.title}\n    ${i.url}`);
		ctx.say(
			`    ${i.lostChars} chars in ${i.lostLines} line(s), overwritten ${i.at}` +
				(i.gapMin === null
					? ""
					: ` — ${i.gapMin} min after the edit it dropped`),
		);
		for (const s of i.sample) ctx.say(`      lost: ${s}`);
	}
	ctx.say(
		"\n  The full text is recoverable — every past body is in GraphQL\n" +
			"  Issue.userContentEdits, whose `diff` field is the whole body, newest\n" +
			"  first. Take the revision immediately before the timestamp above.\n" +
			"  Judge whether each lost ruling still holds before restoring it, and\n" +
			"  re-apply through `node scripts/issue-body.js`, never a raw body write.\n",
	);
}

/**
 * @param {Ctx} ctx
 * @param {Row[]} suspect
 */
function reportSuspect(ctx, suspect) {
	if (suspect.length === 0) return;
	ctx.say(
		`SUSPECT (${suspect.length}) — text vanished in a close-following edit, but the transition is ambiguous:`,
	);
	for (const i of suspect) {
		ctx.say(
			`  #${i.number} ${i.title} — ${i.lostChars} chars at ${i.at}, ${i.gapMin} min after; ${Math.round(i.aKept * 100)}% of the older body kept`,
		);
		for (const s of i.sample) ctx.say(`      lost: ${s}`);
	}
	ctx.say(
		"  Either a race or a deliberate rewrite — indistinguishable from here.\n" +
			"  Reported only.\n",
	);
}

/* `at` is the transition's own timestamp, so it identifies the EVENT. The
 * chars lost and the gap are re-derived every run and stay out of the key
 * (mantahostels#2490). */
/** @param {Row} i */
const identityOf = (i) => `#${i.number}\t${i.at}`;

/**
 * The SUSPECTs the host reviewed, with their reasons, those it did not, and
 * its entries matching no SUSPECT on an issue this run scanned.
 *
 * @param {Row[]} suspect
 * @param {Map<string, string>} reviewedReasons
 * @param {IssueNode[]} scannedIssues
 */
function splitReviewed(suspect, reviewedReasons, scannedIssues) {
	const reviewed = suspect.flatMap((i) => {
		const reason = reviewedReasons.get(identityOf(i));
		return reason === undefined ? [] : [{ ...i, reason }];
	});
	const unreviewed = suspect.filter((i) => !reviewedReasons.has(identityOf(i)));
	const scanned = new Set(scannedIssues.map((i) => `#${i.number}`));
	const matched = new Set(reviewed.map(identityOf));
	const stale = [...reviewedReasons.keys()]
		.filter((id) => {
			const parsed = parseIdentity(id);
			/* loadReviewed refuses an id that will not parse. */
			if (!parsed)
				throw new Error(`reviewed id ${JSON.stringify(id)} is no identity`);
			return scanned.has(parsed.issue) && !matched.has(id);
		})
		.sort();
	return { reviewed, unreviewed, stale };
}

/** @param {Row} i */
const where = (i) =>
	`#${i.number} ${i.title} — ${i.lostChars} chars lost at ${i.at}` +
	(i.gapMin === null ? "" : `, ${i.gapMin} min after the edit it dropped`);

/**
 * @param {Ctx} ctx
 * @param {{ clobbered: Row[], unreviewed: Row[],
 *   reviewed: (Row & {reason: string})[], stale: string[] }} opts
 */
function raiseFindings(ctx, { clobbered, unreviewed, reviewed, stale }) {
	for (const i of clobbered)
		ctx.fail("CLOBBERED", where(i), i, `CLOBBERED\t${identityOf(i)}`);
	for (const i of unreviewed)
		ctx.warn("SUSPECT", where(i), i, `SUSPECT\t${identityOf(i)}`);
	for (const i of reviewed)
		ctx.warn(
			"SUSPECT-REVIEWED",
			where(i),
			i,
			`SUSPECT-REVIEWED\t${identityOf(i)}`,
		);
	for (const id of stale)
		ctx.warn(
			"REVIEWED-STALE",
			`${showIdentity(id)} — ${REVIEWED_FILE} entry matching no SUSPECT this run`,
			{ id },
			`REVIEWED-STALE\t${id}`,
		);
}

/**
 * @param {Ctx} ctx
 * @param {{ reviewed: (Row & {reason: string})[], stale: string[] }} opts
 */
function reportReviewed(ctx, { reviewed, stale }) {
	if (reviewed.length > 0) {
		ctx.say(
			`SUSPECT-REVIEWED (${reviewed.length}) — judged a deliberate rewrite in ${REVIEWED_FILE}:`,
		);
		for (const i of reviewed)
			ctx.say(`  #${i.number} ${i.title} at ${i.at}\n      ${i.reason}`);
		ctx.say("  Reported only.\n");
	}
	if (stale.length > 0) {
		ctx.say(
			`REVIEWED-STALE (${stale.length}) — an entry in ${REVIEWED_FILE} matching no SUSPECT on an issue this run scanned:`,
		);
		for (const id of stale) ctx.say(`  ${showIdentity(id)}`);
		ctx.say(
			"  The edit it names no longer reads as SUSPECT: its text is back, or it is\n" +
				"  now CLOBBERED. Read the entry before deleting it. Reported only.\n",
		);
	}
}

// --- the check --------------------------------------------------------------

runCheck({
	name: "clobbered-bodies",
	usage:
		"node check-clobbered-bodies.js [--warn] [--json] [--since <days>] [--rescan <n,n,…>] [--all]",
	valueFlags: ["--since", "--rescan"],
	flags: ["--all"],
	run(/** @type {Ctx} */ ctx) {
		const { all, days, cutoff } = parseWindow(ctx);
		const rescan = parseRescan(ctx, all);
		const reviewedReasons = loadReviewed(ctx);

		let issues;
		try {
			issues = allIssues(ctx, cutoff);
			issues.push(...rescanIssues(ctx, rescan, issues));
		} catch (e) {
			raiseGhFailure(e);
		}

		/* Two states make no transition, so an issue needs at least two recorded
		 * edits before there is anything to compare. */
		const rescanSet = new Set(rescan);
		const candidates = issues.filter((i) =>
			isCandidate(i, all, cutoff, rescanSet),
		);

		/** @type {Row[]} */
		const clobbered = [];
		/** @type {Row[]} */
		const suspect = [];
		let transitions = 0;

		for (const group of batches(candidates)) {
			let histories;
			try {
				histories = historiesOf(group.map((i) => i.number));
			} catch (e) {
				raiseGhFailure(
					e,
					`${group.map((i) => `#${i.number}`).join(", ")} not examined.`,
				);
			}
			for (const iss of group) {
				const revisions = histories.get(iss.number);
				if (!revisions)
					throw new Error(`#${iss.number}'s history was not in its batch`);
				transitions += scanIssue(iss, revisions, { clobbered, suspect });
			}
		}

		const { reviewed, unreviewed, stale } = splitReviewed(
			suspect,
			reviewedReasons,
			candidates,
		);
		raiseFindings(ctx, { clobbered, unreviewed, reviewed, stale });

		ctx.say(
			`Examined ${transitions} body transition(s) across ${candidates.length} issue(s)` +
				`${all ? " (whole history)" : `, edited in the last ${days} day(s)`}` +
				`${rescan.length > 0 ? ` or among the ${rescan.length} named to re-scan` : ""}.\n`,
		);

		reportClobbered(ctx, clobbered);
		reportSuspect(ctx, unreviewed);
		reportReviewed(ctx, { reviewed, stale });

		return {
			okLine: `no body lost text to a competing write across ${transitions} transition(s).`,
			noun:
				clobbered.length > 0
					? "issue body/bodies clobbered by a competing write"
					: "ambiguous transition(s) that lost text",
			data: {
				window: all ? "all" : `${days}d`,
				transitions,
				examined: candidates.length,
				clobbered,
				suspect: unreviewed,
				reviewed,
				staleReviewed: stale,
			},
		};
	},
});
