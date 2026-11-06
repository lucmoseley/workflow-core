/*
 * scratch-overwrite-host.js — the production port lib/scratch-overwrite.js
 * reads through the dispatcher (#2789): one session's record of the
 * `.claude/tmp/` paths it has written, a file of one path a line under the
 * markers directory.
 */

const fs = require("node:fs");
const path = require("node:path");
const { readText } = require("./file-read.js");
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
				/* Null, which the core logs and allows on (mantahostels#103 §6). */
				return null;
			}
			const record = path.join(dir, `.scratch-written-${sid}`);
			return {
				// A record that will not read is "unknown" (null), never "not ours";
				// the core allows on it, logged (mantahostels#103 §6).
				path: record,
				has: (target) => {
					const got = readText(record);
					if (got.state === "read")
						return got.data.split("\n").includes(target);
					return got.state === "absent" ? false : null;
				},
				add: (target) => {
					try {
						fs.appendFileSync(record, `${target}\n`);
						return true;
					} catch {
						/* False, which the core logs and allows on
						 * (mantahostels#103 §6). */
						return false;
					}
				},
			};
		},
	};
}

module.exports = { buildHostPorts };
