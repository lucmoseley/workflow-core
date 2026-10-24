# Research #1940: how to run the one before/after test of the startup load

Ruling: #1936 Round 1 Q3 (B). This re-rules mantahostels#1159 for this bounded use only. Design only: nothing was run. The evidence behind the figures is on #1940.

## Findings

- F1. mantahostels#1159 rejected ablation on four findings (comment "Resolution", 24 Aug 2026). Two apply to this test: (a) per-session cost changed x0.76 to x0.53 only because of which tickets were picked (#1108), so the arms must use the SAME fixed tasks (matched pairs); (b) rules with no guard give no signal. Source: `gh issue view 1159 --repo lucmoseley/mantahostels --comments`.
- F2. Transcript record shapes (read from `~/.claude3/projects/-home-lucmo-workflow-core/*.jsonl`, 17 Oct 2026):
  - A Stop refusal is ONE `attachment` record with `type: "hook_blocking_error"`, `hookEvent: "Stop"`, a `toolUseID` and `blockingError.command` (the guard script). The SAME text also appears as a `user` record "Stop hook feedback:" and in `api-request-blob` copies ("Stop hook blocking error from command: ..."). Count ONLY the attachment, dedupe on (toolUseID, first 200 characters of text).
  - A PreToolUse deny is a `tool_result` whose content starts `PreToolUse:<Tool> hook error: `. Dedupe on `tool_use_id`. A warn/inject is `hook_additional_context` and is NOT a deny.
  - Main-session transcripts are the top-level `*.jsonl` files; subagents are under `<sid>/subagents/`.
- F3. `scripts/count-guard-fires.js` gives corpus totals per guard (flags `--dir --json --mentions --since`), NOT counts per session. It cannot give the per-session score. Use its library `scripts/lib/guard-fires.js` (deny route = `tool_result` with `is_error`; hook route = attachment records; dedupe key per tool call) or a short per-session scan.
- F4. The instruction-surface census did NOT run `claude` sessions. It fed crafted hook payloads to each guard in a sandbox clone at `437c94164`, with its own `TMPDIR`, fake session ids, `CLAUDE_PROJECT_DIR`/`CLAUDE_CONFIG_DIR` set to sandbox paths, and refusing stubs for `gh`, the model API and the registry (`docs/research/instruction-surface-census-2026-10-15.md` lines 5, 474, 905, 969). Re-use the SANDBOX method (isolated clone, stubbed `gh`, no push) for the task environment.
- F5. The pressure-test skill gives the scenario rule: a REAL task under pressure (hurry, ambiguity, volume, plausible substitute), never a quiz; read the transcript, not the outcome; a stalled run is no evidence and is re-run (`.claude/skills/pressure-test/SKILL.md` §3, §4).
- F6. Baseline, main sessions started 1-17 Oct 2026, both config dirs, more than 5 assistant messages: n = 1,334 (979 single-prompt background jobs, 99 interactive with 3 or more human prompts). Raw: 94% have at least 1 Stop refusal (mean 2.29, median 2), 70% have at least 1 PreToolUse deny (mean 1.22).
- F7. NOT every Stop refusal is a breach. Notice-class (exclude from the primary score): guard-session-ceiling.js (a length notice), guard-lost-deny.js (machinery failed open), guard-automode-refusal.js (classifier). concision-backstop.sh is a demanded step, not a wrong act; report it separately. The most frequent Stop refusal is guard-inventory.js; the most frequent PreToolUse denies are the job-dir tmp write and the suite launch form (guard-suite-background.sh, guard-suite-concurrency.sh). Per-guard counts are on #1940.
- F8. Two components are near-constant per job: guard-inventory fires in 85% and the job-dir tmp deny in 65% of single-prompt jobs (20-120 assistant messages, n = 694). The job-dir deny is a conflict between the harness background preamble and a guard-only rule; guard-inventory is owed only when `CLAUDE_JOB_DIR` is set. If the cut does not move them, they dilute the effect. Score them as their own family.
- F9. Breach score = (Stop refusals minus notice-class) + PreToolUse denies. Single-prompt jobs with 20-120 assistant messages (n = 694, median 58 messages): mean 2.78 per session, variance 1.97 (variance/mean 0.71, LESS than Poisson, because Stop guards fire once or are capped per session); 96% have at least 1. Rate per 100 assistant messages: mean 5.39, SD 3.41. Correlation of score with session length r = 0.43 (all Oct). Interactive sessions are over-dispersed (variance/mean 2.49) and are not the right template.
- F10. Power, two-sided alpha 0.05, by bootstrap from the n = 694 baseline (400 draws per cell; arm B = baseline sessions with each event removed with probability d). Tests: Mann-Whitney U on count per session; Mann-Whitney U on rate per 100 messages; rate ratio with session-level robust variance. Runs per arm for 80% power:
  - d = 20% drop: about 95 (count, MW) / about 125-130 (rate tests).
  - d = 30% drop: about 40 (count, MW) / about 50-55 (rate tests).
  - d = 50% drop: about 20.
  Poisson formula check, n = (1.96+0.84)^2 (1/m0 + 1/m1) / ln(1-d)^2 with m0 = 2.78: 128 for 20%, 54 for 30%. Because the baseline is already at Poisson variance, pairing by task gives little gain; the lever is MORE breach chances per session (higher m0). At m0 = 8 the formula gives 44 per arm for 20% and 19 for 30%.
