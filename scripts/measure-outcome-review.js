#!/usr/bin/env node
/*
 * measure-outcome-review.js — the outcome review of fault-stopping changes,
 * retro-sweep weekly mode's step (spec #4796 §Outcome review, ticket #4797).
 * It gives every verdict; the retro copies `--json` into its run line's
 * `outcomes[]` and never overrides one.
 *
 * IN NO §N3 FAMILY: it gates nothing, writes no file and files no issue (the
 * retro files the unwinds).
 *
 * THE REPOS read are `--root` and every repo root a seat's session ran in
 * (lib/session-head.js's repoRootOf on its cwd) holding a workflow-core
 * config. Each is read for its config's tracker; where two roots
 * resolve to one tracker, the one whose origin/main was updated last is read.
 * Each repo's origin/main is read as last fetched, never fetched here: a ref
 * with no update in the STALE_REF_HOURS to `now` is a failed read for its
 * tracker.
 *
 * FINDINGS are every line of each repo's signature log (lib/fault-signature.js's
 * SIGNATURE_LOG, read from origin/main, never the working tree; an absent log
 * is no lines) with a signature, and every `findings[]` entry with an issue
 * and a signature on a weekly run line (`--root`'s docs/data/retro-runs.jsonl).
 * A finding in both is read once, as the run record has it; one in two logs,
 * as the first log read has it, with a note. A late line is reported apart
 * throughout. A finding whose tracker has no repo read waits, a failed read.
 * A signature lib/fault-signature.js's `checkSignature` refuses, or a stored
 * baseline that is not `{count, sessions}`, is a failure named; the finding is
 * not read, or its baseline is counted here.
 *
 * A DUPLICATE log line for one issue is one finding where the lines are
 * identical; differing lines are a conflict, listed and given no verdict,
 * never one silently picked.
 *
 * SETTLED: a finding a prior run line gave `keep` or `unwind` is not read
 * again; it is listed as settled. An unwind carried past the cap stays in the
 * ranking (below) until filed.
 *
 * THE FIX is derived here, never stored: the finding issue must be closed, and
 * its fix is the latest commit on any repo's `origin/main` whose message cites
 * it — `#<n>` word-bounded where the finding is that repo's tracker's, or
 * `<owner/name>#<n>` anywhere. Either missing, the verdict is `waiting`. The
 * first reading is at the first run INTERVAL_DAYS or more after the fix's
 * commit date.
 *
 * THE BASELINE is the run record's own, where it holds one; otherwise it is
 * worked out here: the hits per session over the BASELINE_WEEKS before the
 * trigger week, i.e. sessions whose first record falls in
 * [filedAt − (BASELINE_WEEKS + 1) weeks, filedAt − 1 week). A session is its
 * main log, one copy across every seat (lib/project-dirs.js
 * readSeatTranscripts, every repo's sessions), with its subagent logs folded
 * under it; hits are lib/fault-signature.js's `signatureHits` on each file's
 * tier.
 *
 * THE WINDOW is the sessions starting after the fix, in time order, grown
 * until rate × sessions reaches EXPECTED_FLOOR or the sessions run out at
 * `now`. A finding a prior run extended reads every session from the fix to
 * `now`.
 * `expected` is rate × sessions, `observed` the hits in them.
 *
 * VERDICTS: guardrail harm (a revert of the fix on its repo's origin/main, or
 * a `bug` issue in any tracker read, filed after the fix, that cites the
 * finding or the fix sha) is
 * `unwind`, whatever the counts. With expected ≥ EXPECTED_FLOOR, `keep` where
 * Poisson P(X ≤ observed | expected) ≤ KEEP_P, `unwind` where observed ≥
 * expected, else `extend`. Under EXPECTED_FLOOR it is `extend`. A finding a
 * prior run already extended, read inconclusive again, is `unwind`.
 *
 * UNWINDS are ranked harm first, then observed ÷ expected, highest first; the
 * top UNWIND_CAP are to file this run and the rest are carried. The prior run
 * line's `outcomeStep.backlog` joins the ranking and is never dropped.
 *
 * MISSES, the backstop for a signature never declared: each tracker's tickets
 * closed in the MISS_DAYS to `now` that landed a commit on its own repo's
 * origin/main citing them, carry
 * `bug` or a FAULT_SHAPE title or closing-commit subject, have no line in
 * either record, and carry no origin a script files under (lib/issue-origin.js
 * SCRIPT_ORIGINS, which declare `--no-fault` in code): a ticket filed past
 * file-issue.js's declarations, or a session's `--no-fault` on a fault, so no
 * fault ticket escapes review by omission. Every other ticket with an
 * `origin:*` label and no line closed in the same days and carrying `bug` is
 * listed apart, as the declaration to doubt.
 *
 * LOST LINES: a closed ticket carrying lib/signature-label.js's label, closed
 * at any date, owes a line; one with none in either record is listed every run
 * until one lands, with the line its body section records or UNRECOVERABLE,
 * for the retro to restore (#4861). It is neither a miss nor a no-fault bug.
 *
 * BASELINE MODE (`--baseline <signature file> --filed-at <iso>`) gives a
 * finding's baseline at filing, for the retro's `findings[].baseline`: the
 * same count over the same BASELINE_WEEKS before the trigger week, the file
 * checked as file-issue.js checks it. `null` for a `"signature": null` file.
 *
 * THE FLIP CHECK is due once FLIP_RUNS weekly runs, this one included, reached
 * a verdict other than `waiting`; earlier where this run's carried backlog is
 * over FLIP_BACKLOG, or FLIP_OVER_BUDGET_RUNS run lines spent over
 * TOKEN_BUDGET on the step. `flipDue.bars` are DROP_BARS, for the filed check
 * to judge.
 *
 * A read that fails is named and never counted as zero: a reading that needs
 * it is `waiting`, its `why` naming the failure, and the run exits 1. A seat
 * that does not exist is noted, not failed. Exit 2 for a command line
 * lib/cli-args.js refuses, no tracker, or a signature file refused.
 */

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const path = require("node:path");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { writeFd } = require("./lib/write-fd.js");
const { caught } = require("./lib/caught.js");
const { parseJsonl, parseJsonlRow, readJsonl } = require("./lib/jsonl.js");
const { now: clockNow } = require("./lib/check");
const { ghIssueListAll, ghJson, parseErrLine } = require("./lib/gh");
const { gitOutcome } = require("./lib/git");
const { hostRoot } = require("./lib/host-root");
const { configDirs } = require("./lib/arbiter-store");
const { readSeatTranscripts } = require("./lib/project-dirs");
const { readSessionHead, repoRootOf } = require("./lib/session-head");
const { hasConfig, requireKey } = require("./lib/workflow-core-config");
const { isScriptOrigin, originOfLabels } = require("./lib/issue-origin");
const { asObject, objectsIn, stringMembers } = require("./lib/json-shape");
const { parseQualifiedRef } = require("./lib/issue-ref");
const { readNeedles, readSubagentFiles } = require("./lib/guard-fires");
const { subagentDirOf } = require("./lib/transcript");
const { escapeRe, requiredGroup } = require("./lib/regex-group");
const {
	SIGNATURE_LOG,
	checkSignature,
	readDeclared,
	parseSignatureSection,
	signatureHits,
} = require("./lib/fault-signature");
const { RUN_RECORD } = require("./lib/retro-record");
const { SIGNATURE_LABEL } = require("./lib/signature-label");
const { canonicalJson } = require("./lib/canonical-json");

/* ---- Constants. The spec's values are untraced (#4796 §Values); the rest
 * are this script's own judgement. ---- */

