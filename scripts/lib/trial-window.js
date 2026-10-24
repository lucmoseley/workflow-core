/*
 * trial-window.js — the one parser of gate 2's trial declaration.
 *
 * WHAT A DECLARATION IS. Seat 3's probation ends in a live trial: the seat is
 * disabled and the two remaining seats are watched for a fortnight
 * (`docs/capacity-procurement-ladder.md` § Seat 3's probation). mantahostels#2847 settled
 * that the trial is declared as a dated, tracked block in the ladder itself —
 * not a marker file, not an environment variable — because a tracked line is
 * reviewable, survives a fresh checkout, and is already the shape
 * `rungOneLogged()` reads at every session start.
 *
 * WHY A MODULE OF ITS OWN (mantahostels#2857). Two readers honour the same declaration and
 * neither imports the other: `check-seat-utilisation.js` excludes the declared
 * seat from its trigger, and `check-self-throttling.js` switches its episode
 * notice on for the window's duration. Two parsers of one grammar drift, which
 * is the failure the tracked declaration was chosen to avoid.
 *
 * WHY THE WINDOW IS TWO WRITTEN INSTANTS AND NOT A FLAG (mantahostels#2847). During the
 * trial the ordinary ceiling re-decision is deliberately suppressed (mantahostels#2845), so
 * a forgotten boolean would suppress it for ever with nothing anywhere saying
 * so. A window expires by arithmetic, which bounds that failure at a fortnight.
 *
 * WHY THE START IS NOT THE DECLARATION DATE (mantahostels#2848). Both remaining seats carry
 * allowance consumed while seat 3 was still working, inside a window that opened
 * before the trial — measuring from the declaration would inflate the chance of
 * an early 100% and fail the trial falsely. So the measured window opens at the
 * LATER of the two remaining seats' first `resets_at` after the declaration, and
 * the days before it are genuine two-seat operation that is simply not measured.
 *
 * NEVER THROWS. Both readers run on the `SessionStart` path across roughly ten
 * concurrent sessions, so an unreadable or half-written ladder returns a
 * refused state (`"unreadable"`) rather than taking a session start down with
 * it — never silently as "no declaration", which would sail past the loud
 * not-honoured branch in `check-seat-utilisation.js` on a fortnight that
 * cannot be replayed (mantahostels#2871).
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./host-root.js");
const { requiredGroup } = require("./regex-group.js");
const { declaresLadder, ladderPath } = require("./workflow-core-config.js");
const { caught } = require("./caught.js");

/** The ladder, which is where both the rung-1 limb and the trial declaration
 *  are read from — `capacityLadderPath` where the host declares one (#401).
 *  `WFC_LADDER` is the test seam. */
/** @type {() => string} */
const LADDER = () =>
	process.env.WFC_LADDER || path.join(hostRoot(), ladderPath());

/** The heading the declaration lives under. NOT `### Re-assessment log`: a
 *  dated line there flips `rungOneLogged()`, which would silently drop the
 *  "rung 1 is unapplied" opener from the blocked-work notice (mantahostels#2847). */
const SECTION = "#### Gate 2 trial declaration";

/** A declaration whose start instant was computed off a seat reading older than
 *  this is refusing to be trusted: the `resets_at` it used may itself be a
 *  carried-forward figure from a dormant seat (mantahostels#2697), which puts the computed
 *  start on the wrong day. mantahostels#2848 ruled that case a refusal, never a guess.
 *  24h and not some other bound: no sourced figure sets it exactly — it is "a
 *  day" (mantahostels#2848), chosen to match `RECORD_MIN_AGE_HOURS` in
 *  lib/seat-utilisation.js, the same cadence the daily history is recorded at.
 *  A basis older than one recording cycle could not have been refreshed by the
 *  ordinary reading process even on a seat still in use, so it stops being
 *  informative about whether that seat has since gone dormant. */
const MAX_BASIS_STALE_HOURS = 24;

