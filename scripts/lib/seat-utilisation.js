const fs = require("node:fs");
const { readJsonl } = require("./jsonl.js");
const { markersDir } = require("./marker-root.js");
const path = require("node:path");
const { configDirs } = require("./arbiter-store");
const { hostRoot } = require("./host-root.js");
const { readUsageCache, hasResetPassed } = require("./usage-cache.js");
const { orFallback } = require("./caught.js");

/**
 * @typedef {object} Seat
 * @property {string} dir
 * @property {string | null} accountUuid
 * @property {boolean} unread
 * @property {number | null} sevenDay
 * @property {number | null} fiveHour
 * @property {number | null} effective
 * @property {string | null} resetsAt
 * @property {number | null} fetchedAtMs
 * @property {number | null} staleHours
 * @property {boolean} rolled
 * @property {string | null} severity
 * @property {ScopedBar[]} scopedBars
 */

/**
 * @typedef {object} ScopedBar
 * @property {string | null} model
 * @property {number} percent
 * @property {string | null} severity
 * @property {string | null} resetsAt
 * @property {number} effective
 * @property {boolean} rolled
 */

const BLOCKED_UTILISATION = 100;

const MIN_HOURS_TO_RESET = 24;

/** @type {() => string} */
const HISTORY_FILE = () =>
	process.env.WFC_SEAT_HISTORY ||
	path.join(markersDir(hostRoot()), ".seat-utilisation-history.jsonl");

/** @type {() => string} */
const RECORD_STAMP = () => `${HISTORY_FILE()}.stamp`;

const RECORD_MIN_AGE_HOURS = 24;

const { LADDER } = require("./trial-window");
const { gitOrNull } = require("./git.js");

/**
 * @param {number | null} sevenDay
 * @param {string | null} resetsAt
 * @param {number} now
 * @returns {{ effective: number | null, rolled: boolean }}
 */
function effectiveSevenDay(sevenDay, resetsAt, now) {
	if (sevenDay === null) return { effective: null, rolled: false };
	if (hasResetPassed(resetsAt, now)) return { effective: 0, rolled: true };
	return { effective: sevenDay, rolled: false };
}

/**
 * @param {string} dir
 * @returns {Seat}
 */
const unreadSeat = (dir) => ({
	dir,
	accountUuid: null,
	unread: true,
	sevenDay: null,
	fiveHour: null,
	effective: null,
	resetsAt: null,
	fetchedAtMs: null,
	staleHours: null,
	rolled: false,
	severity: null,
	scopedBars: [],
});

/**
 * @param {import("./usage-cache.js").LimitBar[]} limits
 * @param {number} now
 * @returns {ScopedBar[]}
 */
function readScopedBars(limits, now) {
	/** @type {ScopedBar[]} */
	const bars = [];
	for (const l of limits) {
		if (l.kind !== "weekly_scoped") continue;
		if (l.percent === null || l.model === null) continue;
		const { effective, rolled } = effectiveSevenDay(l.percent, l.resetsAt, now);
		bars.push({
			model: l.model,
			percent: l.percent,
			severity: l.severity,
			resetsAt: l.resetsAt,
			effective: /** @type {number} */ (effective),
			rolled,
		});
	}
	return bars;
}

/**
 * @param {string} seatDir
 * @param {number} now
 * @returns {Seat | null}
 */
function readSeat(seatDir, now) {
	const dir = path.basename(seatDir);
	const cache = readUsageCache(seatDir);
	if (cache.state === "missing") return null;
	if (cache.state === "unreadable") return unreadSeat(dir);
	const weekly = cache.bars.find((b) => b.kind === "weekly_all");
	const session = cache.bars.find((b) => b.kind === "session");
	const sevenDay = weekly?.percent ?? null;
	const resetsAt = weekly?.resetsAt ?? null;
	const { fetchedAtMs } = cache;
	const { effective, rolled } = effectiveSevenDay(sevenDay, resetsAt, now);
	return {
		dir,
		accountUuid: cache.accountUuid,
		unread: false,
		sevenDay,
		fiveHour: session?.percent ?? null,
		effective,
		resetsAt,
		fetchedAtMs,
		staleHours: fetchedAtMs === null ? null : (now - fetchedAtMs) / 36e5,
		rolled,
		severity: weekly?.severity ?? null,
		scopedBars: readScopedBars(cache.bars, now),
	};
}

/**
 * @param {number} [now]
 * @param {string[]} [dirs]
 * @returns {Seat[]}
 */
