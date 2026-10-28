/*
 * issue-close-host.js — the production ports the dispatcher wires into the
 * guard-issue-close core, lib/issue-close.js (#2798, #3225). Every gh call,
 * the census read and the landing read carry the timeout the core hands them,
 * what is left of its run budget and at most 4 s, cut to what the
 * dispatcher's budget leaves (lib/hook-deadline.js). As in the core, what
 * only a close reaches is required inside its port.
 */

const fs = require("node:fs");
const path = require("node:path");
const { budgetMs } = require("./hook-deadline.js");
const { resolveKey } = require("./workflow-core-config.js");

/**
 * @param {string} root
 * @returns {import("./issue-close.js").ClosePorts}
 */
const buildHostPorts = (root) => ({
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
	census: (n, timeoutMs) =>
		readUnderCeiling("the census reader", budgetMs(timeoutMs), (ceiling) => {
			const { censusRefusal, readExpiredRows } = require("./census-digest.js");
			const rows = readExpiredRows(root, n, { ceiling });
			return rows.length > 0 ? censusRefusal(n, rows) : "";
		}),
	landing: (n, comment, timeoutMs, cwd) =>
		readUnderCeiling("the landing reader", budgetMs(timeoutMs), (ceiling) => {
			const {
				readUnlandedCommits,
				unlandedRefusal,
			} = require("./unlanded-commits.js");
			const { worktreeRoot } = require("./host-root.js");
			/* The close's own checkout, whose HEAD may be a linked worktree's. */
			const unlanded = readUnlandedCommits(
				worktreeRoot(cwd ?? root, { host: root }),
				n,
				comment,
				{
					ceiling,
				},
			);
			return unlanded.commits.length > 0 ? unlandedRefusal(n, unlanded) : "";
		}),
});

/**
 * `refuse`'s refusal under a git ceiling of `ms`, outOfBudget where it
 * passes. Its wait notice starts at 5 s, past any budget the core hands it, so
 * it never writes to stderr.
 * @param {string} label
 * @param {number} ms
 * @param {(ceiling: import("./git-ceiling.js").GitCeiling) => string} refuse
 * @returns {import("./issue-close.js").RefusalRead}
 */
function readUnderCeiling(label, ms, refuse) {
	const { CeilingPassed, buildGitCeiling } = require("./git-ceiling.js");
	try {
		return { refusal: refuse(buildGitCeiling({ label, ms })) };
	} catch (e) {
		if (e instanceof CeilingPassed) return { outOfBudget: true };
		throw e;
	}
}

module.exports = { buildHostPorts };
