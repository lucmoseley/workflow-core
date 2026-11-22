/*
 * adopter-ci.js — renders the core-owned CI workflow of a private adopter
 * (workflow-core#5347, ruled on workflow-core#5343). core-owned-files.js writes
 * it where `.claude/workflow-core.json` carries a `ci` key, and removes the
 * core's copy where the key is gone.
 *
 * SIZED TO THE ACCOUNT'S 3,000 PRO MINUTES, which every private repo of the
 * account shares (workflow-core#5343's research):
 *   - ONE JOB, since GitHub rounds every job up to a whole minute. It runs the
 *     plugin's adopter-ci.js: the repo's own declared commands, then every
 *     shipped tree check whose gate holds. Semgrep CE follows in the same
 *     job, in place of CodeQL, which a Pro account cannot run on private code.
 *   - ON PUSH TO `main` ONLY, no manual trigger and never a `lander/*` ref: the lander's local
 *     tester gates before landing (lib/local-tester.js).
 *   - THE RUNNER the key names: `ubuntu-slim` (1 core, a third of the
 *     standard rate) where the job fits, else `ubuntu-24.04-arm`. Node is
 *     set to 24, as on the founder's machine, since the two images carry
 *     different versions; both carry Python 3.12.
 *   - A JOB CEILING, `timeoutMinutes`, default 15: a hung job bills until it
 *     is killed. GitHub ends a slim job at 15 whatever is set.
 *
 * NOTHING OF THE CORE'S OWN SUITE: no hourly alarm crons, no
 * bisect or named rerun. A stalled adopter queue is the refill loop's to
 * notice (workflow-core#5343 Q1).
 *
 * THE FALLBACK, should the account's use pass 60% of the pool: swap the push
 * trigger here for one run a night when `main` has moved (workflow-core#5347).
 *
 * THE PLUGIN IS CHECKED OUT AT THE TAG `.claude/settings.json` PINS, read at
 * run time so a bump needs no rewrite of this file. workflow-core is public,
 * so the checkout needs no key.
 */

/** The workflow's path in the adopter. */
const CI_WORKFLOW = ".github/workflows/workflow-core-ci.yml";

/** The first line of every copy the core writes; a file without it is the
 * adopter's own and never touched. */
const CI_MARKER = "# CORE-OWNED.";

/* About five times the 2.9-minute job workflow-core#5347's close measured; a guess past
 * that, carried as one there. */
const DEFAULT_TIMEOUT_MINUTES = 15;

/* actions/checkout v4, pinned to a full commit sha as GitHub's secure-use
 * guidance asks (docs/practice/ci-and-repo-quality-gates.md). */
const CHECKOUT = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
const SETUP_NODE =
	"actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
/* Pinned, never floating: a release older than two weeks at pinning. */
const SEMGREP = "1.182.1";

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
# this file. What it runs and why: the plugin's scripts/lib/adopter-ci.js.
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
    env:
      WORKFLOW_CORE_CHECKOUT: \${{ github.workspace }}/.workflow-core
      WFC_PLUGIN_ROOT: \${{ github.workspace }}/.workflow-core
      CLAUDE_PROJECT_DIR: \${{ github.workspace }}
    steps:
      # Full history: the doc-map checks read git log.
      - uses: ${CHECKOUT} # v4
        with:
          fetch-depth: 0
          persist-credentials: false

      - uses: ${SETUP_NODE} # v4
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

      - uses: ${CHECKOUT} # v4
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

/**
 * Whether `text` is a copy the core wrote.
 * @param {string} text
 */
const isCoreCi = (text) => text.startsWith(CI_MARKER);

module.exports = {
	CI_WORKFLOW,
	renderCiWorkflow,
	isCoreCi,
};