function readSeats(now = Date.now(), dirs = configDirs()) {
	/** @type {Seat[]} */
	const seats = [];
	const seen = new Set();
	for (const dir of dirs) {
		const seat = readSeat(dir, now);
		if (seat === null) continue;
		if (seat.accountUuid !== null) {
			if (seen.has(seat.accountUuid)) continue;
			seen.add(seat.accountUuid);
		}
		seats.push(seat);
	}
	return seats;
}

/**
 * @param {Seat[]} seats
 * @param {number} [now]
 */
function verdict(seats, now = Date.now()) {
	const unread = seats.filter((s) => s.unread || s.effective === null);
	const read = seats.filter((s) => !s.unread && s.effective !== null);
	const resets = read
		.map((s) => (s.resetsAt === null ? Number.NaN : Date.parse(s.resetsAt)))
		.filter((t) => Number.isFinite(t) && t > now);
	const hoursToEarliestReset =
		resets.length > 0 ? (Math.min(...resets) - now) / 36e5 : null;
	const allExhausted =
		read.length > 0 &&
		read.every((s) => (s.effective ?? 0) >= BLOCKED_UTILISATION);
	const longEnough =
		hoursToEarliestReset !== null && hoursToEarliestReset > MIN_HOURS_TO_RESET;
	return {
		seats,
		unread,
		read,
		hoursToEarliestReset,
		allExhausted,
		longEnough,
		fired: allExhausted && longEnough && unread.length === 0,
		panelNeeded: allExhausted && longEnough && unread.length > 0,
	};
}

/**
 * @typedef {object} ScopedModelState
 * @property {string} model
 * @property {{ seat: Seat, bar: ScopedBar }[]} entries
 */

/**
 * @param {Seat[]} seats
 * @returns {{ unread: Seat[], read: Seat[], exhausted: ScopedModelState[], fired: boolean, heldFire: boolean }}
 */
function scopedVerdict(seats) {
	const unread = seats.filter((s) => s.unread || s.effective === null);
	const read = seats.filter((s) => !s.unread && s.effective !== null);
	/** @type {Map<string, { seat: Seat, bar: ScopedBar }[]>} */
	const byModel = new Map();
	for (const seat of read) {
		for (const bar of seat.scopedBars ?? []) {
			if (bar.model === null) continue;
			const entries = byModel.get(bar.model) ?? [];
			entries.push({ seat, bar });
			byModel.set(bar.model, entries);
		}
	}
	/** @type {ScopedModelState[]} */
	const exhausted = [];
	for (const [model, entries] of byModel) {
		if (entries.length !== read.length) continue;
		if (entries.every(({ bar }) => bar.effective >= BLOCKED_UTILISATION))
			exhausted.push({ model, entries });
	}
	return {
		unread,
		read,
		exhausted,
		fired: exhausted.length > 0 && unread.length === 0,
		heldFire: exhausted.length > 0 && unread.length > 0,
	};
}

/** @returns {boolean | null} */
function rungOneLogged() {
	let text;
	try {
		text = fs.readFileSync(LADDER(), "utf8");
	} catch {
		return null;
	}
	const at = text.indexOf("### Re-assessment log");
	if (at === -1) return null;
	const section = text.slice(at).split("\n").slice(1);
	for (const line of section) {
		if (line.startsWith("## ")) break;
		if (/^[-*]\s+\d{4}-\d{2}-\d{2}/.test(line.trim())) return true;
	}
	return false;
}

/**
 * @param {number} hours
 * @returns {number | null}
 */
function commitsSince(hours) {
	const out = gitOrNull([
		"-C",
		hostRoot(),
		"rev-list",
		"--count",
		`--since=${hours} hours ago`,
		"HEAD",
	]);
	if (out === null) return null;
	const n = Number(out.trim());
	return Number.isFinite(n) ? n : null;
}

/**
 * @param {Seat[]} seats
 * @param {number} [now]
 * @returns {"recorded" | "throttled" | "failed"}
 */
function recordReading(seats, now = Date.now()) {
	const stamp = RECORD_STAMP();
	const last = orFallback(
		() => Date.parse(fs.readFileSync(stamp, "utf8").trim()),
		Number.NaN,
	);
	if (Number.isFinite(last) && (now - last) / 36e5 < RECORD_MIN_AGE_HOURS)
		return "throttled";
	try {
		fs.writeFileSync(stamp, `${new Date(now).toISOString()}\n`);
	} catch {
		return "failed";
	}
	const reading = {
		at: new Date(now).toISOString(),
		seats: seats.map((s) => ({
			dir: s.dir,
			accountUuid: s.accountUuid,
			unread: s.unread,
			sevenDay: s.sevenDay,
			fiveHour: s.fiveHour,
			resetsAt: s.resetsAt,
			fetchedAt:
				s.fetchedAtMs === null ? null : new Date(s.fetchedAtMs).toISOString(),
			staleHours:
				s.staleHours === null ? null : Number(s.staleHours.toFixed(1)),
			severity: s.severity,
			scopedBars: (s.scopedBars ?? []).map((b) => ({
				model: b.model,
				percent: b.percent,
				severity: b.severity,
				resetsAt: b.resetsAt,
			})),
		})),
		commits24h: commitsSince(24),
		commits7d: commitsSince(24 * 7),
	};
	try {
		fs.appendFileSync(HISTORY_FILE(), `${JSON.stringify(reading)}\n`);
	} catch {
		return "failed";
	}
	return "recorded";
}