/** mantahostels#2848 gave the trial 14 days. A longer window is a typo — a slipped month or
 *  year — and mantahostels#2847 chose two written instants precisely so a forgotten
 *  declaration expires by arithmetic rather than suppressing the ceiling
 *  trigger for ever; a window with no upper bound gives that back. The slack
 *  over 14 is deliberate: a re-declared window may legitimately run a little
 *  long, and refusing one outright would be the same loss in the other
 *  direction. */
const MAX_WINDOW_DAYS = 21;

/**
 * @typedef {object} BasisSeat
 * @property {string} dir
 * @property {string} resetsAt   ISO, as read at declaration time
 * @property {number} staleHours how old that seat's reading was when read
 */

/**
 * Seat 3's own reading at declaration time — the baseline the void/annotate
 * limb compares against (mantahostels#2848 Q3).
 *
 * @typedef {object} ExcludedBaseline
 * @property {number} sevenDay
 * @property {string} resetsAt
 * @property {number} fetchedAtMs
 */

/**
 * @typedef {object} TrialDeclaration
 * @property {"none" | "malformed" | "unreadable" | "declared"} state
 * @property {string} [reason]        why a malformed or unreadable one was refused
 * @property {string} [dir]           the declared seat directory, ADVISORY only
 * @property {string} [accountUuid]   what the exclusion actually matches on
 * @property {string} [startIso]
 * @property {string} [endIso]
 * @property {number} [startMs]
 * @property {number} [endMs]
 * @property {BasisSeat[]} [basis]
 * @property {ExcludedBaseline} [excludedBaseline]
 */

/** @type {TrialDeclaration} */
const NONE = { state: "none" };

/** @param {string} reason @returns {TrialDeclaration} */
const malformed = (reason) => ({ state: "malformed", reason });

/** Distinct from `NONE`: the ladder itself could not be read, so nothing was
 *  parsed at all — as opposed to reading it and finding no declaration
 *  section. Collapsing the two let an I/O failure sail past the loud
 *  not-honoured branch in `check-seat-utilisation.js`, reading as no trial at
 *  all on a fortnight that cannot be replayed (mantahostels#2871). `windowPhase()` and
 *  `trialVerdict()` both treat this like `malformed` — refused, and said.
 *  @param {string} reason @returns {TrialDeclaration} */
const unreadable = (reason) => ({ state: "unreadable", reason });

/**
 * The declaration section's own lines, with HTML comments stripped first.
 *
 * THE TEMPLATE LIVES IN A COMMENT, so the undeclared state is the file's
 * resting state and declaring is uncommenting rather than remembering a
 * grammar. Stripping comments before the scan is what makes that safe.
 *
 * @param {string} text
 * @returns {string[] | null} null where the section is absent
 */