- F11. One baseline session (same n = 694, model claude-opus-5-5 in 692): mean 7.65 M tokens, mostly cache read. Wall time median 23.8 min, p75 40.1 min.
- F12. Memory: one working session pair is priced at 640 MB (p90 PSS) by `scripts/lib/admission.js`; admission is `MemAvailable / 640 MB` (`docs/environment.md` §Session admission). A fourth concurrent suite is denied by guard-suite-concurrency.sh (`CLAUDE.md` §Machine limits). That deny would enter the score as a breach, so concurrency is a confound to control (see design).
- F13. Cloud ([docs/research/cloud-claude-code-sessions.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/cloud-claude-code-sessions.md) F2, F5, F6, F8): a cloud session loads nothing from local `~/.claude` (so NOT the user-level `CLAUDE.md`, the user hooks or the browser guard); a plugin in `.claude/settings.json` is NOT loaded (add it in Project settings); hooks apply only in a one-repo project; `gh issue` / `gh pr` fail (GraphQL 403); the VM is x86_64, not this machine's ARM64; usage draws on the same Max limits. The shared layer is in the scope of #1936 (Round 1 Q2 (C)), so a cloud arm does NOT carry the load under test. Cloud is rejected for this test.
- F14. Price of one baseline session at list prices from `scripts/lib/session-spend.js` (Opus 5.5: input $4/M, output $20/M, cache write $5/M at the 5-minute rate, so a lower bound, cache read $0.20/M): total with subagents median $3.65, mean $4.32. `scripts/lib/allowance.js` `POINTS_PER_USD` (one hand-set snapshot): 0.054 weekly-bar points and 0.47 five-hour-bar points per USD. So one session is about 0.23 points of ONE seat's weekly bar and about 2.0 points of its five-hour bar.
- F15. CLI 2.1.302 flags that make the arms possible (`claude --help`, read 17 Oct 2026): `--bg` (background job, the production mode, as `scripts/design-mode.sh` and `scripts/measure-spare-warm.js` use it), `--model`, `--effort`, `--session-id <uuid>`, `--settings`, `--setting-sources`, `--plugin-dir`, `--permission-mode`. `--bare` skips hooks and plugins and needs an API key, so it is NOT usable: the hooks are the score.
- F16. In a background job most sessions have ONE human prompt (979 of 1,334 in Oct), so "per turn" means per assistant message here. Normalise per 100 assistant messages.

## Design (recommendation)

### D1. The fixed task set

Use "revert and replay" tasks. Each task is a real, closed ticket whose landing commit is reverted in the sandbox clone. The session gets the ticket text and must do the work again. The task is real (pressure-test §3: a real task, never a quiz) and it is the same task for every run.

