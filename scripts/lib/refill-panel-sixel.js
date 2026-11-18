/*
 * refill-panel-sixel.js — the refill loop's panel's switches and tick boxes as Sixel
 * images at WinUI's geometry (workflow-core#3885, spec workflow-core#3596 story 76, ruling workflow-core#2525): a 40×20
 * track with round ends, a 12 px knob inset 4 px (14 px on hover), a 1 px outline when
 * off and an I/O mark; a 20×20 box. Windows Terminal maps Sixel to a 10×20 virtual
 * cell, so these are 4 cells and 2 cells by one row.
 *
 * Ground pixels stay unpainted, so an image takes the terminal's own background.
 * Anti-aliased edges blend towards the dark ground below: on a lighter background they
 * would fringe, as the panel's white text would already be unreadable there.
 *
 * WinUI states no figure for the marks. The I, the O, the tick and the box's radius are
 * the prototype's, drawn by eye (workflow-core#2525); the failed mark and the disabled
 * dash are untraced first guesses.
 */

const { ESC } = require("./refill-panel-input.js");

/** @typedef {[number, number, number]} Rgb */
/**
 * @typedef {import("./refill-panel.js").SwitchState} SwitchState
 * @typedef {import("./refill-panel.js").BoxState} BoxState
 */

const VIRTUAL_CELL_WIDTH = 10;
const SWITCH_WIDTH = 40;
const IMAGE_HEIGHT = 20;
const BOX_WIDTH = 20;
const TRACK_RADIUS = IMAGE_HEIGHT / 2;
const KNOB_DIAMETER = 12;
const KNOB_HOVER_DIAMETER = 14;
const OUTLINE_WIDTH = 1;
const BOX_RADIUS = 4;
/* Sub-samples per pixel side, as the prototype drew them (workflow-core#2525). */
const SUPERSAMPLE = 4;
const I_MARK_X = 13;
const I_MARK_HALF_LENGTH = 4;
const O_MARK_X = 28;
const O_MARK_RADIUS = 3.25;
const MARK_HALF_STROKE = 0.75;
/* The failed mark's bar and dot, top and bottom. */
/** @type {[number, number]} */
const FAILED_BAR = [4, 12];
/** @type {[number, number]} */
const FAILED_DOT = [14, 16];
/** @typedef {[number, number]} Point */
/** @type {[Point, Point, Point]} */
const TICK = [
	[5.5, 10.5],
	[8.5, 13.5],
	[14.5, 6.5],
];
const TICK_HALF_STROKE = 1.1;
/** @type {[Point, Point]} */
const DASH = [
	[6, 10],
	[14, 10],
];
const DASH_HALF_STROKE = 1;
const SIXEL_BAND = 6;
const SIXEL_OFFSET = 63;

/* The prototype's colours (workflow-core#2525): white, as the panel's names and values; no blue, and
 * no yellow, which means only "needs you". */
/** @type {Rgb} */
const GROUND = [0x0c, 0x0c, 0x0c];
/** @type {Rgb} */
const WHITE = [0xf2, 0xf2, 0xf2];
/** @type {Rgb} */
const OUTLINE = [0xa0, 0xa0, 0xa0];
/** @type {Rgb} */
const KNOB_OFF = [0xc8, 0xc8, 0xc8];
/** @type {Rgb} */
const DIM_FILL = [0x8a, 0x8a, 0x8a];
/** @type {Rgb} */
const DIM_LINE = [0x6e, 0x6e, 0x6e];
/* A ticked box's fill under the pointer: one hover signal, a fill step (workflow-core#2525). */
/** @type {Rgb} */
const HOVER_FILL = [0xd0, 0xd0, 0xd0];

/** @param {number} channel */
const toSixelPercent = (channel) => Math.round(channel / 2.55);

/**
 * One register's sixels across one band, or null where it paints none there.
 * @param {number[]} indexes each pixel's register, -1 for unpainted
 * @param {number} register
 * @param {number} top
 * @param {{width: number, height: number}} size
 */
function buildBandLine(indexes, register, top, { width, height }) {
	let line = "";
	for (let x = 0; x < width; x++) {
		let bits = 0;
		const depth = Math.min(SIXEL_BAND, height - top);
		for (let d = 0; d < depth; d++)
			if (indexes[(top + d) * width + x] === register) bits |= 1 << d;
		line += String.fromCharCode(SIXEL_OFFSET + bits);
	}
	if (!/[^?]/.test(line)) return null;
	return `#${register}${line.replace(/(.)\1{3,}/g, (run, char) => `!${run.length}${char}`)}`;
}

