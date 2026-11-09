/*
 * worktree-model-reading.js — the readings behind scripts/measure-worktree-model.js
 * (#4253): whether the worktree model (#4229) holds over a window, and what an
 * `Edit` and a landing merge cost.
 *
 * Pure over what the CLI read (reflog rows, log lines, transcript records,
 * git's answers).
 */

const { MOVED_LINE } = require("./land-refusal.js");
const { QUEUE_PREFIX, VERIFIED_REF } = require("./landing-refs.js");
const { isUnder, relativeUnder } = require("./is-under.js");

/** A levelling pass's own reflog message on `main` (lib/level-main.js). */
const FAST_FORWARD = /^merge [0-9a-f]{40}: Fast-forward$/;
/* The reflog shapes a reconcile branch leaves in a worktree's HEAD log: a
 * switch onto one, a conflicted merge into one committed by hand, and a merge
 * of one. A commit whose subject merely names one is none of these. */
const RECONCILE = [
	/^checkout: moving from \S+ to reconcile-/,
	/^commit \(merge\): .* into reconcile-/,
	/^merge (?:\S+\/)?reconcile-/,
];
/* The subject git gives a merge into a reconcile branch. */
const INTO_RECONCILE = / into reconcile-/;
/* What a levelling report says when it left main unmoved (lib/level-main.js
 * renderOutcome, scripts/level-main.js). A failed install follows a move, so
 * it is not one. */
const NOT_MOVED = /^(?:refused: |level main: failed)/;
/* The header scripts/level-main.js puts over each report. */
const HEADER = /^levelling (\S.*)$/;
const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s/;
const LAND = /\bsession-checkout\.js\s+land\b/;
/** @param {string} text */
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/* scripts/session-checkout.js's land line, which names the session's queue
 * ref and the verified ref it merged. */
const PUSHED_TO = `pushed ([0-9a-f]{7,40}) to ${escapeRe(QUEUE_PREFIX)}\\S+`;
const MERGED_AND_PUSHED = new RegExp(
	`${PUSHED_TO}, ${escapeRe(VERIFIED_REF)} merged in first`,
);
const PUSHED = new RegExp(PUSHED_TO);
const WEEK_MS = 7 * 24 * 60 * 60_000;
/* #4229's prediction, from #4166's replay: pushes that find `landing` moved
 * and so merge first, a week, at W = 15 to 60 min. */
const PREDICTED_MERGES = { low: 491, high: 587 };
/* #4166's replay of the same week on the shared checkout: merges a push made
 * after finding `landing` moved. */
const SHARED_MERGES = 436;
/* Enough paths to act on; the count carries the rest. */
const LISTED_PATHS = 20;

/**
 * @typedef {{ since: number, until: number }} Window ms
 * @typedef {{ t: number, sha: string, msg: string }} ReflogRow t in ms
 * @typedef {{ name: string, input: Record<string, unknown>, start: number, end: number, isError: boolean, result: string }} ToolSpan
 * @typedef {{ sha: string, at: number, lagMs: number | null, withinPass: boolean }} Lag
 * @typedef {{ at: number, line: string, root: string | null }} Refusal
 *   root null: written before reports named their checkout
 * @typedef {{ where: string, t: number, sha: string, msg: string }} ReconcileEntry
 * @typedef {{ n: number, p50: number | null, p90: number | null, max: number | null }} Spread
 */

/**
 * A capture group the pattern always fills where it matched.
 * @param {RegExpExecArray} m
 * @param {number} i
 * @returns {string}
 */
function group(m, i) {
	const g = m[i];
	if (g === undefined) throw new Error(`no group ${i} in a match of ${m[0]}`);
	return g;
}

/**
 * Rows of `git reflog show --date=unix --format=%H%x09%gd%x09%gs <ref>`,
 * oldest first.
 * @param {string} text
 * @returns {ReflogRow[]}
 */
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

/**
 * Entries on the main checkout's `main` that no levelling pass wrote: anything
 * but a fast-forward.
 * @param {ReflogRow[]} mainRows
 */
const foreignMainEntries = (mainRows) =>
	mainRows.filter((r) => !FAST_FORWARD.test(r.msg));

/**
 * For each move of `origin/main`, when `main` first reached it or a
 * descendant, and whether that came before `origin/main` moved again — each
 * move starts its own levelling pass (lib/level-main.js `startLevelling`), so a move
 * overtaken before main reached it is one that pass did not level.
 * @param {ReflogRow[]} moves origin/main rows in the window
 * @param {ReflogRow[]} mainRows every main row from the window's start on
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
 * The not-moved lines of a log's levelling reports for `root`, in the window.
 * A stamp-less line takes the last stamp above it, and its checkout from the
 * last header; a line under no header yet is kept with a null root, since an
 * older report did not name its checkout. A line before any stamp is dropped:
 * its time is unknown.
 * @param {Iterable<string>} lines
 * @param {Window} w
 * @param {string} root the main checkout measured
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

/**
 * @param {ReflogRow[]} rows a worktree's HEAD reflog
 */
const reconcileEntries = (rows) =>
	rows.filter((r) => RECONCILE.some((re) => re.test(r.msg)));

/**
 * @param {string} subject a merge commit's subject
 */
const isMergeIntoReconcile = (subject) => INTO_RECONCILE.test(subject);

/**
 * @param {unknown} content a tool result's content
 * @returns {string}
 */
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
 * One content block of a record: a call opened, or the span a result closes.
 * accumulator: adds to and removes from `open`, the calls awaiting a result.
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

/**
 * Each tool call of a transcript paired with its result: from the assistant
 * record that asked for it to the user record that answered it.
 * @param {Iterable<TranscriptRecord>} records
 * @returns {ToolSpan[]}
 */
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
 * What a landing route call did: `merged` with the merge commit it pushed
 * (`session-checkout.js land` prints the `HEAD` it pushed, which is the merge
 * of origin/main where it says it merged first), `pushed` where it pushed
 * with no merge, `moved` where its queue ref refused it as no fast-forward
 * (#4446),
 * `failed` where it returned any other error — a conflict, a refused gate —
 * and null where it is no landing route call or landed nothing.
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

/**
 * The repo-relative path an `Edit` wrote, where it is this repo's: under the
 * main checkout or one of its `.claude/worktrees/<name>/` worktrees.
 * @param {string} root the main checkout
 * @param {unknown} file
 * @returns {string | null}
 */
function repoPath(root, file) {
	if (typeof file !== "string") return null;
	const rel = relativeUnder(root, file);
	if (!rel) return null;
	const inWorktree = /^\.claude\/worktrees\/[^/]+\/(.+)$/.exec(rel);
	if (inWorktree) return group(inWorktree, 1);
	return isUnder(rel, [".claude/worktrees"]) ? null : rel;
}

/**
 * Nearest-rank percentiles.
 * @param {number[]} values
 * @returns {Spread}
 */
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
 *   landing route calls by landingOutcome's kind
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

/**
 * The four zero-checks. Check 1 counts commits off origin/main, never reflog
 * entries: a reset to a landed sha writes main but strands nothing, so it is
 * named in the detail and not counted.
 * @param {Reading} r
 * @returns {Check[]}
 */
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

/**
 * The landing route's weekly rates: lands that merged a moved origin/main
 * first, against #4229's prediction, and pushes refused as no fast-forward
 * (#4446),
 * against #4166's race window.
 * @param {Reading["costs"]} c
 * @param {Window} w
 */
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
