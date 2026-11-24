#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// lucmoseley/mantahostels#1976
delete process.env.WFC_NOTIFY_PERSIST;

const { now, runCheck } = require("./lib/check");
const notify = require("./lib/notify-report.js");
const { delivered, recordDelivery } = require("./lib/delivery-stamp.js");
const {
	readSessionStartRoster: rosterOf,
	hasReadableHooks,
	KEY_OVERRIDES,
} = require("./lib/session-start-roster.js");
const { hostRoot } = require("./lib/host-root.js");
const { scriptPath } = require("./lib/script-path.js");
const { isRepoChecksReport } = require("./lib/repo-checks-reading.js");
const {
	isFounderNotice,
	isFounderNoticeHeld,
} = require("./lib/background-start.js");
const hookMessage = require("./lib/hook-message");
const { trimEndRun } = require("./lib/trim-run.js");

/** @typedef {import("./lib/check").Ctx} Ctx */

const SELF = "replay-notify-reports";

// workflow-core#1
const repoRoot = () => hostRoot();

// lucmoseley/mantahostels#2366

// lucmoseley/mantahostels#2284
/** @returns {Array<{ key: string, script: string }>} */
function readSessionStartRoster() {
	return rosterOf(repoRoot(), { keyOverrides: KEY_OVERRIDES, self: SELF });
}

// lucmoseley/mantahostels#1976
const SELF_REPORTS_CANCELLATION = new Set(["reap-finished-sessions"]);

// workflow-core#2038
const HELD_FOR_STATUS = new Set(["reap-finished-sessions", "reconcile-plugin"]);

/** @param {string} key */
const isHeldForStatus = (key) =>
	HELD_FOR_STATUS.has(key) || isRepoChecksReport(key);

/**
 * @param {Pass} pass
 * @param {string} key
 */
const isHeldAtStart = (pass, key) =>
	pass.ctx.notify &&
	(isHeldForStatus(key) || isFounderNoticeHeld(key, pass.source));

// guess: one missed start is no alarm, lucmoseley/mantahostels#1949
const SILENT_STARTS = 3;

// guess: smallest round multiple clearing 72 s against 65.3 s, lucmoseley/mantahostels#2342
const SILENT_AGE_MARGIN = 2;
const SILENT_AGE_FLOOR_MS = SILENT_AGE_MARGIN * 65_300;

// guess: far under any producer measured to date, lucmoseley/mantahostels#2342
const MIN_PLAUSIBLE_DURATION_MS = 1000;

/** @param {number|null} durationMs */
const silentAgeFloor = (durationMs) =>
	durationMs !== null && durationMs >= MIN_PLAUSIBLE_DURATION_MS
		? durationMs * SILENT_AGE_MARGIN
		: SILENT_AGE_FLOOR_MS;

/** @typedef {{ at: string, start: number, digest: string }} Shown */

// lucmoseley/mantahostels#1976
/** @param {string} checker */
const shownFile = (checker) =>
	path.join(
		notify.base(),
		`${checker.replace(/[^A-Za-z0-9_-]/g, "-")}.shown.json`,
	);

const startsFile = () => path.join(notify.base(), "replay-starts.json");

/**
 * @param {string} checker
 * @returns {Shown|null}
 */
function readShown(checker) {
	const raw = notify.readJSON(shownFile(checker));
	if (!raw || typeof raw.at !== "string") return null;
	return {
		at: raw.at,
		start: Number.isFinite(raw.start) ? Number(raw.start) : 0,
		digest: typeof raw.digest === "string" ? raw.digest : "",
	};
}

// lucmoseley/mantahostels#1976
function readStarts() {
	const raw = notify.readJSON(startsFile());
	return Number.isFinite(raw?.starts) ? Number(raw.starts) : 0;
}

/** @param {number} starts */
const writeStarts = (starts) =>
	notify.atomicWriteJSON(startsFile(), { starts });

/** @param {number|null} ms */
const humanAge = (ms) => {
	if (ms === null) return "of an unreadable date";
	const s = Math.round(ms / 1000);
	if (s < 90) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 90) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
};

/** @param {string} text */
const digestOf = (text) =>
	crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);

/** @typedef {import("./lib/notify-report.js").Report} Report */

