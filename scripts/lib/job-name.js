/*
 * job-name.js — a name written onto a background job's record, the row
 * `claude agents` lists it under (#4098). The harness gives hooks no rename
 * call, so this writes `name` and `nameSource` into its state.json, as
 * name-issue-session.sh does; the daemon merges its own writes onto what is
 * on disk, and `nameSource: "user"` is the one value its auto-namer leaves.
 *
 * Residual: a daemon write that read the record before this one and lands
 * after it puts the old name back.
 */

const fs = require("node:fs");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { jobStatePath } = require("./job-paths.js");

/**
 * Name job `jobId` on `seat` `name`; null once written, else why not.
 * @param {string} seat
 * @param {string} jobId
 * @param {string} name
 * @returns {string|null}
 */
function writeJobName(seat, jobId, name) {
	const file = jobStatePath(seat, jobId);
	try {
		const rec = JSON.parse(fs.readFileSync(file, "utf8"));
		writeFileAtomic(
			file,
			`${JSON.stringify({ ...rec, name, nameSource: "user" }, null, 2)}\n`,
		);
		return null;
	} catch (e) {
		return `writing ${file}: ${caught(e).message}`;
	}
}

module.exports = { writeJobName };
