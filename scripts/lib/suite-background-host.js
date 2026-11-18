/*
 * suite-background-host.js — the production ports lib/suite-background.js
 * reads through the dispatcher (workflow-core#2790): the host's declared `suiteRunners`,
 * loaded on first use, so a Bash call naming no suite pays nothing.
 */

/**
 * @param {string} root
 * @param {(what: string, detail?: string) => void} log
 * @returns {import("./suite-background.js").BackgroundPorts}
 */
function buildHostPorts(root, log) {
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
					/* Fails open (mantahostels#103 §6): an unreadable config declares no runner. */
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