/**
 * @typedef {{
 *   ctx: Ctx,
 *   now: number,
 *   delivering: boolean,
 *   spending: boolean,
 *   source?: string,
 *   startNo: number,
 *   gated: (key: string) => boolean,
 *   record: [string, Shown][],
 *   blocks: { text: string, notice: boolean }[],
 *   injected: { checker: string, outcome: Report["outcome"], age: number|null }[],
 *   stale: { checker: string, age: number|null }[],
 *   silent: { checker: string, starts: number, age: number|null }[],
 *   neverRan: { checker: string, starts: number }[],
 *   unreadable: string[],
 *   cancelled: { checker: string, startedAt: string }[],
 * }} Pass
 */

/**
 * @typedef {{
 *   name: string,
 *   age: number|null,
 *   digest: string,
 *   shown: Shown|null,
 *   next: Shown,
 *   empty: boolean,
 *   silentFor: number,
 * }} Reading
 */

// lucmoseley/mantahostels#2679
function readGate() {
	const rosterKnown = hasReadableHooks(repoRoot());
	const roster = readSessionStartRoster();
	const wired = new Set(roster.map((r) => r.key));
	/** @param {string} key */
	const gated = (key) => !rosterKnown || wired.has(key);
	const unwired = rosterKnown
		? notify
				.list()
				// workflow-core#1553
				.filter((k) => k !== SELF && !wired.has(k) && !isRepoChecksReport(k))
		: [];
	return { roster, gated, unwired };
}

/**
 * @param {Pass} pass
 * @param {string} key
 */
function replayKey(pass, key) {
	const report = notify.readReport(key);
	if (!report) {
		noteUnreadable(pass, key);
		return;
	}
	const r = readingOf(pass, key, report);
	const wedged = isWedged(pass, key, report, r);
	const tooOld = notify.isStale(
		report,
		report.maxAgeMs ?? notify.DEFAULT_STALE_MS,
		pass.now,
	);
	flagSilence(pass, key, r, { wedged, tooOld });
	pass.record.push([
		key,
		isHeldAtStart(pass, key)
			? r.next
			: offer(pass, report, r, heldAs(wedged, tooOld)),
	]);
}

/**
 * @param {Pass} pass
 * @param {Report} report
 * @param {Reading} r
 * @param {"wedged" | "stale" | null} held
 * @returns {Shown}
 */
function offer(pass, report, r, held) {
	if (r.empty) return r.next;

	const stamps = stampsOf(report, r.name);
	if (pass.delivering && alreadyShown(held, r, stamps)) return r.next;
	return inject(pass, report, r, { held, stamps });
}

/**
 * @param {Pass} pass
 * @param {string} key
 */
function noteUnreadable(pass, key) {
	if (pass.gated(key) && fs.existsSync(notify.reportFile(key))) {
		pass.unreadable.push(key);
		pass.ctx.warn(
			"UNREADABLE",
			`${key}'s persisted report will not parse — its findings are lost for this start.`,
			{ checker: key },
		);
	}
}

/**
 * @param {Pass} pass
 * @param {string} key
 * @param {Report} report
 * @returns {Reading}
 */
function readingOf(pass, key, report) {
	const name = report.checker || key;
	const age = notify.ageMs(report, pass.now);
	const digest = digestOf(report.text);
	const shown = readShown(key);
	const lastRun =
		shown === null || shown.at !== report.at ? pass.startNo : shown.start;
	const next = {
		at: report.at,
		start: lastRun,
		digest: shown?.digest ?? "",
	};
	const empty = !report.text.trim();
	return {
		name,
		age,
		digest,
		shown,
		next,
		empty,
		silentFor: pass.startNo - lastRun,
	};
}

/**
 * @param {Pass} pass
 * @param {string} key
 * @param {Report} report
 * @param {Reading} r
 */
function isWedged(pass, key, report, r) {
	// lucmoseley/mantahostels#2342
	const openRun = notify.readRun(key);
	const hasLiveRun = openRun !== null && !notify.isCancelled(openRun);
	return (
		pass.gated(key) &&
		!hasLiveRun &&
		r.silentFor >= SILENT_STARTS &&
		(r.age === null || r.age >= silentAgeFloor(report.durationMs))
	);
}

/**
 * @param {Pass} pass
 * @param {string} key
 * @param {Reading} r
 * @param {{ wedged: boolean, tooOld: boolean }} verdict
 */
