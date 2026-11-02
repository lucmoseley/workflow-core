/*
 * refill-panel-terminal.js — the refill loop's panel on a terminal (#3873, spec
 * #3596): raw mode, the alternate screen and mouse reports on opening, handed back
 * on every exit a process can catch, and the poll and pid watch between.
 */

const {
	ESC,
	buildFrame,
	buildRows,
	createClickReader,
	createPanel,
} = require("./refill-panel.js");

const SCREEN_ON = `${ESC}[?1049h${ESC}[?25l${ESC}[?1000h${ESC}[?1006h`;
const SCREEN_OFF = `${ESC}[?1006l${ESC}[?1000l${ESC}[?25h${ESC}[?1049l`;
const CLEAR = `${ESC}[2J`;

/* Untraced, first guesses: fast enough that a change elsewhere shows while the
 * founder looks, and each poll is one short Node process. */
const POLL_MS = 3000;
const WATCH_MS = 1000;
/* A stream that reports no width, a terminal's traditional one. */
const DEFAULT_COLUMNS = 80;
/* 128 plus the signal's number, the shell's convention. */
const SIGNAL_EXITS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/**
 * Runs the panel until the process exits, through `proc.exit`.
 * @param {{pid: number, stdin: Pick<import("node:tty").ReadStream, "setRawMode"|"resume"|"setEncoding"|"on">,
 *   stdout: Pick<import("node:tty").WriteStream, "write"|"on"|"columns">,
 *   proc: Pick<import("node:events").EventEmitter, "on"> & {exit: (code: number) => void},
 *   run: import("./refill-panel.js").Runner,
 *   isAlive: (pid: number) => boolean, now: () => number,
 *   reportCrash: (err: unknown) => void}} io
 */
function openPanel({
	pid,
	stdin,
	stdout,
	proc,
	run,
	isAlive,
	now,
	reportCrash,
}) {
	let restored = false;
	const restore = () => {
		if (restored) return;
		restored = true;
		for (const step of [
			() => stdin.setRawMode(false),
			() => stdout.write(SCREEN_OFF),
		]) {
			try {
				step();
			} catch {
				// #3873: the terminal is gone, so nothing is left to restore and the exit must go on.
			}
		}
	};
	/** @param {unknown} err */
	const crash = (err) => {
		restore();
		reportCrash(err);
		proc.exit(1);
	};
	proc.on("exit", restore);
	proc.on("uncaughtException", crash);
	proc.on("unhandledRejection", crash);
	for (const [signal, code] of Object.entries(SIGNAL_EXITS))
		proc.on(signal, () => {
			restore();
			proc.exit(code);
		});

	const draw = () => {
		if (!restored)
			stdout.write(
				buildFrame(
					buildRows(panel.view, now()),
					stdout.columns ?? DEFAULT_COLUMNS,
				),
			);
	};
	const panel = createPanel({ run, now, onChange: draw });
	const readClicks = createClickReader();

	stdin.setRawMode(true);
	stdin.setEncoding("utf8");
	stdin.resume();
	stdout.write(SCREEN_ON);
	draw();

	stdin.on("data", (/** @type {string} */ chunk) => {
		const { clicks, interrupted } = readClicks(chunk);
		if (interrupted) {
			proc.exit(0);
			return;
		}
		for (const row of clicks) panel.click(row).catch(crash);
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
