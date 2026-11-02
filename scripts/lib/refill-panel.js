/*
 * refill-panel.js — what the refill loop's panel draws and what a click or a key
 * does, with no terminal (#3873, #3875, #3877, #3879, #3881, #3883, #3884, #3887, #3948, #3958, spec #3596): status JSON and pending presses in, rows
 * out; a click on a row or a key in, a `refill-loop.js` or `burn-mode.sh` argv out, and focus handed back. The
 * panel runs those two for every read and write, and never opens a control or
 * state file, so the loop's validation, lock and wake apply to every loop press.
 *
 * Desired and observed state stay apart. A press is a pending mark beside what
 * the last status read showed, cleared only by a read showing the change or by
 * the command's refusal. An away press, a burn-mode flip, a goal or a repo's tick is
 * whole when its command exits, so any read after that exit shows it, or another writer's
 * reversal, the loop's automatic return included.
 */

const path = require("node:path");
const { caught } = require("./caught.js");
const { localDate } = require("./morning-review.js");
const { ESC } = require("./refill-panel-input.js");
const { buildControlImage } = require("./refill-panel-sixel.js");
const { describeAge } = require("./proc-table.js");
const { NO_PROGRESS_PAUSE } = require("./refill-decide.js");
const { buildProgressText, parseGoalForm } = require("./refill-goal.js");

/* Where the block starts, 1-based as a mouse report counts. Untraced: one cell
 * of margin round the prototype's layout (#2525 round 9). */
const TOP_ROW = 2;
const LEFT_COLUMN = 3;
/* Untraced, a first guess: Windows' default lines per wheel notch. */
const WHEEL_ROWS = 3;
const MORE_ABOVE_MARK = "↑ more";
const MORE_BELOW_MARK = "↓ more";

/* How long a press's note holds its row before that row's own words return. Untraced:
 * a first guess, long enough to read one line. */
const NOTE_SHOW_MS = 10_000;

/* How long a resume waits for a read to show its process before the row returns.
 * Untraced: a first guess. */
const RESUME_SHOW_MS = 30_000;

/* The skill's line on every flip (`.claude/skills/burn-mode/SKILL.md`). */
const BURN_RESTART_NOTE = "Running sessions keep their effort until restarted";

const AWAY_OFF_WORD = "normal";

/* How `refill-loop.js set` opens a warning about a loop with no process. */
const NOT_RUNNING_PREFIX = "refill loop: not running";

/* `status --json` reads a control never written and a damaged one alike, as no
 * mode. */
const NO_CONTROL_TEXT = "No loop settings to change: run `start`";

/* Holds a frame's text and images back until the whole is written, so the images' being
 * erased and redrawn never shows. */
const SYNC_ON = `${ESC}[?2026h`;
const SYNC_OFF = `${ESC}[?2026l`;

/* Two rows in every state, so nothing below the goal moves (#3596 story 55). */
const GOAL_CAPTION = ["Click to change it", "Enter to save · Esc to cancel"];
const KEY_HINT = ["↑↓ move · space change", "Esc leave"];
const POINTER_MARK = "❯";

/* How `refill-loop.js` opens what it refuses under its lock; refused sooner, it
 * prints the bare reason. */
const REFILL_LOOP_PREFIX = /^refill loop: (nothing set: )?/;

/* Two short lines, so a narrow pane cuts neither: a pulled-in blocker is held only
 * by `refillLoop: false` or no checkout (#2427). */
const REPOS_NOTE = [
	"An unticked repo still supplies",
	"the blockers of served issues",
];

/* One row between a title and its first element and between siblings, two
 * between sections (#3596 story 78). */
const SIBLING_GAP = { text: "", role: /** @type {Role} */ ("secondary") };
const SECTION_GAP = [SIBLING_GAP, SIBLING_GAP];

/** @typedef {"name"|"value"|"secondary"|"needsYou"} Role */

/**
 * From #2525 round 9 (#3596 lists the grey as untraced; the yellow is the
 * prototype's).
 * @type {Record<Role, {rgb: [number, number, number], bold?: boolean}>}
 */
const ROLE_STYLES = {
	name: { rgb: [0xf2, 0xf2, 0xf2], bold: true },
	value: { rgb: [0xf2, 0xf2, 0xf2] },
	secondary: { rgb: [0x94, 0x94, 0x94] },
	needsYou: { rgb: [0xff, 0xd7, 0x00] },
};

/**
 * The fields of `refill-loop.js status --json` the panel reads.
 * @typedef {{root: string, number: number}} PauseIssue
 * @typedef {{seat: string, why: string}
 *   | {seat: string, grantUsd: number, headroomUsd: number,
 *     noLaunchLeft: boolean, running: number}} OverflowKey
 * @typedef {{running: boolean, stopRequested: boolean,
 *   stop: {reason: string, at: number, detail: string}|null, crashed: boolean,
 *   paused: {by: string, at: number, issues?: PauseIssue[]}|null,
 *   lastTick: {at: number, idle: string|null,
 *     paused: boolean, planWait: {resets: number|null}|null}|null,
 *   launchesToday: number,
 *   mode: "normal"|"away"|null,
 *   handedOffSinceAway: number,
 *   repos: {name: string, root: string, ticked: boolean, disabled: string|null}[],
 *   goal: ReturnType<typeof import("./refill-goal.js").buildGoalStatus>,
 *   seats: {readings: {seat: string, week: number|null, weekFull: boolean,
 *     weekRead: {percent: number|null, at: string|null, fresh: boolean}}[],
 *     next: {seat: string, reason: string}|null},
 *   overflow: OverflowKey[],
 *   burnMode: ReturnType<typeof import("./burn-mode.js").readBurnState>}} PanelStatus
 */

/**
 * A press no status read has shown yet. `on` is what it asks for; `landed`,
 * whether its command has exited 0, and when.
 * @typedef {{on: boolean, landed: boolean, landedAt?: number}} Pending
 */

/**
 * What a burn-mode flip left to read, held until the next press: its exit, and
 * stderr then stdout unless it exited 0 with nothing on stderr. `on` is what it
 * asked for.
 * @typedef {{on: boolean, code: number, lines: string[]}} BurnReport
 */

/**
 * `held`, shown until the next goal or repo press.
 * @typedef {{text: string, at: number, held?: boolean}} PressNote
 */

/**
 * A goal being typed. `caret`, how many characters stand before it.
 * @typedef {{text: string, caret: number}} GoalEdit
 */

/** @typedef {import("./refill-panel-input.js").Key} Key */

/** @typedef {() => ReturnType<Runner>} FocusReturner */

/**
 * A topic on its way to being a goal; `found`, null until its issues are back.
 * @typedef {import("./refill-panel-topic.js").TopicSet} TopicSet
 * @typedef {{text: string, found: TopicSet|null}} GoalResolve
 */

/**
 * @typedef {{status: PanelStatus|null, readError: string|null,
 *   pending: Pending|null,
 *   refusal: PressNote|null,
 *   awayPending: Pending|null, awayNote: PressNote|null,
 *   burnPending: Pending|null, burnReport: BurnReport|null,
 *   goalEdit: GoalEdit|null, goalResolve: GoalResolve|null,
 *   goalPending: Pending|null, goalNote: PressNote|null,
 *   repoPending: Record<string, Pending>,
 *   repoRefusal: (PressNote & {name: string})|null,
 *   pointer: string|null, focusNote: string|null, scroll: number}} PanelView
 */

/**
 * @typedef {"on"|"off"|"pending"|"unknown"|"failed"} SwitchState
 * @typedef {"ticked"|"unticked"|"pending"|"disabled"} BoxState
 */

