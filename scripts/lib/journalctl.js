/*
 * journalctl.js — journalctl runs: a journal read, which check-kernel-stall.js
 * takes its kernel log by (#5304), and the boot list, which places an earlyoom
 * kill's time (#4143) and bounds check-kernel-stall.js's --boot offsets
 * (#5299). WFC_JOURNALCTL injects the binary (§N7). The bounded read under it
 * also serves check-kernel-stall.js's dmesg reader, the same kernel log.
 */

const { spawnSync } = require("node:child_process");
const { caught } = require("./caught.js");

/** Per read. Measured at 0.05 s for a 15-hour boot's 542 kernel lines; the rest is margin. */
const READ_TIMEOUT_MS = 5000;

/**
 * Per read. The largest boot journalctl held on 8 Oct 2026 was 1.93 MB (19,526
 * lines over five days), and the whole earlyoom journal, 11 Sep to 26 Oct 2026,
 * 0.8 MB; this is ~30x the larger, so only a boot of months would overflow it —
 * and an overflow is a failed read, never "clean" or "no kills".
 */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * `cmd`'s stdout for `args` under the bounds above, or why it failed.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{stdout: string, why: string|null}}
 */
function runBoundedRead(cmd, args) {
	const r = spawnSync(cmd, args, {
		encoding: "utf8",
		timeout: READ_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: MAX_BUFFER,
	});
	if (r.error || r.status !== 0)
		return {
			stdout: "",
			why: r.error?.message ?? (r.stderr.trim() || `exit ${r.status}`),
		};
	return { stdout: r.stdout, why: null };
}

/**
 * journalctl's stdout for `args`, or why it failed.
 * @param {string[]} args
 */
const runJournalctl = (args) =>
	runBoundedRead(process.env.WFC_JOURNALCTL || "journalctl", args);

/** @param {number} ms floored to the second */
const toSecond = (ms) => Math.floor(ms / 1000) * 1000;

/** @typedef {{id: string, from: number, to: number}} Boot ms */

/**
 * The journal's boots, or why they could not be read. An entry missing its id
 * or a time fails the whole list, never drops a boot.
 * @returns {{boots: Boot[], why: string|null}}
 */
function readBoots() {
	const fail = (/** @type {string} */ reason) => ({
		boots: [],
		why: `journalctl --list-boots: ${reason}`,
	});
	const { stdout, why } = runJournalctl([
		"--list-boots",
		"--no-pager",
		"-o",
		"json",
	]);
	if (why !== null) return fail(why);
	let listed;
	try {
		listed = JSON.parse(stdout);
	} catch (err) {
		return fail(caught(err).message);
	}
	if (!Array.isArray(listed)) return fail("not a JSON array");
	/** @type {Boot[]} */
	const boots = [];
	for (const b of listed) {
		if (
			typeof b?.boot_id !== "string" ||
			typeof b.first_entry !== "number" ||
			typeof b.last_entry !== "number"
		)
			return fail(`an entry not a boot: ${JSON.stringify(b)}`);
		boots.push({
			id: b.boot_id,
			from: toSecond(b.first_entry / 1000),
			to: toSecond(b.last_entry / 1000),
		});
	}
	return { boots, why: null };
}

/** /proc's boot_id carries dashes; journalctl's does not. */
const bootKey = (/** @type {string} */ id) => id.replace(/-/g, "");

module.exports = {
	READ_TIMEOUT_MS,
	bootKey,
	readBoots,
	runBoundedRead,
	runJournalctl,
	toSecond,
};
