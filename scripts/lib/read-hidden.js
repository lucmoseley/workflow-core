// guess, #3817
const SETTLE_MS = 500;

const CONTROL = /\p{Cc}/u;

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

const LINE_ENDS = new Map([
	["\r", "end"],
	["\n", "end"],
	["\x03", INTERRUPTED],
	["\x04", EOF_KEY],
]);

const LINE_END_BYTES = new Set(
	Array.from(LINE_ENDS.keys(), (ch) => ch.charCodeAt(0)),
);

/** @typedef {{ value: string, esc: 0 | 1 | 2, stray: boolean, notUtf8: boolean }} HiddenLine */

/** @typedef {{ why: string | null, lineEnd: string }} Ending */

/**
 * @param {Pick<NodeJS.ReadStream, "setRawMode" | "on" | "removeListener" | "pause" | "resume">} input
 * @returns {Promise<string>}
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
 * @param {HiddenLine} line
 * @param {TextDecoder} decoder
 * @param {Buffer} bytes
 * @returns {Ending | null}
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
 * @param {TextDecoder} decoder
 * @param {Buffer} bytes
 * @returns {string | null}
 */
function decodeStrict(decoder, bytes) {
	try {
		return decoder.decode(bytes, { stream: true });
	} catch {
		return null;
	}
}

/**
 * @param {Ending} ending
 * @param {string} rest
 */
function noteFollowing(ending, rest) {
	if (rest === "") return;
	const more =
		ending.lineEnd === "\r" && rest.startsWith("\n") ? rest.slice(1) : rest;
	ending.lineEnd = "";
	if (more !== "" && ending.why === null) ending.why = MULTI_LINE;
}

/**
 * @param {TextDecoder} decoder
 * @returns {string}
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
 * @param {HiddenLine} line
 * @param {string} ch
 * @returns {string | null}
 */
function readChar(line, ch) {
	const outcome = LINE_ENDS.get(ch);
	if (outcome !== undefined) return outcome;
	if (line.esc !== 0) advanceEscape(line, ch);
	else if (ch === "\x1b") line.esc = 1;
	else if (ch === "\x7f" || ch === "\b")
		line.value = line.value.replace(/[\s\S]$/u, "");
	else if (CONTROL.test(ch)) line.stray = true;
	else line.value += ch;
	return null;
}

/**
 * @param {HiddenLine} line
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

module.exports = { readHidden };
