/*
 * read-hidden.js — one line typed at a terminal with echo off, for a founder
 * entering a secret that must never reach the screen or the chat (#640).
 *
 * Raw mode is what turns echo off, so the line discipline's own editing goes
 * with it and is rebuilt here: Enter ends the line, backspace edits it, and an
 * arrow key's whole escape sequence is dropped, which would otherwise leave
 * `[D` inside the value. Ctrl-C and Ctrl-D reject.
 *
 * Bytes are decoded as strict UTF-8 across reads, so a character split
 * between two chunks arrives whole and invalid input rejects rather than
 * becoming U+FFFD (#3675). Backspace removes one code point, never half a
 * surrogate pair; a combining accent or a ZWJ emoji part goes one at a time.
 *
 * NO KEYSTROKE VANISHES INTO THE VALUE (#3817). Any other control byte, a tab,
 * Ctrl-U, a NUL or an ESC outside a complete `ESC [` or `ESC O` sequence, would
 * leave a value other than the one given, unseen. Each rejects, at the line end
 * rather than the key, since rejecting at the key would hand the rest of a value
 * still being typed to the shell.
 *
 * NOR DOES A BYTE THAT IS NOT UTF-8 END THE READ (#3826). Raw mode holds and all
 * input is discarded to the line end, and no silence ends that wait: a typist's
 * pause outlasts SETTLE_MS, and echo returning then would show the secret's tail
 * and hand it to the shell. Ctrl-C and Ctrl-D count as that line end and report the bad byte,
 * the cause the next attempt in that terminal would meet too.
 *
 * NO BYTE IS LEFT FOR THE SHELL (#3817). Whatever ends the read, raw mode stays
 * on and input is read and thrown away until the terminal has been silent for
 * SETTLE_MS, since a paste arrives in several reads and Node has no `tcflush`.
 * Anything after the line end but one LF after a CR, as Enter or a pasted CRLF
 * gives, rejects: the first line of a pasted key is not the key. Residual: a
 * paste stalling longer than SETTLE_MS stores what came before the stall,
 * replacing any old value, and spills the rest to the shell; after a rejected
 * line it stores nothing and spills the same. `write-secret.js`
 * refuses a PEM header alone, the likeliest such first line.
 *
 * A TERMINAL THAT CLOSES before the read finishes rejects (#3817). A read error
 * is how a closed pty master arrives, and restoring raw mode on it emits
 * another, so the `error` listener stays on for the life of the stream.
 *
 * Each rejection's message is the reason `write-secret.js` prints, and holds
 * nothing of the value.
 */

/* Untraced: long enough that a paste's reads run together, short enough not to
 * matter after Enter at a prompt run by hand. A key typed inside it is refused
 * and re-run. */
const SETTLE_MS = 500;

const INTERRUPTED = "interrupted. Re-run to enter the value.";
const NOT_UTF8 =
	"the typed value holds bytes that are not valid UTF-8, as a terminal set to another encoding sends. Set the terminal to UTF-8, then re-run.";
const MULTI_LINE =
	"more input followed the line end, as a multi-line paste sends, and one line cannot carry it. Re-run and give the value on one line.";
const STRAY =
	"the input held a tab, a control key or a broken escape sequence, which a hidden prompt cannot show you. Re-run and give the value without one.";
const EOF_KEY =
	"Ctrl-D ended the input before Enter, so the value may be cut short. Re-run and finish it with Enter.";
const CLOSED =
	"the terminal closed before the read finished. Re-run to enter the value.";

/** Each character that closes the line, and "end" or the rejection it brings. */
const LINE_ENDS = new Map([
	["\r", "end"],
	["\n", "end"],
	["\x03", INTERRUPTED],
	["\x04", EOF_KEY],
]);

/* LINE_ENDS as bytes. None can sit inside a multibyte character in UTF-8 or in
 * the legacy encodings that send invalid UTF-8. */
const LINE_END_BYTES = new Set(
	Array.from(LINE_ENDS.keys(), (ch) => ch.charCodeAt(0)),
);

/* `esc` is 0 outside an escape sequence; 1 after ESC; 2 inside `ESC [` or
 * `ESC O`, which the first byte in @..~ ends. `stray` is set once a key the
 * value cannot carry has been dropped, `notUtf8` once a byte has failed to
 * decode. */
/** @typedef {{ value: string, esc: 0 | 1 | 2, stray: boolean, notUtf8: boolean }} HiddenLine The line so far. */

/* How the read ended: `why` is the rejection or null, and `lineEnd` the
 * character that ended the line, until any input follows it. */
/** @typedef {{ why: string | null, lineEnd: string }} Ending */

/**
 * @param {Pick<NodeJS.ReadStream, "setRawMode" | "on" | "removeListener" | "pause" | "resume">} input
 * @returns {Promise<string>} rejects with the reason to print
 */
