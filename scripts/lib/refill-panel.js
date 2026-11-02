/*
 * refill-panel.js — what the refill loop's panel draws and what a click does,
 * with no terminal (#3873, #3875, #3877, spec #3596): status JSON and pending presses in, rows
 * out; a click on a row in, a `refill-loop.js` or `burn-mode.sh` argv out. The
 * panel runs those two for every read and write, and never opens a control or
 * state file, so the loop's validation, lock and wake apply to every loop press.
 *
 * Desired and observed state stay apart. A press is a pending mark beside what
 * the last status read showed, cleared only by a read showing the change or by
 * the command's refusal. A burn-mode flip is whole when its script exits, so any
 * read after that exit shows it, or another writer's reversal.
 */

const path = require("node:path");
const { caught } = require("./caught.js");
const { localDate } = require("./morning-review.js");

const ESC = String.fromCharCode(27);
const INTERRUPT = String.fromCharCode(3);

/* Where the block starts, 1-based as a mouse report counts. Untraced: one cell
 * of margin round the prototype's layout (#2525 round 9). */
const TOP_ROW = 2;
const LEFT_COLUMN = 3;

/* How long a refusal holds line 2 before the loop's own words return. Untraced:
 * a first guess, long enough to read one line. */
const REFUSAL_SHOW_MS = 10_000;

/* The skill's line on every flip (`.claude/skills/burn-mode/SKILL.md`). */
const BURN_RESTART_NOTE = "Running sessions keep their effort until restarted";

/* Two rows between sections (#3596 story 78). */
const SECTION_GAP = [
	{ text: "", role: /** @type {Role} */ ("secondary") },
	{ text: "", role: /** @type {Role} */ ("secondary") },
];

/** @typedef {"name"|"value"|"secondary"|"needsYou"} Role */

/**
 * White, #949494 and the one yellow, from #2525 round 9 (#3596 lists the grey as
 * untraced; the yellow is the prototype's).
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
 *     spent: boolean}} OverflowKey
 * @typedef {{running: boolean, stopRequested: boolean,
 *   stop: {reason: string, at: number, detail: string}|null, crashed: boolean,
 *   paused: {by: string, at: number, issues?: PauseIssue[]}|null,
 *   lastTick: {at: number, summary: string, idle: string|null,
 *     paused: boolean, planWait: {resets: number|null}|null}|null,
 *   launchesToday: number,
 *   seats: {readings: {seat: string, week: number|null,
 *     weekFull: boolean}[]},
 *   overflow: OverflowKey[],
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

/**
 * @typedef {{status: PanelStatus|null, readError: string|null,
 *   pending: Pending|null,
 *   refusal: {text: string, at: number}|null,
 *   burnPending: Pending|null, burnReport: BurnReport|null}} PanelView
 */

/**
 * `detail`, drawn after `text` in regular weight whatever the role.
 * @typedef {{text: string, role: Role, detail?: string,
 *   control?: {id: "loop"|"burn",
 *     state: "on"|"off"|"pending"|"unknown"|"failed"}}} Row
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
 * The issues a no-progress pause names, repo-qualified where they span repos.
 * @param {PauseIssue[]} issues
 */
function buildIssueRefs(issues) {
	const spans = new Set(issues.map((i) => i.root)).size > 1;
	return issues
		.map((i) => `${spans ? path.basename(i.root) : ""}#${i.number}`)
		.join(", ");
}

/**
 * What the loop waits on: the allowance's one line, in the panel's clock, or the
 * tick's own words.
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
 * The lines of a pause. A no-progress pause reads "needs you", dead or alive. So
 * does a founder's pause whose process died: the housekeeping it promised has
 * stopped with it.
 * @param {NonNullable<PanelStatus["paused"]>} paused
 * @param {PanelStatus} status
 * @param {number} now
 * @returns {[Row, Row]}
 */
