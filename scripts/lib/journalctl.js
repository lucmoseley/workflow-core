/*
 * journalctl.js — journalctl runs for lib/earlyoom-kills.js: the journal
 * read, and the boot list a kill's time is placed in (#4143). WFC_JOURNALCTL
 * injects the binary (§N7).
 */

const { spawnSync } = require("node:child_process");
const { caught } = require("./caught.js");

/* As check-kernel-stall.js's journal reader, whose comments derive them: a
 * read is well under 1 s, and an overflow is a failed read, never "no kills".
 * The whole earlyoom journal, 11 Sep to 26 Oct 2026, read 0.8 MB. */
const READ_TIMEOUT_MS = 5000;
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * journalctl's stdout for `args`, or why it failed.
 * @param {string[]} args
 * @returns {{stdout: string, why: string|null}}
 */
function runJournalctl(args) {
	const r = spawnSync(process.env.WFC_JOURNALCTL || "journalctl", args, {
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

module.exports = { bootKey, readBoots, runJournalctl, toSecond };
