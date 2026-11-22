const { caught } = require("./caught.js");
const { readJsonl } = require("./jsonl.js");

/**
 * @param {string} file
 * @returns {{name: string|null}|{why: string}}
 */
function readSessionName(file) {
	let read;
	try {
		read = readJsonl(file, (line) => line.includes('"custom-title"'));
	} catch (e) {
		return { why: `reading ${file}: ${caught(e).message}` };
	}
	const named = (read?.rows ?? []).filter(
		(r) => r.type === "custom-title" && typeof r.customTitle === "string",
	);
	const name = /** @type {string|undefined} */ (named.at(-1)?.customTitle);
	return { name: name || null };
}

module.exports = { readSessionName };
