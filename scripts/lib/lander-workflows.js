const {
	CORE_MARKER,
	renderJobEnv,
	renderSetupSteps,
} = require("./adopter-ci.js");
const {
	ADOPTER_WORKFLOWS,
	GROUP_STEP,
	NAMED_JOB,
	SUITE_PASSED_JOB,
	shardJobName,
} = require("./lander-job-names.js");
const { wholeRunShardCount } = require("./workflow-core-config.js");

const LANDER_SUITE_WORKFLOW = `.github/workflows/${ADOPTER_WORKFLOWS.suite}`;
const LANDER_NAMED_WORKFLOW = `.github/workflows/${ADOPTER_WORKFLOWS.named}`;

/** @param {string} e */
const expr = (e) => `\${{ ${e} }}`;
const SHA_INPUT = expr("inputs.sha");

/* workflow-core#5464 */
const DEFAULT_RUNNER = "ubuntu-24.04-arm";
/* A guess, workflow-core#5511. */
const DEFAULT_TIMEOUT_MINUTES = 15;

const LANDER_CONFIG_KEYS = [
	"commands",
	"commands.full_test",
	"commands.test",
	"fullTestShards",
	"ci",
	"ciSetup",
];

/**
 * @typedef {Pick<import("./workflow-core-config.js").Config,
 *   "commands" | "fullTestShards" | "ci" | "ciSetup">} LanderConfig
 */

/**
 * @param {LanderConfig} config
 * @returns {string}
 */
const renderJobHead = ({ ci }) => `    runs-on: ${ci?.runner ?? DEFAULT_RUNNER}
    timeout-minutes: ${ci?.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES}
`;

/** @param {string} what */
const header = (
	what,
) => `${CORE_MARKER} Written by workflow-core's upgrade, where the queue lander may test
# on Actions by run length ("landingTester" absent or "auto" in
# .claude/workflow-core.json), and REWRITTEN on every bump. ${what}
# Change the config, not this file. What it runs: the plugin's
# scripts/lib/lander-workflows.js.
`;

/**
 * @param {LanderConfig} config
 * @returns {string}
 */
function renderSuiteWorkflow(config) {
	const n = wholeRunShardCount(config);
	const ids = Array.from({ length: n }, (_, i) => `shard-${i + 1}`);
	const shards = ids
		.map(
			(id, i) => `  ${id}:
    name: ${shardJobName(i + 1, n)}
${renderJobHead(config)}${renderJobEnv()}${renderSetupSteps({ setup: config.ciSetup })}
      - name: ${GROUP_STEP}
        run: node .workflow-core/scripts/lander-ci.js group ${i + 1}/${n}
`,
		)
		.join("\n");
	return `${header('Its shard jobs follow\n# "fullTestShards", their runner and ceiling the "ci" key, their setup\n# "ciSetup".')}name: workflow-core lander

on:
  push:
    branches: ["lander/batch*", "lander/iso-suite-*"]

permissions:
  contents: read

jobs:
${shards}
  passed:
    name: ${SUITE_PASSED_JOB}
    needs: [${ids.join(", ")}]
    if: \${{ always() }}
${renderJobHead(config)}    steps:
      - name: Every shard passed
        env:
          RESULTS: \${{ join(needs.*.result, ' ') }}
        run: |
          echo "shards: $RESULTS"
          for r in $RESULTS; do [ "$r" = success ] || exit 1; done
`;
}

/**
 * @param {LanderConfig} config
 * @returns {string}
 */
function renderNamedWorkflow(config) {
	return `${header('Its runner and ceiling\n# follow the "ci" key, its setup "ciSetup".')}name: workflow-core named rerun

run-name: named-rerun \${{ inputs.sha }} \${{ inputs.nonce }}

on:
  workflow_dispatch:
    inputs:
      sha:
        required: true
        type: string
      files:
        description: "The test files, one a line."
        required: true
        type: string
      nonce:
        description: "Tells this dispatch's run from another's at the same sha."
        required: true
        type: string

permissions:
  contents: read

jobs:
  named:
    name: ${NAMED_JOB}
${renderJobHead(config)}${renderJobEnv()}${renderSetupSteps({ ref: SHA_INPUT, setup: config.ciSetup })}
      # Through the environment, never \`\${{ }}\` in \`run:\`:
      # https://docs.github.com/en/actions/reference/security/secure-use#use-an-intermediate-environment-variable
      - name: ${NAMED_JOB}
        env:
          FILES: \${{ inputs.files }}
        run: |
          mapfile -t files <<<"$FILES"
          node .workflow-core/scripts/lander-ci.js files "\${files[@]}"
`;
}

/**
 * @param {LanderConfig} config
 * @returns {{rel: string, body: string}[]}
 */
const renderLanderWorkflows = (config) => [
	{ rel: LANDER_SUITE_WORKFLOW, body: renderSuiteWorkflow(config) },
	{ rel: LANDER_NAMED_WORKFLOW, body: renderNamedWorkflow(config) },
];

module.exports = {
	LANDER_CONFIG_KEYS,
	LANDER_NAMED_WORKFLOW,
	LANDER_SUITE_WORKFLOW,
	renderLanderWorkflows,
};
