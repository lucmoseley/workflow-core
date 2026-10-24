#!/usr/bin/env node
/*
 * check-seat-utilisation.js — the blocked-work notice the ceiling spend policy
 * reads, plus the cheap daily local reading that keeps its baseline.
 *
 * WHAT IT FIRES ON, and it is the policy's only upward trigger: EVERY LIVE SEAT
 * AT 100% SEVEN-DAY UTILISATION SIMULTANEOUSLY, WITH MORE THAN 24 H REMAINING
 * BEFORE THE EARLIEST RESET. Not a 95% threshold (mantahostels#1740): the
 * seats sat at 99% for over 24 h across 22-23 August without work stopping, so
 * it would have fired on a non-event.
 *
 * WHAT THE NOTICE PRESCRIBES, AND WHAT IT MUST NEVER PRESCRIBE. A ceiling
 * re-decision — a re-run of map mantahostels#1732 — and never a purchase: mantahostels#1734 made $600 a
 * ceiling with no headroom and a seat costs $200. Wording that reads as "buy
 * capacity" reverses the founder's ruling.
 *
 * The reading itself, and the two cache properties it turns on — absent means
 * unread rather than zero, and a stale figure is a lower bound until its window
 * resets — are in scripts/lib/seat-utilisation.js. This file is the reporting
 * shell over them.
 *
 * A SECOND, SEPARATE TRIGGER (#298, #304): the fired/allExhausted/panelNeeded
 * trigger above reads `weekly_all` alone and is untouched by it. Every
 * `weekly_scoped` bar — a model's own weekly allowance — is read too, and
 * EVERY READABLE SEAT'S bar for a model reading 100% raises a DROP-TIER
 * notice, never the ceiling re-decision above: with `weekly_all` headroom
 * left, work is not blocked, one tier is.
 *
 * UNMEASURED (#298, #292's same gap): whether a session launched into a spent
 * scoped bar hard-fails or silently serves a lower model. If it downgrades
 * silently the notice is over-strict — but dropping tier is the conservative
 * direction either way.
 *
 * THE DAILY READING. Recorded once a day beside the trigger, because the series
 * is perishable in the same way `~/.claude/self-throttling-history.jsonl` is: nothing
 * reconstructs what utilisation looked like before a rung moved. It carries the
 * COMMIT CO-INDICATOR — commits landed on `main` (mantahostels#1738) — which is
 * read and never triggered on: it
 * re-expresses the meter at one remove, so it is a co-indicator and not the
 * unit of work (mantahostels#1737).
 *
 * WHY SESSION START AND NOT THE SCHEDULED SWEEP (mantahostels#1740). The read is cheap,
 * the sweeps drop runs, and the trigger's whole purpose is to fire before the
 * policy gets overridden.
 *
 * IT STAYS ON THAT HOOK ALONE, never also in scripts/status-report.js, where a
 * second run would double the daily recording (mantahostels#2680). It is not a
 * reporter — everything --notify prints (the exhausted-seats notice, the
 * unread-seat panel, and #304's tier-drop notice) is a fact about the seats and
 * not about this repo.
 *
 * GATE 2 OF SEAT 3'S PROBATION, ADDED AT mantahostels#2849. A declared trial window in the
 * ladder (scripts/lib/trial-window.js) makes this the reader of that gate too:
 * inside the window the declared seat is EXCLUDED and the same condition is run
 * over the seats that remain. Three things about it are rulings and not
 * choices —
 *
 *   THE PRESCRIPTION CHANGES, so the trial is a MODE and not a filter (mantahostels#2845).
 *   A trial-time fire means the trial FAILED: seat 3 goes back that day and the
 *   $600 stands. It must never print blockedNotice, which would send the founder
 *   to re-decide a ceiling off evidence about TWO seats.
 *
 *   THE CEILING RE-DECISION IS SUPPRESSED for the fortnight, deliberately, and
 *   every trial notice says so and for how long — the silence has to be
 *   auditable after a window that cannot be replayed.
 *
 *   THE ORDINARY TRIGGER IS UNTOUCHED. verdict() keeps its semantics, the trial
 *   read is layered over it, and a declaration that cannot be honoured falls
 *   back to the ordinary trigger loudly rather than SKIPping (mantahostels#2847) — a SKIP
 *   would lose the upward trigger, which is this collector's primary job.
 *
 * IMPLICIT:  at every session start, reads each seat's usage cache and injects a
 *            blocked-work notice when every live seat is exhausted, a tier-drop
 *            notice when a model's weekly allowance is spent on every readable
 *            seat, a SEAT UNREAD panel when an unread seat holds either back,
 *            and the gate-2 trial's pending, failed, review or cannot-honour
 *            notice; records one reading a day either way.
 * JUSTIFIED: fail-safe — the condition is that work has stopped, and a session
 *            that has to go looking for it finds out after the founder has
 *            already worked around it.
 * DEFEAT:    none at the hook; --notify is silent unless one of those notices
 *            holds or the ladder declaration falls back (#410).
 */

