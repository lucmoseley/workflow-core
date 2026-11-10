/*
 * meminfo.js — the repo's one parser of the meminfo file (workflow-core#3600). A leaf
 * beside lib/proc-root.js, so the guard path loads none of admission.js to
 * read it.
 */

const fs = require("node:fs");
const { readProcStartOf } = require("./arbiter-proc.js");
const { caught } = require("./caught.js");
const { readMachineSetting } = require("./machine-setting.js");
const { meminfoPath } = require("./proc-root.js");

/**
 * @typedef {{ ok: true, mb: number } | { ok: false, error: string }} MbResult
 * @typedef {{ ok: true, totalKb: number | null, availableKb: number, swapTotalKb: number | null, swapFreeKb: number | null } | { ok: false, error: string }} MeminfoRead
 */

/*
 * THE MEMORY-HOLD ADD-BACK (workflow-core#4862). While the memory switchback holds RAM on
 * purpose, `~/.claude/memory-hold` (or `WFC_MEMORY_HOLD`) reads
 * `<MB> <pid> <procStart>`, and every reader here adds the MB back to
 * MemAvailable. The holder counts
 * only while its pid still carries that start token, the arbiter's liveness
 * test (mantahostels#104).
 */

/** The held MB in kB, 0 where no live hold is declared. */
function readHeldKb() {
	const { text } = readMachineSetting("memory-hold", "WFC_MEMORY_HOLD");
	const [, mb, pid, start] = text?.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/) ?? [];
	if (!mb || !pid || readProcStartOf(pid) !== start) return 0;
	return Number(mb) * 1024;
}

/**
 * MemAvailable, MemTotal and swap in kB off ONE read, so figures taken from it
 * cannot disagree.
 * @returns {MeminfoRead}
 */
function readMeminfoKb() {
	const path = meminfoPath();
	try {
		const text = fs.readFileSync(path, "utf8");
		/** @param {string} key */
		const kb = (key) => {
			const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, "m"));
			return m ? Number(m[1]) : null;
		};
		const availableKb = kb("MemAvailable");
		if (availableKb === null)
			return { ok: false, error: `${path} carries no MemAvailable line` };
		return {
			ok: true,
			totalKb: kb("MemTotal"),
			availableKb: availableKb + readHeldKb(),
			swapTotalKb: kb("SwapTotal"),
			swapFreeKb: kb("SwapFree"),
		};
	} catch (e) {
		return { ok: false, error: caught(e).message };
	}
}

/**
 * MemAvailable in MB, from a `readMeminfoKb` read already taken.
 * @param {MeminfoRead} read
 * @returns {MbResult}
 */
const availableFrom = (read) =>
	read.ok
		? { ok: true, mb: Math.floor(read.availableKb / 1024) }
		: { ok: false, error: read.error };

/**
 * MemAvailable, never MemFree — which counts reclaimable cache as spent.
 * @returns {MbResult}
 */
const readAvailableMb = () => availableFrom(readMeminfoKb());

module.exports = { availableFrom, readAvailableMb, readMeminfoKb };
