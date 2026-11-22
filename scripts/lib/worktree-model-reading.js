const { MOVED_LINE } = require("./land-refusal.js");
const { QUEUE_PREFIX, VERIFIED_REF } = require("./landing-refs.js");
const { isUnder, relativeUnder } = require("./is-under.js");
const { escapeRe } = require("./regex-group.js");
const { WORKTREES } = require("./worktree-dirs.js");

const FAST_FORWARD = /^merge [0-9a-f]{40}: Fast-forward$/;
const RECONCILE = [
	/^checkout: moving from \S+ to reconcile-/,
	/^commit \(merge\): .* into reconcile-/,
	/^merge (?:\S+\/)?reconcile-/,
];
const INTO_RECONCILE = / into reconcile-/;
const NOT_MOVED = /^(?:refused: |level main: failed)/;
const HEADER = /^levelling (\S.*)$/;
const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s/;
const LAND = /\bsession-checkout\.js\s+land\b/;
const PUSHED_TO = `pushed ([0-9a-f]{7,40}) to ${escapeRe(QUEUE_PREFIX)}\\S+`;
const MERGED_AND_PUSHED = new RegExp(
	`${PUSHED_TO}, ${escapeRe(VERIFIED_REF)} merged in first`,
);
const PUSHED = new RegExp(PUSHED_TO);
const WEEK_MS = 7 * 24 * 60 * 60_000;
// #4229 guess
const PREDICTED_MERGES = { low: 491, high: 587 };
// #4166 measured on the shared checkout, the same week
const SHARED_MERGES = 436;
const LISTED_PATHS = 20;

/**
 * @typedef {{ since: number, until: number }} Window
 * @typedef {{ t: number, sha: string, msg: string }} ReflogRow
 * @typedef {{ name: string, input: Record<string, unknown>, start: number, end: number, isError: boolean, result: string }} ToolSpan
 * @typedef {{ sha: string, at: number, lagMs: number | null, withinPass: boolean }} Lag
 * @typedef {{ at: number, line: string, root: string | null }} Refusal
 * @typedef {{ where: string, t: number, sha: string, msg: string }} ReconcileEntry
 * @typedef {{ n: number, p50: number | null, p90: number | null, max: number | null }} Spread
 */

/** @param {RegExpExecArray} m @param {number} i @returns {string} */
function group(m, i) {
	const g = m[i];
	if (g === undefined) throw new Error(`no group ${i} in a match of ${m[0]}`);
	return g;
}

/** @param {string} text @returns {ReflogRow[]} */
function parseReflog(text) {
	/** @type {ReflogRow[]} */
	const rows = [];
	for (const line of text.split("\n")) {
		const [sha, selector, ...rest] = line.split("\t");
		const at = /\{(\d+)\}/.exec(selector ?? "");
		if (!sha || !at) continue;
		rows.push({ t: Number(group(at, 1)) * 1000, sha, msg: rest.join("\t") });
	}
	return rows.reverse();
}

/**
 * @template {{ t: number }} T
 * @param {T[]} rows
 * @param {Window} w
 * @returns {T[]}
 */
const inWindow = (rows, w) =>
	rows.filter((r) => r.t >= w.since && r.t < w.until);

/** @param {ReflogRow[]} mainRows */
const foreignMainEntries = (mainRows) =>
	mainRows.filter((r) => !FAST_FORWARD.test(r.msg));

/**
 * @param {ReflogRow[]} moves
 * @param {ReflogRow[]} mainRows
 * @param {(ancestor: string, sha: string) => boolean} isAncestor
 * @param {number} until
 * @returns {Lag[]}
 */
function levelLags(moves, mainRows, isAncestor, until) {
	return moves.map((move, i) => {
		const next = moves[i + 1]?.t ?? until;
		const hit = mainRows.find(
			(r) => r.t >= move.t && isAncestor(move.sha, r.sha),
		);
		const reachedAt = hit ? hit.t : null;
		return {
			sha: move.sha,
			at: move.t,
			lagMs: reachedAt === null ? null : reachedAt - move.t,
			withinPass: reachedAt !== null && reachedAt <= next,
		};
	});
}

/**
 * @param {Iterable<string>} lines
 * @param {Window} w
 * @param {string} root
 * @returns {Refusal[]}
 */
function levellingRefusals(lines, w, root) {
	/** @type {Refusal[]} */
	const found = [];
	let at = Number.NaN;
	/** @type {string | null} */
	let under = null;
	for (const line of lines) {
		const stamp = STAMP.exec(line);
		const header = HEADER.exec(line);
		if (stamp) at = Date.parse(group(stamp, 1));
		else if (header) under = group(header, 1);
		else if (
			at >= w.since &&
			at < w.until &&
			(under === null || under === root) &&
			NOT_MOVED.test(line)
		)
			found.push({ at, line, root: under });
	}
	return found;
}

