#!/usr/bin/env node

const { now, runCheck } = require("./lib/check");
const { scriptPath } = require("./lib/script-path.js");

/**
 * @typedef {import("./lib/check").Ctx} Ctx
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
 * @typedef {{type?: string, message: string}} GraphQLError
 */
const { caught } = require("./lib/caught");
const { ghJson, raiseGhFailure } = require("./lib/gh");
const { loadSettledFile } = require("./lib/host-settled-file");
const { requireKey } = require("./lib/workflow-core-config");

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

const SUBSTANTIAL = 40;

const SUSPECT_WINDOW_MIN = 15;

const REV_PAGE = 20;

// measured ~2 s for 25 histories, #1574; BATCH_BYTES a guess, #1628
const BATCH_ISSUES = 25;
const BATCH_BYTES = 4e6;

const REVIEWED_FILE = "docs/clobber-reviewed.json";

/**
 * @param {string} id
 * @returns {{ issue: string, at: string } | null}
 */
function parseIdentity(id) {
	const m = /^(#[1-9]\d*)\t(\S+)$/.exec(id);
	return m?.[1] && m[2] ? { issue: m[1], at: m[2] } : null;
}

/**
 * @param {string} id
 * @returns {string}
 */
const showIdentity = (id) => {
	const parsed = parseIdentity(id);
	return parsed ? `${parsed.issue} at ${parsed.at}` : id;
};

/**
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

/**
 * @param {string|null|undefined} body
 * @returns {string[]}
 */
const lines = (body) =>
	(body || "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

const KEY_LEN = 60;

/** @param {string} l */
const withoutCheckbox = (l) => l.replace(/^-\s*\[[ xX]\]\s*/, "");

/** @param {string} l */
const key = (l) => withoutCheckbox(l).slice(0, KEY_LEN);

/** @param {string|null|undefined} body */
const lineKeysOf = (body) => new Set(lines(body).map(key));

/**
 * @param {string|null|undefined} body
 * @returns {LiveIndex}
 */
const liveIndex = (body) => ({ keys: lineKeysOf(body), lines: lines(body) });

/**
 * @param {string} l
 * @returns {string|null}
 */
const tailKey = (l) => {
	const s = withoutCheckbox(l);
	return s.length >= KEY_LEN * 2 ? s.slice(KEY_LEN, KEY_LEN * 2) : null;
};

/**
 * @param {string} l
 * @param {LiveIndex} live
 */
const isRestored = (l, live) => {
	if (live.keys.has(key(l))) return true;
	const t = tailKey(l);
	return t !== null && live.lines.some((liveLine) => liveLine.includes(t));
};

/**
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

	const added = bLines.filter(
		(l) => l.length >= SUBSTANTIAL && !aText.has(l) && !aKeys.has(key(l)),
	);
	if (added.length === 0) return null;

	const lost = added.filter(
		(l) => !cText.has(l) && !cKeys.has(key(l)) && !isRestored(l, live),
	);
	if (lost.length === 0) return null;

	const aKept =
		aKeys.size > 0
			? [...aKeys].filter((k) => cKeys.has(k)).length / aKeys.size
			: 1;
	const bText = new Set(bLines);
	const cAdded = lines(C.body).filter(
		(l) => l.length >= SUBSTANTIAL && !bText.has(l) && !bKeys.has(key(l)),
	).length;
	const gapMin =
		B.at && C.at
			? (new Date(C.at).getTime() - new Date(B.at).getTime()) / 60_000
			: null;

	const clobbered = lost.length === added.length && aKept >= 0.99 && cAdded > 0;

	if (!clobbered && !(gapMin !== null && gapMin <= SUSPECT_WINDOW_MIN))
		return null;

	return {
		clobbered,
		at: C.at || "the live body",
		gapMin: gapMin === null ? null : Math.round(gapMin * 10) / 10,
		lostLines: lost.length,
		lostChars: lost.reduce((n, l) => n + l.length, 0),
		sample: lost.map((l) => l.slice(0, 120)),
		aKept: Math.round(aKept * 1000) / 1000,
	};
}

const ISSUE_FIELDS =
	"number title url body lastEditedAt updatedAt userContentEdits(first:1){totalCount}";

/** @param {boolean} recentFirst */
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

/**
 * @param {number[]} numbers
 * @param {string} fields
 */
const batchQuery = (numbers, fields) => `query($owner:String!,$repo:String!){
  repository(owner:$owner,name:$repo){
${numbers.map((n) => `    i${n}: issue(number:${n}){ ${fields} }`).join("\n")}
  }
}`;

/**
 * @param {string} query
 * @param {Record<string, string|number>} vars
 * @param {{ notFound?: boolean }} [opts]
 * @returns {any}
 */
function graphql(query, vars, { notFound = false } = {}) {
	const args = ["api", "graphql", "-f", `query=${query}`];
	for (const [k, v] of Object.entries(vars)) args.push("-F", `${k}=${v}`);
	let body;
	try {
		body = ghJson(args);
	} catch (e) {
		const printed = notFound ? parsedOutput(e) : null;
		if (!printed) throw e;
		body = printed;
	}
	const errors = /** @type {GraphQLError[]} */ (
		Array.isArray(body.errors) ? body.errors : []
	).filter((e) => !(notFound && e.type === "NOT_FOUND"));
	if (errors.length === 0) return body.data;

	const reason = errors.map((e) => e.message).join("; ");
	const err = /** @type {Error & {stderr?: string}} */ (
		new Error(`GraphQL: ${reason}`)
	);
	err.stderr = reason;
	throw err;
}

/**
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
		out.set(n, revisions.reverse());
	}
	return out;
}

/**
 * @param {Ctx} ctx
 * @returns {{ all: boolean, days: number, cutoff: Date | null }}
 */
function parseWindow(ctx) {
	const all = ctx.has("--all");
	if (all && ctx.value("--since") !== null)
		ctx.usageError("--since and --all contradict each other; pass one");
	const sinceArg = ctx.value("--since", "30");
	const days = Number(sinceArg);
	if (!Number.isFinite(days) || days <= 0)
		ctx.usageError(`--since needs a positive number of days, got ${sinceArg}`);
	const cutoff = all ? null : new Date(now() - days * 86_400_000);
	return { all, days, cutoff };
}

/**
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
 * @param {IssueNode} i
 * @param {boolean} all
 * @param {Date | null} cutoff
 * @param {Set<number>} rescan
 */
function isCandidate(i, all, cutoff, rescan) {
	if ((i.userContentEdits?.totalCount || 0) < 2) return false;
	if (all || rescan.has(i.number)) return true;
	return (
		i.lastEditedAt && new Date(i.lastEditedAt) >= /** @type {Date} */ (cutoff)
	);
}

/**
 * @param {IssueNode} iss
 * @param {Revision[]} revisions
 * @param {{ clobbered: Row[], suspect: Row[] }} out
 * @returns {number}
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
			"  re-apply through `node " +
			scriptPath("issue-body.js") +
			"`, never a raw body write.\n",
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

/** @param {Row} i */
const identityOf = (i) => `#${i.number}\t${i.at}`;

/**
 * @param {Row[]} rows
 * @param {Map<string, string>} reviewedReasons
 */
function splitKind(rows, reviewedReasons) {
	const reviewed = rows.flatMap((i) => {
		const reason = reviewedReasons.get(identityOf(i));
		return reason === undefined ? [] : [{ ...i, reason }];
	});
	const unreviewed = rows.filter((i) => !reviewedReasons.has(identityOf(i)));
	return { reviewed, unreviewed };
}

/**
 * @param {{ clobbered: Row[], suspect: Row[] }} found
 * @param {Map<string, string>} reviewedReasons
 * @param {IssueNode[]} scannedIssues
 */
function splitReviewed(found, reviewedReasons, scannedIssues) {
	const clobbered = splitKind(found.clobbered, reviewedReasons);
	const suspect = splitKind(found.suspect, reviewedReasons);
	const scanned = new Set(scannedIssues.map((i) => `#${i.number}`));
	const matched = new Set(
		[...clobbered.reviewed, ...suspect.reviewed].map(identityOf),
	);
	const stale = [...reviewedReasons.keys()]
		.filter((id) => {
			const parsed = parseIdentity(id);
			if (!parsed)
				throw new Error(`reviewed id ${JSON.stringify(id)} is no identity`);
			return scanned.has(parsed.issue) && !matched.has(id);
		})
		.sort();
	return { clobbered, suspect, stale };
}

/** @param {Row} i */
const where = (i) =>
	`#${i.number} ${i.title} — ${i.lostChars} chars lost at ${i.at}` +
	(i.gapMin === null ? "" : `, ${i.gapMin} min after the edit it dropped`);

/**
 * @typedef {Row & {reason: string}} ReviewedRow
 * @typedef {{ reviewed: ReviewedRow[], unreviewed: Row[] }} KindSplit
 * @typedef {{ clobbered: KindSplit, suspect: KindSplit, stale: string[] }} Split
 */

/**
 * @param {Split} split
 * @returns {Array<[string, ReviewedRow[]]>}
 */
const reviewedByTag = ({ clobbered, suspect }) => [
	["CLOBBERED-REVIEWED", clobbered.reviewed],
	["SUSPECT-REVIEWED", suspect.reviewed],
];

/**
 * @param {Ctx} ctx
 * @param {Split} split
 */
function raiseFindings(ctx, split) {
	const { clobbered, suspect, stale } = split;
	for (const i of clobbered.unreviewed)
		ctx.fail("CLOBBERED", where(i), i, `CLOBBERED\t${identityOf(i)}`);
	for (const i of suspect.unreviewed)
		ctx.warn("SUSPECT", where(i), i, `SUSPECT\t${identityOf(i)}`);
	for (const [tag, rows] of reviewedByTag(split))
		for (const i of rows)
			ctx.warn(tag, where(i), i, `${tag}\t${identityOf(i)}`);
	for (const id of stale)
		ctx.warn(
			"REVIEWED-STALE",
			`${showIdentity(id)} — ${REVIEWED_FILE} entry matching no finding this run`,
			{ id },
			`REVIEWED-STALE\t${id}`,
		);
}

/**
 * @param {Ctx} ctx
 * @param {Split} split
 */
function reportReviewed(ctx, split) {
	for (const [tag, rows] of reviewedByTag(split)) {
		if (rows.length === 0) continue;
		ctx.say(
			`${tag} (${rows.length}) — judged a deliberate rewrite in ${REVIEWED_FILE}:`,
		);
		for (const i of rows)
			ctx.say(`  #${i.number} ${i.title} at ${i.at}\n      ${i.reason}`);
		ctx.say("  Reported only.\n");
	}
	const { stale } = split;
	if (stale.length > 0) {
		ctx.say(
			`REVIEWED-STALE (${stale.length}) — an entry in ${REVIEWED_FILE} matching no finding on an issue this run scanned:`,
		);
		for (const id of stale) ctx.say(`  ${showIdentity(id)}`);
		ctx.say(
			"  The edit it names no longer reads as CLOBBERED or SUSPECT: its text is\n" +
				"  back. Read the entry before deleting it. Reported only.\n",
		);
	}
}

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
			return raiseGhFailure(e);
		}

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
				return raiseGhFailure(
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

		const split = splitReviewed(
			{ clobbered, suspect },
			reviewedReasons,
			candidates,
		);
		raiseFindings(ctx, split);

		ctx.say(
			`Examined ${transitions} body transition(s) across ${candidates.length} issue(s)` +
				`${all ? " (whole history)" : `, edited in the last ${days} day(s)`}` +
				`${rescan.length > 0 ? ` or among the ${rescan.length} named to re-scan` : ""}.\n`,
		);

		const failing = split.clobbered.unreviewed;
		reportClobbered(ctx, failing);
		reportSuspect(ctx, split.suspect.unreviewed);
		reportReviewed(ctx, split);

		return {
			okLine: `no body lost text to a competing write across ${transitions} transition(s).`,
			noun:
				failing.length > 0
					? "issue body/bodies clobbered by a competing write"
					: "ambiguous transition(s) that lost text",
			data: {
				window: all ? "all" : `${days}d`,
				transitions,
				examined: candidates.length,
				clobbered: failing,
				suspect: split.suspect.unreviewed,
				clobberedReviewed: split.clobbered.reviewed,
				suspectReviewed: split.suspect.reviewed,
				staleReviewed: split.stale,
			},
		};
	},
});
