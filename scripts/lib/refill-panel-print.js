const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { procRoot } = require("./proc-root.js");
const { readProcTable } = require("./proc-table.js");
const { noop } = require("./noop.js");
const {
	buildFrame,
	countUnscrolledHeight,
	createPanel,
} = require("./refill-panel.js");

const PANEL_SCRIPT = "refill-panel.js";

const ESC = String.fromCharCode(27);
const TOKEN = new RegExp(
	String.raw`${ESC}\[([0-9;?]*)([@-~])|${ESC}P[\s\S]*?${ESC}\\|${ESC}[\s\S]?|([\s\S])`,
	"gu",
);

/**
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
		/** @param {string} params */
		move(params) {
			const [r = 1, c = 1] = params.split(";").map((n) => Number(n) || 1);
			row = r - 1;
			col = c - 1;
		},
		/** @param {boolean} below */
		erase(below) {
			rows[row]?.splice(col);
			if (below) for (let r = row + 1; r < height; r++) rows[r] = [];
		},
		lines: () => rows.map((line) => line.join("").trimEnd()),
	};
}

/**
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
 * @param {{columns: number, rows: number|null, pid?: number, tty?: string}[]} sizes
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
		onChange: noop,
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
