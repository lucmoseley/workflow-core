/*
 * issue-close-host.js — the production ports guard-issue-close.js wires into
 * its core, lib/issue-close.js (#2798). Every gh call and the census read
 * carry the timeout the core hands them, what is left of its run budget and
 * at most 4 s, so the last call ends under the hook's 10 s. As in the
 * core, what only a close reaches is required inside its port.
 */

const fs = require("node:fs");
const path = require("node:path");
const { resolveKey } = require("./workflow-core-config.js");

/**
 * @param {import("./guard-entry.js").PortEnv} env
 * @returns {import("./issue-close.js").ClosePorts}
 */
const buildHostPorts = ({ root }) => ({
	gh: (args, timeoutMs) => require("./gh.js").gh(args, { timeout: timeoutMs }),
	now: Date.now,
	readFile: (rel) => {
		try {
			return fs.readFileSync(path.join(root, rel), "utf8");
		} catch {
			return null;
		}
	},
	/* A config that cannot be read resolves no tracker. */
	tracker: () => {
		let t;
		try {
			t = resolveKey("tracker", { root });
		} catch {
			t = undefined;
		}
		return typeof t === "string" && t ? t : undefined;
	},
	census: (n, timeoutMs) => {
		const { censusRefusal, readExpiredRows } = require("./census-digest.js");
		const { CeilingPassed, buildGitCeiling } = require("./git-ceiling.js");
		/* Its wait notice starts at 5 s, past any budget this hands it, so it
		 * never writes to stderr. */
		const ceiling = buildGitCeiling({
			label: "the census reader",
			ms: timeoutMs,
		});
		try {
			const rows = readExpiredRows(root, n, { ceiling });
			return { refusal: rows.length > 0 ? censusRefusal(n, rows) : "" };
		} catch (e) {
			if (e instanceof CeilingPassed) return { outOfBudget: true };
			throw e;
		}
	},
});

module.exports = { buildHostPorts };