/**
 * @param {string | null} resetsAt
 * @returns {string | null}
 */
function windowKey(resetsAt) {
	const at = resetsAt ? Date.parse(resetsAt) : Number.NaN;
	if (!Number.isFinite(at)) return null;
	return new Date(Math.round(at / 60_000) * 60_000).toISOString();
}

/**
 * @param {Seat} excluded
 * @param {import("./trial-window").ExcludedBaseline} baseline
 * @returns {{ kind: "clean" | "annotated" | "void", detail: string }}
 */
function trialSeatUse(excluded, baseline) {
	if (excluded.unread)
		return {
			kind: "annotated",
			detail:
				"seat 3's usage cache became unreadable during the trial, so its use is unknown",
		};
	if (windowKey(excluded.resetsAt) !== windowKey(baseline.resetsAt)) {
		const spent = excluded.sevenDay ?? 0;
		return spent > 0
			? {
					kind: "void",
					detail:
						`seat 3's 7-day window rolled to ${excluded.resetsAt} and ${spent}% of the ` +
						"new window is already spent",
				}
			: {
					kind: "annotated",
					detail: `seat 3's 7-day window rolled to ${excluded.resetsAt} with nothing spent in it`,
				};
	}
	if ((excluded.sevenDay ?? 0) > baseline.sevenDay)
		return {
			kind: "void",
			detail: `seat 3 rose from ${baseline.sevenDay}% to ${excluded.sevenDay}% inside its declared window`,
		};
	if ((excluded.fetchedAtMs ?? 0) > baseline.fetchedAtMs)
		return {
			kind: "annotated",
			detail:
				`seat 3 was touched at ${new Date(/** @type {number} */ (excluded.fetchedAtMs)).toISOString()} ` +
				`with 7-day utilisation unchanged at ${baseline.sevenDay}%`,
		};
	return { kind: "clean", detail: "seat 3 was untouched" };
}

/**
 * @param {Seat[]} seats
 * @param {import("./trial-window").TrialDeclaration} decl
 * @param {number} [now]
 */