/**
 * `pixels` in reading order, null for a pixel left unpainted. No graphics new line
 * follows the last band, which would move the sixel cursor down a band more.
 * @param {number} width
 * @param {number} height
 * @param {(Rgb|null)[]} pixels
 */
function encodeSixel(width, height, pixels) {
	/** @type {Map<string, number>} */
	const registers = new Map();
	const indexes = pixels.map((rgb) => {
		if (!rgb) return -1;
		const key = rgb.join(";");
		const known = registers.get(key);
		if (known !== undefined) return known;
		const register = registers.size;
		registers.set(key, register);
		return register;
	});
	const palette = [...registers.keys()].map((key, i) => {
		const [r, g, b] = key.split(";").map(Number).map(toSixelPercent);
		return `#${i};2;${r};${g};${b}`;
	});
	const bands = [];
	for (let top = 0; top < height; top += SIXEL_BAND) {
		const lines = [...registers.values()].flatMap(
			(register) =>
				buildBandLine(indexes, register, top, { width, height }) ?? [],
		);
		bands.push(lines.join("$"));
	}
	return `${ESC}P0;1;0q"1;1;${width};${height}${palette.join("")}${bands.join("-")}${ESC}\\`;
}

/**
 * The mean of `paint` over a pixel; null where that is the ground, left unpainted.
 * @param {number} x
 * @param {number} y
 * @param {(x: number, y: number) => Rgb} paint the colour at a sub-pixel point
 * @returns {Rgb|null}
 */
function buildPixel(x, y, paint) {
	/** @type {Rgb} */
	const sum = [0, 0, 0];
	for (let sy = 0; sy < SUPERSAMPLE; sy++)
		for (let sx = 0; sx < SUPERSAMPLE; sx++) {
			const colour = paint(
				x + (sx + 0.5) / SUPERSAMPLE,
				y + (sy + 0.5) / SUPERSAMPLE,
			);
			sum[0] += colour[0];
			sum[1] += colour[1];
			sum[2] += colour[2];
		}
	const samples = SUPERSAMPLE * SUPERSAMPLE;
	/** @type {Rgb} */
	const mean = [
		Math.round(sum[0] / samples),
		Math.round(sum[1] / samples),
		Math.round(sum[2] / samples),
	];
	return mean.join() === GROUND.join() ? null : mean;
}

/**
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => Rgb} paint
 */
function rasterise(width, height, paint) {
	/** @type {(Rgb|null)[]} */
	const pixels = [];
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) pixels.push(buildPixel(x, y, paint));
	return encodeSixel(width, height, pixels);
}

/**
 * Signed distance to a rounded rectangle from the origin: negative inside.
 * @param {number} x
 * @param {number} y
 * @param {{width: number, radius: number}} shape as tall as an image
 */
function roundedRectDistance(x, y, { width, radius }) {
	const dx = Math.max(radius - x, 0, x - (width - radius));
	const dy = Math.max(radius - y, 0, y - (IMAGE_HEIGHT - radius));
	return Math.hypot(dx, dy) - radius;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {[number, number]} a
 * @param {[number, number]} b
 */
function segmentDistance(x, y, [ax, ay], [bx, by]) {
	const vx = bx - ax;
	const vy = by - ay;
	const along = ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy);
	const t = Math.min(Math.max(along, 0), 1);
	return Math.hypot(x - ax - t * vx, y - ay - t * vy);
}

/**
 * What a switch state draws. A pressable state's knob grows on hover; a state with no
 * knob, or a press in flight, has nothing to grow. `mark`, the state's sign.
 * @type {Record<SwitchState, {outline: Rgb, fill?: Rgb, knob?: {centre: number, colour: Rgb, grows: boolean},
 *   mark?: (x: number, y: number) => Rgb|null}>}
 */
