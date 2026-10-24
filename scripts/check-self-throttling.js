#!/usr/bin/env node
/*
 * check-self-throttling.js — reports that the founder appears to have rationed
 * the agent allowance rather than crashed into it.
 *
 * WHY ANYTHING NEEDS TO ASK. `scripts/measure-ceiling/scan_ceiling.py` filters
 * transcripts to lines carrying `"rate_limit"` or `"apiErrorStatus":429`, so it
 * measures crashes, not scarcity (mantahostels#1342). An operator who stops work at 99% of a
 * weekly allowance generates no record at all, and the corpus carries no usage
 * percentage and no approaching-limit warning anywhere.
 *
 * WHAT IT LOOKS FOR. Not a collapse in the daily turn count, which cannot do
 * this job: the innocent collapses in it are DEEPER than the real one. The
 * shape of the silence works where the count fails — a dead window of >=20h
 * flanked on both sides by 3 active hours at >=0.65 of the trailing-7-day
 * busy-hour rate. Thresholds and reasoning: scripts/lib/turn-collapse.js and
 * https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/self-throttling-turn-collapse.md (mantahostels#1362).
 *
 * IT REPORTS AND NOTHING MORE. Both thresholds were fitted after seeing the
 * answer, against one event. No spend-ladder trigger is wired to it,
 * deliberately (mantahostels#1362).
 *
 * WARN, never FAIL. A detected episode is a prompt to go and read Settings ->
 * Usage, not a fault in the repo.
 *
 * THREE PATHS, because the sweep costs 10-19s and a session start allows
 * single-digit seconds:
 *
 *   --notify   reads the state file, sweeps not at all, and kicks a detached
 *              --refresh once a day. The SessionStart path, silent by default.
 *   --refresh  sweeps, writes the state file and appends to the history.
 *              Prints nothing anyone reads.
 *   neither    sweeps live, reports a stalled collector and every candidate
 *              gap whatever the notice setting, and records.
 *              `npm run check:throttling`, and `npm run status`.
 *
 * ONCE A DAY AND NOT PER SESSION: a per-session sweep costs too much CPU,
 * and incremental scanning saves nothing (mantahostels#1362, mantahostels#1130).
 *
 * WIRED THROUGH `scripts/sweep-debts-detached.sh`, which carries this script's
 * IMPLICIT / JUSTIFIED / DEFEAT annotation for the guard registry — the hooks file
 * names the launcher, never this file (mantahostels#1362's piggyback ruling; mantahostels#1404).
 */

const fs = require("node:fs");
const { writeFileAtomic } = require("./lib/atomic-write.js");
const { spawn } = require("node:child_process");

const { configDirs } = require("./lib/arbiter-store");
const { caught } = require("./lib/caught.js");
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
	corpusRoots,
	deadWindows,
	episodes,
	hourlyCounts,
	readCorpus,
	trailingBusyRate,
} = require("./lib/turn-collapse");

/**
 * One dead window as `lib/turn-collapse.js` scores it.
 *
 * @typedef {ReturnType<import("./lib/turn-collapse.js").deadWindows>[number]} Window
 */

/** @typedef {import("./lib/check").Ctx} Ctx */

/** Past this age the stored sweep says nothing: it may predate an episode that
 *  has since ended, and a silent stale file reads exactly like a clean one. */
const STATE_STALE_HOURS = 48;

/** The once-a-day cadence mantahostels#1362 ruled. Below it, no refresh is kicked — every
 *  parallel session start would otherwise launch its own 10-19s sweep. */
const REFRESH_MIN_AGE_HOURS = 24;

/** How long a detected episode stays news. The ladder's companion instrument is
 *  a weekly Settings -> Usage reading, so an episode is worth repeating until
 *  that reading has come round once. */
const REPORT_WINDOW_DAYS = 7;

/** A cap on hook output, per mantahostels#1114: a report that grows with the backlog is the
 *  one thing a session-start line must not do. */
const MAX_REPORTED = 3;

