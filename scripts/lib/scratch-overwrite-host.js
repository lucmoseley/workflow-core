/*
 * scratch-overwrite-host.js — the production port lib/scratch-overwrite.js
 * reads through the dispatcher (workflow-core#2789): one session's record of the
 * `.claude/tmp/` paths it has written, a file of one path a line under the
 * markers directory.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { markersDir } = require("./marker-root.js");

/**
 * @param {string} root
 * @returns {{ scratchRecord: (sid: string) => import("./scratch-overwrite.js").ScratchRecord | null }}
 */
function buildHostPorts(root) {
	return {
		scratchRecord: (sid) => {
			let dir;
			try {
				dir = markersDir(root);
			} catch {
				return null;
			}
			const record = path.join(dir, `.scratch-written-${sid}`);
			return {
				// A record that will not read is "unknown" (null), never "not ours";
				// the core allows on it, logged (mantahostels#103 §6).
				path: record,
				has: (target) => {
					try {
						return fs.readFileSync(record, "utf8").split("\n").includes(target);
					} catch (e) {
						return caught(e).code === "ENOENT" ? false : null;
					}
				},
				add: (target) => {
					try {
						fs.appendFileSync(record, `${target}\n`);
						return true;
					} catch {
						return false;
					}
				},
			};
		},
	};
}

module.exports = { buildHostPorts };
