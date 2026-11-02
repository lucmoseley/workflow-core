// @vitest-environment node
/*
 * The panel's controls as Sixel (#3885, spec #3596 story 76): each state's image,
 * decoded back to pixels, holds WinUI's geometry. Broken, a switch misreads its state
 * or stops fitting its four cells.
 */
import { describe, expect, it } from "vitest";

const { buildControlImage } = require("./refill-panel-sixel.js");

const ESC = String.fromCharCode(27);
const SIXEL_SIZE = 6;

interface Picture {
	width: number;
	height: number;
	registers: number;
	painted: (string | undefined)[][];
}

const HEAD = new RegExp(`^${ESC}P0;1;0q"1;1;(\\d+);(\\d+)`);

/** Paints one colour's sixels across a band. */
function paintLine(
	painted: Picture["painted"],
	{ top, sixels, colour }: { top: number; sixels: string; colour?: string },
) {
	let x = 0;
	for (const [token, run, char] of sixels.matchAll(/!(\d+)(.)|./g)) {
		const bits = (char ?? token).charCodeAt(0) - 63;
		const end = x + (run ? Number(run) : 1);
		for (; x < end; x++)
			for (let d = 0; d < SIXEL_SIZE; d++)
				if (bits & (1 << d) && painted[top + d]) painted[top + d][x] = colour;
	}
}

/** Reads a DCS image back, as a terminal would. */
function decode(sixel: string): Picture {
	const head = HEAD.exec(sixel);
	if (!head || !sixel.endsWith(`${ESC}\\`))
		throw new Error("not a Sixel image");
	const width = Number(head[1]);
	const height = Number(head[2]);
	const palette = new Map<string, string>();
	const body = sixel
		.slice(head[0].length, -2)
		.replace(/#(\d+);2;(\d+;\d+;\d+)/g, (_, i, rgb) => {
			palette.set(i, rgb.replaceAll(";", ","));
			return "";
		});
	const painted: Picture["painted"] = Array.from({ length: height }, () =>
		new Array(width).fill(undefined),
	);
	body.split("-").forEach((band, i) => {
		for (const line of band.split("$")) {
			const [, register = "", sixels = ""] = /^#(\d+)(.*)$/.exec(line) ?? [];
			paintLine(painted, {
				top: i * SIXEL_SIZE,
				sixels,
				colour: palette.get(register),
			});
		}
	});
	return { width, height, registers: palette.size, painted };
}

/** Each run of solid `colour` along a row, as [start, end). */
function runs(line: (string | undefined)[], colour: string | undefined) {
	const found: [number, number][] = [];
	let start = -1;
	line.forEach((value, x) => {
		const hit = value === colour;
		if (hit && start === -1) start = x;
		if (!hit && start !== -1) {
			found.push([start, x]);
			start = -1;
		}
	});
	if (start !== -1) found.push([start, line.length]);
	return found;
}

const MIDDLE = 10;
const WHITE = "95,95,95";
const OUTLINE = "63,63,63";
const KNOB_OFF = "78,78,78";
const DIM_FILL = "54,54,54";
const DIM_LINE = "43,43,43";

const switchImage = (state: string, hovered = false) =>
	buildControlImage({ id: "loop", state }, hovered);
const boxImage = (state: string, hovered = false) =>
	buildControlImage({ id: "repo", name: "wc", state }, hovered);

