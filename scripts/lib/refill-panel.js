/*
 * refill-panel.js — what the refill loop's panel draws and what a click does,
 * with no terminal (#3873, #3877, #3879, #3881, spec #3596): status JSON and pending presses in, rows
 * out; a click on a row in, a `refill-loop.js` or `burn-mode.sh` argv out. The
 * panel runs those two for every read and write, and never opens a control or
 * state file, so the loop's validation, lock and wake apply to every loop press.
 *
 * Desired and observed state stay apart. A press is a pending mark beside what
 * the last status read showed, cleared only by a read showing the change or by
 * the command's refusal. An away press, a burn-mode flip or a repo's tick is whole
 * when its command exits, so any read after that exit shows it, or another writer's
 * reversal, the loop's automatic return included.
 */

const { caught } = require("./caught.js");
const { localDate } = require("./morning-review.js");

const ESC = String.fromCharCode(27);
const INTERRUPT = String.fromCharCode(3);

/* Where the block starts, 1-based as a mouse report counts. Untraced: one cell
 * of margin round the prototype's layout (#2525 round 9). */
const TOP_ROW = 2;
const LEFT_COLUMN = 3;

/* How long a press's note holds its row before that row's own words return. Untraced:
 * a first guess, long enough to read one line. */
const NOTE_SHOW_MS = 10_000;

/* The skill's line on every flip (`.claude/skills/burn-mode/SKILL.md`). */
const BURN_RESTART_NOTE = "Running sessions keep their effort until restarted";

const AWAY_OFF_WORD = "normal";

/* How `refill-loop.js set` opens a warning about a loop with no process. */
const NOT_RUNNING_PREFIX = "refill loop: not running";

/* `status --json` reads a control never written and a damaged one alike, as no
 * mode; `set` refuses both, and `start` writes one. */
const NO_CONTROL_TEXT = "No loop settings to change: run `start`";

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

/** @typedef {"name"|"value"|"secondary"} Role */

/**
 * White and #949494, from #2525 round 9 (#3596 lists the grey as untraced).
 * @type {Record<Role, {rgb: [number, number, number], bold?: boolean}>}
 */
const ROLE_STYLES = {
	name: { rgb: [0xf2, 0xf2, 0xf2], bold: true },
	value: { rgb: [0xf2, 0xf2, 0xf2] },
	secondary: { rgb: [0x94, 0x94, 0x94] },
};

/**
 * The fields of `refill-loop.js status --json` the panel reads.
 * @typedef {{running: boolean, stopRequested: boolean, codeSha: string|null,
 *   paused: {by: string, at: number}|null,
 *   lastTick: {at: number, summary: string, idle: string|null,
 *     paused: boolean}|null,
 *   launchesToday: number,
 *   mode: "normal"|"away"|null,
 *   handedOffSinceAway: number,
 *   repos: {name: string, ticked: boolean, disabled: string|null}[],
 *   burnMode: ReturnType<typeof import("./burn-mode.js").readBurnState>}} PanelStatus
 */

/**
 * A press no status read has shown yet. `on` is what it asks for; `landed`,
 * whether its command has exited 0.
 * @typedef {{on: boolean, landed: boolean}} Pending
 */

/**
 * What a burn-mode flip left to read, held until the next press: its exit, and
 * stderr then stdout unless it exited 0 with nothing on stderr. `on` is what it
 * asked for.
 * @typedef {{on: boolean, code: number, lines: string[]}} BurnReport
 */

/** @typedef {{text: string, at: number}} PressNote */

/**
 * @typedef {{status: PanelStatus|null, readError: string|null,
 *   pending: Pending|null,
 *   refusal: PressNote|null,
 *   awayPending: Pending|null, awayNote: PressNote|null,
 *   burnPending: Pending|null, burnReport: BurnReport|null,
 *   repoPending: Record<string, Pending>,
 *   repoRefusal: (PressNote & {name: string})|null}} PanelView
 */

/**
 * @typedef {"on"|"off"|"pending"|"unknown"|"failed"} SwitchState
 * @typedef {"ticked"|"unticked"|"pending"|"disabled"} BoxState
 */

/**
 * `detail`, drawn after `text` in regular weight whatever the role.
 * @typedef {{text: string, role: Role, detail?: string,
 *   control?: {id: "loop"|"away"|"burn", state: SwitchState}
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
	const { running, stopRequested, paused, launchesToday } = status;
	if (paused) {
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
		{ text: `${launchesToday} launched today`, role: "value" },
		{
			text: `Waiting: ${buildCurrentTick(status)?.idle ?? "the next check"}`,
			role: "secondary",
		},
	];
}

/**
 * @param {PanelView} view
 * @param {number} now
 * @returns {[Row, Row, Row]}
 */