const { configDirs } = require("./lib/arbiter-store");

const { now, runCheck, skipError } = require("./lib/check");
const {
	BLOCKED_UTILISATION,
	HISTORY_FILE,
	MIN_HOURS_TO_RESET,
	readHistory,
	readSeats,
	recordReading,
	rungOneLogged,
	scopedVerdict,
	trialReview,
	trialVerdict,
	verdict,
} = require("./lib/seat-utilisation");
const { readTrialWindow, windowPhase } = require("./lib/trial-window");
const { ladderPath } = require("./lib/workflow-core-config");

/** @typedef {import("./lib/check").Ctx} Ctx */
/** @typedef {import("./lib/seat-utilisation").Seat} Seat */
/** @typedef {import("./lib/seat-utilisation").ScopedModelState} ScopedModelState */
/** @typedef {import("./lib/trial-window").TrialDeclaration} TrialDeclaration */

/** @param {number | null} h */
const hours = (h) => (h === null ? "?" : `${Math.round(h)}h`);

/** A `resets_at` as the notice prints it: `2026-09-01 21:59`. */
/** @param {string | null} iso */
const utc = (iso) => (iso ?? "?").slice(0, 16).replace("T", " ");

/**
 * The per-seat table. Printed on the live path only — a session start gets the
 * verdict and nothing else.
 *
 * @param {Seat[]} seats
 */
function seatTable(seats) {
	const rows = seats.map((s) => {
		if (s.unread) return `  ${s.dir.padEnd(10)}  never run — no usage cache`;
		const roll = s.rolled ? " (window has since reset — read as 0)" : "";
		/* #298 ruling 7: `severity` keeps the `weekly_all` word, quoted; each
		 * scoped bar carries its own percent/severity/model in a separate line —
		 * never merged into one worst-of word, since the two scales measurably
		 * disagree. */
		const scopedLines = (s.scopedBars ?? [])
			.map(
				(b) =>
					`  ${"".padEnd(10)}    ${b.model}: ${b.percent}% ${b.severity ?? "?"}` +
					`, resets ${utc(b.resetsAt)} UTC`,
			)
			.join("\n");
		return (
			`  ${s.dir.padEnd(10)}  7d ${String(s.sevenDay ?? "?").padStart(3)}%  ` +
			`5h ${String(s.fiveHour ?? "?").padStart(3)}%  ` +
			`resets ${utc(s.resetsAt)} UTC  ` +
			`read ${hours(s.staleHours)} ago  ${s.severity ?? "?"}${roll}` +
			(scopedLines ? `\n${scopedLines}` : "")
		);
	});
	return `SEATS (${seats.length})\n${rows.join("\n")}\n`;
}

/**
 * The notice itself. One place, so the live path and the session start cannot
 * word the prescribed act differently.
 *
 * @param {ReturnType<typeof verdict>} v
 */
