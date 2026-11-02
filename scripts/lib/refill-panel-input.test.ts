/*
 * The panel's raw input (#3873, #3883): which bytes are clicks and which are keys,
 * across chunks. Broken, a click presses nothing, or a stray sequence types into or
 * cancels a goal being edited.
 */
import { describe, expect, it } from "vitest";

const { ESC, createInputReader } = require("./refill-panel-input.js");

describe("the mouse reader", () => {
	const report = (button: number, col: number, row: number, kind: string) =>
		`${ESC}[<${button};${col};${row}${kind}`;

	it("takes a release in the pressed cell as a click, the first press included", () => {
		const { read } = createInputReader();
		expect(read(report(0, 5, 2, "M") + report(0, 5, 2, "m")).clicks).toEqual([
			2,
		]);
	});

	it("acts on the release, not the press", () => {
		const { read } = createInputReader();
		expect(read(report(0, 5, 2, "M")).clicks).toEqual([]);
		expect(read(report(0, 5, 2, "m")).clicks).toEqual([2]);
	});

	it("ignores a release in another cell", () => {
		const { read } = createInputReader();
		expect(read(report(0, 5, 2, "M") + report(0, 6, 2, "m")).clicks).toEqual(
			[],
		);
	});

	it("ignores any other button and a release with no press", () => {
		const { read } = createInputReader();
		expect(read(report(2, 5, 2, "M") + report(2, 5, 2, "m")).clicks).toEqual(
			[],
		);
		expect(read(report(0, 5, 2, "m")).clicks).toEqual([]);
	});

	it("reads a report split across chunks", () => {
		const { read } = createInputReader();
		const whole = report(0, 5, 2, "M") + report(0, 5, 2, "m");
		expect(read(whole.slice(0, 13)).clicks).toEqual([]);
		expect(read(whole.slice(13)).clicks).toEqual([2]);
	});

	it("reports an interrupt on Ctrl+C, and neither that nor a click on typed keys", () => {
		const { read } = createInputReader();
		expect(read("x q ")).toMatchObject({ clicks: [], interrupted: false });
		expect(read(String.fromCharCode(3)).interrupted).toBe(true);
	});
});

describe("the key reader", () => {
	it("reads typed text, and takes no mouse report for text", () => {
		const { read } = createInputReader();
		const { keys, clicks } = read(`ab${ESC}[<0;5;2M${ESC}[<0;5;2mc`);
		expect(keys).toEqual([{ text: "ab" }, { text: "c" }]);
		expect(clicks).toEqual([2]);
	});

	it.each([
		["\r", "enter"],
		["\n", "enter"],
		[String.fromCharCode(127), "backspace"],
		["\b", "backspace"],
		[`${ESC}[D`, "left"],
		[`${ESC}[C`, "right"],
		[`${ESC}OD`, "left"],
		[`${ESC}[H`, "home"],
		[`${ESC}[1~`, "home"],
		[`${ESC}[F`, "end"],
		[`${ESC}[4~`, "end"],
		[`${ESC}[3~`, "delete"],
	])("names the key %j", (bytes, name) => {
		expect(createInputReader().read(bytes).keys).toEqual([{ name }]);
	});

	it.each([
		["an arrow it has no use for", `${ESC}[A`],
		["Alt and an arrow", `${ESC}[1;3C`],
		["a function key", `${ESC}[15~`],
		["Alt and a letter", `${ESC}b`],
		["a terminal's private report", `${ESC}[?1;2c`],
		["tab", "\t"],
	])("drops %s, which neither cancels nor types", (_, bytes) => {
		const { read } = createInputReader();
		expect(read(bytes)).toMatchObject({ keys: [], held: false });
	});

	it("holds a lone escape until the flush says it was the Esc key", () => {
		const { read, flush } = createInputReader();
		expect(read(ESC)).toMatchObject({ keys: [], held: true });
		expect(flush()).toEqual([{ name: "escape" }]);
		expect(read("x")).toMatchObject({ keys: [{ text: "x" }], held: false });
	});

	it("reads a sequence split after its escape as that sequence", () => {
		const { read } = createInputReader();
		read(ESC);
		expect(read("[D").keys).toEqual([{ name: "left" }]);
	});

	it("drops a flushed part of a sequence, and its tail when that comes", () => {
		const { read, flush } = createInputReader();
		read(`${ESC}[<0;5`);
		expect(flush()).toEqual([]);
		expect(read(";5Mx").keys).toEqual([{ text: "x" }]);
		expect(read(";5M").keys).toEqual([{ text: ";5M" }]);
	});

	it("takes a newline in a bracketed paste as a space, and after it as Enter", () => {
		const { read } = createInputReader();
		expect(read(`${ESC}[200~a\r\nb${ESC}[201~\r`).keys).toEqual([
			{ text: "a" },
			{ text: " " },
			{ text: " " },
			{ text: "b" },
			{ name: "enter" },
		]);
	});
});

describe("what the terminal answers", () => {
	const read = (bytes: string) => createInputReader().read(bytes);

	it("takes Sixel from device attributes carrying 4", () => {
		const reply = `${ESC}[?61;4;6;7;14;21;22;23;24;28;32;42;52c`;
		expect(read(reply).capabilities).toEqual(["sixel"]);
		expect(read(reply).keys).toEqual([]);
	});

	it.each(["?61;6;7;22c", "?64;14c", "?1;2c"])(
		"takes no Sixel from attributes without 4: %s",
		(params) => {
			expect(read(`${ESC}[${params}`).capabilities).toEqual([]);
		},
	);

	it("takes the 10×20 cell, and no other", () => {
		expect(read(`${ESC}[6;20;10t`).capabilities).toEqual(["cell10x20"]);
		expect(read(`${ESC}[6;16;8t`).capabilities).toEqual([]);
	});

	it("reads an answer split across chunks", () => {
		const reader = createInputReader();
		expect(reader.read(`${ESC}[?61;`).capabilities).toEqual([]);
		expect(reader.read("4c").capabilities).toEqual(["sixel"]);
	});
});

describe("the pointer", () => {
	it("reports motion's row, with no button or the left held", () => {
		const { read } = createInputReader();
		expect(read(`${ESC}[<35;5;7M`).moves).toEqual([7]);
		expect(read(`${ESC}[<32;5;8M`).moves).toEqual([8]);
	});

	it("keeps a press through motion, so it still clicks on release", () => {
		const { read } = createInputReader();
		read(`${ESC}[<0;5;7M`);
		read(`${ESC}[<32;5;7M`);
		expect(read(`${ESC}[<0;5;7m`).clicks).toEqual([7]);
	});

	it("takes neither a press nor a release as motion", () => {
		const { moves } = createInputReader().read(`${ESC}[<0;5;7M${ESC}[<0;5;7m`);
		expect(moves).toEqual([]);
	});

	it("reports the pane losing focus, and not gaining it", () => {
		const { read } = createInputReader();
		expect(read(`${ESC}[O`).focusLost).toBe(true);
		expect(read(`${ESC}[I`).focusLost).toBe(false);
	});
});
