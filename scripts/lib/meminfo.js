/*
 * meminfo.js — the repo's one parser of the meminfo file (#3600). A leaf
 * beside lib/proc-root.js, so the guard path loads none of admission.js to
 * read it.
 */

const fs = require("node:fs");
const { meminfoPath } = require("./proc-root.js");

/**
 * @typedef {{ ok: true, totalKb: number | null, availableKb: number, swapTotalKb: number | null, swapFreeKb: number | null } | { ok: false, error: string }} MeminfoRead
 */

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
			availableKb,
			swapTotalKb: kb("SwapTotal"),
			swapFreeKb: kb("SwapFree"),
		};
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * MemAvailable in MB, from a `readMeminfoKb` read already taken.
 * @param {MeminfoRead} read
 * @returns {{ ok: true, mb: number } | { ok: false, error: string }}
 */
const availableFrom = (read) =>
	read.ok
		? { ok: true, mb: Math.floor(read.availableKb / 1024) }
		: { ok: false, error: read.error };

module.exports = { availableFrom, readMeminfoKb };