/**
 * `detail`, drawn after `text` in regular weight whatever the role. `caret`, where
 * the terminal's cursor stands in `text`, on the row being typed in. `pointed`, the
 * row the keyboard's pointer is on.
 * @typedef {{text: string, role: Role, detail?: string, presses?: "loop",
 *   caret?: number, pointed?: boolean,
 *   control?: {id: "loop"|"away"|"burn"|"goal", state: SwitchState}
 *     | {id: "goalField"|"goalSave"|"goalCancel"}
 *     | {id: "repo", name: string, state: BoxState}}} Row
 */

/** @param {number} n */
const pad = (n) => String(n).padStart(2, "0");

/**
 * @param {number} at
 * @param {number} now
 */
function buildClock(at, now) {
	const d = new Date(at);
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	if (localDate(d) === localDate(new Date(now))) return time;
	return `${localDate(d)} ${time}`;
}

/**
 * The last tick where its words still hold: a tick that idled on a pause since
 * lifted says nothing about a loop now on.
 * @param {PanelStatus} status
 */
const buildCurrentTick = ({ lastTick, paused }) =>
	lastTick?.paused && !paused ? null : lastTick;

/** @type {Row} */
const NEEDS_YOU = { text: "needs you", role: "needsYou" };

/**
 * @param {PauseIssue[]} issues
 */
function buildIssueRefs(issues) {
	const spans = new Set(issues.map((i) => i.root)).size > 1;
	return issues
		.map((i) => `${spans ? path.basename(i.root) : ""}#${i.number}`)
		.join(", ");
}

/**
 * @param {PanelStatus} status
 * @param {number} now
 */
function buildWaitingText(status, now) {
	const tick = buildCurrentTick(status);
	if (!tick?.planWait) return tick?.idle ?? "the next check";
	const { resets } = tick.planWait;
	return resets === null
		? "a plan resets, its time unread"
		: `a plan resets at ${buildClock(resets, now)}`;
}

/**
 * A no-progress pause reads "needs you", dead or alive. So
 * does a founder's pause whose process died: the housekeeping it promised has
 * stopped with it (#3875).
 * @param {NonNullable<PanelStatus["paused"]>} paused
 * @param {PanelStatus} status
 * @param {number} now
 * @returns {[Row, Row]}
 */
function buildPausedLines(paused, { running, crashed }, now) {
	if (paused.by === NO_PROGRESS_PAUSE) {
		const refs = buildIssueRefs(paused.issues ?? []);
		return [
			NEEDS_YOU,
			{ text: `No progress${refs && `: ${refs}`}`, role: "value" },
		];
	}
	if (crashed)
		return [
			NEEDS_YOU,
			{
				text: "It died while switched off · click to restart",
				role: "value",
				presses: "loop",
			},
		];
	const time = buildClock(paused.at, now);
	return [
		{
			text:
				paused.by === "founder"
					? `You switched it off at ${time}`
					: `Switched off at ${time} by ${paused.by}`,
			role: "value",
		},
		{
			text: running
				? "Switch on to carry on"
				: "Not running: switch on to start it",
			role: "secondary",
		},
	];
}

/**
 * @param {NonNullable<PanelStatus["stop"]>} stop
 * @param {number} now
 */
function buildStoppedText(stop, now) {
	const time = buildClock(stop.at, now);
	return stop.reason === "explicit"
		? `Stopped from the command line at ${time} · click to restart`
		: `Stopped at ${time}: ${stop.detail} · click to restart`;
}

/**
 * @param {PressNote|null} note
 * @param {number} now
 * @returns {note is PressNote}
 */
const isNoteShowing = (note, now) =>
	note !== null && (note.held === true || now - note.at < NOTE_SHOW_MS);

/** @param {boolean} on what a pending press asks for */
const buildTurningWord = (on) => `turning ${on ? "on" : "off"}…`;

/**
 * Line 1 and line 2 of the loop block, from the observed status alone.
 * @param {PanelStatus} status
 * @param {number} now
 * @returns {[Row, Row]}
 */
function buildObservedLines(status, now) {
	const { running, stopRequested, paused, crashed, stop } = status;
	if (stop)
		return [
			{ text: "off", role: "value" },
			{
				text: buildStoppedText(stop, now),
				role: "secondary",
				presses: "loop",
			},
		];
	if (paused) return buildPausedLines(paused, status, now);
	if (crashed)
		return [
			NEEDS_YOU,
			{
				text: "It died with no stop · click to restart",
				role: "value",
				presses: "loop",
			},
		];
	if (!running)
		return [
			{ text: "off", role: "value" },
			{
				text: "Not running: start it from the command line",
				role: "secondary",
			},
		];
	if (stopRequested)
		return [
			{ text: "off", role: "value" },
			{ text: "Stopping: sessions running finish", role: "secondary" },
		];
	return [
		{ text: `${status.launchesToday} launched today`, role: "value" },
		{
			text: `Waiting: ${buildWaitingText(status, now)}`,
			role: "secondary",
		},
	];
}

/**
 * @param {PanelStatus["overflow"]} overflow
 * @returns {Exclude<OverflowKey, {why: string}>[]}
 */
const buildReadKeys = (overflow) =>
	overflow.flatMap((key) => ("why" in key ? [] : [key]));

/** @param {PanelStatus["seats"]} seats */
const isEveryPlanFull = (seats) => seats.readings.every((s) => s.weekFull);

/**
 * What API credits hold, at all times once a key is declared (#3958). A key's unread
 * budget stops the panel calling the credits used up, and is said beside the sums,
 * which leave it out (#3875). Used up also needs every plan full: until then the
 * credits are only empty.
 * @param {PanelStatus} status
 * @returns {null | {left: number, grant: number, unread: boolean}
 *   | {usedUp: true} | {why: string}}
 */
function buildCredits({ seats, overflow }) {
	if (overflow.length === 0) return null;
	const read = buildReadKeys(overflow);
	const live = read.filter((key) => !key.noLaunchLeft);
	const unread = overflow.find((key) => "why" in key);
	if (live.length === 0 && unread && "why" in unread)
		return { why: unread.why };
	if (live.length === 0 && isEveryPlanFull(seats)) return { usedUp: true };
	return {
		/* Running runs' reservations can pass a key's grant. */
		left: live.reduce((sum, key) => sum + Math.max(key.headroomUsd, 0), 0),
		grant: read.reduce((sum, key) => sum + key.grantUsd, 0),
		unread: read.length < overflow.length,
	};
}

/**
 * Why no launch is on credits, every key having read.
 * @param {PanelStatus} status
 * @param {boolean} picksKey
 */
function buildNotSpendingReason(status, picksKey) {
	const { seats } = status;
	if (!isLaunching(status)) return "the loop is off";
	if (picksKey) return "nothing launching";
	if (seats.next) return "plans have room";
	return isEveryPlanFull(seats) ? "no credits left" : "waiting on a plan";
}

/**
 * Whether credits are spending (#3958): a session on a key is running, or the seat the
 * picker takes next is a key and the last tick launched rather than idled. Residual:
 * between such a tick's launch and the next status read, this says spending before
 * that session has spent. An unread key
 * could hold running sessions, so it never reads as not spending.
 * @param {PanelStatus} status
 * @returns {{spending: boolean, text: string}}
 */
function buildSpendState(status) {
	const { seats, overflow } = status;
	const running = buildReadKeys(overflow).reduce(
		(sum, key) => sum + key.running,
		0,
	);
	if (running > 0)
		return { spending: true, text: `Spending now: ${running} on credits` };
	const picksKey = overflow.some((key) => key.seat === seats.next?.seat);
	if (isLaunching(status) && picksKey && status.lastTick?.idle === null)
		return { spending: true, text: "Spending now: plans are full" };
	if (overflow.some((key) => "why" in key))
		return { spending: false, text: "Spending unknown: a key is unread" };
	return {
		spending: false,
		text: `Not spending: ${buildNotSpendingReason(status, picksKey)}`,
	};
}