function flagSilence(pass, key, r, { wedged, tooOld }) {
	if (wedged) {
		pass.silent.push({ checker: r.name, starts: r.silentFor, age: r.age });
		pass.ctx.warn(
			"SILENT",
			`${r.name} has not finished a run for ${r.silentFor} session starts — ` +
				`its last report is ${humanAge(r.age)}. A producer wedged at every ` +
				"start reads as nothing to say; run it by hand to see what it is stuck on.",
			{ checker: r.name, starts: r.silentFor },
		);
	} else if (
		tooOld &&
		!r.empty &&
		pass.gated(key) &&
		!isHeldAtStart(pass, key)
	) {
		// lucmoseley/mantahostels#1949
		pass.stale.push({ checker: r.name, age: r.age });
	}
}

/**
 * @param {boolean} wedged
 * @param {boolean} tooOld
 * @returns {"wedged" | "stale" | null}
 */
function heldAs(wedged, tooOld) {
	if (wedged) return "wedged";
	if (tooOld) return "stale";
	return null;
}

/**
 * @param {Report} report
 * @param {string} name
 */
function stampsOf(report, name) {
	// lucmoseley/mantahostels#1975
	const stampMap = {
		...(report.stamp && { [name]: report.stamp }),
		...report.stamps,
	};
	return Object.entries(stampMap);
}

/**
 * @param {"wedged" | "stale" | null} held
 * @param {Reading} r
 * @param {[string, string][]} stamps
 */
function alreadyShown(held, r, stamps) {
	if (held) return true;
	// workflow-core#3892 lucmoseley/mantahostels#2277
	return stamps.length > 0
		? stamps.every(([k, stamp]) => delivered(k, stamp))
		: r.digest === r.shown?.digest;
}

/**
 * @param {Pass} pass
 * @param {Report} report
 * @param {Reading} r
 * @param {{ held: "wedged" | "stale" | null, stamps: [string, string][] }} display
 * @returns {Shown}
 */
function inject(pass, report, r, { held, stamps }) {
	pass.injected.push({ checker: r.name, outcome: report.outcome, age: r.age });
	pass.blocks.push({
		text:
			`▸ ${r.name} — ${humanAge(r.age)}` +
			`${held ? ` (${held}: a session start would not be shown this)` : ""}\n` +
			trimEndRun(report.text, "\n"),
		notice: isFounderNotice(r.name),
	});
	if (pass.spending) for (const [k, stamp] of stamps) recordDelivery(k, stamp);
	return { ...r.next, digest: r.digest };
}

/**
 * @param {Pass} pass
 * @param {{ key: string, script: string }} entry
 */
function checkNeverRan(pass, { key, script }) {
	const shown = readShown(key);
	const firstSeen = shown?.start ?? pass.startNo;
	const firstSeenAt = shown?.at ?? new Date(pass.now).toISOString();
	const silentFor = pass.startNo - firstSeen;
	pass.record.push([
		key,
		{ at: firstSeenAt, start: firstSeen, digest: shown?.digest ?? "" },
	]);
	if (silentFor < SILENT_STARTS) return;
	const firstSeenMs = Date.parse(firstSeenAt);
	const firstSeenAge = Number.isNaN(firstSeenMs)
		? null
		: pass.now - firstSeenMs;
	if (firstSeenAge !== null && firstSeenAge < SILENT_AGE_FLOOR_MS) return;
	pass.neverRan.push({ checker: key, starts: silentFor });
	pass.ctx.warn(
		"NEVER-RAN",
		`${key} is wired at SessionStart as a persisting producer but has ` +
			`never written a report or an open run, across ${silentFor} ` +
			"session starts — it may be wedged before its first openRun, or " +
			"misnamed against notify-report.js's checker key; run " +
			`\`node scripts/${script} --notify\` by hand to see what it does.`,
		{ checker: key, starts: silentFor },
	);
}

/**
 * @param {Pass} pass
 * @param {string} key
 */
function checkCancelled(pass, key) {
	const run = notify.readRun(key);
	if (!run || !notify.isCancelled(run)) return;
	if (!pass.gated(key)) return;
	const name = run.checker || key;
	pass.cancelled.push({ checker: name, startedAt: run.startedAt });
	if (SELF_REPORTS_CANCELLATION.has(key)) return;
	const opened = Date.parse(run.startedAt);
	pass.ctx.warn(
		"CANCELLED",
		`${name} was cut off mid-run — it opened at ${run.startedAt}` +
			`${Number.isNaN(opened) ? "" : ` (${humanAge(Math.max(0, pass.now - opened))})`}` +
			" and its process is gone, so whatever it would have reported was never written.",
		{ checker: name, startedAt: run.startedAt },
	);
}

/**
 * @param {Ctx} ctx
 * @param {[string, Shown][]} record
 * @param {number} startNo
 */
