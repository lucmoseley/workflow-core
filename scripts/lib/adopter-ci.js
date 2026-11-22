const { CHECKOUT_STEP, SETUP_NODE_STEP } = require("./lander-job-names.js");

const CI_WORKFLOW = ".github/workflows/workflow-core-ci.yml";

const CI_MARKER = "# CORE-OWNED.";

// 2.9 min measured, #5347
const DEFAULT_TIMEOUT_MINUTES = 15;

const CHECKOUT = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
const SETUP_NODE =
	"actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
const SEMGREP = "1.182.1";

/** @returns {string} */
const renderJobEnv = () => `    env:
      WORKFLOW_CORE_CHECKOUT: \${{ github.workspace }}/.workflow-core
      WFC_PLUGIN_ROOT: \${{ github.workspace }}/.workflow-core
      CLAUDE_PROJECT_DIR: \${{ github.workspace }}
`;

/**
 * @param {{ref?: string}} [tree]
 * @returns {string}
 */
function renderSetupSteps({ ref } = {}) {
	return `    steps:
      # Full history: the doc-map checks read git log.
      - name: ${CHECKOUT_STEP}
        uses: ${CHECKOUT} # v4
        with:
${ref ? `          ref: ${ref}\n` : ""}          fetch-depth: 0
          persist-credentials: false

      - name: ${SETUP_NODE_STEP}
        uses: ${SETUP_NODE} # v4
        with:
          node-version: 24

      # Inline, not the plugin's own pin reader (lib/plugin-state.js): the
      # plugin is checked out only once this step has read where it is.
      - id: core-pin
        name: Read the workflow-core pin
        run: |
          node - >> "$GITHUB_OUTPUT" <<'EOF'
          const fs = require("node:fs");
          let settings;
          try {
            settings = JSON.parse(fs.readFileSync(".claude/settings.json", "utf8"));
          } catch (e) {
            if (e.code !== "ENOENT") {
              console.error(\`.claude/settings.json will not read, so no workflow-core pin can be found: \${e.message} — commit a settings.json that parses and pins a workflow-core release tag\`);
              process.exit(1);
            }
          }
          const known = settings?.extraKnownMarketplaces ?? {};
          const key = Object.keys(settings?.enabledPlugins ?? {}).find((k) => {
            const [name, marketplace] = k.split("@");
            return name === "workflow-core" && Object.hasOwn(known, marketplace);
          });
          const source = key ? (known[key.split("@")[1]]?.source ?? {}) : {};
          const ref = source.ref;
          const repo =
            source.repo ??
            /github\\.com[/:]([^/]+\\/[^/]+?)(?:\\.git)?\\/?$/.exec(source.url ?? "")?.[1];
          if (!repo || !/^v?\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(ref ?? "")) {
            console.error(\`.claude/settings.json pins no workflow-core release tag on GitHub (found: \${ref ?? "none"}\${repo ? \` on \${repo}\` : ""}) — pin a release tag in extraKnownMarketplaces.<marketplace>.source.ref, its source a GitHub repo or url\`);
            process.exit(1);
          }
          console.log(\`repo=\${repo}\`);
          console.log(\`ref=v\${ref.replace(/^v/, "")}\`);
          EOF

      - name: ${CHECKOUT_STEP}
        uses: ${CHECKOUT} # v4
        with:
          repository: \${{ steps.core-pin.outputs.repo }}
          ref: \${{ steps.core-pin.outputs.ref }}
          persist-credentials: false
          path: .workflow-core
      # Kept out of every git-reading check's view of the tree.
      - run: echo /.workflow-core/ >> .git/info/exclude

      - name: Install dependencies
        run: |
          if [ -f package-lock.json ]; then npm ci; fi
          if [ -f requirements-dev.txt ]; then python3 -m pip install --require-hashes --only-binary ":all:" -r requirements-dev.txt; fi
`;
}

/**
 * @param {import("./workflow-core-config.js").Ci} ci
 * @returns {string}
 */
function renderCiWorkflow({
	runner,
	timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
}) {
	return `${CI_MARKER} Written by workflow-core's upgrade from the \`ci\` key in
# .claude/workflow-core.json, and REWRITTEN on every bump. Change the key, not
# this file. What it runs: the plugin's scripts/lib/adopter-ci.js. Why:
# lucmoseley/workflow-core-tracker#5343 and lucmoseley/workflow-core-tracker#5347.
name: workflow-core CI

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  ci:
    name: Tests and guards
    runs-on: ${runner}
    timeout-minutes: ${timeoutMinutes}
${renderJobEnv()}${renderSetupSteps()}
      - name: Commands and shipped checks
        run: node .workflow-core/scripts/adopter-ci.js

      # In place of CodeQL. ERROR severity only, so a finding is one to act
      # on; silence a false positive with a \`nosemgrep: <rule-id>\` comment
      # carrying the reason.
      - name: Semgrep
        if: \${{ !cancelled() }}
        run: pipx run semgrep==${SEMGREP} scan --config p/default --severity ERROR --error --metrics off --exclude .workflow-core
`;
}

/** @param {string} text */
const isCoreCi = (text) => text.startsWith(CI_MARKER);

module.exports = {
	CI_MARKER,
	CI_WORKFLOW,
	DEFAULT_TIMEOUT_MINUTES,
	renderCiWorkflow,
	renderJobEnv,
	renderSetupSteps,
	isCoreCi,
};