function blockedNotice(v) {
	const rung1 = rungOneLogged();
	const opener =
		rung1 === false
			? "  Open the re-decision with `rung 1 is unapplied`: the ladder's re-assessment\n" +
				"  log records no dated line reporting a measured consumption cut (mantahostels#1740).\n"
			: "";
	return (
		`ALL SEATS EXHAUSTED (${v.read.length}) — every live seat is at ${BLOCKED_UTILISATION}% of its 7-day\n` +
		`allowance with ${hours(v.hoursToEarliestReset)} to go before the earliest reset, so work is blocked\n` +
		`for longer than the ${MIN_HOURS_TO_RESET}h this policy waits out.\n` +
		`${v.read.map((s) => `  ${s.dir}: ${s.sevenDay}% until ${utc(s.resetsAt)} UTC`).join("\n")}\n` +
		"  THE PRESCRIBED ACT IS A CEILING RE-DECISION — re-run map mantahostels#1732. NOT A PURCHASE:\n" +
		"  mantahostels#1734 set $600/month as a ceiling with no headroom, and a seat costs $200.\n" +
		`${opener}` +
		`  Background: ${ladderPath()}.\n`
	);
}

/**
 * One exhausted model's seats, in the shape both the warn payload and the
 * `--json` envelope want.
 *
 * @param {ScopedModelState[]} exhausted
 * @param {{ severity?: boolean }} [opts]
 */
function scopedModelsSummary(exhausted, opts = {}) {
	return exhausted.map((m) => ({
		model: m.model,
		seats: m.entries.map(({ seat, bar }) => ({
			dir: seat.dir,
			percent: bar.percent,
			...(opts.severity ? { severity: bar.severity } : {}),
			resetsAt: bar.resetsAt,
		})),
	}));
}

/**
 * The scoped-tier notice — #298's second state.
 *
 * NO HELD-FIRE NOTICE OF ITS OWN (#298 ruling 3, explicit): an unread seat
 * holds this fire in total silence — the ordinary trigger's own `SEAT UNREAD`
 * notice already sends the founder to Settings -> Usage, and a second one
 * here would collide with that needle (`scripts/guard-fire-needles.json`).
 *
 * @param {ScopedModelState[]} exhausted
 */
function scopedTierNotice(exhausted) {
	const resets = exhausted
		.flatMap((m) => m.entries.map(({ bar }) => bar.resetsAt))
		.map((iso) => (iso === null ? Number.NaN : Date.parse(iso)))
		.filter((t) => Number.isFinite(t));
	const earliest = resets.length > 0 ? Math.min(...resets) : null;
	const models = exhausted
		.map(
			(m) =>
				`  ${m.model}:\n` +
				m.entries
					.map(
						({ seat, bar }) =>
							`    ${seat.dir}: ${bar.percent}% until ${utc(bar.resetsAt)} UTC`,
					)
					.join("\n"),
		)
		.join("\n");
	return (
		`MODEL TIER SPENT (${exhausted.length}) — every readable seat's \`weekly_scoped\` bar for\n` +
		`the model(s) below is at ${BLOCKED_UTILISATION}%. THE PRESCRIBED ACT IS: DROP TIER FOR NOW\n` +
		"(docs/effort-guide.md), never a ceiling re-decision — weekly_all still has\n" +
		"headroom, so work is not blocked, one tier is.\n" +
		`${models}\n` +
		`  Earliest reset: ${earliest === null ? "?" : utc(new Date(earliest).toISOString())} UTC.\n`
	);
}

/** The measured window, as every trial notice states it. */
/** @param {import("./lib/trial-window").TrialDeclaration} d */
const windowLine = (d) =>
	`${utc(d.startIso ?? null)} → ${utc(d.endIso ?? null)} UTC ` +
	`(${Math.round(((d.endMs ?? 0) - (d.startMs ?? 0)) / 864e5)} days)`;

/**
 * A declaration the machine contradicts: run the ordinary trigger unchanged and
 * say loudly that a trial was declared and could not be honoured (mantahostels#2847 Q4).
 *
 * NEVER SILENT AND NEVER A SKIP. The fortnight is one-shot and unreplayable, so
 * a declaration that goes unread has to be discoverable on the day rather than
 * at the 1 October review.
 *
 * @param {string} reason
 */