function buildPausedLines(paused, { running, crashed }, now) {
	if (paused.by !== "founder") {
		const refs = buildIssueRefs(paused.issues ?? []);
		return [
			NEEDS_YOU,
			{
				text: `No progress${refs && `: ${refs}`} · click to resume`,
				role: "value",
			},
		];
	}
	if (crashed)
		return [
			NEEDS_YOU,
			{
				text: "It died while switched off · click to restart",
				role: "value",
			},
		];
	return [
		{
			text: `You switched it off at ${buildClock(paused.at, now)}`,
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
 * Line 2 of a loop with no process and no pause. A click restarts a loop that
 * ended; one never started has nothing to start from.
 * @param {PanelStatus["stop"]} stop
 * @param {number} now
 */
function buildEndedText(stop, now) {
	if (!stop) return "Not running: start it from the command line";
	const time = buildClock(stop.at, now);
	return stop.reason === "explicit"
		? `Stopped from the command line at ${time} · click to restart`
		: `Stopped at ${time}: ${stop.detail} · click to restart`;
}

/**
 * Line 1 and line 2 of the loop block, from the observed status alone.
 * @param {PanelStatus} status
 * @param {number} now
 * @returns {[Row, Row]}
 */
function buildObservedLines(status, now) {
	const { running, stopRequested, paused, crashed, stop } = status;
	if (paused) return buildPausedLines(paused, status, now);
	if (crashed)
		return [
			NEEDS_YOU,
			{ text: "It died with no stop · click to restart", role: "value" },
		];
	if (!running)
		return [
			{ text: "off", role: "value" },
			{ text: buildEndedText(stop, now), role: "secondary" },
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
 * unread budget stops the panel calling the credits spent.
 * @param {PanelStatus} status
 * @returns {null | {left: number, grant: number} | {spent: true} | {why: string}}
 */
function readCredits({ seats, overflow }) {
	if (overflow.length === 0 || !seats.readings.every((s) => s.weekFull))
		return null;
	const read = overflow.flatMap((key) => ("why" in key ? [] : [key]));
	const live = read.filter((key) => !key.spent);
	if (live.length > 0)
		return {
			left: live.reduce((sum, key) => sum + key.headroomUsd, 0),
			grant: read.reduce((sum, key) => sum + key.grantUsd, 0),
		};
	const unread = overflow.find((key) => "why" in key);
	return unread && "why" in unread ? { why: unread.why } : { spent: true };
}

/**
 * Line 3 of the loop block: each plan seat's week, or the credits past them. The
 * seats are named since their order follows the last typed seat.
 * @param {PanelStatus} status
 * @returns {Row}
 */
function buildSpendRow(status) {
	const credits = readCredits(status);
	if (credits && "left" in credits)
		return {
			text: `On API credits: $${Math.floor(credits.left)} of $${Math.floor(credits.grant)} left`,
			role: "value",
		};
	if (credits && "spent" in credits)
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
	const credits = readCredits(status);
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
				text: pending.on ? "turning on…" : "turning off…",
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
	const refused = refusal && now - refusal.at < REFUSAL_SHOW_MS;
	return [
		first,
		refused ? { text: refusal.text, role: "value" } : second,
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
 * @returns {NonNullable<Row["control"]>["state"]}
 */
function buildBurnState({ status, burnPending, burnReport }) {
	if (burnPending) return "pending";
	if (burnReport && burnReport.code !== 0) return "failed";
	if (!status || status.burnMode.on === null) return "unknown";
	if (status.burnMode.disagreeing.length > 0) return "failed";
	return status.burnMode.on ? "on" : "off";
}

/** @type {Record<NonNullable<Row["control"]>["state"], string>} */
const SWITCH_TEXT = {
	on: "[on]",
	off: "[off]",
	pending: "[…]",
	unknown: "[?]",
	failed: "[!]",
};

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
	const word = burnPending ? `  turning ${burnPending.on ? "on" : "off"}…` : "";
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
		...buildBurnRows(view),
	];
}

/**
 * What a press on the switch does: the argv to run and what it asks for, or
 * null where the press does nothing. A dead loop restarts from its stored
 * settings. One never started, or one stopping, has nothing to write here, and no
 * press ever stops the process.
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
		burnPending: null,
		burnReport: null,
	};
	let reading = false;
	let readAgain = false;

	/**
	 * @param {PanelStatus|string} parsed the status, or why it will not read
	 * @param {{press: boolean, flip: boolean}} landedBefore whether each pending
	 *   mark's command had exited when this read began
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
		if (landedBefore.flip) view.burnPending = null;
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
			flip: view.burnPending?.landed === true,
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

	async function pressLoop() {
		const press = buildPress(view);
		if (!press) return;
		const pending = { on: press.on, landed: false };
		view.pending = pending;
		view.refusal = null;
		onChange();
		const result = await run(press.argv);
		if (result.code === 0) {
			pending.landed = true;
		} else {
			view.pending = null;
			view.refusal = { text: buildFailureText(result), at: now() };
		}
		onChange();
		await refreshStatus();
	}

	/** @param {number} terminalRow */
	async function click(terminalRow) {
		const id = buildRows(view, now())[terminalRow - TOP_ROW]?.control?.id;
		if (id === "loop") await pressLoop();
		if (id === "burn") await pressBurn();
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
 * @param {Row[]} rows
 * @param {number} columns the terminal's width
 */
function buildFrame(rows, columns) {
	const width = columns - (LEFT_COLUMN - 1) * 2;
	const drawn = rows
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