/**
 * Whether a detected episode is announced at session start.
 *
 * OFF, and deliberately. The detector can inform no decision today: mantahostels#1362 wired
 * no ladder rung to it, both its thresholds were fitted against a single event,
 * and no capacity has been cut yet — so the condition it watches for does not
 * exist, and the one episode it finds is a stop the founder made and remembers.
 * What it still earns is the sweep, whose readings are perishable (`historyFile`
 * in lib/throttle-paths.js). Keep collecting, stop announcing — founder's ruling at mantahostels#1404.
 *
 * TURN THIS BACK ON THE DAY A SEAT IS CUT. That is the day an operator who
 * absorbs the shortfall by quietly stopping becomes invisible to every other
 * instrument — `scan_ceiling.py` reads refusals, and the ladder's restore
 * trigger counts BLOCKED hours, of which a deliberate stop generates none.
 */
const NOTICE_ON_SESSION_START = false;

/** Two missed daily sweeps. One is a machine asleep at the wrong hour. */
const COLLECTOR_STALE_HOURS = 48;

/**
 * How long since the history last grew, or null while it is keeping up.
 *
 * WHY ANYTHING CHECKS. With the notice off, collecting is the only thing this
 * does, and `--refresh` runs detached under `stdio: "ignore"` — so its BROKEN
 * on an unwritable history is written to nowhere at all. Without this a
 * read-only or full disk ends the collection in total silence, and the gap is
 * discovered on the day someone finally needs the baseline (mantahostels#1404).
 *
 * Reads the mtime, not the last line: the file only ever grows, and a stat is
 * O(1) where a tail is not.
 *
 * @returns {number | null} hours since the last reading, when overdue
 */
function collectorStalledHours() {
	const now = Date.now();
	const overdue = (/** @type {number} */ ms) => {
		const age = (now - ms) / 36e5;
		return age > COLLECTOR_STALE_HOURS ? age : null;
	};
	try {
		return overdue(fs.statSync(historyFile()).mtimeMs);
	} catch {
		/* No history at all — normal on a fresh machine until the first sweep
		 * lands. The stamp is what tells "not started yet" from "kicked and never
		 * finishing", and with neither there is nothing to complain about. */
		try {
			const kicked = Date.parse(fs.readFileSync(refreshStamp(), "utf8").trim());
			return Number.isFinite(kicked) ? overdue(kicked) : null;
		} catch {
			return null;
		}
	}
}

/**
 * The window/constant limb of the chain, shared by `noticeBase()` and
 * `noticeDecision()`: a declared
 * gate 2 trial window turns the notice on for the window's duration, and
 * otherwise the constant above decides (mantahostels#2857).
 *
 * THE CONSTANT SURVIVES because the trial is one reason to switch the notice on
 * and not the only one — mantahostels#1404's own instruction is "turn this back on the day
 * a seat is cut", and a permanent cut is not a trial.
 *
 * THE WINDOW ALONE DECIDES IT, with no `accountUuid` match (mantahostels#2857 Q5). This
 * reader sees transcripts and never seats, so it has no seat dimension on which
 * to disagree with a declaration; failing closed on a seat-match result it
 * cannot itself diagnose would lose the corroborating record for the very
 * fortnight it exists to corroborate. `check-seat-utilisation.js` is the reader
 * that owns that diagnosis, and prints it at the same session start.
 *
 * @returns {{ enabled: boolean, by: "window" | "constant", detail: string }}
 */
