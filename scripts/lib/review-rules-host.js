/*
 * review-rules-host.js — the production ports lib/review-rules.js reads
 * through the dispatcher (workflow-core#2792): the core root this file was installed
 * under, the review subagent type the host offers (lib/review-agent-type.js)
 * and which standards files a review can be handed (lib/review-standards.js).
 */

const { reviewAgentType } = require("./review-agent-type.js");
const standards = require("./review-standards.js");
const scriptPath = require("./script-path.js");

/**
 * @typedef {{ state: "both" | "base" | "local" | "neither", baseShown: string,
 *   glossaryLine: string,
 *   missingBase: { what: string, detail: string } | null }} ReviewStandards
 */

/** @param {string} root the host root */
function buildHostPorts(root) {
	return {
		/* coreRoot() names this install wherever WFC_SCRIPT_ROOT is unset, the
		 * one case the core reads this port in. */
		installRoot: scriptPath.coreRoot(),
		reviewAgentType: () => reviewAgentType(root),
		/**
		 * @param {string} coreRoot
		 * @returns {ReviewStandards}
		 */
		reviewStandards: (coreRoot) => ({
			state: standards.standardsState(coreRoot, root),
			baseShown: standards.standardsShown(
				standards.standardsBase(coreRoot),
				root,
			),
			glossaryLine: standards.standardsGlossaryLine(root),
			missingBase: standards.missingBase(coreRoot),
		}),
	};
}

module.exports = { buildHostPorts };
