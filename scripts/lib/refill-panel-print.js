/*
 * refill-panel-print.js — the panel's frame as the plain text a pane of a given size
 * shows, and the size of every panel running now (#4114). A session checks what the
 * founder would read through `refill-panel.js --print`, never a throwaway script:
 * one status read, drawn at each size asked for.
 *
 * The screen is read off lib/refill-panel.js's own frame, cursor moves and erases
 * applied, so a wrap or a cut the pane would show shows here. One cell per code
 * point: a wide character's second cell is not modelled.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { procRoot } = require("./proc-root.js");
const { readProcTable } = require("./proc-table.js");
const {
	buildFrame,
	countUnscrolledHeight,
	createPanel,
} = require("./refill-panel.js");

const PANEL_SCRIPT = "refill-panel.js";

/* A control sequence, its parameters and final byte; a Sixel image to its terminator,
 * ESC \; any other escape; or one printed character. */
const TOKEN =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the escapes are what is read.
	/\u001b\[([0-9;?]*)([@-~])|\u001bP[\s\S]*?\u001b\\|\u001b[\s\S]?|([\s\S])/gu;

/**
 * A blank screen of `height` rows and its cursor.
 * @param {number} height
 */
function createScreen(height) {
	/** @type {string[][]} */
	const rows = Array.from({ length: height }, () => []);
	let row = 0;
	let col = 0;
	return {
		/** @param {string} ch */
		put(ch) {
			const line = rows[row];
			if (line) {
				while (line.length < col) line.push(" ");
				line[col] = ch;
			}
			col++;
		},
		/** @param {string} params `row;column`, 1-based */
		move(params) {
			const [r = 1, c = 1] = params.split(";").map((n) => Number(n) || 1);
			row = r - 1;
			col = c - 1;
		},
		/** @param {boolean} below with every row under the cursor's, as `ESC [J` */
		erase(below) {
			rows[row]?.splice(col);
			if (below) for (let r = row + 1; r < height; r++) rows[r] = [];
		},
		lines: () => rows.map((line) => line.join("").trimEnd()),
	};
}

/**
 * The lines a terminal of `height` rows shows after drawing `frame` on a blank screen,
 * each with its trailing blanks cut, and the blank lines below the last cut too.
 * @param {string} frame
 * @param {number} height
 * @returns {string[]}
 */
function buildScreenLines(frame, height) {
	const screen = createScreen(height);
	for (const [, params = "", final, printed] of frame.matchAll(TOKEN)) {
		if (printed !== undefined) screen.put(printed);
		else if (final === "H") screen.move(params);
		else if (final === "K" || final === "J") screen.erase(final === "J");
	}
	const lines = screen.lines();
	while (lines.at(-1) === "") lines.pop();
	return lines;
}

/**
 * @typedef {{pid: number, tty: string, rows: number, columns: number}} PanelSize
 * @typedef {{pid: number, why: string}} UnsizedPanel
 */

/**
 * Every running panel's terminal and its size, read the way `stty -F <tty> size`
 * reads it, and each panel whose terminal would not read, with why: another user's,
 * or one gone mid-read.
 * @param {{root?: string, readSize?: (tty: string) => string}} [deps]
 * @returns {{sizes: PanelSize[], unsized: UnsizedPanel[]}}
 */
function findPanelSizes({
	root = procRoot(),
	readSize = (tty) =>
		execFileSync("stty", ["-F", tty, "size"], { encoding: "utf8" }),
} = {}) {
	/** @type {PanelSize[]} */
	const sizes = [];
	/** @type {UnsizedPanel[]} */
	const unsized = [];
	for (const { pid, argv } of readProcTable(root)?.procs.values() ?? []) {
		const [, script, ...rest] = argv;
		if (path.basename(script ?? "") !== PANEL_SCRIPT) continue;
		if (rest.includes("--print")) continue;
		try {
			const tty = fs.readlinkSync(path.join(root, String(pid), "fd", "1"));
			const [rows, columns] = readSize(tty).trim().split(/\s+/).map(Number);
			if (rows && columns) sizes.push({ pid, tty, rows, columns });
			else unsized.push({ pid, why: `${tty} reads no size` });
		} catch (err) {
			unsized.push({ pid, why: caught(err).message.split("\n")[0] ?? "" });
		}
	}
	return { sizes: sizes.sort((a, b) => a.pid - b.pid), unsized };
}

/**
 * The screen at each size from one status read, a size's own heading only where
 * there are several, and why the read failed, or null.
 * @param {{columns: number, rows: number|null, pid?: number, tty?: string}[]} sizes
 *   `rows` null for every row
 * @param {{run: import("./refill-panel.js").Runner,
 *   runBurn: import("./refill-panel.js").Runner, now: () => number}} deps
 * @returns {Promise<{text: string, readError: string|null}>}
 */
async function buildScreensText(sizes, { run, runBurn, now }) {
	let columns = 0;
	const panel = createPanel({
		run,
		runBurn,
		now,
		resolveTopic: async () => {
			throw new Error("a print resolves no topic");
		},
		returnFocus: async () => ({ code: 0, stdout: "", stderr: "" }),
		height: () => 0,
		columns: () => columns,
		onChange: () => {
			/* A print draws once, after its read. */
		},
	});
	await panel.refreshStatus();
	const screens = sizes.map((size) => {
		columns = size.columns;
		const rows = panel.buildViewRows();
		const height = size.rows ?? countUnscrolledHeight(rows.length);
		const lines = buildScreenLines(buildFrame(rows, columns, height), height);
		const heading =
			sizes.length > 1
				? [`── panel ${size.pid} on ${size.tty}, ${size.rows}×${columns} ──`]
				: [];
		return [...heading, ...lines].join("\n");
	});
	return { text: `${screens.join("\n\n")}\n`, readError: panel.view.readError };
}

module.exports = { buildScreenLines, buildScreensText, findPanelSizes };
