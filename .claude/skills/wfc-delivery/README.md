# wfc-delivery

A mod that brings a report this session's own start produced into the session while it runs, rather than leaving it for the next session start (workflow-core#849), and a sweep verdict that changes mid-session within about ten minutes of the run finishing, while a turn runs (workflow-core#856, workflow-core#3247).

Every 30 s while a main-loop turn runs, and once at that turn's start before its first model request, it stats the notify-reports store. Only when that stat changes does it run `${CLAUDE_PLUGIN_ROOT}/scripts/deliver-to-session.js --reports`. The script owns every rule of what is due. On the first interval tick 10 minutes or more after the session's start or its last check, it runs `--ci`: one `gh` call for the newest run carrying a verdict, and only where that run differs from the last one this session saw, the full CI check with `--recheck`, which fires no sweep and leaves the delivery stamps to the session-start route. Non-empty output is appended once as a `user` row the model reads, written to the debug log, and toasted where a surface draws. Between turns it stats nothing and spawns nothing (workflow-core#3247): it hooks `turn.start` and `turn.complete` on the main loop to start and stop its loop, and `session.start` to set it up. It never submits a prompt, so it skips no guard and wakes no idle session. The session-start replay is untouched: a report delivered early still shows at the next session start.

**Tested on Claude Code 2.1.294. Floor: 2.1.289.** Below it the mod starts nothing and says so once in the debug log.

## How it loads

- **In workflow-core**, as a stand-alone mod, `wfc-delivery@skills-dir`, in any session started at the repo's root.
- **In an adopter**, through the workflow-core plugin's one entry module (workflow-core#933), in any session started at the adopter's root that loads the plugin. Loaded that way, it runs the `${CLAUDE_PLUGIN_ROOT}/scripts/deliver-to-session.js` the plugin ships, not one in the adopter, with the session's folder as its working folder, so the script finds the adopter's own stores. Where the session's folder also carries `${CLAUDE_PLUGIN_ROOT}/.claude/skills/wfc-delivery/`, this load starts nothing and says so in the debug log, so the mod never runs twice.

At session start it checks, in order, the Claude Code floor, then that double-load guard. Each one that stops it writes one debug-log line naming why.

## Switching it off

No repo can switch it off. It tells the model what the session must act on, so the committed `mods` key has no `wfc-delivery` switch.

The emergency off switch, for a mod that breaks a session, is one seat's own:

- **In workflow-core**, this line in `.claude/settings.local.json` turns the stand-alone load off:

  ```json
  { "enabledPlugins": { "wfc-delivery@skills-dir": false } }
  ```

- **In an adopter**, the mod loads with the plugin's guards, so the plugin's own line would turn those off too. An empty `${CLAUDE_PLUGIN_ROOT}/.claude/skills/wfc-delivery/` folder stops the hosted load alone, through the double-load guard above, and git never commits an empty folder.

## Checking it

- `claude plugin test ${CLAUDE_PLUGIN_ROOT}/.claude/skills/wfc-delivery`: the mod's own tests. The ordinary vitest suite never collects them.
- `claude plugin validate ${CLAUDE_PLUGIN_ROOT}/.claude/skills/wfc-delivery`: must list `session.start`, `turn.start` and `turn.complete` as its only hooks. `${CLAUDE_PLUGIN_ROOT}/scripts/wfc-mods-validate.test.ts` asserts it.
- `npm run typecheck`: its third pass type-checks the module and tests.

**The engine's types are an untracked copy** (workflow-core#1960): Claude Code's declarations carry no grant to redistribute them. The engine writes no `.claude-plugin/types/` for a `@skills-dir` mod (workflow-core#851, check (e)), so `npm run typecheck` copies the newest unpacked `plugin-authoring` skill's `types/claude-code.d.ts` to the gitignored `.claude-plugin/types/claude-code/index.d.ts`, and skips the mod's pass where no session has unpacked that skill. `types/index.d.ts` is the mod's own `$.state` contract: whether a main-loop turn runs, kept by the host so the fresh load after a lost hooks worker resumes the loop mid-turn (workflow-core#3251).

**The tests need Claude Code 2.1.293 or later** (workflow-core#896), above the mod's own floor. The pre-push gate (`${CLAUDE_PLUGIN_ROOT}/scripts/run-mod-tests.js`) reads its floor from this bolded sentence and, below it, warns and skips the tests rather than refusing the push (workflow-core#901); reword it and the gate loses the floor.