/** @param {ReflogRow[]} rows */
const reconcileEntries = (rows) =>
	rows.filter((r) => RECONCILE.some((re) => re.test(r.msg)));

/** @param {string} subject */
const isMergeIntoReconcile = (subject) => INTO_RECONCILE.test(subject);

/** @param {unknown} content @returns {string} */
function resultText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => (c && typeof c.text === "string" ? c.text : ""))
		.join("\n");
}

/**
 * @typedef {{ name: string, input: Record<string, unknown>, start: number }} OpenCall
 * @typedef {import("./transcript.js").TranscriptRecord} TranscriptRecord
 * @typedef {import("./transcript.js").TranscriptBlock} TranscriptBlock
 */

/**
 * @param {TranscriptRecord} rec
 * @param {TranscriptBlock} block
 * @param {number} t
 * @param {Map<string, OpenCall>} open
 * @returns {ToolSpan | null}
 */
function pairBlock(rec, block, t, open) {
	if (rec.type === "assistant" && block?.type === "tool_use") {
		open.set(block.id, {
			name: block.name,
			input: block.input ?? {},
			start: t,
		});
		return null;
	}
	if (rec.type !== "user" || block?.type !== "tool_result") return null;
	const call = open.get(block.tool_use_id);
	if (!call) return null;
	open.delete(block.tool_use_id);
	return {
		...call,
		end: t,
		isError: block.is_error === true,
		result: resultText(block.content),
	};
}

/** @param {Iterable<TranscriptRecord>} records @returns {ToolSpan[]} */
function toolSpans(records) {
	/** @type {Map<string, OpenCall>} */
	const open = new Map();
	/** @type {ToolSpan[]} */
	const spans = [];
	for (const rec of records) {
		const t = Date.parse(rec.timestamp);
		const content = rec.message?.content;
		if (Number.isNaN(t) || !Array.isArray(content)) continue;
		for (const block of content) {
			const span = pairBlock(rec, block, t, open);
			if (span) spans.push(span);
		}
	}
	return spans;
}

/**
 * @param {ToolSpan} span
 * @returns {{ kind: "merged", sha: string } | { kind: "pushed" | "moved" | "failed" } | null}
 */
function landingOutcome(span) {
	if (span.name !== "Bash" || !LAND.test(String(span.input.command ?? "")))
		return null;
	if (span.isError)
		return { kind: span.result.includes(MOVED_LINE) ? "moved" : "failed" };
	const m = MERGED_AND_PUSHED.exec(span.result);
	if (m) return { kind: "merged", sha: group(m, 1) };
	return PUSHED.test(span.result) ? { kind: "pushed" } : null;
}

const IN_WORKTREE = new RegExp(`^${escapeRe(WORKTREES)}/[^/]+/(.+)$`);

/** @param {string} root @param {unknown} file @returns {string | null} */
function repoPath(root, file) {
	if (typeof file !== "string") return null;
	const rel = relativeUnder(root, file);
	if (!rel) return null;
	const inWorktree = IN_WORKTREE.exec(rel);
	if (inWorktree) return group(inWorktree, 1);
	return isUnder(rel, [WORKTREES]) ? null : rel;
}

/** @param {number[]} values @returns {Spread} */
function spread(values) {
	const sorted = [...values].sort((a, b) => a - b);
	/** @param {number} q */
	const at = (q) =>
		sorted.length === 0
			? null
			: (sorted[
					Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)
				] ?? null);
	return { n: sorted.length, p50: at(0.5), p90: at(0.9), max: at(1) };
}

/**
 * @typedef {{
 *   main: { rows: ReflogRow[], moves: ReflogRow[], foreign: ReflogRow[], unlanded: string[], lags: Lag[] },
 *   reconcile: { worktrees: number, entries: ReconcileEntry[] },
 *   refusals: Refusal[],
 *   absentLogs: string[],
 *   dirt: { dirty: string[], untracked: number, touched: string[] },
 *   costs: {
 *     transcripts: number, unparsed: number,
 *     edit: Spread, editErrors: number,
 *     mergeToCommit: Spread, mergeCall: Spread, mergeUnread: number,
 *     land: LandCounts,
 *   },
 * }} Reading
 * @typedef {{ name: string, count: number, detail: string }} Check
 * @typedef {{ merged: number, pushed: number, moved: number, failed: number }} LandCounts
 */

/** @param {number | null} ms */
const secs = (ms) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);
/** @param {Spread} s */
const spreadText = (s) =>
	`n ${s.n}, median ${secs(s.p50)}, p90 ${secs(s.p90)}, max ${secs(s.max)}`;
