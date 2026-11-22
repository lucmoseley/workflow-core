const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { markersDir } = require("./marker-root.js");
const { repoRoot } = require("./test-pass-marker.js");

const PREFIX = ".typecheck-red-";
// #3824 guess
const OUTPUT_CAP = 2000;

/**
 * @param {string} root
 * @param {string} sid
 * @returns {string|null}
 */
function recordPath(root, sid) {
	const canonical = repoRoot(root);
	return canonical ? path.join(markersDir(canonical), `${PREFIX}${sid}`) : null;
}

/**
 * @param {string} root
 * @param {string} sid
 * @param {{ command: string, output: string }} attempt
 */
function recordRed(root, sid, { command, output }) {
	const file = recordPath(root, sid);
	if (!file) throw new Error("git names no canonical checkout");
	writeFileAtomic(
		file,
		JSON.stringify({
			at: new Date().toISOString(),
			command,
			output: output.slice(0, OUTPUT_CAP),
			cut: output.length > OUTPUT_CAP,
		}),
	);
}

/**
 * @param {string} root
 * @param {string} sid
 * @param {(what: string) => void} log
 * @returns {import("./typecheck-red.js").RedTry | null}
 */
function takeRed(root, sid, log) {
	const file = recordPath(root, sid);
	if (!file) return null;
	const taken = `${file}.${process.pid}`;
	try {
		fs.renameSync(file, taken);
		return JSON.parse(fs.readFileSync(taken, "utf8"));
	} catch (e) {
		if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT")
			log(`a RED record went unread: ${caught(e).message}`);
		return null;
	} finally {
		fs.rmSync(taken, { force: true });
	}
}

/**
 * @param {import("./core-contract.js").HostEnv} env
 */
function buildHostPorts({ root, log }) {
	return { takeRed: (/** @type {string} */ sid) => takeRed(root, sid, log) };
}

module.exports = { buildHostPorts, recordRed, takeRed };
