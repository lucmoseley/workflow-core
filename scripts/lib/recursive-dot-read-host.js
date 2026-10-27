/*
 * recursive-dot-read-host.js — the production port lib/recursive-dot-read.js
 * reads through the dispatcher (#2791) beyond the shared ones: a path
 * resolved physical as `realpath -m` resolves it, no component required to
 * exist. Git and existence come through the dispatcher's own `git` and
 * `exists`.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * `p` with every symlink among its existing components followed, in order, so
 * a `..` after a link climbs from the link's target as `realpath -m` does; a
 * component that does not exist, and everything after it, is joined as
 * spelled. A relative `p` is read from the hook's own directory.
 * @param {string} p
 * @returns {string}
 */
function realpath(p) {
	const abs = path.isAbsolute(p) ? p : `${process.cwd()}/${p}`;
	let cur = "/";
	let missing = false;
	for (const part of abs.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			cur = path.dirname(cur);
			continue;
		}
		const next = path.join(cur, part);
		if (missing) {
			cur = next;
			continue;
		}
		try {
			cur = fs.realpathSync(next);
		} catch {
			missing = true;
			cur = next;
		}
	}
	return cur;
}

/** @returns {import("./recursive-dot-read.js").DotReadPorts} */
function buildHostPorts() {
	return { realpath };
}

module.exports = { buildHostPorts };