const cannotHonourNotice = (reason) =>
	"TRIAL DECLARED, NOT HONOURED — gate 2's trial window in\n" +
	`${ladderPath()} cannot be read against this machine:\n` +
	`  ${reason}.\n` +
	"  The ordinary three-seat trigger is running unchanged, so nothing is being\n" +
	"  suppressed — but GATE 2 IS NOT BEING MEASURED. Fix the declaration or\n" +
	"  remove it; the trial fortnight cannot be replayed.\n";

/**
 * The ladder itself could not be read, so no declaration was parsed and this
 * notice never says one was made (#735) — equally loud, for the same reason.
 *
 * @param {string} reason
 */
const ladderUnreadableNotice = (reason) =>
	"GATE 2 LADDER UNREADABLE — whether a gate 2 trial is declared is unknown:\n" +
	`  ${reason}.\n` +
	"  The ordinary three-seat trigger is running unchanged, so nothing is being\n" +
	"  suppressed — but IF A TRIAL IS DECLARED, GATE 2 IS NOT BEING MEASURED.\n" +
	"  Make the ladder readable at that path; a repo that keeps none removes\n" +
	'  whatever is there and sets `"capacityLadder": false` in\n' +
	"  .claude/workflow-core.json.\n";

/**
 * The trial failed. mantahostels#2845: the prescribed act is re-enabling a seat already
 * paid for, and naming a ceiling re-decision here would prescribe off evidence
 * the fire does not carry.
 *
 * @param {ReturnType<typeof trialVerdict>} tv
 * @param {import("./lib/trial-window").TrialDeclaration} d
 * @param {number} nowMs
 */
function trialFailedNotice(tv, d, nowMs) {
	const v = /** @type {ReturnType<typeof verdict>} */ (tv.verdict);
	const day = Math.floor((nowMs - (d.startMs ?? nowMs)) / 864e5) + 1;
	const total = Math.round(((d.endMs ?? 0) - (d.startMs ?? 0)) / 864e5);
	const use =
		tv.use && tv.use.kind === "annotated"
			? `  Annotated, and the trial still counts: ${tv.use.detail} (mantahostels#2848).\n`
			: "";
	return (
		`GATE 2 TRIAL FAILED — the ${v.read.length} remaining seat(s) are at ${BLOCKED_UTILISATION}% of their\n` +
		`7-day allowance with ${hours(v.hoursToEarliestReset)} to go before the earliest reset, on day ${day} of ${total}.\n` +
		`${v.read.map((s) => `  ${s.dir}: ${s.sevenDay}% until ${utc(s.resetsAt)} UTC`).join("\n")}\n` +
		`  Excluded, per the declaration: ${d.dir} (${tv.excluded?.sevenDay ?? "?"}% at declaration, not counted).\n` +
		"  THE PRESCRIBED ACT IS: RE-ENABLE SEAT 3 TODAY. Probation ends, the seat stays,\n" +
		"  and the $600/month ceiling stands — seat 3 is already paid for, so this costs\n" +
		"  nothing and is NOT a purchase and NOT a ceiling re-decision (mantahostels#2845).\n" +
		`  The ordinary ceiling trigger was SUPPRESSED for this trial — ${windowLine(d)} —\n` +
		"  and resumes over three seats the day the seat is back.\n" +
		`${use}` +
		`  Then clear the declaration block from ${ladderPath()}.\n`
	);
}

/**
 * The window has closed. The verdict is read back off the daily series, not off
 * the live cache: the failure condition is instantaneous, so a fire on day 4 is
 * invisible to a read on day 15.
 *
 * @param {ReturnType<typeof trialReview>} r
 * @param {import("./lib/trial-window").TrialDeclaration} d
 */