function sectionLines(text) {
	const bare = text.replace(/<!--[\s\S]*?-->/g, "");
	const at = bare.indexOf(SECTION);
	if (at === -1) return null;
	/** @type {string[]} */
	const out = [];
	for (const line of bare.slice(at).split("\n").slice(1)) {
		if (/^#{1,4} /.test(line)) break;
		out.push(line);
	}
	return out;
}

/** @param {string[]} lines @param {string} key */
const field = (lines, key) => {
	const re = new RegExp(`^[-*]\\s+\\*\\*${key}:\\*\\*\\s*(.+?)\\s*$`);
	for (const line of lines) {
		const m = re.exec(line);
		if (m) return requiredGroup(m, 1, re);
	}
	return null;
};

const BACKTICKED = /^`([^`]+)`$/;
const WINDOW_LINE = /^`([^`]+)`\s*(?:→|->)\s*`([^`]+)`$/;
const BASIS_ENTRY =
	/^\s*`([^`]+)`\s+resets\s+`([^`]+)`\s+read\s+([\d.]+)h ago\s*$/;
const BASELINE_LINE =
	/^7d\s+(\d+)%\s*·\s*resets\s+`([^`]+)`\s*·\s*fetched\s+`([^`]+)`$/;

/**
 * Parse the whole declaration out of ladder text.
 *
 * @param {string} text
 * @returns {TrialDeclaration}
 */
function parseTrialWindow(text) {
	const lines = sectionLines(text);
	if (lines === null) return NONE;

	const seat = field(lines, "seat");
	const account = field(lines, "account");
	const basisText = field(lines, "start basis");
	const windowText = field(lines, "measured window");
	const baselineText = field(lines, "seat 3 at declaration");
	/* Nothing filled in at all is the resting state, not a fault: the section
	 * exists between trials and must read as silence. */
	if (!seat && !account && !basisText && !windowText && !baselineText)
		return NONE;

	const dirM = seat === null ? null : BACKTICKED.exec(seat);
	if (!dirM) return malformed("no `seat` line naming a seat directory");
	const acctM = account === null ? null : BACKTICKED.exec(account);
	if (!acctM) return malformed("no `account` line naming an accountUuid");

	const window = parseWindow(windowText);
	if ("fault" in window) return malformed(window.fault);
	const { startMs, endMs } = window;
	const basis = parseBasis(basisText, startMs);
	if ("fault" in basis) return malformed(basis.fault);
	const excludedBaseline = parseBaseline(baselineText);
	if ("fault" in excludedBaseline) return malformed(excludedBaseline.fault);

	return {
		state: "declared",
		dir: requiredGroup(dirM, 1, BACKTICKED),
		accountUuid: requiredGroup(acctM, 1, BACKTICKED),
		startIso: new Date(startMs).toISOString(),
		endIso: new Date(endMs).toISOString(),
		startMs,
		endMs,
		basis: basis.seats,
		excludedBaseline,
	};
}

/**
 * @param {string|null} windowText
 * @returns {{fault: string} | {startMs: number, endMs: number}}
 */
function parseWindow(windowText) {
	const winM = windowText === null ? null : WINDOW_LINE.exec(windowText);
	if (!winM)
		return {
			fault: "no `measured window` line in the form `<start>` → `<end>`",
		};
	const startMs = Date.parse(requiredGroup(winM, 1, WINDOW_LINE));
	const endMs = Date.parse(requiredGroup(winM, 2, WINDOW_LINE));
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs))
		return { fault: "the measured window's instants do not parse as dates" };
	if (endMs <= startMs)
		return { fault: "the measured window ends at or before it starts" };
	const days = (endMs - startMs) / 864e5;
	if (days > MAX_WINDOW_DAYS)
		return {
			fault:
				`the measured window runs ${Math.round(days)} days, over the ${MAX_WINDOW_DAYS}-day ` +
				"bound — the trial is a fortnight, so this is a mistyped end instant",
		};
	return { startMs, endMs };
}

/**
 * The `start basis` seats, refused where any is stale or the window does not
 * start at the later of their reset instants.
 * @param {string|null} basisText
 * @param {number} startMs
 * @returns {{fault: string} | {seats: BasisSeat[]}}
 */
function parseBasis(basisText, startMs) {
	if (basisText === null)
		return {
			fault: "no `start basis` line, so the start instant cannot be checked",
		};
	/** @type {BasisSeat[]} */
	const basis = [];
	for (const part of basisText.split("·")) {
		const seat = parseBasisEntry(part);
		if ("fault" in seat) return seat;
		basis.push(seat);
	}
	if (basis.length === 0)
		return { fault: "the `start basis` line names no seat" };

	/* mantahostels#2848's carried-forward case. A dormant seat's cache repeats its last
	 * `resets_at` under a fresh reading, so a basis read hours after that seat
	 * last ran may be describing a window that has already rolled — and the
	 * start instant computed off it lands on the wrong day, on a fortnight that
	 * cannot be replayed. */
	const staleSeat = basis.find((b) => b.staleHours >= MAX_BASIS_STALE_HOURS);
	if (staleSeat)
		return {
			fault:
				`the start basis for \`${staleSeat.dir}\` was ${staleSeat.staleHours}h stale ` +
				`when read, at or over the ${MAX_BASIS_STALE_HOURS}h bound — its \`resets_at\` ` +
				"may be carried forward (mantahostels#2697), so the start instant cannot be trusted",
		};
	const latest = Math.max(...basis.map((b) => Date.parse(b.resetsAt)));
	if (latest !== startMs)
		return {
			fault:
				"the measured window does not start at the LATER of the start basis' " +
				`reset instants (${new Date(latest).toISOString()})`,
		};
	return { seats: basis };
}