/**
 * A figure the picker would not trust reads unread, with its last value and age, so
 * an old read cannot look current (#3958).
 * @param {PanelStatus["seats"]["readings"][number]} reading
 * @param {number} now
 */
function buildPlanFigure({ week, weekRead }, now) {
	if (weekRead.fresh) return `${week}% used`;
	if (weekRead.percent === null) return "unread";
	const age =
		weekRead.at === null
			? ""
			: `, ${describeAge(Math.max(0, (now - Date.parse(weekRead.at)) / 1000))} ago`;
	return `unread (${weekRead.percent}%${age})`;
}

/**
 * The seats are named since their order follows the last typed seat.
 * @param {PanelStatus} status
 * @param {number} now
 * @returns {Row[]}
 */
function buildPlanRows({ seats }, now) {
	if (seats.readings.length === 0) return [];
	return [
		SIBLING_GAP,
		{ text: "Weekly plan usage", role: "secondary" },
		...seats.readings.map((reading) => ({
			text: `  ${reading.seat.replace("~/", "")}  ${buildPlanFigure(reading, now)}`,
			role: /** @type {Role} */ ("secondary"),
		})),
	];
}

/**
 * @param {PanelStatus} status
 * @returns {Row[]}
 */
function buildCreditRows(status) {
	const credits = buildCredits(status);
	if (!credits) return [];
	const { spending, text } = buildSpendState(status);
	/** @type {Role} */
	const role = spending ? "value" : "secondary";
	/** @type {Row} */
	let balance;
	if ("left" in credits)
		balance = {
			text: `API credits  $${Math.floor(credits.left)} of $${Math.floor(credits.grant)} left${credits.unread ? ", a key unread" : ""}`,
			role,
		};
	else if ("usedUp" in credits)
		balance = { text: "Plans and API credits all used up", role: "value" };
	else
		balance = { text: `API credits unread: ${credits.why}`, role: "secondary" };
	return [SIBLING_GAP, balance, { text: `  ${text}`, role }];
}

/**
 * @param {PanelView} view
 * @param {number} now
 * @returns {Row[]}
 */
function buildLoopBlock({ status, readError, pending, refusal }, now) {
	const usage = status
		? [...buildPlanRows(status, now), ...buildCreditRows(status)]
		: [];
	if (pending)
		return [
			{
				text: buildTurningWord(pending.on),
				role: "value",
			},
			{
				text: pending.on ? "" : "Turning off when this check ends",
				role: "secondary",
			},
			...usage,
		];
	if (!status)
		return [
			{
				text: readError ? "Status unreadable" : "Reading the loop…",
				role: "value",
			},
			{ text: readError ?? "", role: "secondary" },
		];
	const [first, second] = buildObservedLines(status, now);
	return [
		first,
		isNoteShowing(refusal, now)
			? { text: refusal.text, role: "value" }
			: second,
		...usage,
	];
}

/** @param {PanelStatus} status */
const isLaunching = ({ running, stopRequested, paused }) =>
	running && !stopRequested && !paused;

/**
 * The switch's state: on only while the loop runs and launches, and neither word
 * while a press is pending or the status unread.
 * @param {PanelView} view
 * @returns {"on"|"off"|"pending"|"unknown"}
 */
function buildSwitchState({ status, pending }) {
	if (pending) return "pending";
	if (!status) return "unknown";
	return isLaunching(status) ? "on" : "off";
}

/**
 * The Burn mode switch's state, off the machine as well as this panel's own flip,
 * so a second panel or a restarted one reads a half-flip too.
 * @param {PanelView} view
 * @returns {SwitchState}
 */
function buildBurnState({ status, burnPending, burnReport }) {
	if (burnPending) return "pending";
	if (burnReport && burnReport.code !== 0) return "failed";
	if (!status || status.burnMode.on === null) return "unknown";
	if (status.burnMode.disagreeing.length > 0) return "failed";
	return status.burnMode.on ? "on" : "off";
}

/** @type {Record<SwitchState, string>} */
const SWITCH_TEXT = {
	on: "[on]",
	off: "[off]",
	pending: "[…]",
	unknown: "[?]",
	failed: "[!]",
};

/* ✓ alone: ✔ and ☑ render as colour emoji in Windows Terminal (#3596). */
/** @type {Record<BoxState, string>} */
const BOX_TEXT = {
	ticked: "[✓]",
	unticked: "[ ]",
	pending: "[…]",
	disabled: "[-]",
};

/**
 * The Away switch's state and the words beside it.
 * @param {PanelView} view
 * @returns {{state: "on"|"off"|"pending"|"unknown", words: string}}
 */
function buildAwayState({ status, awayPending }) {
	if (awayPending)
		return {
			state: "pending",
			words: buildTurningWord(awayPending.on),
		};
	if (!status?.mode) return { state: "unknown", words: "" };
	if (status.mode !== "away") return { state: "off", words: AWAY_OFF_WORD };
	const count = status.handedOffSinceAway;
	return { state: "on", words: count > 0 ? `${count} handed off` : "" };
}

/**
 * The Away row, then its sibling row, which holds what its command said, or why
 * a click does nothing, and is otherwise blank, so nothing below moves.
 * @param {PanelView} view
 * @param {number} now
 * @returns {[Row, Row]}
 */
function buildAwayRows(view, now) {
	const { state, words } = buildAwayState(view);
	const { status, awayNote } = view;
	return [
		{
			text: `Away  ${SWITCH_TEXT[state]}${words && `  ${words}`}`,
			role: "name",
			control: { id: "away", state },
		},
		isNoteShowing(awayNote, now)
			? { text: awayNote.text, role: "value" }
			: {
					text: status && !status.mode ? NO_CONTROL_TEXT : "",
					role: "secondary",
				},
	];
}

/**
 * What the machine says beneath the switch: why it cannot be read, or the plans
 * out of step with it.
 * @param {PanelStatus["burnMode"]|undefined} burnMode
 * @returns {Row[]}
 */
function buildBurnMachineRows(burnMode) {
	if (burnMode?.error) return [{ text: burnMode.error, role: "secondary" }];
	if (!burnMode?.disagreeing.length) return [];
	const words = burnMode.on ? "Not at the burn effort" : "At the burn effort";
	return [
		{ text: `${words}: ${burnMode.disagreeing.join(", ")}`, role: "value" },
	];
}

/**
 * @param {BurnReport} report
 * @returns {Row[]}
 */
function buildBurnReportRows({ on, code, lines }) {
	if (code === 0 && lines.length === 0)
		return [{ text: BURN_RESTART_NOTE, role: "secondary" }];
	return [
		{
			text: `burn-mode.sh ${on ? "on" : "off"}: exit ${code}`,
			role: "value",
		},
		...lines.map((text) => ({
			text,
			role: /** @type {Role} */ ("secondary"),
		})),
	];
}

/**
 * @param {PanelView} view
 * @returns {Row[]}
 */
function buildBurnRows(view) {
	const state = buildBurnState(view);
	const { status, burnPending, burnReport } = view;
	const word = burnPending ? `  ${buildTurningWord(burnPending.on)}` : "";
	const press = buildBurnPress(view);
	/** @type {Row[]} */
	const below = [
		...buildBurnMachineRows(status?.burnMode),
		...(burnReport ? buildBurnReportRows(burnReport) : []),
		...(state === "failed" && press
			? [
					{
						text: `Click runs burn-mode.sh ${press.on ? "on" : "off"}`,
						role: /** @type {Role} */ ("secondary"),
					},
				]
			: []),
	];
	return [
		{
			text: `Burn mode  ${SWITCH_TEXT[state]}${word}`,
			role: "name",
			control: { id: "burn", state },
		},
		...(below.length > 0 ? [SIBLING_GAP, ...below] : []),
	];
}

