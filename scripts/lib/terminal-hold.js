const { ignoreFailure } = require("./caught.js");

// #3883 guess
const ESCAPE_WAIT_MS = 50;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const SIGNAL_EXITS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/**
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
		// #3873
		for (const step of [
			() => stdin.setRawMode(false),
			() => stdout.write(screenOff),
		])
			ignoreFailure(step);
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
