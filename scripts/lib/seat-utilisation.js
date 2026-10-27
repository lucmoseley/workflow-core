/*
 * seat-utilisation.js — reading each seat's allowance out of
 * `.claude.json`, and the blocked-work condition over the set.
 *
 * SEPARATE FROM THE CHECKER for the reason lib/turn-collapse.js is: the
 * reporting shell exits the process, so a test that wants the arithmetic has to
 * be able to get at it without running one.
 *
 * WHY ANY OF THIS IS READABLE AT ALL. `docs/capacity-procurement-ladder.md` said
 * the Settings -> Usage panel and `/usage` were the only readers of allowance
 * consumption and that no agent or hook reached either. mantahostels#1738 falsified it:
 * each seat's cache holds the panel's own numbers, and all three read in 2 ms.
 *
 * TWO PROPERTIES OF THE CACHE THAT THE READING TURNS ON.
 *
 *   ABSENT MEANS UNREAD, NOT ZERO (mantahostels#1742). A seat that has never run has no
 *   `cachedUsageUtilization` key at all. Counting it as a satisfied seat would
 *   fire the trigger on a seat nobody has touched; counting it as 0 would
 *   silence the trigger for good. It is neither — it blocks the fire and says
 *   so, and the fallback is the founder's panel reading.
 *
 *   A STALE READING IS A SOUND LOWER BOUND UNTIL `resets_at`, AND EXACTLY 0
 *   AFTER IT (mantahostels#1742, definitional). The cache refreshes only while that seat
 *   runs, so a dormant seat's number ages — but utilisation is a fraction of an
 *   allowance consumed inside a window and consumption cannot go negative. An
 *   exhaustion test needs a lower bound, so the error runs in the safe
 *   direction. Past `resets_at` the window has rolled and the number says
 *   nothing at all, which is why effectiveSevenDay() returns 0 there rather
 *   than the frozen figure.
 */

const fs = require("node:fs");
const { markersDir } = require("./marker-root.js");
const path = require("node:path");
const { configDirs } = require("./arbiter-store");
const { hostRoot } = require("./host-root.js");
const { readUsageCache, hasResetPassed } = require("./usage-cache.js");

/**
 * One seat's reading, or the fact that there is nothing to read.
 *
 * @typedef {object} Seat
 * @property {string} dir          the seat directory, e.g. `.claude2`
 * @property {string | null} accountUuid
 * @property {boolean} unread      no `cachedUsageUtilization` key at all
 * @property {number | null} sevenDay   as the cache holds it
 * @property {number | null} fiveHour
 * @property {number | null} effective  sevenDay, or 0 past `resets_at`
 * @property {string | null} resetsAt   ISO
 * @property {number | null} fetchedAtMs
 * @property {number | null} staleHours
 * @property {boolean} rolled      the seven-day window has reset since the read
 * @property {string | null} severity   the vendor's own word for the weekly limit
 * @property {ScopedBar[]} scopedBars   every `kind: "weekly_scoped"` bar the cache carries (workflow-core#304)
 */

/**
 * One `kind: "weekly_scoped"` bar — a model's own weekly allowance, distinct
 * from `weekly_all` (workflow-core#298 measured the two scales genuinely different). Judged
 * past its OWN `resets_at`, never `weekly_all`'s.
 *
 * @typedef {object} ScopedBar
 * @property {string | null} model   `scope.model.display_name`, quoted
 * @property {number} percent
 * @property {string | null} severity
 * @property {string | null} resetsAt
 * @property {number} effective   percent, or 0 past this bar's own `resetsAt`
 * @property {boolean} rolled
 */

/** The condition mantahostels#1740 settled. Not 95%: the seats sat at 99% for over 24 h
 *  across 22-23 August 2026 without work stopping. */
const BLOCKED_UTILISATION = 100;

/** …and long enough left in the window that waiting it out is not the answer. */
const MIN_HOURS_TO_RESET = 24;

/** Every reading, one JSON line a day. Perishable for the reason
 *  `~/.claude/self-throttling-history.jsonl` is: no later run can reconstruct a day's
 *  utilisation, the cache holding only the newest. */
/** @type {() => string} */
const HISTORY_FILE = () =>
	process.env.WFC_SEAT_HISTORY ||
	path.join(markersDir(hostRoot()), ".seat-utilisation-history.jsonl");

/** When a reading was last appended. Read then written, not claimed atomically,
 *  so two session starts in one tick both record — bounded at a handful of
 *  duplicate lines a day, against ~200 starts if nothing throttled at all. */
