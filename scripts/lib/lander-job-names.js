const SHARD_JOB = /\bVitest \((\d+)\/(\d+)\)$/;
/** @param {number} k @param {number} n */
const shardJobName = (k, n) => `Vitest (${k}/${n})`;
/* workflow-core#2414 */
const SUITE_PASSED_JOB = "Suite passed";
const NAMED_JOB = "Named files";
const CHECKOUT_STEP = "Run actions/checkout@v4";
const SETUP_NODE_STEP = "Run actions/setup-node@v4";
/* workflow-core#4485 */
const RUNNER_STEPS = new Set([
	"Set up job",
	CHECKOUT_STEP,
	SETUP_NODE_STEP,
	"Install test tools",
	"Full history",
]);
const GROUP_STEP = "Whole-run group";

/** @type {import("./actions-tester.js").Workflows} */
const ADOPTER_WORKFLOWS = {
	suite: "workflow-core-lander.yml",
	named: "workflow-core-named-rerun.yml",
	suiteStep: GROUP_STEP,
};

module.exports = {
	ADOPTER_WORKFLOWS,
	CHECKOUT_STEP,
	GROUP_STEP,
	NAMED_JOB,
	RUNNER_STEPS,
	SETUP_NODE_STEP,
	SHARD_JOB,
	SUITE_PASSED_JOB,
	shardJobName,
};
