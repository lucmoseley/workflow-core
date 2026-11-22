const fs = require("node:fs");
const path = require("node:path");

const { coreRoot } = require("./script-path.js");

/**
 * @param {{ root: string }} env
 * @returns {Pick<import("./founder-wording.js").WordingPorts, "corpus" | "skillFile">}
 */
function buildHostPorts({ root }) {
	return {
		corpus: () =>
			require("./workflow-core-config.js").resolveCorpus({ root, quiet: true }),
		skillFile: (name) => {
			try {
				return fs.readFileSync(
					path.join(coreRoot(), ".claude", "skills", name, "SKILL.md"),
					"utf8",
				);
			} catch {
				return null;
			}
		},
	};
}

module.exports = { buildHostPorts };
