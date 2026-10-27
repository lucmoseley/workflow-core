#!/usr/bin/env node
/*
 * pick-retro-sessions.js — which finished sessions of one week a retro should
 * read, ranked by fault signal, from one pool across every repo that runs the
 * plugin (workflow-core#960; contract: workflow-core#948 §Session picker).
 *
 * IN NO SCRIPT FAMILY (docs/code-standards-base.md §N3): a read-only ranker
 * whose output retro-sweep reads. Prints one JSON object to stdout; exits 2 on
 * a bad argument.
 *
 * POOL. Every seat's `projects/` (`lib/seat-args.js`), realpath-deduped, one
 * copy of each session (`lib/project-dirs.js`). A session's repo comes from the
 * first `cwd` its transcript records, never from the slug, which flattens every
 * `/`, `.` and `-` alike and so cannot be read back into a path. Excluded by
 * that cwd: job temp (`<seat>/jobs/<id>/tmp`), system temp (`os.tmpdir()`) and
 * repo scratch (`<repo>/.claude/tmp/…`). A harness worktree
 * (`<repo>/.claude/worktrees/<name>`) counts as its repo. A repo is pooled
 * where it is workflow-core itself (its own `.claude-plugin/plugin.json`) or
 * its `.claude/settings.json`, as committed when the session started, enables
 * `workflow-core@<marketplace>`; that commit's pin is the release reported.
 *
 * WINDOW. A session belongs to the week its first timestamp falls in:
 * `[start, start + 7 days)`, start being `--week`'s date at 00:00 UTC, or
 * 7 days before now by default. `WFC_NOW` pins now.
 *
 * EXCLUDED: an `sdk-cli` entrypoint (headless `claude -p`); the calling
 * session (`CLAUDE_CODE_SESSION_ID`); any session `lib/agent-liveness.js`
 * reads as live, or, on another seat, the arbiter's sessions registry does.
 * Where either cannot be read, every session whose main or subagent log
 * changed within 60 minutes is skipped too, and stderr says so.
 *
 * SCORE. workflow-core#876's six signals, counted over the main log and every subagent log,
 * each capped at 10, summed. A classifier denial is not also a tool error. Ties go to more API responses (distinct
 * `requestId`s), then to the lower session id so the order is stable.
 *
 * THE ONE WRITE IS THE ORACLE LIBRARY'S: its single-flight cache under
 * `CLAUDE_CONFIG_DIR` (`lib/oracle-cache.js`). This script opens nothing for
 * writing, and its `git` calls only read.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { listedSessionIds, isListedLive } = require("./lib/agent-liveness");
const { readLiveSessionIds } = require("./lib/arbiter-core");
const { parseOrExit, exitWith, flagValue, CliExit } = require("./lib/cli-args");
const { streamRecords } = require("./lib/encoding-use");
const { readSessionHead, repoRootOf } = require("./lib/session-head.js");
const { findPin, isCoreHost, readJsonSafe } = require("./lib/plugin-state");
const { readSeatTranscripts } = require("./lib/project-dirs");
const { seatsFrom } = require("./lib/seat-args");
const {
	STOP_FEEDBACK,
	parseContentText,
	subagentDirOf,
} = require("./lib/transcript");
const { byCodeUnit } = require("./lib/by-code-unit.js");
const { execGit } = require("./lib/git.js");

const USAGE = `Usage: node scripts/pick-retro-sessions.js [--week <date>] [--top <n>]
  [--calibrate [--seed <s>]] [--config-dir <dir>]...

Ranks one week's finished sessions, across every repo that runs the
workflow-core plugin, by fault signal. Prints JSON.

  --week <date>       the week starting at <date> 00:00 UTC (default: the last 7 days)
  --top <n>           keep the first <n> sessions
  --calibrate         the top 8 as "rank" plus 4 random others as "control"
  --seed <s>          make the --calibrate draw repeatable
  --config-dir <dir>  a seat to read, repeatable (default: every known seat)`;

const DAY_MS = 86_400_000;
/* workflow-core#948 §Session picker sets the hour, the cap and the 8 + 4 split (workflow-core#927's
 * ruled 12-session calibration batch, a third of it random control). None is
 * measured; calibration is what tests them. */