/** @type {() => string} */
const RECORD_STAMP = () => `${HISTORY_FILE()}.stamp`;

/** One reading a day. The series is read as a daily one at the 1 Oct review, and
 *  ~200 session starts a day would otherwise each run the git count and append a
 *  line — the same cadence and the same reason as `~/.claude/self-throttling-history.jsonl`
 *  (mantahostels#1362, mantahostels#1404). */
const RECORD_MIN_AGE_HOURS = 24;

/** Where the rung-1 limb is judged from: mantahostels#1740 made it a named, dated line in
 *  the ladder's own re-assessment log, matching `:129` item 3. The same file
 *  carries gate 2's trial declaration, so the path is owned by the module that
 *  parses that (mantahostels#2857) rather than spelled out twice. */
const { LADDER } = require("./trial-window");
const { gitOrNull } = require("./git.js");

/**
 * The seven-day figure to test, with the window's own arithmetic applied.
 *
 * Past `resets_at` the allowance has rolled and the frozen reading describes a
 * window that no longer exists — so it is 0, not the stale number. Before it,
 * the reading is a lower bound and is used as-is.
 *
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
 * A seat that exists and whose allowance is unknown. Never a zero: mantahostels#1742 ruled
 * absent means UNREAD, and a 0 here would silence the exhaustion trigger for
 * good while a 100 would fire it on a seat nobody has touched.
 *
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
 * Every `weekly_scoped` bar a seat's `limits[]` carries, each judged past its
 * own `resets_at`, never `weekly_all`'s.
 *
 * A bar with no numeric `percent` cannot be judged and is dropped rather than
 * guessed; a bar with no `scope.model.display_name` cannot be named in a
 * notice and is dropped for the same reason mantahostels#1742 never fires on silence.
 *
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
 * Read one seat, or null where the directory holds no `.claude.json` at all —
 * which is a seat that does not exist, a different fact from a seat that has
 * never run.
 *
 * Never throws: this runs on the session-start path.
 *
 * @param {string} seatDir
 * @param {number} now
 * @returns {Seat | null}
 */
function readSeat(seatDir, now) {
	const dir = path.basename(seatDir);
	/* A seat with no `.claude.json` at all does not exist, and drops out. Every
	 * other failure — a half-written file the harness is mid-rewrite of, a
	 * permission error — is a seat that EXISTS and whose allowance could not be
	 * read, which is mantahostels#1742's unread case and must block the fire rather than
	 * vanish from the set. */
	const cache = readUsageCache(seatDir);
	if (cache.state === "missing") return null;
	if (cache.state === "unreadable") return unreadSeat(dir);
	/* `limits[]` is the panel's own source, so its severity word is quoted
	 * rather than derived — worth showing beside our own threshold precisely
	 * because the two can disagree. */
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
 * Every seat on this machine, deduplicated by account.
 *
 * WHY BY ACCOUNT AND NOT BY DIRECTORY. Two seat directories pointed at one
 * subscription are one seat's allowance read twice, and the trigger asks about
 * every LIVE SEAT — counting one twice cannot change the verdict here, but it
 * would misreport the table and inflate the daily history. Unread seats carry
 * no account, so each is kept on its own.
 *
 * @param {number} [now]
 * @param {string[]} [dirs] the seat directories, arbiter-store's set by default
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
 * The trigger, over a set of seats.
 *
 * @param {Seat[]} seats
 * @param {number} [now]
 */
function verdict(seats, now = Date.now()) {
	/* A cache present but carrying no numeric `weekly_all` is unread for the same
	 * reason an absent one is: the allowance was not read. Splitting it off into
	 * neither list would let the trigger fire on the seats that did answer. */
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
		/* Unread seats block the fire. mantahostels#1742: absent means unread, and a trigger
		 * that fires while a seat's allowance is unknown is asserting something it
		 * has not read. */
		fired: allExhausted && longEnough && unread.length === 0,
		/* Everything read is exhausted but a seat is unreadable — the one state
		 * where the founder's panel is the only way to finish the reading. */
		panelNeeded: allExhausted && longEnough && unread.length > 0,
	};
}

/**
 * One model's `weekly_scoped` state across a set of seats: whether EVERY
 * readable seat carrying that model's bar is over ceiling.
 *
 * @typedef {object} ScopedModelState
 * @property {string} model
 * @property {{ seat: Seat, bar: ScopedBar }[]} entries   one per seat reading this model
 */

