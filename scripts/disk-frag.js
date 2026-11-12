#!/usr/bin/env node
/*
 * disk-frag.js — how much of the WSL disk's free space sits in small aligned
 * chunks, and where on the disk its used blocks sit, without root (#5054).
 *
 * Usage:  node scripts/disk-frag.js [--mount <path>] [--table <file>] [--json]
 *
 * In no family (§N3): a readout run by hand while the disk is being measured,
 * neither a check, a guard nor a report the sweeps run.
 *
 * It reads the kernel's per-group buddy table, /proc/fs/ext4/<dev>/mb_groups,
 * which is world-readable where the device is not, so `e2freefrag` needs
 * root. Each row counts a block group's free chunks by buddy order: order k
 * is 2^k blocks, aligned to its own size. These are NOT e2freefrag's free
 * extents: the buddy cuts a free run into aligned chunks, so a run of 4 MiB
 * or more that starts off a 4 MiB boundary counts partly under 4 MiB. Keep a
 * series to one tool. Aligned chunks are what a 1 MiB-block `compact vdisk`
 * sees, so the figure under COMPACT_BYTES is free space it cannot hand back
 * (docs/environment.md §1).
 *
 * BANDS sums the used space per BAND_GIB of disk, so a band filling past the
 * packed region shows where new writes land: ext4's Orlov allocator puts a
 * top-level directory such as /tmp into an empty region of its own.
 *
 * Residual: a group is taken to hold 8 × block-size blocks, one block bitmap's
 * worth, which a filesystem made with `mke2fs -g` or bigalloc breaks. On a
 * live mount the read refuses where the groups do not cover the filesystem's
 * blocks; a saved --table is taken at TABLE_BLOCK_BYTES, unchecked.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { requiredGroup } = require("./lib/regex-group.js");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");

const MIB = 2 ** 20;
const GIB = 2 ** 30;
/* WSL's VHDX block, the unit `compact vdisk` frees (docs/environment.md §1). */
const COMPACT_BYTES = MIB;
/* #5041's cut: the free space under it was the dead space its rebuild dropped. */
const REBUILD_BYTES = 4 * MIB;
/* A readability choice: 512 groups, so the rebuild's packed 0–128 GiB reads as
 * two bands. */
const BAND_GIB = 64;
/* mke2fs.conf's default block size for any filesystem over 512 MiB. */
const TABLE_BLOCK_BYTES = 4096;
const USAGE = `Usage: node ${scriptPath("disk-frag.js")} [--mount <path>] [--table <file>] [--json]`;
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
 * Read from /proc/self/mountinfo the device name /proc/fs/ext4 keys the ext4
 * filesystem mounted at `mount` by, or null where none is ext4.
 * @param {string} mount
 */
function readExt4Device(mount) {
	for (const line of fs
		.readFileSync("/proc/self/mountinfo", "utf8")
		.split("\n")) {
		const [left = "", right] = line.split(" - ");
		if (!right) continue;
		const [fstype, source] = right.split(" ");
		if (left.split(" ")[4] !== mount || fstype !== "ext4") continue;
		if (!source) throw new Error(`mountinfo row names no source: ${line}`);
		return path.basename(source);
	}
	return null;
}

/** @param {number} bytes */
function mib(bytes) {
	return `${bytes / MIB} MiB`;
}

/** @param {Frag} frag */
function render(frag) {
	const gib = (/** @type {number} */ n) => `${n.toFixed(2)} GiB`;
	return [
		`${frag.groups} groups: ${frag.full} full, ${frag.untouched} with every block free`,
		`free ${gib(frag.freeGiB)}: in aligned chunks under ${mib(COMPACT_BYTES)} ${gib(frag.underCompactGiB)}, under ${mib(REBUILD_BYTES)} ${gib(frag.underRebuildGiB)}`,
		`last group in use ends ${gib(frag.lastUsedGiB)} into the disk`,
		"used, by band:",
		...frag.bands.map(
			(b) => `  ${b.fromGiB}-${b.fromGiB + BAND_GIB} GiB  ${gib(b.usedGiB)}`,
		),
	].join("\n");
}

/** @param {string} why */
function refuse(why) {
	writeFd(2, `disk-frag: ${why}\n`);
	process.exit(2);
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
	let blockBytes = TABLE_BLOCK_BYTES;
	let fsBlocks = null;
	if (table) {
		text = fs.readFileSync(table, "utf8");
	} else {
		const dev = readExt4Device(mount);
		if (!dev) return refuse(`no ext4 filesystem is mounted at ${mount}`);
		text = fs.readFileSync(`/proc/fs/ext4/${dev}/mb_groups`, "utf8");
		({ bsize: blockBytes, blocks: fsBlocks } = fs.statfsSync(mount));
	}
	const frag = summarise(text, blockBytes);
	if (frag.groups === 0) return refuse("the table holds no group row");
	if (fsBlocks !== null && frag.groups * 8 * blockBytes < fsBlocks) {
		return refuse(
			`${frag.groups} groups of ${8 * blockBytes} blocks do not cover the filesystem's ${fsBlocks}`,
		);
	}
	// console-kept: the readout is the program's product, so it goes to stdout.
	writeFd(1, values.json ? `${JSON.stringify(frag)}\n` : `${render(frag)}\n`);
}

if (require.main === module) main();
