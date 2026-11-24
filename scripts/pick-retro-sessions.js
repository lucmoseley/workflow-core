#!/usr/bin/env node

const crypto = require("node:crypto");
const { scriptPath } = require("./lib/script-path.js");
const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { listedSessionIds, isListedLive } = require("./lib/agent-liveness");
const { readLiveSessionIds } = require("./lib/arbiter-core");
const { parseOrExit, exitWith, flagValue, CliExit } = require("./lib/cli-args");
const { streamRecords } = require("./lib/encoding-use");
const { readSessionHead, repoRootOf } = require("./lib/session-head.js");
const { findPin, isCoreHost, readJsonSafe } = require("./lib/plugin-state");
const { isPrefixedPrompt } = require("./lib/loop-prompts");
const { readSeatTranscripts } = require("./lib/project-dirs");
const { seatsFrom } = require("./lib/seat-args");
const {
	STOP_FEEDBACK,
	parseContentText,
	subagentDirOf,
} = require("./lib/transcript");
const { byCodeUnit } = require("./lib/by-code-unit.js");
const { orFallback } = require("./lib/caught.js");
const { execGit } = require("./lib/git.js");
const { errMessage, now: checkNow } = require("./lib/check");

const USAGE = `Usage: node ${scriptPath("pick-retro-sessions.js")} [--week <date>] [--top <n>]
  [--calibrate [--seed <s>]] [--config-dir <dir>]...

Ranks one week's finished sessions, across every repo that runs the
workflow-core plugin, by fault signal. Prints JSON.

  --week <date>       the week starting at <date> 00:00 UTC (default: the last 7 days)
  --top <n>           keep the first <n> sessions
  --calibrate         the top 8 as "rank" plus 4 random others as "control"
  --seed <s>          make the --calibrate draw repeatable
  --config-dir <dir>  a seat to read, repeatable (default: every known seat)`;

const DAY_MS = 86_400_000;
/* workflow-core#948 guess: calibration tests them */
const LIVE_WINDOW_MS = 60 * 60_000;
const SIGNAL_CAP = 10;
const CALIBRATE_RANKED = 8;
const CALIBRATE_CONTROLS = 4;

const CLASSIFIER = /auto mode classifier/i;
/* workflow-core#883 guess: calibration tests it */
const LIVENESS_ASK =
	/\b(progress|have a (check|look)|check (in|on)|status|any (news|update)|how'?s it going|how is it going|still (working|going|running|there|alive)|are you (stuck|there|alive|working)|stuck|frozen|stalled|hung)\b/i;
/* workflow-core#883 guess: the asks run to ~120 characters */
const LIVENESS_ASK_MAX = 200;

/** @typedef {{toolErrors: number, classifierDenials: number, stopBlocks: number,
 *   compactions: number, livenessAsks: number, apiErrors: number}} Signals
 * @typedef {{signals: Signals, requests: Set<string>}} Tally
 * @typedef {import("./lib/session-head.js").SessionHead} SessionHead
 * @typedef {{file: string, sessionId: string, subagentDir: string|null,
 *   subagentLogs: string[], changed: number, head: SessionHead, root: string,
 *   release: string|null}} Candidate */

/**
 * @typedef {import("./lib/transcript.js").TranscriptRecord} TranscriptRecord
 * @typedef {import("./lib/transcript.js").TranscriptBlock} TranscriptBlock
 */

/** @returns {number} */
function now() {
	try {
		return checkNow();
	} catch (e) {
		return exitWith(new CliExit(2, `${errMessage(e)}\n`));
	}
}

/** @param {string} dir */
function readDir(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** @param {string} file */
function readMtimeOf(file) {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return Number.NaN;
	}
}

/**
 * @param {string} root
 * @param {string} at
 * @returns {unknown}
 */
function readSettingsAt(root, at) {
	const rel = ".claude/settings.json";
	const git = (/** @type {string[]} */ args) =>
		execGit(["-C", root, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			// workflow-core#960 guess: a wedged git, not a slow one
			timeout: 10_000,
		}).trim();
	const committed = orFallback(() => {
		const sha = git(["log", "-1", "--format=%H", `--before=${at}`, "--", rel]);
		return sha ? JSON.parse(git(["show", `${sha}:${rel}`])) : undefined;
	}, undefined);
	if (committed !== undefined) return committed;
	return readJsonSafe(path.join(root, rel));
}

/**
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
 * @param {string} file
 * @param {"main"|"subagent"} tier
 * @param {Tally} tally
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
 * @param {TranscriptRecord} r
 * @param {Signals} signals
 */
function countUserSignals(r, signals) {
	const content = r.message?.content;
	if (Array.isArray(content)) countToolErrors(content, signals);
	const text = parseContentText(content);
	if (STOP_FEEDBACK.test(text)) signals.stopBlocks++;
	else if (
		r.origin?.kind === "human" &&
		!isPrefixedPrompt(text) &&
		text.length <= LIVENESS_ASK_MAX &&
		LIVENESS_ASK.test(text)
	)
		signals.livenessAsks++;
}

/**
 * @param {TranscriptBlock[]} content
 * @param {Signals} signals
 */
function countToolErrors(content, signals) {
	for (const b of content) {
		if (b?.type !== "tool_result" || !b.is_error) continue;
		if (CLASSIFIER.test(parseContentText(b.content)))
			signals.classifierDenials++;
		else signals.toolErrors++;
	}
}

/** @param {string|undefined} seed */
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
	const changed = Math.max(
		own,
		...subagentLogs.map(readMtimeOf).filter((m) => !Number.isNaN(m)),
	);
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

/** @param {Candidate} c */
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
 * @template {object} T
 * @param {T[]} scored
 * @param {string|undefined} seed
 */
function pickCalibration(scored, seed) {
	const rest = scored.slice(CALIBRATE_RANKED);
	const draw = drawFrom(seed);
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
