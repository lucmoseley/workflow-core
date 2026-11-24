/**
 * @param {{ root: string }} env
 * @returns {import("./unasked-rerun-guard.js").UnaskedPorts}
 */
function buildHostPorts({ root }) {
	return {
		judge: (input, tree) =>
			require("./unasked-rerun.js").judge(
				input,
				require("./unasked-rerun-io.js").judgeIO(root, { tree }),
			),
	};
}

module.exports = { buildHostPorts };
