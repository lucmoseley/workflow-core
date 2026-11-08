/*
 * refill-panel-terminal.js — the refill loop's panel on a terminal (workflow-core#3873, workflow-core#3885, workflow-core#3887, workflow-core#3948, spec
 * workflow-core#3596): raw mode, the alternate screen and mouse reports on opening, handed back
 * on every exit a process can catch, and the poll and pid watch between. It asks what
 * the terminal can draw on opening, keeping the text controls until both answers say
 * images fit; a terminal that never answers keeps them.
 */

const {
	POLL_MS,
	buildFrame,
	findHoverRow,
	createPanel,
} = require("./refill-panel.js");
const { ESC, createInputReader } = require("./refill-panel-input.js");
const {
	DEFAULT_COLUMNS,
	DEFAULT_ROWS,
	ESCAPE_WAIT_MS,
	holdTerminal,
} = require("./terminal-hold.js");

/* Primary device attributes, then the character cell's size in pixels. */
const ASK_CAPABILITIES = `${ESC}[c${ESC}[16t`;
const SCREEN_ON = `${ESC}[?1049h${ESC}[?25l${ESC}[?1000h${ESC}[?1006h${ESC}[?1004h${ESC}[?2004h${ASK_CAPABILITIES}`;
/* Any-motion reports serve only the images' hover. No leave report exists, so losing
 * focus is what ends one. */
const HOVER_ON = `${ESC}[?1003h`;
const SCREEN_OFF = `${ESC}[?1004l${ESC}[?1003l${ESC}[?2004l${ESC}[?1006l${ESC}[?1000l${ESC}[?25h${ESC}[?1049l`;
const CLEAR = `${ESC}[2J`;

/* Untraced, a first guess: how often the panel checks its own code for a change. */
const WATCH_MS = 1000;

/**
 * Runs the panel until the process exits, through `proc.exit`.
 * @param {{pid: number, stdin: Pick<import("node:tty").ReadStream, "setRawMode"|"resume"|"setEncoding"|"on">,
 *   stdout: Pick<import("node:tty").WriteStream, "write"|"on"|"columns"|"rows">,
 *   proc: Pick<import("node:events").EventEmitter, "on"> & {exit: (code: number) => void},
 *   run: import("./refill-panel.js").Runner,
 *   runBurn: import("./refill-panel.js").Runner,
 *   resolveTopic: import("./refill-panel.js").TopicResolver,
 *   returnFocus: import("./refill-panel.js").FocusReturner,
 *   isAlive: (pid: number) => boolean, now: () => number,
 *   reportCrash: (err: unknown) => void}} io
 */
function openPanel({
	pid,
	stdin,
	stdout,
	proc,
	run,
	runBurn,
	resolveTopic,
	returnFocus,
	isAlive,
	now,
	reportCrash,
}) {
	const { crash, isRestored } = holdTerminal({
		stdin,
		stdout,
		proc,
		screenOn: SCREEN_ON,
		screenOff: SCREEN_OFF,
		reportCrash,
	});

	const height = () => stdout.rows ?? DEFAULT_ROWS;
	const columns = () => stdout.columns ?? DEFAULT_COLUMNS;
	/** @type {Set<string>} */
	const capabilities = new Set();
	let imagesFit = false;
	/** @type {number|null} */
	let hoverRow = null;
	/** @param {string[]} answered */
	const takeCapabilities = (answered) => {
		for (const capability of answered) capabilities.add(capability);
		if (imagesFit || !capabilities.has("sixel")) return;
		if (!capabilities.has("cell10x20")) return;
		imagesFit = true;
		stdout.write(HOVER_ON);
		draw();
	};
	/** @param {number|null} terminalRow */
	const moveHover = (terminalRow) => {
		const next =
			imagesFit && terminalRow !== null
				? findHoverRow(
						panel.buildViewRows(),
						terminalRow,
						height(),
						panel.view.scroll,
					)
				: null;
		if (next === hoverRow) return;
		hoverRow = next;
		draw();
	};
	const draw = () => {
		if (!isRestored())
			stdout.write(
				buildFrame(panel.buildViewRows(), columns(), height(), {
					images: imagesFit,
					hoverRow,
					scroll: panel.view.scroll,
				}),
			);
	};
	const panel = createPanel({
		run,
		runBurn,
		now,
		resolveTopic,
		returnFocus,
		height,
		columns,
		onChange: draw,
	});
	const input = createInputReader();
	/** @type {NodeJS.Timeout|undefined} */
	let escapeWait;
	/** @param {import("./refill-panel-input.js").Key[]} keys */
	const pressKeys = (keys) => {
		for (const key of keys) panel.pressKey(key).catch(crash);
	};
	/**
	 * The wheel goes after the clicks: nothing in a read has been drawn yet, so the frame
	 * showing when each was made is the one before any of its wheel reports.
	 * @param {{clicks: number[], missed: boolean, wheel: number}} read
	 */
	const takeButtons = ({ clicks, missed, wheel }) => {
		for (const row of clicks) panel.click(row).catch(crash);
		if (missed) panel.missClick().catch(crash);
		if (wheel !== 0) panel.scrollBy(wheel);
	};

	draw();

	stdin.on("data", (/** @type {string} */ chunk) => {
		clearTimeout(escapeWait);
		const {
			moves,
			keys,
			capabilities: answered,
			focusGained,
			focusLost,
			interrupted,
			held,
			...buttons
		} = input.read(chunk);
		if (interrupted) {
			proc.exit(0);
			return;
		}
		takeCapabilities(answered);
		const [lastMove] = moves.slice(-1);
		if (lastMove !== undefined) moveHover(lastMove);
		if (focusLost) {
			moveHover(null);
			panel.loseFocus();
		}
		if (focusGained) panel.takeFocus();
		takeButtons(buttons);
		pressKeys(keys);
		if (held)
			escapeWait = setTimeout(() => pressKeys(input.flush()), ESCAPE_WAIT_MS);
	});
	stdout.on("resize", () => {
		stdout.write(CLEAR);
		draw();
	});
	const poll = () => {
		panel.refreshStatus().catch(crash);
	};
	poll();
	setInterval(poll, POLL_MS);
	setInterval(() => {
		if (!isAlive(pid)) proc.exit(0);
	}, WATCH_MS);
}

module.exports = { openPanel };