function resolvedNotice() {
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

/**
 * What the notice would be with no environment override in play — the
 * RESOLVED non-env state `noticeDecision()`'s own env branch is compared
 * against (mantahostels#2857), so this must never itself consult the override.
 */
const noticeBase = () => resolvedNotice().enabled;

/**
 * The notice's setting AND the input that decided it, which mantahostels#2857 made this
 * reader owe: an unhonourable or expired declaration is silent here — the
 * collector prints the loud version off the same file at the same session start
 * and a second copy across ~10 concurrent sessions is duplicate noise — so this
 * record is the only way to answer "why was this session silent" afterwards.
 *
 * `WFC_THROTTLE_NOTICE=1`/`=0` stays top of the chain: it keeps both sides
 * reachable from a test without editing code, and it is the founder's escape
 * from a mis-dated window without a commit.
 *
 * @returns {{ enabled: boolean, by: "override" | "window" | "constant", detail: string }}
 */
function noticeDecision() {
	const override = process.env.WFC_THROTTLE_NOTICE;
	if (override === "1" || override === "0")
		return {
			enabled: override === "1",
			by: "override",
			detail: `WFC_THROTTLE_NOTICE=${override}`,
		};
	return resolvedNotice();
}

const noticeEnabled = () => noticeDecision().enabled;

/**
 * Kick a detached sweep, at most once every `REFRESH_MIN_AGE_HOURS`. Fire and
 * forget: the session must not wait on it, and its failure is the next run's
 * missing state rather than anything to report here.
 *
 * THE STAMP IS TAKEN BEFORE THE SPAWN, AND A FAILED STAMP CANCELS THE SPAWN.
 * A fresh machine has no state file, so EVERY session
 * start reaches the no-state branch until the first sweep lands ~26s later. A
 * throttle keyed on the state file alone is therefore no throttle at all: the
 * ~200 starts a day would each spawn their own corpus walk, and on a read-only
 * or full disk — where no sweep can ever record itself — that never stops.
 * Unthrottled is the one outcome worse than silent.
 *
 * THE READ AND THE WRITE HAPPEN UNDER AN EXCLUSIVE CLAIM, so starts landing in
 * the same tick cannot both pass: the loser is a no-op, and at most one kicked
 * sweep runs machine-wide (workflow-core#2098). A hand-run `--refresh` or live sweep takes
 * no claim.
 *
 * Residual: a start that judged a claim stale can unlink a newer start's live
 * one, letting a third in beside it. It needs a killed start's debris and
 * three starts inside one claim's milliseconds.
 *
 * @returns {boolean} whether a sweep was launched
 */
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
		spawn(process.execPath, [__filename, "--refresh"], {
			detached: true,
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
		return true; // no stamp yet, or an unreadable one
	}
}

/** Older than this, a kick claim is debris from a start killed between the
 *  read and the write it guards, which take milliseconds. A guess, unmeasured:
 *  set below a loaded machine's slowest read-and-write, a live claim is broken
 *  and two starts kick at once. */
const KICK_CLAIM_STALE_MS = 10_000;

/**
 * Take the claim `kickRefresh()` decides under, or report it held. A stale
 * claim is removed but not taken, so two starts that both find it stale can
 * never both proceed: the next start after the break wins it.
 *
 * @param {string} stamp
 * @returns {boolean}
 */
function claimKick(stamp) {
	const claim = `${stamp}.claim`;
	try {
		fs.closeSync(fs.openSync(claim, "wx"));
		return true;
	} catch (e) {
		// Any other failure is an unwritable directory, where the stamp
		// cannot be written either: no sweep, as kickRefresh() rules.
		if (caught(e).code !== "EEXIST") return false;
		try {
			if (Date.now() - fs.statSync(claim).mtimeMs > KICK_CLAIM_STALE_MS)
				fs.unlinkSync(claim);
		} catch {
			/* gone already, or unremovable: either way not ours */
		}
		return false;
	}
}

/** @param {string} stamp */
function releaseKick(stamp) {
	try {
		fs.unlinkSync(`${stamp}.claim`);
	} catch {
		/* already gone */
	}
}

/** The stored sweep, or null where there is none, it will not parse, or it is
 *  too old to speak. Never throws: this runs on the session-start path. */
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
 * Record a completed sweep, in both places a sweep is recorded: the state file
 * the session-start path reads, and the append-only history that outlives the
 * transcripts. The single seam every sweep passes through, so a future caller
 * cannot record one without the other.
 *
 * Neither failure throws — a read-only disk must not kill the sweep — so
 * each is reported separately and the caller decides what to do about it.
 *
 * @param {ReturnType<typeof sweep>} swept
 * @returns {{state: boolean, history: boolean}} which of the two writes landed
 */
function recordSweep(swept) {
	const now = Date.now();
	const reading = {
		sweptAt: new Date(now).toISOString(),
		fileCount: swept.fileCount,
		turnCount: swept.turnCount,
		busyRate: swept.busyRate === null ? null : Math.round(swept.busyRate),
		/* Every gap considered, not only those that fired. A day with no episode
		 * still carries its rate and its near-misses, which is what makes a run of
		 * readings a baseline rather than a fire list. */
		candidates: swept.windows.map(serialise),
		// Absolute instants, never ages: the reader ages them itself.
		episodes: swept.fired.map(serialise),
	};
	// History first, state second: a reader polls on the state file's
	// existence, so ordering the append before the rename means a landed
	// history write is never behind the state it accompanies (a failed
	// append is a separate, already-reported failure below).
	let history = true;
	try {
		/* JSONL, so a torn write costs the last line and never the file, which a
		 * rewritten JSON array would risk every time. `appendFileSync` opens
		 * `O_APPEND`, so the sessions sharing this machine cannot interleave at
		 * an offset — but nothing makes a single line atomic, so read it
		 * defensively: a trailing partial line is expected, not corruption.
		 *
		 * UNBOUNDED, DELIBERATELY. ~1-2 KB a line at one sweep a day is well under
		 * a megabyte a year, and every rotation policy considered deletes the
		 * oldest readings — which are precisely the pre-cut ones this file exists
		 * to keep. Revisit only if interactive runs start dominating the line
		 * count. */
		fs.appendFileSync(historyFile(), `${JSON.stringify(reading)}\n`);
	} catch {
		history = false;
	}
	let state = true;
	const target = stateFile();
	try {
		// Atomic, because a session-start reader may be mid-`readFileSync` on
		// this very path.
		writeFileAtomic(target, `${JSON.stringify(reading, null, 2)}\n`);
	} catch {
		state = false;
	}
	return { state, history };
}

/**
 * One window as the state file and the `--json` envelope carry it: absolute
 * instants, never ages, so the reader ages them against its own clock.
 *
 * @param {Window} w
 */
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

/**
 * One episode, for a reader who has never opened the artefact.
 *
 * The ratios are read defensively even though `episodes()` cannot pass a null
 * one: on the `--notify` path they come off a state file on disk, and a
 * session-start hook must print SOMETHING rather than die on a corrupt cache.
 *
 * @param {{hours: number, start: string, end: string, beforeRatio: number|null, afterRatio: number|null, busyRate: number|null}} ep
 */
function renderEpisode(ep) {
	const flank = (/** @type {number | null} */ r) =>
		r === null ? "?" : r.toFixed(2);
	return (
		`  ${ep.hours}h with no assistant turn (a ${MIN_DEAD_HOURS}h floor), ${utc(ep.start)} -> ${utc(ep.end)}\n` +
		`    flanked by ${FLANK_HOURS}h of work at ${flank(ep.beforeRatio)} and ${flank(ep.afterRatio)} of the ` +
		`trailing-7-day busy-hour rate (${ep.busyRate ?? "?"}/h), against a ${FLANK_RATIO} threshold`
	);
}

/**
 * --refresh: pay the sweep, write the state, say nothing.
 * @param {Ctx} ctx
 */
function refreshState(ctx) {
	const swept = sweep();
	/* ONE ctx.broken FOR BOTH. It throws, so a branch per write reports
	 * only the first — and the ordinary failure, a read-only or full disk,
	 * fails both at once, which silenced the history exactly where it is
	 * the one loss no later run can repair (mantahostels#1404). */
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

/**
 * A collector that has stopped: a FAULT, not an episode, so a hand run says it
 * whatever the notice setting — mantahostels#1404 silenced the announcing and kept the
 * collecting. Read before the live sweep, whose own append would hide it. Off
 * the --notify path, since no session acts on it; `npm run status` carries it
 * (workflow-core#2038).
 * @param {Ctx} ctx
 */
function sayCollectorStall(ctx) {
	const stalled = collectorStalledHours();
	if (stalled === null) return;
	/* A WARN, or `npm run status` folds the line away under an OK summary. */
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

/**
 * What a --notify run says whatever the notice setting: an export overriding
 * the repo's setting.
 * @param {Ctx} ctx
 */
function sayNotifyFaults(ctx) {
	/* Compared against the RESOLVED non-env state, never the constant
	 * (mantahostels#2857): against the constant, an export reversing a LIVE
	 * TRIAL prints nothing. */
	const base = noticeBase();
	if (process.env.WFC_THROTTLE_NOTICE !== undefined && noticeEnabled() !== base)
		ctx.say(
			`(WFC_THROTTLE_NOTICE=${process.env.WFC_THROTTLE_NOTICE} is overriding this\n` +
				`repo's setting, which is ${base ? "on" : "off"}${
					trialLive() ? " while a gate 2 trial window is live" : ""
				}.)\n`,
		);
}

/**
 * The live path: sweep now, warm the state for the next session start, and
 * print every candidate gap.
 * @param {Ctx} ctx
 */
function liveSweep(ctx) {
	const swept = sweep();
	const windows = swept.windows;
	const fired = swept.fired.map(serialise);
	const counts = { fileCount: swept.fileCount, turnCount: swept.turnCount };
	const wrote = recordSweep(swept);
	/* Not BROKEN: this run's report — the table below and run()'s after it —
	 * is answerable and this run's reader has their answer. It is the next
	 * session start that now has nothing. */
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
	/* Every candidate gap, fired or not, on the live path only — far too much
	 * for a session-start hook, which prints fires alone. */
	ctx.say(candidateTable(windows));
	return { windows, fired, counts };
}

/**
 * The SELF-THROTTLING warning, and the episodes it names.
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
 * The OK line, naming the deciding input where an episode went unannounced.
 * @param {{ recent: unknown[], fired: unknown[], days: number, decision: ReturnType<typeof noticeDecision> }} at
 * @returns {string}
 */
function okLineFor({ recent, fired, days, decision }) {
	if (recent.length > 0)
		/* Reached only when the notice is gated off — an announced episode
		 * is a WARN and never prints an OK line at all. It must not read as
		 * "nothing found": --json carries it, and so does a later reader
		 * wondering why a silent session start had something to say. The
		 * DECIDING INPUT is named rather than the constant assumed (mantahostels#2857). */
		return (
			`${recent.length} episode(s) in the last ${days} days, not announced at ` +
			`session start (${decision.detail}).`
		);
	if (fired.length > 0)
		return `no self-throttling in the last ${days} days (${fired.length} episode(s) all-time).`;
	return "no self-throttling episode anywhere in the corpus.";
}

/**
 * The hook run's source: the state file only. A 10-19s sweep here is killed by
 * the hook's timeout, and a killed check prints exactly what a clean one
 * prints, so the silence would never surface as a fault.
 *
 * @param {Ctx} ctx
 */
function fromState(ctx) {
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
			const read = fromState(ctx);
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
			/* Counted as episodes only where one was found; a stalled collector
			 * alone is a finding of its own. */
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

/** The whole corpus, swept. */
function sweep() {
	const files = corpusFiles(corpusRoots());
	/* SKIP, not BROKEN: the transcript corpus is the SUBJECT and lives outside
	 * the repo, so a machine that has never run Claude Code, or a seat directory
	 * pruned away, is not this repo's fault (lib/check.js's subject/apparatus
	 * split). It must never read as "no throttling found". */
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
		/* Taken at the sweep's own instant rather than at some window's edge. */
		busyRate: trailingBusyRate(hourlyCounts(turns), Date.now()),
	};
}
