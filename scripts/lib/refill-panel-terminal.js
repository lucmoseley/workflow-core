/*
 * refill-panel-terminal.js — the refill loop's panel on a terminal (#3873, spec
 * #3596): raw mode, the alternate screen and mouse reports on opening, handed back
 * on every exit a process can catch, and the poll and pid watch between.
 */

const { buildFrame, buildRows, createPanel } = require("./refill-panel.js");
const { ESC, createInputReader } = require("./refill-panel-input.js");

const SCREEN_ON = `${ESC}[?1049h${ESC}[?25l${ESC}[?1000h${ESC}[?1006h${ESC}[?2004h`;
const SCREEN_OFF = `${ESC}[?2004l${ESC}[?1006l${ESC}[?1000l${ESC}[?25h${ESC}[?1049l`;
const CLEAR = `${ESC}[2J`;

/* Untraced, first guesses: fast enough that a change elsewhere shows while the
 * founder looks, and each poll is one short Node process. */
const POLL_MS = 3000;
const WATCH_MS = 1000;
/* A stream that reports no width, a terminal's traditional one. */
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
/* How long a lone escape byte waits for the rest of a sequence before it reads as
 * the Esc key. Untraced, a first guess: a terminal writes a sequence whole, so
 * this need only outlast a split read. */
const ESCAPE_WAIT_MS = 50;
/* 128 plus the signal's number, the shell's convention. */
const SIGNAL_EXITS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/**
 * Runs the panel until the process exits, through `proc.exit`.
 * @param {{pid: number, stdin: Pick<import("node:tty").ReadStream, "setRawMode"|"resume"|"setEncoding"|"on">,
 *   stdout: Pick<import("node:tty").WriteStream, "write"|"on"|"columns"|"rows">,
 *   proc: Pick<import("node:events").EventEmitter, "on"> & {exit: (code: number) => void},
 *   run: import("./refill-panel.js").Runner,
 *   runBurn: import("./refill-panel.js").Runner,
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
					stdout.rows ?? DEFAULT_ROWS,
				),
			);
	};
	const panel = createPanel({ run, runBurn, now, onChange: draw });
	const input = createInputReader();
	/** @type {NodeJS.Timeout|undefined} */
	let escapeWait;
	/** @param {import("./refill-panel-input.js").Key[]} keys */
	const pressKeys = (keys) => {
		for (const key of keys) panel.pressKey(key).catch(crash);
	};

	stdin.setRawMode(true);
	stdin.setEncoding("utf8");
	stdin.resume();
	stdout.write(SCREEN_ON);
	draw();

	stdin.on("data", (/** @type {string} */ chunk) => {
		clearTimeout(escapeWait);
		const { clicks, keys, interrupted, held } = input.read(chunk);
		if (interrupted) {
			proc.exit(0);
			return;
		}
		for (const row of clicks) panel.click(row).catch(crash);
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