const LIVE_WINDOW_MS = 60 * 60_000;
const SIGNAL_CAP = 10;
const CALIBRATE_RANKED = 8;
const CALIBRATE_CONTROLS = 4;

const CLASSIFIER = /auto mode classifier/i;
/* A founder asking whether the session is still moving. A first cut from the
 * workflow-core#883 trial's three asks; calibration is what tests it. */
const LIVENESS_ASK =
	/\b(progress|have a (check|look)|check (in|on)|status|any (news|update)|how'?s it going|how is it going|still (working|going|running|there|alive)|are you (stuck|there|alive|working)|stuck|frozen|stalled|hung)\b/i;
/* A first guess, and stated as one: the workflow-core#883 asks run to ~120 characters, and
 * a longer message mentioning "progress" is the founder briefing new work.
 * Only `origin.kind` human counts: a subagent log's dispatch prompt is a plain
 * user string too. Each `[image]` marker in the text counts toward the cap. */
const LIVENESS_ASK_MAX = 200;

/** @typedef {{toolErrors: number, classifierDenials: number, stopBlocks: number,
 *   compactions: number, livenessAsks: number, apiErrors: number}} Signals
 * @typedef {{signals: Signals, requests: Set<string>}} Tally
 * @typedef {import("./lib/session-head.js").SessionHead} SessionHead
 * @typedef {{file: string, sessionId: string, subagentDir: string|null,
 *   subagentLogs: string[], changed: number, head: SessionHead, root: string,
 *   release: string|null}} Candidate */

/**
 * @typedef {Record<string, any>} LogPart One parsed session-log record, or one
 * content block inside its message. `any` because streamRecords hands back
 * JSON.parse's output untyped, and each field is read through `?.` or a type
 * test where it is used.
 */

/** @returns {number} */
function now() {
	const raw = process.env.WFC_NOW;
	if (!raw) return Date.now();
	const t = Date.parse(raw);
	if (Number.isNaN(t))
		exitWith(new CliExit(2, `WFC_NOW is not a date: ${raw}\n`));
	return t;
}

/** An absent directory reads empty: a session with no subagents. @param {string} dir */
function readDir(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** NaN where the file cannot be stat'ed. @param {string} file */
function readMtimeOf(file) {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return Number.NaN;
	}
}

/**
 * A repo's `.claude/settings.json` as last committed before `at`, so a session
 * reports the pin it ran under rather than one bumped since. The working copy
 * where git has no such commit to show.
 * @param {string} root
 * @param {string} at  an ISO timestamp
 * @returns {unknown}
 */
function readSettingsAt(root, at) {
	const rel = ".claude/settings.json";
	const git = (/** @type {string[]} */ args) =>
		execGit(["-C", root, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			// A guess, never measured: a wedged git, not a slow one.
			timeout: 10_000,
		}).trim();
	try {
		const sha = git(["log", "-1", "--format=%H", `--before=${at}`, "--", rel]);
		if (sha) return JSON.parse(git(["show", `${sha}:${rel}`]));
	} catch {
		/* Not a repo git can read, or no parseable commit: the working copy
		 * below is the best remaining answer. */
	}
	return readJsonSafe(path.join(root, rel));
}

/**
 * Whether a repo ran the plugin at `at`, and the release it pinned: `self`
 * for workflow-core itself, the pin's `ref` (or null) for an adopter.
 * @param {string} root
 * @param {string} at
 * @returns {{release: string|null} | null}
 */
function readPluginRelease(root, at) {
	if (isCoreHost(root)) return { release: "self" };
	const settings =
		/** @type {import("./lib/plugin-state").AdopterSettings|null} */ (
			readSettingsAt(root, at)
		);
	const pin = findPin(settings, "workflow-core");
	if (!pin.marketplace) return null;
	if (settings?.enabledPlugins?.[`workflow-core@${pin.marketplace}`] !== true)
		return null;
	return { release: pin.ref };
}

/**
 * Adds one log's signals and request ids to `tally`. Throws where the log
 * cannot be read, leaving what was counted before the failure.
 * @param {string} file
 * @param {"main"|"subagent"} tier
 * @param {Tally} tally accumulator: signals are counted and request ids added
 */
function countSignals(file, tier, { signals, requests }) {
	for (const r of streamRecords(file, tier)) {
		if (r.type === "system" && r.subtype === "compact_boundary")
			signals.compactions++;
		else if (r.type === "assistant") {
			if (typeof r.requestId === "string") requests.add(r.requestId);
			if (r.isApiErrorMessage) signals.apiErrors++;
		} else if (r.type === "user") countUserSignals(r, signals);
	}
}

/**
 * @param {LogPart} r
 * @param {Signals} signals accumulator: counts stop blocks, liveness asks and tool errors
 */
function countUserSignals(r, signals) {
	const content = r.message?.content;
	if (Array.isArray(content)) countToolErrors(content, signals);
	const text = parseContentText(content);
	if (STOP_FEEDBACK.test(text)) signals.stopBlocks++;
	else if (
		r.origin?.kind === "human" &&
		text.length <= LIVENESS_ASK_MAX &&
		LIVENESS_ASK.test(text)
	)
		signals.livenessAsks++;
}

/**
 * @param {LogPart[]} content
 * @param {Signals} signals accumulator: counts classifier denials and other tool errors
 */
function countToolErrors(content, signals) {
	for (const b of content) {
		if (b?.type !== "tool_result" || !b.is_error) continue;
		if (CLASSIFIER.test(parseContentText(b.content)))
			signals.classifierDenials++;
		else signals.toolErrors++;
	}
}

/**
 * A seeded uniform draw in [0, 1) — mulberry32 over the seed's hash — or
 * Math.random where no seed is given.
 * @param {string|undefined} seed
 */
function drawFrom(seed) {
	if (seed === undefined) return Math.random;
	let a = crypto.createHash("sha256").update(seed).digest().readUInt32LE(0);
	return () => {
		a = (a + 0x6d_2b_79_f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/** @param {string[]} argv */
function parseArgs(argv) {
	const { flags, lists } = parseOrExit(argv, {
		usage: USAGE,
		flags: {
			"--week": "value",
			"--top": "value",
			"--calibrate": "boolean",
			"--seed": "value",
			"--config-dir": "list",
		},
	});
	const refuse = (/** @type {string} */ why) =>
		exitWith(new CliExit(2, `${why}\n\n${USAGE}\n`));

	const t = now();
	const start = weekStart(flagValue(flags, "--week"), t, refuse);
	const topFlag = flagValue(flags, "--top");
	const top = topOf(topFlag, refuse);
	const calibrate = flags["--calibrate"] === true;
	if (calibrate && topFlag) refuse("--top and --calibrate exclude each other");
	const seed = flagValue(flags, "--seed");
	if (seed !== undefined && !calibrate)
		refuse("--seed applies only with --calibrate");
	return {
		t,
		start,
		end: start + 7 * DAY_MS,
		top,
		calibrate,
		seed,
		seats: seatsFrom(lists["--config-dir"]),
	};
}

/**
 * @param {string | undefined} week
 * @param {number} t
 * @param {(why: string) => void} refuse
 */
function weekStart(week, t, refuse) {
	if (week === undefined) return t - 7 * DAY_MS;
	const start = /^\d{4}-\d{2}-\d{2}$/.test(week)
		? Date.parse(`${week}T00:00:00Z`)
		: Number.NaN;
	if (Number.isNaN(start)) refuse(`--week is not a date (YYYY-MM-DD): ${week}`);
	if (start > t) refuse(`--week names a week not yet begun: ${week}`);
	return start;
}

/**
 * @param {string | undefined} topFlag
 * @param {(why: string) => void} refuse
 */
function topOf(topFlag, refuse) {
	if (topFlag === undefined) return Number.POSITIVE_INFINITY;
	const top = Number(topFlag);
	if (!Number.isInteger(top) || top < 1)
		refuse(`--top needs a positive whole number: ${topFlag}`);
	return top;
}

/**
 * The window's sessions in plugin repos, before the liveness skip, with the
 * main logs that could not be read and the seat or project directories that
 * could not be listed (workflow-core#1054).
 * @param {string[]} seats
 * @param {number} start
 * @param {number} end
 * @returns {{ candidates: Candidate[], unreadable: string[], unlisted: { refused: string[], absent: string[] } }}
 */
function poolCandidates(seats, start, end) {
	const me = process.env.CLAUDE_CODE_SESSION_ID;
	/** @type {Candidate[]} */
	const candidates = [];
	/** @type {string[]} */
	const unreadable = [];
	const listing = readSeatTranscripts(seats);
	for (const file of listing.files) {
		const sessionId = path.basename(file, ".jsonl");
		if (sessionId === me) continue;
		const c = candidateOf(file, sessionId, { start, end });
		if (c.unreadable) unreadable.push(file);
		if (c.candidate) candidates.push(c.candidate);
	}
	return {
		candidates,
		unreadable,
		unlisted: { refused: [...listing.unreadable], absent: [...listing.absent] },
	};
}

/**
 * One listed main log as a Candidate, or null where the session is excluded;
 * `unreadable` says the log itself could not be read.
 * @param {string} file
 * @param {string} sessionId
 * @param {{ start: number, end: number }} window
 * @returns {{ candidate: Candidate|null, unreadable: boolean }}
 */
function candidateOf(file, sessionId, { start, end }) {
	const own = readMtimeOf(file);
	if (Number.isNaN(own)) return { candidate: null, unreadable: true };
	const subagentDir = subagentDirOf(file);
	const subagentLogs = readDir(subagentDir)
		.filter((e) => e.name.endsWith(".jsonl"))
		.map((e) => path.join(subagentDir, e.name));
	// A subagent log that vanished since the listing changes nothing here.
	const changed = Math.max(
		own,
		...subagentLogs.map(readMtimeOf).filter((m) => !Number.isNaN(m)),
	);
	// The first record is written before any later one, so a log last
	// changed before the window opened cannot start inside it.
	const excluded = { candidate: null, unreadable: false };
	if (changed < start) return excluded;
	/** @type {SessionHead} */
	let head;
	try {
		head = readSessionHead(file);
	} catch {
		return { candidate: null, unreadable: true };
	}
	if (!head.firstTimestamp || !head.cwd) return excluded;
	const first = Date.parse(head.firstTimestamp);
	if (!(first >= start && first < end)) return excluded;
	if (head.entrypoint === "sdk-cli") return excluded;
	const root = repoRootOf(head.cwd);
	if (!root) return excluded;
	const plugin = readPluginRelease(root, head.firstTimestamp);
	if (!plugin) return excluded;
	return {
		candidate: {
			file,
			sessionId,
			subagentDir: subagentLogs.length > 0 ? subagentDir : null,
			subagentLogs,
			changed,
			head,
			root,
			release: plugin.release,
		},
		unreadable: false,
	};
}

/**
 * The candidates nothing shows running. `claude agents --json` lists the
 * caller's own seat; the sessions registry (`lib/arbiter-core.js`) covers
 * every seat by pid. A session the oracle calls finished is kept whatever the
 * registry says, its process merely resident. Where either cannot be read,
 * the header's EXCLUDED fallback applies (workflow-core#948 §Session picker).
 * @param {Candidate[]} candidates
 * @param {number} t
 * @returns {Candidate[]}
 */
function dropLive(candidates, t) {
	if (candidates.length === 0) return candidates;
	const listed = listedSessionIds();
	const registry = readLiveSessionIds();
	/** @type {string[]} */
	const doubts = [];
	if (listed.why !== undefined)
		doubts.push(`the liveness oracle could not be read (${listed.why})`);
	if (registry === null) doubts.push("the sessions registry could not be read");
	const { ids, terminal } = listed;
	const kept = candidates.filter((c) => {
		if (ids && isListedLive(c.sessionId, ids, terminal)) return false;
		if (terminal?.has(c.sessionId)) return true;
		if (registry?.has(c.sessionId)) return false;
		return doubts.length === 0 || t - c.changed >= LIVE_WINDOW_MS;
	});
	if (doubts.length > 0)
		writeFd(
			2,
			`pick-retro-sessions: ${doubts.join(" and ")}, so ${
				candidates.length - kept.length
			} session(s) whose transcript changed in the last 60 minutes were skipped.\n`,
		);
	return kept;
}

/**
 * One candidate's output row, and the logs that failed partway: each is
 * counted on what was read (workflow-core#960 fails open here: one bad log must not drop a
 * week's ranking).
 * @param {Candidate} c
 */
function scoreSession(c) {
	/** @type {string[]} */
	const unreadable = [];
	/** @type {Tally} */
	const tally = {
		signals: {
			toolErrors: 0,
			classifierDenials: 0,
			stopBlocks: 0,
			compactions: 0,
			livenessAsks: 0,
			apiErrors: 0,
		},
		requests: new Set(),
	};
	for (const [log, tier] of /** @type {Array<[string, "main"|"subagent"]>} */ ([
		[c.file, "main"],
		...c.subagentLogs.map((l) => [l, "subagent"]),
	]))
		try {
			countSignals(log, tier, tally);
		} catch {
			unreadable.push(log);
		}
	return {
		row: {
			sessionId: c.sessionId,
			repo: path.basename(c.root),
			repoRoot: c.root,
			transcript: c.file,
			subagentDir: c.subagentDir,
			firstTimestamp: c.head.firstTimestamp,
			release: c.release,
			signals: tally.signals,
			apiResponses: tally.requests.size,
			score: Object.values(tally.signals).reduce(
				(sum, n) => sum + Math.min(n, SIGNAL_CAP),
				0,
			),
		},
		unreadable,
	};
}

/**
 * The top CALIBRATE_RANKED as `rank`, then CALIBRATE_CONTROLS drawn uniformly
 * from the rest as `control`, each keeping its place in the full ranking.
 * @template {object} T
 * @param {T[]} scored  in rank order
 * @param {string|undefined} seed
 */
function pickCalibration(scored, seed) {
	const rest = scored.slice(CALIBRATE_RANKED);
	const draw = drawFrom(seed);
	// A partial Fisher-Yates: the first k slots end up a uniform draw.
	const k = Math.min(CALIBRATE_CONTROLS, rest.length);
	for (let i = 0; i < k; i++) {
		const j = i + Math.floor(draw() * (rest.length - i));
		const [a, b] = [rest[i], rest[j]];
		if (a === undefined || b === undefined)
			throw new Error(`swap ${i}↔${j} fell outside ${rest.length} sessions`);
		[rest[i], rest[j]] = [b, a];
	}
	return [
		...scored
			.slice(0, CALIBRATE_RANKED)
			.map((s, i) => ({ rank: i + 1, pick: "rank", ...s })),
		...rest.slice(0, k).map((s) => ({
			rank: scored.indexOf(s) + 1,
			pick: "control",
			...s,
		})),
	];
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const pool = poolCandidates(args.seats, args.start, args.end);
	const { unlisted } = pool;
	const eligible = dropLive(pool.candidates, args.t);
	const results = eligible.map((c) => scoreSession(c));
	const scored = results.map((r) => r.row);
	const unreadable = [
		...pool.unreadable,
		...results.flatMap((r) => r.unreadable),
	];
	scored.sort(
		(a, b) =>
			b.score - a.score ||
			b.apiResponses - a.apiResponses ||
			byCodeUnit(a.sessionId, b.sessionId),
	);
	const sessions = args.calibrate
		? pickCalibration(scored, args.seed)
		: scored.slice(0, args.top).map((s, i) => ({ rank: i + 1, ...s }));

	if (unlisted.refused.length > 0)
		writeFd(
			2,
			`pick-retro-sessions: ${unlisted.refused.length} director(ies) could not be listed, so no session under them is pooled; fix the permission, or leave the seat out by naming the others with --config-dir:\n${unlisted.refused
				.map((d) => `  ${d}\n`)
				.join("")}`,
		);
	if (unlisted.absent.length > 0)
		writeFd(
			2,
			`pick-retro-sessions: ${unlisted.absent.length} seat(s) have no projects/ directory, so hold no session:\n${unlisted.absent
				.map((d) => `  ${d}\n`)
				.join("")}`,
		);
	if (unreadable.length > 0)
		writeFd(
			2,
			`pick-retro-sessions: ${unreadable.length} log(s) could not be read; a main log's session is left out, a session with a bad subagent log is ranked on what was read:\n${unreadable
				.map((f) => `  ${f}\n`)
				.join("")}`,
		);
	writeFd(
		1,
		`${JSON.stringify(
			{
				window: {
					start: new Date(args.start).toISOString(),
					end: new Date(args.end).toISOString(),
				},
				pooled: scored.length,
				sessions,
			},
			null,
			2,
		)}\n`,
	);
}

if (require.main === module) main();
