#!/usr/bin/env node
/*
 * report-outcome-review.js — the outcome review of fault-stopping changes,
 * retro-sweep weekly mode's step (spec #4796 §Outcome review, ticket #4797).
 * It gives every verdict; the retro copies `--json` into its run line's
 * `outcomes[]` and never overrides one. It files nothing and writes nothing.
 *
 * FINDINGS are every line of the signature log (lib/fault-signature.js's
 * SIGNATURE_LOG) with a signature, and every `findings[]` entry with an issue
 * and a signature on a weekly run line (docs/data/retro-runs.jsonl). A finding
 * in both is read once, as the run record has it. A late line is reported
 * apart throughout.
 *
 * SETTLED: a finding a prior run line gave `keep` or `unwind` is not read
 * again; it is listed as settled. An unwind carried past the cap stays in the
 * ranking (below) until filed.
 *
 * THE FIX is derived here, never stored: the finding issue must be closed, and
 * its fix is the latest commit on `origin/main` (as last fetched; this script
 * does not fetch) whose message cites it — `#<n>` word-bounded where the
 * finding is the tracker's, or `<owner/name>#<n>` anywhere. Either missing,
 * the verdict is `waiting`. The first reading is at the first run
 * INTERVAL_DAYS or more after the fix's commit date.
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
 * `now`. `expected` is rate × sessions, `observed` the hits in them.
 *
 * VERDICTS: guardrail harm (a revert of the fix on origin/main, or a `bug`
 * issue filed after the fix that cites the finding or the fix sha) is
 * `unwind`, whatever the counts. With expected ≥ EXPECTED_FLOOR, `keep` where
 * Poisson P(X ≤ observed | expected) ≤ KEEP_P, `unwind` where observed ≥
 * expected, else `extend`. Under EXPECTED_FLOOR it is `extend`. A finding a
 * prior run already extended, read inconclusive again, is `unwind`.
 *
 * UNWINDS are ranked harm first, then observed ÷ expected, highest first; the
 * top UNWIND_CAP are to file this run and the rest are carried. The prior run
 * line's `outcomeStep.backlog` joins the ranking and is never dropped.
 *
 * MISSES, the backstop for a signature never declared: the tracker's tickets
 * closed in the MISS_DAYS to `now` that landed a commit citing them, carry
 * `bug` or a FAULT_SHAPE title or closing-commit subject, have no line in
 * either record, and carry no `origin:*` label: a ticket filed past
 * file-issue.js's declarations, by a hand `gh issue create`. A labelled ticket
 * with no line declared `--no-fault`, so it is no miss; every such ticket
 * carrying `bug` is listed apart, as the declaration to doubt.
 *
 * THE FLIP CHECK is due once FLIP_RUNS weekly runs, this one included, reached
 * a verdict other than `waiting`; earlier where this run's carried backlog is
 * over FLIP_BACKLOG, or FLIP_OVER_BUDGET_RUNS run lines spent over
 * TOKEN_BUDGET on the step.
 *
 * A read that fails is named and never counted as zero: a reading that needs
 * it is `waiting`, its `why` naming the failure, and the run exits 1. A seat
 * that does not exist is noted, not failed. Exit 2 for a command line
 * lib/cli-args.js refuses or no tracker.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseOrExit } = require("./lib/cli-args");
const { writeFd } = require("./lib/write-fd.js");
const { caught } = require("./lib/caught.js");
const { parseJsonlRow, readJsonl } = require("./lib/jsonl.js");
const { now: clockNow } = require("./lib/check");
const { ghIssueListAll, ghJson, parseErrLine } = require("./lib/gh");
const { gitOutcome } = require("./lib/git");
const { hostRoot } = require("./lib/host-root");
const { configDirs } = require("./lib/arbiter-store");
const { readSeatTranscripts } = require("./lib/project-dirs");
const { requireKey } = require("./lib/workflow-core-config");
const { originOfLabels } = require("./lib/issue-origin");
const {
	SIGNATURE_LOG,
	readRegistry,
	readSignatureLog,
	signatureHits,
} = require("./lib/fault-signature");

/* ---- Constants. The spec's values are untraced (#4796 §Values); the rest
 * are this script's own judgement. ---- */