/** @param {number} t */
const iso = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
/** @param {string[]} items */
const indented = (items) => items.map((i) => `\n    ${i}`).join("");

/** @param {Reading} r @returns {Check[]} */
function zeroChecks(r) {
	const { main: m, reconcile, refusals, dirt } = r;
	const missed = m.lags.filter((l) => !l.withinPass);
	const lag = spread(
		m.lags.flatMap((l) => (l.lagMs === null ? [] : [l.lagMs])),
	);
	const unattributed = refusals.filter((f) => f.root === null).length;
	return [
		{
			name: "commits on main not on origin/main",
			count: m.unlanded.length,
			detail: `${m.rows.length} main reflog entries, ${m.foreign.length} not a levelling fast-forward${indented(
				[...m.unlanded, ...m.foreign.map((f) => `${iso(f.t)} ${f.msg}`)],
			)}`,
		},
		{
			name: "origin/main moves main did not reach within one pass",
			count: missed.length,
			detail: `${m.moves.length} moves; lag ${spreadText(lag)}${indented(missed.map((l) => `${l.sha.slice(0, 9)} moved ${iso(l.at)}`))}`,
		},
		{
			name: "reconcile-* merges, and levelling passes that left main unmoved",
			count: reconcile.entries.length + refusals.length,
			detail: `${reconcile.entries.length} reconcile entries across ${reconcile.worktrees} registered worktrees, every branch and every merge's subject; ${refusals.length} not-moved line(s), ${unattributed} from a report naming no checkout${r.absentLogs.length > 0 ? `; no log at ${r.absentLogs.join(", ")}` : ""}${indented(
				[
					...reconcile.entries.map((e) => `${e.where} ${iso(e.t)} ${e.msg}`),
					...refusals.map((f) => `${iso(f.at)} ${f.line}`),
				],
			)}`,
		},
		{
			name: "tracked dirt in the main checkout",
			count: dirt.dirty.length + dirt.touched.length,
			detail: `${dirt.dirty.length} dirty now; ${dirt.touched.length} tracked file(s) written in the window outside a fast-forward; ${dirt.untracked} untracked (not counted)${indented([...dirt.dirty, ...dirt.touched].slice(0, LISTED_PATHS))}`,
		},
	];
}

/** @param {Reading["costs"]} c @param {Window} w */
function landRates(c, w) {
	/** @param {number} n */
	const weekly = (n) => Math.round((n * WEEK_MS) / (w.until - w.since));
	const { merged, pushed, moved } = c.land;
	const landed = merged + pushed;
	const tried = landed + moved;
	const share = tried === 0 ? "—" : `${((100 * moved) / tried).toFixed(1)}%`;
	const { low, high } = PREDICTED_MERGES;
	const rate = weekly(merged);
	let verdict = "within";
	if (rate < low) verdict = "below";
	else if (rate > high) verdict = "above";
	return `landing route a week: ${rate} merged ${VERIFIED_REF} first, of ${weekly(landed)} pushed — ${verdict} the predicted ${low}–${high} (#4229; against ${SHARED_MERGES} merges on the shared checkout); ${weekly(moved)} refused as no fast-forward of the queue ref, ${share} of ${tried} push attempt(s) (#4166: 6% of pushes came under 60 s after another)`;
}

/**
 * @param {Reading} r
 * @param {Window} w
 * @returns {{ text: string, failed: boolean }}
 */
function render(r, w) {
	const checks = zeroChecks(r);
	const c = r.costs;
	const text = [
		`window ${iso(w.since)} to ${iso(w.until)}`,
		...checks.map(
			(k) =>
				`${k.count === 0 ? "PASS" : "FAIL"} ${k.name}: ${k.count} — ${k.detail}`,
		),
		`Edit on a path tracked at ${VERIFIED_REF}, call to result: ${spreadText(c.edit)}; ${c.editErrors} errored Edit(s) left out; over ${c.transcripts} transcripts, ${c.unparsed} unparsable line(s)`,
		`landing merge, call start to merge commit (fetch, merge and gates): ${spreadText(c.mergeToCommit)}; ${c.land.failed + c.land.moved} landing call(s) that errored left out${c.mergeUnread > 0 ? `; ${c.mergeUnread} sha(s) git no longer holds` : ""}`,
		`landing route call that merged, whole (push included): ${spreadText(c.mergeCall)}`,
		landRates(c, w),
	].join("\n");
	return { text, failed: checks.some((k) => k.count !== 0) };
}

module.exports = {
	foreignMainEntries,
	inWindow,
	isMergeIntoReconcile,
	landingOutcome,
	levelLags,
	levellingRefusals,
	parseReflog,
	reconcileEntries,
	render,
	repoPath,
	spread,
	toolSpans,
	zeroChecks,
};
