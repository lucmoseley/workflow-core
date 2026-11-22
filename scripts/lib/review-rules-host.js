const { reviewAgentType } = require("./review-agent-type.js");
const standards = require("./review-standards.js");
const scriptPath = require("./script-path.js");

/**
 * @typedef {{ state: "both" | "base" | "local" | "neither", baseShown: string,
 *   glossaryLine: string,
 *   missingBase: { what: string, detail: string } | null }} ReviewStandards
 */

/** @param {{ root: string }} env */
function buildHostPorts({ root }) {
	return {
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
