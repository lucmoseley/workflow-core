const fs = require("node:fs");
const path = require("node:path");
const { readText } = require("./file-read.js");
const { markersDir } = require("./marker-root.js");

/**
 * @param {{ root: string }} env
 * @returns {{ scratchRecord: (sid: string) => import("./scratch-overwrite.js").ScratchRecord | null }}
 */
function buildHostPorts({ root }) {
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
						return false;
					}
				},
			};
		},
	};
}

module.exports = { buildHostPorts };
