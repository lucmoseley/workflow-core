const fs = require("node:fs");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { jobStatePath } = require("./job-paths.js");

/**
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
