/*
 * terminal-hold.js — a full-screen program's hold on its terminal (#3873,
 * #4583): raw mode and the program's screen modes on opening, handed back on
 * every exit a process can catch. lib/refill-panel-terminal.js and
 * lib/overflow-viewer.js both open through it.
 */

/* How long a lone escape byte waits for the rest of a sequence before it reads as
 * the Esc key. Untraced, a first guess: a terminal writes a sequence whole, so
 * this need only outlast a split read. */
const ESCAPE_WAIT_MS = 50;
/* A stream that reports no width, a terminal's traditional one. */
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
/* 128 plus the signal's number, the shell's convention. */
const SIGNAL_EXITS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/**
 * Takes the terminal: raw mode, then `screenOn`. `restore` turns raw mode off
 * and writes `screenOff`, once; `crash` restores, reports and exits 1.
 * @param {{stdin: Pick<import("node:tty").ReadStream, "setRawMode"|"resume"|"setEncoding">,
 *   stdout: Pick<import("node:tty").WriteStream, "write">,
 *   proc: Pick<import("node:events").EventEmitter, "on"> & {exit: (code: number) => void},
 *   screenOn: string, screenOff: string,
 *   reportCrash: (err: unknown) => void}} io
 * @returns {{restore: () => void, crash: (err: unknown) => void,
 *   isRestored: () => boolean}}
 */
function holdTerminal({
	stdin,
	stdout,
	proc,
	screenOn,
	screenOff,
	reportCrash,
}) {
	let restored = false;
	const restore = () => {
		if (restored) return;
		restored = true;
		for (const step of [
			() => stdin.setRawMode(false),
			() => stdout.write(screenOff),
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
	stdin.setRawMode(true);
	stdin.setEncoding("utf8");
	stdin.resume();
	stdout.write(screenOn);
	return { restore, crash, isRestored: () => restored };
}

module.exports = {
	DEFAULT_COLUMNS,
	DEFAULT_ROWS,
	ESCAPE_WAIT_MS,
	holdTerminal,
};