/**
 * @param {string} part one `·`-separated entry of the `start basis` line
 * @returns {{fault: string} | BasisSeat}
 */
function parseBasisEntry(part) {
	const m = BASIS_ENTRY.exec(part);
	if (!m)
		return {
			fault:
				"a `start basis` entry is not `<dir>` resets `<iso>` read <n>h ago",
		};
	const dir = requiredGroup(m, 1, BASIS_ENTRY);
	const resetsAt = requiredGroup(m, 2, BASIS_ENTRY);
	const at = Date.parse(resetsAt);
	if (!Number.isFinite(at))
		return { fault: "a `start basis` reset instant does not parse as a date" };
	const staleHours = Number(m[3]);
	/* `NaN >= 24` is false, so a malformed figure would sail through the
	 * staleness refusal in `parseBasis` and be ACCEPTED — the expensive direction, a
	 * fortnight of suppressed upward trigger off a possibly carried-forward
	 * `resets_at`. */
	if (!Number.isFinite(staleHours))
		return {
			fault: `the \`start basis\` staleness for \`${dir}\` is not a number`,
		};
	return { dir, resetsAt, staleHours };
}

/**
 * @param {string|null} baselineText
 * @returns {{fault: string} | ExcludedBaseline}
 */
function parseBaseline(baselineText) {
	const baseM = baselineText === null ? null : BASELINE_LINE.exec(baselineText);
	if (!baseM)
		return {
			fault:
				"no `seat 3 at declaration` line in the form 7d <n>% · resets `<iso>` · fetched `<iso>`",
		};
	const baselineResetsAt = requiredGroup(baseM, 2, BASELINE_LINE);
	const fetchedAtMs = Date.parse(requiredGroup(baseM, 3, BASELINE_LINE));
	if (
		!Number.isFinite(Date.parse(baselineResetsAt)) ||
		!Number.isFinite(fetchedAtMs)
	)
		return {
			fault: "the `seat 3 at declaration` instants do not parse as dates",
		};
	return {
		sevenDay: Number(requiredGroup(baseM, 1, BASELINE_LINE)),
		resetsAt: baselineResetsAt,
		fetchedAtMs,
	};
}

/**
 * The declaration as it stands on disk. Never throws.
 *
 * A missing ladder is unreadable (mantahostels#2871) only where the host config
 * declares `"capacityLadder": true`. Anywhere else its absence is no trial,
 * since most adopters keep none (#735). What that leaves open: a host
 * that keeps a ladder without declaring `true` reads its vanished ladder as no
 * trial, the silent pass mantahostels#2871 closed — so a ladder-keeping host
 * declares it, as mantahostels does.
 *
 * @param {string} [file]
 * @param {{root?: string}} [host] where the host config is read from
 * @returns {TrialDeclaration}
 */
function readTrialWindow(file = LADDER(), host = {}) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		const { code, message } = caught(e);
		if (code === "ENOENT" && !declaresLadder(host)) return NONE;
		return unreadable(
			`the ladder at ${file} could not be read (${code ?? message})`,
		);
	}
	return parseTrialWindow(text);
}

/**
 * Where `now` sits against a parsed declaration.
 *
 * @param {TrialDeclaration} decl
 * @param {number} [now]
 * @returns {"none" | "malformed" | "unreadable" | "pending" | "live" | "ended"}
 */
function windowPhase(decl, now = Date.now()) {
	if (decl.state !== "declared") return decl.state;
	if (now < /** @type {number} */ (decl.startMs)) return "pending";
	if (now < /** @type {number} */ (decl.endMs)) return "live";
	return "ended";
}

/** Whether the measured window is open right now — the single test
 *  `check-self-throttling.js` conditions its episode notice on (mantahostels#2857 Q5), and
 *  deliberately no `accountUuid` match: that reader sees transcripts, not seats,
 *  so it has no seat dimension on which to disagree. */
const trialLive = () => windowPhase(readTrialWindow(), Date.now()) === "live";

module.exports = {
	LADDER,
	readTrialWindow,
	trialLive,
	windowPhase,
};