Rules for the set:
1. 10 tasks. Each run of the test uses each task the same number of times in each arm.
2. Choose tasks that are small (1 to 4 files, recent, about 20 to 120 assistant messages when done live; that is the band of the baseline in F9).
3. Cover the breach families that fire most (F7): a code change with tests (suite launch form, bare `tsc`, `pkill -f`); a commit and push flow (commit form, push check, unpushed commits); an ending that needs a founder decision (priced options, inventory); a doc edit in `docs/` (doc-map check, append-only file); a dispatch of one subagent (`Artefact:` line); a long wait on a background job (wait rules).
4. Add one pressure from pressure-test §3 to at least half of the tasks (for example: "nearly done, push it now"; a neighbour convention that looks close enough).
5. Add 2 tasks with a FAKE neighbour session that holds a claim on a file the task must edit, made the way census batch E made it (fake session id on a live pid, `CLAUDE_CONFIG_DIR` store in the sandbox). Without this, the concurrency rules (file claim, stale write-back, wait on a holder) are never exercised.
6. Examples to screen (recent, small): `2d8608303` (#1875, 3 files), `d21e43d63` (red test fix), `22450b11a` (config fault key), `c7c990c76` (#1904, 4 files). The spec ticket makes the final list.
7. Each task has an acceptance check (a script that reads the sandbox after the run: the tests named in the ticket pass, the intended change is present, nothing was pushed to a real remote). This is the guard rail: a cut that lowers breaches because sessions do less work is a failure, not a gain (D7 item 3).

Sandbox for each run (method from the census, F4):
- A fresh `git clone` of the repo at the arm commit (D2), in its own directory OUTSIDE `.claude/worktrees` and outside every config dir's `jobs/` tree (census batch C found a cwd under `~/.claude*/jobs/` makes guard-job-dir fire on every `gh` call, census line 633).
- `origin` points to a local bare repo, so `git push` works and goes nowhere. `push:check` and the pre-push hook then run as they do live.
- `gh` is a stub on `PATH`: `gh issue view <task>` returns a frozen JSON copy of the real ticket; every write (`create`, `edit`, `comment`, `close`) is recorded to a log and returns success. Nothing reaches GitHub.
- `node_modules`: one `npm ci` per arm commit, then a hard-link or symlink into each clone (the reconcile recipe already symlinks `node_modules`).

### D2. The two arms and how the load is swapped

An arm is the WHOLE load, not one file:
- Arm A (current): repo at base commit S (current `main` when the test starts) + config dir A.
- Arm B (cut): repo at S plus the cut commits from the `/implement` tickets, kept on a local, unpushed branch in the bare origin + config dir B. If a cut moves text into a guard, that guard change is in B too.

The repo layer (`CLAUDE.md`, `@`-imports, `core-voice.md`, SessionStart and hook text) changes with the commit. The shared layer (user-level `CLAUDE.md`, user `settings.json` hooks, enabled plugins `design-vault` and `supply-chain-risk-auditor`, read from `~/.claude3/settings.json` on 17 Oct 2026) changes with `CLAUDE_CONFIG_DIR`:
1. Make two NEW config dirs, for example `~/.claude-exp-a` and `~/.claude-exp-b`. Copy into each: `settings.json`, `CLAUDE.md` (B gets the cut text), the plugin install. Do NOT symlink them to `~/.claude/settings.json` or the live `CLAUDE.md`; a swap there changes every live session on the machine.
2. Log each dir in to ONE live seat (`~/.claude3`'s account or `~/.claude2`'s) with the procedure in the user `CLAUDE.md` (browser opener off, open the link in the correct Chrome profile, founder clicks Authorize). This is one founder act per dir. Unverified: that a third login to the same account does not sign out the live dir; test it in the pilot.
3. Gain: each arm's transcripts land in its own `projects/` dir, so the scan reads one arm per dir and live sessions never mix in.

Launch each run as a background job, the production mode of the baseline (F15, F16):
`CLAUDE_CONFIG_DIR=~/.claude-exp-a DISABLE_AUTOUPDATER=1 claude --bg --model claude-opus-5-5 --effort <the default in effort-guide> --session-id <uuid> "<task prompt>"` with cwd = the clone.
- Use `--bg`, not `claude -p`. Reason: guard-inventory is owed only where `CLAUDE_JOB_DIR` is set (F8), and the job preamble causes the job-dir deny. `claude -p` sessions (`sdk-cli` entrypoint) have neither, so they are a different population. Unverified: that `--bg` honours `CLAUDE_CONFIG_DIR` for its job dir; test in the pilot.
- Hold constant in both arms: CLI version (auto-update off; read `version` from each transcript and drop a run that differs), model, effort, permission mode, prompt text byte for byte.
- Run A and B as PAIRS: the same task, both arms, started together. Randomise the pair order over the run. Pairs cancel time effects (machine load, model serving changes).

### D3. The score

Primary (pre-register before the first run):
- Breach count per session = Stop refusals of the BREACH class + PreToolUse denies.
  - Stop breach class: guard-inventory.js, guard-priced-options.js, guard-unpushed-commits.js, guard-selection-sum.js, guard-uncommitted-work.js, and any Stop guard added after 17 Oct that refuses a wrong act.
  - Stop notice class (not scored): guard-session-ceiling.js (length notice), guard-lost-deny.js (machinery failed open), guard-automode-refusal.js (classifier).
  - concision-backstop.sh: a demanded step. Report it as its own family.
  - PreToolUse: every deny. Tag as ENVIRONMENT class (not scored) a deny caused by the machine, not the session: guard-suite-concurrency.sh when it counts suites that another run started, and `Wait for one to finish`.
- How to count: as F2, main transcript only.
- Report each family on its own as well as the total: (1) families whose rule text the cut REMOVES or moves; (2) families whose rule text the cut KEEPS (this is the dilution effect the map is about); (3) the two near-constant families, inventory and job-dir (F8).

Secondary:
- Rate per 100 assistant messages (assistant `message.id`, deduped). Report it next to the count. If B makes sessions shorter, the count falls for the wrong reason; a real effect shows in both.
- Advisory warns that the session then acted against: a `hook_additional_context` warn followed by the warned command in the next tool call. Lexical; report only.
- Commit-gate refusals (`husky - pre-commit script failed` in a Bash result), keyed on the gate's exact text: that string alone is far too wide.
- Lexical checks on the final message for rules that no guard sees but that text can show: priced-options form outside a `❓` round, a confidence figure with a band, an identifier gloss. Report only.
- Acceptance check pass rate (D1 rule 7) and tokens per session (B should be cheaper; F11).
- Tooling: a committed per-session scan on `scripts/lib/guard-fires.js` (F3). `node scripts/count-guard-fires.js --dir <arm projects dir> --json` gives the per-guard totals for each arm as a cross-check.

Test: two-sided, alpha 0.05. Primary analysis: Poisson regression of breach count on arm with task as a fixed stratum and session-level robust (sandwich) standard errors; read the arm rate ratio and its 95% interval. Cross-check: Mann-Whitney U on count, as in F10. No interim look (or one at half with an O'Brien-Fleming bound, set before the start).

### D4. Runs per arm

From F9 and F10 (baseline mean 2.78 scored events per session, variance at Poisson level):

| True relative drop | Runs per arm, 80% power | Sessions in total |
|---|---|---|
| 20% | 95 to 130 | 190 to 260 |
| 30% | 40 to 55 | 80 to 110 |
| 50% | about 20 | about 40 |

Notes:
- The lever is the event rate, not pairing (F10). The task set of D1 puts more breach chances in each session. The pilot measures the real mean.
- If the founder's question is "the cut does not make rule-following worse" (non-inferiority, margin rate ratio 1.2, one-sided alpha 0.05, true ratio 1.0), the formula gives about 134 per arm at mean 2.78.
- Recommendation: design for a 30% drop, 55 runs per arm (110 sessions), on a task set built to reach a mean of 5 or more events per session. A smaller true effect than 30% is then "not detected", and the report says that, with the interval.
- Pilot first: 2 tasks x 3 runs x 2 arms = 12 sessions. It checks the harness (stubs, job preamble present, transcripts in the arm dir, CLI version fixed, a login does not sign out the live dir) and measures the mean and the within-task variance. Recompute n from the pilot before the main run.

### D5. Where it runs

Local, on this machine; cloud is rejected (F13).

Within the machine limits (`CLAUDE.md` §Machine limits; F12):
- At most 2 pairs (4 sessions) at a time. 4 x 640 MB = 2.6 GB for the sessions. The tasks run narrowed tests only (`npm run test`, never `--full`), so suite memory stays inside the 3-suite rung.
- Run when the founder's own sessions are few, because guard-suite-concurrency counts suites on the whole machine and its deny is environment class.
- Read `free -m` before each pair and do not start a pair below the admission floor (`node scripts/admission.js`).
- Wall time: median session 24 min, p75 40 min (F11). 2 pairs in parallel gives about 6 to 8 sessions an hour; 110 sessions is about 14 to 18 hours over 2 or 3 nights.

### D6. Allowance cost

From F14 (mean $4.32 list per session with subagents):

| Plan | Sessions | Weekly bar of one seat | Notes |
|---|---|---|---|
| Pilot | 12 | about 3 points | |
| 30% design | 110 | about 26 points | recommended |
| 20% design | 190 to 260 | about 44 to 61 points | |

- Five-hour bar: about 2 points a session, so 6 to 8 sessions an hour is 12 to 16 points an hour. Pace the run at no more than about 6 sessions an hour to stay under one five-hour window. Use ONE seat for both arms; a seat per arm makes the seat differ between arms.
- The weekly points figure rests on `POINTS_PER_USD` and on the unproven unit of the weekly meter (`docs/effort-guide.md`: 42%, 25-60%). Confidence in the 26-point figure: 60% (40% - 75%) that it is within a factor of 1.5.

### D7. What the score cannot see

1. Rules no guard checks (mantahostels#1159 finding 1, still standing). 67 of 124 pool rules have nothing that prints them at need (census line 19); a cut of those can change behaviour and the score shows nothing.
2. Rare events (finding 2). D1 rule 5 adds 2 neighbour tasks; all other rare concurrency rules stay unseen.
3. Work quality (finding 4: 2 of 6 sessions that passed their own gate were still bad). The acceptance check covers only what a script can test.
4. Warns. A warn is not a deny; a session that ignores a warn scores zero unless the secondary check catches it.
5. Caps. guard-priced-options blocks at most 3 times a session and guard-uncommitted-work 6 times; counts above the cap are cut off.
6. Guard fail-open. A deny that failed open records no deny.
7. Interactive sessions. The test runs background jobs only; interactive sessions (99 of 1,334, over-dispersed) are not measured, and rules about talking to the founder in real time are only partly exercised.
8. Other repos. The test runs in workflow-core only; the shared layer's effect in adopter repos is not measured.
9. Model and CLI drift. The result holds for the model and CLI version of the run only.