function trialEndedNotice(r, d) {
	/** @type {string} */
	let head;
	if (r.kind === "unmeasured")
		head =
			"GATE 2 TRIAL UNMEASURED — the window closed with no usable reading inside it,\n" +
			"so nothing was observed and this is not a pass. Re-declare and re-run it.\n";
	else if (r.kind === "void")
		head =
			"GATE 2 TRIAL VOID — seat 3 carried work during the fortnight, so this was not a\n" +
			"two-seat fortnight and it measures nothing. Re-declare and re-run it.\n" +
			`${r.voids.map((x) => `  ${utc(x.at)} UTC: ${x.detail}`).join("\n")}\n`;
	else if (r.kind === "failed")
		head =
			"GATE 2 TRIAL FAILED — the remaining seats hit the failure condition inside the\n" +
			"window, and the session start that would have said so at the time was missed.\n" +
			`${r.fires.map((x) => `  ${utc(x.at)} UTC: all remaining seats at ${BLOCKED_UTILISATION}%, ${hours(x.hoursToEarliestReset)} to the earliest reset`).join("\n")}\n` +
			"  THE PRESCRIBED ACT IS: RE-ENABLE SEAT 3. Probation ends, the seat stays, and\n" +
			"  the $600/month ceiling stands — not a purchase, not a ceiling re-decision.\n";
	else
		head =
			"GATE 2 TRIAL PASSED — two seats carried the fortnight without once meeting the\n" +
			`failure condition (${BLOCKED_UTILISATION}% on every remaining seat with over ${MIN_HOURS_TO_RESET}h to the\n` +
			"earliest reset). THE PRESCRIBED ACT IS: RETIRE SEAT 3, ending the probation.\n";
	const [firstNote] = r.annotations;
	const annotations = firstNote
		? `  Seat 3 was touched ${r.annotations.length} time(s) without measurable use: ${firstNote.detail} (mantahostels#2848).\n`
		: "";
	const dropped = r.droppedLines
		? `  ${r.droppedLines} history line(s) inside the window would not parse and were\n` +
			"  dropped — a run of these is itself a coverage gap, on top of the count above.\n"
		: "";
	return (
		`${head}` +
		`  Window: ${windowLine(d)}.\n` +
		`  COVERAGE — ${r.readingCount} reading(s) inside it, largest gap ${hours(r.largestGapHours)}. Judge the\n` +
		"  verdict on that: a gap neither extends nor voids the window, because work\n" +
		"  stopping is itself what this gate measures (mantahostels#2848), but an unmeasured stretch\n" +
		"  is a reason to distrust a pass.\n" +
		`${dropped}` +
		`${annotations}` +
		"  The ordinary ceiling trigger was SUPPRESSED for the window above and is\n" +
		"  running again now. This notice repeats at every session start until the\n" +
		`  declaration block is cleared from ${ladderPath()}.\n`
	);
}

/**
 * @param {Ctx} ctx
 * @param {{ decl: TrialDeclaration, tv: ReturnType<typeof trialVerdict>, phase: ReturnType<typeof windowPhase> }} trial
 */
function sayDeclarationState(ctx, { decl, tv, phase }) {
	if (decl.state !== "none" && !tv.honoured) {
		ctx.say(
			(decl.state === "unreadable"
				? ladderUnreadableNotice
				: cannotHonourNotice)(
				tv.reason ?? "the declaration could not be parsed",
			),
		);
	} else if (phase === "pending" && tv.honoured) {
		/* Between the declaration and the measured window's start the two
		 * remaining seats are still carrying allowance consumed while seat 3
		 * worked, so nothing is measured yet (mantahostels#2848 Q1). Said rather than
		 * silent: those days look identical to a live trial from the outside. */
		ctx.say(
			`GATE 2 TRIAL PENDING — declared, and the measured window opens ${utc(decl.startIso ?? null)} UTC.\n` +
				`  ${windowLine(decl)}. Until then nothing is measured and the ordinary\n` +
				"  three-seat trigger is running unchanged.\n",
		);
	}
}

/**
 * @param {Ctx} ctx
 * @param {{ tv: ReturnType<typeof trialVerdict>, liveVerdict: ReturnType<typeof verdict>, decl: TrialDeclaration, t: number }} at
 *   `liveVerdict` is the trial's verdict over the seats it leaves live
 */