function trialVerdict(seats, decl, now = Date.now()) {
	if (decl.state === "none") return { honoured: false, reason: null };
	if (decl.state === "malformed" || decl.state === "unreadable")
		return {
			honoured: false,
			reason: decl.reason ?? "the declaration is malformed",
		};

	const excluded = seats.find((s) => s.accountUuid === decl.accountUuid);
	if (!excluded)
		return {
			honoured: false,
			reason: `the declared account ${decl.accountUuid} is not among the ${seats.length} seat(s) read`,
		};
	if (excluded.dir !== decl.dir)
		return {
			honoured: false,
			reason: `the declaration names \`${decl.dir}\` but account ${decl.accountUuid} reads as \`${excluded.dir}\``,
		};

	const remaining = seats.filter((s) => s !== excluded);
	const named = new Set((decl.basis ?? []).map((b) => b.dir));
	const missing = remaining.filter((s) => !named.has(s.dir));
	if (missing.length > 0)
		return {
			honoured: false,
			reason:
				`the start basis names no reset for ${missing.map((s) => `\`${s.dir}\``).join(", ")}, ` +
				"so the window's start instant is not the later of the remaining seats' resets",
		};
	return {
		honoured: true,
		excluded,
		remaining,
		verdict: verdict(remaining, now),
		use: trialSeatUse(
			excluded,
			/** @type {import("./trial-window").ExcludedBaseline} */ (
				decl.excludedBaseline
			),
		),
	};
}

/**
 * @param {{ at: string, seats: any[] }} row
 * @returns {Seat[]}
 */
function rowSeats(row) {
	const at = Date.parse(row.at);
	return (Array.isArray(row.seats) ? row.seats : []).map((s) => {
		const sevenDay = typeof s?.sevenDay === "number" ? s.sevenDay : null;
		const resetsAt = typeof s?.resetsAt === "string" ? s.resetsAt : null;
		const { effective, rolled } = effectiveSevenDay(sevenDay, resetsAt, at);
		return {
			dir: s?.dir ?? "?",
			accountUuid: s?.accountUuid ?? null,
			unread: s?.unread === true,
			sevenDay,
			fiveHour: typeof s?.fiveHour === "number" ? s.fiveHour : null,
			effective,
			resetsAt,
			fetchedAtMs:
				typeof s?.fetchedAt === "string" ? Date.parse(s.fetchedAt) : null,
			staleHours: typeof s?.staleHours === "number" ? s.staleHours : null,
			rolled,
			severity: typeof s?.severity === "string" ? s.severity : null,
			scopedBars: rowScopedBars(s?.scopedBars, at),
		};
	});
}

/**
 * @param {unknown} bars
 * @param {number} at
 * @returns {ScopedBar[]}
 */
function rowScopedBars(bars, at) {
	return (Array.isArray(bars) ? bars : [])
		.filter(
			(/** @type {{ percent?: unknown, model?: unknown }} */ b) =>
				typeof b?.percent === "number" && typeof b?.model === "string",
		)
		.map(
			(
				/** @type {{ percent: number, model: string, severity?: unknown, resetsAt?: unknown }} */ b,
			) => {
				const bResetsAt = typeof b.resetsAt === "string" ? b.resetsAt : null;
				const { effective, rolled } = effectiveSevenDay(
					b.percent,
					bResetsAt,
					at,
				);
				return {
					model: b.model,
					percent: b.percent,
					severity: typeof b.severity === "string" ? b.severity : null,
					resetsAt: bResetsAt,
					effective: /** @type {number} */ (effective),
					rolled,
				};
			},
		);
}

/**
 * @param {{ at: string, seats: any[] }[] & { dropped?: number }} history
 * @param {import("./trial-window").TrialDeclaration} decl
 */
function trialReview(history, decl) {
	const start = /** @type {number} */ (decl.startMs);
	const end = /** @type {number} */ (decl.endMs);
	const rows = history
		.filter((r) => {
			const at = Date.parse(r?.at);
			return Number.isFinite(at) && at >= start && at <= end;
		})
		.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

	/** @type {{ at: string, hoursToEarliestReset: number | null }[]} */
	const fires = [];
	/** @type {{ at: string, detail: string }[]} */
	const voids = [];
	/** @type {{ at: string, detail: string }[]} */
	const annotations = [];
	let usable = 0;
	for (const row of rows) {
		const seats = rowSeats(row);
		const excluded = seats.find(
			(s) =>
				s.accountUuid === decl.accountUuid ||
				(s.accountUuid === null && s.dir === decl.dir),
		);
		if (!excluded) continue;
		usable += 1;
		const v = verdict(
			seats.filter((s) => s !== excluded),
			Date.parse(row.at),
		);
		if (v.fired)
			fires.push({ at: row.at, hoursToEarliestReset: v.hoursToEarliestReset });
		const use = trialSeatUse(
			excluded,
			/** @type {import("./trial-window").ExcludedBaseline} */ (
				decl.excludedBaseline
			),
		);
		if (use.kind === "void") voids.push({ at: row.at, detail: use.detail });
		else if (use.kind === "annotated")
			annotations.push({ at: row.at, detail: use.detail });
	}

	let largest = 0;
	let prev = start;
	for (const row of rows) {
		largest = Math.max(largest, (Date.parse(row.at) - prev) / 36e5);
		prev = Date.parse(row.at);
	}
	largest = Math.max(largest, (end - prev) / 36e5);

	/** @type {"void" | "failed" | "unmeasured" | "passed"} */
	let kind = "passed";
	if (voids.length > 0) kind = "void";
	else if (fires.length > 0) kind = "failed";
	else if (usable === 0) kind = "unmeasured";
	return {
		kind,
		readingCount: usable,
		largestGapHours: largest,
		droppedLines: history.dropped ?? 0,
		fires,
		voids,
		annotations,
	};
}

/**
 * @param {string} [file]
 * @returns {{ at: string, seats: any[] }[] & { dropped: number }}
 */
function readHistory(file = HISTORY_FILE()) {
	const read = orFallback(() => readJsonl(file), null);
	if (!read) return Object.assign([], { dropped: 0 });
	const rows = /** @type {{ at: string, seats: any[] }[]} */ (
		read.rows.filter((row) => typeof row.at === "string")
	);
	const dropped = read.rows.length - rows.length + read.bad.length;
	return Object.assign(rows, { dropped });
}

module.exports = {
	BLOCKED_UTILISATION,
	HISTORY_FILE,
	LADDER,
	MIN_HOURS_TO_RESET,
	commitsSince,
	readHistory,
	readSeats,
	recordReading,
	rungOneLogged,
	scopedVerdict,
	trialReview,
	trialVerdict,
	verdict,
};
