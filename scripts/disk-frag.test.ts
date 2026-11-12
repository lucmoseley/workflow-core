// @vitest-environment node
/*
 * Pins that disk-frag.js reads the kernel's mb_groups buddy table into free
 * space by aligned chunk size and used space by disk band (#5054). A wrong
 * order cut misstates how much free space `compact vdisk` cannot reach.
 *
 * The cases feed a synthetic table through --table, the program's one seam,
 * so the arithmetic is pinned on known chunks; one contract case reads the
 * machine's own table, world-readable, where an ext4 root has one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "disk-frag.js");
const HEADER =
	"#group: free  frags first [ 2^0   2^1   2^2   2^3   2^4   2^5   2^6   2^7   2^8   2^9   2^10  2^11  2^12  2^13  ]";

function row(group: number, free: number, orders: number[]) {
	return `#${group}    : ${free}     1     0     [ ${orders.join("     ")}     ]`;
}

// A never-written 128 MiB group: four order-13 chunks.
const EMPTY = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4];
const NONE = new Array(14).fill(0);
// One 4 KiB chunk, one 512 KiB (order 7), one 2 MiB (order 9).
const GAPPY = [1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0];
const TABLE = [
	HEADER,
	row(0, 0, NONE),
	row(1, 1 + 128 + 512, GAPPY),
	row(2, 32_768, EMPTY),
	row(600, 32_768 - 256, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]),
].join("\n");

const GIB_BLOCKS = 2 ** 30 / 4096;

let dir = "";
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "disk-frag-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function runOn(text: string, args: string[] = []) {
	const table = path.join(dir, "mb_groups");
	fs.writeFileSync(table, text);
	return runInProcess(SCRIPT, ["--table", table, ...args], { cwd: dir });
}

describe("a saved table", () => {
	it("counts chunks under 1 MiB and under 4 MiB by buddy order", () => {
		const f = JSON.parse(runOn(TABLE, ["--json"]).stdout);
		expect(f.underCompactGiB * GIB_BLOCKS).toBe(1 + 128);
		expect(f.underRebuildGiB * GIB_BLOCKS).toBe(1 + 128 + 512);
	});

	it("names full and never-written groups and where use ends", () => {
		const f = JSON.parse(runOn(TABLE, ["--json"]).stdout);
		expect([f.groups, f.full, f.untouched]).toEqual([4, 1, 1]);
		expect(f.lastUsedGiB).toBe(601 / 8);
	});

	it("sums used space per 64 GiB band, leaving empty bands out", () => {
		const f = JSON.parse(runOn(TABLE, ["--json"]).stdout);
		expect(f.bands.map((b: { fromGiB: number }) => b.fromGiB)).toEqual([0, 64]);
		expect(f.bands[0].usedGiB * GIB_BLOCKS).toBe(32_768 + 32_768 - 641);
		expect(f.bands[1].usedGiB * GIB_BLOCKS).toBe(256);
	});

	it("prints the readout with its cuts named", () => {
		const r = runOn(TABLE);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("in aligned chunks under 1 MiB 0.00 GiB");
		expect(r.stdout).toContain("64-128 GiB  0.00 GiB");
	});

	it("refuses a table with no group row rather than read an empty disk", () => {
		const r = runOn(HEADER);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("no group row");
	});
});

describe("a live mount", () => {
	it("refuses a mount that is not ext4", () => {
		const r = runInProcess(SCRIPT, ["--mount", path.join(dir, "none")], {
			cwd: dir,
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("no ext4 filesystem is mounted at");
	});

	const ext4Root = fs
		.readFileSync("/proc/self/mountinfo", "utf8")
		.split("\n")
		.some((l) => l.split(" ")[4] === "/" && / - ext4 /.test(l));
	it.skipIf(!ext4Root)("reads the machine's own table", () => {
		const r = runInProcess(SCRIPT, ["--json"], { cwd: dir });
		expect(r.status, r.stderr).toBe(0);
		expect(JSON.parse(r.stdout).groups).toBeGreaterThan(0);
	});
});