function buildLoopBlock({ status, readError, pending, refusal }, now) {
	const third = {
		text: status
			? [status.codeSha, buildCurrentTick(status)?.summary]
					.filter(Boolean)
					.join(" · ")
			: "",
		role: /** @type {Role} */ ("secondary"),
	};
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
			role: "name",
			control: { id: "loop", state },
		},
		...buildLoopBlock(view, now),
		...SECTION_GAP,
		...buildAwayRows(view, now),
		...buildBurnRows(view),
		...SECTION_GAP,
		...buildReposRows(view, now),
	];
}

/**
 * What a press on the switch does: the argv to run and what it asks for, or
 * null where the press does nothing. A loop with no process and no pause, or one
 * stopping, has nothing to write here.
 * @param {PanelView} view
 */
function buildPress({ status, pending }) {
	if (pending || !status) return null;
	if (status.paused) return { argv: ["set", "--resume"], on: true };
	if (isLaunching(status)) return { argv: ["set", "--pause"], on: false };
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
 * shows the change, or another writer's reversal of it.
 * @param {Pending} pending
 * @param {PanelStatus} status
 * @param {boolean} readAfterLanding
 */
function isPressSettled(pending, status, readAfterLanding) {
	if (!readAfterLanding) return false;
	const { paused, running, lastTick } = status;
	if (pending.on || !paused) return true;
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
		repoPending: {},
		repoRefusal: null,
	};
	let reading = false;
	let readAgain = false;

	/**
	 * @param {PanelStatus|string} parsed the status, or why it will not read
	 * @param {{press: boolean, away: boolean, flip: boolean, repos: string[]}} landedBefore which
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
			isPressSettled(view.pending, parsed, landedBefore.press)
		)
			view.pending = null;
		if (landedBefore.away) view.awayPending = null;
		if (landedBefore.flip) view.burnPending = null;
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
	 * @param {"pending"|"awayPending"} pendingSlot
	 * @param {"refusal"|"awayNote"} noteSlot
	 */
	async function runLoopPress(press, pendingSlot, noteSlot) {
		if (!press) return;
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

	/** @param {number} terminalRow */
	async function click(terminalRow) {
		const control = buildRows(view, now())[terminalRow - TOP_ROW]?.control;
		if (control?.id === "loop")
			await runLoopPress(buildPress(view), "pending", "refusal");
		if (control?.id === "away")
			await runLoopPress(buildAwayPress(view), "awayPending", "awayNote");
		if (control?.id === "burn") await pressBurn();
		if (control?.id === "repo") await pressRepo(control.name);
	}

	return { view, refreshStatus, click };
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
 * line, where a click would press a row other than the one showing.
 * @param {Row[]} rows
 * @param {number} columns the terminal's width
 * @param {number} height
 */
function buildFrame(rows, columns, height) {
	const width = columns - (LEFT_COLUMN - 1) * 2;
	const drawn = rows
		.slice(0, Math.max(height - TOP_ROW + 1, 0))
		.map(({ text, detail, role }, i) => {
			const { rgb, bold } = ROLE_STYLES[role];
			const chars = [...fitText(detail ? `${text}  ${detail}` : text, width)];
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
	return `${drawn}${ESC}[J`;
}

const MOUSE_REPORT = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, "g");
const PARTIAL_REPORT = new RegExp(`${ESC}(\\[(<[\\d;]*)?)?$`);
const LEFT_BUTTON = 0;

/**
 * Reads SGR mouse reports (mode 1006) off the raw input stream, across chunks: a
 * click is a left release in the cell of the left press before it. The press
 * that focused the pane counts, as the terminal reports it like any other.
 */
function createClickReader() {
	let rest = "";
	/** @type {string|null} */
	let pressedCell = null;
	/** @param {string} chunk */
	return (chunk) => {
		const input = rest + chunk;
		/** @type {number[]} */
		const clicks = [];
		for (const [, button, column, row, kind] of input.matchAll(MOUSE_REPORT)) {
			const left = Number(button) === LEFT_BUTTON;
			const cell = `${column};${row}`;
			if (kind === "M") {
				pressedCell = left ? cell : null;
				continue;
			}
			if (left && pressedCell === cell) clicks.push(Number(row));
			pressedCell = null;
		}
		rest = PARTIAL_REPORT.exec(input)?.[0] ?? "";
		return { clicks, interrupted: input.includes(INTERRUPT) };
	};
}

module.exports = {
	ESC,
	buildFrame,
	buildRows,
	createClickReader,
	createPanel,
};