const DAY_MS = 86_400_000;
/** The trigger week, never part of the baseline. */
const TRIGGER_DAYS = 7;
/** The baseline's span before the trigger week (#4796: 4 weeks). */
const BASELINE_WEEKS = 4;
/** Days after the fix's commit before the first reading (#4796). */
const INTERVAL_DAYS = 7;
/** Expected recurrences the window grows to (#4796: 3). */
const EXPECTED_FLOOR = 3;
/** Poisson P(X ≤ observed | expected) at or under which the count fell. */
const KEEP_P = 0.05;
/** Unwind tickets to file a run (#4796). */
const UNWIND_CAP = 5;
/** The miss backstop's look-back. */
const MISS_DAYS = 7;
/** Words that make a closed ticket's title or closing subject fault-shaped. */
const FAULT_SHAPE =
	/\b(?:fix(?:es|ed|ing)?|stop(?:s|ped|ping)?|prevent(?:s|ed|ing)?|fail(?:s|ed|ing|ure|ures)?|broke|broken|crash(?:es|ed|ing)?|stall(?:s|ed|ing)?|drop(?:s|ped|ping)?|leak(?:s|ed|ing)?|wrong(?:ly)?|regress(?:es|ed|ion|ions)?|bug(?:s|gy)?|hang(?:s|ing)?|stuck|misses|missed|race)\b/i;
/** Weekly runs reaching a verdict before the flip check is due (#4796). */
const FLIP_RUNS = 4;
/** A carried backlog over this brings the flip check forward (#4796). */
const FLIP_BACKLOG = 10;
/** The step's token budget a run (#4796: 30k). */
const TOKEN_BUDGET = 30_000;
/** Runs over the budget that bring the flip check forward (#4796). */
const FLIP_OVER_BUDGET_RUNS = 2;
/** The flip check's bars: the review drops to on-demand where any holds
 * (#4796 §Outcome review). */
const DROP_BARS = [
	"fewer than half of the closed unwind tickets landed a revert that held 14 days",
	"any unwound change was landed again",
	"fewer than 5 verdicts were reached",
];

/** Hours without an update after which a repo's origin/main is stale (#4858:
 * untraced, a guess). How often an adopter's ref really moves is unmeasured,
 * and #4872 weighs it. */
const STALE_REF_HOURS = 24;
/** Bytes read from a transcript's head to find its first timestamp. */
const START_PROBE_BYTES = 65_536;

const USAGE = `usage: node ${scriptPath("measure-outcome-review.js")} [--now <iso>] [--json] [--root <dir>] [--config-dir <dir>]...
       node ${scriptPath("measure-outcome-review.js")} --baseline <signature file> --filed-at <iso> [--json] [--root <dir>] [--config-dir <dir>]...
  --now         the reading instant (default: WFC_NOW, else the clock)
  --baseline    a finding's signature file: print its baseline at filing
  --filed-at    with --baseline, when the finding was filed
  --json        the report as JSON, for the retro's run line
  --root        the repo whose ${RUN_RECORD} is read, first of the repos read (default: this host)
  --config-dir  a seat to read transcripts and repos from, repeatable (default: every seat)`;

/**
 * @typedef {import("./lib/fault-signature").Signature} Signature
 * @typedef {import("./lib/fault-signature").Registry} Registry
 * @typedef {import("./lib/fault-signature").Row} Row  a run record or log
 *   line, or a prior outcome read back from one
 * @typedef {{count: number, sessions: number}} Baseline  kept as counts, the
 *   rate worked out from them at each reading: a rare fault's rate rounded
 *   would read as 0
 * @typedef {{ref: string, repo: string, number: number, filedAt: number,
 *   signature: Signature, baseline: Baseline | null, late: boolean}} Finding
 * @typedef {{sha: string, at: number, subject: string, message: string}} Commit
 * @typedef {{number: number, title: string, body?: string, createdAt?: string,
 *   closedAt?: string, labels: Array<{name: string}>}} IssueRow
 * @typedef {{followOns: string[], reverts: string[]}} Guardrails
 * @typedef {"waiting" | "keep" | "extend" | "unwind"} Verdict
 * @typedef {{finding: string, fixSha: string | null, fixAt: string | null,
 *   window: {start: string, end: string} | null, sessions: number | null,
 *   observed: number | null, expected: number | null,
 *   guardrails: Guardrails | null, verdict: Verdict, unwindIssue: null,
 *   late: boolean, baseline: Baseline | null, why: string}} Outcome
 * @typedef {{file: string, start: number}} Session
 * @typedef {{tracker: string, root: string, sha: string | null,
 *   refAt: number | null, commits: Commit[] | string, sigRows: Row[]}} Repo
 *   `commits` is why they would not read, where they would not
 */

const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
const day = (/** @type {number} */ ms) => iso(ms).slice(0, 10);
const round3 = (/** @type {number} */ x) => Math.round(x * 1000) / 1000;
/** Hits per session. */
const rateOf = (/** @type {Baseline} */ b) =>
	b.sessions > 0 ? b.count / b.sessions : 0;

/** @param {unknown} v @returns {number | null} */
const numberOf = (v) =>
	typeof v === "number" && Number.isFinite(v) ? v : null;
/** @param {unknown} v */
const isCount = (v) => Number.isInteger(v) && Number(v) >= 0;

/**
 * A stored baseline, or null where it is not one.
 * @param {unknown} v
 * @returns {Baseline | null}
 */
function parseBaseline(v) {
	const b = asObject(v);
	return b && isCount(b.count) && isCount(b.sessions)
		? { count: Number(b.count), sessions: Number(b.sessions) }
		: null;
}

/**
 * Poisson P(X ≤ k | lambda).
 * @param {number} k
 * @param {number} lambda
 */
function poissonCdf(k, lambda) {
	let term = Math.exp(-lambda);
	let sum = term;
	for (let i = 1; i <= k; i++) {
		term *= lambda / i;
		sum += term;
	}
	return Math.min(1, sum);
}

/**
 * Whether `text` cites issue `n` of `repo`: the full ref anywhere, or a bare
 * `#n` where `repo` is the tracker.
 * @param {string} text
 * @param {{repo: string, number: number}} ref
 * @param {string} tracker
 */
function cites(text, { repo, number: n }, tracker) {
	if (new RegExp(`(?<![\\w.-])${escapeRe(repo)}#${n}(?!\\w)`).test(text))
		return true;
	return (
		repo === tracker && new RegExp(`(?<![\\w/.#-])#${n}(?!\\w)`).test(text)
	);
}

/**
 * Every commit on origin/main up to `nowMs`, newest first.
 * @param {string} root
 * @param {number} nowMs
 * @returns {Commit[] | string}  the commits, or why they would not read
 */
function readMainLog(root, nowMs) {
	const r = gitOutcome(
		["log", "origin/main", "--format=%H%x1f%cI%x1f%B%x1e"],
		[],
		root,
	);
	if (!r.ok) return `git log origin/main in ${root}: ${r.why}`;
	/** @type {Commit[]} */
	const out = [];
	for (const raw of r.out.split("\x1e")) {
		const rec = raw.replace(/^\n+/, "");
		if (!rec) continue;
		const [sha = "", date = "", message = ""] = rec.split("\x1f");
		const at = Date.parse(date);
		if (at > nowMs) continue;
		out.push({ sha, at, subject: message.split("\n")[0] ?? "", message });
	}
	return out;
}

/**
 * When `root`'s origin/main was last updated, by its reflog; null where it
 * has none.
 * @param {string} root
 */
function readRefUpdatedAt(root) {
	const r = gitOutcome(
		[
			"log",
			"-g",
			"-1",
			"--date=unix",
			"--format=%gd",
			"refs/remotes/origin/main",
		],
		[],
		root,
	);
	const re = /@\{(\d+)\}/;
	const m = r.ok ? r.out.match(re) : null;
	return m ? Number(requiredGroup(m, 1, re)) * 1000 : null;
}

/**
 * The signature log on `root`'s origin/main.
 * @param {string} root
 * @param {string} tracker  for a failure line
 * @param {string[]} failures  accumulator: a log that will not read, and each
 *   line that does not parse
 * @returns {Row[]}
 */