/** The run record, at the repo root. */
const RUN_RECORD = "docs/data/retro-runs.jsonl";
const DAY_MS = 86_400_000;
/** The trigger week, never part of the baseline. */
const TRIGGER_DAYS = 7;
/** The baseline's span before the trigger week (#4796: 4 weeks). */
const BASELINE_WEEKS = 4;
/** Days after the fix's commit before the first reading (#4796). */
const INTERVAL_DAYS = 7;
/** Expected recurrences the window grows to (#4796: 3; e^-3 ≈ 5%). */
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
/** Bytes read from a transcript's head to find its first timestamp. */
const START_PROBE_BYTES = 65_536;

const USAGE = `usage: node scripts/report-outcome-review.js [--now <iso>] [--json] [--root <dir>] [--config-dir <dir>]...
  --now         the reading instant (default: WFC_NOW, else the clock)
  --json        the report as JSON, for the retro's run line
  --root        the repo whose ${RUN_RECORD}, ${SIGNATURE_LOG} and origin/main are read (default: this host)
  --config-dir  a seat to read transcripts from, repeatable (default: every seat)`;

/**
 * @typedef {import("./lib/fault-signature").Signature} Signature
 * @typedef {{count: number, sessions: number, rate: number}} Baseline
 * @typedef {{ref: string, repo: string, n: number, filedAt: number,
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
 */

const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
const day = (/** @type {number} */ ms) => iso(ms).slice(0, 10);
const round3 = (/** @type {number} */ x) => Math.round(x * 1000) / 1000;
const escapeRe = (/** @type {string} */ s) =>
	s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

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
 * `owner/name#n` split, or null.
 * @param {unknown} ref
 */
function parseRef(ref) {
	const m =
		typeof ref === "string" ? /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref) : null;
	return m?.[1] && m[2] ? { repo: m[1], n: Number(m[2]) } : null;
}

/**
 * Whether `text` cites issue `n` of `repo`: the full ref anywhere, or a bare
 * `#n` where `repo` is the tracker.
 * @param {string} text
 * @param {{repo: string, n: number}} ref
 * @param {string} tracker
 */
function cites(text, { repo, n }, tracker) {
	if (new RegExp(`(?<![\\w.-])${escapeRe(repo)}#${n}(?!\\w)`).test(text))
		return true;
	return (
		repo === tracker && new RegExp(`(?<![\\w/.#-])#${n}(?!\\w)`).test(text)
	);
}

/**
 * Every line of a JSONL file; ENOENT is no lines, a line that will not parse
 * is named.
 * @param {string} file
 * @returns {{lines: Array<Record<string, any>>, bad: number[]}}
 */