const SWITCH_LOOKS = {
	on: {
		outline: WHITE,
		fill: WHITE,
		knob: {
			centre: SWITCH_WIDTH - TRACK_RADIUS,
			colour: GROUND,
			grows: true,
		},
		mark: (x, y) =>
			Math.abs(x - I_MARK_X) <= MARK_HALF_STROKE &&
			Math.abs(y - TRACK_RADIUS) <= I_MARK_HALF_LENGTH
				? GROUND
				: null,
	},
	off: {
		outline: OUTLINE,
		knob: { centre: TRACK_RADIUS, colour: KNOB_OFF, grows: true },
		mark: (x, y) =>
			Math.abs(Math.hypot(x - O_MARK_X, y - TRACK_RADIUS) - O_MARK_RADIUS) <=
			MARK_HALF_STROKE
				? OUTLINE
				: null,
	},
	pending: {
		outline: DIM_LINE,
		knob: { centre: SWITCH_WIDTH / 2, colour: DIM_FILL, grows: false },
	},
	unknown: { outline: DIM_LINE },
	failed: {
		outline: WHITE,
		mark: (x, y) =>
			Math.abs(x - SWITCH_WIDTH / 2) <= 1 &&
			((y >= FAILED_BAR[0] && y <= FAILED_BAR[1]) ||
				(y >= FAILED_DOT[0] && y <= FAILED_DOT[1]))
				? WHITE
				: null,
	},
};

/**
 * @param {SwitchState} state
 * @param {boolean} hovered
 */
function buildSwitchImage(state, hovered) {
	const { outline, fill, knob, mark } = SWITCH_LOOKS[state];
	const knobRadius =
		(hovered && knob?.grows ? KNOB_HOVER_DIAMETER : KNOB_DIAMETER) / 2;
	return rasterise(SWITCH_WIDTH, IMAGE_HEIGHT, (x, y) => {
		const edge = roundedRectDistance(x, y, {
			width: SWITCH_WIDTH,
			radius: TRACK_RADIUS,
		});
		if (edge > 0) return GROUND;
		if (knob && Math.hypot(x - knob.centre, y - TRACK_RADIUS) <= knobRadius)
			return knob.colour;
		const signed = mark?.(x, y);
		if (signed) return signed;
		if (fill) return fill;
		return edge > -OUTLINE_WIDTH ? outline : GROUND;
	});
}

/**
 * What a box state draws; `hover`, its colour under the pointer where a press would act.
 * @type {Record<BoxState, {colour: Rgb, hover?: Rgb, filled?: boolean, tick?: boolean, dash?: boolean}>}
 */
const BOX_LOOKS = {
	ticked: { colour: WHITE, hover: HOVER_FILL, filled: true, tick: true },
	unticked: { colour: OUTLINE, hover: WHITE },
	pending: { colour: DIM_FILL, filled: true },
	disabled: { colour: DIM_LINE, dash: true },
};

/**
 * @param {BoxState} state
 * @param {boolean} hovered
 */
function buildBoxImage(state, hovered) {
	const { colour, hover, filled, tick, dash } = BOX_LOOKS[state];
	const drawn = (hovered && hover) || colour;
	return rasterise(BOX_WIDTH, IMAGE_HEIGHT, (x, y) => {
		const edge = roundedRectDistance(x, y, {
			width: BOX_WIDTH,
			radius: BOX_RADIUS,
		});
		if (edge > 0) return GROUND;
		if (
			tick &&
			Math.min(
				segmentDistance(x, y, TICK[0], TICK[1]),
				segmentDistance(x, y, TICK[1], TICK[2]),
			) <= TICK_HALF_STROKE
		)
			return GROUND;
		if (filled) return drawn;
		if (dash && segmentDistance(x, y, DASH[0], DASH[1]) <= DASH_HALF_STROKE)
			return drawn;
		return edge > -OUTLINE_WIDTH ? drawn : GROUND;
	});
}

/** @type {Map<string, {cells: number, sixel: string}>} */
const images = new Map();

/**
 * A control's image and the cells it covers.
 * @param {{id: "repo", state: BoxState} | {id: "loop"|"away"|"burn"|"goal", state: SwitchState}} control
 * @param {boolean} hovered
 */
function buildControlImage(control, hovered) {
	const key = `${control.id === "repo"}:${control.state}:${hovered}`;
	const known = images.get(key);
	if (known) return known;
	const image =
		control.id === "repo"
			? {
					cells: BOX_WIDTH / VIRTUAL_CELL_WIDTH,
					sixel: buildBoxImage(control.state, hovered),
				}
			: {
					cells: SWITCH_WIDTH / VIRTUAL_CELL_WIDTH,
					sixel: buildSwitchImage(control.state, hovered),
				};
	images.set(key, image);
	return image;
}

module.exports = { buildControlImage };
