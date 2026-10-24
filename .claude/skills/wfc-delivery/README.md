# wfc-delivery

A mod that brings a report this session's own start produced into the session while it runs, rather than leaving it for the next session start (#849), a release request against a file it holds at its next turn, rather than at its next write to that file (#855), and a sweep verdict that changes mid-session within about ten minutes of the run finishing (#856).

Every 30 s it stats the notify-reports store, the request register and the claim store. Only when a stat changes does it run `scripts/deliver-to-session.js` with that source's flag: `--reports` for the store, `--requests` for the other two. The script owns every rule of what is due; a request is told in the arbiter's own wording and once with its write path, within the hour. Every 10 minutes, beginning 10 minutes in, it runs `--ci`: one `gh` call for the newest run carrying a verdict, and only where that run differs from the last one this session saw, the full CI check with `--recheck`, which fires no sweep and leaves the delivery stamps to the session-start route. Non-empty output is appended once as a `user` row the model reads, written to the debug log, and toasted where a surface draws. It hooks `session.start` alone and never submits a prompt, so it skips no guard and wakes no idle session. The session-start replay is untouched: a report delivered early still shows at the next session start.

**Tested on Claude Code 2.1.294. Floor: 2.1.289.** Below it the mod starts nothing and says so once in the debug log.

## How it loads

- **In workflow-core**, as a stand-alone mod, `wfc-delivery@skills-dir`, in any session started at the repo's root.
- **In an adopter**, through the workflow-core plugin's one entry module (#933), in any session started at the adopter's root that loads the plugin. Loaded that way, it runs the `scripts/deliver-to-session.js` the plugin ships, not one in the adopter, with the session's folder as its working folder, so the script finds the adopter's own stores. Where the session's folder also carries `.claude/skills/wfc-delivery/`, this load starts nothing and says so in the debug log, so the mod never runs twice.

At session start it checks, in order, the Claude Code floor, then that double-load guard. Each one that stops it writes one debug-log line naming why.

## Switching it off

No repo can switch it off. It tells the model what the session must act on, and CLAUDE.md's rule that a holder reads a release request at its next turn depends on it, so the committed `mods` key has no `wfc-delivery` switch.

The emergency off switch, for a mod that breaks a session, is one seat's own:

- **In workflow-core**, this line in `.claude/settings.local.json` turns the stand-alone load off:

  ```json
  { "enabledPlugins": { "wfc-delivery@skills-dir": false } }
  ```

- **In an adopter**, the mod loads with the plugin's guards, so the plugin's own line would turn those off too. An empty `.claude/skills/wfc-delivery/` folder stops the hosted load alone, through the double-load guard above, and git never commits an empty folder.

## Checking it

- `claude plugin test .claude/skills/wfc-delivery`: the mod's own tests. The ordinary vitest suite never collects them.
- `claude plugin validate .claude/skills/wfc-delivery`: must list `session.start` as the only hook. `scripts/wfc-mods-validate.test.ts` asserts it.
- `npm run typecheck`: its third pass type-checks the module and tests.

**The engine's types are an untracked copy** (#1960): Claude Code's declarations carry no grant to redistribute them. The engine writes no `.claude-plugin/types/` for a `@skills-dir` mod (#851, check (e)), so `npm run typecheck` copies the newest unpacked `plugin-authoring` skill's `types/claude-code.d.ts` to the gitignored `.claude-plugin/types/claude-code/index.d.ts`, and skips the mod's pass where no session has unpacked that skill.

**The tests need Claude Code 2.1.293 or later** (#896), above the mod's own floor. The pre-push gate (`scripts/run-mod-tests.js`) reads its floor from this bolded sentence and, below it, warns and skips the tests rather than refusing the push (#901); reword it and the gate loses the floor.
