/*
 * founder-wording-host.js — the production ports lib/founder-wording.js reads
 * on both its routes (#2792): the host's tracker corpus, and a skill file of
 * the plugin's own, beside these scripts in the repo and in a plugin install
 * alike (#628 story 18).
 */

const fs = require("node:fs");
const path = require("node:path");

/** The plugin's skills directory, two levels up from scripts/lib. */
const { coreRoot } = require("./script-path.js");

/**
 * @param {string} root the host root
 * @returns {Pick<import("./founder-wording.js").WordingPorts, "corpus" | "skillFile">}
 */
function buildHostPorts(root) {
	return {
		/* Quiet: a rejected value reads as the default, unsaid on a hook's stderr. */
		corpus: () =>
			require("./workflow-core-config.js").resolveCorpus({ root, quiet: true }),
		skillFile: (name) => {
			try {
				return fs.readFileSync(
					path.join(coreRoot(), ".claude", "skills", name, "SKILL.md"),
					"utf8",
				);
			} catch {
				/* No such skill installed: its pattern injects nothing. */
				return null;
			}
		},
	};
}

module.exports = { buildHostPorts };