function warnTrialFailed(ctx, { tv, liveVerdict, decl, t }) {
	ctx.warn(
		"GATE-2-TRIAL-FAILED",
		`the ${liveVerdict.read.length} seat(s) left live by the trial are at ${BLOCKED_UTILISATION}% with more than ${MIN_HOURS_TO_RESET}h to the earliest reset`,
		{
			trial: { start: decl.startIso, end: decl.endIso, excluded: decl.dir },
			seats: liveVerdict.read.map((s) => ({
				dir: s.dir,
				sevenDay: s.sevenDay,
				resetsAt: s.resetsAt,
			})),
			hoursToEarliestReset: liveVerdict.hoursToEarliestReset,
		},
	);
	ctx.say(trialFailedNotice(tv, decl, t));
}

/**
 * @param {Ctx} ctx
 * @param {ReturnType<typeof trialReview>} review
 * @param {TrialDeclaration} decl
 */
function reportReview(ctx, review, decl) {
	/* A PASS IS SPOKEN, NOT WARNED. findingCount() excludes it, and a WARN
	 * carrying a count of 0 reads as a fault the checker could not name. */
	if (review.kind !== "passed")
		ctx.warn(
			`GATE-2-TRIAL-${review.kind.toUpperCase()}`,
			`the declared trial window closed ${utc(decl.endIso ?? null)} UTC and reads as ${review.kind}`,
			{
				trial: {
					start: decl.startIso,
					end: decl.endIso,
					excluded: decl.dir,
				},
				...review,
			},
		);
	ctx.say(trialEndedNotice(review, decl));
}

/**
 * @param {Ctx} ctx
 * @param {ReturnType<typeof verdict>} v
 */
function warnAllExhausted(ctx, v) {
	ctx.warn(
		"ALL-SEATS-EXHAUSTED",
		`every live seat is at ${BLOCKED_UTILISATION}% with more than ${MIN_HOURS_TO_RESET}h to the earliest reset`,
		{
			seats: v.read.map((s) => ({
				dir: s.dir,
				sevenDay: s.sevenDay,
				resetsAt: s.resetsAt,
			})),
			hoursToEarliestReset: v.hoursToEarliestReset,
		},
	);
	ctx.say(blockedNotice(v));
}

/**
 * @param {Ctx} ctx
 * @param {{ v: ReturnType<typeof verdict>, tv: ReturnType<typeof trialVerdict>, decl: TrialDeclaration, t: number, review: ReturnType<typeof trialReview> | null, suppressed: boolean, phase: ReturnType<typeof windowPhase> }} at
 */
function reportVerdict(ctx, { v, tv, decl, t, review, suppressed, phase }) {
	if (suppressed && phase === "live" && tv.verdict?.fired)
		warnTrialFailed(ctx, { tv, liveVerdict: tv.verdict, decl, t });
	else if (review) reportReview(ctx, review, decl);
	else if (v.fired && !suppressed) warnAllExhausted(ctx, v);
	else if (suppressed && tv.verdict?.panelNeeded) {
		/* mantahostels#1742's held fire, inside the trial. Without this limb an unread
		 * REMAINING seat blocks the trial fire in total silence, on a window
		 * that cannot be replayed — the excluded seat is excluded, but an
		 * unreadable live one still has to be finished by hand. */
		ctx.say(
			`SEAT UNREAD (${tv.verdict.unread.length}) — every seat the trial leaves live and readable is at\n` +
				`${BLOCKED_UTILISATION}%, but ${tv.verdict.unread.map((s) => s.dir).join(", ")} carries no reading at all.\n` +
				"  Absent means UNREAD, not zero (mantahostels#1742), so the trial-failure verdict is held.\n" +
				"  Read Settings -> Usage on that seat: at 100% the trial has FAILED and the act\n" +
				"  is to re-enable seat 3 — probation ends, the seat stays, the $600 stands.\n",
		);
	} else if (v.panelNeeded && !suppressed) {
		/* Spoken, never a finding: the condition is unproven, and a WARN here
		 * would put a seat nobody has run on the same footing as one measured at
		 * 100%. */
		ctx.say(
			`SEAT UNREAD (${v.unread.length}) — every seat with a usage cache is at ${BLOCKED_UTILISATION}%, but\n` +
				`${v.unread.map((s) => s.dir).join(", ")} has never run and so carries no reading at all.\n` +
				"  Absent means UNREAD, not zero (mantahostels#1742), so the blocked-work trigger is held.\n" +
				"  Read Settings -> Usage on that seat: at 100% the trigger's condition holds and\n" +
				"  the act is a ceiling re-decision (re-run map mantahostels#1732), never a purchase.\n",
		);
	}
}

