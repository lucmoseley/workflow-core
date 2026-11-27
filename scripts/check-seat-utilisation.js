#!/usr/bin/env node

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

/** @param {string | null} iso */
const utc = (iso) => (iso ?? "?").slice(0, 16).replace("T", " ");

/** @param {Seat[]} seats */
function seatTable(seats) {
	const rows = seats.map((s) => {
		if (s.unread) return `  ${s.dir.padEnd(10)}  never run — no usage cache`;
		const roll = s.rolled ? " (window has since reset — read as 0)" : "";
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

/** @param {ReturnType<typeof verdict>} v */
function buildBlockedNotice(v) {
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
 * @param {ScopedModelState[]} exhausted
 * @param {{ severity?: boolean }} [opts]
 */
function buildScopedModelsSummary(exhausted, opts = {}) {
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

/** @param {ScopedModelState[]} exhausted */
function buildScopedTierNotice(exhausted) {
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

/** @param {import("./lib/trial-window").TrialDeclaration} d */
const buildWindowLine = (d) =>
	`${utc(d.startIso ?? null)} → ${utc(d.endIso ?? null)} UTC ` +
	`(${Math.round(((d.endMs ?? 0) - (d.startMs ?? 0)) / 864e5)} days)`;

/** @param {string} reason */
const buildCannotHonourNotice = (reason) =>
	"TRIAL DECLARED, NOT HONOURED — gate 2's trial window in\n" +
	`${ladderPath()} cannot be read against this machine:\n` +
	`  ${reason}.\n` +
	"  The ordinary three-seat trigger is running unchanged, so nothing is being\n" +
	"  suppressed — but GATE 2 IS NOT BEING MEASURED. Fix the declaration or\n" +
	"  remove it; the trial fortnight cannot be replayed.\n";

/** @param {string} reason */
const buildLadderUnreadableNotice = (reason) =>
	"GATE 2 LADDER UNREADABLE — whether a gate 2 trial is declared is unknown:\n" +
	`  ${reason}.\n` +
	"  The ordinary three-seat trigger is running unchanged, so nothing is being\n" +
	"  suppressed — but IF A TRIAL IS DECLARED, GATE 2 IS NOT BEING MEASURED.\n" +
	"  Make the ladder readable at that path; a repo that keeps none removes\n" +
	'  whatever is there and sets `"capacityLadder": false` in\n' +
	"  .claude/workflow-core.json.\n";

/**
 * @param {ReturnType<typeof trialVerdict>} tv
 * @param {import("./lib/trial-window").TrialDeclaration} d
 * @param {number} nowMs
 */
function buildTrialFailedNotice(tv, d, nowMs) {
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
		`  The ordinary ceiling trigger was SUPPRESSED for this trial — ${buildWindowLine(d)} —\n` +
		"  and resumes over three seats the day the seat is back.\n" +
		`${use}` +
		`  Then clear the declaration block from ${ladderPath()}.\n`
	);
}

/**
 * @param {ReturnType<typeof trialReview>} r
 * @param {import("./lib/trial-window").TrialDeclaration} d
 */
function buildTrialEndedNotice(r, d) {
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
	const zeroed = r.zeroedRecords
		? `  ${r.zeroedRecords} history record(s) zeroed by a crash are lost — a coverage gap\n` +
			"  on top of the count above.\n"
		: "";
	return (
		`${head}` +
		`  Window: ${buildWindowLine(d)}.\n` +
		`  COVERAGE — ${r.readingCount} reading(s) inside it, largest gap ${hours(r.largestGapHours)}. Judge the\n` +
		"  verdict on that: a gap neither extends nor voids the window, because work\n" +
		"  stopping is itself what this gate measures (mantahostels#2848), but an unmeasured stretch\n" +
		"  is a reason to distrust a pass.\n" +
		`${dropped}` +
		`${zeroed}` +
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
				? buildLadderUnreadableNotice
				: buildCannotHonourNotice)(
				tv.reason ?? "the declaration could not be parsed",
			),
		);
	} else if (phase === "pending" && tv.honoured) {
		ctx.say(
			`GATE 2 TRIAL PENDING — declared, and the measured window opens ${utc(decl.startIso ?? null)} UTC.\n` +
				`  ${buildWindowLine(decl)}. Until then nothing is measured and the ordinary\n` +
				"  three-seat trigger is running unchanged.\n",
		);
	}
}

/**
 * @param {Ctx} ctx
 * @param {{ tv: ReturnType<typeof trialVerdict>, liveVerdict: ReturnType<typeof verdict>, decl: TrialDeclaration, t: number }} at
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
	ctx.say(buildTrialFailedNotice(tv, decl, t));
}

/**
 * @param {Ctx} ctx
 * @param {ReturnType<typeof trialReview>} review
 * @param {TrialDeclaration} decl
 */
function reportReview(ctx, review, decl) {
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
	ctx.say(buildTrialEndedNotice(review, decl));
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
	ctx.say(buildBlockedNotice(v));
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
		ctx.say(
			`SEAT UNREAD (${tv.verdict.unread.length}) — every seat the trial leaves live and readable is at\n` +
				`${BLOCKED_UTILISATION}%, but ${tv.verdict.unread.map((s) => s.dir).join(", ")} carries no reading at all.\n` +
				"  Absent means UNREAD, not zero (mantahostels#1742), so the trial-failure verdict is held.\n" +
				"  Read Settings -> Usage on that seat: at 100% the trial has FAILED and the act\n" +
				"  is to re-enable seat 3 — probation ends, the seat stays, the $600 stands.\n",
		);
	} else if (v.panelNeeded && !suppressed) {
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
		{ models: buildScopedModelsSummary(scoped.exhausted) },
	);
	ctx.say(buildScopedTierNotice(scoped.exhausted));
}

/** @param {Seat[]} seats */
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

/** @param {{ phase: ReturnType<typeof windowPhase>, tv: ReturnType<typeof trialVerdict>, decl: TrialDeclaration, suppressed: boolean, review: ReturnType<typeof trialReview> | null }} at */
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
		// workflow-core#410
		if (ctx.notify && !ctx.asJson) ladderPath({ say: (line) => ctx.say(line) });
		const t = now();
		const dirs = configDirs();
		const seats = readSeats(t, dirs);
		if (seats.length === 0)
			throw skipError(
				`no Claude Code seat directory found (${dirs.join(", ")}).`,
			);

		const v = verdict(seats, t);
		const recorded = recordReading(seats, t);

		const decl = readTrialWindow();
		const phase = windowPhase(decl, t);
		const tv = trialVerdict(seats, decl, t);
		const review =
			phase === "ended" && tv.honoured
				? trialReview(readHistory(), decl)
				: null;
		// lucmoseley/mantahostels#2845
		const suppressed = phase === "live" && tv.honoured;

		// workflow-core#298
		const scoped = scopedVerdict(suppressed ? (tv.remaining ?? seats) : seats);

		if (!ctx.notify) sayTable(ctx, seats, recorded);

		sayDeclarationState(ctx, { decl, tv, phase });

		reportVerdict(ctx, { v, tv, decl, t, review, suppressed, phase });

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
					models: buildScopedModelsSummary(scoped.exhausted, {
						severity: true,
					}),
					unread: scoped.unread.map((s) => s.dir),
				},
				trial: trialData({ phase, tv, decl, suppressed, review }),
				hoursToEarliestReset: v.hoursToEarliestReset,
				seats: seatRows(seats),
			},
		};
	},
});
