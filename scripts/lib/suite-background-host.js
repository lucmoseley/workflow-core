/**
 * @param {import("./core-contract.js").HostEnv} env
 * @returns {import("./suite-background.js").BackgroundPorts}
 */
function buildHostPorts({ root, log }) {
	/** @type {string[] | undefined} */
	let runners;
	return {
		runners: () => {
			if (runners === undefined) {
				try {
					runners =
						require("./workflow-core-config.js").readConfig({
							root,
							quiet: true,
						}).suiteRunners ?? [];
				} catch {
					log(
						"workflow-core.json unreadable — no declared suite runner counted",
					);
					runners = [];
				}
			}
			return /** @type {string[]} */ (runners);
		},
	};
}

module.exports = { buildHostPorts };
