# Helper surface — adopter guide

The helper surface is the set of core files an adopter's checks and tests may import from outside the plugin, or run as commands: `scripts/lib/helper-surface.json` lists them, the names each exports, and each command's argv (#457, #655). An adopter holds one core file in its own tree, `scripts/lib/resolve-core.js`, which init and upgrade write, as its husky hooks run through it (#1839). Where it has Python code it also keeps a copy of `scripts/lib/resolve_core.py` (#465), which init and upgrade rewrite from the plugin's copy where the adopter holds one (#5718). The manifest's `copies` lists each core file an adopter holds a copy of, so the comment gate lets that file's top comment carry its contract (#5562). It imports every surface helper through `resolveCore()` — never by a relative path, and never from a vendored copy.

`resolveCore()` finds the core in three places, first hit wins: `WORKFLOW_CORE_DIR`, an explicit override; `WORKFLOW_CORE_CHECKOUT`, where CI checked the core out; the installed plugin. A session and a git hook find the installed plugin. CI has no plugin installed, so it checks the core out itself, as below.

## CI: checking the core out at the pin

CI takes the core-owned workflow, `.github/workflows/workflow-core-ci.yml`: the upgrade writes it where `.claude/workflow-core.json` carries a `ci` key, and rewrites it on every bump (`scripts/lib/adopter-ci.js`, #5347). Its job checks the core out at the tag `.claude/settings.json` pins, into `.workflow-core`, and sets `WORKFLOW_CORE_CHECKOUT` there, so `resolveCore()` finds it. Write no checkout steps of your own: a pin that is a branch or a SHA fails the job's first step, naming the fix.

## Running a core command

The manifest's `commands` lists the core scripts whose argv is promised, beside `entryPoints`; an unlisted script's argv may change in any release. Spawn a listed one from the resolved core, never a copy: `spawnSync(process.execPath, [path.join(resolveCore(), "scripts/register-doc.js"), …])`, or the resolver's script form, `node scripts/lib/resolve-core.js scripts/register-doc.js …`, which exits as the script did.

A core command a migration note's `[act]` step has an adopter write into its own code or config — a hook, a test, CI, an npm script, a `.claude/workflow-core.json` command — is listed here before the note ships, as `biome-staged.js` is (#4616). A file a step has an adopter import or source goes on `entryPoints` the same way, with the names the step gives, as `rule-text.sh` and `rule-text.js` are (#4780). A command a step has someone run once by hand, such as a breach lister, stays unlisted: they run it while reading the step, so a changed argv fails in front of them, not in an unattended call.

The seven husky hooks and the commands `.claude/workflow-core.md` and `.claude/workflow-core.reference.md` name run core scripts too, but each hook is a shim running the resolved core's own (#1839), and `init` and `upgrade` render the rules file from the release they call, so their argv is internal and unlisted (#663). An adopter's own forwarder that passes a session's argv straight to a core script is left with no caller once `upgrade` has spelled the rules file's commands at the plugin (#654): delete it then.

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

## Spawning the program under test

A test runs a Node program through `runInProcess` from `scripts/lib/run-in-process.js`. Where base §X3 keeps a real process, it spawns through `keptSpawn` from `scripts/lib/kept-spawn.js`, naming the reason: `keptSpawn("fd").spawnSync(process.execPath, [script], options)`, with `.spawn`, `.execFile` and `.execFileSync` beside it. The reasons are `REASONS`: `timeout`, `signal`, `concurrent`, `fd` and `boundary`. The pre-commit's `check-test-spawn.js` refuses any other spawn of `node` in a test.

## Reading the clock

A program reads the time through `now()` from `scripts/lib/clock.js`, so a test pins it with `WFC_NOW`; a guard core passes its injected env, `now(ctx.env)`. The pre-commit's `check-clock-copies.js` refuses any other read of `WFC_NOW` in your `scripts/`. A program times a span on the clock `durationClock()` returns, so a test fixes each span with `WFC_STEP_MS`, every read that many ms past the last; a program that spawns deletes `WFC_STEP_MS` from `process.env` once it has built its clock, so no child inherits it.

## Failing open in Python

A program-routed `.py` that keeps working past an error it caught hands that error to `fail_open` from `scripts/lib/fail_open.py`, imported from that module, in a statement of the handler itself, with what it does instead: `except OSError as e: fail_open(e, "cache read as empty")`. It prints both to stderr. A drop the program counts into a tally it prints goes to `tallied(e, tally, key)` instead, and a condition that is the program's normal path, such as a process gone between listing and read, to `expected(e, "<outcome>")` under a specific caught type; neither prints. The pre-commit's `check-swallowed-errors.js` refuses any other `except` that neither raises nor exits, and a test pins each site.

## Proving a release against your checks

Declare `commands.helper_check` in `.claude/workflow-core.json`: a command that imports surface helpers through `resolveCore()` and exits non-zero on a failure. A release cut with `--dry-run-adopter <your checkout>` runs it against the rendered release tree, `WORKFLOW_CORE_DIR` pointed there, before the tag exists (#464); undeclared, that step skips. It runs in a copy of your tree without `node_modules`, so it must need no npm package: plain `node`, never a test runner.

## Running the suite through the core

A green run records a certificate, and the unasked-rerun guard refuses a bare re-run of a tree certificates already attest. Two things record one, and an adopter wires both (#552).

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

- **A bare `npm run test` is the session's touched tests** — the test files it edited and those that directly import or read a file it changed — and never widens; the lander runs the full suite (#2930). One exception (#4967): a changed guard-registry anchors file, read-edge manifest or instruction-surface anchors file selects only its checker tests, and the banner counts the readers left to the lander.
- **The pytest runner is the core's `scripts/run-pytest.js`**, reached the same way. Its listed argv is bare and a lone `--full`, the whole suite, which a CI step passes: a bare run in a clean checkout selects nothing. It exits 0 or 1, never pytest's own code (#4779).
- **CI runs `npm run test:ci`** unless it checks the core out as above: with no core to resolve, `npm run test` exits 1 naming the pin, while plain vitest runs with the recorders left off.
- **A runner of your own prints the run-cost report through the core, never a copy of its wording**: write a JSON object of each test file it timed to its seconds, then `node scripts/lib/resolve-core.js scripts/lib/run-cost-report.js <timings.json>` after the suite's summary (#1880).
- **The suite concurrency guard offers `--queue` only to a launch whose npm script calls `run-vitest.js`**, the flag being that runner's alone. Any other npm `test` script, and a `node --test`, pytest or declared `suiteRunners` launch, is offered the core's `scripts/queue-run.js` instead (#1776).