describe("the switch's images", () => {
	it.each(["on", "off", "pending", "unknown", "failed"])(
		"draws %s as a 40×20 image over 4 cells, in few enough colours",
		(state) => {
			const { cells, sixel } = switchImage(state);
			const picture = decode(sixel);
			expect(cells).toBe(4);
			expect([picture.width, picture.height]).toEqual([40, 20]);
			expect(picture.registers).toBeLessThanOrEqual(256);
		},
	);

	it("draws off as a 1 px outline, a 12 px knob inset 4 px on the left, and an O", () => {
		const { painted } = decode(switchImage("off").sixel);
		const middle = painted[MIDDLE];
		expect(middle[0]).toBe(OUTLINE);
		expect(middle[1]).toBeUndefined();
		expect(middle[39]).toBe(OUTLINE);
		expect(middle[38]).toBeUndefined();
		expect(runs(middle, KNOB_OFF)).toEqual([[4, 16]]);
		const ring = middle.slice(23, 33);
		expect(ring.filter(Boolean).length).toBeGreaterThan(0);
		expect(middle[28]).toBeUndefined();
	});

	it("grows off's knob to 14 px about the same centre on hover", () => {
		const { painted } = decode(switchImage("off", true).sixel);
		expect(runs(painted[MIDDLE], KNOB_OFF)).toEqual([[3, 17]]);
	});

	it("draws on as a filled track, a 12 px knob inset 4 px on the right, and an I", () => {
		const { painted } = decode(switchImage("on").sixel);
		const middle = painted[MIDDLE];
		expect(middle.slice(24, 36).every((p) => p === undefined)).toBe(true);
		expect(middle[23]).toBe(WHITE);
		expect(middle[36]).toBe(WHITE);
		expect(middle[39]).toBe(WHITE);
		expect(runs(middle.slice(10, 20), WHITE).length).toBe(2);
	});

	it("grows on's knob to 14 px on hover", () => {
		const { painted } = decode(switchImage("on", true).sixel);
		expect(painted[MIDDLE].slice(23, 37).every((p) => p === undefined)).toBe(
			true,
		);
		expect(painted[MIDDLE][22]).toBe(WHITE);
		expect(painted[MIDDLE][37]).toBe(WHITE);
	});

	it("draws pending as a dim track and a centred knob, hover or not", () => {
		const { painted } = decode(switchImage("pending").sixel);
		expect(painted[MIDDLE][0]).toBe(DIM_LINE);
		expect(runs(painted[MIDDLE], DIM_FILL)).toEqual([[14, 26]]);
		expect(switchImage("pending", true).sixel).toBe(
			switchImage("pending").sixel,
		);
	});

	it("draws unknown as a dim track with nothing in it", () => {
		const { painted } = decode(switchImage("unknown").sixel);
		expect(painted[MIDDLE][0]).toBe(DIM_LINE);
		expect(painted[MIDDLE].slice(1, 39).every((p) => p === undefined)).toBe(
			true,
		);
	});

	it("draws failed as a white track and a mark, with no knob to read as a side", () => {
		const { painted } = decode(switchImage("failed").sixel);
		expect(painted[MIDDLE][0]).toBe(WHITE);
		expect(runs(painted[MIDDLE], WHITE)).toEqual([
			[0, 1],
			[19, 21],
			[39, 40],
		]);
	});

	it("uses neither blue nor yellow: every colour is a grey", () => {
		const makers = [
			...["on", "off", "pending", "unknown", "failed"].map(
				(state) => (hovered: boolean) => switchImage(state, hovered),
			),
			...["ticked", "unticked", "pending", "disabled"].map(
				(state) => (hovered: boolean) => boxImage(state, hovered),
			),
		];
		for (const make of makers)
			for (const hovered of [false, true])
				for (const [, r, g, b] of make(hovered).sixel.matchAll(
					/;2;(\d+);(\d+);(\d+)/g,
				))
					expect(new Set([r, g, b]).size).toBe(1);
	});
});

describe("the tick box's images", () => {
	it.each(["ticked", "unticked", "pending", "disabled"])(
		"draws %s as a 20×20 image over 2 cells",
		(state) => {
			const { cells, sixel } = boxImage(state);
			const picture = decode(sixel);
			expect(cells).toBe(2);
			expect([picture.width, picture.height]).toEqual([20, 20]);
		},
	);

	it("draws unticked as a 1 px outline, brighter under the pointer", () => {
		const middle = decode(boxImage("unticked").sixel).painted[MIDDLE];
		expect(runs(middle, OUTLINE)).toEqual([
			[0, 1],
			[19, 20],
		]);
		const hovered = decode(boxImage("unticked", true).sixel).painted[MIDDLE];
		expect(runs(hovered, WHITE)).toEqual([
			[0, 1],
			[19, 20],
		]);
	});

	it("draws ticked as a filled box with a tick cut from it, the fill stepping on hover", () => {
		const { painted } = decode(boxImage("ticked").sixel);
		expect(painted[MIDDLE][0]).toBe(WHITE);
		expect(painted[13][8]).toBeUndefined();
		expect(painted[9][12]).toBeUndefined();
		const hovered = decode(boxImage("ticked", true).sixel).painted;
		expect(hovered[MIDDLE][0]).not.toBe(WHITE);
		expect(hovered[MIDDLE][0]).toBeDefined();
	});

	it("draws pending as a dim fill with no tick", () => {
		const { painted } = decode(boxImage("pending").sixel);
		expect(runs(painted[MIDDLE], DIM_FILL)).toEqual([[0, 20]]);
	});

	it("draws disabled as a dim outline and a dash, unchanged by hover", () => {
		const { painted } = decode(boxImage("disabled").sixel);
		expect(painted[MIDDLE][0]).toBe(DIM_LINE);
		expect(painted[MIDDLE].slice(6, 14).every((p) => p === DIM_LINE)).toBe(
			true,
		);
		expect(boxImage("disabled", true).sixel).toBe(boxImage("disabled").sixel);
	});
});
