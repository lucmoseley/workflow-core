#!/usr/bin/env node
/*
 * disk-frag.js — how fragmented the WSL disk's free space is, and where on
 * the disk its used blocks sit, without root (#5054).
 *
 * Usage:  node scripts/disk-frag.js [--mount <path>] [--table <file>] [--json]
 *
 * It reads the kernel's per-group buddy table, /proc/fs/ext4/<dev>/mb_groups,
 * which is world-readable where the device and `e2freefrag` are not. Each row
 * counts a block group's free chunks by order: order k holds 2^k blocks. The
 * buddy splits a free run into aligned chunks, so a gap's size reads at most
 * one order short. Free space in chunks under COMPACT_BYTES is space
 * `compact vdisk` cannot hand back to the host (docs/environment.md §1);
 * under REBUILD_BYTES is #5041's own measure of the dead space a rebuild
 * drops. A group with no free block left is "full"; one with every block free
 * was never written, or was freed whole.
 *
 * BANDS sums the used space per BAND_GIB of disk, so a band filling past the
 * packed region shows where new writes land: ext4's Orlov allocator spreads a
 * top-level directory such as /tmp into an empty region of its own.
 *
 * --table reads a saved copy of the table instead; blocks are taken as 4 KiB
 * there, and the mount's block size otherwise.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { requiredGroup } = require("./lib/regex-group.js");
const { writeFd } = require("./lib/write-fd.js");

const MIB = 2 ** 20;
const GIB = 2 ** 30;
const COMPACT_BYTES = MIB;
const REBUILD_BYTES = 4 * MIB;
const BAND_GIB = 64;
const FIXTURE_BLOCK = 4096;
const USAGE =
	"Usage: node scripts/disk-frag.js [--mount <path>] [--table <file>] [--json]";
/* One group: `#<n> : <free> <frags> <first> [ <chunks by order> ]`. */
const ROW = /^#(\d+)\s*:\s*(\d+)\s+\d+\s+\d+\s*\[([\d\s]*)\]/;

/**
 * @typedef {{ blockBytes: number, groups: number, full: number,
 *   untouched: number, freeGiB: number, underCompactGiB: number,
 *   underRebuildGiB: number, lastUsedGiB: number,
 *   bands: { fromGiB: number, usedGiB: number }[] }} Frag
 */

/**
 * Summarise the text of an mb_groups table.
 * @param {string} text
 * @param {number} blockBytes
 * @returns {Frag}
 */
function summarise(text, blockBytes) {
	const perGroup = 8 * blockBytes;
	const groupGiB = (perGroup * blockBytes) / GIB;
	const compactOrder = Math.log2(COMPACT_BYTES / blockBytes);
	const rebuildOrder = Math.log2(REBUILD_BYTES / blockBytes);
	let groups = 0;
	let full = 0;
	let untouched = 0;
	let free = 0;
	let underCompact = 0;
	let underRebuild = 0;
	let lastUsed = -1;
	/** @type {Map<number, number>} */
	const used = new Map();
	for (const line of text.split("\n")) {
		const row = ROW.exec(line);
		if (!row) continue;
		const group = Number(requiredGroup(row, 1, ROW));
		const groupFree = Number(requiredGroup(row, 2, ROW));
		const orders = requiredGroup(row, 3, ROW).trim().split(/\s+/).map(Number);
		groups++;
		free += groupFree;
		if (groupFree === 0) full++;
		if (groupFree === perGroup) untouched++;
		else lastUsed = group;
		for (const [order, count] of orders.entries()) {
			if (order < compactOrder) underCompact += count * 2 ** order;
			if (order < rebuildOrder) underRebuild += count * 2 ** order;
		}
		const band = Math.floor((group * groupGiB) / BAND_GIB);
		used.set(band, (used.get(band) ?? 0) + perGroup - groupFree);
	}
	const toGiB = (/** @type {number} */ blocks) => (blocks * blockBytes) / GIB;
	return {
		blockBytes,
		groups,
		full,
		untouched,
		freeGiB: toGiB(free),
		underCompactGiB: toGiB(underCompact),
		underRebuildGiB: toGiB(underRebuild),
		lastUsedGiB: (lastUsed + 1) * groupGiB,
		bands: [...used]
			.filter(([, blocks]) => blocks > 0)
			.map(([band, blocks]) => ({
				fromGiB: band * BAND_GIB,
				usedGiB: toGiB(blocks),
			})),
	};
}

/**
 * The device name /proc/fs/ext4 keys the ext4 filesystem mounted at `mount`
 * by, from /proc/self/mountinfo, or null where none is ext4.
 * @param {string} mount
 */
function ext4DeviceOf(mount) {
	for (const line of fs
		.readFileSync("/proc/self/mountinfo", "utf8")
		.split("\n")) {
		const [left = "", right] = line.split(" - ");
		if (!right) continue;
		const [fstype, source = ""] = right.split(" ");
		if (left.split(" ")[4] === mount && fstype === "ext4") {
			return path.basename(source);
		}
	}
	return null;
}

/** @param {Frag} f */
function render(f) {
	const g = (/** @type {number} */ n) => `${n.toFixed(2)} GiB`;
	return [
		`${f.groups} groups: ${f.full} full, ${f.untouched} with every block free`,
		`free ${g(f.freeGiB)}: in gaps under 1 MiB ${g(f.underCompactGiB)}, under 4 MiB ${g(f.underRebuildGiB)}`,
		`last group in use ends ${g(f.lastUsedGiB)} into the disk`,
		"used, by band:",
		...f.bands.map(
			(b) => `  ${b.fromGiB}-${b.fromGiB + BAND_GIB} GiB  ${g(b.usedGiB)}`,
		),
	].join("\n");
}

function main() {
	const { values } = parseArgs({
		options: {
			mount: { type: "string", default: "/" },
			table: { type: "string" },
			json: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) {
		writeFd(1, `${USAGE}\n`);
		return;
	}
	const { table, mount } = values;
	let text;
	let blockBytes = FIXTURE_BLOCK;
	if (table) {
		text = fs.readFileSync(table, "utf8");
	} else {
		const dev = ext4DeviceOf(mount);
		if (!dev) {
			writeFd(2, `disk-frag: no ext4 filesystem is mounted at ${mount}\n`);
			process.exit(2);
		}
		text = fs.readFileSync(`/proc/fs/ext4/${dev}/mb_groups`, "utf8");
		blockBytes = fs.statfsSync(mount).bsize;
	}
	const frag = summarise(text, blockBytes);
	writeFd(1, values.json ? `${JSON.stringify(frag)}\n` : `${render(frag)}\n`);
}

if (require.main === module) main();

module.exports = { summarise };
