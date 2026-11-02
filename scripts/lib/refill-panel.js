/*
 * refill-panel.js — what the refill loop's panel draws and what a click does,
 * with no terminal (#3873, #3875, #3877, #3879, #3881, #3883, spec #3596): status JSON and pending presses in, rows
 * out; a click on a row in, a `refill-loop.js` or `burn-mode.sh` argv out. The
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
const { NO_PROGRESS_PAUSE } = require("./refill-decide.js");
const { buildProgressText } = require("./refill-goal.js");

const ESC = String.fromCharCode(27);
const INTERRUPT = String.fromCharCode(3);

/* Where the block starts, 1-based as a mouse report counts. Untraced: one cell
 * of margin round the prototype's layout (#2525 round 9). */
const TOP_ROW = 2;
const LEFT_COLUMN = 3;

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
 * mode; `set` refuses both, and `start` writes one. */
const NO_CONTROL_TEXT = "No loop settings to change: run `start`";

/* Two rows in every state, so nothing below the goal moves (#3596 story 55). */
const GOAL_CAPTION = ["Click to change it", "Enter to save · Esc to cancel"];

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
 *     noLaunchLeft: boolean}} OverflowKey
 * @typedef {{running: boolean, stopRequested: boolean,
 *   stop: {reason: string, at: number, detail: string}|null, crashed: boolean,
 *   paused: {by: string, at: number, issues?: PauseIssue[]}|null,
 *   lastTick: {at: number, idle: string|null,
 *     paused: boolean, planWait: {resets: number|null}|null}|null,
 *   launchesToday: number,
 *   mode: "normal"|"away"|null,
 *   handedOffSinceAway: number,
 *   repos: {name: string, ticked: boolean, disabled: string|null}[],
 *   goal: ReturnType<typeof import("./refill-goal.js").buildGoalStatus>,
 *   seats: {readings: {seat: string, week: number|null,
 *     weekFull: boolean}[]},
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

/** @typedef {{text: string, at: number}} PressNote */

/**
 * A goal being typed. `caret`, how many characters stand before it.
 * @typedef {{text: string, caret: number}} GoalEdit
 */

/**
 * A key the panel can use, with no meaning until a field is being edited.
 * @typedef {{text: string}
 *   | {name: "enter"|"escape"|"backspace"|"delete"|"left"|"right"|"home"|"end"}} Key
 */

/**
 * @typedef {{status: PanelStatus|null, readError: string|null,
 *   pending: Pending|null,
 *   refusal: PressNote|null,
 *   awayPending: Pending|null, awayNote: PressNote|null,
 *   burnPending: Pending|null, burnReport: BurnReport|null,
 *   goalEdit: GoalEdit|null, goalPending: Pending|null, goalNote: PressNote|null,
 *   repoPending: Record<string, Pending>,
 *   repoRefusal: (PressNote & {name: string})|null}} PanelView
 */

/**
 * @typedef {"on"|"off"|"pending"|"unknown"|"failed"} SwitchState
 * @typedef {"ticked"|"unticked"|"pending"|"disabled"} BoxState
 */

/**
 * `detail`, drawn after `text` in regular weight whatever the role. `caret`, where
 * the terminal's cursor stands in `text`, on the row being typed in.
 * @typedef {{text: string, role: Role, detail?: string, presses?: "loop",
 *   caret?: number,
 *   control?: {id: "loop"|"away"|"burn"|"goal", state: SwitchState}
 *     | {id: "goalField"}
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
	note !== null && now - note.at < NOTE_SHOW_MS;

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
 * What API credits hold once every plan seat's week is full: null where no key is
 * declared, so no credits show until overflow launches can run (#2611). A key's
 * unread budget stops the panel calling the credits used up, and is said beside
 * the sums, which leave it out (#3875).
 * @param {PanelStatus} status
 * @returns {null | {left: number, grant: number, unread: boolean}
 *   | {usedUp: true} | {why: string}}
 */
function buildCredits({ seats, overflow }) {
	if (overflow.length === 0 || !seats.readings.every((s) => s.weekFull))
		return null;
	const read = overflow.flatMap((key) => ("why" in key ? [] : [key]));
	const live = read.filter((key) => !key.noLaunchLeft);
	if (live.length > 0)
		return {
			/* Running runs' reservations can pass a key's grant. */
			left: live.reduce((sum, key) => sum + Math.max(key.headroomUsd, 0), 0),
			grant: read.reduce((sum, key) => sum + key.grantUsd, 0),
			unread: read.length < overflow.length,
		};
	const unread = overflow.find((key) => "why" in key);
	return unread && "why" in unread ? { why: unread.why } : { usedUp: true };
}

/**
 * The seats are named since their order follows the last typed seat.
 * @param {PanelStatus} status
 * @returns {Row}
 */
function buildSpendRow(status) {
	const credits = buildCredits(status);
	if (credits && "left" in credits)
		return {
			text: `On API credits: $${Math.floor(credits.left)} of $${Math.floor(credits.grant)} left${credits.unread ? ", a key unread" : ""}`,
			role: "value",
		};
	if (credits && "usedUp" in credits)
		return { text: "Plans and API credits all used up", role: "value" };
	if (credits)
		return { text: `API credits unread: ${credits.why}`, role: "secondary" };
	const uses = status.seats.readings.map(
		({ seat, week }) =>
			`${seat.replace("~/", "")} ${week === null ? "unread" : `${week}%`}`,
	);
	return {
		text: uses.length > 0 ? `Plans this week: ${uses.join(", ")}` : "",
		role: "secondary",
	};
}

/**
 * The words beside the switch where launches now spend money.
 * @param {PanelView} view
 */
function buildSwitchDetail({ status, pending }) {
	if (pending || !status || !isLaunching(status)) return {};
	const credits = buildCredits(status);
	return credits && "left" in credits ? { detail: "API credits · on" } : {};
}

/**
 * @param {PanelView} view
 * @param {number} now
 * @returns {[Row, Row, Row]}
 */
function buildLoopBlock({ status, readError, pending, refusal }, now) {
	/** @type {Row} */
	const third = status
		? buildSpendRow(status)
		: { text: "", role: "secondary" };
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
			third,
		];
	if (!status)
		return [
			{
				text: readError ? "Status unreadable" : "Reading the loop…",
				role: "value",
			},
			{ text: readError ?? "", role: "secondary" },
			third,
		];
	const [first, second] = buildObservedLines(status, now);
	return [
		first,
		isNoteShowing(refusal, now)
			? { text: refusal.text, role: "value" }
			: second,
		third,
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
	return [
		{
			text: `Burn mode  ${SWITCH_TEXT[state]}${word}`,
			role: "name",
			control: { id: "burn", state },
		},
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
 * The field shows what the last read showed until a read shows otherwise, so a
 * refused goal leaves the old one showing.
 * @param {PanelView} view
 * @param {number} now
 * @returns {Row}
 */
function buildGoalField({ status, goalEdit }, now) {
	/** @type {Row["control"]} */
	const control = { id: "goalField" };
	if (goalEdit)
		return {
			text: goalEdit.text,
			role: "value",
			caret: goalEdit.caret,
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

/**
 * The Goal section. A note takes the caption's rows, which stay two.
 * @param {PanelView} view
 * @param {number} now
 * @returns {Row[]}
 */
function buildGoalRows(view, now) {
	const state = buildGoalState(view);
	const { goalPending, goalNote } = view;
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
		...(isNoteShowing(goalNote, now)
			? buildGoalNoteRows(goalNote.text)
			: GOAL_CAPTION.map((text) => ({
					text,
					role: /** @type {Role} */ ("secondary"),
				}))),
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

/**
 * @param {PanelView} view
 * @param {number} now
 * @returns {Row[]}
 */
function buildRows(view, now) {
	const state = buildSwitchState(view);
	return [
		{
			text: `Refill loop  ${SWITCH_TEXT[state]}`,
			...buildSwitchDetail(view),
			role: "name",
			control: { id: "loop", state },
		},
		...buildLoopBlock(view, now),
		...SECTION_GAP,
		...buildAwayRows(view, now),
		...buildBurnRows(view),
		...SECTION_GAP,
		...buildGoalRows(view, now),
		...SECTION_GAP,
		...buildReposRows(view, now),
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
	const edited = (head, tail) => ({
		text: [...head, ...tail].join(""),
		caret: head.length,
	});
	if ("text" in key) return edited([...before, ...key.text], after);
	if (key.name === "backspace") return edited(before.slice(0, -1), after);
	if (key.name === "delete") return edited(before, after.slice(1));
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
 *   onChange: () => void}} deps `run`, `refill-loop.js`; `runBurn`, `burn-mode.sh`
 */
function createPanel({ run, runBurn, now, onChange }) {
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
		goalPending: null,
		goalNote: null,
		repoPending: {},
		repoRefusal: null,
	};
	let reading = false;
	let readAgain = false;

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

	function beginGoalEdit() {
		if (!view.status || view.goalPending) return;
		const text = view.status.goal?.text ?? "";
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
		if (view.status?.goal)
			await runLoopPress(
				{ argv: ["set", "--clear-goal"], on: false },
				"goalPending",
				"goalNote",
			);
		else if (!closedEdit) beginGoalEdit();
	}

	/**
	 * One argument, however it is typed, so typed words reach `--goal` alone and
	 * never read as another flag.
	 * @param {GoalEdit} edit
	 */
	async function saveGoal({ text }) {
		view.goalEdit = null;
		await runLoopPress(
			{ argv: ["set", `--goal=${text.trim()}`], on: true },
			"goalPending",
			"goalNote",
		);
	}

	/**
	 * Every key but Enter and Esc edits the field, and with no field open no key does
	 * anything (#3596 story 75).
	 * @param {Key} key
	 */
	async function pressKey(key) {
		const edit = view.goalEdit;
		if (!edit) return;
		if ("name" in key && key.name === "enter") {
			await saveGoal(edit);
			return;
		}
		view.goalEdit =
			"name" in key && key.name === "escape" ? null : buildEditAfter(edit, key);
		onChange();
	}

	/**
	 * A click outside the field drops what was typed, as Esc does: the press itself
	 * still changes one control.
	 * @param {number} terminalRow
	 */
	async function click(terminalRow) {
		const row = buildRows(view, now())[terminalRow - TOP_ROW];
		const control = row?.control;
		const closedEdit = view.goalEdit !== null && control?.id !== "goalField";
		if (closedEdit) {
			view.goalEdit = null;
			onChange();
		}
		if (control?.id === "goal") await pressGoalSwitch(closedEdit);
		else if (control?.id === "goalField") {
			if (!view.goalEdit) beginGoalEdit();
		} else await pressRow(row);
	}

	/** @param {Row|undefined} row */
	async function pressRow(row) {
		const control = row?.control;
		if (control?.id === "loop" || row?.presses === "loop")
			await runLoopPress(buildPress(view), "pending", "refusal");
		if (control?.id === "away")
			await runLoopPress(buildAwayPress(view), "awayPending", "awayNote");
		if (control?.id === "burn") await pressBurn();
		if (control?.id === "repo") await pressRepo(control.name);
	}

	return { view, refreshStatus, click, key: pressKey };
}

/**
 * `text` on one line of `width` cells: a row never wraps into the one below.
 * @param {string} text
 * @param {number} width
 */
function fitText(text, width) {
	const chars = [...text.replace(/\p{Cc}+/gu, " ")];
	return chars.length > width
		? `${chars.slice(0, Math.max(width - 1, 0)).join("")}…`
		: chars.join("");
}

/**
 * Ends by erasing below, so a report gone from the rows goes from the screen.
 * Draws only the rows that fit: past the bottom a terminal stacks them on its last
 * line, where a click would press a row other than the one showing. The cursor
 * shows only on a row being typed in, which scrolls to keep it in view.
 * @param {Row[]} rows
 * @param {number} columns the terminal's width
 * @param {number} height
 */
function buildFrame(rows, columns, height) {
	const width = columns - (LEFT_COLUMN - 1) * 2;
	let cursor = "";
	const drawn = rows
		.slice(0, Math.max(height - TOP_ROW + 1, 0))
		.map(({ text, detail, role, caret }, i) => {
			const { rgb, bold } = ROLE_STYLES[role];
			const start = caret === undefined ? 0 : Math.max(caret - width + 1, 0);
			if (caret !== undefined)
				cursor = `${ESC}[${TOP_ROW + i};${LEFT_COLUMN + caret - start}H${ESC}[?25h`;
			const chars =
				caret === undefined
					? [...fitText(detail ? `${text}  ${detail}` : text, width)]
					: [...text.replace(/\p{Cc}+/gu, " ")].slice(start, start + width);
			const textChars = [...text].length;
			return [
				`${ESC}[${TOP_ROW + i};${LEFT_COLUMN}H`,
				bold ? `${ESC}[1m` : "",
				`${ESC}[38;2;${rgb.join(";")}m`,
				chars.slice(0, textChars).join(""),
				`${ESC}[22m`,
				chars.slice(textChars).join(""),
				`${ESC}[0m${ESC}[K`,
			].join("");
		})
		.join("");
	return `${ESC}[?25l${drawn}${ESC}[J${cursor}`;
}

const INPUT_TOKEN = new RegExp(
	`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])|${ESC}(?:\\[([\\d;]*[A-Za-z~])|O([A-Za-z]))|(${ESC})|(\\P{Cc}+)|(\\p{Cc})`,
	"gu",
);
const PARTIAL_INPUT = new RegExp(`${ESC}(\\[[<\\d;]*|O)?$`);
const LEFT_BUTTON = 0;

/** @type {Record<string, Key>} */
const SEQUENCE_KEYS = {
	D: { name: "left" },
	C: { name: "right" },
	H: { name: "home" },
	F: { name: "end" },
	"1~": { name: "home" },
	"4~": { name: "end" },
	"3~": { name: "delete" },
};
/** @type {Record<string, Key>} */
const CONTROL_KEYS = {
	"\r": { name: "enter" },
	"\n": { name: "enter" },
	"\x7f": { name: "backspace" },
	"\b": { name: "backspace" },
};
/** @type {Key} */
const ESCAPE_KEY = { name: "escape" };

/**
 * The key a token of the input names, if the panel has a use for it.
 * @param {RegExpMatchArray} token
 * @returns {Key|undefined}
 */
function buildKeyOf([, , , , , csi, ss3, lone, text, control]) {
	if (lone) return ESCAPE_KEY;
	if (text) return { text };
	return SEQUENCE_KEYS[csi ?? ss3 ?? ""] ?? CONTROL_KEYS[control ?? ""];
}

/**
 * Reads the raw input stream, across chunks: SGR mouse reports (mode 1006), where a
 * click is a left release in the cell of the left press before it, the press that
 * focused the pane counting as the terminal reports it like any other; and the keys
 * a field uses, any other sequence dropped. `held` says the stream stops on what may
 * start a sequence: `flush` ends the wait, a lone escape then reading as the Esc key.
 */
function createInputReader() {
	let rest = "";
	/** @type {string|null} */
	let pressedCell = null;
	/**
	 * @param {RegExpMatchArray} report
	 * @returns {number[]} the row, where this report ends a click
	 */
	const readReport = ([, button, column, row, kind]) => {
		const left = Number(button) === LEFT_BUTTON;
		const cell = `${column};${row}`;
		if (kind === "M") {
			pressedCell = left ? cell : null;
			return [];
		}
		const clicked = left && pressedCell === cell;
		pressedCell = null;
		return clicked ? [Number(row)] : [];
	};
	return {
		/** @param {string} chunk */
		read(chunk) {
			const input = rest + chunk;
			rest = PARTIAL_INPUT.exec(input)?.[0] ?? "";
			const tokens = [
				...input.slice(0, input.length - rest.length).matchAll(INPUT_TOKEN),
			];
			const clicks = tokens.flatMap((t) => (t[4] ? readReport(t) : []));
			const keys = tokens.flatMap((t) => buildKeyOf(t) ?? []);
			return {
				clicks,
				keys,
				interrupted: input.includes(INTERRUPT),
				held: rest !== "",
			};
		},
		/** @returns {Key[]} */
		flush() {
			const lone = rest === ESC;
			rest = "";
			return lone ? [ESCAPE_KEY] : [];
		},
	};
}

module.exports = {
	ESC,
	buildFrame,
	buildRows,
	createInputReader,
	createPanel,
};
