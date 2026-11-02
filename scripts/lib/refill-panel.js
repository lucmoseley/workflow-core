/*
 * refill-panel.js — what the refill loop's panel draws and what a click does,
 * with no terminal (#3873, spec #3596): status JSON and pending presses in, rows
 * out; a click on a row in, a `refill-loop.js` argv out. The panel runs that
 * command line for every read and write, and never opens a control or state
 * file, so the loop's validation, lock and wake apply to every press.
 *
 * Desired and observed state stay apart. A press is a pending mark beside what
 * the last status read showed, cleared only by a read showing the change or by
 * the command's refusal.
 */

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
 *   launchesToday: number}} PanelStatus
 */

/**
 * A press no status read has shown yet. `on` is what it asks for; `landed`,
 * whether its command has exited 0.
 * @typedef {{on: boolean, landed: boolean}} Pending
 */

/**
 * @typedef {{status: PanelStatus|null, readError: string|null,
 *   pending: Pending|null,
 *   refusal: {text: string, at: number}|null}} PanelView
 */

/**
 * @typedef {{text: string, role: Role,
 *   control?: {id: "loop", state: "on"|"off"|"pending"|"unknown"}}} Row
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
					: "Not running: switch on, then start it from the command line",
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

/** @type {Record<ReturnType<typeof buildSwitchState>, string>} */
const SWITCH_TEXT = {
	on: "[on]",
	off: "[off]",
	pending: "[…]",
	unknown: "[?]",
};

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
 * @typedef {(argv: string[]) => Promise<RunResult>} Runner runs
 *   `refill-loop.js <argv>`; a command that cannot start resolves as a failure
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
 * @param {{run: Runner, now: () => number, onChange: () => void}} deps
 */
function createPanel({ run, now, onChange }) {
	/** @type {PanelView} */
	const view = { status: null, readError: null, pending: null, refusal: null };
	let reading = false;
	let readAgain = false;

	async function refreshStatus() {
		if (reading) {
			readAgain = true;
			return;
		}
		reading = true;
		const readAfterLanding = view.pending?.landed === true;
		const result = await run(["status", "--json"]);
		reading = false;
		const parsed =
			result.code === 0 ? parseStatus(result.stdout) : buildFailureText(result);
		if (typeof parsed === "string") {
			view.status = null;
			view.readError = parsed;
		} else {
			view.status = parsed;
			view.readError = null;
			if (
				view.pending &&
				isPressSettled(view.pending, parsed, readAfterLanding)
			)
				view.pending = null;
		}
		onChange();
		if (readAgain) {
			readAgain = false;
			await refreshStatus();
		}
	}

	/** @param {number} terminalRow */
	async function click(terminalRow) {
		if (terminalRow !== TOP_ROW) return;
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
 * @param {Row[]} rows
 * @param {number} columns the terminal's width
 */
function buildFrame(rows, columns) {
	const width = columns - (LEFT_COLUMN - 1) * 2;
	return rows
		.map(({ text, role }, i) => {
			const { rgb, bold } = ROLE_STYLES[role];
			return [
				`${ESC}[${TOP_ROW + i};${LEFT_COLUMN}H`,
				bold ? `${ESC}[1m` : "",
				`${ESC}[38;2;${rgb.join(";")}m`,
				fitText(text, width),
				`${ESC}[0m${ESC}[K`,
			].join("");
		})
		.join("");
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