/**
 * The scoped-tier trigger, over a set of seats — workflow-core#298's second state, kept
 * separate from `verdict()` on purpose (ruling 1): a spent model-scoped bar
 * answers "should one tier drop", never "is work blocked", so it must never
 * touch `fired`, `allExhausted` or `panelNeeded`.
 *
 * QUORUM MIRRORS `allExhausted` (ruling 3): a model fires only when EVERY
 * readable seat reports a bar for it AND every one of those bars is over
 * ceiling. A seat that carries no bar at all for a given model VETOES that
 * model's fire outright — a deliberately declared unknown reads no differently
 * here than one seat still having headroom, since workflow-core#298 rules on neither and
 * the safer read is "not proven exhausted". An UNREAD seat (its whole cache
 * unknown, not just one model's bar) is a stronger fact and blocks every
 * model's fire the same way it blocks `verdict()`'s (ruling 3, mantahostels#1742).
 *
 * UNMEASURED, CARRIED RATHER THAN GUESSED (workflow-core#298's flip condition, workflow-core#292's same
 * gap): whether a session launched into a spent scoped bar hard-fails or
 * silently serves a lower model. If it downgrades silently this notice is
 * over-strict — but dropping tier is the conservative direction either way,
 * which is why the notice's prescribed act is a drop and never a re-decision.
 *
 * @param {Seat[]} seats
 * @returns {{ unread: Seat[], read: Seat[], exhausted: ScopedModelState[], fired: boolean, heldFire: boolean }}
 */
function scopedVerdict(seats) {
	/* Mirrors `verdict()`'s own unread/read split — filtering on `s.unread`
	 * alone would let a half-read cache count as readable here while
	 * `verdict()` holds it. */
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
		/* RESIDUAL, DECLINED: two `weekly_scoped` bars naming the same model on
		 * one seat push `entries.length` past `read.length`, vetoing that model
		 * permanently. Not a shape the vendor's cache has ever been observed to
		 * produce — one bar per model per seat — so this is left unguarded
		 * rather than adding a de-dupe step for data nothing supplies. */
		if (entries.length !== read.length) continue;
		if (entries.every(({ bar }) => bar.effective >= BLOCKED_UTILISATION))
			exhausted.push({ model, entries });
	}
	return {
		unread,
		read,
		exhausted,
		/* Unread seats hold this fire exactly as they hold `verdict()`'s
		 * (ruling 3) — never a second held-fire notice of its own. */
		fired: exhausted.length > 0 && unread.length === 0,
		heldFire: exhausted.length > 0 && unread.length > 0,
	};
}

/**
 * Whether the ladder's re-assessment log records a measured consumption cut.
 *
 * mantahostels#1740 made this a limb of the notice and NOT a precondition: absent the line
 * the trigger still fires, and the re-decision simply opens with "rung 1 is
 * unapplied". Not a hard precondition: it would block the founder behind
 * another map's progress, and he would override it as he did in August.
 *
 * Reads only the log section, and only whether it holds a line at all. Judging
 * whether a line describes a real cut is a reader's job.
 *
 * @returns {boolean | null} null where the ladder cannot be read
 */
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
 * Commits landed on `main` in the last `hours`. The co-indicator, read and
 * never triggered on (mantahostels#1737). Both instruments read it, so it lives here.
 *
 * @param {number} hours
 * @returns {number | null} null where git will not answer
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
 * Append today's reading, at most once every `RECORD_MIN_AGE_HOURS`.
 *
 * THE STAMP IS TAKEN BEFORE THE APPEND, AND A FAILED STAMP CANCELS IT — the
 * throttle has to hold on a read-only or full disk, where the append can never
 * record itself and an unthrottled path would run the git count at every one of
 * ~200 session starts a day.
 *
 * @param {Seat[]} seats
 * @param {number} [now]
 * @returns {"recorded" | "throttled" | "failed"}
 */
function recordReading(seats, now = Date.now()) {
	const stamp = RECORD_STAMP();
	try {
		const last = Date.parse(fs.readFileSync(stamp, "utf8").trim());
		if (Number.isFinite(last) && (now - last) / 36e5 < RECORD_MIN_AGE_HOURS)
			return "throttled";
	} catch {
		/* no stamp yet, or an unreadable one: a reading is due */
	}
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
			// Marks the row above's lower-bound reading (mantahostels#2697). Absent before
			// this field existed; same precision as the --json envelope's.
			staleHours:
				s.staleHours === null ? null : Number(s.staleHours.toFixed(1)),
			severity: s.severity,
			// workflow-core#298 ruling 8: recorded as a daily series, since the cache holds
			// only the newest reading.
			scopedBars: (s.scopedBars ?? []).map((b) => ({
				model: b.model,
				percent: b.percent,
				severity: b.severity,
				resetsAt: b.resetsAt,
			})),
		})),
		// The co-indicator, both windows, so a run of lines is readable on its own.
		commits24h: commitsSince(24),
		commits7d: commitsSince(24 * 7),
	};
	try {
		/* JSONL and `O_APPEND`, so a torn write costs the last line and never the
		 * file — the ~10 sessions sharing this tree cannot interleave at an offset,
		 * though nothing makes one line atomic. */
		fs.appendFileSync(HISTORY_FILE(), `${JSON.stringify(reading)}\n`);
	} catch {
		return "failed";
	}
	return "recorded";
}