/**
 * @param {{ suppressed: boolean, v: ReturnType<typeof verdict>, tv: ReturnType<typeof trialVerdict>, decl: TrialDeclaration, seats: Seat[] }} at
 * @returns {string}
 */
function okLineFor({ suppressed, v, tv, decl, seats }) {
	if (suppressed)
		return `gate 2 trial live to ${utc(decl.endIso ?? null)} UTC over ${tv.verdict?.read.length ?? 0} seat(s), ${decl.dir} excluded; the ordinary ceiling trigger is suppressed until then.`;
	if (v.allExhausted)
		return `every readable seat is at ${BLOCKED_UTILISATION}%, but the earliest reset is ${hours(v.hoursToEarliestReset)} away — inside the ${MIN_HOURS_TO_RESET}h this policy waits out.`;
	if (v.read.length === 0)
		/* Every seat present but none ever run. Never "0%": that is the
		 * reading mantahostels#1742 forbids, and it would read as allowance to spare. */
		return `${seats.length} seat(s) found, none with a usage cache — read Settings -> Usage.`;
	return `${v.read.length} seat(s) read, highest 7-day utilisation ${Math.max(...v.read.map((s) => s.effective ?? 0))}%.`;
}

/**
 * @param {Ctx} ctx
 * @param {Seat[]} seats
 * @param {ReturnType<typeof recordReading>} recorded
 */
function sayTable(ctx, seats, recorded) {
	ctx.say(seatTable(seats));
	if (recorded === "failed")
		ctx.say(
			`(could not append today's reading to ${HISTORY_FILE()}, so this\n` +
				"reading is lost — see HISTORY_FILE in scripts/lib/seat-utilisation.js.)\n",
		);
}

/**
 * @param {Ctx} ctx
 * @param {ReturnType<typeof scopedVerdict>} scoped
 */
function warnScopedTier(ctx, scoped) {
	ctx.warn(
		"MODEL-TIER-SPENT",
		`${scoped.exhausted.map((m) => m.model).join(", ")} weekly allowance is at ${BLOCKED_UTILISATION}% on every readable seat`,
		{ models: scopedModelsSummary(scoped.exhausted) },
	);
	ctx.say(scopedTierNotice(scoped.exhausted));
}

/**
 * Each seat as `--json` carries it.
 *
 * @param {Seat[]} seats
 */
const seatRows = (seats) =>
	seats.map((s) => ({
		dir: s.dir,
		unread: s.unread,
		sevenDay: s.sevenDay,
		effective: s.effective,
		fiveHour: s.fiveHour,
		resetsAt: s.resetsAt,
		staleHours: s.staleHours === null ? null : Number(s.staleHours.toFixed(1)),
		rolled: s.rolled,
		severity: s.severity,
	}));

/**
 * @param {{ suppressed: boolean, v: ReturnType<typeof verdict>, tv: ReturnType<typeof trialVerdict>, review: ReturnType<typeof trialReview> | null, scoped: ReturnType<typeof scopedVerdict> }} at
 */
function findingCount({ suppressed, v, tv, review, scoped }) {
	const fired = suppressed ? tv.verdict?.fired : v.fired;
	return (
		(fired ? 1 : 0) +
		(review && review.kind !== "passed" ? 1 : 0) +
		(scoped.fired ? 1 : 0)
	);
}

