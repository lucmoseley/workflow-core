#!/usr/bin/env node
const fs = require("node:fs");
const { writeFileAtomic } = require("./lib/atomic-write.js");
const { spawnOutliving } = require("./lib/user-scope.js");

const { configDirs } = require("./lib/arbiter-store");
const { caught, ignoreFailure } = require("./lib/caught.js");
const { runCheck, skipError } = require("./lib/check");
const { trialLive } = require("./lib/trial-window");
const { ladderPath } = require("./lib/workflow-core-config");
const {
	historyFile,
	refreshStamp,
	stateFile,
} = require("./lib/throttle-paths.js");
const {
	CANDIDATE_MIN_HOURS,
	DAY_MS,
	FLANK_HOURS,
	FLANK_RATIO,
	MIN_DEAD_HOURS,
	corpusFiles,
	readCorpusRoots,
	deadWindows,
	episodes,
	hourlyCounts,
	readCorpus,
	trailingBusyRate,
} = require("./lib/turn-collapse");

/** @typedef {ReturnType<typeof import("./lib/turn-collapse.js").deadWindows>[number]} Window */

/** @typedef {import("./lib/check").Ctx} Ctx */

const STATE_STALE_HOURS = 48;

// lucmoseley/mantahostels#1362
const REFRESH_MIN_AGE_HOURS = 24;

const REPORT_WINDOW_DAYS = 7;

// lucmoseley/mantahostels#1114
const MAX_REPORTED = 3;

// lucmoseley/mantahostels#1404
const NOTICE_ON_SESSION_START = false;

const COLLECTOR_STALE_HOURS = 48;

/** @returns {number | null} */
function collectorStalledHours() {
	const now = Date.now();
	const overdue = (/** @type {number} */ ms) => {
		const age = (now - ms) / 36e5;
		return age > COLLECTOR_STALE_HOURS ? age : null;
	};
	try {
		return overdue(fs.statSync(historyFile()).mtimeMs);
	} catch {
		try {
			const kicked = Date.parse(fs.readFileSync(refreshStamp(), "utf8").trim());
			return Number.isFinite(kicked) ? overdue(kicked) : null;
		} catch {
			return null;
		}
	}
}

/** @returns {{ enabled: boolean, by: "window" | "constant", detail: string }} */
function buildResolvedNotice() {
	if (trialLive())
		return {
			enabled: true,
			by: "window",
			detail: "a gate 2 trial window is live; mantahostels#2857",
		};
	return {
		enabled: NOTICE_ON_SESSION_START,
		by: "constant",
		detail: `NOTICE_ON_SESSION_START is ${NOTICE_ON_SESSION_START ? "on" : "off"}; mantahostels#1404`,
	};
}

const noticeBase = () => buildResolvedNotice().enabled;

/** @returns {{ enabled: boolean, by: "override" | "window" | "constant", detail: string }} */
function noticeDecision() {
	const override = process.env.WFC_THROTTLE_NOTICE;
	if (override === "1" || override === "0")
		return {
			enabled: override === "1",
			by: "override",
			detail: `WFC_THROTTLE_NOTICE=${override}`,
		};
	return buildResolvedNotice();
}

const noticeEnabled = () => noticeDecision().enabled;

