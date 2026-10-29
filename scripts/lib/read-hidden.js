/*
 * read-hidden.js — one line typed at a terminal with echo off, for a founder
 * entering a secret that must never reach the screen or the chat (#640).
 *
 * Raw mode is what turns echo off, so the line discipline's own editing goes
 * with it and is rebuilt here: Enter ends the line, backspace edits it, Ctrl-C
 * rejects, Ctrl-D ends it where it stands. Every other control byte is dropped
 * — an arrow key's whole escape sequence included, which would otherwise leave
 * `[D` inside the value.
 *
 * Bytes are decoded as strict UTF-8 across reads, so a character split
 * between two chunks arrives whole and invalid input rejects rather than
 * becoming U+FFFD (#3675). Backspace removes one code point, never half a
 * surrogate pair; a combining accent or a ZWJ emoji part goes one at a time.
 */

/** readHidden's rejection messages: Ctrl-C, and bytes that are not valid UTF-8. */
const INTERRUPTED = "interrupted";
const NOT_UTF8 = "not UTF-8";

/* `esc` is 0 outside an escape sequence; 1 after ESC; 2 inside `ESC [` or
 * `ESC O`, which the first byte in @..~ ends. */
/** @typedef {{ value: string, esc: 0 | 1 | 2 }} HiddenLine The line so far. */

/**
 * @param {Pick<NodeJS.ReadStream, "setRawMode" | "on" | "removeListener" | "pause" | "resume">} input
 * @returns {Promise<string>} rejects with INTERRUPTED on Ctrl-C and NOT_UTF8
 *   on bytes that are not valid UTF-8
 */
function readHidden(input) {
	return new Promise((resolve, reject) => {
		/** @type {HiddenLine} */
		const line = { value: "", esc: 0 };
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const done = (/** @type {string | null} */ failure) => {
			input.setRawMode(false);
			input.pause();
			input.removeListener("data", onData);
			if (failure === null) resolve(line.value);
			else reject(new Error(failure));
		};
		const onData = (/** @type {Buffer|string} */ chunk) => {
			let text;
			try {
				text = decoder.decode(Buffer.from(chunk), { stream: true });
			} catch {
				return done(NOT_UTF8);
			}
			for (const ch of text) {
				const outcome = readChar(line, ch);
				if (outcome !== null)
					return done(outcome === "interrupt" ? INTERRUPTED : null);
			}
		};
		input.setRawMode(true);
		input.on("data", onData);
		input.resume();
	});
}

/**
 * @param {HiddenLine} line accumulator: the line being read, advanced one character
 * @param {string} ch
 * @returns {"end" | "interrupt" | null} null while the line is still open
 */
function readChar(line, ch) {
	if (line.esc !== 0) {
		line.esc = escStateAfter(line.esc, ch);
		return null;
	}
	if (ch === "\x1b") {
		line.esc = 1;
		return null;
	}
	if (ch === "\r" || ch === "\n" || ch === "\x04") return "end";
	if (ch === "\x03") return "interrupt";
	if (ch === "\x7f" || ch === "\b")
		line.value = line.value.replace(/[\s\S]$/u, "");
	else if (ch >= " ") line.value += ch;
	return null;
}

/**
 * @param {1 | 2} esc
 * @param {string} ch
 * @returns {0 | 1 | 2}
 */
function escStateAfter(esc, ch) {
	if (esc === 1) return ch === "[" || ch === "O" ? 2 : 0;
	return ch >= "@" && ch <= "~" ? 0 : 2;
}

module.exports = { NOT_UTF8, readHidden };
