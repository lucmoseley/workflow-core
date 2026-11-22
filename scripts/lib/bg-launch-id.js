const ESC = String.fromCharCode(0x1b);
const ESCAPE = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");

/**
 * @param {string} stdout
 * @returns {string}
 */
function bgLaunchId(stdout) {
	for (const line of stdout.replace(ESCAPE, "").split("\n")) {
		const m = line.match(/[0-9a-f]{8}/);
		if (m) return m[0];
	}
	return "";
}

module.exports = { bgLaunchId };