function persistShown(ctx, record, startNo) {
	let unrecorded = 0;
	for (const [key, next] of record)
		if (!notify.atomicWriteJSON(shownFile(key), next)) unrecorded += 1;
	writeStarts(startNo);
	// lucmoseley/mantahostels#1976
	if (unrecorded)
		ctx.warn(
			"UNRECORDED",
			`${unrecorded} of ${record.length} shown-records could not be written under ` +
				`${notify.base()} — until that directory takes a write again, every ` +
				"report repeats at every start and no wedged producer is named.",
			{ count: unrecorded },
		);
}

/**
 * @param {Ctx} ctx
 * @param {Pass} pass
 * @param {string[]} unwired
 */
function printSummary(ctx, { blocks, stale }, unwired) {
	for (const { text, notice } of blocks) {
		if (notice) ctx.sayNotice(text);
		else ctx.say(text);
		ctx.say("");
	}
	for (const f of ctx.findings) ctx.say(f.message);
	if (stale.length > 0)
		ctx.say(
			`${stale.length} report(s) dropped as stale, the oldest ` +
				`${humanAge(Math.max(...stale.map((s) => s.age ?? 0)))}: ` +
				`${stale.map((s) => s.checker).join(", ")}. ` +
				"Each refreshes when its own producer finishes this start.",
		);
	if (!ctx.notify && unwired.length > 0)
		ctx.say(
			`${unwired.length} key(s) in the store that the repo's hooks do not ` +
				`wire as a persisting SessionStart producer: ${unwired.join(", ")}. ` +
				"No fault is raised about these and none can refresh; delete each " +
				`one's .report.json, .run.json and .shown.json under ${notify.base()} ` +
				"to drop it for good.",
		);
}

/**
 * @param {Pick<Pass, "ctx" | "delivering" | "spending" | "source" | "startNo" | "gated">} given
 * @returns {Pass}
 */
const newPass = (given) => ({
	...given,
	now: now(),
	record: [],
	blocks: [],
	injected: [],
	stale: [],
	silent: [],
	neverRan: [],
	unreadable: [],
	cancelled: [],
});

/** @param {Ctx} ctx */
function statusView(ctx) {
	if (ctx.notify) ctx.usageError("--status is a hand run; drop --notify.");
	const pass = newPass({
		ctx,
		delivering: false,
		spending: !ctx.asJson,
		startNo: readStarts() + 1,
		gated: () => false,
	});
	for (const key of notify.list().filter(isHeldForStatus)) replayKey(pass, key);
	for (const { text } of pass.blocks) {
		ctx.say(text);
		ctx.say("");
	}
	for (const { checker, age } of pass.injected)
		ctx.warn("HELD", `${checker} reported ${humanAge(age)}.`, { checker });
	return {
		okLine: "no held-back report on disk.",
		noun: "held-back report(s)",
		data: { injected: pass.injected },
	};
}

runCheck({
	name: SELF,
	usage: `node ${scriptPath("replay-notify-reports.js")} [--notify | --status] [--json]`,
	screenNotices: true,
	flags: ["--status"],
	run(/** @type {Ctx} */ ctx) {
		if (ctx.has("--status")) return statusView(ctx);
		// lucmoseley/mantahostels#1976
		const delivering = ctx.notify && !ctx.asJson;
		const startNo = readStarts() + 1;

		const { roster, gated, unwired } = readGate();
		const pass = newPass({
			ctx,
			delivering,
			spending: delivering,
			source: ctx.notify ? hookMessage.readPayload()?.source : undefined,
			startNo,
			gated,
		});

		for (const key of notify.list()) {
			if (key === SELF) continue;
			replayKey(pass, key);
		}

		const present = new Set(notify.list());
		for (const entry of roster) {
			if (present.has(entry.key)) continue;
			checkNeverRan(pass, entry);
		}

		for (const key of notify.list()) {
			if (key === SELF) continue;
			checkCancelled(pass, key);
		}

		if (delivering) persistShown(ctx, pass.record, startNo);

		printSummary(ctx, pass, unwired);

		const { injected, stale, silent, neverRan, unreadable, cancelled } = pass;
		const data = {
			injected,
			stale,
			silent,
			neverRan,
			unreadable,
			cancelled,
			unwired,
		};
		if (ctx.findings.length > 0) return { noun: "producer fault(s)", data };
		return {
			okLine:
				injected.length > 0
					? `${injected.length} report(s) replayed.`
					: "no persisted reports outstanding.",
			data,
		};
	},
});
