const nodeFs = require("node:fs");
const { caught } = require("./caught.js");

// measured 105 MB read peaked at 710 MB resident, lucmoseley/mantahostels#181
const DEFAULT_ROTATE_AT = 8 * 1024 * 1024;

function rotateAt() {
	const override = Number(process.env.WFC_ROTATE_AT);
	return Number.isFinite(override) && override > 0
		? override
		: DEFAULT_ROTATE_AT;
}

/**
 * @param {string} logPath
 * @param {number} readSize
 * @param {{ fs?: typeof nodeFs, limit?: number }} [options]
 */
function rotateLog(
	logPath,
	readSize,
	{ fs = nodeFs, limit = rotateAt() } = {},
) {
	if (readSize <= limit) return null;
	try {
		if (fs.statSync(logPath).size !== readSize) return null;
		fs.renameSync(logPath, `${logPath}.1`);
		return null;
	} catch (e) {
		const err = caught(e);
		if (err.code === "ENOENT") return null;
		return `${logPath} is ${readSize} bytes and could not be rotated (${err.code || err.message}) — it is read whole at every session start, and nothing is bounding its growth`;
	}
}

module.exports = { rotateLog };
