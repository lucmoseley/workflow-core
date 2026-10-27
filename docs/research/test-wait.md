# Research: where test wait falls, and what an in-process core removes (ticket #2194)

Scope: workflow-core (WFC) at `a21fabe04` and mantahostels (MH). No full suite was run. All figures come from records on disk, from `gh`, or from one small measurement that this note labels.

Scratch scripts and extracts: `.claude/tmp/rtw/` (gitignored).

## F1. The records that exist, and what each one measures

- **Suite-queue wait.** `scripts/lib/queue-exit-log.js` appends one line for each waiter that leaves the queue to `.claude/tmp/markers/.suite-queue-exits.jsonl`. Fields: `at`, `waitS`, `reason`, `kind`, `session`. Retention is 30 days. The queue markers themselves (`wfc-suite-queue-*.json` in `os.tmpdir()`'s `wfc-suite-queue/`, `scripts/lib/suite-queue.js`) are live state only. `scripts/check-stale-suite-queue.js` reads them and keeps no history.
- **Each run's duration.** The test-pass and test-fail markers (`.claude/tmp/markers/.test-pass-markers.jsonl`, `.test-fail-markers.jsonl`, and their `.archive.jsonl` files) keep one line for each vitest run: `startedAt`, `durationMs`, `scope.modulesRun`, `scope.modulesTotal`, `argv`, and a `machine` sample (`load1`, `busyPct`). This is the best wall-time ledger. It does not keep a per-file time.
- **Per-file time.** `scripts/lib/test-file-timings.js` writes each file's queued-to-end seconds to `os.tmpdir()/wfc-timings-<pid>.json` (`scripts/run-vitest.js:342`). The wrapper reads it for the RUN COST report and then deletes it (`timings.clear`, `run-vitest.js:398`). Thus **no per-file timing ledger exists**. The only kept per-file figures are (a) the RUN COST lines and the vitest per-file lines in the tee'd logs under `.claude/tmp/markers/.test-logs/` (the last 30 runs only, `scripts/lib/test-log.js` `KEEP_RUNS = 30`), and (b) MH `docs/data/suite-file-timings-2026-08-30.csv`.
- WFC `docs/data/` has no test-timing data set. MH `docs/data/` has `suite-file-timings-2026-08-30.csv` and `git-spawn-census-2026-08-30.csv`.

## F2. WFC: wall time of local runs, by run size (measured, from the markers)

Source: the four marker files in F1, vitest lines only, made unique on `(startedAt, sessionId)`. Window: 2026-10-11 08:23 to 2026-10-19 11:00 UTC (about 195 h). 4,969 runs. Script: `.claude/tmp/rtw/m.py`, `.claude/tmp/rtw/m2.py`. The class is the share of `modulesRun` in `modulesTotal`, and `--changed` in `argv`.

| Run class | Runs | Sum of wall | p10 | p50 | p90 | max | Median files | Median load1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 to 5 files | 3,525 | 22.7 h | 0.9 s | 6.7 s | 56.8 s | 3,091 s | 1 | 17.4 |
| 6 to 30 files | 490 | 11.3 h | 10.0 s | 55.8 s | 185 s | 679 s | 11 | 17.6 |
| `--changed` | 358 | 28.6 h | 8.9 s | 189 s | 647 s | 2,255 s | 35 | 17.0 |
| more than 30 files (named) | 298 | 30.2 h | 131 s | 309 s | 648 s | 3,350 s | 57 | 14.3 |
| full (95% of files or more) | 38 | 10.3 h | 638 s | 861 s | 1,489 s | 1,779 s | 483 | 11.1 |
| no scope recorded | 260 | 0.1 h | 0 s | 0 s | 0 s | 341 s | 0 | 16.4 |

- **Sum of local run wall: 103.1 h in 195 h.** At least one run was live for 58.1 h (30% of the window). While one or more runs were live, the mean count of live runs was 1.77. Time at each count: 1 run 47.3%, 2 runs 32.3%, 3 runs 17.0%, 4 or more 3.3%. `SUITE_MAX` is 3 (`scripts/lib/admission.js:320`), and each run has `maxWorkers: 3` (`vitest.config.ts:104`).
- **The machine is loaded during most runs.** The median `load1` is 14 to 18 on 8 cores for every selected class. Thus the selected-run figures are contended figures, not quiet figures.
- **Full suite: 33 unique full runs, p50 861 s, range 631 to 1,779 s.** The six full runs at `load1` < 5 took 632, 636, 646, 717, 741 and 1,112 s (440 to 534 files). Thus a quiet full suite today is about 630 to 740 s. The full suite grew from 440 files (2026-10-12) to 540 files (2026-10-19), +23% in 7 days.
- **The selected runs carry most of the wall.** Runs that are not full carry 92.8 h of the 103.1 h (90%). The full suite carries 10.3 h (10%).

## F3. WFC: suite-queue wait between sessions (measured)

Source: `.claude/tmp/markers/.suite-queue-exits.jsonl`, 1,261 lines, 2026-10-10 05:00 to 2026-10-19 10:56 UTC. Script: `.claude/tmp/rtw/q.py`. A day is the UTC day of the exit, and the wait is not clipped to the day (the alarm clips it, so its day figures differ by a small amount).

| Kind | Exits | Sum of wait | p50 | p90 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- |
| all | 1,261 | 28.3 h | 3 s | 227 s | 1,319 s | 1,991 s |
| `named` (an explicit file list) | 810 | 23.5 h | 12 s | 328 s | 1,364 s | 1,991 s |
| `bare` | 240 | 3.1 h | 1 s | 152 s | 504 s | 1,319 s |
| `changed` | 202 | 1.7 h | 1 s | 101 s | 507 s | 562 s |
| `full` / `other` | 9 | 0.03 h | | | | |

- 98 exits skipped the queue at once (`skipped: true`, the own work reached no test file, #1221). 7 waits ended by a kill (1.1 h).
- Wait by exit day: 10 Oct 0.1 h, 11 Oct 0.0 h, 12 Oct 0.2 h, 13 Oct 8.4 h, 14 Oct 3.6 h, 15 Oct 2.5 h, 16 Oct 5.1 h, 17 Oct 1.1 h, 18 Oct 5.1 h, 19 Oct (to 11:00) 2.1 h. The alarm limit is 2 h in a rolling 24 h (`scripts/report-suite-queue-wait.js:66`). It fired five times in seven days: #1517 (13 Oct), #1679 (14 Oct), #1762 (16 Oct), #2070 (18 Oct), #2178 (19 Oct).
- **Compare with run wall.** In the same days the runs took 103.1 h of wall (F2). Thus queue wait is about 27% of run wall. The wait is the sum over waiters, so two waiters at one time count two times.
- **The waits are long because slots are full, and slots are full because of a few heavy runs.** The closed issues give the causes:
  - #2178 (19 Oct, 4.93 h over 265 exits): three clusters made 4.2 h. Cause 1: a bare `--` after a list flag ran the whole suite by mistake (3 runs of 529 to 540 files, 1,312 to 1,488 s, about 1.0 slot-hour) → #2181. Cause 2: `/implement` sessions ran `test:changed -- <session base>` and took on every neighbour commit (9 runs, 2.36 slot-hours, 12% of slot time, 9 of 9 red) → #2182. Cause 3: duplicate `--adopt` runs of one selection (about 920 s each) → #2183. One cluster was CPU saturation after a dispatch burst (load1 21 to 56; single-file runs took 2 to 4 min) → #2133.
  - #2074 (24 h to 18 Oct 08:10): 623 runs held 13.66 slot-hours. 52 runs of 50 or more files held 7.84 slot-hours (57%). 37 own-work runs that touched a hub file (40 or more readers in `docs/test-read-edges.json`) held 5.41 slot-hours (40%). Comment citations in helpers make 8.7 to 19.4% of selected test time → #2093 (open).
  - #1155 (9 Oct): of 103 min with the gate shut below the cap, 36 min came from a real third suite that wrote no marker, 19 min from the 10 s poll interval, 7 min from a run past its gate but not yet spawned, 4.5 min from `vitest list` counted as a suite. Gate open to vitest spawn: median 16 s in a worktree, 11 s in the shared tree.
  - #1152 (9 Oct): 847 runs, 13.2 h queue wait, 28 h slot time.
- **What this means for the redesign.** Queue wait is a function of slot occupancy. The records name selection faults (wrong range, whole suite by mistake, duplicates, hub fan-out) as the main causes. No record gives the elasticity (queue wait saved for each slot-hour saved). #2074 Q3 says that no replay yet reproduces the observed wait, because design-vault suites and direct runs write no marker. **This figure is missing.**

## F4. WFC: CI wall time (measured, from `gh`)

Route: `ci.yml` is `workflow_call` and `workflow_dispatch` only. The sweeps run it through `scheduled-checks.yml` (cron `0 3,9,15,21 * * *`, line 218). Thus `gh run list --workflow ci.yml --branch main` gives one run only. I used `gh run list --workflow scheduled-checks.yml --limit 30` and `gh run view <id> --json jobs` for each run (2026-10-12 10:23 to 2026-10-19 08:34 UTC). The repo is PRIVATE (`gh repo view --json visibility`). Script: `.claude/tmp/rtw/ci.py`.

- Whole workflow run: 46 to 1,919 s. The 46 s and 48 s runs on 17 Oct are sweeps that found the sha already green and skipped the suite (the `Decide whether to test` job, mantahostels#3493's lever).
- `Full suite / Lint and tests` job, 28 jobs that ran the suite:

| Step | min | p50 | max |
| --- | --- | --- | --- |
| whole job | 820 s | 1,423 s | 1,895 s |
| Vitest | 689 s | 1,165 s | 1,546 s |
| Shellcheck | 86 s | 165 s | 222 s |
| Typecheck | 13 s | 31 s | 36 s |
| Install dependencies (`npm ci`) | 9 s | 20 s | 25 s |
| Biome ci | 9 s | 20 s | 23 s |
| Mod tests (9 jobs) | 15 s | 16 s | 19 s |
| ESLint, checkout, setup-node, set up, others | each 0 to 6 s | | |

- **Vitest is 82% of the job at p50 (1,165 of 1,423 s). Shellcheck is 12%. Install, typecheck, lint and job setup together are about 80 s (6%).**
- **The Vitest step has a wide spread that is not code.** In time order: 1,101, 689, 923, 1,098, 1,050, 1,135, 936, 1,152, 1,165, 994, 1,220, 973, 1,213, 1,201, 1,168, 1,227, 1,205, 805, 1,223, 1,131, 1,297, 1,284, 899, 1,345, 1,404, 1,449, 983, 1,546 s. Neighbour runs differ by up to 400 s (for example 1,205 → 805 → 1,223 s). I compared the per-file times of the 689 s run (38316505708, 12 Oct, 448 files, 1,947.6 file-seconds) with the 1,448 s run (18 Oct, 532 files, 4,053.2 file-seconds). For the 73 files over 2 s with the same test count in both, the ratio new/old is p10 1.10, p50 1.67, p90 2.57. For 110 small files (0.2 to 2 s) it is p50 1.87. Files that did not change got about 1.7 to 1.9 times slower. **Thus most of the gap between those two runs is the runner, not the code.** CI has no neighbour sessions, but the hosted runner's own speed is not constant. The cause (CPU type or host load on GitHub's side) is not recorded in the job log. The 88 new files add 291 file-seconds (7% of the 18 Oct sum). The trend under the noise is up, from about 950 s (12 to 13 Oct) to about 1,300 s (18 to 19 Oct), but a fit needs more runs.
- Some files grew more than the runner factor. `scripts/precommit-doc-map-gate.test.ts` went 192 → 2,088 ms for each test (89 tests both times, ×10.9). `.claude/skills/new-repo/scripts/new-repo.test.ts` went 2,288 → 5,095 ms for each test. Both drive the real `.husky/pre-commit` stack in a fixture (33 spawn sites each, F7), and `.husky/pre-commit` had 35 commits in the window. This is a reading, not a measurement: I did not prove that the new gates cause the growth.
- **One CI suite in detail** (run 39173972318, job 117812756401, 2026-10-18 22:50, green, log from `gh api .../actions/jobs/<id>/logs`): 534 files (532 timed), Duration 1,447.88 s, tests 4,053.18 file-seconds, setup 71.8 s, import 50.9 s, transform 19.4 s. Ratio: **2.80 file-seconds for each wall-second.** `vitest.config.ts` gives `maxWorkers: 3`.
  - Slowest file: `.claude/skills/new-repo/scripts/new-repo.test.ts` 326 s (8.0% of file-seconds). Top 5: 24.1%. Top 20: 49.4%. Top 50: 68.5%.
  - **Lower bound from the slowest file: 326 s. Lower bound from the work: 4,053 / 3 = 1,351 s.** The wall (1,448 s) is 7% above the work bound and 4.4 times the slowest-file bound. A cut in one file shortens the wall by about its saving divided by 2.8, and only while that file is not on the tail.
  - `--full=coverage` in the Vitest step (`ci.yml:268`) is a full-run cause label (`FULL_CAUSES`, `scripts/lib/test-pass-marker.js:175`). It is not code-coverage instrumentation.

### Why the mantahostels#3535 speed-up left CI wall at 594 s (P2)

Source: `gh issue view 3535 --repo lucmoseley/mantahostels --json comments`, the "Checkbox 1" and "Checkbox 3" comments.

- `guard-echo-call.test.ts` fell 70.6 → 20.9 s on the runner (−49.7 s). But the sum over 325 files fell only 1,538.0 → 1,533.0 s (−5 s). Other files moved up by run-to-run noise: guard-commit-form +5.3 s, pick-next +5.9 s, check-doc-map +7.3 s.
- At the measured 2.59 file-seconds for each wall-second, a 49.7 s file saving is about 19 s of wall. The noise band of four sweeps was 573 to 611 s (±20 s). **Thus the saving was smaller than the noise, and the sum of file-seconds did not move.** The job (707 s) is 113 s more than the Vitest step (594 s). That is the setup, lint, Shellcheck and typecheck share, and the speed-up did not touch it.
- The slowest file then was about 132 s, far under 594 s. Thus the slowest file did not bound it either. The bound was the sum (1,538 s) divided by about 2.6.
- **The general rule:** CI wall ≈ (sum of file-seconds) / (effective parallelism, 2.6 to 2.8 measured) + fixed job steps (about 110 to 260 s). A per-file cut moves the wall only by (cut / 2.6 to 2.8). It must be more than about 50 to 55 file-seconds to clear a ±20 s noise band.

## F5. mantahostels today: test wait is small, because its machinery tests moved to WFC

Sources: MH `.claude/tmp/markers/.test-pass-markers.jsonl` and `.test-fail-markers.jsonl` (700 vitest runs, 2026-09-28 to 2026-10-19); MH `.suite-queue-exits.jsonl` (7 lines, 2026-10-12 to 2026-10-19); `gh run list --workflow ci.yml --branch main --limit 30 --repo lucmoseley/mantahostels` and `gh run view` for the 12 newest. MH `git ls-files '*.test.ts'` gives 46 test files at `1b3bcfa02`.

- **Full local suite: 39 files, p50 12.6 s, max 24.7 s** (15 full runs). Selected runs: p50 0.8 s (1 to 5 files) to 5.7 s (6 to 30 files). Sum of all local run wall in 3 weeks: about 0.3 h.
- **Queue wait: 309 s in a week, over 7 exits.** One wait of 296 s; four of zero.
- **CI** (`ci.yml`, on push to main): workflow run 60 to 118 s. Job `Lint and tests` 64 to 113 s; Vitest step 26 to 36 s; `npm ci` about 21 s; typecheck about 9 s. Thus in MH the fixed CI setup (about 45 to 75 s) is now larger than the test step.
- The P2 case (594 s Vitest, 707 s job, 325 files, 16 Sept 2026) is the MH suite before its machinery tests moved to the WFC plugin. MH commit `59c506122` (2026-09-28, workflow-core#412) deleted MH's copies of the machinery; `scripts/pick-next.test.ts`, `scripts/guard-echo-call.test.ts` and `scripts/dispatch-sessions.test.ts` now exist in WFC.

## F6. The commit's and the push's selected local run

- **A commit runs no test suite in WFC or MH.** `node scripts/lib/test-gate.js commit` prints `SKIP: commands.test is gated at push by the test-pass marker — module "suites" is on and it runs scripts/run-vitest.js` (exit 1). `scripts/lib/test-gate.js:53-60` gives this answer for every host where `suites` is on and the declared test command runs `run-vitest.js`. Both hosts are that case (WFC `.claude/workflow-core.json` `commands.test: "npm run test"`; MH the same, through `resolve-core.js`). The pre-commit test gate (`.husky/pre-commit:1016`) and the pre-lock run in `scripts/commit-paths.js` stand down there. Thus the commit's test wait is zero. Its other gates (lint, gitleaks, the checkers) are not in this question.
- **A push needs certificates that attest its commits.** The pre-push hook only warns (mantahostels#908). The run that makes the certificate is the session's selected run: bare `npm run test` (own unpushed commits and own uncommitted files, #1216), `test:changed` (own uncommitted files, #1217), `--retest`/named files, or one `--adopt` run for an ended session's commits (#1213). These are the selected classes in F2.
- **Size (WFC, F2):** p50 6.7 s for 1 to 5 files, 56 s for 6 to 30 files, 189 s for `--changed`, 309 s for more than 30 files. p90 57 s to 648 s. The selected classes hold 92.8 h of the 103.1 h of local run wall in 8 days.

## F7. Where the spawn and fixture cost sits (static census, WFC)

Method: `.claude/tmp/rtw/census.py`. For each tracked `*.test.ts`, it counts the call sites of `spawnSync|execFileSync|execSync|spawn|execFile|exec(`, of `runInProcess(`, and signs of a git fixture. It weights each file by its CI file-seconds (run 39173972318, F4). A call site is not a call: one site in a loop or a helper can run hundreds of times (P3a's lesson from mantahostels#1993). Thus this census gives where the cost CAN be, not how much of it is spawn.

- Files with at least one spawn site and no `runInProcess`: 60.6% of CI file-seconds. Files with both: 34.3%. Files with `runInProcess` only: 2.5%. Files with neither: 2.6%.
- **Thus 95% of CI file-seconds is in files that spawn a process.** Files with a git-fixture sign carry 69.3%.
- 45 bash guards (`scripts/guard-*.sh`) and 10 node guards (`scripts/guard-*.js`) exist. Most heavy guard tests drive a bash guard. `run-in-process.js` cannot take a bash script (mantahostels#3535: "four are pure-bash scripts with no in-process seam Node can take").
- The top 7 files by CI time (326, 186, 172, 160, 135, 120, 113 s; 30% of file-seconds) are `new-repo`, `precommit-doc-map-gate`, `guard-commit-form`, `dispatch-sessions`, `bg-run`, `init-adopter`, `pick-next`. Of these, `dispatch-sessions` and `bg-run` test real time, signals and process groups (mantahostels#3535: their cost is the guarantee under test). `new-repo`, `precommit-doc-map-gate` and `init-adopter` drive real git and the real hook stack in fixtures.
- vitest's own phases are small: on CI, transform 19 s, setup 72 s and import 51 s against 4,053 file-seconds (3.5%). Locally (full run 2026-10-19 09:48), transform 21 s, setup 34 s and import 43 s against 3,763 file-seconds (2.6%).

## F8. One measured file: `scripts/guard-pull-form.test.ts` (a small measurement, labelled)

**LABEL: this is a new measurement, taken 2026-10-19 by this agent. It is one file, one run, on a loaded machine (load1 11 to 21).** Rerun: `strace -f -qq --seccomp-bpf -e trace=execve -o <out> node_modules/.bin/vitest run scripts/guard-pull-form.test.ts --reporter=dot --maxWorkers=1`, then `python3 .claude/tmp/rtw/st.py <out>`. The `--reporter=dot` flag replaces the house reporters, so the run wrote no pass marker. Raw files: `.claude/tmp/rtw/rtw-pull-form.strace`, `rtw-pull-form.out`.

Why this file: it is a typical bash-guard test (309 tests, 57.4 s on CI, 78.2 s in the 19 Oct local full run). The bash-guard class is 26% of CI file-seconds (below).

- Result: 309 of 309 pass. The wall under strace was 321.7 s. strace slows each fork and exec, so **this wall is not used**. The process counts do not depend on load or on strace (P4: "the durable, load-independent result is the spawn count").
- **8,546 successful `execve` in the file: 27.7 processes for each test.** By binary: `git` 2,265; `realpath` 1,913; `basename` 1,211; `dirname` 1,051; `jq` 630; `bash` 363; the guard script itself 353; `cat` 346; `sed` 340; `mkdir` 70; `node` 2.
- The guard runs 353 times (1.14 for each test). Each run starts about 24 processes.
- The `git` calls are mostly path resolution, not git work: 1,550 `rev-parse --path-format=absolute --git-common-dir`, 363 `rev-parse --git-dir`, 74 `--show-toplevel`, 74 `--show-prefix`. Real fixture work is small: 2 `git init`, 62 `add`, 62 `commit`. Thus this file builds its git fixture about two times, and the fixture cost is small here.
- **Unit costs on this machine today** (labelled measurement, `.claude/tmp/rtw/spawn.js` and `spawn3.js`, 20 to 30 runs each, load1 11 to 21): `node -e 0` p50 27 to 49 ms; `bash -c :` 2.4 ms; `realpath`, `dirname`, `sed`, `git --version` 2 to 3 ms; `jq` 3.8 ms; `git rev-parse --git-common-dir` 3.4 ms; a git fixture (`init` + `add` + `commit` in a temp dir) 19.6 ms; an in-process `fs.readFileSync` 0.1 ms. **One whole run of `bash scripts/guard-pull-form.sh` on one payload: p50 254 ms (min 200 ms).**
- **Thus P3's cost model understates a bash guard.** P3 prices a bash spawn at 5 ms. But a guard run costs about 250 ms: about 24 child processes at 2 to 4 ms (about 70 ms), and about 180 ms of bash that reads its libraries and runs its functions. The node figure is the other way: 27 to 49 ms here against P3's 115 ms (mantahostels#1907, August, a different suite state).
- **Share of the file spent at the process boundary.** 353 guard runs × 200 to 254 ms = 71 to 90 s. The file took 78.2 s in the local full run and 57.4 s on CI. **Thus almost all of this file's time is the real bash guard running: its start, its library load, its child processes.** On P3's model alone (8,544 non-node processes × 5 ms = 43 s), the share is 55 to 75%.

### Extrapolation to the suite (an estimate, labelled; one file measured)

Class of each test file by name and by whether a `.sh` guard of the same name exists (`.claude/tmp/rtw/` inline script), weighted by CI file-seconds (run 39173972318):

| Class | Files | CI file-seconds | Share |
| --- | --- | --- | --- |
| guard tests with a bash guard | 46 | 1,052 s | 26.0% |
| hook stack and repo bootstrap (`new-repo`, `init-adopter`, `precommit-*`) | 33 | 727 s | 17.9% |
| checkers (`check-*`) | 86 | 550 s | 13.6% |
| real time and signals (`dispatch-sessions`, `bg-run`) | 2 | 295 s | 7.3% |
| guard tests with a node guard | 28 | 165 s | 4.1% |
| other | 337 | 1,264 s | 31.2% |

- **Estimate:** if the bash-guard class is like the measured file, an in-process core (guard logic callable as a function, one shell-boundary contract test kept for each guard) removes about 80 to 95% of that class. That is about 21 to 25% of the suite's file-seconds.
- The hook-stack class runs real git and every pre-commit gate in fixtures. Part of it is real git work that a core does not remove. **Its boundary share is not measured. This figure is missing.**
- The real-time class (7.3%) tests timeouts, signals and process groups. A core does not remove it: the guarantee under test is the real clock (mantahostels#3535).
- The node-guard and checker classes already use `runInProcess` in many files (P3, mantahostels#1945). The residual spawn share there is not measured.
- The "other" class (31%) is not classified. **Its boundary share is missing.**

## F9. Wrapper cost that no record holds

- A marker's `durationMs` is vitest's own run only. `scripts/run-vitest.js:395` sets `startedAt` just before it spawns vitest. The 44 run records in `.claude/tmp/markers/.test-logs/runs-*.jsonl` that match a marker start 0.4 to 2.7 s before it (vitest start-up) and end 0.0 to 1.3 s after it ends.
- Thus **the cost before the spawn is in no ledger**: the `pretest` reap (`scripts/pretest-reap.js`), the own-work probe and `vitest list`, the isolated worktree build, and the queue's own poll. #1155 measured gate-open to vitest spawn at median 16 s in a worktree and 11 s in the shared tree (9 Oct). For a 1-to-5-file run (p50 6.7 s of vitest), this fixed cost is larger than the test time. **The figure for today is missing.** It is process and git cost (node starts, `git worktree add`, `vitest list`), so a core that plans the selection in process could cut it. It is paid one time for each run: about 4,969 runs in 8 days × 11 to 16 s ≈ 15 to 22 h, if #1155's median still holds. **This product is an estimate on a 10-day-old median, not a measurement.**
- `gh` boundary: no test calls the real `gh`. 80 test files reference a fake `gh` (a script on `PATH`), which costs as one more bash process. The measured file (F8) made 0 `gh` calls. The runner and the queue make no `gh` call. The queue-wait alarm (`scripts/report-suite-queue-wait.js`) calls `gh` at most hourly, outside any test wait. **Thus `gh` boundary cost in test wait is about zero.**

## F10. Answer: which wait a core-and-shell redesign could cut

| Wait | Measured size (WFC) | Boundary share | Can a core cut it materially? |
| --- | --- | --- | --- |
| Commit's selected run | 0 s: no suite runs at commit in WFC or MH (F6) | — | No: nothing to cut. |
| Push's selected run | 4,931 runs, 92.8 h of vitest wall in 8 days; p50 6.7 s (1 to 5 files) to 309 s (more than 30 files) (F2) | Same mix as the suite, if the selections are like the suite (not measured). Plus 11 to 16 s fixed wrapper cost for each run (#1155, stale) (F9) | **Yes, about 21 to 25% of test time (estimate, F8), plus most of the fixed wrapper cost.** |
| Suite-queue wait | 28.3 h in 9.5 days, 1,261 exits; about 27% of run wall; alarm fired 5 times in 7 days (F3) | None directly. The wait is slot occupancy. | **Second-order only.** It falls as run wall falls, but the elasticity is not measured. The causes named in #2178 and #2074 are selection faults (#2181, #2182, #2183, #2093), which a core does not fix. |
| Full local suite | 540 files; quiet 632 to 741 s; p50 861 s, max 1,779 s; 10% of local run wall (F2) | As the push row | Yes, the same 21 to 25% (estimate). But it is only 10% of local wall. |
| CI wall | job p50 1,423 s; Vitest step p50 1,165 s (82%); Shellcheck 165 s (12%); install, typecheck, lint, setup about 80 s (6%) (F4) | Vitest wall ≈ file-seconds / 2.8 | **Yes: about 245 to 290 s off the Vitest step (21 to 25% of 1,165 s), estimate.** The fixed steps (about 260 s) and runner variance (up to about 1.7×) stay. |
| MH, all four | full suite 12.6 s; CI job 64 to 113 s; queue 309 s in a week (F5) | — | No: too small to matter. |

- A core helps CI only if it cuts many files at once: the bash-guard class is 46 files and 26% of file-seconds.

## Missing figures

1. **The boundary share of every test class other than bash guards.** Only one file was measured (F8). The hook-stack class (17.9%), the checkers (13.6%), the node guards (4.1%) and "other" (31.2%) have no measured spawn or fixture share. To get them: the F8 strace method on one or two files of each class.
2. **The elasticity of queue wait to slot time.** No replay reproduces the observed wait (#2074 Q3), because design-vault suites and direct runs write no marker.
3. **Today's fixed wrapper cost for each run** (pretest, probe, `vitest list`, worktree, gate). The last figure is #1155's median of 11 to 16 s on 9 Oct. No ledger records it, because `startedAt` is set at the vitest spawn.
4. **A per-file timing ledger.** `test-file-timings.js` deletes its per-run file. Per-file figures exist only in the last 30 tee'd logs and in CI job logs.
5. **Whether selected runs have the suite's class mix.** The markers keep `fileFilters` and `selected`, so this is computable, but I did not compute it.
6. **The CI runner's speed.** The job log does not name the CPU. Two runs differ by about 1.7× on unchanged files (F4).
7. **The cause of the growth in `precommit-doc-map-gate.test.ts` (×10.9 for each test) and `new-repo.test.ts` (×2.2) between 12 and 18 Oct.** My reading (new pre-commit gates run in each fixture commit) is not proven.

## Bound

- Read in full: `scripts/lib/test-file-timings.js`; [docs/research/suite-file-timings.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/suite-file-timings.md); `docs/research/test-cost-practices.md` P2 to P11; `scripts/lib/queue-exit-log.js` header; `scripts/lib/test-gate.js` lines 1 to 90; the bodies and comments of #1152, #1155, #2074, #2093, #2178, #2182 and mantahostels#3535's CI comments; the WFC queue-exit log (1,261 lines); all four WFC marker stores (4,969 unique vitest runs); the MH marker stores and queue log; the job and step times of 28 WFC sweeps and 12 MH CI runs; two full WFC CI job logs (12 Oct and 18 Oct); one full local run log (19 Oct 09:48).
- Sampled: `scripts/lib/suite-queue.js` lines 1 to 80 and a grep; `scripts/check-stale-suite-queue.js` header; `scripts/run-vitest.js` by grep and lines 1 to 60, 385 to 545; `.husky/pre-commit` by grep and lines 995 to 1040; `ci.yml` steps. Not read: #1157, #2070, #1762, #1679, #1517; the 30 tee'd logs other than the full run.
- Measured by this agent (labelled): one strace run of one test file; spawn unit costs. No full suite was run.