function readSigLog(root, tracker, failures) {
	const at = `origin/main:${SIGNATURE_LOG}`;
	const listed = gitOutcome(
		["ls-tree", "--name-only", "origin/main", "--", SIGNATURE_LOG],
		[],
		root,
	);
	if (listed.ok && !listed.out.trim()) return [];
	const shown = listed.ok ? gitOutcome(["show", at], [], root) : listed;
	if (!shown.ok) {
		failures.push(`${tracker}: ${at} in ${root}: ${shown.why}`);
		return [];
	}
	const { rows, bad } = parseJsonl(shown.out);
	for (const b of bad)
		failures.push(`${tracker}: ${at} line ${b} does not parse`);
	return rows;
}

/**
 * The cwd a project directory's sessions ran in: the first of its transcripts
 * to record one.
 * @param {string[]} files
 * @returns {{cwd: string | null, unread: string[]}}  `unread`: each transcript
 *   read before it that would not read
 */
function readDirCwd(files) {
	/** @type {string[]} */
	const unread = [];
	for (const file of files) {
		try {
			const { cwd } = readSessionHead(file);
			if (cwd) return { cwd, unread };
		} catch (e) {
			unread.push(`${path.basename(file)} ${unreadable(e)}`);
		}
	}
	return { cwd: null, unread };
}

/**
 * `root`, then every repo root a seat's session ran in that holds a
 * workflow-core config. One head is read per project directory: its sessions
 * share the cwd it is named for.
 * @param {string} root
 * @param {string[]} seats
 * @param {string[]} failures  accumulator: each directory none of whose
 *   transcripts will read
 */
function findRoots(root, seats, failures) {
	/** @type {Map<string, string[]>} */
	const byDir = new Map();
	for (const file of readSeatTranscripts(seats).files) {
		const dir = path.dirname(file);
		const held = byDir.get(dir);
		if (held) held.push(file);
		else byDir.set(dir, [file]);
	}
	const roots = [root];
	for (const [dir, files] of byDir) {
		const { cwd, unread } = readDirCwd(files);
		if (!cwd && unread.length === files.length)
			failures.push(`project directory unreadable: ${dir} (${unread[0]})`);
		const at = cwd ? repoRootOf(cwd) : null;
		if (at && !roots.includes(at) && hasConfig(at)) roots.push(at);
	}
	return roots;
}

const refAgeHours = (
	/** @type {number} */ refAt,
	/** @type {number} */ nowMs,
) => (nowMs - refAt) / 3_600_000;

/**
 * Why a repo's origin/main is too stale to read, or null where it is fresh.
 * @param {{tracker: string, root: string, refAt: number | null, nowMs: number}} at
 */
function staleWhy({ tracker, root, refAt, nowMs }) {
	if (refAt === null)
		return `${tracker}: origin/main in ${root} has no reflog, so its last update is unknown`;
	if (refAgeHours(refAt, nowMs) <= STALE_REF_HOURS) return null;
	return `${tracker}: origin/main in ${root} last updated ${iso(refAt)}, over ${STALE_REF_HOURS} h before ${iso(nowMs)}`;
}

/**
 * Every repo read, one per tracker, `root`'s first and the rest by tracker.
 * @param {{root: string, seats: string[], nowMs: number, failures: string[]}} at
 *   accumulator: `failures` takes each root with no tracker, each stale or
 *   unread origin/main and each signature log that will not read
 * @returns {Repo[]}
 */
function readRepos({ root, seats, nowMs, failures }) {
	/** @type {Map<string, {root: string, refAt: number | null}>} */
	const best = new Map();
	const rank = (/** @type {number | null} */ t) =>
		t ?? Number.NEGATIVE_INFINITY;
	for (const r of findRoots(root, seats, failures)) {
		let tracker;
		try {
			tracker = requireKey("tracker", { root: r });
		} catch (e) {
			failures.push(caught(e).message);
			continue;
		}
		const refAt = readRefUpdatedAt(r);
		const held = best.get(tracker);
		if (!held || rank(refAt) > rank(held.refAt))
			best.set(tracker, { root: r, refAt });
	}
	const [first, ...rest] = best;
	const ordered = first
		? [first, ...rest.sort(([a], [b]) => (a < b ? -1 : 1))]
		: [];
	return ordered.map(([tracker, { root: r, refAt }]) => {
		const sha = gitOutcome(
			["rev-parse", "--verify", "-q", "refs/remotes/origin/main"],
			[],
			r,
		);
		const commits =
			staleWhy({ tracker, root: r, refAt, nowMs }) ?? readMainLog(r, nowMs);
		if (typeof commits === "string") failures.push(commits);
		return {
			tracker,
			root: r,
			sha: sha.ok ? sha.out.trim() || null : null,
			refAt,
			commits,
			sigRows: readSigLog(r, tracker, failures),
		};
	});
}

/**
 * Every repo's signature log lines, a ref in two logs kept from the first.
 * @param {Repo[]} repos
 * @param {string[]} notes  accumulator: each ref in two logs
 * @returns {Row[]}
 */
function joinLogs(repos, notes) {
	/** @type {Map<unknown, string>} */
	const firstIn = new Map();
	return repos.flatMap((repo) =>
		repo.sigRows.filter((row) => {
			const first = firstIn.get(row.issue);
			if (first === undefined) firstIn.set(row.issue, repo.tracker);
			else if (first !== repo.tracker) {
				notes.push(
					`${row.issue} is in the signature logs of ${first} and ${repo.tracker}: read ${first}'s`,
				);
				return false;
			}
			return true;
		}),
	);
}

/**
 * The time of a transcript's first timestamped record, read from its head
 * (the whole file only where the head holds none); null where it has none.
 * @param {string} file
 * @returns {number | null}
 * @throws where the file will not read
 */