/**
 * The trial as `--json` carries it.
 *
 * @param {{ phase: ReturnType<typeof windowPhase>, tv: ReturnType<typeof trialVerdict>, decl: TrialDeclaration, suppressed: boolean, review: ReturnType<typeof trialReview> | null }} at
 */
const trialData = ({ phase, tv, decl, suppressed, review }) => ({
	phase,
	honoured: tv.honoured,
	reason: tv.reason ?? null,
	start: decl.startIso ?? null,
	end: decl.endIso ?? null,
	excluded: decl.dir ?? null,
	suppressed,
	use: tv.use ?? null,
	review,
});

runCheck({
	name: "seat-utilisation",
	usage: "node check-seat-utilisation.js [--warn] [--json] [--notify]",
	/** @param {Ctx} ctx */
	run(ctx) {
		/* A refused or unreadable ladder declaration warns on stderr, which a
		 * SessionStart hook drops, and only when a notice names the ladder. Read
		 * it first on every --notify run so the warning lands on stdout and the
		 * later calls find it already said (#410). --json would drop it. */
		if (ctx.notify && !ctx.asJson) ladderPath({ say: (line) => ctx.say(line) });
		/* This clock reaches recordReading()'s durable history/throttle stamp, so
		 * an unrelated session exporting WFC_NOW skews or silences that seat's
		 * daily reading — lib/check.js's now() states the general residual
		 * (mantahostels#2161). */
		const t = now();
		const dirs = configDirs();
		const seats = readSeats(t, dirs);
		/* SKIP, not BROKEN: the seat caches are the SUBJECT and live outside the
		 * repo, so a machine that has never run Claude Code is not this repo's
		 * fault. It must never read as "no seat is exhausted". */
		if (seats.length === 0)
			throw skipError(
				`no Claude Code seat directory found (${dirs.join(", ")}).`,
			);

		const v = verdict(seats, t);
		const recorded = recordReading(seats, t);

		/* Gate 2. The ordinary verdict above is computed and reported either way;
		 * what a live trial changes is which notice prints. */
		const decl = readTrialWindow();
		const phase = windowPhase(decl, t);
		const tv = trialVerdict(seats, decl, t);
		const review =
			phase === "ended" && tv.honoured
				? trialReview(readHistory(), decl)
				: null;
		/* Suppressed only while the window is OPEN and honoured (mantahostels#2845). A
		 * declaration that cannot be read suppresses nothing. */
		const suppressed = phase === "live" && tv.honoured;

		/* #298 ruling 6: keyed off `suppressed`, never the wider `tv.honoured` —
		 * a PENDING or ENDED declaration runs the ordinary three-seat trigger
		 * unchanged, so this one does too. `suppressed` only picks which seats
		 * it is read over; it never stops this notice from printing. */
		const scoped = scopedVerdict(suppressed ? (tv.remaining ?? seats) : seats);

		if (!ctx.notify) sayTable(ctx, seats, recorded);

		sayDeclarationState(ctx, { decl, tv, phase });

		reportVerdict(ctx, { v, tv, decl, t, review, suppressed, phase });

		/* #298's second state — never chained onto `blockedNotice`'s branch,
		 * which prescribes a different act. `heldFire` prints NOTHING (ruling
		 * 3): the ordinary trigger's own `SEAT UNREAD` notice already covers
		 * the unread seat. */
		if (scoped.fired) warnScopedTier(ctx, scoped);

		const okLine = okLineFor({ suppressed, v, tv, decl, seats });
		return {
			okLine,
			noun: "exhausted-seat conditions",
			count: findingCount({ suppressed, v, tv, review, scoped }),
			data: {
				recorded,
				scoped: {
					fired: scoped.fired,
					heldFire: scoped.heldFire,
					models: scopedModelsSummary(scoped.exhausted, { severity: true }),
					unread: scoped.unread.map((s) => s.dir),
				},
				trial: trialData({ phase, tv, decl, suppressed, review }),
				hoursToEarliestReset: v.hoursToEarliestReset,
				seats: seatRows(seats),
			},
		};
	},
});