// #2098
/** @returns {boolean} */
function kickRefresh() {
	const now = Date.now();
	const stamp = refreshStamp();
	if (!claimKick(stamp)) return false;
	try {
		if (!isSweepDue(stamp, now)) return false;
		fs.writeFileSync(stamp, `${new Date(now).toISOString()}\n`);
	} catch {
		return false;
	} finally {
		releaseKick(stamp);
	}
	try {
		// #4706
		spawnOutliving(process.execPath, [__filename, "--refresh"], {
			stdio: "ignore",
		}).unref();
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {string} stamp
 * @param {number} now
 */
function isSweepDue(stamp, now) {
	try {
		const last = Date.parse(fs.readFileSync(stamp, "utf8").trim());
		return !(
			Number.isFinite(last) && (now - last) / 36e5 < REFRESH_MIN_AGE_HOURS
		);
	} catch {
		return true;
	}
}

// #2098 guess
const KICK_CLAIM_STALE_MS = 10_000;

/**
 * @param {string} stamp
 * @returns {boolean}
 */
function claimKick(stamp) {
	const claim = `${stamp}.claim`;
	try {
		fs.closeSync(fs.openSync(claim, "wx"));
		return true;
	} catch (e) {
		if (caught(e).code !== "EEXIST") return false;
		ignoreFailure(() => {
			if (Date.now() - fs.statSync(claim).mtimeMs > KICK_CLAIM_STALE_MS)
				fs.unlinkSync(claim);
		});
		return false;
	}
}

/** @param {string} stamp */
function releaseKick(stamp) {
	ignoreFailure(() => fs.unlinkSync(`${stamp}.claim`));
}

function readState() {
	const now = Date.now();
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
	} catch {
		return null;
	}
	const sweptAt = Date.parse(parsed?.sweptAt);
	if (!Number.isFinite(sweptAt)) return null;
	parsed.ageHours = (now - sweptAt) / 36e5;
	parsed.stale = parsed.ageHours > STATE_STALE_HOURS;
	return parsed;
}

/**
 * @param {ReturnType<typeof sweep>} swept
 * @returns {{state: boolean, history: boolean}}
 */
function recordSweep(swept) {
	const now = Date.now();
	const reading = {
		sweptAt: new Date(now).toISOString(),
		fileCount: swept.fileCount,
		turnCount: swept.turnCount,
		busyRate: swept.busyRate === null ? null : Math.round(swept.busyRate),
		candidates: swept.windows.map(serialise),
		episodes: swept.fired.map(serialise),
	};
	let history = true;
	try {
		fs.appendFileSync(historyFile(), `${JSON.stringify(reading)}\n`);
	} catch {
		history = false;
	}
	let state = true;
	const target = stateFile();
	try {
		writeFileAtomic(target, `${JSON.stringify(reading, null, 2)}\n`);
	} catch {
		state = false;
	}
	return { state, history };
}

/** @param {Window} w */
const serialise = (w) => ({
	start: new Date(w.start).toISOString(),
	end: new Date(w.end).toISOString(),
	hours: Number(w.hours.toFixed(1)),
	beforeRatio: w.beforeRatio === null ? null : Number(w.beforeRatio.toFixed(2)),
	afterRatio: w.afterRatio === null ? null : Number(w.afterRatio.toFixed(2)),
	busyRate: w.baseline === null ? null : Math.round(w.baseline),
});

/** @param {string} iso */
const utc = (iso) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** @param {{hours: number, start: string, end: string, beforeRatio: number|null, afterRatio: number|null, busyRate: number|null}} ep */
function renderEpisode(ep) {
	const flank = (/** @type {number | null} */ r) =>
		r === null ? "?" : r.toFixed(2);
	return (
		`  ${ep.hours}h with no assistant turn (a ${MIN_DEAD_HOURS}h floor), ${utc(ep.start)} -> ${utc(ep.end)}\n` +
		`    flanked by ${FLANK_HOURS}h of work at ${flank(ep.beforeRatio)} and ${flank(ep.afterRatio)} of the ` +
		`trailing-7-day busy-hour rate (${ep.busyRate ?? "?"}/h), against a ${FLANK_RATIO} threshold`
	);
}

/** @param {Ctx} ctx */
function refreshState(ctx) {
	const swept = sweep();
	// lucmoseley/mantahostels#1404
	const wrote = recordSweep(swept);
	const lost = [];
	if (!wrote.state)
		lost.push(
			`the cached sweep at ${stateFile()}, leaving the session start on the old one`,
		);
	if (!wrote.history)
		lost.push(
			`the reading history at ${historyFile()}, losing this reading for good`,
		);
	if (lost.length > 0)
		ctx.broken(`the sweep ran but could not write ${lost.join("; and ")}.`);
	return {
		okLine: `state refreshed: ${swept.turnCount} turn(s) over ${swept.fileCount} transcript(s).`,
		data: { refreshed: true, ...swept, windows: undefined },
	};
}

/** @param {Ctx} ctx */
function sayCollectorStall(ctx) {
	const stalled = collectorStalledHours();
	if (stalled === null) return;
	ctx.warn(
		"COLLECTOR-STALLED",
		`no reading recorded for ${Math.round(stalled)}h`,
		{
			hours: stalled,
		},
	);
	ctx.say(
		`SELF-THROTTLING COLLECTOR STALLED — no reading recorded for ${Math.round(stalled)}h.\n` +
			"  The daily sweep is what builds the pre-cut capacity baseline, and it has\n" +
			`  stopped growing ${historyFile()}.\n`,
	);
}

/** @param {Ctx} ctx */
function sayNotifyFaults(ctx) {
	// lucmoseley/mantahostels#2857
	const base = noticeBase();
	if (process.env.WFC_THROTTLE_NOTICE !== undefined && noticeEnabled() !== base)
		ctx.say(
			`(WFC_THROTTLE_NOTICE=${process.env.WFC_THROTTLE_NOTICE} is overriding this\n` +
				`repo's setting, which is ${base ? "on" : "off"}${
					trialLive() ? " while a gate 2 trial window is live" : ""
				}.)\n`,
		);
}

/** @param {Ctx} ctx */
function liveSweep(ctx) {
	const swept = sweep();
	const windows = swept.windows;
	const fired = swept.fired.map(serialise);
	const counts = { fileCount: swept.fileCount, turnCount: swept.turnCount };
	const wrote = recordSweep(swept);
	if (!wrote.state)
		ctx.say(
			`(could not write the cached sweep at ${stateFile()}, so the session\n` +
				"start has nothing to report from until that path is writable.)\n",
		);
	if (!wrote.history)
		ctx.say(
			`(could not append to ${historyFile()}, so this reading is lost\n` +
				"— see historyFile in scripts/lib/throttle-paths.js.)\n",
		);
	ctx.say(candidateTable(windows));
	return { windows, fired, counts };
}

/**
 * @param {Ctx} ctx
 * @param {Parameters<typeof renderEpisode>[0][]} recent
 * @param {number} days
 */
function announceRecent(ctx, recent, days) {
	ctx.warn(
		"SELF-THROTTLING",
		`${recent.length} dead window(s) in the last ${days} days match deliberate rationing`,
		{ episodes: recent },
	);
	ctx.say(
		`SELF-THROTTLING SIGNAL (${recent.length}) — work appears to have been stopped to stay\n` +
			"under a weekly allowance, rather than crashing into it. Nothing else can see this:\n" +
			"a deliberate stop leaves no rate-limit record for the ceiling scanner to read.\n" +
			`${recent.slice(0, MAX_REPORTED).map(renderEpisode).join("\n")}\n` +
			"  REPORTS ONLY. No spend-ladder rung is wired to this, deliberately: both\n" +
			"  thresholds were fitted after seeing one event (mantahostels#1362). Read Settings -> Usage\n" +
			`  on every seat, and see ${ladderPath()} before acting.\n`,
	);
}

/**
 * @param {{ recent: unknown[], fired: unknown[], days: number, decision: ReturnType<typeof noticeDecision> }} at
 * @returns {string}
 */
function okLineFor({ recent, fired, days, decision }) {
	if (recent.length > 0)
		return (
			`${recent.length} episode(s) in the last ${days} days, not announced at ` +
			`session start (${decision.detail}).`
		);
	if (fired.length > 0)
		return `no self-throttling in the last ${days} days (${fired.length} episode(s) all-time).`;
	return "no self-throttling episode anywhere in the corpus.";
}

/** @param {Ctx} ctx */
function readSweepFromState(ctx) {
	sayNotifyFaults(ctx);
	const state = readState();
	if (!state || state.stale) {
		kickRefresh();
		return {
			okLine: "no transcript sweep recent enough to report from.",
			data: { fromState: true, state: null },
		};
	}
	if (state.ageHours > REFRESH_MIN_AGE_HOURS) kickRefresh();
	return {
		fired: state.episodes || [],
		sweptAt: state.sweptAt,
		counts: { fileCount: state.fileCount, turnCount: state.turnCount },
	};
}

runCheck({
	name: "self-throttling",
	usage:
		"node check-self-throttling.js [--days <n>] [--warn] [--json] [--notify] [--refresh]",
	valueFlags: ["--days"],
	flags: ["--refresh"],
	/** @param {Ctx} ctx */
	run(ctx) {
		const days = Number(ctx.value("--days", String(REPORT_WINDOW_DAYS)));
		if (!Number.isFinite(days) || days < 0)
			ctx.usageError(
				`--days needs a non-negative number, got "${ctx.value("--days")}".`,
			);

		if (ctx.has("--refresh")) return refreshState(ctx);

		let fired;
		let windows = null;
		let sweptAt = null;
		let counts = {};
		if (ctx.notify) {
			const read = readSweepFromState(ctx);
			if ("okLine" in read) return read;
			({ fired, sweptAt, counts } = read);
		} else {
			sayCollectorStall(ctx);
			({ windows, fired, counts } = liveSweep(ctx));
		}

		const now = Date.now();
		const recent = fired
			.filter(
				(/** @type {{end: string}} */ ep) =>
					(now - Date.parse(ep.end)) / DAY_MS <= days,
			)
			.sort(
				(/** @type {{end: string}} */ a, /** @type {{end: string}} */ b) =>
					Date.parse(b.end) - Date.parse(a.end),
			);

		const decision = noticeDecision();
		const announce = !ctx.notify || decision.enabled;

		if (recent.length > 0 && announce) announceRecent(ctx, recent, days);

		const okLine = okLineFor({ recent, fired, days, decision });
		return {
			okLine,
			...(recent.length > 0 && {
				noun: "self-throttling episodes",
				count: recent.length,
			}),
			data: {
				days,
				notice: decision,
				...counts,
				sweptAt,
				episodes: fired,
				candidates: windows ? windows.map(serialise) : undefined,
			},
		};
	},
});

/**
 * Every candidate gap as a table, in the shape
 * https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/self-throttling-turn-collapse.md publishes.
 *
 * @param {Window[]} windows
 */
function candidateTable(windows) {
	const rows = windows.map((w) => {
		const r = (/** @type {number | null} */ x) =>
			(x === null ? "-" : x.toFixed(2)).padStart(6);
		return (
			`  ${utc(new Date(w.start).toISOString())}  ${w.hours.toFixed(1).padStart(5)}h  ` +
			`${r(w.beforeRatio)}${r(w.afterRatio)}  ` +
			`${(w.baseline === null ? "no baseline" : `${Math.round(w.baseline)}/h`).padStart(11)}`
		);
	});
	return (
		`CANDIDATE GAPS (${windows.length}) of ${CANDIDATE_MIN_HOURS}h or more. A gap fires only at ` +
		`${MIN_DEAD_HOURS}h or more\nwith BOTH flanks at ${FLANK_RATIO} or more of the trailing-7-day busy-hour rate.\n` +
		`  ${"start (UTC)".padEnd(22)}${"hours".padStart(6)}  ${"before".padStart(6)}${"after".padStart(6)}  ${"busy rate".padStart(11)}\n` +
		`${rows.join("\n")}\n`
	);
}

function sweep() {
	const files = corpusFiles(readCorpusRoots());
	if (files.length === 0)
		throw skipError(
			`no Claude Code transcripts found under ${configDirs().join(", ")}.`,
		);
	const turns = readCorpus(files);
	const windows = deadWindows(turns);
	return {
		fileCount: files.length,
		turnCount: turns.length,
		windows,
		fired: episodes(windows),
		busyRate: trailingBusyRate(hourlyCounts(turns), Date.now()),
	};
}
