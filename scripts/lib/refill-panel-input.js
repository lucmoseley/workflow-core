/*
 * refill-panel-input.js — the refill loop's panel's raw input stream, read across
 * chunks (#3873, #3883, #3885, #3887, spec #3596): SGR mouse reports (mode 1006), where a click is
 * a left release in the cell of the left press before it, the press that focused the
 * pane counting as the terminal reports it like any other, and a motion report moves
 * the hover and leaves that press alone; the terminal's answers about what it can draw;
 * the pane gaining and losing focus; and the keys the panel uses, any other sequence dropped.
 */

const ESC = String.fromCharCode(27);
const INTERRUPT = String.fromCharCode(3);

/** A control sequence's parameter and intermediate bytes (ECMA-48 §5.4). */
const PARAMS = "[0-?]*[ -/]*";
const INPUT_TOKEN = new RegExp(
	[
		`${ESC}\\[<(?<button>\\d+);(?<column>\\d+);(?<row>\\d+)(?<kind>[Mm])`,
		`${ESC}\\[(?<csi>${PARAMS}[@-~])`,
		`${ESC}O(?<ss3>[ -~])`,
		/* Alt and a key, which no field has a use for. */
		`${ESC}\\P{Cc}`,
		`(?<lone>${ESC})`,
		"(?<text>\\P{Cc}+)",
		"(?<control>\\p{Cc})",
	].join("|"),
	"gu",
);
const PARTIAL_INPUT = new RegExp(`${ESC}(\\[${PARAMS}|O)?$`);
const SEQUENCE_TAIL = new RegExp(`^${PARAMS}[@-~]`);
const LEFT_BUTTON = 0;
const MOTION_BIT = 32;
const PASTE_START = "200~";
const PASTE_END = "201~";
const FOCUS_IN = "I";
const FOCUS_OUT = "O";
/* A primary device attributes reply, and attribute 4, Sixel graphics (xterm ctlseqs). */
const DEVICE_ATTRIBUTES = /^\?[\d;]*c$/;
const SIXEL_ATTRIBUTE = "4";
/* `CSI 16 t`'s reply, height then width. Only the 10×20 cell fits the controls' images
 * to their cells (lib/refill-panel-sixel.js). */
const CELL_10_BY_20 = "6;20;10t";

/**
 * A key the panel can use. `pasted`: from a bracketed paste, so no one pressed it.
 * @typedef {{text: string, pasted?: boolean}
 *   | {name: "enter"|"escape"|"backspace"|"delete"|"up"|"down"|"left"|"right"|"home"|"end"}} Key
 */

/** @type {Record<string, Key>} */
const SEQUENCE_KEYS = {
	A: { name: "up" },
	B: { name: "down" },
	D: { name: "left" },
	C: { name: "right" },
	H: { name: "home" },
	F: { name: "end" },
	"1~": { name: "home" },
	"4~": { name: "end" },
	"3~": { name: "delete" },
};
/** @type {Key} */
const ENTER_KEY = { name: "enter" };
/** @type {Record<string, Key>} */
const CONTROL_KEYS = {
	"\r": ENTER_KEY,
	"\n": ENTER_KEY,
	"\x7f": { name: "backspace" },
	"\b": { name: "backspace" },
};
/** @type {Key} */
const ESCAPE_KEY = { name: "escape" };
/** @type {Key} */
const PASTED_NEWLINE = { text: " ", pasted: true };

/** @param {Key} key */
function buildPastedKey(key) {
	if (key === ENTER_KEY) return PASTED_NEWLINE;
	return "text" in key ? { ...key, pasted: true } : key;
}

/** @param {string|undefined} button */
const isMotion = (button) => (Number(button) & MOTION_BIT) !== 0;

/**
 * What a terminal's answer says it can do.
 * @param {string|undefined} csi
 * @returns {("sixel"|"cell10x20")[]}
 */
function parseCapabilities(csi) {
	if (csi === CELL_10_BY_20) return ["cell10x20"];
	if (!csi || !DEVICE_ATTRIBUTES.test(csi)) return [];
	return csi.slice(1, -1).split(";").includes(SIXEL_ATTRIBUTE) ? ["sixel"] : [];
}

/**
 * `held` says the stream stops on what may start a sequence: `flush` ends the wait, a
 * lone escape then reading as the Esc key, and a part of a sequence dropped with the
 * rest of it. A newline inside a bracketed paste is a space.
 */
function createInputReader() {
	let rest = "";
	let droppingTail = false;
	let pasting = false;
	/** @type {string|null} */
	let pressedCell = null;
	let missed = false;

	/**
	 * @param {Record<string, string|undefined>} report
	 * @returns {number[]} the row, where this report ends a click
	 */
	const takeReport = ({ button, column, row, kind }) => {
		if (isMotion(button)) return [];
		const left = Number(button) === LEFT_BUTTON;
		const cell = `${column};${row}`;
		if (kind === "M") {
			pressedCell = left ? cell : null;
			return [];
		}
		const clicked = left && pressedCell === cell;
		pressedCell = null;
		missed ||= !clicked;
		return clicked ? [Number(row)] : [];
	};

	/**
	 * @param {Record<string, string|undefined>} token
	 * @returns {Key[]}
	 */
	const takeKey = ({ lone, text, csi, ss3, control }) => {
		if (csi === PASTE_START || csi === PASTE_END) pasting = csi === PASTE_START;
		if (lone) return [ESCAPE_KEY];
		const key = text
			? { text }
			: (SEQUENCE_KEYS[csi ?? ss3 ?? ""] ?? CONTROL_KEYS[control ?? ""]);
		if (!key) return [];
		return [pasting ? buildPastedKey(key) : key];
	};

	return {
		/** @param {string} chunk */
		read(chunk) {
			const input =
				rest + (droppingTail ? chunk.replace(SEQUENCE_TAIL, "") : chunk);
			droppingTail = false;
			rest = PARTIAL_INPUT.exec(input)?.[0] ?? "";
			const tokens = [
				...input.slice(0, input.length - rest.length).matchAll(INPUT_TOKEN),
			].map((match) => match.groups ?? {});
			missed = false;
			const clicks = tokens.flatMap((t) => (t.kind ? takeReport(t) : []));
			const lastFocus = tokens.findLast(
				({ csi }) => csi === FOCUS_IN || csi === FOCUS_OUT,
			)?.csi;
			return {
				clicks,
				/* A button released with no click: a slip off its cell, or not the left one. */
				missed,
				moves: tokens.flatMap((t) =>
					t.kind && isMotion(t.button) ? [Number(t.row)] : [],
				),
				keys: tokens.flatMap((t) => (t.kind ? [] : takeKey(t))),
				capabilities: tokens.flatMap(({ csi }) => parseCapabilities(csi)),
				focusGained: lastFocus === FOCUS_IN,
				focusLost: lastFocus === FOCUS_OUT,
				interrupted: input.includes(INTERRUPT),
				held: rest !== "",
			};
		},
		/** @returns {Key[]} */
		flush() {
			const lone = rest === ESC;
			droppingTail = rest !== "" && !lone;
			rest = "";
			return lone ? [ESCAPE_KEY] : [];
		},
	};
}

module.exports = { ESC, createInputReader };