/**
 * @param {PanelView} view
 * @returns {SwitchState}
 */
function buildGoalState({ status, goalPending }) {
	if (goalPending) return "pending";
	if (!status) return "unknown";
	return status.goal ? "on" : "off";
}

/**
 * The field shows what the last read showed until a read shows otherwise.
 * @param {PanelView} view
 * @param {number} now
 * @returns {Row}
 */
function buildGoalField({ status, goalEdit, goalResolve }, now) {
	/** @type {Row["control"]} */
	const control = { id: "goalField" };
	if (goalEdit)
		return {
			text: goalEdit.text,
			role: "value",
			caret: goalEdit.caret,
			control,
		};
	if (goalResolve)
		return {
			text: goalResolve.found
				? goalResolve.text
				: `resolving "${goalResolve.text}"…`,
			role: "value",
			control,
		};
	const goal = status?.goal;
	if (!goal)
		return {
			text: status ? "No goal: running bare" : "",
			role: "secondary",
			control,
		};
	const progress = buildProgressText(goal, (at) => buildClock(at, now));
	return { text: `${goal.text}${progress}`, role: "value", control };
}

/**
 * What a goal press left, in the caption's two rows: the reason, then what to do
 * about it, so a narrow pane cutting the reason still shows the box to tick.
 * @param {string} text
 * @returns {Row[]}
 */
function buildGoalNoteRows(text) {
	const bare = text.replace(REFILL_LOOP_PREFIX, "");
	const at = bare.search(/[:;] /);
	const [reason, remedy] =
		at === -1 ? [bare, ""] : [bare.slice(0, at), bare.slice(at + 2)];
	return [
		{ text: reason, role: "value" },
		{ text: remedy, role: "value" },
	];
}

/** @type {Row} */
const GOAL_CANCEL_ROW = {
	text: "Cancel · Esc",
	role: "value",
	control: { id: "goalCancel" },
};

/**
 * The caption's two rows, press rows while a topic is in hand. The first stays blank
 * while it resolves, so a click there cannot meet Save arriving (#3596 story 62).
 * @param {TopicSet|null} found
 * @returns {Row[]}
 */
function buildTopicPressRows(found) {
	if (!found) return [SIBLING_GAP, GOAL_CANCEL_ROW];
	const { length } = found.issues;
	return [
		{
			text: `Save ${length === 1 ? "this one" : `these ${length}`} · Enter`,
			role: "value",
			control: { id: "goalSave" },
		},
		GOAL_CANCEL_ROW,
	];
}

/**
 * Stands in the Repos section's place until the confirm or cancel: a click aimed at
 * a box as the set arrives lands on a row that presses nothing, and the boxes the set
 * came from cannot change under it.
 * @param {TopicSet} found
 * @returns {Row[]}
 */
function buildTopicSetRows({ issues, dropped }) {
	const spans = new Set(issues.map((i) => i.repo)).size > 1;
	return [
		...(dropped > 0
			? [
					{
						text: `${dropped} dropped: not open in a ticked repo`,
						role: /** @type {Role} */ ("secondary"),
					},
				]
			: []),
		...issues.map(({ repo, number, title }) => ({
			text: `${spans ? repo : ""}#${number}`,
			detail: title,
			role: /** @type {Role} */ ("value"),
		})),
	];
}

/**
 * @param {string[]} lines
 * @returns {Row[]}
 */
const buildCaptionRows = (lines) =>
	lines.map((text) => ({ text, role: "secondary" }));

/**
 * @param {PanelView} view
 * @param {number} now
 * @returns {Row[]}
 */
function buildUnderGoalRows({ goalResolve, goalNote }, now) {
	if (goalResolve) return buildTopicPressRows(goalResolve.found);
	return isNoteShowing(goalNote, now)
		? buildGoalNoteRows(goalNote.text)
		: buildCaptionRows(GOAL_CAPTION);
}

/**
 * @param {PanelView} view
 * @param {number} now
 * @returns {Row[]}
 */
function buildGoalRows(view, now) {
	const state = buildGoalState(view);
	const { goalPending } = view;
	const word = goalPending
		? `  ${goalPending.on ? "setting…" : buildTurningWord(false)}`
		: "";
	return [
		{
			text: `Goal  ${SWITCH_TEXT[state]}${word}`,
			role: "name",
			control: { id: "goal", state },
		},
		SIBLING_GAP,
		buildGoalField(view, now),
		...buildUnderGoalRows(view, now),
	];
}

/**
 * A disabled box is off whatever the control holds: the loop never serves an
 * opted-out tick.
 * @param {PanelStatus["repos"][number]} repo
 * @param {Pending|undefined} pending
 * @returns {Row[]}
 */
function buildRepoRows({ name, ticked, disabled }, pending) {
	if (disabled)
		return [
			{
				text: `${BOX_TEXT.disabled} ${name}`,
				role: "secondary",
				control: { id: "repo", name, state: "disabled" },
			},
			{ text: disabled, role: "secondary" },
		];
	if (pending)
		return [
			{
				text: `${BOX_TEXT.pending} ${name}  ${buildTurningWord(pending.on)}`,
				role: "value",
				control: { id: "repo", name, state: "pending" },
			},
		];
	const state = ticked ? "ticked" : "unticked";
	return [
		{
			text: `${BOX_TEXT[state]} ${name}`,
			role: ticked ? "value" : "secondary",
			control: { id: "repo", name, state },
		},
	];
}

/**
 * The Repos section, the count off what the loop reads, never a pending press. A
 * refusal takes the gap below its box, so no box moves when it goes.
 * @param {PanelView} view
 * @param {number} now
 * @returns {Row[]}
 */
function buildReposRows({ status, repoPending, repoRefusal }, now) {
	if (!status) return [];
	const { repos } = status;
	const onCount = repos.filter((r) => r.ticked && !r.disabled).length;
	const refused = isNoteShowing(repoRefusal, now) ? repoRefusal : null;
	return [
		{ text: "Repos", detail: `${onCount} of ${repos.length} on`, role: "name" },
		SIBLING_GAP,
		...repos.flatMap((repo) => [
			...buildRepoRows(repo, repoPending[repo.name]),
			refused?.name === repo.name
				? { text: refused.text, role: /** @type {Role} */ ("value") }
				: SIBLING_GAP,
		]),
		...REPOS_NOTE.map((text) => ({
			text,
			role: /** @type {Role} */ ("secondary"),
		})),
	];
}

/** @param {PanelView} view */
const isFieldOpen = ({ goalEdit, goalResolve }) =>
	goalEdit !== null || goalResolve !== null;

/**
 * The name the pointer holds a row's control by, which outlasts the row moving; null
 * for a row it skips, a disabled box pressing nothing.
 * @param {Row} row
 * @returns {string|null}
 */
function buildPointerKey({ control }) {
	if (!control) return null;
	if (control.id !== "repo") return control.id;
	return control.state === "disabled" ? null : `repo:${control.name}`;
}

/** @param {Row[]} rows */
const buildPointerKeys = (rows) =>
	rows.map(buildPointerKey).filter((key) => key !== null);

/**
 * @param {PanelView} view
 * @param {number} now
 * @returns {Row[]}
 */
function buildRows(view, now) {
	const rows = buildUnpointedRows(view, now);
	return view.pointer === null || isFieldOpen(view)
		? rows
		: rows.map((row) =>
				buildPointerKey(row) === view.pointer ? { ...row, pointed: true } : row,
			);
}

/**
 * The key hint goes while a field or topic is open, as the arrows then do not move.
 * @param {PanelView} view
 * @param {number} now
 * @returns {Row[]}
 */
