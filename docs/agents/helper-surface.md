# Helper surface — adopter guide

The helper surface is the set of core files an adopter's checks and tests may import from outside the plugin, or run as commands: `scripts/lib/helper-surface.json` lists them, the names each exports, and each command's argv (workflow-core#457, workflow-core#655). An adopter holds one core file in its own tree, `scripts/lib/resolve-core.js`, which init and upgrade write, as its husky hooks run through it (workflow-core#1839). Where it has Python code it also keeps a copy of `scripts/lib/resolve_core.py` (workflow-core#465). It imports every surface helper through `resolveCore()` — never by a relative path, and never from a vendored copy.

`resolveCore()` finds the core in three places, first hit wins: `WORKFLOW_CORE_DIR`, an explicit override; `WORKFLOW_CORE_CHECKOUT`, where CI checked the core out; the installed plugin. A session and a git hook find the installed plugin. CI has no plugin installed, so it checks the core out itself, as below.

## CI: checking the core out at the pin

### Founder setup, once per adopter

Outside Claude Code, and never scripted around (workflow-core#458, the deploy-key checkout spike).

1. Make a key pair with no passphrase: `ssh-keygen -t ed25519 -N '' -C <adopter>-core-checkout -f <file>`.
2. Register the public half on `lucmoseley/workflow-core` as a **read-only** deploy key — Settings → Deploy keys, "Allow write access" left unticked, or `gh repo deploy-key add <file>.pub -R lucmoseley/workflow-core -t <adopter>-core-checkout`, which is read-only unless given `--allow-write`. Confirm `read_only: true` in `gh api repos/lucmoseley/workflow-core/keys`.
3. Store the private half as an Actions secret on the adopter — Settings → Secrets and variables → Actions — named `WORKFLOW_CORE_DEPLOY_KEY`.
4. Delete both key files.

One key per adopter: GitHub's documentation refuses a deploy key already registered on another repository, and a per-adopter key revokes alone.

### The workflow steps

Set the resolver's variable on the job and add these steps after the adopter's own checkout and before anything that imports through `resolveCore()`:

```yaml
    env:
      WORKFLOW_CORE_CHECKOUT: ${{ github.workspace }}/.workflow-core
    steps:
      - uses: actions/checkout@v7
      - id: core-pin
        name: Read the workflow-core pin
        run: |
          node - >> "$GITHUB_OUTPUT" <<'EOF'
          const fs = require("node:fs");
          let settings = null;
          try {
            settings = JSON.parse(fs.readFileSync(".claude/settings.json", "utf8"));
          } catch {}
          const known = settings?.extraKnownMarketplaces ?? {};
          const key = Object.keys(settings?.enabledPlugins ?? {}).find((k) => {
            const [name, marketplace] = k.split("@");
            return name === "workflow-core" && marketplace in known;
          });
          const ref = key ? known[key.split("@")[1]]?.source?.ref : undefined;
          if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(ref ?? "")) {
            console.error(`.claude/settings.json pins no workflow-core tag (found: ${ref ?? "none"}) — pin a release tag in extraKnownMarketplaces.<marketplace>.source.ref`);
            process.exit(1);
          }
          console.log(`ref=v${ref.replace(/^v/, "")}`);
          EOF
      - name: Require the core deploy key
        env:
          DEPLOY_KEY: ${{ secrets.WORKFLOW_CORE_DEPLOY_KEY }}
          PIN: ${{ steps.core-pin.outputs.ref }}
        run: |
          if [ -z "$DEPLOY_KEY" ]; then
            echo "secret WORKFLOW_CORE_DEPLOY_KEY is unset or empty, so workflow-core $PIN cannot be checked out — founder setup: workflow-core's docs/agents/helper-surface.md" >&2
            exit 1
          fi
      - uses: actions/checkout@v7
        with:
          repository: lucmoseley/workflow-core
          ref: ${{ steps.core-pin.outputs.ref }}
          ssh-key: ${{ secrets.WORKFLOW_CORE_DEPLOY_KEY }}
          persist-credentials: false
          path: .workflow-core
```

- **The tag comes from the pin**, `.claude/settings.json` → `extraKnownMarketplaces[<marketplace>].source.ref`, found the way `resolveCore()` finds it. A branch or a SHA pin fails the step: it names no release (`docs/agents/adopter-upgrade.md` §The four records). The core's tags carry the `v`, so the step outputs that spelling whichever the pin uses.
- **The key check comes before the checkout**: `actions/checkout` without a key fails naming neither the pin nor the secret (workflow-core#458). It catches only an absent key: a wrong or revoked key, or a pin naming a tag the core never cut, still fails inside `actions/checkout` — neither was run at workflow-core#458.
- **A run with no Actions secrets stops at the key check**, per GitHub's documentation: a pull request from a fork, and a run Dependabot triggers, which reads Dependabot secrets instead — store the key there too if Dependabot's pull requests run this job.
- **The default shallow fetch is enough.** A tag ref checks out detached at depth 1; no `fetch-depth` or `fetch-tags` is needed.
- **`persist-credentials: false`** — the default leaves the key configured in the core checkout for every later step, which needs only the files.
- **No `ssh-keyscan`**: `actions/checkout` pins GitHub's host keys itself.
- **The core lands inside the adopter's tree**: `actions/checkout`'s `path` is relative to the workspace, per its documentation. A tool the job runs over the whole tree — a linter, a formatter check — sees `.workflow-core/` too; exclude it there. The adopter's own checkout goes first: a checkout into the workspace root can clear what is already there.

## Running a core command

The manifest's `commands` lists the core scripts whose argv is promised, beside `entryPoints`; an unlisted script's argv may change in any release. Spawn a listed one from the resolved core, never a copy: `spawnSync(process.execPath, [path.join(resolveCore(), "scripts/register-doc.js"), …])`, or the resolver's script form, `node scripts/lib/resolve-core.js scripts/register-doc.js …`, which exits as the script did.

The seven husky hooks and the commands `.claude/workflow-core.md` and `.claude/workflow-core.reference.md` name run core scripts too, but each hook is a shim running the resolved core's own (workflow-core#1839), and `init` and `upgrade` render the rules file from the release they call, so their argv is internal and unlisted (workflow-core#663). An adopter's own forwarder that passes a session's argv straight to a core script is left with no caller once `upgrade` has spelled the rules file's commands at the plugin (workflow-core#654): delete it then.

Each entry is the command's **argv contract**:

- `positionals` — in the order the command reads them. Where a positional lists `values`, only those are promised: `checker-new-faults.js` has more profiles, and they may change in any release.
- `flags` — each flag the command reads, in any order after the positionals. One with a `value` takes the next argument as its value; one without is a switch.
- `exit` — each exit code and what it means.

The contract does not cover the wording of stdout or stderr, except where an `exit` entry says what stdout carries. It also does not cover flags or values the entry does not list.

**Versioning** follows the exports rule, in the manifest's `versioning` field. These changes are major and need a migration note:

- removing a command;
- removing or reordering a positional;
- removing a flag or a listed value;
- adding a positional or flag a caller must now pass;
- changing what an exit code means.

The core's release gate refuses the first three on a minor cut; the manifest does not mark which arguments are required, so the last two go unseen.

**An adopter's drift check**, the `helper_check` below, should check more than whether each spawned script exists. For every command it spawns, it should read the resolved core's `helper-surface.json` and confirm three things:

- the command is listed;
- each positional it passes sits at the listed place, and each profile value it passes is listed;
- each flag it passes is listed.

## Proving a release against your checks

Declare `commands.helper_check` in `.claude/workflow-core.json`: a command that imports surface helpers through `resolveCore()` and exits non-zero on a failure. A release cut with `--dry-run-adopter <your checkout>` runs it against the rendered release tree, `WORKFLOW_CORE_DIR` pointed there, before the tag exists (workflow-core#464); undeclared, that step skips. It runs in a copy of your tree without `node_modules`, so it must need no npm package: plain `node`, never a test runner.

## Running the suite through the core

With the `suites` module on (`.claude/workflow-core.json` → `modules`), a push warns unless the sha carries a green run. Two things record one, and an adopter wires both (workflow-core#552).

**The recorders**, attached in the adopter's `vitest.config.ts` from the resolved core. They ship in the plugin as the helper surface's three `.ts` entry points, which only vitest loads:

```ts
import path from "node:path";
import { defineConfig } from "vitest/config";
import { resolveCore } from "./scripts/lib/resolve-core.js";

/* None where no core resolves — a CI job that never checked it out. */
function coreRecorders() {
	let core: string;
	try {
		core = resolveCore();
	} catch {
		return { reporters: ["default"] };
	}
	const at = (file: string) => path.join(core, "scripts", file);
	return {
		globalSetup: [at("vitest-tree-watch.ts")],
		reporters: [
			"default",
			at("vitest-pass-reporter.ts"),
			at("vitest-inflight-reporter.ts"),
		],
	};
}

export default defineConfig({ test: { ...coreRecorders() } });
```

Merge `globalSetup` and `reporters` with any the config already has. The pass reporter and the tree watch share one record in memory, so attach both or neither.

**The runner**, the core's `scripts/run-vitest.js`, reached through the resolver's script form: `node scripts/lib/resolve-core.js <core-relative script> [args…]` runs it and exits as it did. Its listed argv is the two spellings below, bare and `--changed`; its other flags are the core's own rules' to change.

```json
"test": "NODE_OPTIONS=--max-old-space-size=2048 node scripts/lib/resolve-core.js scripts/run-vitest.js",
"test:changed": "NODE_OPTIONS=--max-old-space-size=2048 node scripts/lib/resolve-core.js scripts/run-vitest.js --changed",
"test:ci": "NODE_OPTIONS=--max-old-space-size=2048 vitest run"
```

- **A bare `npm run test` narrows to the diff only where `docs/test-read-edges.json` is committed and the read graph renders from the tree.** Otherwise it runs the whole suite, its banner naming `stale-manifest`.
- **CI runs `npm run test:ci`** unless it checks the core out as above: with no core to resolve, `npm run test` exits 1 naming the pin, while plain vitest runs with the recorders left off.
- **A runner of your own prints the run-cost report through the core, never a copy of its wording**: write a JSON object of each test file it timed to its seconds, then `node scripts/lib/resolve-core.js scripts/lib/run-cost-report.js <timings.json>` after the suite's summary (workflow-core#1880).
- **The suite concurrency guard offers `--queue` only to a launch whose npm script calls `run-vitest.js`**, the flag being that runner's alone. Any other npm `test` script, and a `node --test`, pytest or declared `suiteRunners` launch, is offered the core's `scripts/queue-run.js` instead (workflow-core#1776).
