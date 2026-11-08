# Adopter upgrade — agent guide

Reached by rule id, never always-loaded (workflow-core#231, the ticket that ruled this mechanism's enforcement and homing). An adopter's session meets this file only when the SessionStart reporter's injection names one of its rule ids, or when a session is told to update an adopter repo directly.

## The four records

- **Pin** — the adopter's declared intent. `.claude/settings.json` → `extraKnownMarketplaces[<marketplace>].source.ref`. A fixed tag, tracked in git. The only thing that selects a version. **A branch name and a SHA are what that field also accepts, and both are declined** (workflow-core#251): neither names a version, so an adopter carrying one has no pin, no gaps and no report — the same silence a directory-sourced adopter gets. A tag is semver with the `v` optional: `v1.1.8` and `1.1.8` are one tag under two spellings, compared as one.
- **Supply** — the local marketplace clone the CLI installs *from*, at `<config-dir>/plugins/marketplaces/<marketplace>`. One per machine per config dir, one ref at a time, rotated only by `claude plugin marketplace add`.
- **Install record** — the per-project row in `<config-dir>/plugins/installed_plugins.json`, keyed `<plugin>@<marketplace>`. Its `installPath` is authoritative; its `gitCommitSha` is never consulted, being written at install and not refreshed on update.
- **Running plugin** — `<installPath>/.claude-plugin/plugin.json`, the bytes that actually load.

"Installed" means the running plugin's own `version`, reached through the install record's `installPath` for the project in question, under the config dir in force. `CLAUDE_PLUGIN_ROOT` cannot stand in for this: it only answers for the repo whose session is running.

## The two gaps, and the exact command that closes each

"Behind" is always two gaps, never one number, and both are owed only while the install is not at the pin: the supply is read only at install time (inferred from install timestamps at workflow-core#738, not observed), so another adopter's tag sitting there is no gap and no contention, and the `SessionEnd` materialiser skips its three `claude` calls and goes straight to the migration walk (workflow-core#747).

- **Supply behind pin** — the supply's ref does not match the pin. Closed by:

  ```
  claude plugin marketplace add <url>#<ref> --scope project
  ```

- **Install behind supply** — the running plugin's version does not match the pin, which the supply sits on or is rotated onto first. Closed by:

  ```
  claude plugin install <name>@<marketplace> -y --scope project
  claude plugin update <name>@<marketplace> --scope project -y
  ```

Both gaps together mean all three commands, in order — see `rule:adopter-materialise-sequence`.

`<url>` is a template only where the pin names no clone URL of its own. Where `source.url` is on disk the reporter substitutes it (workflow-core#251).

## The third reading: materialised but not yet live

Neither gap is open and there is still a difference — the supply and the install record agree with the pin, but **this process loaded the previous bytes**. That is what the `SessionEnd` materialiser (workflow-core#247) leaves behind on success.

Nothing is owed. No command closes it, no consent is asked for, and it ends when the session does. The reporter says so in one line and stops.

## The migration walk lands as one commit, never pushed (workflow-core#249)

Once the `SessionEnd` materialiser (workflow-core#247) rotates the install, or finds it already at the pin, it runs the migration walk itself, `scripts/lib/walk-and-commit.js`, against that install path — never against this session's own stale `CLAUDE_PLUGIN_ROOT`.

The walk runs under four conditions:

- **A clean adopter tree**, required before `upgrade()` is ever called. Dirty: defer with a line saying so, retried at the next session's exit.
- **One commit**, made by pathspec, containing only the walk's output — every migration note's residue through the last one that verified, plus the per-run hook re-templating `upgrade()` always does. The message body carries this walk's own additions to `stepsOwed` (workflow-core#248).
- **Never pushed.** The commit stays local; deploying it, if ever, is a separate, deliberate act.
- **A refusing pre-commit hook halts the walk and reports.** The walk's output is left uncommitted for a human to clear by hand.

**The half-way stop.** A note's `Verify` can fail after its residue has already been written. `upgrade()`'s `ceiling` parameter (its own JSDoc) lets the wrapper reset the tree to clean and replay the walk capped at the last tag that actually verified — sound because two notes can rewrite the same file, so no general per-note diff can isolate "this note's writes" any other way. The committed `walkedTo` always describes the committed tree, on both the clean and the half-way paths: a re-run is safe on any machine without inspecting anything.

## The founder's answer, on disk

The reporter puts the gap to a session as a priced yes/no; the founder answers
in the chat, never in a terminal. `scripts/lib/adopter-consent.js` is where
that answer lands, machine-locally, keyed `<repo>@<tag>` — `repo` the adopter
root the session ran in, `tag` the pin ref just proposed. `scripts/adopter-consent.js`
is the CLI over it, and the reporter prints its two commands verbatim
whenever a gap is open:

```
node scripts/adopter-consent.js accept  <repo> <tag>
node scripts/adopter-consent.js decline <repo> <tag>
```

A **decline** is permanent for that `<repo>@<tag>` — this reporter checks it
first and stays silent for exactly that tag; a different tag in the same
repo, or the same tag in a different adopter, still reports. A **pending
consent**, written on a yes, is read and cleared by the `SessionEnd`
materialiser (workflow-core#247) once its three-command sequence actually succeeds.
**Nothing in the store can express "accepted and completed"** — a failed
materialise leaves the pending record in place, so this reporter (which never
reads pending, only decline) keeps speaking and the founder is asked again.

On a yes, tell the founder plainly: this session keeps the plugin it started
with, and the next one will be current.

## `stepsOwed` — a manual step the walk could not discharge

A migration note's `## Manual steps` bullet is typed `[act]`, `[choice]` or
`[notice]` (workflow-core#246). The walker (`upgrade.js`) never blocks on any of the three
— `## Verify` is the sole gate — but a real run, once a note's own Verify has
passed, appends every one of that note's bullets to `.claude/workflow-core.json`'s
`stepsOwed`: a committed array of `{tag, type, text}`, populated only through
`scripts/lib/steps-owed.js`. The same list is also printed to stdout,
labelled for the commit message body — paste it verbatim: `stepsOwed` itself
gets cleared as entries are discharged, so the commit body is the only place
the full history of what a walk once owed survives.

**What a session meeting an entry does, by type:**

- **`act`** — perform it yourself. One attempted and failed **stays owed** —
  clear it only once it has actually succeeded, never on the attempt.
- **`choice`** — put it to the founder as a priced question. A decline is
  recorded as declined, not cleared, so his preference travels with the repo
  (in git) rather than being re-asked on the next machine or the next
  session here.
- **`notice`** — print it once, then clear it.

**The discharge route**, `scripts/steps-owed.js` — the only writer of this
field outside the walker:

```
node scripts/steps-owed.js list
node scripts/steps-owed.js clear   <tag> <act|choice|notice> "<text>"
node scripts/steps-owed.js decline <tag> "<text>"
```

`<tag>` and `<text>` must match the entry exactly, as `list` prints it.
`clear` refuses a malformed identifier — an unknown type, an empty tag or
text — before touching the file. `decline` only ever touches a `choice`.

The `check-plugin-gap.js` SessionStart reporter (workflow-core#243) surfaces every
undeclined `stepsOwed` entry — alongside the version-gap report where one is
open, and on its own where it is not. Its report carries the exact `clear`/
`decline` command for each entry.

The same reporter checks the `.husky/*` hooks, also whatever the gap state.
Each hook is a shim that finds the core at run time through
`scripts/lib/resolve-core.js`, so it names no plugin path and a bump never
rewrites it (workflow-core#1839). Where no core resolves for the shims it is a FAIL,
printing resolve-core's reason and the fix, since every commit is refused. A
hook that is not yet a shim names its plugin on a `WFC_PLUGIN_ROOT` line
(workflow-core#1168): a root that no longer exists is a FAIL, and one other than this
session's `CLAUDE_PLUGIN_ROOT` a WARN, both printing the `upgrade.js` command
that turns the hooks into shims.

## Which release carries a commit

`git tag --contains <sha>` is always empty: every release is a root commit, off every branch. In a workflow-core checkout, `node scripts/release-contains.js <sha>` answers it instead (workflow-core#797).

## Enforcement

<!-- guard-registry:begin -->
<!-- Every rule here carries **Enforced** / **Advisory** / **Unenforced** / **Unenforceable**; `scripts/check-guard-registry.js` gates it. -->

- **`rule:adopter-materialise-sequence`** — the three `claude` calls above are one sequence, never alternatives. `marketplace add` is the only step that rotates the supply's ref; `install` no-ops on an already-installed plugin; `update` is the only one that re-pulls. **Unenforceable** (workflow-core#231): the typed route is guardable in principle but deliberately not guarded, and the prose route — a session recommending the wrong command in chat — is unobservable by any `PreToolUse` hook.
- **`rule:adopter-pin-consent`** — the committed pin is the consent token. An agent session may advance it as a deliberate act — told to update the repo, editing the line and committing it — but an unattended advance never. **Unenforceable** (workflow-core#231): the writer is a script no hook sees.

<!-- guard-registry:end -->
