# Research: logic that can move to an in-process core behind ports (#2205)

Question: for the 20 costliest test files and 10 bash guards, how much logic under test can move to an in-process core behind ports, and what does it save?

## 1. Source of the file times

- No stored per-file timing dataset exists in workflow-core. `scripts/lib/test-file-timings.js` writes each run's record to the file that `WFC_RUN_TIMINGS_FILE` names, and the wrapper deletes it after it prints the run-cost report (`clear()`, `scripts/lib/test-file-timings.js:76-90`).
- [docs/research/suite-file-timings.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/suite-file-timings.md) is withdrawn for its shares. Its dataset (`mantahostels/docs/data/suite-file-timings-2026-08-30.csv`) is from 30 August, at 229 files. It is too old for this tree (540 files).
- The source I used: the vitest log of the most recent full-suite run in this repo, `.claude/tmp/markers/.test-logs/333928efa8251799b698ecfbb65e43d16696301a-2026-10-19T09-48-28-486Z-1637343.log`. It was run on 2026-10-19 at 09:48 UTC, at sha 333928ef. It has 540 files (1 failed, 539 passed), 1,312.2 s wall, and "tests 3763.13s". The log's run-cost line gives load 12.55 (1 min) and 6.2 GB available.
- Method: I took each vitest file line (`✓ <file> (N tests) <time>`) from the log. 536 of 540 lines parsed. The sum is 3,762.1 file-seconds.
- The top 20 files have 1,856.8 s. That is **49.4%** of the measured file time.
- Caution: the run had a high load. `docs/research/test-cost-practices.md` P8 (mantahostels#2255) records that load multiplies a spawning test by a median of x39.6. Thus a quiet-machine cost model (P3a: 115 ms a node spawn, 5 ms a bash spawn, 90 ms a git fixture) prices far less than these loaded seconds. Section 5 gives the two figures side by side.

| Rank | File | Tests | Loaded file time (s) |
|---|---|---|---|
| 1 | .claude/skills/new-repo/scripts/new-repo.test.ts | 64 | 232.0 |
| 2 | scripts/guard-commit-form.test.ts | 424 | 166.8 |
| 3 | scripts/dispatch-sessions.test.ts | 124 | 137.3 |
| 4 | scripts/bg-run.test.ts | 68 | 129.5 |
| 5 | scripts/precommit-doc-map-gate.test.ts | 89 | 107.6 |
| 6 | scripts/init-adopter.test.ts | 91 | 98.7 |
| 7 | scripts/guard-tracker-rules.test.ts | 134 | 97.6 |
| 8 | scripts/guard-push-rules.test.ts | 97 | 91.4 |
| 9 | scripts/pick-next.test.ts | 340 | 90.8 |
| 10 | scripts/inject-tracker-docs.test.ts | 231 | 84.7 |
| 11 | scripts/guard-suite-concurrency.test.ts | 256 | 82.0 |
| 12 | scripts/guard-pull-form.test.ts | 309 | 78.2 |
| 13 | scripts/concision-backstop.test.ts | 93 | 71.9 |
| 14 | scripts/check-doc-map.test.ts | 358 | 60.6 |
| 15 | scripts/guard-file-claim.test.ts | 108 | 59.3 |
| 16 | scripts/repo-checks.test.ts | 51 | 58.3 |
| 17 | scripts/lib/guard-parse.test.ts | 411 | 55.7 |
| 18 | scripts/guard-issue-create-label.test.ts | 232 | 53.9 |
| 19 | scripts/check-guard-registry.test.ts | 179 | 53.7 |
| 20 | scripts/guard-echo-call.test.ts | 47 | 46.7 |
| | **Top 20 total** | | **1,856.8 (49.4% of 3,762.1)** |

## 2. Start time and hook latency, measured here

Measured on 2026-10-19 at about 19:00 local time. Machine: aarch64 (Snapdragon, WSL2), node v24.18.0, `NODE_OPTIONS=--max-old-space-size=4096`. Load average during the runs: 9.4 to 11.4 (1 min). Each figure is 20 runs, timed with `date +%s%N` around the call. A one-off measurement at that load.

| What | min (ms) | median (ms) | max (ms) |
|---|---|---|---|
| `node -e 0` | 19.6 | 24.2 | 28.8 |
| `bash -c :` | 2.1 | 2.4 | 4.7 |
| `bash --noprofile --norc -c :` | 2.2 | 2.7 | 4.4 |
| `jq -n 1` | 3.0 | 3.8 | 5.9 |
| `bash -c 'source lib/guard-log.sh; source lib/guard-parse.sh'` | 10.6 | 11.9 | 20.4 |
| `guard-node-heap.sh`, payload `ls -la` | 17.1 | 25.6 | 29.1 |
| `guard-bg-job.sh`, `ls -la` | 19.5 | 27.3 | 36.6 |
| `guard-push-rules.sh`, `ls -la` | 28.9 | 34.3 | 93.2 |
| `guard-issue-create-label.sh`, `ls -la` | 30.7 | 35.6 | 88.4 |
| `guard-tracker-rules.sh`, `ls -la` | 32.6 | 37.5 | 47.1 |
| `guard-file-claim.sh`, `ls -la` | 32.7 | 41.4 | 63.4 |
| `guard-suite-concurrency.sh`, `ls -la` | 34.8 | 43.1 | 58.5 |
| `guard-echo-call.sh`, `ls -la` | 40.9 | 47.3 | 190.3 |
| `guard-commit-form.sh`, `ls -la` (not a commit) | 51.6 | 63.7 | 243.7 |
| `guard-commit-form.sh`, `git commit -m x -- a.md` in a scratch repo | 93.3 | 130.9 | 156.6 |
| `guard-pull-form.sh`, `ls -la` | 83.0 | 107.7 | 399.5 |
| `node scripts/guard-inventory.js` (a real Node hook, Stop payload) | 50.8 | 62.0 | 94.5 |
| `node -e` that parses stdin JSON and loads `child_process` | 27.3 | 31.8 | 41.2 |

Process count for one call (`strace -f -e trace=execve`):

- `guard-node-heap.sh`, `ls -la`: 6 execve.
- `guard-commit-form.sh`, `ls -la`: 14 execve.
- `guard-pull-form.sh`, `ls -la`: 19 execve.
- `guard-commit-form.sh`, commit path: 27 execve (9 `git`, 5 `realpath`, 4 `jq`, 4 `dirname`, 1 each of `sed`, `rm`, `cat`, `bash`, `basename`).

Findings:

- F2.1. A bare `bash` start is 2.4 ms, but a real guard call is **25 to 131 ms** (median). The 5 ms P3a figure for "a bash spawn" (`docs/research/test-cost-practices.md:72`) prices only the bare start. It does not price a guard. The floor of a guard is about 12 ms to source `guard-log.sh` and `guard-parse.sh` (3,367 lines), plus `jq` (about 4 ms a call) and other forks.
- F2.2. A bare `node -e 0` is 24 ms. That is less than the median of 9 of the 11 bash guard calls above. A Node core that parses stdin and loads `child_process` is 32 ms. A real Node hook with its requires (`guard-inventory.js`) is 62 ms.
- F2.3. Thus a Node start does not obviously add latency against a guard that is already large. It does add latency against a small guard (`guard-node-heap.sh`, 26 ms; `guard-bg-job.sh`, 27 ms). The cost depends on how many modules the Node core loads. Each `require` of a large lib adds time. This report does not measure that.
- F2.4. The P3a figure of 115 ms for a node spawn is about 5x the bare `node -e 0` measured here (24 ms). It is a good price for a spawned program under test. It is not a price for a minimal Node hook.
- F2.5. 51 bash hooks match each Bash tool call before it runs: 48 under matcher `Bash`, 2 under `Bash|Write|Edit|NotebookEdit`, 1 under `Bash|Read` (`hooks/hooks.json`, counted by a script). If the harness runs them in parallel, the latency of one call is near the slowest hook. The CPU cost is the sum. This report did not measure which. The sum of the medians of the 10 guards above (fast path) is about 453 ms. Thus one extra Node start on each of the 51 hooks costs about 51 x 24 ms = 1.2 s of CPU for each Bash tool call. One shared Node dispatcher for all 51 costs 24 to 62 ms.

## 3. Method for the 20 test files

I did not run a test file, because a timing exists for each file. All counts come from the test source, by script.

1. **N (cases).** The count of cases that vitest ran, from the log line for that file. `it.each` rows are in N.
2. **Program spawns.** A script finds each helper that calls `spawnSync`, `execFileSync`, `execSync`, `spawn` or `execFile`, and each helper that calls such a helper. It counts the calls to these helpers in each case body. It multiplies by N divided by the static case count, to include `it.each` rows. `runInProcess` calls are counted apart and get no spawn price. Git calls are counted apart. Limit: a static count. It does not see loops or a call in `beforeEach`. For `guard-commit-form.test.ts` it gives 504 guard spawns. `docs/research/test-cost-practices.md:42` gives 178 real `spawnSync(GUARD)` calls over 388 tests, from an earlier count. Thus the static count can be high by up to 2.8x on a file with many `it.each` rows.
3. **B (cases that test the boundary itself).** A case is in B if its name says it asserts real OS or tool behaviour: a signal or kill, a hang, wedge or timeout, a race or "concurrent" or "at once", detach or background, stdin or an fd, mtime, clock, epoch or heartbeat, sleep, "real git/gh/shell/checker/husky", a full hook stack, byte for byte, exit code, shellcheck, gitleaks, `PATH`, or "this repo's own" file. A case that drives a failed port ("ps cannot be read", "fails open on an unwritable log") is NOT in B. Under ports, a fake that fails drives that branch in process. Only the adapter's own test stays real. I checked the precision by reading samples. The broad keyword set gave many false hits ("worktree", "path", "watcher"). I removed those words. Some noise stays.
4. **K (cases that stay real).** K = P + B. P is the number of programs that the file spawns as the subject: 2 for `concision-backstop.test.ts` (backstop and recorder) and `guard-echo-call.test.ts` (guard and recorder), 1 for the other files.
5. **Moved = N − K.** A moved case calls the core in process with fake ports for git, fs, `gh`, process and clock. It needs no spawn and no fixture.
6. **Prices.**
   - *P3 model* (`docs/research/test-cost-practices.md:72`): 115 ms a node spawn, 5 ms a bash spawn, 90 ms a git fixture that is built again for each case. A fixture copied from a template is 16 ms (`test-cost-practices.md:91`). P3 has no price for one test-side git call, so I used 3.2 ms (measured: `git rev-parse`, median of 20, §2 load).
   - *Measured prices*: the same, but a bash spawn is the measured median of that guard's own call (§2). Where I did not measure the program, I used 25 ms, the smallest guard measured (`guard-node-heap.sh`). That value is an assumption and has a `*` in the table.
   - *Loaded-time bound*: file time − time of the kept cases − 6 ms for each moved case. The time of a kept case comes from the log where vitest listed it as slow (300 ms or more). An unlisted kept case is counted at 0.3 s, which is the most that it can be. The 6 ms is the measured mean case time of two in-process lib test files in the same run (`scripts/lib/scratch-sweep.test.ts`: 42 tests in 263 ms; `scripts/lib/arbiter-issue-claims.test.ts`: 25 tests in 164 ms). This bound gives ALL other time in a moved case to spawns, fixtures and waits. It is an upper bound.
7. **Already in process.** `pick-next`, `check-doc-map` and `repo-checks` already call their program through `runInProcess`/`runInProcessAsync`. `check-guard-registry` does this for part of its calls. For these files the P3 saving is only fixtures and git calls.

## 4. Results for the 20 test files

| File | Loaded T (s) | Cases N | Program | Fixture/case | Boundary cases B | Kept real K=P+B | Moved N-K | Est. program spawns | Spawns saved | Test-side git saved | Fixtures saved | Saved, P3 model (s) | Saved, measured prices (s) | Saved, loaded-time bound (s) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| new-repo.test.ts | 232.0 | 64 | node | rebuild | 2 | 3 | 61 | 131 | 125 | 121 | 61 | 20.3 | 20.3 | 210.3 |
| guard-commit-form.test.ts | 166.8 | 424 | bash (131 ms) | copy | 4 | 5 | 419 | 504 | 498 | 210 | 419 | 9.9 | 72.6 | 160.7 |
| dispatch-sessions.test.ts | 137.3 | 124 | bash (25* ms) | none | 12 | 13 | 111 | 140 | 125 | 0 | 0 | 0.6 | 3.1 | 75.5 |
| bg-run.test.ts | 129.5 | 68 | bash (25* ms) | none | 30 | 31 | 37 | 125 | 68 | 1 | 0 | 0.3 | 1.7 | 48.4 |
| precommit-doc-map-gate.test.ts | 107.6 | 89 | bash (25* ms) | rebuild | 5 | 6 | 83 | 83 | 77 | 101 | 83 | 8.2 | 9.7 | 23.7 |
| init-adopter.test.ts | 98.7 | 91 | node | rebuild | 6 | 7 | 84 | 116 | 107 | 97 | 84 | 20.2 | 20.2 | 67.3 |
| guard-tracker-rules.test.ts | 97.6 | 134 | bash (38 ms) | none | 0 | 1 | 133 | 159 | 158 | 0 | 0 | 0.8 | 5.9 | 93.1 |
| guard-push-rules.test.ts | 91.4 | 97 | bash (34 ms) | copy | 1 | 2 | 95 | 162 | 159 | 13 | 95 | 2.4 | 7.0 | 90.2 |
| pick-next.test.ts | 90.8 | 340 | node-rip | none | 3 | 4 | 336 | 0 | 0 | 720 | 0 | 2.3 | 2.3 | 87.5 |
| inject-tracker-docs.test.ts | 84.7 | 231 | bash (25* ms) | none | 4 | 5 | 226 | 275 | 269 | 14 | 0 | 1.4 | 6.8 | 75.2 |
| guard-suite-concurrency.test.ts | 82.0 | 256 | bash (43 ms) | none | 4 | 5 | 251 | 325 | 319 | 0 | 0 | 1.6 | 13.7 | 78.7 |
| guard-pull-form.test.ts | 78.2 | 309 | bash (108 ms) | copy | 0 | 1 | 308 | 423 | 422 | 37 | 308 | 7.2 | 50.5 | 75.4 |
| concision-backstop.test.ts | 71.9 | 93 | bash (25* ms) | copy | 3 | 5 | 88 | 202 | 191 | 43 | 88 | 2.5 | 6.3 | 65.4 |
| check-doc-map.test.ts | 60.6 | 358 | node-rip | copy | 0 | 1 | 357 | 2 | 2 | 550 | 357 | 7.5 | 7.5 | 58.2 |
| guard-file-claim.test.ts | 59.3 | 108 | bash (41 ms) | none | 6 | 7 | 101 | 135 | 126 | 1 | 0 | 0.6 | 5.2 | 51.3 |
| repo-checks.test.ts | 58.3 | 51 | node-rip | none | 4 | 5 | 46 | 0 | 0 | 2 | 0 | 0.0 | 0.0 | 55.6 |
| guard-parse.test.ts | 55.7 | 411 | bash (14 ms) | copy | 4 | 5 | 406 | 496 | 490 | 8 | 406 | 9.0 | 13.5 | 51.8 |
| guard-issue-create-label.test.ts | 53.9 | 232 | bash (36 ms) | none | 1 | 2 | 230 | 473 | 469 | 0 | 0 | 2.3 | 16.7 | 51.4 |
| check-guard-registry.test.ts | 53.7 | 179 | node | none | 6 | 7 | 172 | 43 | 41 | 8 | 0 | 4.7 | 4.7 | 46.3 |
| guard-echo-call.test.ts | 46.7 | 47 | bash (47 ms) | none | 3 | 5 | 42 | 143 | 128 | 0 | 0 | 0.6 | 6.1 | 42.7 |
| **Total** | **1856.7** | 3706 | | | | 120 | 3586 | | **3774** | **1926** | **1901** | **102.3** | **273.8** | **1508.7** |

`*` = an assumed price of 25 ms (see §3, step 6). "node-rip" = the file already calls the program in process.

Totals:

- **P3 model:** 3,774 program spawns, 1,926 test-side git calls and 1,901 fixtures saved, for **102.3 s**. That is **5.5%** of the top-20 time (1,856.7 s) and 2.7% of the suite (3,762.1 file-seconds).
- **Measured prices:** **273.8 s**: **14.7%** of the top-20 time and 7.3% of the suite.
- **Loaded-time bound:** **1,508.7 s**: **81.3%** of the top-20 time and 40.1% of the suite.
- 120 of 3,706 cases (3.2%) stay real-boundary under the rule "one real-boundary case for each program, plus the cases that test the boundary".

How to read the three figures:

- Cross-check against conversions that were done: the in-process seam took five files from 264.0 s to 71.5 s, a 73% cut (mantahostels#1907, `test-cost-practices.md:57,77`). The gain was 8x on a hook guard (`guard-priced-options.test.ts`, 17.5 s to 2.1 s) and 2.5x on a checker. If the moved cases get the checker's 2.5x (60%) to the hook guard's 8x (88%), the top 20 save about **1,110 to 1,630 s** loaded. The loaded bound (1,509 s) is in that range. This cross-check is an inference from 5 files of a different kind (node programs) and is not a measurement.

### 4.1 Notes for each file: the boundaries and what stays real

| File | Program under test and its boundaries | Cases that stay real (why) |
|---|---|---|
| new-repo.test.ts | `new-repo.js` (Node, 1,801 code lines). Boundaries: git (41 git argument sites), `gh` (6), fs (48 `fs.*Sync`), gitleaks and shellcheck, an async `spawn` for `--resume`. | 3. 47 of 64 cases are slow-listed (197 s). The longest is 20.1 s. The script-and-hook end-to-end cases are the true cost. Most cases test the order of steps and the decisions; a fake git/`gh` port can drive them. |
| guard-commit-form.test.ts | `guard-commit-form.sh` (bash). Boundaries: git index and worktree state (27 execve on one commit call, 9 of them git), arbiter state on fs, `jq`. Copies a template for each case. | 5. Nearly all cases are "command text plus repo state → verdict". This is the largest saving at measured prices (72.6 s), because one call costs 131 ms. |
| dispatch-sessions.test.ts | `dispatch-sessions.sh` (bash). Boundaries: `claude` (12 call sites), `jq` (14), `node` (8), `timeout`/`sleep` (a probe wedge). | 13. The wedge cases are real clock waits ("refuses inside 45s", 36.1 s; 9.1 s; 3.8 s), 60.2 s of 137.3 s. With a clock port, the other wait cases can move. A guard on the real 45 s budget stays real. |
| bg-run.test.ts | `bg-run.sh` (bash). Boundaries: background processes, signals (`kill`), heartbeat file mtime, `date` (11), `sleep` (5). | 31 of 68. The program IS a process supervisor. Almost half the cases test the boundary itself (SIGKILL, beat mtime, launch second). Small saving at a spawn price. The loaded bound (48.4 s) needs a clock port and a process port. |
| precommit-doc-map-gate.test.ts | The pre-commit fragment, run by `sh -ec`. It calls the real `node scripts/check-doc-map.js` on a git repo that it builds again for each case. | 6. Two "cuts the real checker's … block" cases take 50.6 s and 31.5 s, which is 82.2 s of 107.6 s. Those cases run the real checker. They are real by design, so the loaded bound is only 23.7 s. |
| init-adopter.test.ts | `init-adopter.js` (Node). Boundaries: fs writes (15), git, husky hooks, guards that the hooks call. | 7. Three "lands … through the husky stack" cases take 42.6 s together. They are end-to-end by design. |
| guard-tracker-rules.test.ts | `guard-tracker-rules.sh` (bash). Parses `gh` commands; 2 real `gh` calls. | 1. No case name tests the boundary. All 134 cases are parse-and-decide. |
| guard-push-rules.test.ts | `guard-push-rules.sh` (bash). Boundaries: git (range, worktree), review markers on fs, `node`. | 2. |
| pick-next.test.ts | `pick-next.js`, already in process (`runInProcessAsync`). Boundaries that stay: git (`git ls-files`), `gh` and `ps` through `lib/`. `beforeEach` runs `git init` and `git add` for every case (`stubRepo`). | 4. The spawn is gone already. The rest is 2 git calls for each case and fs. A git port in `pick-next.js` removes them. |
| inject-tracker-docs.test.ts | `inject-tracker-docs.sh` (bash). Boundaries: fs reads, `gh` behind `timeout` (2), `stat`, a lock against two firings. | 5 ("gh that hangs past 4 s", 4.4 s; "two concurrent firings", 2.7 s). |
| guard-suite-concurrency.test.ts | `guard-suite-concurrency.sh` (bash). Boundaries: `ps` and `/proc` (13), `flock` (1), `kill`/`wait` (13). | 5. The `ps` lines are already fed through a shim in many cases ("withPs" helper). That is a port in all but name. |
| guard-pull-form.test.ts | `guard-pull-form.sh` (bash). Boundaries: git config and state (7 real git call sites), main-rewind lib. | 1. One call costs 108 ms, which is the highest fast-path cost measured. |
| concision-backstop.test.ts | `concision-backstop.sh` and `record-write.sh` (bash). Boundaries: git diff, markers on fs, `node` (arbiter). | 5. |
| check-doc-map.test.ts | `check-doc-map.js`, already in process. Boundaries that stay: git through `lib/doc-map.js` (8 git sites) and `lib/check.js` (4), fs. Copies a template for each case. | 1. The spawn is gone already. The saving is the template copies and the git calls (about 550). |
| guard-file-claim.test.ts | `guard-file-claim.sh` (bash). Boundaries: arbiter (`node` behind `timeout`), `jq`, fs. | 7 ("kills an arbiter that hangs", 5.1 s). |
| repo-checks.test.ts | `repo-checks.js`, already in process. Boundaries: the child checks it runs, the clock (6 `Date` sites). | 5. The spawn is gone already. The 1.1 s mean case comes from the checks it runs and from time windows, not from a spawn. The P3 saving is 0. A port for the check runner and the clock is necessary for any saving. |
| guard-parse.test.ts | `lib/guard-parse.sh` (bash library, 3,367 lines). The tests source it in `bash` for each call. Boundaries: almost none; a git walker and rule files on fs. Copies a template for each case. | 5. It is the clearest case for a Node core: 97% of the library is parse-and-decide (§5). |
| guard-issue-create-label.test.ts | `guard-issue-create-label.sh` (bash). Boundaries: `gh` API (4 call sites, a shim on `PATH` in the tests), `cat` of body files, `timeout`. | 2. The `gh` shim is already a port at the process level. |
| check-guard-registry.test.ts | `check-guard-registry.js` (Node), partly in process (210 `runInProcess` calls against 43 spawns). Boundaries: fs (41), git (2), `hooks/hooks.json`. | 7 ("passes against this repo's own CLAUDE.md", 4.5 s). |
| guard-echo-call.test.ts | `guard-echo-call.sh` and `record-tool-echo.sh` (bash). Boundaries: the echo store on fs. | 5. |

## 5. The 10 bash guards: parse-and-decide against shell-only

Sample: 10 of the 45 `scripts/guard-*.sh`, from small to large, with `guard-commit-form.sh`. Six of them also have a test file in the top 20.

Method: an awk script classifies each code line (no comments, no blank lines).

- **Boundary**: the line runs an external command (`git`, `gh`, `node`, `jq`, `date`, `mktemp`, `stat`, `find`, `ps`, `kill`, `flock`, `sleep`, `timeout`, `realpath`, `cat`, `mkdir`, `rm`, `touch`, `mv`, `cp`, …) at a command position, reads or writes a file by a redirection, or tests a file (`[ -e`, `-f`, `-d`, …).
- **Output**: a heredoc body, or a line that prints deny or warn text.
- **Logic**: all other lines: parsing, `case`, `[[ =~ ]]`, variables, functions.

Logic and output can move to a Node core. A boundary line becomes a port call. Its adapter stays a thin real call. I checked `guard-commit-form.sh` by reading its `git` lines. The real git calls (`git -C … rev-parse`, `ls-files`, `diff --cached`) are classed as boundary. A `git` word inside deny text is classed as logic or output. Thus the boundary share is a lower bound: a call through a wrapper function is not seen.

| Guard | Lines | Code lines | Boundary | Output | Logic | Portable (logic + output) | Shell-only constructs | Median call (ms, §2) | Test in top 20 |
|---|---|---|---|---|---|---|---|---|---|
| guard-node-heap.sh | 54 | 13 | 2 | 0 | 11 | 85% | none | 25.6 | no |
| guard-bg-job.sh | 94 | 13 | 2 | 0 | 11 | 85% | 1 `timeout` | 27.3 | no |
| guard-echo-call.sh | 146 | 57 | 4 | 9 | 44 | 93% | 1 `kill`/`wait` word | 47.3 | yes (#20) |
| guard-push-rules.sh | 253 | 116 | 11 | 3 | 102 | 91% | 1 `trap`, 1 `timeout` | 34.3 | yes (#8) |
| guard-file-claim.sh | 399 | 104 | 9 | 9 | 86 | 91% | 5 `timeout` | 41.4 | yes (#15) |
| guard-tracker-rules.sh | 494 | 204 | 9 | 1 | 194 | 96% | 1 `timeout` | 37.5 | yes (#7) |
| guard-pull-form.sh | 767 | 430 | 22 | 50 | 358 | 95% | 1 `timeout` | 107.7 | yes (#12) |
| guard-suite-concurrency.sh | 999 | 437 | 24 | 9 | 404 | 95% | 1 `flock`, 13 `ps`//proc, 13 `kill`/`wait`, 5 `timeout` | 43.1 | yes (#11) |
| guard-issue-create-label.sh | 1,229 | 891 | 18 | 512 | 361 | 98% | 2 `kill`/`wait`, 5 `timeout` | 35.6 | yes (#18) |
| guard-commit-form.sh | 1,567 | 652 | 36 | 53 | 563 | 94% | 1 `trap`, 2 `kill`/`wait`, 7 `timeout` | 63.7 (not a commit); 130.9 (a commit) | yes (#2) |
| lib/guard-parse.sh (sourced by all 10) | 3,367 | 1,848 | 57 | 38 | 1,753 | 97% | 1 | 11.9 to source with `guard-log.sh` | yes (#17) |
| lib/guard-log.sh (sourced by all 10) | 226 | 88 | 3 | 9 | 76 | 97% | 0 | (in the 11.9) | no |

Findings:

- F5.1. **85% to 98%** of the code lines of each guard are parse, decide or output. These lines can move to a Node core behind ports. The shell-only part is small: the hook entry (stdin, exit code), `timeout`, and in `guard-suite-concurrency.sh` the `ps`/`/proc`/`flock`/`kill` calls. A Node core can call each of these through a port, as `child_process` calls or `fs` reads of `/proc`.
- F5.2. The largest unit that can move is not a guard. It is `lib/guard-parse.sh`, which every guard sources (3,367 lines, 97% logic). No Node port of it exists in `scripts/lib/` (I searched for a tokeniser or a shell-word parser in `scripts/lib/*.js`; the only match, `materialise-plugin.js`, is not a parser). Thus a Node core for the guards starts with a port of this parser. That is the largest cost of the change, and the parser has the largest test file of the sample (411 cases).
- F5.3. Latency. A guard call costs 26 to 131 ms (median) now. A bare `node -e 0` costs 24 ms, and a Node hook with its requires costs 62 ms (`guard-inventory.js`). Thus:
  - A Node core that each guard starts on its own adds about 24 ms or more to each of the 51 hooks on a Bash tool call. Against the large guards, the Node start can be less than the bash cost now, because a Node core does not need 4 to 9 `jq`, `realpath` and `dirname` forks (§2: 27 execve on one commit call).
  - One Node dispatcher process for all Bash hooks pays one start (24 to 62 ms) for each tool call and removes about 51 bash starts and their forks. This report did not measure such a dispatcher.
- F5.4. A thin bash shell for each guard (read stdin, `exec node core.js`) keeps the hook wiring. But it pays bash plus Node: about 2.4 + 24 ms or more.

## 6. Seams that exist now

- F6.1. `scripts/lib/suite-queue.js:87`, `readMarkers(dir, fsImpl = fs)`. This is an fs port by a default parameter. The real `fs` is the default, and a test gives a stub. `scripts/lib/suite-queue.test.ts:114-164` uses it: `fsImpl({ "wfc-suite-queue-11.json": … })`. The shape fits a core behind ports exactly.
- F6.2. `scripts/lib/arbiter-debts.js:658`, `sweepDebts({ clearStub = clearDebt, now = Date.now } = {})`. This is a clock port and a port for one race-prone fs act, both by injection. `scripts/lib/arbiter-debts.test.ts:606` pins the clock: `sweepDebts({ now: () => pinnedNow })`. Its header gives the reason for the port: two results are races that are "unreachable in-process".
- F6.3. The same style is in 19 files under `scripts/lib/` (a grep for `fsImpl = fs`, `now = Date.now`, `exec… = execFileSync`, or `spawnImpl`: `allowance.js`, `arbiter-core.js`, `arbiter-debts.js`, `arbiter-locks.js`, `captures.js`, `changed-selection.js`, `detached-run.js`, `doc-map.js`, `lost-verdict.js`, `notify-report.js`, `queue-exit-log.js`, `round-check.js`, `scratch-sweep.js`, `seat-utilisation.js`, `session-spend.js`, `suite-queue.js`, `test-log.js`, `tree-drift.js`, `trial-window.js`). The pattern is present, but it is applied to one function at a time. No lib gives a git port. Example: `lib/doc-map.js` injects the clock (`pairingHalfAgeMs(…, now = Date.now())`, line 1747) but calls `execFileSync("git", …)` directly (lines 1689 and 1785). For this reason `check-doc-map.test.ts` still copies a git template for each of its 358 cases.
- F6.4. `scripts/lib/run-in-process.js` (802 lines). It runs a Node CLI script in the vitest worker in place of `spawnSync("node", …)`. It reproduces the exit status, stdout and stderr (fd 1/2 and `process.stdout`), cwd, env, stdin by `fs.readFileSync(0)`, and `require.main`. It purges the repo's module cache for each call. 184 test files use it.
  - What it removes: the Node start, priced at 115 ms in P3 and 24 ms bare here.
  - What it does not remove: (1) real git and real fs. The git subprocesses of the script still run, and the fixture is still built or copied. (2) Any bash program. 14 of the 20 costliest files test a bash program (§4), so `runInProcess` cannot reach them. (3) The four shapes that must keep a spawn (`test-cost-practices.md:59`): an async entry point (in part handled by `runInProcessAsync`), a timeout or signal, two processes at once, and a real fd.
  - Thus `runInProcess` already got the Node-start limb for `pick-next`, `check-doc-map`, `repo-checks` and part of `check-guard-registry`. Their remaining cost is the git/fs limb. Only a git port and an fs port in the program can remove it.
  - It also has a known hazard that a port does not have: process-wide patched state. One case that times out can cause a cascade of failures (lucmoseley/mantahostels#2239, mantahostels#2254; `test-cost-practices.md:125`). A core that takes its ports as arguments patches no global, so this hazard does not apply to it.

## 7. Summary

- Top 20 test files: 1,856.7 s of 3,762.1 file-seconds (49.4%), one loaded run (load 12.55), 2026-10-19, sha 333928ef.
- Under the rule "one real-boundary case for each program, plus the cases that test the boundary", 120 of 3,706 cases stay real. 3,586 cases (96.8%) can move to an in-process core.
- Saved: about 3,774 program spawns, 1,926 test-side git calls and 1,901 per-case fixtures.
  - P3 model: 102.3 s (5.5% of top-20 time; 2.7% of the suite).
  - Measured quiet prices (bash guard at its measured call cost): 273.8 s (14.7%; 7.3%).
  - Loaded-time upper bound: 1,508.7 s (81.3%; 40.1%). The precedent of the in-process seam (2.5x to 8x) gives about 1,110 to 1,630 s, so the loaded bound is credible as an order of magnitude.
- Largest single savings at measured prices: `guard-commit-form` (72.6 s), `guard-pull-form` (50.5 s), `new-repo` (20.3 s), `init-adopter` (20.2 s), `guard-issue-create-label` (16.7 s).
- Files where a core saves little: `bg-run` (31 of 68 cases test the boundary itself), `precommit-doc-map-gate` (82.2 s of 107.6 s is in two cases that run the real checker by design), `dispatch-sessions` (60.2 s in real clock waits).
- Bash guards: 85% to 98% of their code is parse, decide or output. The shared parser `lib/guard-parse.sh` (3,367 lines, 97% logic) is the main unit to port, and no Node version of it exists.
- Latency: a guard call is 26 to 131 ms now. A Node start is 24 ms bare, 62 ms for a real Node hook. A Node start for each of the 51 Bash hooks costs about 1.2 s CPU for each Bash call. One shared Node dispatcher costs one start.

## 8. Limits of this research

- One timing run, at high load, on a dirty tree. No spread.
- Spawn and case counts are static estimates (§3). The `guard-commit-form` estimate (504) is 2.8x the earlier count of 178 in `test-cost-practices.md:42`.
- The boundary-case count B is a keyword filter on case names, checked by sampling.
- I did not read any test file or program in full. I read the helpers, the `beforeEach` blocks, the spawn sites, the slow-test lines of the log, and the seams.
- The 25 ms price for the unmeasured bash programs and the 6 ms in-process case cost are assumptions from measurements of other files (§3, step 6).
