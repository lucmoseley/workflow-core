/*
 * refill-panel-print.js — the panel's frame as the plain text a pane of a given size
 * shows, and the size of every panel running now (#4114). A session checks what the
 * founder would read through `refill-panel.js --print`, never a throwaway script.
 *
 * The screen is read off lib/refill-panel.js's own frame, cursor moves and erases
 * applied, so a wrap or a cut the pane would show shows here. One cell per code
 * point: a wide character's second cell is not modelled.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { procRoot } = require("./proc-root.js");
const { readProcTable } = require("./proc-table.js");

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
 */

/**
 * Every running panel's terminal and its size, read the way `stty -F <tty> size`
 * reads it; a panel whose terminal will not read is left out.
 * @param {{root?: string, readSize?: (tty: string) => string}} [deps]
 * @returns {PanelSize[]}
 */
function findPanelSizes({
	root = procRoot(),
	readSize = (tty) =>
		execFileSync("stty", ["-F", tty, "size"], { encoding: "utf8" }),
} = {}) {
	const table = readProcTable(root);
	if (!table) return [];
	/** @type {PanelSize[]} */
	const found = [];
	for (const { pid, argv } of table.procs.values()) {
		const [, script, ...rest] = argv;
		if (path.basename(script ?? "") !== PANEL_SCRIPT) continue;
		if (rest.includes("--print")) continue;
		try {
			const tty = fs.readlinkSync(path.join(root, String(pid), "fd", "1"));
			const [rows, columns] = readSize(tty).trim().split(/\s+/).map(Number);
			if (rows && columns) found.push({ pid, tty, rows, columns });
		} catch {
			/* Another user's panel, or one gone mid-read. */
		}
	}
	return found.sort((a, b) => a.pid - b.pid);
}

module.exports = { buildScreenLines, findPanelSizes };
