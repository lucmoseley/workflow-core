#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { requiredGroup } = require("./lib/regex-group.js");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");

const MIB = 2 ** 20;
const GIB = 2 ** 30;
// guess, #5041
const COMPACT_BYTES = MIB;
// guess, #5041
const REBUILD_BYTES = 4 * MIB;
// guess: the packed 0-128 GiB reads as two bands, #5054
const BAND_GIB = 64;
// mke2fs.conf's default blocksize, https://github.com/tytso/e2fsprogs/blob/master/misc/mke2fs.conf.in
const TABLE_BLOCK_BYTES = 4096;
const USAGE = `Usage: node ${scriptPath("disk-frag.js")} [--mount <path>] [--table <file>] [--json]`;
const ROW = /^#(\d+)\s*:\s*(\d+)\s+\d+\s+\d+\s*\[([\d\s]*)\]/;

/**
 * @typedef {{ blockBytes: number, groups: number, full: number,
 *   untouched: number, freeGiB: number, underCompactGiB: number,
 *   underRebuildGiB: number, lastUsedGiB: number,
 *   bands: { fromGiB: number, usedGiB: number }[] }} Frag
 */

/**
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

/** @param {string} mount */
function readExt4Device(mount) {
	for (const line of fs
		.readFileSync("/proc/self/mountinfo", "utf8")
		.split("\n")) {
		const [left = "", right] = line.split(" - ");
		if (!right) continue;
		const fields = left.split(" ");
		if (fields[4] !== mount || right.split(" ")[0] !== "ext4") continue;
		const devNo = fields[2];
		if (!devNo) throw new Error(`mountinfo row names no device: ${line}`);
		return path.basename(fs.realpathSync(`/sys/dev/block/${devNo}`));
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
	writeFd(1, values.json ? `${JSON.stringify(frag)}\n` : `${render(frag)}\n`);
}

if (require.main === module) main();