function buildUnpointedRows(view, now) {
	const state = buildSwitchState(view);
	return [
		{
			text: `Refill loop  ${SWITCH_TEXT[state]}`,
			role: "name",
			control: { id: "loop", state },
		},
		SIBLING_GAP,
		...buildLoopBlock(view, now),
		...SECTION_GAP,
		...buildAwayRows(view, now),
		...buildBurnRows(view),
		...SECTION_GAP,
		...buildGoalRows(view, now),
		...SECTION_GAP,
		...(view.goalResolve?.found
			? buildTopicSetRows(view.goalResolve.found)
			: buildReposRows(view, now)),
		...(isFieldOpen(view)
			? []
			: [
					SIBLING_GAP,
					...(view.focusNote
						? [
								{
									text: `Focus stayed here: ${view.focusNote}`,
									role: /** @type {Role} */ ("value"),
								},
							]
						: []),
					...buildCaptionRows(KEY_HINT),
				]),
	];
}

/**
 * What a press on the switch does: the argv to run and what it asks for, or
 * null where the press does nothing. A dead loop restarts from its stored
 * settings. No press ever stops the process.
 * @param {PanelView} view
 */
function buildPress({ status, pending }) {
	if (pending || !status) return null;
	if (status.paused) return { argv: ["set", "--resume"], on: true };
	if (isLaunching(status)) return { argv: ["set", "--pause"], on: false };
	if (!status.running && (status.crashed || status.stop))
		return { argv: ["set", "--resume"], on: true };
	return null;
}

/**
 * What a press on the Away switch does, or null where it does nothing: the
 * opposite of what the last read showed, the loop stopped or paused included
 * (#3879, story 41).
 * @param {PanelView} view
 */
function buildAwayPress({ status, awayPending }) {
	if (awayPending || !status?.mode) return null;
	return status.mode === "away"
		? { argv: ["set", "--normal"], on: false }
		: { argv: ["set", "--away"], on: true };
}

/**
 * What a press on the Burn mode switch asks for, or null where it does nothing:
 * the opposite of the marker, half-flip or not. The script keeps the marker
 * through a failed flip, so a half-flip reads on and this runs `off`, which
 * restores from the record (#3877).
 * @param {PanelView} view
 */
function buildBurnPress({ status, burnPending }) {
	if (burnPending || !status || status.burnMode.on === null) return null;
	return { on: !status.burnMode.on };
}

/**
 * `edit` after a key that stays in the field.
 * @param {GoalEdit} edit
 * @param {Key} key
 * @returns {GoalEdit}
 */
function buildEditAfter({ text, caret }, key) {
	const chars = [...text];
	const before = chars.slice(0, caret);
	const after = chars.slice(caret);
	/**
	 * @param {string[]} head
	 * @param {string[]} tail
	 */
	const buildEdited = (head, tail) => ({
		text: [...head, ...tail].join(""),
		caret: head.length,
	});
	if ("text" in key) return buildEdited([...before, ...key.text], after);
	if (key.name === "backspace") return buildEdited(before.slice(0, -1), after);
	if (key.name === "delete") return buildEdited(before, after.slice(1));
	if (key.name === "left") return { text, caret: Math.max(caret - 1, 0) };
	if (key.name === "right")
		return { text, caret: Math.min(caret + 1, chars.length) };
	if (key.name === "home") return { text, caret: 0 };
	if (key.name === "end") return { text, caret: chars.length };
	return { text, caret };
}

/**
 * What a press on a repo's box asks for, or null.
 * @param {PanelView} view
 * @param {string} name
 */
function buildRepoPress({ status, repoPending }, name) {
	const repo = status?.repos.find((r) => r.name === name);
	if (!repo || repo.disabled || repoPending[name]) return null;
	const on = !repo.ticked;
	return { on, argv: ["set", on ? "--tick" : "--untick", name] };
}

/**
 * @param {boolean} on what the flip asked for
 * @param {RunResult} result
 * @returns {BurnReport}
 */
function buildBurnReport(on, { code, stdout, stderr }) {
	const lines =
		code === 0 && !stderr.trim()
			? []
			: `${stderr}\n${stdout}`
					.split("\n")
					.map((l) => l.trimEnd())
					.filter(Boolean);
	return { on, code, lines };
}

/**
 * Whether a read shows a failed flip since finished, by another panel or the
 * skill: the marker where it asked, and every plan in step.
 * @param {BurnReport} report
 * @param {PanelStatus} status
 */
const isBurnReportOutlived = ({ on, code }, { burnMode }) =>
	code !== 0 && burnMode.on === on && burnMode.disagreeing.length === 0;

/**
 * Whether a status read clears a pending press. Only a read begun after the
 * command landed can: one begun before shows the world before the press. A pause
 * is taken once a tick has started since it, or at once with no process to take
 * it, since a tick already running finishes first. `set` touches the wake, so
 * that tick follows within seconds of the running one ending. Any other read
 * shows the change, or another writer's reversal of it. A resume's `set` returns
 * once it has spawned any process, ahead of the pidfile, so it waits for a read
 * showing one, for a while.
 * @param {Pending} pending
 * @param {PanelStatus} status
 * @param {boolean} readAfterLanding
 * @param {number} now
 */
function isPressSettled(pending, status, readAfterLanding, now) {
	if (!readAfterLanding) return false;
	const { paused, running, lastTick } = status;
	if (pending.on)
		return running || now - (pending.landedAt ?? now) >= RESUME_SHOW_MS;
	if (!paused) return true;
	return !running || (lastTick?.at ?? 0) >= paused.at;
}

/**
 * @param {string} stdout
 * @returns {PanelStatus|string} the status, or why it will not read
 */
function parseStatus(stdout) {
	try {
		const parsed = JSON.parse(stdout);
		return typeof parsed?.running === "boolean"
			? parsed
			: "status --json has no running field";
	} catch (err) {
		return `status --json: ${caught(err).message}`;
	}
}

/**
 * @typedef {{code: number, stdout: string, stderr: string}} RunResult
 * @typedef {(argv: string[]) => Promise<RunResult>} Runner runs one script with
 *   `argv`; a command that cannot start resolves as a failure
 * @typedef {(text: string, repos: import("./refill-panel-topic.js").TickedRepo[],
 *   signal: AbortSignal) => Promise<import("./refill-panel-topic.js").TopicResult>} TopicResolver
 */

/**
 * What a press's command warns of on exit 0: that a loop with no process has not
 * taken the change in full.
 * @param {string} stdout
 */
const buildNotRunningText = (stdout) =>
	stdout.split("\n").find((l) => l.startsWith(NOT_RUNNING_PREFIX)) ?? null;

/** @param {RunResult} result */
const buildFailureText = ({ code, stderr }) =>
	stderr
		.split("\n")
		.map((l) => l.trim())
		.find(Boolean) ?? `exit ${code}`;

/**
 * The panel's state over an injected runner. Reads never overlap: one asked for
 * during another runs after it, so a press's read starts after its command.
 * @param {{run: Runner, runBurn: Runner, now: () => number,
 *   resolveTopic: TopicResolver, returnFocus: FocusReturner, height: () => number,
 *   onChange: () => void}} deps `run`, `refill-loop.js`; `runBurn`, `burn-mode.sh`;
 *   `returnFocus`, hands focus to the agents pane; `height`, the terminal's rows
 */
