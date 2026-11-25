const { spawnSync } = require("node:child_process");
const { caught } = require("./caught.js");

// measured 0.05 s for a 15-hour boot's 542 kernel lines, workflow-core#5304
const READ_TIMEOUT_MS = 5000;

// measured 1.93 MB for the largest boot's journal, workflow-core#5304
const MAX_BUFFER = 64 * 1024 * 1024;

/**
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
 * @param {string[]} args
 */
const runJournalctl = (args) =>
	runBoundedRead(process.env.WFC_JOURNALCTL || "journalctl", args);

/** @param {number} ms */
const toSecond = (ms) => Math.floor(ms / 1000) * 1000;

/** @typedef {{id: string, from: number, to: number}} Boot */

/**
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

const bootKey = (/** @type {string} */ id) => id.replace(/-/g, "");

module.exports = {
	bootKey,
	readBoots,
	runBoundedRead,
	runJournalctl,
	toSecond,
};
