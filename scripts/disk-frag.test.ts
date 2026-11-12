// @vitest-environment node
/*
 * Pins that disk-frag.js reads the kernel's mb_groups buddy table into free
 * space by gap size and used space by disk band (#5054). A wrong order cut
 * misstates how much free space `compact vdisk` cannot reach, which is the
 * figure the disk's re-measure compares.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const { summarise } = require("./disk-frag.js");

const HEADER =
	"#group: free  frags first [ 2^0   2^1   2^2   2^3   2^4   2^5   2^6   2^7   2^8   2^9   2^10  2^11  2^12  2^13  ]";

function row(group: number, free: number, orders: number[]) {
	return `#${group}    : ${free}     1     0     [ ${orders.join("     ")}     ]`;
}

const EMPTY = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
const NONE = new Array(14).fill(0);
// One 4 KiB gap, one 512 KiB gap (order 7), one 2 MiB gap (order 9).
const GAPPY = [1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0];
const TABLE = [
	HEADER,
	row(0, 0, NONE),
	row(1, 1 + 128 + 512, GAPPY),
	row(2, 32_768, EMPTY),
	row(600, 32_768 - 256, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]),
].join("\n");

const GIB_BLOCKS = 2 ** 30 / 4096;

describe("summarise", () => {
	const f = summarise(TABLE, 4096);

	it("counts gaps under 1 MiB and under 4 MiB by buddy order", () => {
		expect(f.underCompactGiB * GIB_BLOCKS).toBe(1 + 128);
		expect(f.underRebuildGiB * GIB_BLOCKS).toBe(1 + 128 + 512);
	});

	it("names full and never-written groups and where use ends", () => {
		expect(f.groups).toBe(4);
		expect(f.full).toBe(1);
		expect(f.untouched).toBe(1);
		expect(f.lastUsedGiB).toBe(601 / 8);
	});

	it("sums used space per 64 GiB band, leaving empty bands out", () => {
		expect(f.bands.map((b: { fromGiB: number }) => b.fromGiB)).toEqual([0, 64]);
		expect(f.bands[0].usedGiB * GIB_BLOCKS).toBe(32_768 + 32_768 - 641);
		expect(f.bands[1].usedGiB * GIB_BLOCKS).toBe(256);
	});
});

describe("the command", () => {
	let dir = "";
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("reads a saved table and prints JSON", () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "disk-frag-"));
		const table = path.join(dir, "mb_groups");
		fs.writeFileSync(table, TABLE);
		const r = runInProcess(
			path.join(__dirname, "disk-frag.js"),
			["--table", table, "--json"],
			{ cwd: dir },
		);
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout).groups).toBe(4);
	});
});
