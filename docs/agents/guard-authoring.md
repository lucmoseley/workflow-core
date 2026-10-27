# Building a guard — the eight surfaces, and the proof that it fires

A guard is a script wired to a Claude Code hook event that denies or warns on a
tool call. Ruled at mantahostels#1239 (should this repo have a guard generator, and an
authoring discipline that proves a new guard in both directions?): **no
generator** — the boilerplate is already factored into `scripts/lib/`, and guard
bodies are 70–670 lines of bespoke judgement.

## The eight surfaces

1. **The script** — `scripts/guard-<name>.{sh,js}`.
2. **A `# shellcheck source=scripts/lib/<lib>.sh` directive above every `source`
   line.** `-x` cannot resolve `"$here/lib/..."` statically, so without it that
   lib's globals come back from `npm run check:sh` as unassigned-variable noise.
3. **A sibling `scripts/guard-<name>.test.ts`**, proving both directions — the
   fire case and the pass case.
4. **A `self-plugin/hooks/hooks.json` registration**, with the right *event*
   and the right *matcher*. **Merge into the file; never clobber it** — it
   holds every other session's hooks too. It is an ordinary repo edit, with no
   permission prompt. `.claude/settings.json` keeps only the self-plugin
   canary, and `check-registrations.js` refuses any other hook there (#2447).
   - **A new entry reaches a session only at its next start or
     `/reload-plugins`**: plugin hooks do not reload live (spec #2295). One
     registered in a `.claude/worktrees/` checkout reaches sessions only once it
     lands in the main checkout, whose file the plugin loads.
   - **Then re-render `hooks/hooks.json`** — `node
     scripts/generate-plugin-hooks.js`. It is the plugin's copy of the
     self-plugin's registration, never hand-edited (#1011, #2441).
   - **Two spellings live in the file, and converting between them by copying a
     neighbour's quotes disables the guard silently.** The shell form is
     `"$CLAUDE_PROJECT_DIR"/scripts/x.sh` with no `args` key; the exec form
     (mantahostels#2059) is `${CLAUDE_PROJECT_DIR}/scripts/x.sh` **with** one. **Adding
     `args` while keeping the quoted spelling does not error visibly**: the
     entry stops going through a shell, so every tool call gets a non-blocking
     `ENOENT: no such file or directory, posix_spawn` that reaches the
     transcript and nothing else — no denial and no session output (mantahostels#2059).
     **Convert the quotes and the `args` key together, or neither.**
     - **`args` also carries the guard's own arguments, and the five readers
       named here all see them.** `guard-fires.js`'s registration key and
       `check-hook-liveness.js`'s **assertion 4** read `args`
       (mantahostels#2106); that checker's runtime census needs nothing, the
       harness writing the transcript's `.command` as `command` plus `args`
       joined. `check-guard-registry.js` matches a script path against
       `rule-emission.js`'s exported `buildHookCommandLine()` join rather than
       against `command`, so an interpreter-plus-script entry
       (`"command": "node"`) does not FAIL a commit with `UNWIRED-IF`;
       `rule-emission.js` uses the same join for its own RULE_CAP byte
       census (mantahostels#2266). And
       `lib/hook-wiring.ts` carries `args` through, its `buildCommandLine` helper
       being what `hook-registrations.test.ts` matches its ids against, so a
       pair told apart only by an argument (`concision-backstop.sh stop` /
       `start`) survives an exec-form conversion. The fifth,
       `check-instruction-surface.js`'s `readHookCommands`, also runs
       `buildHookCommandLine()` over each entry rather than reading `command` alone,
       so its `liveCommandCount`-versus-`hooks.total` census counts an
       exec-form entry as wired (mantahostels#2301). No entry holds a script
       path in `args` today, so all of it makes the next conversion safe.
       **The survey is five readers because five is what has been audited, not
       because five is all there are** — mantahostels#2266's review found one
       the first audit missed.
   - **An `if` field narrows which calls the guard is even exec'd on** —
     `Bash(git *)`, `Bash(gh *)`, and `Bash(*gh *)` on two guards that
     walk wrappers. **It
     fails toward running, not toward skipping** (`hooks.md:448`, quoted on
     mantahostels#2126) — never the sole gate on a hard refusal.
     **Measured** (mantahostels#2159 §5 and [docs/research/if-field-overmatch.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/if-field-overmatch.md) §5, 22
     commands across three sessions): it splits `;` and `|` as it does `&&`;
     it tests quoted argument text, so an unanchored arm fires on
     `echo "a gh mention"`; it does NOT test a heredoc body, so it parses the
     shell rather than searching the string; and the anchored arm matches
     neither a wrapper prefix nor a path spelling (`/usr/bin/gh …`), both of
     which the unanchored arms do.
     **Documented, not measured** (`hooks.md:353`, :436-446): it also runs each
     subcommand of a `&&` chain and
     reaches inside `$()` and backticks; §1a measured `||`, a background `&`,
     a newline and a subshell against one guard's own walker, not against this
     matcher, and no run carried a `#` comment.
     **The anchored form is the default because the unanchored one matched
     English** (mantahostels#2127): `Bash(*gh*)` fired on `through`, `right` and
     `neighbour`, 31.5% of its execs across 210,695 corpus Bash calls, and
     `Bash(*git*)` on `.gitignore`, `.github/` and `legitimate`, 19.8%.
     Anchoring costs almost nothing where the guard reads only a segment's own
     command word, which all but those two do — almost, because all of them
     resolve that word through `basename`, so a path-spelled call is judged by
     the guard and matched by neither anchored spelling: 43 calls corpus-wide. **The exceptions are
     `guard-issue-phase-scope.js` and the `guard-anthropic-report` core**, whose
     walkers step past a `timeout`/`env`/`nohup` prefix: anchoring would leave
     `timeout 60 gh issue create` unjudged in silence, so they keep a
     wrapper-tolerant `Bash(*gh *)`. **Match the `if` to what the guard's own
     walker reads, not to the tool word.** A new
     guard states its own `if` narrowing — one line
     where its LIMITS section already runs long, its own paragraph where it
     does not — never repeats this one (mantahostels#2126). **`check-guard-registry.js`
     gates three ways** (mantahostels#2212, mantahostels#2234): it FAILs
     `UNDECLARED-IF` where a hook entry carries an `if` the script's header
     never states verbatim, `STALE-IF` where the header states one no entry
     naming that script carries, and `UNWIRED-IF` where the header states one
     and `self-plugin/hooks/hooks.json` names that script in no entry at all — a
     script dropped from the wiring entirely, not just missing its `if` field.
     Its remedy: delete the header's `if` line, or wire the script. It matches
     the string, never the sentence around it — whether the blind-spot
     enumeration beside it was recomputed against the narrowing is still a
     reader's call, and the staleness warning is the surface for that.
   - **A removed entry runs on in every session started before its removal**,
     so a deleted script fails to start there, and under `onFailure: "block"`
     every call its line matches is refused. `scripts/keep-hook-shims.js`,
     run by `.husky/post-commit` and `.husky/post-merge`, writes an untracked
     exit-0 shim at each such path while a live session started on a line
     naming it, and deletes it once none did (#2879). **Delete a hook script
     in the same Bash call that commits the deletion**: your own session holds
     the old line too, and its next call would be refused before the shim was
     written; a port landing by merge is covered by the merge itself. Never
     restore a deleted script by hand. Re-adding a retired one, run `node
     scripts/keep-hook-shims.js` after writing it: until then its path is
     ignored and `git add` refuses it.
5. **A row in `scripts/hook-registrations.test.ts`'s pinned table.** Its own
   header says why nothing else can cover this — `check-guard-registry.js` is
   event-agnostic and matcher-blind — `if` is the one registration field it does
   read (mantahostels#2212), and this table still owns the event and the matcher.
6. **An entry in `.claude/guard-registry-anchors.json`**, where surface 8's
   sentence names the guard. It is generated, never typed:
   `node scripts/check-guard-registry.js --review scripts/guard-<name>.sh`.
   A later commit that changes the guard, or a file its digest hashes, is told
   at post-commit to re-read and re-anchor it (`--touched-by`, #2375).
7. **An entry in `scripts/guard-fire-needles.json`** — the deny, warn or inject
   text this guard prints, keyed by its filename, which is how
   `count-guard-fires.js` counts a guard's real fires; the file's own
   `_comment` defines `kind`'s value set, `inject` included (mantahostels#2136).
   `count-guard-fires.test.ts` fails a registration with no key and a key with
   no registration.
   - **The `text` must be a contiguous run of bytes a NON-TEST corpus file
     carries** — the guard, the `scripts/lib/` module holding its block text,
     or for an `inject` the `docs/agents/rules/` fragment it hands over. The
     containment corpus excludes test files (`scripts/lib/test-kind.js`'s
     `isCollectedTestOrConftest`, mantahostels#3288), because a test asserting on the guard's wording
     carries its own copy of it, so a needle keyed on the test passes
     containment while measuring nothing. Where the printed line escapes a
     character — a backtick inside a shell double-quoted string, a `❓` in JS —
     key on the longest unescaped run of it, and where no single run is
     distinctive enough, on an array of runs, all of which must appear.
   In an adopter, surfaces 5 and 7 live in the host instead (#1456): a
   `hooks` row in `.claude/registrations.json` and an entry in
   `.claude/guard-fire-needles.json`, judged by
   `guard-registry-atomicity.js` and `check-registrations.js`.
8. **A rule sentence** — a top-level bullet inside a `<!-- guard-registry:begin
   -->` region — tagged **Enforced** (naming the guard path in backticks),
   **Advisory** (naming the path of a guard that observes the rule and
   speaks, never refusing — #185; an issue owning a deterministic replacement
   is welcome and never owed), **Unenforced** (naming the issue that owns
   building it) or **Unenforceable**. `scripts/check-guard-registry.js` fails a
   rule carrying no marker, and fails a marker that lies. **A guard path named
   in backticks is tested for existence and wiring whatever the marker
   carrying it** (mantahostels#2347): only **Enforced** and **Advisory** must name one.
   **A warn-only guard is Advisory, never Enforced or Unenforced**: the first
   claims a refusal it does not make, the second reads as nothing wired at
   all. So **do not name a guard you have not
   written yet** — that FAILs as BROKEN-CLAIM; name the owning issue and no
   path. Wiring counts a `package.json` script as well as a
   hook entry, a husky file and a workflow.
   - **`Enforced` claims wiring, not delivery.** The registry's Enforced
     branch (`scripts/check-guard-registry.js:1612-1623`) requires only a
     named path; `checkNamedPaths` (`:1481-1500`) tests only that it exists
     and is wired — never that it fired. A wired guard killed mid-verdict
     fails open and the marker still reads true (mantahostels#2291).
   - **Its default home is `docs/agents/guard-registry.md`** (#1942), whose
     region the check reads like any other. A
     document that is already the rule's sole authority keeps it instead —
     `docs/effort-guide.md` carries a region because mantahostels#831 made it
     the sole authority on model choice.
   - **Never `CLAUDE.md` or another always-loaded file by default.** A rule
     enters one only where it binds before the session's first tool call, with
     an entry in `docs/pool-admission-ledger.json` giving its removal claim and
     route; `scripts/check-context-budget.js --against HEAD` refuses a commit
     adding a pool rule with none. Those bytes load every session against the
     pool's cap, so name the shed that pays for the sentence before writing it
     (`docs/doc-map.md` §Capture and placement).

<!-- guard-registry:begin -->
- **A session creating a guard is pointed at this list as it writes the script.**
  **Advisory** (#1011): `scripts/guard-dispatch.js` (its `guard-file-claim` core) hands over
  `rule:guard-authoring` on a `Write` creating `scripts/guard-*.sh` or
  `scripts/guard-*.js`, once a session. A guard created through Bash, or
  named otherwise, gets nothing.
<!-- guard-registry:end -->

## The proving discipline

> A guard is not shipped until it has been observed firing through the real hook
> seam once — the actual tool call, in a live session, producing the actual deny
> or warn text — and the sibling test proves both directions of its logic.

**The wiring clause leads, and that is deliberate.** Two measurements say logic
is the wrong target here.

- **Every guard in this repo already tests both directions** — 14 scripts, 14
  sibling tests on 24 August 2026, each carrying fire-cases and pass-cases. The
  logic clause codifies universal existing practice.
- **Every guard failure this repo has recorded is one layer out.** mantahostels#112 and mantahostels#117
  shipped guards built and never wired. mantahostels#258 found 10 of 15 registrations with
  no event-or-matcher test. mantahostels#872 found the priced-options `Stop` guard
  silently missing four defective turns in one background session.
  mantahostels#1254 found two of three `Stop` guards reading an empty outgoing message on **91%** of final turns — 246 of 270 sessions for
  `guard-priced-options`. All had passing both-direction tests.

## The independence line — dormant

> The session that builds a guard does not also author the scenarios that judge
> the stack it joins.

Adopted at mantahostels#1239 (routed from mantahostels#1163, does the independence line apply here, and
is a builder-blind validator affordable?) and **dormant**: it binds from the
moment stack scenarios first exist, and none do — mantahostels#1163 deliberately built none.
The subject is the whole hook stack firing in one session, not any single
guard.

mantahostels#325 ruled that an author judging its own output is not a pass, **for prose
only**; `readProcStartOf`'s comment in `scripts/proving-session.ts` states the code form for one file —
"a harness that borrowed the implementation it is checking would agree with it
by construction, including where both are wrong".

Such scenarios live in an in-repo directory under a `permissions.deny`
`Read()` rule in `.claude/settings.json`, pinned by
`scripts/hook-registrations.test.ts` (mantahostels#1163 §4); `/to-spec` writes them.

## Choosing the event

Key on when the event fires and whether it can block.

- **`PreToolUse`** fires before the tool runs and can refuse it. This is the only
  event that gives a *guarantee*; every deny in this repo is one.
- **`PostToolUse`** fires after the tool has already run, so it can only react or
  log. Use it to record state, never to protect anything.
- **`PostToolUseFailure`** fires instead of `PostToolUse` when the call throws,
  a non-zero Bash exit included, carrying the output in `error`.
- **`PostToolBatch`** fires once after every batch, takes no matcher, and
  carries each call's result text. It is the only event that sees a call the
  harness refused in input validation — a slash-only `Skill` among them —
  which no per-call hook reaches (#2026). It fires on every batch, so match
  the payload as a string before loading anything.
- **`UserPromptSubmit`** fires on the prompt before the model reads it, and can
  block it — but the live use here is **injection**: what the hook prints on
  stdout is prepended to the prompt as context. `scripts/inject-tracker-docs.sh`
  is the worked example, handing the tracker rules to the skills that would
  otherwise not carry them. THE TRAP: that text is spent on every matching
  prompt, so this is the wrong event for anything the session could read for
  itself.
- **`Stop`** fires as the turn ends and can block the stop — the last moment a
  defective outgoing message can still be fixed, which is what the `guard-*` Stop
  hooks are for. THE TRAP §The proving discipline measured (mantahostels#1254): a Stop guard
  that reconstructs the outgoing message from the transcript file reads an empty
  string, because the assistant's text record is not in the file yet — and empty
  is indistinguishable from a genuinely empty turn, so the guard returns no
  verdict and says nothing at all. Read `last_assistant_message`
  off the payload instead — `scripts/lib/hook-message.js` is the shared reader,
  and `mantahostels:docs/research/stop-hook-outgoing-text.md` carries the payload schema,
  extracted from the installed binary. A blocked Stop fires again on the
  re-stop; the payload's `stop_hook_active` is the only thing that tells the two
  apart, and `scripts/lib/hook-record.js` records it for that reason.
- **`SessionStart`** fires before any work, and refuses nothing — the
  notifier tier. **It fires again after every compaction**, as
  `SessionStart:compact` with `source: "compact"`, and its output is rendered as
  model context there too: 34 of 34 compacted transcripts in this repo's corpus,
  an `auto` trigger among them (#1142). THE TRAP: its output is unconditional
  context spend at every start and every compaction, so a check stays silent
  while things are fine and prints only what the session must act on.
- **`PreCompact`** fires when a session's context is about to be cut, refuses
  nothing, and carries `session_id` and `trigger` (`manual` observed, `auto`
  documented — mantahostels#1804 measured the manual one on 2.1.250). It is the only place
  to undo per-session state that a compaction would otherwise strand: a marker
  saying "already told this session" outlives the text it recorded. THE TRAP:
  nothing else fires here, so a session that never compacts never runs it — the
  hook is a repair, never a place to put work that must happen.

## Which channel reaches the model — measured, not documented

A hook has several ways to emit text and they are not interchangeable. Each
bullet below was measured in August and September 2026 — over this repo's own
transcript corpus, save the founder-visibility one, which no transcript could
supply and a terminal capture did. Two contradict the vendor documentation.
**What a channel does is a fact about this harness, so measure before trusting
a doc.**

- **`PreToolUse` `additionalContext`** reaches the model. Proven positively: a
  canary string quoted back verbatim in a genuine `tool_result` (mantahostels#2319,
  transcript `74fff86a-cf53-4614-a1d1-7e5479ba8ffc.jsonl`). Uncapped. **Not
  pre-emptive on the first call**: the hook runs before the tool, but the model
  reads the text only on that call's result (mantahostels#3421). A first breach that cannot
  be undone needs a denial from the same hook.
- **A `Stop` block's `reason`** reaches the model, as `message.content` on a
  `type:"user"` record reading `Stop hook feedback:\n<reason>`. 3,631 firings of
  five guards, 2026-08-03 – 2026-09-01, no positional variation (mantahostels#2335). **Put
  anything the session must act on here.**
- **A `Stop` hook's `additionalContext`** reaches the model **and re-opens the
  turn exactly as a block does** — so it is no warn-only channel. A canary
  emitted on every Stop was quoted back, then re-invoked the session until the
  engine's 9-consecutive-block cap ended it (2.1.289, `claude -p`, #829).
- **A `Stop` hook's `systemMessage`** reaches the screen and never the model —
  the screen limb assumed, not measured (the residual two bullets down). It
  lands only in `"type":"attachment"` records, and appears as model context
  zero times in 598 firings across 63 sessions (mantahostels#2319). The vendor doc calls it
  the model-only limb and `reason` the founder-facing one; **both halves are
  backwards**.
- **A `systemMessage` reaches no model on `UserPromptSubmit` or `SessionStart`
  either**, so the channel is model-dead on every event yet measured.
  `scripts/name-issue-session.sh` announces a session rename through it, and
  that line was delivered 2,252 times on `UserPromptSubmit` and 2,045 times on
  `SessionStart`, every delivery landing in a `"type":"attachment"` record and
  none as model context (mantahostels#2380). On `Stop` there is a second reason — with no
  `decision` the hook does not re-invoke the session, so not even the fact of
  the emission carries — but that is not why the other two fail.
- **A foreground terminal does render it**, so the channel is model-dead rather
  than dead outright — rendered, which is not the same as noticed. `Session
  named — Pick-next: 2026-09-03 19:45` was captured off the CLI's own render
  stream by `tmux pipe-pane`, Claude Code `2.1.259` (mantahostels#2337). The all-`"bg"`
  corpus never said otherwise: it holds no foreground session, which is not the
  same as a foreground session failing to render (mantahostels#2338, mantahostels#2380). **So
  `systemMessage` is the channel for text only the founder should see, and the
  wrong channel for anything an agent must act on** — put that in a `Stop`
  block's `reason` (mantahostels#2337). **The residual:** the probe rendered a
  `UserPromptSubmit` `systemMessage`, no `Stop` hook emitting one to test
  against (mantahostels#2349); the reading above takes the CLI to render the channel
  uniformly across events, which is assumed and not measured.
- **`SessionStart` stdout** reaches the model, as the session's opening context
  and again straight after each compaction (`source: "compact"`, #1142).
  It refuses nothing and is spent unconditionally at every start, so it carries
  a *report*, never a correction.

**The silence past the block cap.** `scripts/lib/hook-block.js` counts every
`Stop` block against a per-session, per-prefix counter and returns `false` once
the cap is spent, emitting nothing. The cap is load-bearing — three of the seven
wired conditions cannot be fixed from inside the blocked turn — so it stays, and
the *last permitted* block says so in its own `reason` (mantahostels#2348,
`buildLastBlockNotice`). A guard past its cap is enforcing nothing, and a registry
marker resting on one says so.

**Which bound a guard takes turns on what it demands.** A **reporting** guard —
one that demands nothing of the turn — takes the changed-condition bound: each
new instance is worth saying once and a repeat is worth nothing.
`scripts/lib/report-once.js:88-100` keeps a `seen` set of reported
tool-call ids, for `guard-lost-deny.js` and `guard-automode-refusal.js` alike. A **demanding**
guard takes a counter, because a repeat block on an unchanged condition *is* the
nag: measured over 4,544 transcripts, `guard-uncommitted-work.js`'s repeat on an
unchanged path set was followed by compliance in roughly 37 of 99 cases (mantahostels#2791).
Raising a counter is the answer to a guard silenced too early; replacing it with
a changed-condition bound is not. **The residual:** the transcript cannot
distinguish a session that committed from one that merely ended, so 37 is an
upper bound.

**A budget is reserved by stake tier, never spent first-come** (mantahostels#3420). Two
tiers: **shape** — reply format a founder can read past (round shape,
recommendation order, a term's position) — and **consequential**, everything
whose miss files a job wrongly or lets a false claim stand, a `waiting:` resting
on nothing included. No counter holds limbs of both tiers. A ceiling spanning
both is allowed only as a loop bound, and shape stops one block short of it: the
last block is the consequential tier's. The principle binds any budget whose
exhaustion silences a check for the rest of a window — `Stop` counters,
once-only latched warns, delivery-once notifiers — and not one that only defers,
such as `RULE_CAP`'s envelope. A reserve cannot be a held-back final block: no
`Stop` knows it is the last (mantahostels#2544).

**What this means for a guard's text.** A block's `reason` is read by the
founder *and* the model, so it carries both audiences at once. Splitting it — a
short notice in `reason`, the correction in `systemMessage` — sends the
correction to the founder's screen alone and never to the session that has to
act on it. Where a refusal's wording would confuse the founder, shorten it;
never route it.

## Fail open, and the log that makes it visible

**Every `PreToolUse` guard fails open by default** (mantahostels#103, mantahostels#147): a missing `jq`, an
unparseable payload or an unreadable lib all ALLOW the action. **That default
covers a fault the guard catches itself; a deny-capable guard the harness ends
fails closed** (#2670 Q1 (A)), as §The ceiling your guard runs under sets out.

**A limb may fail CLOSED only where the guard's LIMITS header names it and
why** (#339) — a store fault, an unresolved `merge`/`rebase` target (#301), a
budget that ran out. Its refusal is its own record.

A disarmed guard is indistinguishable from a guard finding nothing wrong, so
every fail-open path must write the shared record via
`scripts/lib/guard-log.sh`. `npm run check:guard-errors` is what reports it,
and it runs at session start under `--notify`.

## The ceiling your guard runs under

**A new guard gets 10 s.** Every `PreToolUse` Bash guard in `self-plugin/hooks/hooks.json`
but one carries that `timeout` value.

**A guard with bounded external work derives its ceiling from that work** —
`guard-npm-install.js`'s 60 s is the worked example. The guard
runs a 30 s internal wall-clock budget, tested before each package; one package
costs up to `timeout 12` + `curl --max-time 8` = 20 s; so a package can start at
29 s and finish at 49 s, and 30 + 20 leaves 10 s of margin under the 60 s
ceiling (`scripts/guard-npm-install.js`'s `30 s, not 40` comment, sized at mantahostels#1803's review H4).
State the same arithmetic for any guard adding network or subprocess work.

**A deny-capable `PreToolUse` hook fails closed when the harness ends it**
(#2670 Q1 (A)). Its registration carries `"onFailure": "block"`, which
`scripts/generate-plugin-hooks.js` writes on exactly the hooks
`scripts/lib/deny-capable.js` accepts and whose `--check` refuses drift either
way. A timeout, a script that cannot start, invalid JSON or an exit other than
0 or 2 then refuses the call with `hook error: … blocking because onFailure is
"block"` (Claude Code 2.1.309, measured at #2670). Every other hook's
cancellation still fails open, its output discarded. So a deny-capable guard
ends every path it reaches itself through `scripts/lib/guard-entry.js`, which allows on a throw,
never on a stray non-zero status, which would refuse every call it matches.
It still carries its own internal budget where it could be killed mid-verdict:
a timeout refusal tells the model nothing about the act, while a budgeted
verdict names what went unchecked.

**Below Claude Code 2.1.295 the field is ignored**, and a cancellation fails
open as before (2.1.294, measured at #2670); `scripts/guard-lost-deny.js`
still reports it at `Stop`.

**A guard that relays another script's refusal declares it** — a
`# DENIES-THROUGH: <script> <subcommand>` line in its header comment, naming a
script beside it, as `guard-dispatch.js` carries — or `guard-lost-deny.js`
never reports its cancellation (`scripts/lib/deny-capable.js`, #1815). A
guard writing its `permissionDecision` itself needs no line.

**An internal budget only catches your own slowness.** It catches nothing in
a whole-burst stall, because a starved guard has no CPU to notice its own
clock. On the six longest `SessionStart` bursts, four hooks reported
169,485-169,492 ms within 7 ms of each other across recorded ceilings of
`None`, 15,000 and 10,000 — one script succeeding at 169 s in one session
while cancelled at 155 s in its neighbour (mantahostels#2295). Write the budget for the
slow-guard case, and expect nothing from it in a burst stall.

**Raising a ceiling does not rescue a starved guard.** The `PreToolUse:Bash`
guards succeed well inside their 10 s ceiling, yet are cancelled seconds past a
ceiling they never approach, because the whole hook burst stalls together
(mantahostels#2287, `mantahostels:docs/research/hook-timeout-overshoot.md`). A lone cancellation is a
clean kill; the overshoot is a property of concurrent bursts, not of any one
hook being slow. Fan-out is the lever, and map mantahostels#1980 owns it — a guard author
has no ceiling value that fixes this.

## Deny or warn — split on the signal, not the stakes

Ruled at mantahostels#103: **deny when the guard has a structured, unambiguous fact and the
guarded action has no legitimate use; warn when the guard is inferring.**

A deny carries a false-positive mode a warn does not: a `PreToolUse` matcher on
`Bash` sees the raw command string, so a session merely *writing documentation
that mentions* the guarded command trips it — noise under warn, a wedged session
under deny. A guard reading a structured field such as `tool_input.file_path`
has no such mode, which is why the file-claim guard denies.

`scripts/lib/self-match.js`'s header is the worked example, splitting one
guard across both verdicts: `pkill -f` is **denied** (it can kill the session,
and killing by pid is always available), `pgrep -f` is **warned** (reading is
harmless in itself; only the caller knows whether a self-match changes the
verdict it is about to draw).