function createPanel({
	run,
	runBurn,
	now,
	resolveTopic,
	returnFocus,
	height,
	onChange,
}) {
	/** @type {PanelView} */
	const view = {
		status: null,
		readError: null,
		pending: null,
		refusal: null,
		awayPending: null,
		awayNote: null,
		burnPending: null,
		burnReport: null,
		goalEdit: null,
		goalResolve: null,
		goalPending: null,
		goalNote: null,
		repoPending: {},
		repoRefusal: null,
		pointer: null,
		focusNote: null,
		scroll: 0,
	};
	/* Off a focus report, so never set on a terminal that sends none. */
	let focusGone = false;
	let returning = false;
	let reading = false;
	let readAgain = false;
	/** @type {AbortController|null} */
	let resolveAbort = null;

	/**
	 * @param {PanelStatus|string} parsed the status, or why it will not read
	 * @param {{press: boolean, away: boolean, flip: boolean, goal: boolean, repos: string[]}} landedBefore which
	 *   pending marks' commands had exited when this read began
	 */
	function takeRead(parsed, landedBefore) {
		if (typeof parsed === "string") {
			view.status = null;
			view.readError = parsed;
			return;
		}
		view.status = parsed;
		view.readError = null;
		if (
			view.pending &&
			isPressSettled(view.pending, parsed, landedBefore.press, now())
		)
			view.pending = null;
		for (const [landed, slot] of /** @type {const} */ ([
			[landedBefore.away, "awayPending"],
			[landedBefore.flip, "burnPending"],
			[landedBefore.goal, "goalPending"],
		]))
			if (landed) view[slot] = null;
		for (const name of landedBefore.repos) delete view.repoPending[name];
		if (view.burnReport && isBurnReportOutlived(view.burnReport, parsed))
			view.burnReport = null;
	}

	async function refreshStatus() {
		if (reading) {
			readAgain = true;
			return;
		}
		reading = true;
		const landedBefore = {
			press: view.pending?.landed === true,
			away: view.awayPending?.landed === true,
			flip: view.burnPending?.landed === true,
			goal: view.goalPending?.landed === true,
			repos: Object.entries(view.repoPending)
				.filter(([, mark]) => mark.landed)
				.map(([name]) => name),
		};
		const result = await run(["status", "--json"]);
		reading = false;
		takeRead(
			result.code === 0 ? parseStatus(result.stdout) : buildFailureText(result),
			landedBefore,
		);
		onChange();
		if (readAgain) {
			readAgain = false;
			await refreshStatus();
		}
	}

	async function pressBurn() {
		const press = buildBurnPress(view);
		if (!press) return;
		const pending = { on: press.on, landed: false };
		view.burnPending = pending;
		view.burnReport = null;
		onChange();
		const result = await runBurn([press.on ? "on" : "off"]);
		if (result.code === 0) pending.landed = true;
		else view.burnPending = null;
		view.burnReport = buildBurnReport(press.on, result);
		onChange();
		await refreshStatus();
	}

	/**
	 * @param {string[]} argv
	 * @param {Pending} pending
	 * @param {(text: string) => void} takeNote holds the words a press leaves
	 * @param {() => void} unmark
	 */
	async function runPress(argv, pending, takeNote, unmark) {
		onChange();
		const result = await run(argv);
		if (result.code === 0) {
			pending.landed = true;
			pending.landedAt = now();
			const warning = buildNotRunningText(result.stdout);
			if (warning) takeNote(warning);
		} else {
			unmark();
			takeNote(buildFailureText(result));
		}
		onChange();
		await refreshStatus();
	}

	/**
	 * @param {{argv: string[], on: boolean}|null} press
	 * @param {"pending"|"awayPending"|"goalPending"} pendingSlot
	 * @param {"refusal"|"awayNote"|"goalNote"} noteSlot
	 */
	async function runLoopPress(press, pendingSlot, noteSlot) {
		if (!press) return;
		/** @type {Pending} */
		const pending = { on: press.on, landed: false };
		view[pendingSlot] = pending;
		view[noteSlot] = null;
		await runPress(
			press.argv,
			pending,
			(text) => {
				view[noteSlot] = { text, at: now() };
			},
			() => {
				view[pendingSlot] = null;
			},
		);
	}

	/** @param {string} name */
	async function pressRepo(name) {
		const press = buildRepoPress(view, name);
		if (!press) return;
		const pending = { on: press.on, landed: false };
		view.repoPending[name] = pending;
		view.repoRefusal = null;
		if (view.goalNote?.held) view.goalNote = null;
		await runPress(
			press.argv,
			pending,
			(text) => {
				view.repoRefusal = { name, text, at: now() };
			},
			() => {
				delete view.repoPending[name];
			},
		);
	}

	function cancelResolve() {
		resolveAbort?.abort();
		resolveAbort = null;
		view.goalResolve = null;
		onChange();
	}

	/** From the topic in hand where there is one, so a poor set is a small edit. */
	function beginGoalEdit() {
		if (!view.status || view.goalPending) return;
		const text = view.goalResolve?.text ?? view.status.goal?.text ?? "";
		cancelResolve();
		view.goalEdit = { text, caret: [...text].length };
		view.goalNote = null;
		onChange();
	}

	/**
	 * The switch clears a goal; with none, it opens the field for one, unless this
	 * click just closed it.
	 * @param {boolean} closedEdit
	 */
	async function pressGoalSwitch(closedEdit) {
		if (view.goalPending) return;
		if (view.goalResolve) cancelResolve();
		else if (view.status?.goal)
			await runLoopPress(
				{ argv: ["set", "--clear-goal"], on: false },
				"goalPending",
				"goalNote",
			);
		else if (!closedEdit) beginGoalEdit();
	}

	/**
	 * A fixed form goes to `--goal` as one argument, however it is typed; anything
	 * else is a topic, stored only on the confirm press (#3596 stories 62, 65). A
	 * blank field closes, the switch being what clears a goal (story 53).
	 * @param {GoalEdit} edit
	 */
	async function saveGoal({ text }) {
		view.goalEdit = null;
		const typed = text.trim();
		if (typed === "") {
			onChange();
			return;
		}
		if (parseGoalForm(typed) === null) await resolveGoal(typed);
		else
			await runLoopPress(
				{ argv: ["set", `--goal=${typed}`], on: true },
				"goalPending",
				"goalNote",
			);
	}

	/**
	 * A failure leaves the old goal, and a result arriving after a cancel is nobody's.
	 * @param {string} text
	 */
	async function resolveGoal(text) {
		if (!view.status) {
			takeResolveFailure(view.readError ?? "the loop's status is unread");
			onChange();
			return;
		}
		const repos = view.status.repos.filter(
			(repo) => repo.ticked && !repo.disabled,
		);
		/** @type {GoalResolve} */
		const request = { text, found: null };
		const abort = new AbortController();
		resolveAbort = abort;
		view.goalResolve = request;
		view.goalNote = null;
		onChange();
		const result = await resolveTopic(text, repos, abort.signal);
		if (view.goalResolve !== request) return;
		resolveAbort = null;
		if ("why" in result) {
			view.goalResolve = null;
			takeResolveFailure(result.why);
			await leaveUnlessOpen();
			return;
		}
		request.found = result;
		const rows = buildRows(view, now());
		revealRow(rows, rows.findIndex(isSaveRow));
		onChange();
	}

	/** @param {string} why */
	function takeResolveFailure(why) {
		view.goalNote = {
			text: `Topic not resolved: ${why}`,
			at: now(),
			held: true,
		};
	}

	/**
	 * Each ref carries its repo and the text one argument, so `set` reads them as
	 * typed. It stays as resolved until the next resolve (#3596 story 64).
	 */
	async function saveTopic() {
		const resolved = view.goalResolve;
		if (!resolved?.found) return;
		view.goalResolve = null;
		const refs = resolved.found.issues.map((i) => `${i.repo}#${i.number}`);
		await runLoopPress(
			{
				argv: [
					"set",
					`--goal-issues=${refs.join(",")}`,
					`--goal-text=${resolved.text}`,
				],
				on: true,
			},
			"goalPending",
			"goalNote",
		);
	}

	/**
	 * Skipped where the founder has already gone: a resolve can
	 * fail long after its Enter, and `move-focus` counts from wherever focus now is, as
	 * it does for a second return while the first runs. A return that fails leaves the
	 * pointer showing, as the keys here still work (#3887).
	 */
	async function leave() {
		view.pointer = null;
		view.focusNote = null;
		onChange();
		if (focusGone || returning) return;
		returning = true;
		const result = await returnFocus();
		returning = false;
		if (result.code === 0) return;
		view.focusNote = buildFailureText(result);
		showPointer();
		onChange();
	}

	/** After a key, focus stays while a field or topic waits on its Enter or Esc. */
	async function leaveUnlessOpen() {
		if (!isFieldOpen(view)) await leave();
	}

	/**
	 * After a click, focus stays only for typing: a topic waiting on its press does not
	 * hold it, as Save and Cancel are rows to click (#3596 stories 72, 73).
	 */
	async function leaveUnlessTyping() {
		if (!view.goalEdit) await leave();
	}

	/**
	 * Leaves as the press starts, not when its command ends, as the next keystroke will
	 * not wait for it; a press's refusal therefore draws after focus has gone (#3887). A
	 * press opens or closes a field before its first await.
	 * @param {() => Promise<void>} press
	 * @param {() => Promise<void>} leaveAfter
	 */
	async function pressThenLeave(press, leaveAfter) {
		await Promise.all([press(), leaveAfter()]);
	}

	/** @param {Key} key */
	async function pressTopicKey(key) {
		if (!("name" in key)) return;
		if (key.name === "enter" && !bringIntoView(isSaveRow))
			await pressThenLeave(saveTopic, leaveUnlessOpen);
		if (key.name === "escape") {
			cancelResolve();
			await leaveUnlessOpen();
		}
	}

	/**
	 * @param {GoalEdit} edit
	 * @param {Key} key
	 */
	async function pressEditKey(edit, key) {
		if ("name" in key && key.name === "enter") {
			if (bringIntoView((row) => row.caret !== undefined)) return;
			await pressThenLeave(() => saveGoal(edit), leaveUnlessOpen);
			return;
		}
		if ("name" in key && key.name === "escape") {
			view.goalEdit = null;
			await leaveUnlessOpen();
			return;
		}
		view.goalEdit = buildEditAfter(edit, key);
		const rows = buildRows(view, now());
		revealRow(
			rows,
			rows.findIndex((row) => row.caret !== undefined),
		);
		onChange();
	}

	/**
	 * @param {Row[]} rows
	 * @param {number} index
	 */
	function isRowDrawn(rows, index) {
		const { first, count } = buildWindow(rows.length, height(), view.scroll);
		return index >= first && index < first + count;
	}

	/**
	 * Moves the window only as far as the row needs, leaving it clear of the mark
	 * below, where an image would not draw; no row found leaves it.
	 * @param {Row[]} rows
	 * @param {number} index
	 */
	function revealRow(rows, index) {
		if (index < 0 || isRowDrawn(rows, index)) return;
		const { first } = buildWindow(rows.length, height(), view.scroll);
		view.scroll =
			index < first
				? index
				: index - Math.max(countDrawnRows(height()) - 1, 1) + 1;
	}

	/**
	 * A key that would act on a row out of sight brings it back instead.
	 * @param {(row: Row) => boolean} isWanted
	 * @returns {boolean} whether the row had to come back
	 */
	function bringIntoView(isWanted) {
		const rows = buildRows(view, now());
		const at = rows.findIndex(isWanted);
		if (at < 0 || isRowDrawn(rows, at)) return false;
		revealRow(rows, at);
		onChange();
		return true;
	}

	/** @param {number} delta rows, negative is up, stopping at either end */
	function scrollRows(delta) {
		const count = buildRows(view, now()).length;
		const { first } = buildWindow(count, height(), view.scroll);
		const next = buildWindow(count, height(), first + delta).first;
		if (next === first) return;
		view.scroll = next;
		onChange();
	}

	/** @param {number} notches negative is up */
	const scrollBy = (notches) => scrollRows(notches * WHEEL_ROWS);

	/** The first control showing, which leaves the rows where the reader has them. */
	function buildFirstPointerKey() {
		const rows = buildRows(view, now());
		const { first, count } = buildWindow(rows.length, height(), view.scroll);
		const showing = rows.slice(first, first + count);
		return buildPointerKeys(showing)[0] ?? buildPointerKeys(rows)[0] ?? null;
	}

	/** Where a terminal reports no focus, the first arrow is what shows the pointer. */
	function showPointer() {
		if (view.pointer !== null) return;
		view.pointer = buildFirstPointerKey();
		onChange();
	}

	function takeFocus() {
		focusGone = false;
		showPointer();
	}

	function loseFocus() {
		focusGone = true;
		if (view.pointer === null) return;
		view.pointer = null;
		onChange();
	}

	/** @param {-1|1} step stops at either end */
	function movePointer(step) {
		if (view.pointer === null) view.pointer = buildFirstPointerKey();
		else {
			const keys = buildPointerKeys(buildRows(view, now()));
			const at = keys.indexOf(view.pointer);
			view.pointer =
				keys[Math.min(Math.max(at + step, 0), keys.length - 1)] ?? null;
		}
		const rows = buildRows(view, now());
		/* The last control takes the rows under it along, the key hint among them. */
		revealRow(
			rows,
			view.pointer === buildPointerKeys(rows).at(-1)
				? rows.length - 1
				: rows.findIndex((row) => row.pointed),
		);
		onChange();
	}

	async function pressPointedRow() {
		if (bringIntoView((row) => row.pointed === true)) return;
		await pressRow(
			buildRows(view, now()).find((row) => row.pointed),
			false,
		);
	}

	/**
	 * With no field or topic open, only the arrows, space and Esc do anything (#3596
	 * stories 74, 75). Space alone: two in one read, or one in a paste, were never a press
	 * on the pointer's control. Space on a control the wheel took off the pane brings it
	 * back rather than press it blind.
	 * @param {Key} key
	 */
	async function pressPointerKey(key) {
		if ("text" in key) {
			if (key.text === " " && !key.pasted && view.pointer !== null)
				await pressPointedRow();
			return;
		}
		if (key.name === "escape") await leaveUnlessOpen();
		if (key.name === "up") movePointer(-1);
		if (key.name === "down") movePointer(1);
	}

	/** @param {Key} key */
	async function pressKey(key) {
		if (view.goalResolve) await pressTopicKey(key);
		else if (view.goalEdit) await pressEditKey(view.goalEdit, key);
		else await pressPointerKey(key);
	}

	/**
	 * A click outside the field drops what was typed: the press itself
	 * still changes one control (#3596 story 61).
	 * @param {number} terminalRow
	 */
	async function click(terminalRow) {
		const rows = buildRows(view, now());
		const scrollWindow = buildWindow(rows.length, height(), view.scroll);
		const markStep = findMarkStep(scrollWindow, terminalRow, height());
		if (markStep !== 0) {
			scrollRows(markStep * Math.max(scrollWindow.count - 1, 1));
			await leaveUnlessTyping();
			return;
		}
		const row = findDrawnRow(rows, terminalRow, height(), view.scroll);
		const closedEdit =
			view.goalEdit !== null && row?.control?.id !== "goalField";
		if (closedEdit) {
			view.goalEdit = null;
			onChange();
		}
		await pressThenLeave(() => pressRow(row, closedEdit), leaveUnlessTyping);
	}

	/**
	 * @param {Row|undefined} row
	 * @param {boolean} closedEdit
	 */
	async function pressRow(row, closedEdit) {
		const control = row?.control;
		if (control === undefined) {
			if (row?.presses === "loop")
				await runLoopPress(buildPress(view), "pending", "refusal");
			return;
		}
		switch (control.id) {
			case "goal":
				await pressGoalSwitch(closedEdit);
				break;
			case "goalField":
				if (!view.goalEdit) beginGoalEdit();
				break;
			case "goalSave":
				await saveTopic();
				break;
			case "goalCancel":
				cancelResolve();
				break;
			case "loop":
				await runLoopPress(buildPress(view), "pending", "refusal");
				break;
			case "away":
				await runLoopPress(buildAwayPress(view), "awayPending", "awayNote");
				break;
			case "burn":
				await pressBurn();
				break;
			case "repo":
				await pressRepo(control.name);
				break;
		}
	}

	return {
		view,
		refreshStatus,
		click,
		missClick: leaveUnlessTyping,
		pressKey,
		scrollBy,
		leave,
		takeFocus,
		loseFocus,
	};
}