function sessionStart(file) {
	const fd = fs.openSync(file, "r");
	let head;
	try {
		const buf = Buffer.alloc(START_PROBE_BYTES);
		const got = fs.readSync(fd, buf, 0, START_PROBE_BYTES, 0);
		head = buf.subarray(0, got).toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
	const fromText = (/** @type {string} */ text) => {
		for (const line of text.split("\n")) {
			const t = Date.parse(String(parseJsonlRow(line)?.timestamp));
			if (!Number.isNaN(t)) return t;
		}
		return null;
	};
	const t = fromText(head);
	if (t !== null || head.length < START_PROBE_BYTES) return t;
	return fromText(fs.readFileSync(file, "utf8"));
}

/**
 * One session's hits on each wanted signature, keyed by its request's index:
 * its main log, and every subagent log under it, each on its own tier.
 * @param {string} mainLog
 * @param {Array<{i: number, sig: Signature}>} wanted
 * @param {Registry} registry
 * @returns {Map<number, number>}
 * @throws where a log will not read
 */
function sessionHits(mainLog, wanted, registry) {
	const logs = [
		{ file: mainLog, tier: /** @type {const} */ ("main") },
		...readSubagentFiles(subagentDirOf(mainLog)),
	];
	const tallies = wanted.map((w) => ({ ...w, hits: 0 }));
	for (const { file, tier } of logs) {
		const text = fs.readFileSync(file, "utf8");
		for (const t of tallies)
			t.hits += signatureHits(text, t.sig, tier, registry).length;
	}
	return new Map(tallies.map((t) => [t.i, t.hits]));
}

/** @param {unknown} e */
const unreadable = (e) => `(${caught(e).code ?? caught(e).message})`;

/**
 * Every session starting at or after `fromMs`, one copy across the seats, in
 * time order.
 * @param {string[]} seats
 * @param {number} fromMs
 * @param {{failures: string[], notes: string[]}} log  accumulator: each
 *   unreadable seat or transcript is pushed to `failures`, each absent seat to
 *   `notes`
 * @returns {Session[]}
 */
function indexSessions(seats, fromMs, { failures, notes }) {
	const listing = readSeatTranscripts(seats);
	for (const a of listing.absent) notes.push(`no seat at ${a}`);
	for (const u of listing.unreadable)
		failures.push(`seat directory unreadable: ${u}`);
	/** @type {Session[]} */
	const out = [];
	for (const file of listing.files) {
		try {
			/* A session last written before `fromMs` started before it. */
			if (fs.statSync(file).mtimeMs < fromMs) continue;
			const start = sessionStart(file);
			if (start !== null) out.push({ file, start });
		} catch (e) {
			failures.push(`transcript unreadable: ${file} ${unreadable(e)}`);
		}
	}
	return out.sort((a, b) => a.start - b.start || (a.file < b.file ? -1 : 1));
}

/**
 * Hits on each request's signature in each of its sessions, reading each
 * session once; null for a request one of whose sessions would not read.
 * @param {Array<{sig: Signature, sessions: Session[]}>} requests
 * @param {Registry} registry
 * @param {string[]} failures  accumulator: each transcript that will not read
 * @returns {Array<number[] | null>}
 */
function hitsFor(requests, registry, failures) {
	/** @type {Map<string, Array<{i: number, sig: Signature}>>} */
	const wanted = new Map();
	requests.forEach((r, i) => {
		for (const s of r.sessions)
			wanted.set(s.file, [...(wanted.get(s.file) ?? []), { i, sig: r.sig }]);
	});
	/** @type {Map<string, Map<number, number>>} */
	const got = new Map();
	for (const [file, who] of wanted) {
		try {
			got.set(file, sessionHits(file, who, registry));
		} catch (e) {
			failures.push(`transcript unreadable: ${file} ${unreadable(e)}`);
		}
	}
	return requests.map((r, i) => {
		const per = r.sessions.map((s) => got.get(s.file)?.get(i));
		return per.includes(undefined) ? null : /** @type {number[]} */ (per);
	});
}

/** A revert's message, git's own or a hand-written `Revert "…"`. */
const REVERT = /^Revert "|This reverts commit [0-9a-f]{7,40}/m;

/**
 * The fix: the latest commit on origin/main citing the issue, a revert of it
 * aside.
 * @param {Commit[]} commits  newest first
 * @param {{repo: string, number: number}} ref
 * @param {string} tracker
 */
const fixOf = (commits, ref, tracker) =>
	commits.find(
		(c) => !REVERT.test(c.message) && cites(c.message, ref, tracker),
	);

/**
 * Commits on origin/main after the fix that revert it.
 * @param {Commit[]} commits
 * @param {Commit} fix
 */
function revertsOf(commits, fix) {
	return commits
		.filter((c) => c.at > fix.at && c.sha !== fix.sha)
		.filter(
			(c) =>
				[...c.message.matchAll(/This reverts commit ([0-9a-f]{7,40})/g)].some(
					(m) => m[1] !== undefined && fix.sha.startsWith(m[1]),
				) || c.subject === `Revert "${fix.subject}"`,
		)
		.map((c) => c.sha);
}

/**
 * `bug` issues filed after the fix whose body cites the finding or the fix.
 * @param {IssueRow[]} bugs
 * @param {Finding} f
 * @param {Commit} fix
 * @param {{tracker: string, nowMs: number}} at
 */
function followOnsOf(bugs, f, fix, { tracker, nowMs }) {
	return bugs
		.filter((b) => {
			const created = Date.parse(b.createdAt ?? "");
			if (!(created > fix.at && created <= nowMs)) return false;
			if (tracker === f.repo && b.number === f.number) return false;
			const body = b.body ?? "";
			return (
				cites(body, f, tracker) ||
				[...body.matchAll(/\b[0-9a-f]{7,40}\b/g)].some((m) =>
					fix.sha.startsWith(m[0]),
				)
			);
		})
		.map((b) => `${tracker}#${b.number}`);
}

/**
 * Every finding with a signature, a run record's entry over a log line for the
 * same issue, and every issue either record names.
 * @param {Row[]} sigLines
 * @param {Row[]} weekly
 * @param {Registry} registry  to check each signature against
 * @param {string[]} failures  accumulator: each entry with no usable issue,
 *   date, signature or baseline
 */
function collectFindings(sigLines, weekly, registry, failures) {
	/** @type {Map<string, Finding>} */
	const findings = new Map();
	/** @type {Set<string>} */
	const signed = new Set();
	/** @type {Map<string, Set<string>>} each issue's distinct log lines */
	const logged = new Map();
	for (const l of sigLines)
		if (typeof l?.issue === "string")
			logged.set(
				l.issue,
				(logged.get(l.issue) ?? new Set()).add(canonicalJson(l, true)),
			);
	const conflicts = [...logged]
		.filter(([, lines]) => lines.size > 1)
		.map(([issue, lines]) => ({
			issue,
			lines: [...lines].map((l) => JSON.parse(l)),
		}));
	const conflicted = new Set(conflicts.map((c) => c.issue));
	/**
	 * @param {Row} entry  a log line or a `findings[]` entry
	 * @param {number} filedAt
	 * @param {string} where  for a failure line
	 */
	const add = (entry, filedAt, where) => {
		const issue = entry.issue;
		if (typeof issue !== "string") return;
		signed.add(issue);
		if (!entry.signature || conflicted.has(issue)) return;
		const named = `${where} ${JSON.stringify(issue)}`;
		const ref = parseQualifiedRef(issue);
		if (!ref || Number.isNaN(filedAt)) {
			failures.push(`${named} has no usable issue or date`);
			return;
		}
		const checked = checkSignature(entry.signature, registry);
		if ("error" in checked) {
			failures.push(`${named}: ${checked.error}`);
			return;
		}
		const baseline = parseBaseline(entry.baseline);
		if (entry.baseline != null && !baseline)
			failures.push(
				`${named} has a baseline that is not {count, sessions}; it is counted here`,
			);
		const held = findings.get(issue);
		findings.set(issue, {
			ref: issue,
			...ref,
			filedAt: held?.filedAt ?? filedAt,
			signature: checked.signature,
			baseline,
			late: held?.late === true || entry.late === true,
		});
	};
	const dateMs = (/** @type {unknown} */ v) =>
		typeof v === "string" ? Date.parse(v) : Number.NaN;
	for (const l of sigLines) add(l, dateMs(l.filedAt), "signature log line for");
	for (const line of weekly)
		for (const f of objectsIn(line.findings))
			add(
				f,
				dateMs(asObject(line.week)?.end ?? line.date),
				`run line ${String(line.date)} finding`,
			);
	return { findings, signed, conflicts };
}

/**
 * The latest prior outcome of each finding, those ever extended, and the last
 * run's carried backlog.
 * @param {Row[]} weekly
 */
function readPrior(weekly) {
	/** @type {Map<string, Row>} */
	const prior = new Map();
	/** @type {Set<string>} */
	const extended = new Set();
	for (const line of weekly)
		for (const o of objectsIn(line.outcomes)) {
			if (typeof o.finding !== "string") continue;
			prior.set(o.finding, o);
			if (o.verdict === "extend") extended.add(o.finding);
		}
	const backlog = stringMembers(asObject(weekly.at(-1)?.outcomeStep)?.backlog);
	return { prior, extended, backlog };
}

/**
 * A reading with no verdict yet.
 * @param {Finding} f
 * @param {string} why
 * @param {Partial<Outcome>} [more]
 * @returns {Outcome}
 */
const waiting = (f, why, more = {}) => ({
	finding: f.ref,
	fixSha: null,
	fixAt: null,
	window: null,
	sessions: null,
	observed: null,
	expected: null,
	guardrails: null,
	verdict: "waiting",
	unwindIssue: null,
	late: f.late,
	baseline: f.baseline,
	why,
	...more,
});

/**
 * Inconclusive: `extend` the first time, `unwind` the second.
 * @param {string} why
 * @param {boolean} extendedBefore
 * @returns {{verdict: Verdict, why: string}}
 */
const inconclusive = (why, extendedBefore) =>
	extendedBefore
		? { verdict: "unwind", why: `${why}, inconclusive a second time` }
		: { verdict: "extend", why };

/**
 * The verdict on a read window.
 * @param {{observed: number, expected: number, harm: boolean, extendedBefore: boolean}} r
 * @returns {{verdict: Verdict, why: string}}
 */
function judge({ observed, expected, harm, extendedBefore }) {
	if (harm) return { verdict: "unwind", why: "guardrail harm" };
	if (expected < EXPECTED_FLOOR)
		return inconclusive(
			`window ran out at ${round3(expected)} expected, under ${EXPECTED_FLOOR}`,
			extendedBefore,
		);
	const p = poissonCdf(observed, expected);
	if (p <= KEEP_P)
		return { verdict: "keep", why: `fell: P(X ≤ ${observed}) = ${round3(p)}` };
	if (observed >= expected) return { verdict: "unwind", why: "did not fall" };
	return inconclusive(
		`fell short of the ${KEEP_P} bar: P(X ≤ ${observed}) = ${round3(p)}`,
		extendedBefore,
	);
}

/**
 * @typedef {{f: Finding, fix: Commit, guardrails: Guardrails}} Reading
 * @typedef {{repos: Map<string, Repo>, bugs: Map<string, IssueRow[] | string>,
 *   nowMs: number, failures: string[]}} Reads  each keyed by tracker
 */

/**
 * The latest fix of `ref` across every repo whose origin/main read. A repo
 * that did not read is passed over, so a newer fix citing `ref` in full there
 * goes unseen and the reading takes an older one; the run still exits 1 on
 * that repo's failure.
 * @param {Map<string, Repo>} repos
 * @param {{repo: string, number: number}} ref
 * @returns {{fix: Commit, commits: Commit[]} | null}  the fix and its repo's
 *   commits
 */
function latestFix(repos, ref) {
	/** @type {{fix: Commit, commits: Commit[]} | null} */
	let best = null;
	for (const { commits, tracker } of repos.values()) {
		if (typeof commits === "string") continue;
		const fix = fixOf(commits, ref, tracker);
		if (fix && (!best || fix.at > best.fix.at)) best = { fix, commits };
	}
	return best;
}

/**
 * A finding as far as the trackers and each origin/main take it: a `waiting`
 * outcome, or a reading due its counts.
 * @param {Finding} f
 * @param {Reads} reads  accumulator: `failures` takes each issue read that
 *   fails, and each finding whose tracker has no repo read
 * @returns {Outcome | Reading}
 */
function stageFinding(f, { repos, bugs, nowMs, failures }) {
	/** @type {{state?: string}} */
	let issue;
	try {
		issue = ghJson([
			"issue",
			"view",
			String(f.number),
			"--repo",
			f.repo,
			"--json",
			"state",
		]);
	} catch (e) {
		const why = `could not read ${f.ref}: ${parseErrLine(e)}`;
		failures.push(why);
		return waiting(f, why);
	}
	if (issue.state !== "CLOSED") return waiting(f, "the finding is open");
	const home = repos.get(f.repo);
	if (!home) {
		const why = `no checkout of ${f.repo} on this machine`;
		failures.push(`${f.ref}: ${why}`);
		return waiting(f, why);
	}
	if (typeof home.commits === "string")
		return waiting(f, `origin/main unread: ${home.commits}`);
	const found = latestFix(repos, f);
	if (!found) return waiting(f, "no commit on origin/main cites it");
	const { fix, commits } = found;
	const fixed = { fixSha: fix.sha, fixAt: iso(fix.at) };
	const due = fix.at + INTERVAL_DAYS * DAY_MS;
	if (nowMs < due) return waiting(f, `first reading from ${day(due)}`, fixed);
	/** @type {string[]} */
	const followOns = [];
	for (const [tracker, list] of bugs) {
		if (typeof list === "string")
			return waiting(f, `follow-ons unread: ${list}`, fixed);
		followOns.push(...followOnsOf(list, f, fix, { tracker, nowMs }));
	}
	return {
		f,
		fix,
		guardrails: { reverts: revertsOf(commits, fix), followOns },
	};
}

/** The first instant of a finding's baseline: BASELINE_WEEKS before its trigger week. */
const baselineFrom = (/** @type {number} */ filedAt) =>
	filedAt - (TRIGGER_DAYS + BASELINE_WEEKS * 7) * DAY_MS;

/**
 * Each request's baseline: its hits per session over the BASELINE_WEEKS
 * before its trigger week. Null where a session would not read.
 * @param {Array<{sig: Signature, filedAt: number}>} requests
 * @param {Session[]} sessions  every session from the earliest baseline on
 * @param {Registry} registry
 * @param {string[]} failures  accumulator: each transcript that will not read
 * @returns {Array<Baseline | null>}
 */
function countBaselines(requests, sessions, registry, failures) {
	const hits = hitsFor(
		requests.map((r) => {
			const start = baselineFrom(r.filedAt);
			const end = r.filedAt - TRIGGER_DAYS * DAY_MS;
			return {
				sig: r.sig,
				sessions: sessions.filter((s) => s.start >= start && s.start < end),
			};
		}),
		registry,
		failures,
	);
	return hits.map((h) => {
		if (!h) return null;
		return { count: h.reduce((a, b) => a + b, 0), sessions: h.length };
	});
}

/**
 * Each reading's baseline (the run record's, else `countBaselines`) and its
 * window: the sessions after the fix until rate × sessions reaches the floor
 * (every one to `now` where a prior run extended it), with their hits. Null
 * hits where a session would not read.
 * @param {Reading[]} reading
 * @param {{seats: string[], registry: Registry, nowMs: number,
 *   extended: Set<string>, failures: string[], notes: string[]}} at
 *   accumulator: `failures` and `notes` take what `indexSessions` and
 *   `hitsFor` push
 */
function countReadings(
	reading,
	{ seats, registry, nowMs, extended, failures, notes },
) {
	const from = Math.min(
		...reading.map((r) =>
			r.f.baseline ? r.fix.at : baselineFrom(r.f.filedAt),
		),
	);
	const sessions = indexSessions(seats, from, { failures, notes });
	const owed = reading.filter((r) => !r.f.baseline);
	const counted = countBaselines(
		owed.map((r) => ({ sig: r.f.signature, filedAt: r.f.filedAt })),
		sessions,
		registry,
		failures,
	);
	const baselines = reading.map((r) =>
		r.f.baseline ? r.f.baseline : (counted[owed.indexOf(r)] ?? null),
	);
	const takes = reading.map((r, i) => {
		const base = baselines[i];
		const rate = base ? rateOf(base) : 0;
		const need =
			rate > 0 && !extended.has(r.f.ref)
				? Math.ceil(EXPECTED_FLOOR / rate - 1e-9)
				: Number.POSITIVE_INFINITY;
		return base
			? sessions
					.filter((s) => s.start > r.fix.at && s.start <= nowMs)
					.slice(0, need)
			: [];
	});
	const winHits = hitsFor(
		reading.map((r, i) => ({ sig: r.f.signature, sessions: takes[i] ?? [] })),
		registry,
		failures,
	);
	return reading.map((_, i) => ({
		base: baselines[i] ?? null,
		take: takes[i] ?? [],
		hits: winHits[i] ?? null,
	}));
}

/** A reading the count never reached: withheld, as a failed read is. */
const NO_COUNTS = { base: null, take: [], hits: null };

/**
 * A reading's outcome from its counts.
 * @param {Reading} r
 * @param {{base: Baseline | null, take: Session[], hits: number[] | null}} c
 * @param {{extended: Set<string>, nowMs: number, failures: string[]}} at
 * @returns {Outcome}
 */
function buildOutcome({ f, fix, guardrails }, { base, take, hits }, at) {
	const fixed = { fixSha: fix.sha, fixAt: iso(fix.at), guardrails };
	if (at.failures.length > 0 || !base || !hits)
		return waiting(
			f,
			`withheld: transcripts unread (${at.failures.join("; ")})`,
			{ ...fixed, baseline: base },
		);
	const observed = hits.reduce((a, b) => a + b, 0);
	const expected = rateOf(base) * take.length;
	const extendedBefore = at.extended.has(f.ref);
	const { verdict, why } = judge({
		observed,
		expected,
		harm: guardrails.reverts.length + guardrails.followOns.length > 0,
		extendedBefore,
	});
	const last = take.at(-1);
	return {
		finding: f.ref,
		...fixed,
		window: {
			start: iso(fix.at),
			end:
				last && expected >= EXPECTED_FLOOR && !extendedBefore
					? iso(last.start)
					: iso(at.nowMs),
		},
		sessions: take.length,
		observed,
		expected,
		verdict,
		unwindIssue: null,
		late: f.late,
		baseline: base,
		why,
	};
}

/**
 * Reads every unsettled finding. Transcripts are read only where a finding
 * is due its counts.
 * @param {Finding[]} findings
 * @param {Reads & {extended: Set<string>, seats: string[],
 *   registry: Registry, notes: string[]}} at  accumulator: `failures` and
 *   `notes` take every failed read and note
 * @returns {Outcome[]}
 */
function readOutcomes(findings, at) {
	const staged = findings.map((f) => stageFinding(f, at));
	const reading = /** @type {Reading[]} */ (staged.filter((s) => "fix" in s));
	if (reading.length === 0) return /** @type {Outcome[]} */ (staged);
	/** @type {string[]} */
	const transcriptFailures = [];
	const counts = countReadings(reading, {
		...at,
		failures: transcriptFailures,
	});
	at.failures.push(...transcriptFailures);
	return staged.map((s) =>
		"fix" in s
			? buildOutcome(s, counts[reading.indexOf(s)] ?? NO_COUNTS, {
					extended: at.extended,
					nowMs: at.nowMs,
					failures: transcriptFailures,
				})
			: s,
	);
}

/**
 * Observed ÷ expected, for ranking: infinite where hits came against none
 * expected.
 * @param {{observed?: number | null, expected?: number | null}} o
 */
function unwindRatio({ observed, expected }) {
	const seen = observed ?? 0;
	if (typeof expected === "number" && expected > 0) return seen / expected;
	return seen > 0 ? Number.POSITIVE_INFINITY : 0;
}

/**
 * Ranks this run's unwinds with the carried backlog; the cap's worth to file.
 * @param {Outcome[]} outcomes
 * @param {string[]} backlog
 * @param {Map<string, Row>} prior
 */
function rankUnwinds(outcomes, backlog, prior) {
	const fresh = outcomes.filter((o) => o.verdict === "unwind");
	const seen = new Set(fresh.map((o) => o.finding));
	const carried = backlog
		.filter((ref) => !seen.has(ref) && seen.add(ref))
		.map((ref) => ({
			finding: ref,
			...(prior.get(ref) ?? {}),
			carriedIn: true,
		}));
	/** @type {Row[]} */
	const ranked = [...fresh, ...carried];
	const rows = ranked.map((o) => {
		const guardrails = asObject(o.guardrails);
		const reverts = stringMembers(guardrails?.reverts);
		const followOns = stringMembers(guardrails?.followOns);
		const observed = numberOf(o.observed);
		const expected = numberOf(o.expected);
		const rank = unwindRatio({ observed, expected });
		return {
			finding: String(o.finding),
			fixSha: typeof o.fixSha === "string" ? o.fixSha : null,
			observed,
			expected,
			guardrails: { reverts, followOns },
			harm: reverts.length + followOns.length > 0,
			ratio: Number.isFinite(rank) ? round3(rank) : null,
			rank,
			carriedIn: "carriedIn" in o,
			late: o.late === true,
		};
	});
	rows.sort(
		(a, b) =>
			Number(b.harm) - Number(a.harm) ||
			b.rank - a.rank ||
			(a.finding < b.finding ? -1 : 1),
	);
	const strip = rows.map(({ rank, ...r }) => r);
	return { file: strip.slice(0, UNWIND_CAP), carried: strip.slice(UNWIND_CAP) };
}

/** @param {IssueRow} i */
const labelsOf = (i) => (i.labels ?? []).map((l) => l.name);

/**
 * Whether a ticket closed in the MISS_DAYS to `nowMs`.
 * @param {IssueRow} i
 * @param {number} nowMs
 */
function closedThisWeek(i, nowMs) {
	const at = Date.parse(i.closedAt ?? "");
	return at >= nowMs - MISS_DAYS * DAY_MS && at <= nowMs;
}

/**
 * The week's closed tickets that landed a commit, look fault-shaped, have no
 * line in either record and no SCRIPT_ORIGINS label.
 * @param {IssueRow[]} closed
 * @param {{commits: Commit[], signed: Set<string>, tracker: string, nowMs: number}} at
 */
function readMisses(closed, { commits, signed, tracker, nowMs }) {
	const out = [];
	for (const i of closed) {
		const ref = `${tracker}#${i.number}`;
		if (!closedThisWeek(i, nowMs) || signed.has(ref)) continue;
		const origin = originOfLabels(labelsOf(i));
		if (isScriptOrigin(origin)) continue;
		if (labelsOf(i).includes(SIGNATURE_LABEL)) continue;
		const fix = fixOf(commits, { repo: tracker, number: i.number }, tracker);
		if (!fix) continue;
		const why = [
			labelsOf(i).includes("bug") && "bug",
			FAULT_SHAPE.test(i.title) && "fault-shaped title",
			FAULT_SHAPE.test(fix.subject) && "fault-shaped commit subject",
		].filter((w) => typeof w === "string");
		if (why.length > 0)
			out.push({ issue: ref, title: i.title, fixSha: fix.sha, why });
	}
	return out;
}

/**
 * The week's closed `bug` tickets carrying an `origin:*` label and no
 * signature line, declared `--no-fault`, that are not already misses.
 * @param {IssueRow[]} closed
 * @param {{signed: Set<string>, missed: Set<string>, tracker: string,
 *   nowMs: number}} at
 */
function readNoFaultBugs(closed, { signed, missed, tracker, nowMs }) {
	return closed.flatMap((i) => {
		const origin = originOfLabels(labelsOf(i));
		const ref = `${tracker}#${i.number}`;
		return origin &&
			labelsOf(i).includes("bug") &&
			!labelsOf(i).includes(SIGNATURE_LABEL) &&
			closedThisWeek(i, nowMs) &&
			!signed.has(ref) &&
			!missed.has(ref)
			? [{ issue: ref, title: i.title, origin }]
			: [];
	});
}

/**
 * The closed tickets owing a line that neither record holds, each with the
 * line its body section records, or null where the section is gone.
 * @param {IssueRow[]} owing  closed tickets carrying SIGNATURE_LABEL
 * @param {{signed: Set<string>, tracker: string}} at
 */
function lostLinesOf(owing, { signed, tracker }) {
	return owing.flatMap((i) => {
		const ref = `${tracker}#${i.number}`;
		return signed.has(ref)
			? []
			: [
					{
						issue: ref,
						title: i.title,
						line: parseSignatureSection(ref, i.body ?? ""),
					},
				];
	});
}

/**
 * @param {Row[]} weekly prior weekly run lines
 * @param {Outcome[]} outcomes this run's
 * @param {number} backlog this run's carried count
 */
function flipCheck(weekly, outcomes, backlog) {
	const reached = (/** @type {Row[]} */ os) =>
		os.some((o) => o.verdict && o.verdict !== "waiting");
	const runs =
		weekly.filter((l) => reached(objectsIn(l.outcomes))).length +
		(reached(outcomes) ? 1 : 0);
	const over = weekly.filter(
		(l) => Number(asObject(l.outcomeStep)?.tokens) > TOKEN_BUDGET,
	).length;
	const why = [];
	if (runs >= FLIP_RUNS)
		why.push(`${runs} runs reached a verdict (due at ${FLIP_RUNS})`);
	if (backlog > FLIP_BACKLOG)
		why.push(`carried backlog ${backlog} is over ${FLIP_BACKLOG}`);
	if (over >= FLIP_OVER_BUDGET_RUNS)
		why.push(`${over} runs spent over the ${TOKEN_BUDGET}-token budget`);
	return {
		due: why.length > 0,
		bars: DROP_BARS,
		why:
			why.length > 0
				? why.join("; ")
				: `${runs} of ${FLIP_RUNS} verdict runs, backlog ${backlog}, ${over} over budget`,
	};
}

/**
 * @param {ReturnType<typeof review>} r
 * @returns {string}
 */
function buildText(r) {
	const out = [
		`Outcome review at ${r.now} (tracker ${r.tracker})`,
		"",
		"Repos read:",
		...r.repos.map(
			(p) =>
				`  ${p.tracker} ${p.root} origin/main ${p.sha?.slice(0, 9) ?? "?"} updated ${p.refAt ?? "?"}${p.refAgeHours === null ? "" : ` (${p.refAgeHours} h before now)`}`,
		),
	];
	const row = (/** @type {Outcome} */ o) => {
		const counts =
			o.observed === null
				? ""
				: ` observed ${o.observed} vs expected ${o.expected} over ${o.sessions} session(s)`;
		const fix = o.fixSha ? ` fix ${o.fixSha.slice(0, 9)} ${o.fixAt}` : "";
		return `  ${o.verdict.padEnd(7)} ${o.finding}${fix}${counts} — ${o.why}`;
	};
	for (const [title, late] of /** @type {const} */ ([
		["Verdicts", false],
		["Late verdicts", true],
	])) {
		const os = r.outcomes.filter((o) => o.late === late);
		out.push("", `${title}:`, ...(os.length > 0 ? os.map(row) : ["  none"]));
	}
	if (r.settled.length > 0)
		out.push(
			"",
			"Settled (not read again):",
			...r.settled.map((s) => `  ${s.verdict} ${s.finding}`),
		);
	const unwindRow = (
		/** @type {ReturnType<typeof rankUnwinds>["file"][number]} */ u,
	) => {
		const sig = r.signatures[u.finding];
		const g = u.guardrails;
		return `  ${u.finding} fix ${u.fixSha ?? "?"}${u.late ? " (late)" : ""}${u.carriedIn ? " (carried in)" : ""} — observed ${u.observed ?? "?"} vs expected ${u.expected ?? "?"}; reverts [${g.reverts.join(", ")}]; follow-ons [${g.followOns.join(", ")}]; signature ${sig ? JSON.stringify(sig) : "?"}`;
	};
	out.push(
		"",
		`Unwinds to file (at most ${UNWIND_CAP}):`,
		...(r.unwinds.file.length > 0 ? r.unwinds.file.map(unwindRow) : ["  none"]),
	);
	out.push(
		"",
		"Carried backlog:",
		...(r.unwinds.carried.length > 0
			? r.unwinds.carried.map(unwindRow)
			: ["  none"]),
	);
	const unread = (/** @type {string[]} */ ts) =>
		ts.length > 0 ? ` (UNREAD in ${ts.join(", ")})` : "";
	out.push(
		"",
		`Missed signatures (closed ${MISS_DAYS} days to now, landed, fault-shaped, no signature line): ${r.misses.length}${unread(r.missesUnread)}`,
		...r.misses.map(
			(m) =>
				`  ${m.issue} ${JSON.stringify(m.title)} — ${m.why.join(", ")}; fix ${m.fixSha.slice(0, 9)}`,
		),
		"",
		`Declared --no-fault yet carrying bug (closed ${MISS_DAYS} days to now): ${r.noFaultBug.length}${unread(r.noFaultBugUnread)}`,
		...r.noFaultBug.map(
			(m) => `  ${m.issue} ${JSON.stringify(m.title)} — origin:${m.origin}`,
		),
		"",
		`Signature declared, line missing on main (closed, any date): ${r.lostLines.length}${unread(r.lostLinesUnread)}`,
		...r.lostLines.map(
			(m) =>
				`  ${m.issue} ${JSON.stringify(m.title)} — ${m.line ? JSON.stringify(m.line) : "UNRECOVERABLE"}`,
		),
		"",
		`Conflicting signature lines (no verdict): ${r.conflicts.length}`,
		...r.conflicts.flatMap((c) => [
			`  ${c.issue}`,
			...c.lines.map((l) => `    ${JSON.stringify(l)}`),
		]),
		"",
		`Flip check: ${r.flipDue.due ? "DUE" : "not due"} — ${r.flipDue.why}`,
		`  drops to on-demand if: ${r.flipDue.bars.join("; ")}`,
	);
	if (r.notes.length > 0)
		out.push("", "Notes:", ...r.notes.map((n) => `  ${n}`));
	if (r.failures.length > 0)
		out.push("", "FAILED READS:", ...r.failures.map((f) => `  ${f}`));
	return `${out.join("\n")}\n`;
}

/**
 * The tracker's `bug` issues, the week's closes and every closed ticket owing a
 * signature line, or why each would not read.
 * @param {string} tracker
 * @param {number} nowMs
 * @param {string[]} failures  accumulator: each list that will not read
 */
function readTracker(tracker, nowMs, failures) {
	/** @param {string} what @param {string[]} args */
	const list = (what, args) => {
		try {
			return /** @type {IssueRow[]} */ (
				ghIssueListAll(what, ["--repo", tracker, ...args])
			);
		} catch (e) {
			const why = `${tracker}: ${what} unread: ${parseErrLine(e)}`;
			failures.push(why);
			return why;
		}
	};
	return {
		bugs: list("bug issues", [
			"--state",
			"all",
			"--label",
			"bug",
			"--json",
			"number,title,body,createdAt,labels",
		]),
		closed: list("closed issues", [
			"--state",
			"closed",
			"--search",
			`closed:>=${day(nowMs - MISS_DAYS * DAY_MS)}`,
			"--json",
			"number,title,closedAt,labels",
		]),
		owing: list("closed fault-signature issues", [
			"--state",
			"closed",
			"--label",
			SIGNATURE_LABEL,
			"--json",
			"number,title,body,closedAt,labels",
		]),
	};
}

/**
 * A log's rows under `root`; none where it is absent or will not read.
 * @param {string} root
 * @param {string} rel
 * @param {string[]} failures  accumulator: a log that will not read, and each
 *   line that does not parse
 * @returns {Row[]}
 */
function readRows(root, rel, failures) {
	let log;
	try {
		log = readJsonl(path.join(root, rel));
	} catch (e) {
		failures.push(`${rel} will not read ${unreadable(e)}`);
		return [];
	}
	for (const b of log?.bad ?? [])
		failures.push(`${rel} line ${b} does not parse`);
	return log?.rows ?? [];
}

/**
 * The whole review.
 * @param {{root: string, seats: string[], nowMs: number, tracker: string}} at
 */
function review({ root, seats, nowMs, tracker }) {
	/** @type {string[]} */
	const failures = [];
	/** @type {string[]} */
	const notes = [];
	const repos = readRepos({ root, seats, nowMs, failures });
	const sigLines = joinLogs(repos, notes);
	const weekly = readRows(root, RUN_RECORD, failures).filter(
		(l) => l.mode === "weekly",
	);
	const registry = readNeedles(root).needles;
	const { findings, signed, conflicts } = collectFindings(
		sigLines,
		weekly,
		registry,
		failures,
	);
	const { prior, extended, backlog: carriedIn } = readPrior(weekly);
	const settled = [];
	/** @type {Finding[]} */
	const open = [];
	for (const f of findings.values()) {
		const v = prior.get(f.ref)?.verdict;
		if (v === "keep" || v === "unwind")
			settled.push({ finding: f.ref, verdict: v, late: f.late });
		else open.push(f);
	}
	const reads = repos.map((repo) => ({
		repo,
		...readTracker(repo.tracker, nowMs, failures),
	}));
	const outcomes = readOutcomes(open, {
		repos: new Map(repos.map((p) => [p.tracker, p])),
		bugs: new Map(reads.map((t) => [t.repo.tracker, t.bugs])),
		nowMs,
		failures,
		extended,
		seats,
		registry,
		notes,
	});
	const unwinds = rankUnwinds(outcomes, carriedIn, prior);
	const misses = [];
	const noFaultBug = [];
	/** @type {string[]} */
	const missesUnread = [];
	/** @type {string[]} */
	const noFaultBugUnread = [];
	const lostLines = [];
	/** @type {string[]} */
	const lostLinesUnread = [];
	for (const { repo, closed, owing } of reads) {
		const at = { signed, tracker: repo.tracker, nowMs };
		if (typeof owing === "string") lostLinesUnread.push(repo.tracker);
		else lostLines.push(...lostLinesOf(owing, at));
		if (typeof closed === "string") {
			missesUnread.push(repo.tracker);
			noFaultBugUnread.push(repo.tracker);
			continue;
		}
		const repoMisses =
			typeof repo.commits === "string"
				? []
				: readMisses(closed, { ...at, commits: repo.commits });
		if (typeof repo.commits === "string") missesUnread.push(repo.tracker);
		misses.push(...repoMisses);
		const missed = new Set(repoMisses.map((m) => m.issue));
		noFaultBug.push(...readNoFaultBugs(closed, { ...at, missed }));
	}
	/** @type {Record<string, Signature>} */
	const signatures = {};
	for (const f of findings.values()) signatures[f.ref] = f.signature;
	const backlog = unwinds.carried.map((u) => u.finding);
	return {
		now: iso(nowMs),
		tracker,
		repos: repos.map((p) => ({
			tracker: p.tracker,
			root: p.root,
			sha: p.sha,
			refAt: p.refAt === null ? null : iso(p.refAt),
			refAgeHours:
				p.refAt === null
					? null
					: Math.round(refAgeHours(p.refAt, nowMs) * 10) / 10,
		})),
		outcomes,
		unwinds,
		outcomeStep: {
			misses: missesUnread.length > 0 ? null : misses.length,
			backlog,
		},
		settled,
		misses,
		missesUnread,
		noFaultBug,
		noFaultBugUnread,
		lostLines,
		lostLinesUnread,
		conflicts,
		flipDue: flipCheck(weekly, outcomes, backlog.length),
		signatures,
		notes: [...new Set(notes)],
		failures: [...new Set(failures)],
	};
}

/**
 * A finding's baseline at filing, the retro's `findings[].baseline`.
 * @param {{file: string, filedAt: number, root: string, seats: string[]}} at
 * @returns {{filedAt: string, window: {start: string, end: string},
 *   baseline: Baseline | null, why: string, notes: string[],
 *   failures: string[]} | {error: string}}
 */
function readFilingBaseline({ file, filedAt, root, seats }) {
	const read = readDeclared(file, { root, seats });
	if ("error" in read) return read;
	const from = baselineFrom(filedAt);
	const window = {
		start: iso(from),
		end: iso(filedAt - TRIGGER_DAYS * DAY_MS),
	};
	const { signature } = read.declared;
	if (signature === null)
		return {
			filedAt: iso(filedAt),
			window,
			baseline: null,
			why: "the signature is null",
			notes: [],
			failures: [],
		};
	/** @type {string[]} */
	const failures = [];
	/** @type {string[]} */
	const notes = [];
	const sessions = indexSessions(seats, from, { failures, notes });
	const [base] = countBaselines(
		[{ sig: signature, filedAt }],
		sessions,
		read.registry,
		failures,
	);
	return {
		filedAt: iso(filedAt),
		window,
		baseline: base ?? null,
		why: base ? "counted" : "withheld: transcripts unread",
		notes: [...new Set(notes)],
		failures: [...new Set(failures)],
	};
}

/**
 * @param {Exclude<ReturnType<typeof readFilingBaseline>, {error: string}>} r
 * @returns {string}
 */
function buildBaselineText(r) {
	const b = r.baseline;
	const out = [
		`Baseline for a finding filed ${r.filedAt}, over ${r.window.start} to ${r.window.end}: ${b ? `${b.count} hit(s) in ${b.sessions} session(s), rate ${round3(rateOf(b))}` : `none — ${r.why}`}`,
	];
	if (r.notes.length > 0)
		out.push("", "Notes:", ...r.notes.map((n) => `  ${n}`));
	if (r.failures.length > 0)
		out.push("", "FAILED READS:", ...r.failures.map((f) => `  ${f}`));
	return `${out.join("\n")}\n`;
}

/**
 * Baseline mode: one finding's baseline at filing.
 * @param {{file: string | undefined, filedAt: string | undefined,
 *   root: string, seats: string[], json: boolean}} o
 * @returns {number} the exit code
 */
function baselineMain({ file, filedAt, root, seats, json }) {
	const at = typeof filedAt === "string" ? Date.parse(filedAt) : Number.NaN;
	if (typeof file !== "string" || Number.isNaN(at)) {
		writeFd(
			2,
			`measure-outcome-review: --baseline and --filed-at go together, --filed-at an ISO time.\n${USAGE}\n`,
		);
		return 2;
	}
	const r = readFilingBaseline({ file, filedAt: at, root, seats });
	if ("error" in r) {
		writeFd(2, `measure-outcome-review: ${r.error}\n`);
		return 2;
	}
	writeFd(1, json ? `${JSON.stringify(r, null, 2)}\n` : buildBaselineText(r));
	return r.failures.length > 0 ? 1 : 0;
}

/**
 * The weekly review.
 * @param {{now: string | undefined, root: string, seats: string[],
 *   json: boolean}} o
 * @returns {number} the exit code
 */
function reviewMain({ now, root, seats, json }) {
	let nowMs;
	try {
		nowMs = typeof now === "string" ? Date.parse(now) : clockNow();
	} catch (e) {
		nowMs = Number.NaN;
		writeFd(2, `measure-outcome-review: ${caught(e).message}\n`);
	}
	if (Number.isNaN(nowMs)) {
		writeFd(2, `measure-outcome-review: --now is not a date.\n${USAGE}\n`);
		return 2;
	}
	let tracker;
	try {
		tracker = requireKey("tracker", { root });
	} catch (e) {
		writeFd(2, `measure-outcome-review: ${caught(e).message}\n`);
		return 2;
	}
	const r = review({ root, seats, nowMs, tracker });
	writeFd(1, json ? `${JSON.stringify(r, null, 2)}\n` : buildText(r));
	return r.failures.length > 0 ? 1 : 0;
}

function main() {
	const { flags, lists } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: {
			"--now": "value",
			"--json": "boolean",
			"--root": "value",
			"--config-dir": "list",
			"--baseline": "value",
			"--filed-at": "value",
		},
	});
	const root = path.resolve(flagValue(flags, "--root") ?? hostRoot());
	const seats = lists["--config-dir"] ?? configDirs();
	const json = "--json" in flags;
	process.exitCode =
		"--baseline" in flags || "--filed-at" in flags
			? baselineMain({
					file: flagValue(flags, "--baseline"),
					filedAt: flagValue(flags, "--filed-at"),
					root,
					seats,
					json,
				})
			: reviewMain({ now: flagValue(flags, "--now"), root, seats, json });
}

if (require.main === module) main();