function readRows(file) {
	const read = readJsonl(file);
	return {
		lines: /** @type {Array<Record<string, any>>} */ (read?.rows ?? []),
		bad: read?.bad ?? [],
	};
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
 * One session's hits on each signature: its main log, and every subagent log
 * under it, each on its own tier.
 * @param {string} mainLog
 * @param {Signature[]} sigs
 * @param {Record<string, any>} registry
 * @returns {number[]}
 * @throws where a log will not read
 */
function sessionHits(mainLog, sigs, registry) {
	const counts = sigs.map(() => 0);
	const add = (
		/** @type {string} */ text,
		/** @type {"main" | "subagent"} */ tier,
	) => {
		sigs.forEach((s, i) => {
			counts[i] =
				(counts[i] ?? 0) + signatureHits(text, s, tier, registry).length;
		});
	};
	add(fs.readFileSync(mainLog, "utf8"), "main");
	const subDir = path.join(
		path.dirname(mainLog),
		path.basename(mainLog, ".jsonl"),
		"subagents",
	);
	/** @type {string[]} */
	let names = [];
	try {
		names = fs.readdirSync(subDir);
	} catch (e) {
		if (caught(e).code !== "ENOENT") throw e;
	}
	for (const name of names.sort())
		if (name.endsWith(".jsonl"))
			add(fs.readFileSync(path.join(subDir, name), "utf8"), "subagent");
	return counts;
}

/** @param {unknown} e */
const unreadable = (e) => `(${caught(e).code ?? caught(e).message})`;

/**
 * Every session starting at or after `fromMs`, one copy across the seats, in
 * time order.
 * @param {string[]} seats
 * @param {number} fromMs
 * @param {{failures: string[], notes: string[]}} log
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
 * @param {Record<string, any>} registry
 * @param {string[]} failures
 * @returns {Array<number[] | null>}
 */
function hitsFor(requests, registry, failures) {
	/** @type {Map<string, number[]>} */
	const wanted = new Map();
	requests.forEach((r, i) => {
		for (const s of r.sessions)
			wanted.set(s.file, [...(wanted.get(s.file) ?? []), i]);
	});
	/** @type {Map<string, Map<number, number>>} */
	const got = new Map();
	for (const [file, who] of wanted) {
		try {
			const counts = sessionHits(
				file,
				who.map(
					(i) => /** @type {(typeof requests)[number]} */ (requests[i]).sig,
				),
				registry,
			);
			got.set(file, new Map(who.map((i, k) => [i, counts[k] ?? 0])));
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
 * @param {{repo: string, n: number}} ref
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
			if (tracker === f.repo && b.number === f.n) return false;
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
 * @param {Array<Record<string, any>>} sigLines
 * @param {Array<Record<string, any>>} weekly
 * @param {string[]} failures
 */
function collectFindings(sigLines, weekly, failures) {
	/** @type {Map<string, Finding>} */
	const findings = new Map();
	/** @type {Set<string>} */
	const signed = new Set();
	/**
	 * @param {Record<string, any>} entry  a log line or a `findings[]` entry
	 * @param {number} filedAt
	 * @param {string} where  for a failure line
	 */
	const add = (entry, filedAt, where) => {
		if (typeof entry?.issue !== "string") return;
		signed.add(entry.issue);
		if (!entry.signature) return;
		const ref = parseRef(entry.issue);
		if (!ref || Number.isNaN(filedAt)) {
			failures.push(
				`${where} ${JSON.stringify(entry.issue)} has no usable issue or date`,
			);
			return;
		}
		const held = findings.get(entry.issue);
		findings.set(entry.issue, {
			ref: entry.issue,
			...ref,
			filedAt: held?.filedAt ?? filedAt,
			signature: entry.signature,
			baseline: entry.baseline ?? null,
			late: held?.late === true || entry.late === true,
		});
	};
	for (const l of sigLines)
		add(l, Date.parse(l.filedAt), "signature log line for");
	for (const line of weekly)
		for (const f of Array.isArray(line.findings) ? line.findings : [])
			add(
				f,
				Date.parse(line.week?.end ?? line.date),
				`run line ${line.date} finding`,
			);
	return { findings, signed };
}

/**
 * The latest prior outcome of each finding, those ever extended, and the last
 * run's carried backlog.
 * @param {Array<Record<string, any>>} weekly
 */
function readPrior(weekly) {
	/** @type {Map<string, Record<string, any>>} */
	const prior = new Map();
	/** @type {Set<string>} */
	const extended = new Set();
	for (const line of weekly)
		for (const o of Array.isArray(line.outcomes) ? line.outcomes : []) {
			if (typeof o?.finding !== "string") continue;
			prior.set(o.finding, o);
			if (o.verdict === "extend") extended.add(o.finding);
		}
	const held = weekly.at(-1)?.outcomeStep?.backlog;
	/** @type {string[]} */
	const backlog = Array.isArray(held)
		? held.filter((/** @type {unknown} */ b) => typeof b === "string")
		: [];
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
 * @typedef {{commits: Commit[] | string, bugs: IssueRow[] | string,
 *   tracker: string, nowMs: number, failures: string[]}} Reads
 */

/**
 * A finding as far as the tracker and origin/main take it: a `waiting`
 * outcome, or a reading due its counts.
 * @param {Finding} f
 * @param {Reads} reads
 * @returns {Outcome | Reading}
 */
function stageFinding(f, { commits, bugs, tracker, nowMs, failures }) {
	/** @type {{state?: string}} */
	let issue;
	try {
		issue = ghJson([
			"issue",
			"view",
			String(f.n),
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
	if (typeof commits === "string")
		return waiting(f, `origin/main unread: ${commits}`);
	const fix = fixOf(commits, f, tracker);
	if (!fix) return waiting(f, "no commit on origin/main cites it");
	const fixed = { fixSha: fix.sha, fixAt: iso(fix.at) };
	const due = fix.at + INTERVAL_DAYS * DAY_MS;
	if (nowMs < due) return waiting(f, `first reading from ${day(due)}`, fixed);
	if (typeof bugs === "string")
		return waiting(f, `follow-ons unread: ${bugs}`, fixed);
	return {
		f,
		fix,
		guardrails: {
			reverts: revertsOf(commits, fix),
			followOns: followOnsOf(bugs, f, fix, { tracker, nowMs }),
		},
	};
}

/**
 * Each reading's baseline (the run record's, else counted over the four weeks
 * before its trigger week) and its window: the sessions after the fix until
 * rate × sessions reaches the floor, with their hits. Null hits where a
 * session would not read.
 * @param {Reading[]} reading
 * @param {{seats: string[], registry: Record<string, any>, nowMs: number,
 *   failures: string[], notes: string[]}} at
 */
function countReadings(reading, { seats, registry, nowMs, failures, notes }) {
	const from = Math.min(
		...reading.map((r) =>
			r.f.baseline
				? r.fix.at
				: r.f.filedAt - (TRIGGER_DAYS + BASELINE_WEEKS * 7) * DAY_MS,
		),
	);
	const sessions = indexSessions(seats, from, { failures, notes });
	const owed = reading.filter((r) => !r.f.baseline);
	const baseHits = hitsFor(
		owed.map((r) => {
			const end = r.f.filedAt - TRIGGER_DAYS * DAY_MS;
			const start = end - BASELINE_WEEKS * 7 * DAY_MS;
			return {
				sig: r.f.signature,
				sessions: sessions.filter((s) => s.start >= start && s.start < end),
			};
		}),
		registry,
		failures,
	);
	const baselines = reading.map((r) => {
		if (r.f.baseline) return r.f.baseline;
		const hits = baseHits[owed.indexOf(r)];
		if (!hits) return null;
		const count = hits.reduce((a, b) => a + b, 0);
		return {
			count,
			sessions: hits.length,
			rate: hits.length > 0 ? count / hits.length : 0,
		};
	});
	const takes = reading.map((r, i) => {
		const rate = baselines[i]?.rate ?? 0;
		const need =
			rate > 0
				? Math.ceil(EXPECTED_FLOOR / rate - 1e-9)
				: Number.POSITIVE_INFINITY;
		return baselines[i]
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
	const expected = base.rate * take.length;
	const { verdict, why } = judge({
		observed,
		expected,
		harm: guardrails.reverts.length + guardrails.followOns.length > 0,
		extendedBefore: at.extended.has(f.ref),
	});
	const last = take.at(-1);
	return {
		finding: f.ref,
		...fixed,
		window: {
			start: iso(fix.at),
			end: last && expected >= EXPECTED_FLOOR ? iso(last.start) : iso(at.nowMs),
		},
		sessions: take.length,
		observed,
		expected: round3(expected),
		verdict,
		unwindIssue: null,
		late: f.late,
		baseline: { ...base, rate: round3(base.rate) },
		why,
	};
}

/**
 * Reads every unsettled finding. Transcripts are read only where a finding
 * is due its counts.
 * @param {Finding[]} findings
 * @param {Reads & {extended: Set<string>, seats: string[],
 *   registry: Record<string, any>, notes: string[]}} at
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
 * @param {Map<string, Record<string, any>>} prior
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
	/** @type {Array<Record<string, any>>} prior outcomes are the record's, unchecked */
	const ranked = [...fresh, ...carried];
	const rows = ranked.map((o) => {
		const reverts = o.guardrails?.reverts ?? [];
		const followOns = o.guardrails?.followOns ?? [];
		const rank = unwindRatio(o);
		return {
			finding: o.finding,
			fixSha: o.fixSha ?? null,
			observed: o.observed ?? null,
			expected: o.expected ?? null,
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
 * The week's closed tickets that landed a commit, look fault-shaped, have no
 * line in either record and declared nothing.
 * @param {IssueRow[]} closed
 * @param {{commits: Commit[], signed: Set<string>, tracker: string, nowMs: number}} at
 */
function readMisses(closed, { commits, signed, tracker, nowMs }) {
	const since = nowMs - MISS_DAYS * DAY_MS;
	const out = [];
	for (const i of closed) {
		const at = Date.parse(i.closedAt ?? "");
		const ref = `${tracker}#${i.number}`;
		if (!(at >= since && at <= nowMs) || signed.has(ref)) continue;
		if (originOfLabels(labelsOf(i)) !== null) continue;
		const fix = fixOf(commits, { repo: tracker, n: i.number }, tracker);
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
 * Every `bug` ticket carrying an `origin:*` label and no signature line:
 * declared `--no-fault`.
 * @param {IssueRow[]} bugs
 * @param {{signed: Set<string>, tracker: string}} at
 */
function readNoFaultBugs(bugs, { signed, tracker }) {
	return bugs.flatMap((i) => {
		const origin = originOfLabels(labelsOf(i));
		const ref = `${tracker}#${i.number}`;
		return origin && !signed.has(ref)
			? [{ issue: ref, title: i.title, origin }]
			: [];
	});
}

/**
 * @param {Array<Record<string, any>>} weekly prior weekly run lines
 * @param {Outcome[]} outcomes this run's
 * @param {number} backlog this run's carried count
 */
function flipCheck(weekly, outcomes, backlog) {
	const reached = (/** @type {Array<{verdict?: string}>} */ os) =>
		os.some((o) => o?.verdict && o.verdict !== "waiting");
	const runs =
		weekly.filter((l) => Array.isArray(l.outcomes) && reached(l.outcomes))
			.length + (reached(outcomes) ? 1 : 0);
	const over = weekly.filter(
		(l) => Number(l.outcomeStep?.tokens) > TOKEN_BUDGET,
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
	const out = [`Outcome review at ${r.now} (tracker ${r.tracker})`];
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
	out.push(
		"",
		`Missed signatures (closed ${MISS_DAYS} days to now, landed, fault-shaped, no signature line): ${r.misses === null ? "UNREAD" : r.misses.length}`,
		...(r.misses ?? []).map(
			(m) =>
				`  ${m.issue} ${JSON.stringify(m.title)} — ${m.why.join(", ")}; fix ${m.fixSha.slice(0, 9)}`,
		),
		"",
		`Declared --no-fault yet carrying bug: ${r.noFaultBug === null ? "UNREAD" : r.noFaultBug.length}`,
		...(r.noFaultBug ?? []).map(
			(m) => `  ${m.issue} ${JSON.stringify(m.title)} — origin:${m.origin}`,
		),
		"",
		`Flip check: ${r.flipDue.due ? "DUE" : "not due"} — ${r.flipDue.why}`,
	);
	if (r.notes.length > 0)
		out.push("", "Notes:", ...r.notes.map((n) => `  ${n}`));
	if (r.failures.length > 0)
		out.push("", "FAILED READS:", ...r.failures.map((f) => `  ${f}`));
	return `${out.join("\n")}\n`;
}

/**
 * The tracker's `bug` issues and the week's closes, or why each would not read.
 * @param {string} tracker
 * @param {number} nowMs
 * @param {string[]} failures
 */
function readTracker(tracker, nowMs, failures) {
	/** @param {string} what @param {string[]} args */
	const list = (what, args) => {
		try {
			return /** @type {IssueRow[]} */ (
				ghIssueListAll(what, ["--repo", tracker, ...args])
			);
		} catch (e) {
			const why = `${what} unread: ${parseErrLine(e)}`;
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
	};
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
	const sig = readSignatureLog(root);
	const runs = readRows(path.join(root, RUN_RECORD));
	for (const b of sig.bad)
		failures.push(`${SIGNATURE_LOG} line ${b} does not parse`);
	for (const b of runs.bad)
		failures.push(`${RUN_RECORD} line ${b} does not parse`);
	const weekly = runs.lines.filter((l) => l.mode === "weekly");
	const { findings, signed } = collectFindings(sig.lines, weekly, failures);
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
	const commits = readMainLog(root, nowMs);
	if (typeof commits === "string") failures.push(commits);
	const { bugs, closed } = readTracker(tracker, nowMs, failures);
	const outcomes = readOutcomes(open, {
		commits,
		bugs,
		tracker,
		nowMs,
		failures,
		extended,
		seats,
		registry: readRegistry(root),
		notes,
	});
	const unwinds = rankUnwinds(outcomes, carriedIn, prior);
	const misses =
		typeof closed === "string" || typeof commits === "string"
			? null
			: readMisses(closed, { commits, signed, tracker, nowMs });
	const noFaultBug =
		typeof bugs === "string"
			? null
			: readNoFaultBugs(bugs, { signed, tracker });
	/** @type {Record<string, Signature>} */
	const signatures = {};
	for (const f of findings.values()) signatures[f.ref] = f.signature;
	const backlog = unwinds.carried.map((u) => u.finding);
	return {
		now: iso(nowMs),
		tracker,
		outcomes,
		unwinds,
		outcomeStep: { misses: misses?.length ?? null, backlog },
		settled,
		misses,
		noFaultBug,
		flipDue: flipCheck(weekly, outcomes, backlog.length),
		signatures,
		notes: [...new Set(notes)],
		failures: [...new Set(failures)],
	};
}

function main() {
	const { flags, lists } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: {
			"--now": "value",
			"--json": "boolean",
			"--root": "value",
			"--config-dir": "list",
		},
	});
	const root =
		typeof flags["--root"] === "string"
			? path.resolve(flags["--root"])
			: hostRoot();
	let nowMs;
	try {
		nowMs =
			typeof flags["--now"] === "string"
				? Date.parse(flags["--now"])
				: clockNow();
	} catch (e) {
		nowMs = Number.NaN;
		writeFd(2, `report-outcome-review: ${caught(e).message}\n`);
	}
	if (Number.isNaN(nowMs)) {
		writeFd(2, `report-outcome-review: --now is not a date.\n${USAGE}\n`);
		process.exitCode = 2;
		return;
	}
	let tracker;
	try {
		tracker = requireKey("tracker", { root });
	} catch (e) {
		writeFd(2, `report-outcome-review: ${caught(e).message}\n`);
		process.exitCode = 2;
		return;
	}
	const r = review({
		root,
		seats: lists["--config-dir"] ?? configDirs(),
		nowMs,
		tracker,
	});
	writeFd(
		1,
		"--json" in flags ? `${JSON.stringify(r, null, 2)}\n` : buildText(r),
	);
	if (r.failures.length > 0) process.exitCode = 1;
}

module.exports = { FAULT_SHAPE, poissonCdf };

if (require.main === module) main();
