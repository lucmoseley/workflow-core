# wfc-liveness

A mod that shows, under the prompt, how many subagents are running and names any that are stalled (#480, #863).

A subagent is **stalled** when its status is `running` and no model step has started in it for 5 minutes, clocked from the moment the mod first saw it listed where no step was seen, and from its return to `running` after any other status. Each stalled agent is named with its task description, how long it has been quiet, and what it was doing: *model answering*, *running <tools>*, or *between steps*. The longest stall comes first. `pending`, `waiting` and `idle` agents are never judged. The line clears when no subagent is `pending`, `running` or `waiting`. One toast marks each stall's onset; the onset and the end go to the debug log.

Every 5 s it makes one `$.agent.list()` call; it forks no process, and reads no file but the repo's `.claude/workflow-core.json`, once at its start. It hooks `session.start`, `turn.step`, `turn.complete`, `ui.render` on its own pane and `command.run` on `/liveness` alone, passes every step's stream and result through untouched, and never tells the model, wakes the session, or stops or messages an agent. The `Artefact:` line and `scripts/watch-artefact.js` are untouched and still give the parent session its abandon rule.

**Tested on Claude Code 2.1.292. Floor: 2.1.289.** Below it the mod starts nothing and says so once in the debug log.

## The pane

Type `/liveness` to open a pane with one row per subagent the session lists, live or finished: its task description, type, status, steps so far, what it is doing and for how long, and `stalled, <time> quiet` while it is stalled. Its times move every 5 s. Type `/liveness` again to close it, or close it from its mark. The command runs at once, even mid-turn, starts no model turn, and the pane never opens unasked. A finished, failed or killed agent keeps its row with its final status until the engine stops listing it, about 30 s after it ends (#864).

## How it loads

- **In workflow-core**, as a stand-alone mod, `wfc-liveness@skills-dir`, in any session started at the repo's root.
- **In an adopter**, through the workflow-core plugin's one entry module (#933), in any session started at the adopter's root that loads the plugin. Where the session's folder also carries `.claude/skills/wfc-liveness/`, this load starts nothing and says so in the debug log, so the mod never runs twice.

At session start it checks, in order, the Claude Code floor, the repo's off switch, then that double-load guard. Each one that stops it writes one debug-log line naming why.

## Switching it off

It keeps a repo-wide switch, where the delivery mod has none (#1467): it only displays, and never tells the model or acts, so a repo that turns it off loses no rule. For every seat and session in a repo, add this key to the repo's `.claude/workflow-core.json` and commit it:

```json
"mods": { "wfc-liveness": false }
```

A missing file, a missing `mods` key or a mod missing from it leaves the mod on. A file that cannot be read or parsed also leaves it on, with one debug-log line, and a `mods` value that is no object of booleans leaves it on with a `readConfig` warning as well.

In workflow-core alone, this line in `.claude/settings.local.json` also turns the stand-alone load off, for that seat only. In a repo that also loads the workflow-core plugin, the guard above still sees the folder, so that line leaves neither load running:

```json
{ "enabledPlugins": { "wfc-liveness@skills-dir": false } }
```

## Checking it

- `claude plugin test .claude/skills/wfc-liveness`: the mod's own tests. The ordinary vitest suite never collects them; pre-push runs them when a push touches this folder, and every scheduled sweep that tests runs them on the newest Claude Code (#1854).
- `claude plugin validate .claude/skills/wfc-liveness`: must list exactly those five hooks. `scripts/wfc-mods-validate.test.ts` asserts it.
- `npm run typecheck`: one of its passes type-checks the module and tests.

**The engine's types are an untracked copy** (#1960): Claude Code's declarations carry no grant to redistribute them. The engine writes no `.claude-plugin/types/` for a `@skills-dir` mod (#851, check (e)), so `npm run typecheck` copies the newest unpacked `plugin-authoring` skill's `types/claude-code.d.ts` to the gitignored `.claude-plugin/types/claude-code/index.d.ts`, and skips the mod's pass where no session has unpacked that skill. `types/index.d.ts` is the mod's own `$.state` contract.