function readHidden(input) {
	return new Promise((resolve, reject) => {
		/** @type {HiddenLine} */
		const line = { value: "", esc: 0, stray: false, notUtf8: false };
		const decoder = new TextDecoder("utf-8", { fatal: true });
		/** @type {Ending | null} */
		let ending = null;
		let finished = false;
		/** @type {NodeJS.Timeout | undefined} */
		let settling;
		const finish = () => {
			if (finished) return;
			finished = true;
			clearTimeout(settling);
			input.removeListener("data", onData);
			input.removeListener("end", onClosed);
			input.setRawMode(false);
			input.pause();
			const why = ending === null ? CLOSED : ending.why;
			if (why === null) resolve(line.value);
			else reject(new Error(why));
		};
		const onClosed = () => {
			if (ending?.why === null) ending.why = CLOSED;
			finish();
		};
		const onData = (/** @type {Buffer|string} */ chunk) => {
			const bytes = Buffer.from(chunk);
			if (ending === null) ending = readChunk(line, decoder, bytes);
			else noteFollowing(ending, bytes.toString("latin1"));
			if (ending === null) return;
			clearTimeout(settling);
			settling = setTimeout(finish, SETTLE_MS);
		};
		input.setRawMode(true);
		input.on("data", onData);
		input.on("end", onClosed);
		input.on("error", onClosed);
		input.resume();
	});
}

/**
 * @param {HiddenLine} line accumulator: the line being read
 * @param {TextDecoder} decoder accumulator: flushed once the line ends
 * @param {Buffer} bytes
 * @returns {Ending | null} null while the line is still open
 */
function readChunk(line, decoder, bytes) {
	const text = line.notUtf8 ? null : decodeStrict(decoder, bytes);
	if (text === null) {
		line.notUtf8 = true;
		return bytes.some((b) => LINE_END_BYTES.has(b))
			? { why: NOT_UTF8, lineEnd: "" }
			: null;
	}
	let read = 0;
	for (const ch of text) {
		read += ch.length;
		const outcome = readChar(line, ch);
		if (outcome === null) continue;
		if (outcome !== "end") return { why: outcome, lineEnd: "" };
		const ending = {
			why: line.stray || line.esc !== 0 ? STRAY : null,
			lineEnd: ch,
		};
		noteFollowing(ending, text.slice(read) + flushDecoder(decoder));
		return ending;
	}
	return null;
}

/**
 * @param {TextDecoder} decoder accumulator: holds a split character for the next read
 * @param {Buffer} bytes
 * @returns {string | null} null where the bytes are not valid UTF-8
 */
function decodeStrict(decoder, bytes) {
	try {
		return decoder.decode(bytes, { stream: true });
	} catch {
		return null;
	}
}

/**
 * @param {Ending} ending accumulator: rejected once more than the line end's LF follows
 * @param {string} rest what followed
 */
function noteFollowing(ending, rest) {
	if (rest === "") return;
	const more =
		ending.lineEnd === "\r" && rest.startsWith("\n") ? rest.slice(1) : rest;
	ending.lineEnd = "";
	if (more !== "" && ending.why === null) ending.why = MULTI_LINE;
}

/**
 * Ends the decoder's stream.
 * @param {TextDecoder} decoder accumulator: left with nothing held
 * @returns {string} a character standing for an unfinished one it held, else ""
 */
function flushDecoder(decoder) {
	try {
		decoder.decode();
		return "";
	} catch {
		return "\ufffd";
	}
}

/**
 * @param {HiddenLine} line accumulator: the line being read, advanced one character
 * @param {string} ch
 * @returns {string | null} "end" at the line end, the rejection at a key that
 *   ends the read without one, null while the line is still open
 */
function readChar(line, ch) {
	const outcome = LINE_ENDS.get(ch);
	if (outcome !== undefined) return outcome;
	if (line.esc !== 0) advanceEscape(line, ch);
	else if (ch === "\x1b") line.esc = 1;
	else if (ch === "\x7f" || ch === "\b")
		line.value = line.value.replace(/[\s\S]$/u, "");
	else if (ch >= " ") line.value += ch;
	else line.stray = true;
	return null;
}

/**
 * @param {HiddenLine} line accumulator: its escape state, and `stray` where
 *   `ch` breaks the sequence
 * @param {string} ch
 */
function advanceEscape(line, ch) {
	if (line.esc === 1 && (ch === "[" || ch === "O")) {
		line.esc = 2;
		return;
	}
	if (line.esc === 2 && ch >= " " && ch < "@") return;
	if (line.esc === 1 || ch < "@" || ch > "~") line.stray = true;
	line.esc = 0;
}

module.exports = { readHidden, SETTLE_MS };