/**
 * The window a `resets_at` names, as a comparable key: the instant rounded to
 * the minute. The API returns one reset with sub-second jitter either side of
 * the hour (20:59:59.886397, then 21:00:00.466931), so the raw string is never
 * a window's identity (mantahostels#3379). Rounding absorbs up to ±30 s. Null where
 * unparseable.
 *
 * @param {string | null} resetsAt
 * @returns {string | null}
 */
function windowKey(resetsAt) {
	const at = resetsAt ? Date.parse(resetsAt) : Number.NaN;
	if (!Number.isFinite(at)) return null;
	return new Date(Math.round(at / 60_000) * 60_000).toISOString();
}

/**
 * What seat 3's own cache says happened to it during the trial (mantahostels#2848 Q3).
 *
 * VOID VERSUS ANNOTATE, AND WHY THE LINE IS THERE. A fortnight in which the
 * disabled seat actually carried work is not a two-seat fortnight, and letting
 * one pass as such defeats the only thing gate 2 measures. But voiding on any
 * sign of life costs another 14-21 days on a window that cannot be replayed, so
 * one accidental session must not do it.
 *
 * THE CACHE ONLY REFRESHES WHILE THAT SEAT RUNS, which is what makes this
 * readable at all: a `resets_at` that has moved since the declaration is proof
 * the seat ran, and a `sevenDay` that has risen inside the declared window is
 * proof it did work. A `fetchedAt` alone advancing is the seat being touched
 * without measurably consuming anything.
 *
 * ⚠ KNOWN RESIDUAL, UNMEASURED (mantahostels#2848): `sevenDay` is coarse, so a very short
 * session lands in the annotate limb rather than the void one; and it is not
 * verified that `fetchedAt` advances only when a session runs, so a background
 * token refresh would make the annotate limb fire constantly.
 *
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
	/* SEAT 3'S WINDOW HAS ROLLED. The cache only refreshes while the seat runs,
	 * so the roll itself proves a session happened — but mantahostels#2848 rejected voiding
	 * on any sign of life, one accidental session costing another 14-21 days on
	 * a window that cannot be replayed. So the materiality test moves with the
	 * window: the new window's baseline is 0, and anything consumed in it is a
	 * rise. A roll with nothing consumed annotates. */
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
 * The trial-scoped read: gate 2's trigger over the seats the trial leaves live.
 *
 * A SECOND READ LAYERED OVER `verdict()`, NEVER AN EDIT TO IT (mantahostels#2845). The
 * ordinary three-seat upward trigger keeps its semantics whatever a declaration
 * says — including on the branch where the declaration cannot be honoured,
 * which is why that branch returns rather than throwing or skipping.
 *
 * mantahostels#1742 STILL BINDS ON THIS READ. The excluded seat is EXCLUDED — a third state
 * that is neither `read` nor `unread` — and never recast as unread, which would
 * make an unread seat block a fire the trial exists to catch. Unread seats among
 * the REMAINING ones still block it, exactly as they do for the ordinary read.
 *
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
	/* The directory is advisory (mantahostels#2847): `readSeats` deduplicates by account, so
	 * two directories pointed at one subscription collapse to one row and the
	 * survivor may not be the one named. A disagreement is still worth refusing
	 * on — it means the founder wrote the line about a different seat than the
	 * one the exclusion will actually take out. */
	if (excluded.dir !== decl.dir)
		return {
			honoured: false,
			reason: `the declaration names \`${decl.dir}\` but account ${decl.accountUuid} reads as \`${excluded.dir}\``,
		};

	const remaining = seats.filter((s) => s !== excluded);
	/* THE START INSTANT IS THE LATER OF THE REMAINING SEATS' RESETS (mantahostels#2848), so
	 * a basis that names only some of them can compute a start up to 7 days
	 * early — reintroducing the contamination the later-of rule exists to
	 * remove, in a window that cannot be re-run. The parser cannot check this:
	 * only here is the live seat set known. */
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
 * One history row's seats, in the shape `verdict()` reads.
 *
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
 * One history seat's scoped bars, in the shape `verdict()` reads.
 *
 * @param {unknown} bars the seat's `scopedBars` as the row holds it
 * @param {number} at the row's instant, in ms
 * @returns {ScopedBar[]}
 */
function rowScopedBars(bars, at) {
	/* Same drop rule as `readScopedBars()`: a row with no numeric `percent`
	 * or no `model` cannot be judged or named, so it is skipped here too
	 * rather than replayed with a guessed or null figure. */
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
 * The whole fortnight, read back off the daily series once the window has
 * closed — the verdict, and the coverage the founder judges it on.
 *
 * WHY THE SERIES AND NOT THE LIVE CACHE. The failure condition is
 * instantaneous, so a fire that happened on day 4 is invisible to a live read on
 * day 15: the cache holds only the newest reading. The series is the only record
 * that a fire happened at all, which is also why mantahostels#2848 made coverage part of the
 * pass rather than a footnote — a fortnight with a five-day hole in it has not
 * been measured, and only the reader can judge whether that matters.
 *
 * ⚠ A GAP IS NOT A DEFECT (mantahostels#2848 Q4). Work stopping is the behaviour this gate
 * measures, so a long gap during a two-seat fortnight is itself a candidate
 * self-throttling episode. The window neither extends nor voids on one.
 *
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
		/* WIDER THAN `trialVerdict()`'S MATCH, DELIBERATELY (mantahostels#2871). That reader
		 * refuses a `dir`/`accountUuid` mismatch outright. This reads the HISTORY
		 * instead of a live seat set, and a row can carry `accountUuid: null` —
		 * an old row recorded before the field existed, or one recorded while the
		 * seat was unread — and such a row must still be matchable, on directory
		 * alone, or it silently drops out of coverage. A row that DOES carry an
		 * account is matched on the account only, exactly as the live read is;
		 * directory is never consulted where an account is present. */
		const excluded = seats.find(
			(s) =>
				s.accountUuid === decl.accountUuid ||
				(s.accountUuid === null && s.dir === decl.dir),
		);
		/* A row carrying no declared seat cannot be read as a two-seat moment at
		 * all, so it is not coverage either — counting it would put a
		 * full-looking reading count under a verdict nothing measured. */
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

	/* Both edges count: a window whose first reading landed on day 6 is as
	 * unmeasured at its head as one with a hole in the middle. */
	let largest = 0;
	let prev = start;
	for (const row of rows) {
		largest = Math.max(largest, (Date.parse(row.at) - prev) / 36e5);
		prev = Date.parse(row.at);
	}
	largest = Math.max(largest, (end - prev) / 36e5);

	/* AN UNMEASURED FORTNIGHT IS NOT A PASS. Without this limb a window with
	 * no usable reading in it returns "passed", and both consumers go on to
	 * prescribe retiring a seat off a fortnight nothing observed. mantahostels#2848 Q4
	 * made coverage the founder's judgement, not a precondition — so it is
	 * reported and filed either way, under a verdict that says what it is. */
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
 * The daily series, newest last, skipping lines that do not parse.
 *
 * A truncated final line is the expected corruption: the file is appended to
 * from a session-start hook that can be killed mid-write, and one unusable line
 * must not cost the whole series.
 *
 * THE DROPPED COUNT RIDES ON THE ARRAY, not a second return value: every
 * existing caller does `readHistory().filter(...)` or similar, and a run of
 * dropped lines is a coverage gap that changes a verdict — it must be visible
 * to whichever caller wants it without every caller destructuring a new shape
 * (mantahostels#2871). `trialReview()` reports it under `droppedLines` in its result.
 *
 * @param {string} [file]
 * @returns {{ at: string, seats: any[] }[] & { dropped: number }}
 */
function readHistory(file = HISTORY_FILE()) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return Object.assign([], { dropped: 0 });
	}
	/** @type {{ at: string, seats: any[] }[]} */
	const rows = [];
	let dropped = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line);
			if (typeof row?.at === "string") rows.push(row);
			else dropped += 1;
		} catch {
			/* one unusable line, not a lost series — but counted, not silent */
			dropped += 1;
		}
	}
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