/** @param {number} height the terminal's rows */
const countDrawnRows = (height) => Math.max(height - TOP_ROW + 1, 0);

/**
 * The rows a pane shows, read each time as the rows can shrink, or the pane grow, under
 * a scroll. While rows lie below, the pane's last row says so, unless it is the only one.
 * @param {number} rowCount
 * @param {number} height
 * @param {number} scroll
 */
function buildWindow(rowCount, height, scroll) {
	const room = countDrawnRows(height);
	const lastFirst = Math.max(rowCount - room, 0);
	const first = Math.max(Math.min(scroll, lastFirst), 0);
	const markBelow = first < lastFirst && room > 1;
	return {
		first,
		count: markBelow ? room - 1 : room,
		markAbove: first > 0,
		markBelow,
	};
}

/**
 * Which way a click on a terminal row scrolls, where it holds a mark; 0 where it holds none.
 * @param {ReturnType<typeof buildWindow>} scrollWindow
 * @param {number} terminalRow
 * @param {number} height
 */
function findMarkStep({ markAbove, markBelow }, terminalRow, height) {
	if (markAbove && terminalRow === TOP_ROW - 1) return -1;
	return markBelow && terminalRow === height ? 1 : 0;
}

/** @param {Row} row */
const isSaveRow = (row) => row.control?.id === "goalSave";

