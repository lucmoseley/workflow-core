const { orFallback } = require("./caught.js");
const { budgetMs } = require("./hook-deadline.js");
const { resolveKey } = require("./workflow-core-config.js");

/**
 * @param {{ root: string }} env
 * @returns {import("./issue-close.js").ClosePorts}
 */
const buildHostPorts = ({ root }) => ({
	gh: (args, timeoutMs) => require("./gh.js").gh(args, { timeout: timeoutMs }),
	now: Date.now,
	tracker: () => {
		const t = orFallback(() => resolveKey("tracker", { root }), undefined);
		return typeof t === "string" && t ? t : undefined;
	},
	census: (n, timeoutMs, tree) =>
		readUnderCeiling("the census reader", budgetMs(timeoutMs), (ceiling) => {
			const { censusRefusal, readExpiredRows } = require("./census-digest.js");
			const rows = readExpiredRows(tree, n, { ceiling });
			return rows.length > 0 ? censusRefusal(n, rows) : "";
		}),
	landing: (n, comment, timeoutMs, tree) =>
		readUnderCeiling("the landing reader", budgetMs(timeoutMs), (ceiling) => {
			const {
				readUnlandedCommits,
				unlandedRefusal,
			} = require("./unlanded-commits.js");
			const unlanded = readUnlandedCommits(tree, n, comment, { ceiling });
			return unlanded.commits.length > 0 ? unlandedRefusal(n, unlanded) : "";
		}),
});

/**
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