/**
 * The row a terminal row is showing, so a press and the frame agree (#3948).
 * @param {Row[]} rows
 * @param {number} terminalRow
 * @param {number} height
 * @param {number} scroll
 * @returns {Row|undefined}
 */
function findDrawnRow(rows, terminalRow, height, scroll) {
	const { first, count } = buildWindow(rows.length, height, scroll);
	const at = terminalRow - TOP_ROW;
	if (at < 0 || at >= count) return;
	return rows[at + first];
}

/** @param {string} text a command's words, which may carry control characters */
const buildDrawableChars = (text) => [...text.replace(/\p{Cc}+/gu, " ")];

/**
 * `text` on one line of `width` cells: a row never wraps into the one below.
 * @param {string} text
 * @param {number} width
 */
function fitText(text, width) {
	const chars = buildDrawableChars(text);
	return chars.length > width
		? `${chars.slice(0, Math.max(width - 1, 0)).join("")}…`
		: chars.join("");
}

/**
 * A row's text with its control's mark blanked to the cells its image covers, and the
 * image; null where the row has no such control, or the image would pass the row's end.
 * @param {Row} row
 * @param {number} width
 * @param {boolean} hovered
 */
function buildImagedRow({ text, control }, width, hovered) {
	if (!control || !("state" in control)) return null;
	const mark =
		control.id === "repo"
			? BOX_TEXT[control.state]
			: SWITCH_TEXT[control.state];
	const { cells, sixel } = buildControlImage(control, hovered);
	const at = [...text.slice(0, text.indexOf(mark))].length;
	if (at + cells > width) return null;
	return { at, sixel, text: text.replace(mark, " ".repeat(cells)) };
}

/**
 * The row a pointer's report rests on, where that row holds an image to grow.
 * @param {Row[]} rows
 * @param {number} terminalRow
 * @param {number} height
 * @param {number} scroll
 */
const findHoverRow = (rows, terminalRow, height, scroll) => {
	const control = findDrawnRow(rows, terminalRow, height, scroll)?.control;
	return control && "state" in control ? terminalRow : null;
};

/**
 * Ends by erasing below, so a report gone from the rows goes from the screen.
 * Draws only the rows that fit, from the first the scroll shows: past the bottom a
 * terminal stacks them on its last line, where a click would press a row other than
 * the one showing. A mark says where more rows lie. The cursor
 * shows only on a row being typed in, which scrolls to keep it in view.
 *
 * Images go on last, as text and erasing wipe what lies under them. A 20 px image fills
 * four 6 px Sixel bands, so on the pane's last row it would scroll the page (#2525):
 * that row keeps its text control.
 * @param {Row[]} rows
 * @param {number} columns the terminal's width
 * @param {number} height
 * @param {{images?: boolean, hoverRow?: number|null, scroll?: number}} [options] `hoverRow`, 1-based
 */
function buildFrame(
	rows,
	columns,
	height,
	{ images = false, hoverRow = null, scroll = 0 } = {},
) {
	const width = columns - (LEFT_COLUMN - 1) * 2;
	let cursor = "";
	let placed = "";
	const { first, count, markAbove, markBelow } = buildWindow(
		rows.length,
		height,
		scroll,
	);
	/** @param {string} text @param {number} terminalRow */
	const buildMarkLine = (text, terminalRow) =>
		buildFrameLine({ text, role: "secondary" }, terminalRow, width).text;
	const above = buildMarkLine(markAbove ? MORE_ABOVE_MARK : "", TOP_ROW - 1);
	const below = markBelow ? buildMarkLine(MORE_BELOW_MARK, height) : "";
	const drawn = rows
		.slice(first, first + count)
		.map((row, i) => {
			const terminalRow = TOP_ROW + i;
			const imaged =
				images && terminalRow < height
					? buildImagedRow(row, width, terminalRow === hoverRow)
					: null;
			if (imaged)
				placed += `${ESC}[${terminalRow};${LEFT_COLUMN + imaged.at}H${imaged.sixel}`;
			const line = buildFrameLine(
				{ ...row, text: imaged?.text ?? row.text },
				terminalRow,
				width,
			);
			cursor = line.cursor || cursor;
			return line.text;
		})
		.join("");
	const frame = `${ESC}[?25l${above}${drawn}${below}${ESC}[J${placed}${cursor}`;
	return placed ? `${SYNC_ON}${frame}${SYNC_OFF}` : frame;
}

/**
 * @param {Row} row
 * @param {number} terminalRow
 * @param {number} width
 */
function buildFrameLine(
	{ text, detail, role, caret, pointed },
	terminalRow,
	width,
) {
	const { rgb, bold } = ROLE_STYLES[role];
	const start = caret === undefined ? 0 : Math.max(caret - width + 1, 0);
	const chars =
		caret === undefined
			? [...fitText(detail ? `${text}  ${detail}` : text, width)]
			: buildDrawableChars(text).slice(start, start + width);
	const textChars = [...text].length;
	return {
		cursor:
			caret === undefined
				? ""
				: `${ESC}[${terminalRow};${LEFT_COLUMN + caret - start}H${ESC}[?25h`,
		text: [
			`${ESC}[${terminalRow};1H${pointed ? POINTER_MARK : " "}`,
			`${ESC}[${terminalRow};${LEFT_COLUMN}H`,
			bold ? `${ESC}[1m` : "",
			`${ESC}[38;2;${rgb.join(";")}m`,
			chars.slice(0, textChars).join(""),
			`${ESC}[22m`,
			chars.slice(textChars).join(""),
			`${ESC}[0m${ESC}[K`,
		].join(""),
	};
}

module.exports = {
	ESC,
	buildFrame,
	findHoverRow,
	buildRows,
	createPanel,
};
