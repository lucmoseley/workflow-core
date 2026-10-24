# Adopter suite cost: fantasy-books and design-vault (#2238, map #2186)

Machine: aarch64 (Snapdragon, WSL2), 8 cores, 10 GB, 2 GB swap. Node v24.18.0, Python 3.12.12 (miniforge). Date: 2026-10-19. Neighbour sessions run at the same time.

Measured commits (clean clones, not the shared working trees, which hold other sessions' edits):

- fantasy-books `7ac8c29934bae478e3942c26c92e52b00d2de366` (2026-10-19 21:48 +08:00).
- design-vault `17756113872cb3bedf237e25b1b6306d0eb744e1` (2026-10-19 11:13 +08:00).

Each clone: `git clone --local --no-checkout <repo> <dir>` and `git checkout <sha>`, under `/home/lucmo/.claude3/jobs/fde5c58e/tmp/{fb,dv}`. The suites read `HEAD` and `git ls-files`, so an archive export is not sufficient. `node_modules` is a symlink to the repo's own directory, and it is in the clone's `.git/info/exclude`.

Labels: **measured** (a run in this session; the command is given), **cited** (a file or a note; the path and line are given), **estimate** (a calculation from measured or cited inputs).

## Method

This note uses the same-run share method of `docs/research/guard-port-cut-band.md` §Method. Both parts of the ratio come from the same run. The instrument is in the Appendix.

Changes for `node:test` and for plain Python:

- `node --test` runs each test file in a child process (isolation `process`, the default). `NODE_OPTIONS=--require preload.js` reaches the runner and every child. A depth counter in the environment (`R2238_DEPTH`) lets only depth 1 log: depth 0 is the runner, depth 1 is the test-file process, depth 2+ is what a test spawns.
- The preload wraps `spawnSync`, `execFileSync`, `execSync`, `spawn`, `execFile`, `exec`, `fork` and the promisified forms of `exec` and `execFile`. An async call is timed from the call to the `close` event of the child.
- Async calls can overlap. Thus the sum of call walls can be more than the file time. The summariser gives the sum and also the union of the call intervals. Where the two differ, the note says so.
- File time (the denominator): the life of the test-file process, from the preload to `exit`, in a run with `--test-concurrency=1` (one file at a time, no contention between the files). This is the same for every file.
- Python suites (`python3 test/x.test.py`): a `sitecustomize.py` on `PYTHONPATH` wraps `subprocess.Popen` (this covers `run`, `call`, `check_call`, `check_output`). It logs the program, the first arguments and the wall from `Popen()` to the `wait`/`poll` that sees the exit. It also times each Playwright sync call (`SyncBase._sync`) and the start and stop of `sync_playwright()`. A Python child (depth 1) logs only the total time it spent in Playwright, so a call to a program that drives a browser is split into browser time and the rest.
- File time for a Python suite: the life of the suite process, from `sitecustomize` import to `atexit`.

Classes of a boundary call:

| Class | What | Group |
| --- | --- | --- |
| `node-program`, `sh-program`, `py-program`, `program-direct` | A spawn of a program in the repo (the program under test), or of a copy of it in a fixture directory | **(a)** a core can reach it (F1.5 measures how much of a call goes) |
| `node-nested-test` | A nested `node --test` (a test of the suite runner) | (a) |
| `gh`, the stand-in `claude` CLI | A call to an external CLI (real or a stub) | (a) |
| `git` | A git call by the test itself: fixture work (it builds a repo, a commit, an index) | **(b)** a core with a real-git port still pays it |
| `browser` | Playwright calls, the driver start and stop, and the Playwright time inside a child program | **(c)** a real render is the thing under test; a core does not remove it |
| `shell-c`, `node-eval`, `python-c`, other tools | All other spawns | **(d)** |

Share rule: **share (a) = sum of the (a) call walls / file time** (the union of the intervals where calls overlap). The predicted cut uses the cut-band conversion (`guard-port-cut-band.md` Q1.5 to Q1.6): **cut ≈ share (a) × 0.80 to 0.97.** The low end keeps 10% of the calls as real boundary contract tests and puts the rest through a `runInProcess`-style entry at 10 to 40 ms each. The high end keeps 3% and calls the core directly (about 0.01 ms).

## F1. fantasy-books

### F1.1 What runs the suite, and who waits for it

**LABEL: cited.**

- fantasy-books declares no `commands.test` (`/home/lucmo/fantasy-books/.claude/workflow-core.json`: no `commands` key, `"modules": []`). Thus the core's `scripts/lib/test-gate.js` (plugin 1.3.15, lines 53 to 59) gives gate `null`: no core hook runs a suite at commit or at push.
- The full suite runner is `scripts/check-suites-green.js`. It runs every `scripts/*.test.js` in one `node --test --test-reporter=junit --test-concurrency=2` (lines 300 to 318), then every `scripts/*.test.py` one at a time (lines 382 to 395, 416 to 440). Then it runs each red suite again alone with the TAP reporter.
- `scripts/run-stop-checks.js:64` runs it on each `Stop`. It starts it **detached** (`startBackground`, `check-suites-green.js:615` to 628, `detached: true`, `unref()`), with a floor between runs (`maybeStart`). **Thus no session waits for the full suite.** The cost is machine load, not a wait.
- The suite wait that a person or a session has: `scripts/check-index-suites.js`, run by `scripts/hooks/commit-msg:72`. It runs only when the index stages `candidates/`, `taste/corpus/`, `taste/corpus-blind/` or `shortlist.md` (`TRIGGER`, line 64). Then it runs 9 suites (6 node, 3 python; `SUITES`, lines 67 to 77) in a throwaway worktree, 2 node suites at a time (line 80). Its header records **39.4 s** for a green one-dossier commit and **66.8 s** for a commit refused on three suites (2026-10-12, load1 20 to 24).
- **LABEL: measured.** 108 of the last 300 non-merge commits (2026-10-10 to 2026-10-19) stage a `TRIGGER` path. Command: `git log --no-merges --format=%h -n 300 HEAD`, then `git diff-tree --no-commit-id --name-only -r <c> | grep -qE '^(candidates/|taste/corpus/|taste/corpus-blind/|shortlist\.md$)'` for each.

### F1.2 Full-suite wall, as it runs today

**LABEL: measured.** Command (in the clone): `node scripts/check-suites-green.js`.

| Run | Start | Wall | load1/5/15 before | after | used / avail MB before | after | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fb-headline-1 | 2026-10-19 22:08:38 +08:00 | **1,322.5 s** | 32.6 / 38.5 / 38.9 | 47.2 / 54.6 / 52.5 | 6,692 / 3,231 | 7,289 / 2,634 | 99 suites (91 node, 8 python); 1 red (`run-stop-checks.test.js`, red in the whole run, green alone) |

- The 1,322.5 s includes the lone TAP re-run of the one red suite.
- Load1 here was 33 to 55, so the wall at rest is probably much lower than 1,322 s; the per-file shares below do not depend on the load.

### F1.3 Per-file time and boundary share (run 1)

**LABEL: measured.** Run fb-node-serial-1: start 2026-10-19 22:31:06 +08:00, wall 784.0 s, load1/5/15 before 54.1 / 55.6 / 52.9, after 22.7 / 27.6 / 38.4, used / avail MB before 8,237 / 1,686, after 5,482 / 4,441. 347 tests, 347 pass. Python suites: 22:45:30 to 22:46:23 +08:00, load1 22 to 29, avail 3,282 to 4,416 MB, all pass.

Commands (in the clone):

- Node: `R2238_OUT=<log> NODE_OPTIONS="$NODE_OPTIONS --require <inst>/preload.js" node --test --test-concurrency=1 --test-reporter=tap $(ls scripts/*.test.js | sort) > <tap>`, then `python3 <inst>/sum.py <clone> <log> <tap>`.
- Python: for each `scripts/*.test.py`: `R2238_PYOUT=<log> PYTHONPATH=<inst>/py python3 <file>`, then `python3 <inst>/sum.py <clone> <log>`.

File time is the life of the test-file process. On the 78 files where TAP names the file, TAP `duration_ms` sums to 679.2 s and the process lives sum to 667.7 s (TAP is 1.7% more: node start). 13 files print their tests at top level, so TAP gives no file line for them.

A fixture copies a program of the repo into a temp directory (`/tmp/<x>/scripts/<program>.js`) and runs it there. The summariser counts such a copy as the program under test (class a), by the last 1 to 4 parts of its path.

| File | File time (s) | (a) calls | (a) wall (s) | (a) share | git calls (b) | (b) wall (s) | (b) share | (d) wall (s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `build-site.test.js` | 72.1 | 92 | 46.8 | **0.650** | 38 | 1.5 | 0.021 | 0.0 |
| `commit-refusals.test.js` | 40.8 | 117 | 31.4 | **0.771** | 917 | 8.6 | 0.212 | 0.0 |
| `check-live-scale.test.js` | 34.9 | 16 | 28.7 | **0.822** | 251 | 5.4 | 0.154 | 0.0 |
| `check-research-label-figures.test.js` | 34.6 | 3 | 6.9 | **0.200** | 273 | 25.8 | 0.747 | 0.0 |
| `run-stop-checks.test.js` | 34.2 | 36 | 15.0 | **0.439** | 57 | 1.1 | 0.031 | 20.4 |
| `check-itemisation.test.js` | 33.7 | 33 | 23.2 | **0.688** | 263 | 6.4 | 0.188 | 0.1 |
| `check-dead-links.test.js` | 27.6 | 37 | 27.3 | **0.988** | 0 | 0.0 | 0.000 | 0.0 |
| `check-index-suites.test.js` | 25.4 | 19 | 18.6 | **0.730** | 238 | 6.7 | 0.263 | 0.0 |
| `check-relation-claims.test.js` | 22.7 | 107 | 20.2 | **0.887** | 0 | 0.0 | 0.000 | 1.1 |
| `check-committed-reversion.test.js` | 22.4 | 11 | 22.3 | **0.996** | 5 | 0.1 | 0.003 | 0.0 |
| `check-reachability.test.js` | 21.6 | 80 | 18.3 | **0.848** | 115 | 2.3 | 0.109 | 0.0 |
| `check-map-index.test.js` | 20.7 | 65 | 20.4 | **0.989** | 0 | 0.0 | 0.000 | 0.0 |
| `check-hook-wiring.test.js` | 20.3 | 35 | 15.8 | **0.775** | 193 | 4.1 | 0.201 | 0.1 |
| `check-rule-stamps.test.js` | 18.6 | 53 | 14.0 | **0.752** | 155 | 4.4 | 0.237 | 0.0 |
| `check-in-note-locators.test.js` | 16.1 | 73 | 9.3 | **0.574** | 436 | 6.2 | 0.385 | 0.0 |
| other 76 node files | 322.7 | | 240.1 | 0.744 | | | | |
| **91 node files** | **768.6** | 1983 | **558.4** | **0.727** | 6522 | 131.1 | 0.171 | 27.6 |
| 8 python suites | 41.0 | 32 | 4.9 | 0.119 | 2 | 0.0 | 0.000 | 1.2 |
| **All 99 suites** | **809.7** | | **563.3** | **0.696** | | 131.1 | 0.162 | 28.8 |


Findings:

- F1.3.1 **Class (a) share over the 91 node files: 0.727 (558.4 of 768.6 s). Over all 99 suites: 0.696 (563.3 of 809.7 s).** Git fixture work by the tests (b): 0.162. Other spawns (d): 0.036; most of (d) is `run-stop-checks.test.js`, whose runner under test spawns stub checks (`c.js`, `hang.js`, `crash.js`). That spawn is the job of the runner, so a core does not remove it.
- F1.3.2 The Python suites are mostly in-process already: (a) is 4.9 of 41.0 s (0.119), all of it in `check-blind-brief.test.py` (29 spawns of `check-blind-brief.py`) and `check-declared-class.test.py`.
- F1.3.3 The (a) wall is spread over **84 distinct programs**. The top 10 hold 48% of it, the top 20 hold 67%. The top programs by (a) wall: `build-site.js` (98 calls, 47.6 s), `commit-refusals.js` (119, 41.6 s), `check-live-scale.js` (16, 28.7 s), `check-dead-links.js` (37, 27.3 s), `check-itemisation.js` (33, 23.2 s), `check-committed-reversion.js` (11, 22.3 s), `check-map-index.js` (65, 20.4 s), `check-relation-claims.js` (107, 20.2 s), `check-index-suites.js` (19, 18.6 s), `check-reachability.js` (79, 17.9 s).
- F1.3.4 The mean wall of one (a) call is 127 ms to 2,030 ms.
- F1.3.5 Async overlap: only `run-stop-checks.test.js` has overlapping calls (sum − union = 2.5 s, all in class d). In every other file the union of the call intervals equals the sum.

### F1.4 Noise: 3 files, 3 runs each

**LABEL: measured.** Each file alone (`node --test --test-reporter=tap <file>`, instrumented, `R2238_NESTED=1`), in turn, 2026-10-19 22:47:09 to 22:53:16 +08:00. Available memory before each run: 4,199 to 4,778 MB.

| File | Run | load1 before → after | Wall (s) | File time (s) | (a) share | (b) share |
| --- | --- | --- | --- | --- | --- | --- |
| build-site | 1 | 35.1 → 29.0 | 38.57 | 38.09 | 0.726 | 0.039 |
| | 2 | 38.5 → 30.5 | 34.08 | 33.59 | 0.522 | 0.015 |
| | 3 | 25.5 → 24.7 | 25.89 | 25.55 | 0.636 | 0.022 |
| commit-refusals | 1 | 29.0 → 43.5 | 97.41 | 95.54 | 0.756 | 0.232 |
| | 2 | 30.5 → 28.0 | 45.24 | 44.91 | 0.790 | 0.195 |
| | 3 | 24.7 → 21.4 | 35.15 | 34.92 | 0.745 | 0.237 |
| check-live-scale | 1 | 43.5 → 38.5 | 42.97 | 41.44 | 0.850 | 0.131 |
| | 2 | 28.0 → 25.5 | 29.32 | 29.09 | 0.810 | 0.170 |
| | 3 | 21.4 → 18.4 | 17.85 | 17.72 | 0.740 | 0.218 |

Findings:

- F1.4.1 **Wall moves a lot: 26 to 38 s, 35 to 96 s, 18 to 42 s** (range / median 37%, 135%, 81%) at load1 18 to 44. The serial pass (F1.3), at load1 22 to 55, gave 72.1, 40.8 and 34.9 s.
- F1.4.2 **The (a) share moves less, but more than in the bash-guard class: 0.52 to 0.73, 0.745 to 0.79, 0.74 to 0.85** (range 0.20, 0.045, 0.11). The call counts do not move. In #2202 the share moved by 0.03 or less. A cause: here the time that is not (a) or (b) is in-process work of the test (in build-site, 0.24 to 0.46 of the file), and that work and the spawns slow down by different amounts under load. Thus read a fantasy-books port on the **call count** first and on the share second.

### F1.5 What is inside one (a) call (run 2, nested split)

**LABEL: measured.** Run fb-node-serial-2-nested: start 2026-10-19 22:53:58 +08:00, wall 688.0 s, load1/5/15 before 24.2 / 27.6 / 33.8, after 28.1 / 35.5 / 34.1, used / avail MB before 5,397 / 4,526, after 5,370 / 4,553. 347 tests, 347 pass. Command: as run 1, with `R2238_NESTED=1`; then `python3 <inst>/split.py <clone> <log>`.

With `R2238_NESTED=1`, each program that a test spawns (depth 2) writes one record at exit: its life (from the preload to exit) and the wall of its own spawns, by program. `split.py` puts each record in the smallest (a) call whose interval holds it (1,972 of 1,983 calls matched).

- F1.5.1 **Run 2 repeats run 1 on the suite: (a) share 0.733 (491.3 of 670.3 s of node file time); run 1 gave 0.727.** Per file, |share run 2 − share run 1| has median 0.023, p90 0.095, max 0.275.
- F1.5.2 **The 491.3 s of (a) calls, by part (time-weighted):**

| Part of an (a) call | Share of (a) | Seconds | What removes it |
| --- | --- | --- | --- |
| Outside the program: node start, exit, stdio pipe (call wall − program life) | **0.374** | 183.7 | Any in-process test path |
| The program's own `git` calls (11,744 calls) | **0.254** | 124.9 | Only a fake git port in the test; a real-git port keeps it |
| The program's own `gh` calls (stubs on `PATH`) | 0.017 | 8.3 | A fake gh port |
| The program's other spawns (`tar`, a nested `node build-site.js`) | 0.092 | 45.1 | In-process composition (partly) |
| In the program: module load and logic | **0.259** | 127.5 | Module load only (below); the logic stays |

- F1.5.3 **LABEL: measured** (2026-10-19 23:06 +08:00, load1 29.8, avail 3,623 MB). One bare `spawnSync(process.execPath, ["-e", "0"])`: min 41, p50 59, p90 92 ms (25 calls). The mean outside part of an (a) call is 93 ms (183.7 s / 1,972), so most of it is node start. Cold `require` of the 10 top programs (3 each, fresh process): 5 to 107 ms; median of the per-program medians 12 ms; `build-site.js` and `commit-refusals.js` 41 to 44 ms. Command: `node -e '…require(process.argv[1])…' scripts/<program>.js`.
- F1.5.4 **Thus about a quarter of an (a) call is the program's real work, and another quarter is its own real git.** The bash-guard class of #2202 did not have this: there, nearly all of a guard call was the cost to start bash and parse the guard. Thus the cut-band factor 0.80 to 0.97 on the whole share **over-predicts for fantasy-books**.
- F1.5.5 **LABEL: cited.** All 20 top programs guard their CLI entry with `require.main === module` (`grep -c 'require.main === module' scripts/<program>.js`: 1 in each). `check-suites-green.js:784` shows the form: `main(argv, opts)` with `opts.root` and `opts.out`. Thus the in-process entry mostly exists already. A port is mostly a change to how the tests call the programs, plus git and gh ports where the tests want to fake them.

### F1.6 Predicted cut

**LABEL: estimate.** Inputs: (a) = 563.3 s of 809.7 s of serial file time (F1.3, run 1, 99 suites); the split of F1.5.2; the kept-contract fraction and the in-process residual of `guard-port-cut-band.md` Q1.5 to Q1.6.

| Band | What a port does | Removable part of (a) | Kept as contract tests | Cut (s) | Cut (% of suite file time) |
| --- | --- | --- | --- | --- | --- |
| Naive (the #2202 conversion, share × 0.80 to 0.97) | All of each call | 1.00 | factor 0.80 to 0.97 | 451 to 546 | 55.7 to 67.5% |
| **Low** | Tests call `main()` in-process (a `runInProcess`-style entry, module cache purged); real git and gh | 0.374 (outside only) | 10% | **190** | **23.4%** |
| **High** | Tests call the core directly (cache kept); fake git and gh ports in most tests | 0.374 + 0.254 + 0.017 + module load about 0.06 = 0.705 | 3% | **385** | **47.6%** |

- F1.6.1 **Recommended band: 23% to 48% of the suite's serial file time, about 190 to 385 s of 810 s** (at load1 22 to 55).
- F1.6.2 The band does not count the git fixture work of the tests (class b, 131.1 s, 16.2%). A test that changes from a real fixture repo to a fake git port removes that too. That is a larger change to each test than a change of entry.
- F1.6.3 What drives the band: (1) whether the tests fake git (0.254 of a); (2) whether a `runInProcess` entry purges the module cache (about 0.06 of a); (3) the kept contract fraction (3% to 10%).
- F1.6.4 The cut is spread thin. 84 programs hold the (a) time and the top 10 hold 48% of it (F1.3.3). Thus a port of 10 programs and their test files gives about half of the band: about 90 to 185 s.

### F1.7 Where the wait falls in fantasy-books

- F1.7.2 **LABEL: measured.** The one wait is `check-index-suites.js` in `commit-msg`, on 108 of the last 300 commits (36%). A green one-dossier commit, run twice in the clone: **46.7 s and 47.1 s** (2026-10-19 23:06:58 and 23:07:45 +08:00, load1 24.5 → 26.5 and 26.5 → 23.0, avail 4,306 and 4,447 MB). Command: stage a one-line change to `candidates/a-wizard-of-earthsea.md`, then `node scripts/check-index-suites.js --message-file <msg>`. The header of the script cites 39.4 s at load1 20 to 24.
- F1.7.3 **LABEL: measured** (from F1.3 and F1.5). Its 9 suites hold 111.0 s (run 1) and 128.7 s (run 2) of serial file time. Their (a) share is 0.639 and 0.665. In their (a) calls the outside part is lower than in the suite (about 0.29, time-weighted over the 6 node suites), and two Python content suites (`scan-mixed-class-rows`, `scan-mark-vs-citations`, 20.5 s together) have no (a) calls.
- F1.7.4 **LABEL: estimate.** Cut on the 9 suites' file time: low about 0.65 × 0.29 × 0.90 ≈ 17%; high about 0.65 × (0.29 + 0.10 git + 0.06 load) × 0.97 ≈ 28%. On the 47 s wait that is **about 8 to 13 s for each record commit**, if the cut passes through the 2 node lanes in proportion. This is an estimate; the lanes can move the critical path.

### F1.8 Verdict for fantasy-books

**Ruled at #2243: a named retrofit of the 10 costliest programs' tests, because a detached suite's machine load counts as a cost (fantasy-books#1892, #830).**

- The suite is not small: 810 s of serial file time, 1,322 s of wall as it runs under load. The (a) share is high and stable (0.727 and 0.733). On the measured split, a core with an in-process test path removes about 23% to 48% of the suite. That is not "nothing material" as in mantahostels (12.6 s).
- Against a retrofit: no person or session waits for the full suite (it runs detached on `Stop`). The one wait (47 s on 36% of commits) gets about 8 to 13 s from a port. The cost that a retrofit removes is mostly machine load under the 10 GB cap, not a wait.
- Name for the retrofit: the test files of the 10 programs that hold 48% of the (a) time: `build-site`, `commit-refusals`, `check-live-scale`, `check-dead-links`, `check-itemisation`, `check-committed-reversion`, `check-map-index`, `check-relation-claims`, `check-index-suites`, `check-reachability`. Most of the programs already export `main(argv, opts)` (F1.5.5), so the change is in the tests: call `main()` in-process for most cases, and keep a few spawn cases as contract tests.
- The band's high end needs fake git ports; without them the cut is near the low end (23%).

## F2. design-vault

### F2.1 What runs the suite, and who waits for it

**LABEL: cited.**

- `.claude/workflow-core.json` declares `"commands": {"test": "bash test/all.sh"}` and `"modules": []`. Thus `scripts/lib/test-gate.js` (plugin 1.3.15, lines 53 to 59) gives gate `"commit"`: the core's `.husky/pre-commit` (lines 989 to 1003) runs `bash test/all.sh` in the commit lock and refuses the commit on a red, unless a pre-lock green stamp (`commit-paths.js`) stands it down. Either way, the commit waits for one run of `test/all.sh`.
- `test/all.sh` (lines 15 to 37) holds 22 suites: `node --test` (35 `test/*.test.js` files), `bash test/design-round-pointer.test.sh`, and 20 Python suites. 17 of the Python suites need Playwright and Chromium.
- In a commit, `test/all.sh` (lines 44 to 81) runs only the suites that `test/select-suites.js` selects for the staged paths. **`node --test` and the bash suite always run; only the Python suites are skipped** (`select-suites.js` lines 1 to 5). By hand, every suite runs.
- `test/run-lanes.sh` runs up to 3 suites at once. A 2nd or 3rd lane opens only while MemAvailable clears 3,400 or 4,050 MB (line 19) and fewer than 3 suites run on the machine.
- **design-vault already has an in-process test path for its Node programs**: `test/core-run-in-process.js` loads the core's `scripts/lib/run-in-process.js` (#187, "as base §X3 asks of a program test"). 20 of the 35 `test/*.test.js` files use it (`grep -l core-run-in-process test/*.js`).

### F2.2 Full-suite wall, as it runs today

**LABEL: measured.** Command (in the clone, by hand, so every suite runs): `bash test/all.sh`.

| Run | Start | Wall | load1/5/15 before | after | used / avail MB before | after | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dv-headline-1 | 2026-10-19 23:09:44 +08:00 | **1,132.4 s** | 25.6 / 29.3 / 31.9 | 24.4 / 26.7 / 29.3 | 6,060 / 3,863 | 5,365 / 4,558 | 22 of 22 suites passed |

Per-suite wall in that run (`run-lanes.sh` prints `== <suite> (<s> s)`): `node --test` 38, bash suite 4, `check-flow` 171, `check-frames` 170, `check-access` 155, `drive-form` 106, `look-renders` 93, `drive-overlay` 78, `check-overlay` 75, `check-measure` 61, `check-layout` 55, `drive-pointer` 49, `probe` 39, `check-load` 37, `face-profile` 21, `look` 20, `check-render` 14, `contact-sheet` 14, `conditions` 13, `cutout` 9, `parts-map` 8, `palette` 1. Sum 1,231 s. The sum is only 9% more than the wall, so the lanes seldom ran 2 or 3 at once (the memory rungs held them back at 3,863 MB available).

### F2.3 The wait at commit

**LABEL: measured.** The selection of `test/select-suites.js`, replayed over the last 120 non-merge commits (2026-10-15 to 2026-10-18). Command, in the clone: for each commit `c`, `git diff --name-only --no-renames c^ c | node test/select-suites.js --select <the 22 suites of all.sh>`.

| Suites selected | Commits |
| --- | --- |
| `node --test` and the bash suite only | 71 (59%) |
| 1 to 9 Python suites as well | 31 (26%) |
| 17 Python suites | 6 (5%) |
| All (`all` verdict) | 12 (10%) |

Python suites most often selected: `look-renders` (22 commits), `check-access` (17), `parts-map` (15), `check-flow` (14), `check-frames` (13).

**LABEL: estimate.** The wait for each replayed commit, from the per-suite walls of F2.2 (one lane: the sum; three lanes: a greedy schedule, the best case): median **42 s** (one lane) or **38 s** (three lanes); p75 306 s or 170 s; p90 1,231 s or 411 s; mean 274 s or 120 s.

### F2.4 Per-suite time and boundary share (run 1)

**LABEL: measured.** Pass dvp1, one suite at a time, 2026-10-19 23:28:56 to 23:46:47 +08:00. Load1 14.6 to 29.9; available memory 3,859 to 5,819 MB before each suite. 861 node tests pass; the bash suite and all 20 Python suites exit 0. Command: `<inst>/dv-pass.sh dvp1` (Appendix), then `sum.py` and `apportion.py`.

| Part | Wall in this pass (s) |
| --- | --- |
| `node --test --test-concurrency=1` (instrumented) | 89.2 |
| `bash test/design-round-pointer.test.sh` | 1.3 |
| 20 Python suites, one at a time (instrumented) | 978.1 |

Node files (one `node --test` process, one file at a time):

| File | File time (s) | Spawns by class | (a) wall, union (s) | (a) share | stub `claude` (s) | git (b) (s) | (b) share |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `gate-wording.test.js` | 27.2 | none | 0.00 | 0.000 | 0.00 | 0.00 | 0.000 |
| `client-originals.test.js` | 16.3 | git 14, py-program 50, python-c 21 | 10.48 | 0.643 | 0.00 | 0.38 | 0.023 |
| `select-suites.test.js` | 9.8 | sh-program 1, git 19 | 0.04 | 0.004 | 0.00 | 3.39 | 0.347 |
| `ingest.test.js` | 5.8 | other:claude 29, node-program 1 | 0.28 | 0.048 | 4.34 | 0.00 | 0.000 |
| `round-log.test.js` | 4.1 | git 401 | 0.00 | 0.000 | 0.00 | 3.76 | 0.922 |
| `calibration-critic.test.js` | 3.5 | other:claude 48 | 0.00 | 0.000 | 3.21 | 0.00 | 0.000 |
| `run-lanes.test.js` | 3.4 | sh-program 19, other:pgrep 8 | 3.35 | 0.990 | 0.00 | 0.00 | 0.000 |
| `fall.test.js` | 3.0 | none | 0.00 | 0.000 | 0.00 | 0.00 | 0.000 |
| `check-curves.test.js` | 1.2 | none | 0.00 | 0.000 | 0.00 | 0.00 | 0.000 |
| `gate-recheck.test.js` | 1.2 | none | 0.00 | 0.000 | 0.00 | 0.00 | 0.000 |
| `calibration-score.test.js` | 1.0 | none | 0.00 | 0.000 | 0.00 | 0.00 | 0.000 |
| `corrections-log.test.js` | 0.9 | git 43, sh-program 2 | 0.36 | 0.386 | 0.00 | 0.42 | 0.454 |
| `validate.test.js` | 0.8 | git 37 | 0.00 | 0.000 | 0.00 | 0.38 | 0.469 |
| `release-check.test.js` | 0.5 | git 28, gh 4 | 0.13 | 0.262 | 0.00 | 0.29 | 0.589 |
| `bundle.test.js` | 0.5 | git 23, shell-c 2 | 0.00 | 0.000 | 0.00 | 0.15 | 0.331 |
| other 29 files | 4.0 | | 0.49 | | | | |
| **44 files** | **82.9** | | **15.1** | **0.182** | 7.5 (0.091) | 8.8 | 0.106 |

- The default `node --test` pattern also loads the helper `.js` files under `test/` (44 files, not 35).
- `run-lanes.test.js` starts `test/run-lanes.sh` with overlapping async calls: the sum of the call walls is 36.4 s in a 3.4 s file. The table uses the union of the intervals. The spawns are the job of the runner under test (as `run-stop-checks` in fantasy-books). Thus they are contract calls; a core does not remove them.
- `ingest.test.js` and `calibration-critic.test.js` spawn a stand-in `claude` (`WFC_CLAUDE_BIN`, a stub node script). That is an external CLI boundary, as `gh` is. A port for it removes these 7.5 s.

Python suites (each suite alone; Chromium time apportioned on clock time, F2.0 below):

| Suite | File time (s) | Program spawns | (a) program, not browser (s) | (a) share | (c) Chromium (s) | (c) share | Clock scale |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `check-access.test.py` | 144.1 | 27 | 30.3 | 0.210 | 112.4 | 0.780 | 0.27 |
| `check-flow.test.py` | 140.5 | 130 | 17.6 | 0.125 | 106.6 | 0.759 | 1.00 |
| `check-frames.test.py` | 134.7 | 27 | 8.0 | 0.059 | 126.5 | 0.939 | 1.00 |
| `look-renders.test.py` | 84.5 | 18 | 7.2 | 0.085 | 76.6 | 0.907 | 1.00 |
| `drive-form.test.py` | 73.0 | 0 | 0.0 | 0.000 | 71.7 | 0.983 | 1.00 |
| `drive-overlay.test.py` | 70.6 | 0 | 0.0 | 0.000 | 70.0 | 0.992 | 1.00 |
| `check-overlay.test.py` | 68.2 | 22 | 31.0 | 0.455 | 35.0 | 0.513 | 1.00 |
| `drive-pointer.test.py` | 49.8 | 0 | 0.0 | 0.000 | 49.6 | 0.997 | 1.00 |
| `check-layout.test.py` | 44.6 | 19 | 2.1 | 0.048 | 42.4 | 0.951 | 0.32 |
| `check-load.test.py` | 36.7 | 4 | 1.3 | 0.035 | 35.3 | 0.963 | 1.00 |
| `probe.test.py` | 33.5 | 14 | 2.3 | 0.068 | 31.0 | 0.926 | 1.00 |
| `look.test.py` | 19.9 | 8 | 3.1 | 0.154 | 16.2 | 0.817 | 1.00 |
| `check-measure.test.py` | 14.8 | 17 | 3.1 | 0.211 | 11.6 | 0.786 | 1.00 |
| `contact-sheet.test.py` | 13.3 | 4 | 0.8 | 0.063 | 12.2 | 0.917 | 1.00 |
| `check-render.test.py` | 13.0 | 25 | 3.7 | 0.284 | 0.0 | 0.000 | 1.00 |
| `face-profile.test.py` | 10.1 | 3 | 0.6 | 0.064 | 9.5 | 0.934 | 1.00 |
| `parts-map.test.py` | 9.1 | 6 | 0.9 | 0.097 | 8.2 | 0.900 | 0.35 |
| `conditions.test.py` | 7.9 | 0 | 0.0 | 0.000 | 7.8 | 0.986 | 1.00 |
| `cutout.test.py` | 7.1 | 5 | 3.1 | 0.442 | 0.0 | 0.000 | 1.00 |
| `palette.test.py` | 1.6 | 20 | 1.6 | 0.978 | 0.0 | 0.000 | 1.00 |
| **20 suites** | **976.9** | | **116.7** | **0.119** | **822.7** | **0.842** | |

How the Python split works (F2.0, the classification rule):

- **Rule: a Chromium launch and all page work is class (c), and a core does not remove it**, because the render in a real browser is the thing under test. Class (c) is the time inside Playwright: each sync API call (`SyncBase._sync`), and `sync_playwright()` start and stop. That is measured in the suite process, and in each Python child program (its total, written at exit).
- A spawn of a repo program (`python3 plugin/.../check-flow.py`, `node .../fall.js`) is class (a) **less the Playwright time inside it**. Thus (a) here is: Python start, imports (numpy, scipy, PIL, Playwright), and the program's own logic.
- `check-access`, `check-layout` and `parts-map` run the program calls in a thread pool (`concurrent.futures.ThreadPoolExecutor`), so the call walls overlap. "Clock scale" is the union of the call intervals divided by the sum of the call walls. Each class is scaled by it, so the classes add up to clock time.

Findings:

- F2.4.1 **Chromium (c) is 0.842 of the Python suites (822.7 of 976.9 s).** Class (a) is 0.119 (116.7 s). Git (b) is zero: no Python suite builds a git fixture.
- F2.4.2 **Over the whole suite (node + bash + Python, 1,061 s of serial file time): (c) 0.775, (a) 0.131 (139.3 s, with the `claude` stub), (b) 0.008, and in-process test time about 0.08.**
- F2.4.3 Four suites drive the browser in the test process itself and spawn no program: `drive-form` (1,737 Playwright calls), `drive-overlay` (2,581), `drive-pointer` (385), `conditions` (179). Their time is 0.98 to 0.997 (c).
- F2.4.4 **177 program calls each start their own Playwright driver and Chromium** (`check-flow` 42, `check-access` 26, `check-frames` 22, `check-layout` 18, `check-overlay` 17, `look-renders` 14, `check-measure` 13, and 6 more suites). **LABEL: measured** (2026-10-19 23:52 +08:00, load1 16.5 to 17.2, avail 4,943 to 5,378 MB): one `sync_playwright()` start + `chromium.launch()` + close, in a fresh Python, takes min 0.68, p50 0.70, max 3.26 s (5 runs). Python start alone: 9 to 14 ms. `import numpy, PIL.Image, scipy.ndimage`: min 0.73, p50 2.7 s, max 27 s (8 runs; the page cache was under pressure). `from playwright.sync_api import sync_playwright`: min 0.32, p50 1.1 s.

### F2.5 Noise: 3 parts, 3 runs each

**LABEL: measured.** Run 1 is pass dvp1 (F2.4). Runs 2 and 3: 2026-10-19 23:54:17 to 2026-10-20 00:01:35 +08:00, in turn (check-flow, check-access, node). Available memory before each run: 5,042 to 6,294 MB. Command: `<inst>/dv-noise.sh 2 3` (Appendix), then `sum.py` and `apportion.py`.

| Part | Run | load1 before → after | File time (s) | (a) share | (c) share | (b) share |
| --- | --- | --- | --- | --- | --- | --- |
| check-flow | 1 | 23.6 → 16.7 | 140.5 | 0.125 | 0.759 | 0 |
| | 2 | 28.1 → 15.3 | 103.0 | 0.087 | 0.830 | 0 |
| | 3 | 19.2 → 9.0 | 100.6 | 0.098 | 0.823 | 0 |
| check-access | 1 | 24.8 → 26.8 | 144.1 | 0.210 | 0.780 | 0 |
| | 2 | 15.3 → 12.9 | 72.3 | 0.178 | 0.819 | 0 |
| | 3 | 9.0 → 11.5 | 72.2 | 0.185 | 0.811 | 0 |
| node (44 files, serial) | 1 | 29.9 → 27.4 | 82.9 | 0.273 (with `claude` stub) | — | 0.106 |
| | 2 | 12.9 → 19.2 | 53.0 | 0.263 | — | 0.067 |
| | 3 | 11.5 → 7.7 | 31.2 | 0.263 | — | 0.073 |

Findings:

- F2.5.1 **Wall moves by a factor of 1.4 to 2.7** (check-flow 101 to 141 s, check-access 72 to 144 s, node 31 to 83 s) as load1 fell from about 25 to about 10.
- F2.5.2 **The shares move by 0.04 or less:** (a) 0.087 to 0.125, 0.178 to 0.210, 0.263 to 0.273; (c) 0.759 to 0.830, 0.780 to 0.819. The call counts do not move. Run 1 (the highest load) gives the highest (a) share in all three: program start and imports slow down more than browser work under load.

### F2.6 Predicted cut

**LABEL: estimate.** Inputs: F2.4 (run 1), F2.4.4, the cut-band conversion.

The (a) time that a core can reach: 139.3 s of 1,061 s (0.131). Of this:

- Node: 15.1 s (union) + 7.5 s (`claude` stub). `run-lanes.test.js` (3.35 s) is a contract test of a process runner, so it stays. Reachable: about 19.2 s. The largest single part is `client-originals.test.js`, which spawns a Python program 50 times (10.5 s).
- Python: 116.7 s. This is Python start (9 to 14 ms a call, small), imports (numpy, scipy, PIL, Playwright: 0.3 to 2.7 s a call at p50, F2.4.4), and the program's logic. A test that imports the program once and calls it in-process pays the imports once per suite, not once per call. The logic stays. This note did not measure the split of imports against logic in the Python programs; the band below takes 0.5 to 0.9 of the 116.7 s as imports and start.

| Band | What a port does | Cut (s) | Cut (% of 1,061 s serial) |
| --- | --- | --- | --- |
| Naive (#2202 conversion on all of a) | 139.3 × 0.80 to 0.97 | 111 to 135 | 10.5 to 12.7% |
| **Low** | 10% kept as contract; Python (a) is 0.5 imports and start | 17 + 53 = **70** | **6.6%** |
| **High** | 3% kept; Python (a) is 0.9 imports and start | 19 + 102 = **120** | **11.4%** |
| Outside the rule: one shared browser for the cases of a suite | 177 launches × 0.68 to 0.70 s, less the thread-pool overlap | about **+100** | about +9% |

- F2.6.1 **Recommended band for the core-and-shell rule: 7% to 11% of the suite, about 70 to 120 s of 1,061 s of serial file time.** Under the classification rule (F2.0), Chromium (77.5% of the suite) stays.
- F2.6.2 If a core also lets the tests share one browser per suite (one launch, not 177), the launch cost goes too: about 100 s more, a total of about 17% to 21%. The page work (the render itself) stays in both readings. This lever is a browser port and a shared session, not the in-process core of #2186.

### F2.7 Where the wait falls in design-vault

- F2.7.2 **LABEL: measured (F2.3).** 59% of commits run only `node --test` and the bash suite. In the lane run (F2.2) that was 38 s and 4 s, in parallel: **about 38 to 42 s**.
- F2.7.3 **LABEL: estimate.** The cut does not reach that wait. `node --test` runs its files 7 at a time by default (`availableParallelism() − 1`), so its wall is set by the longest file. The longest file is `gate-wording.test.js` (27.2 s in the serial pass, 33% of all node file time). It spawns nothing (F2.4 table), so a core does not change it. It is the longest file in all 3 runs of F2.5 (27.2, 20.8, 11.0 s). The node (a) time (19.2 s, mostly `client-originals.test.js`, 16.3 s) is in other files that run beside it. **Thus the cut on the typical commit is about 0 to 5 s.**

### F2.8 Verdict for design-vault

**Ruled at #2243: change-only — the rule applies to new and changed code only.**

- The (a) share is low (0.131 of the suite; 0.06 to 0.21 in the browser suites), and the typical commit's wait is set by an in-process test file (`gate-wording.test.js`) that a core does not change.
- The rest of the Node (a) time is one file (`client-originals.test.js`, which spawns a Python program) and the stub `claude` CLI.
- The cost is Chromium (0.775 of the suite). The core-and-shell rule does not reach it. If the dispatching session wants to cut the long commits, the lever is the browser: one browser per suite in place of 177 launches (about 100 s, about 9%), and the selection of `select-suites.js`. It is not a retrofit under #2186; it is design-vault#376.
- If most of the Python (a) time is imports (not logic), the high band (11%) holds, and a small named retrofit of the 4 suites with the largest (a) time (`check-access` 30.3 s, `check-overlay` 31.0 s, `check-flow` 17.6 s, `client-originals` 10.5 s) gives about 60 to 80 s on the full run, but nothing on the typical commit.

## Headline

| | fantasy-books | design-vault |
| --- | --- | --- |
| Measured commit | `7ac8c29` | `1775611` |
| Full suite as it runs (measured) | 1,322.5 s (`node scripts/check-suites-green.js`, load1 33 to 47) | 1,132.4 s (`bash test/all.sh`, load1 24 to 26) |
| Serial file time (measured) | 809.7 s (91 node + 8 python) | 1,061 s (44 node + bash + 20 python) |
| (a) share: spawns of the program under test (measured) | **0.696** (run 2 node: 0.733) | **0.131** |
| (b) git fixture work (measured) | 0.162 | 0.008 |
| (c) Chromium (measured) | 0 | **0.775** |
| Naive cut, (a) × 0.80 to 0.97 (estimate) | 56% to 68% | 10.5% to 12.7% |
| **Recommended cut band (estimate)** | **23% to 48% (190 to 385 s)** | **7% to 11% (70 to 120 s)**; +9% with one shared browser (outside the rule) |
| Who waits for the full suite (cited) | Nobody: it runs detached on `Stop` | The commit, for the suites `select-suites.js` selects |
| Typical wait (measured) | 47 s on the 36% of commits that stage a record (`check-index-suites.js`) | 38 to 42 s on the 59% of commits that run only `node --test` + bash |
| Cut on that wait (estimate) | about 8 to 13 s | about 0 to 5 s (the long pole is an in-process file) |
| **Ruling (#2243)** | **Named retrofit, limited** | **Change-only** |

- **The naive conversion of #2202 does not carry over to fantasy-books.** In a bash guard, nearly all of the call is the cost to start bash and parse the guard. In a fantasy-books program, 0.374 of the call is node start and exit, 0.254 is the program's own real git, and 0.259 is its own logic and module load (F1.5). Thus a later ticket must use the measured split, not share × 0.80 to 0.97.
- **The share is stable on the suite, less so on one file.** Suite (a) share: fantasy-books 0.727 and 0.733 in two full passes; design-vault parts within 0.04 over 3 runs. One fantasy-books file moved by up to 0.20 (build-site). Read a port on the call count first.

## Appendix: the instrument

Kept so that a later ticket can measure again by the same method. Paths in the scripts are those of this run; change `J` for a new run.

`envrec.sh` (date, load and memory before and after; wall of the command):

```bash
#!/usr/bin/env bash
# envrec.sh <label> -- <command...>: prints date, load and memory before and after, and the wall of the command.
label=$1; shift; [[ $1 == -- ]] && shift
b_load=$(cut -d' ' -f1-3 /proc/loadavg); b_mem=$(free -m | awk '/^Mem:/{print $3" used / "$7" avail"}'); b_date=$(date -Is)
t0=$EPOCHREALTIME
"$@"; rc=$?
t1=$EPOCHREALTIME
a_load=$(cut -d' ' -f1-3 /proc/loadavg); a_mem=$(free -m | awk '/^Mem:/{print $3" used / "$7" avail"}')
printf 'ENV %s | start %s | rc %s | wall %.2f s | load before %s | after %s | mem before %s | after %s\n' "$label" "$b_date" "$rc" "$(echo "$t1 - $t0" | bc)" "$b_load" "$a_load" "$b_mem" "$a_mem" >&2
exit $rc
```

`preload.js` (`NODE_OPTIONS="$NODE_OPTIONS --require <inst>/preload.js"`, `R2238_OUT=<log>`; `R2238_NESTED=1` adds the depth-2 split):

```js
// Times every child_process call made by a node:test test-file process.
// Gating: R2238_DEPTH counts node processes that loaded this preload. The `node --test` runner is depth 0,
// each test-file child is depth 1 (the only one that logs), and anything a test spawns is depth 2+ (silent:
// its time is inside the depth-1 call that waits for it, so it is not counted twice).
const cp = require("node:child_process");
const fs = require("node:fs");
const util = require("node:util");
const mod = require("node:module");
const { performance } = require("node:perf_hooks");
const depth = Number(process.env.R2238_DEPTH || 0);
process.env.R2238_DEPTH = String(depth + 1);
const OUT = process.env.R2238_OUT;
const now = () => performance.timeOrigin + performance.now();
if (OUT && depth === Number(process.env.R2238_LOGDEPTH || 1)) {
	const log = (rec) => {
		try {
			fs.appendFileSync(OUT, JSON.stringify({ pid: process.pid, ...rec }) + "\n");
		} catch {}
	};
	const desc = (file, args) => {
		const a = Array.isArray(args) ? args : [];
		return { file: String(file).slice(0, 300), a0: a.slice(0, 5).map((x) => String(x).slice(0, 160)) };
	};
	for (const name of ["spawnSync", "execFileSync", "execSync"]) {
		const orig = cp[name];
		cp[name] = function (file, args, ...rest) {
			const t0 = now();
			try {
				return orig.call(this, file, args, ...rest);
			} finally {
				const t1 = now();
				log({ k: name, ...desc(file, args), ms: t1 - t0, t0, t1 });
			}
		};
	}
	for (const name of ["spawn", "execFile", "exec", "fork"]) {
		const orig = cp[name];
		const wrapped = function (file, args, ...rest) {
			const t0 = now();
			const child = orig.call(this, file, args, ...rest);
			try {
				child.once("close", () => {
					const t1 = now();
					log({ k: name, ...desc(file, args), ms: t1 - t0, t0, t1 });
				});
			} catch {}
			return child;
		};
		// util.promisify(exec/execFile) reads the custom symbol; keep it, timed.
		const custom = orig[util.promisify.custom];
		if (typeof custom === "function") {
			wrapped[util.promisify.custom] = function (file, args, ...rest) {
				const t0 = now();
				const p = custom.call(this, file, args, ...rest);
				const done = () => {
					const t1 = now();
					log({ k: name + "-p", ...desc(file, args), ms: t1 - t0, t0, t1 });
				};
				p.then(done, done);
				return p;
			};
		}
		cp[name] = wrapped;
	}
	mod.syncBuiltinESMExports();
	const start = now();
	log({ k: "start", argv1: process.argv[1] || "", t0: start });
	process.on("exit", () => log({ k: "end", argv1: process.argv[1] || "", t0: start, t1: now() }));
} else if (OUT && process.env.R2238_NESTED && depth === Number(process.env.R2238_LOGDEPTH || 1) + 1) {
	// A program a test spawned (depth 2): one record at exit with its life and the wall of its own spawns by
	// program, so the depth-1 call that waited for it can be split into "the program's own git/gh/other spawns"
	// and "node start + module load + logic" (what an in-process call with a real-git port still pays vs not).
	const agg = {};
	const add = (file, ms) => {
		const b = String(file).split(/[\s/]/).filter(Boolean);
		const base = String(file).includes(" ") ? String(file).split(" ")[0].split("/").pop() : b.pop() || "";
		const k = base === "git" ? "git" : base === "gh" ? "gh" : "other";
		agg[k] = (agg[k] || 0) + ms;
		agg[k + "_n"] = (agg[k + "_n"] || 0) + 1;
	};
	for (const name of ["spawnSync", "execFileSync", "execSync"]) {
		const orig = cp[name];
		cp[name] = function (file, ...rest) {
			const t0 = now();
			try {
				return orig.call(this, file, ...rest);
			} finally {
				add(file, now() - t0);
			}
		};
	}
	for (const name of ["spawn", "execFile", "exec"]) {
		const orig = cp[name];
		const wrapped = function (file, ...rest) {
			const t0 = now();
			const child = orig.call(this, file, ...rest);
			try {
				child.once("close", () => add(file, now() - t0));
			} catch {}
			return child;
		};
		const custom = orig[util.promisify.custom];
		if (typeof custom === "function") {
			wrapped[util.promisify.custom] = function (file, ...rest) {
				const t0 = now();
				const p = custom.call(this, file, ...rest);
				const done = () => add(file, now() - t0);
				p.then(done, done);
				return p;
			};
		}
		cp[name] = wrapped;
	}
	mod.syncBuiltinESMExports();
	const start = now();
	process.on("exit", () => {
		try {
			fs.appendFileSync(OUT, JSON.stringify({ k: "nested", pid: process.pid, ppid: process.ppid, t0: start, t1: now(), script: (process.argv[1] || "").split("/").slice(-2).join("/"), ...agg }) + "\n");
		} catch {}
	});
}
```

`py/sitecustomize.py` (`PYTHONPATH=<inst>/py`, `R2238_PYOUT=<log>`):

```python
# Times every subprocess.Popen and every Playwright sync call of a python test suite.
# Gating: R2238_PYDEPTH counts python processes that loaded this file. The suite process (`python3 test/x.test.py`)
# is depth 0 and logs each child process and each browser interval. A python child (depth 1+) logs only one
# "nested-browser" record at exit: the time it spent inside Playwright, so the parent's call to it can be split
# into browser work and the rest.
import os, sys, time, json, threading, atexit

_OUT = os.environ.get("R2238_PYOUT")
_DEPTH = int(os.environ.get("R2238_PYDEPTH") or 0)
os.environ["R2238_PYDEPTH"] = str(_DEPTH + 1)
_lock = threading.Lock()
_tls = threading.local()


def _log(rec):
    try:
        rec = {"pid": os.getpid(), "ppid": os.getppid(), "depth": _DEPTH, **rec}
        with _lock, open(_OUT, "a") as f:
            f.write(json.dumps(rec) + "\n")
    except Exception:
        pass


if _OUT:
    import subprocess

    _browser = {"ms": 0.0, "n": 0}

    if _DEPTH == 0:
        _orig_init = subprocess.Popen.__init__
        _orig_wait = subprocess.Popen.wait
        _orig_poll = subprocess.Popen.poll

        def _desc(args):
            if isinstance(args, (str, bytes)):
                a = [args if isinstance(args, str) else args.decode("utf8", "replace")]
            else:
                a = [
                    os.fspath(x)
                    if not isinstance(x, bytes)
                    else x.decode("utf8", "replace")
                    for x in args
                ]
            return {
                "file": str(a[0])[:300] if a else "",
                "a0": [str(x)[:160] for x in a[1:6]],
            }

        def _init(self, args, *rest, **kw):
            self._r_t0 = time.time() * 1000
            self._r_desc = _desc(args)
            self._r_done = False
            _orig_init(self, args, *rest, **kw)

        def _finish(self):
            if getattr(self, "_r_done", True) or self.returncode is None:
                return
            self._r_done = True
            t1 = time.time() * 1000
            _log(
                {
                    "k": "popen",
                    **self._r_desc,
                    "child": self.pid,
                    "ms": t1 - self._r_t0,
                    "t0": self._r_t0,
                    "t1": t1,
                }
            )

        def _wait(self, *a, **kw):
            try:
                return _orig_wait(self, *a, **kw)
            finally:
                _finish(self)

        def _poll(self):
            r = _orig_poll(self)
            _finish(self)
            return r

        subprocess.Popen.__init__ = _init
        subprocess.Popen.wait = _wait
        subprocess.Popen.poll = _poll

    def _patch_playwright():
        try:
            from playwright._impl import _sync_base
            from playwright.sync_api import _context_manager
        except Exception:
            return

        def timed(kind, fn):
            def w(*a, **kw):
                if getattr(_tls, "inpw", False):
                    return fn(*a, **kw)
                _tls.inpw = True
                t0 = time.time() * 1000
                try:
                    return fn(*a, **kw)
                finally:
                    _tls.inpw = False
                    t1 = time.time() * 1000
                    _browser["ms"] += t1 - t0
                    _browser["n"] += 1
                    if _DEPTH == 0:
                        _log(
                            {
                                "k": "browser",
                                "file": kind,
                                "a0": [],
                                "ms": t1 - t0,
                                "t0": t0,
                                "t1": t1,
                            }
                        )

            return w

        _sync_base.SyncBase._sync = timed("pw-call", _sync_base.SyncBase._sync)
        cm = _context_manager.PlaywrightContextManager
        cm.__enter__ = timed("pw-start", cm.__enter__)
        cm.__exit__ = timed("pw-stop", cm.__exit__)

    # Patch Playwright when it is first imported, not before (importing it eagerly would change the suite).
    import importlib.abc, importlib.machinery

    class _Hook(importlib.abc.MetaPathFinder):
        def find_spec(self, name, path, target=None):
            if name == "playwright.sync_api":
                sys.meta_path.remove(self)
                spec = importlib.machinery.PathFinder.find_spec(name, path)
                if spec and spec.loader:
                    orig_exec = spec.loader.exec_module

                    def exec_module(module):
                        orig_exec(module)
                        _patch_playwright()

                    spec.loader.exec_module = exec_module
                return spec
            return None

    sys.meta_path.insert(0, _Hook())

    _start = time.time() * 1000
    if _DEPTH == 0:
        _log(
            {
                "k": "start",
                "argv1": sys.argv[1]
                if len(sys.argv) > 1
                else (sys.argv[0] if sys.argv else ""),
                "t0": _start,
            }
        )

    def _end():
        t1 = time.time() * 1000
        if _DEPTH == 0:
            _log(
                {
                    "k": "end",
                    "argv1": sys.argv[0] if sys.argv else "",
                    "t0": _start,
                    "t1": t1,
                }
            )
        elif _browser["n"]:
            _log({"k": "nested-browser", "ms": _browser["ms"], "n": _browser["n"]})

    atexit.register(_end)
```

`sum.py` (`python3 sum.py <clone> <log> [<tap>]`: per file, calls by class, sum, union, shares):

```python
# Summarise a #2238 call log: per test file, boundary calls by class, sum and union of their wall, share of the
# file's time. Usage: python3 sum.py <repo root> <call log> [<tap output> ...] > out.json
# Denominator: the TAP duration_ms of the file where a TAP output names it, else the file process's own lifetime
# (preload/sitecustomize start to exit).
import json, os, re, sys, collections as C

root = os.path.realpath(sys.argv[1])
logf = sys.argv[2]
taps = sys.argv[3:]

# TAP: a top-level "ok N - <path>" / "not ok N - <path>" followed by "  duration_ms: X".
tapdur = {}
for t in taps:
    lines = open(t, errors="replace").read().split("\n")
    for i, l in enumerate(lines):
        m = re.match(r"^(not ok|ok) \d+ - (.*)$", l)
        if not m:
            continue
        name = m.group(2).strip()
        for j in range(i + 1, min(i + 6, len(lines))):
            d = re.match(r"^  duration_ms: ([0-9.]+)", lines[j])
            if d:
                tapdur[os.path.basename(name)] = (float(d.group(1)), m.group(1) == "ok")
                break

NODES = {"node", os.path.basename(sys.executable) if False else "node"}


TESTRE = re.compile(r"\.test\.(js|py|ts|sh)$")


def inrepo(p):
    """A program of the repo: a path in the clone, or a copy of one (a fixture copies scripts/x.js into a temp
    dir), matched on its last 1 to 4 path parts. A test file is not a program."""
    if not p or TESTRE.search(p):
        return False
    q = p if os.path.isabs(p) else os.path.join(root, p)
    q = os.path.realpath(q)
    if q.startswith(root + os.sep):
        return True
    parts = [x for x in p.split("/") if x]
    for k in range(min(4, len(parts)), 0, -1):
        if os.path.isfile(os.path.join(root, *parts[-k:])):
            return True
    return False


def script_of(args):
    for a in args:
        if a.startswith("-"):
            continue
        return a
    return ""


def cls(r):
    f = r.get("file", "")
    a = r.get("a0", [])
    base = os.path.basename(f.split()[0]) if f else ""
    if r["k"] == "browser":
        return "browser"
    if r["k"] == "execSync":  # a shell line: classify by its first word
        words = f.split()
        base = os.path.basename(words[0]) if words else ""
        a = words[1:6]
        f = words[0] if words else ""
    if base == "git":
        return "git"
    if base == "gh":
        return "gh"
    if (
        base == "node"
        or base.startswith("node")
        and f.endswith("/node")
        or base == "nodejs"
    ):
        if "--test" in a:
            return "node-nested-test"
        if a and a[0] in ("-e", "--eval", "-p", "--print"):
            return "node-eval"
        s = script_of(a)
        if s and inrepo(s):
            return "node-program"
        return "node-other"
    if base in ("bash", "sh", "dash", "zsh"):
        s = script_of(a)
        if a and a[0] == "-c" or not s:
            return "shell-c"
        return "sh-program" if inrepo(s) else "sh-other"
    if f.endswith(".sh"):
        return "sh-program" if inrepo(f) else "sh-other"
    if base.startswith("python"):
        if len(a) >= 2 and a[0] == "-m" and a[1] == "playwright":
            return "browser"
        if a and a[0] == "-c":
            return "python-c"
        s = script_of(a)
        return "py-program" if s and inrepo(s) else "python-other"
    if f.endswith(".py") or f.endswith(".js"):
        return "program-direct" if inrepo(f) else "other:" + base
    if "chrom" in base or "headless_shell" in base:
        return "browser"
    return "other:" + base


# Groups for the report.
GROUP = {
    "node-program": "a",
    "sh-program": "a",
    "py-program": "a",
    "program-direct": "a",
    "node-nested-test": "a",
    "gh": "a",
    "git": "b",
    "browser": "c",
}


def group(k):
    return GROUP.get(k, "d")


def union(iv):
    iv = sorted(iv)
    tot, cs, ce = 0.0, None, None
    for s, e in iv:
        if cs is None:
            cs, ce = s, e
        elif s <= ce:
            ce = max(ce, e)
        else:
            tot += ce - cs
            cs, ce = s, e
    if cs is not None:
        tot += ce - cs
    return tot


procs = C.OrderedDict()
nested = {}
for line in open(logf):
    try:
        r = json.loads(line)
    except Exception:
        continue
    if r["k"] == "nested":
        continue
    if r["k"] == "nested-browser":
        nested[r["pid"]] = r["ms"]
        nested.setdefault(("pp", r.get("ppid")), 0)
        nested[("pp", r.get("ppid"))] += r["ms"]
        continue
    p = procs.setdefault(
        r["pid"], {"calls": [], "start": None, "end": None, "argv1": ""}
    )
    if r["k"] == "start":
        p["start"] = r["t0"]
        p["argv1"] = r.get("argv1", "")
    elif r["k"] == "end":
        p["end"] = r["t1"]
        p["argv1"] = p["argv1"] or r.get("argv1", "")
    else:
        p["calls"].append(r)

files = []
for pid, p in procs.items():
    name = os.path.basename(p["argv1"])
    life = (p["end"] - p["start"]) if p["start"] and p["end"] else float("nan")
    dur, ok = tapdur.get(name, (None, None))
    denom = (
        life if life == life else dur
    )  # uniform: process lifetime; TAP only where no lifetime
    n, s, ivs = C.Counter(), C.Counter(), C.defaultdict(list)
    for r in p["calls"]:
        k = cls(r)
        ms = r["ms"]
        # A python call to a program that drove a browser: move its browser time to class c.
        nb = nested.get(r.get("child"), 0) if r.get("child") else 0
        if nb and group(k) == "a":
            n["browser-nested"] += 0
            s["browser-nested"] += nb
            ms = ms - nb
        n[k] += 1
        s[k] += ms
        ivs[group(k)].append((r["t0"], r["t1"]))
        ivs["all"].append((r["t0"], r["t1"]))
    g = C.Counter()
    for k, v in s.items():
        g["c" if k == "browser-nested" else group(k)] += v
    files.append(
        {
            "file": name,
            "pid": pid,
            "ok": ok,
            "denom_ms": round(denom, 1),
            "life_ms": round(life, 1),
            "counts": dict(n),
            "sum_ms": {k: round(v, 1) for k, v in s.items()},
            "group_ms": {k: round(v, 1) for k, v in g.items()},
            "union_all_ms": round(union(ivs["all"]), 1),
            "union_a_ms": round(union(ivs["a"]), 1),
            "share_a": round(g["a"] / denom, 3) if denom else None,
            "share_b": round(g["b"] / denom, 3) if denom else None,
            "share_c": round(g["c"] / denom, 3) if denom else None,
            "share_d": round(g["d"] / denom, 3) if denom else None,
            "share_all_union": round(union(ivs["all"]) / denom, 3) if denom else None,
            "tap_ms": round(dur, 1) if dur else None,
            "share_a_union": round(union(ivs["a"]) / denom, 3) if denom else None,
            "overlap": round(
                sum(s.values()) - union(ivs["all"]) - s.get("browser-nested", 0), 1
            ),
        }
    )
files.sort(key=lambda x: -(x["denom_ms"] or 0))
print(json.dumps(files, indent=None))
```

`split.py` (`python3 split.py <clone> <log>`, on a log made with `R2238_NESTED=1`: the parts of each (a) call):

```python
# Split the class-(a) calls of a #2238 log (run with R2238_NESTED=1) into: the program's own spawns (git, gh,
# other), its in-process life (module load + logic), and the rest (node start, exit, pipe) = call wall - life.
# Usage: python3 split.py <repo root> <call log>. Needs sum.py beside it (for cls/group).
import json, os, sys, collections as C

sys.argv = [sys.argv[0], sys.argv[1], sys.argv[2]]
here = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(here, "sum.py")).read().split("procs = C.OrderedDict()")[0]
g = {}
exec(src, g)
cls, group = g["cls"], g["group"]
logf = sys.argv[2]
calls, nested, starts = [], [], {}
for line in open(logf):
    r = json.loads(line)
    if r["k"] == "nested":
        nested.append(r)
    elif r["k"] == "start":
        starts[r["pid"]] = os.path.basename(r["argv1"])
    elif r["k"] not in ("end", "nested-browser"):
        calls.append(r)
calls.sort(key=lambda r: r["t0"])
acc = C.defaultdict(C.Counter)
for n in nested:
    best = None
    for c in calls:
        if c["t0"] <= n["t0"] and n["t1"] <= c["t1"]:
            if best is None or c["ms"] < best["ms"]:
                best = c
    if best is None:
        continue
    best.setdefault("nested", []).append(n)
for c in calls:
    k = cls(c)
    if group(k) != "a":
        continue
    f = starts.get(c["pid"], "?")
    a = acc[f]
    a["calls"] += 1
    a["call_ms"] += c["ms"]
    ns = c.get("nested", [])
    if ns:
        n = max(ns, key=lambda x: x["t1"] - x["t0"])
        life = n["t1"] - n["t0"]
        a["matched"] += 1
        a["life_ms"] += life
        a["outside_ms"] += c["ms"] - life
        for key in ("git", "gh", "other"):
            a[key + "_ms"] += n.get(key, 0)
            a[key + "_n"] += n.get(key + "_n", 0)
for f, a in acc.items():
    tot = a["call_ms"] or 1
    print(
        json.dumps(
            {
                "file": f,
                "calls": a["calls"],
                "matched": a["matched"],
                "call_s": round(a["call_ms"] / 1000, 2),
                "outside_share": round(a["outside_ms"] / tot, 3),
                "inner_git_share": round(a["git_ms"] / tot, 3),
                "inner_gh_share": round(a["gh_ms"] / tot, 3),
                "inner_other_share": round(a["other_ms"] / tot, 3),
                "logic_share": round(
                    (a["life_ms"] - a["git_ms"] - a["gh_ms"] - a["other_ms"]) / tot, 3
                ),
                "inner_git_n": a["git_n"],
                "inner_other_n": a["other_n"],
            }
        )
    )
```

`apportion.py` (`python3 apportion.py <sum.json>`: classes scaled to clock time where calls overlap):

```python
# Apportion each file's clock time inside spawns (the union of its call intervals) to the classes, in proportion
# to their raw call wall, so overlapping calls (a thread pool) do not count twice. Usage: apportion.py <sum.json>
import json, sys

d = json.load(open(sys.argv[1]))
G = {"a": 0, "b": 0, "c": 0, "d": 0}
T = 0
rows = []
for x in d:
    s = x["sum_ms"]
    raw = {
        "a": x["group_ms"].get("a", 0),
        "b": x["group_ms"].get("b", 0),
        "c": x["group_ms"].get("c", 0),
        "d": x["group_ms"].get("d", 0),
    }
    tot = sum(raw.values())
    f = (x["union_all_ms"] / tot) if tot else 0
    eff = {k: v * f for k, v in raw.items()}
    for k in G:
        G[k] += eff[k]
    T += x["denom_ms"]
    rows.append((x["file"], x["denom_ms"], eff, round(f, 3)))
for name, den, eff, f in rows:
    print(
        f"{name:30s} {den / 1000:6.1f} "
        + " ".join(f"{k}={eff[k] / 1000:6.1f}s({eff[k] / den:.3f})" for k in "abcd")
        + f" scale={f}"
    )
print(
    "TOTAL",
    round(T / 1000, 1),
    {k: (round(v / 1000, 1), round(v / T, 3)) for k, v in G.items()},
)
```

`noise.sh` (fantasy-books: each node file alone, in turn, N rounds):

```bash
#!/usr/bin/env bash
# noise.sh <clone> <tag> <rounds> <file...>: runs each node test file alone, in turn, <rounds> times, instrumented.
J=/home/lucmo/.claude3/jobs/fde5c58e/tmp; clone=$1 tag=$2 rounds=$3; shift 3
cd "$clone" || exit 1
for r in $(seq 1 "$rounds"); do
  for f in "$@"; do
    b=$(basename "$f" .test.js); out=$J/runs/$tag-$b-r$r
    rm -f $out.jsonl
    R2238_NESTED=1 R2238_OUT=$out.jsonl NODE_OPTIONS="$NODE_OPTIONS --require $J/inst/preload.js" \
      $J/inst/envrec.sh "$tag $b r$r" -- node --test --test-reporter=tap "$f" > $out.tap 2> $out.err
    grep '^ENV' $out.err
  done
done
```

`dv-pass.sh` (design-vault: the instrumented pass, one suite at a time):

```bash
#!/usr/bin/env bash
# dv-pass.sh <tag>: instrumented design-vault pass: node --test one file at a time, the bash suite, then each python suite alone.
J=/home/lucmo/.claude3/jobs/fde5c58e/tmp; tag=$1; cd $J/dv || exit 1
unset $(git rev-parse --local-env-vars)
rm -f $J/runs/$tag-node.jsonl $J/runs/$tag-py.jsonl
R2238_NESTED=1 R2238_OUT=$J/runs/$tag-node.jsonl NODE_OPTIONS="$NODE_OPTIONS --require $J/inst/preload.js" \
  $J/inst/envrec.sh "$tag node" -- node --test --test-concurrency=1 --test-reporter=tap > $J/runs/$tag-node.tap 2>> $J/runs/$tag.env
$J/inst/envrec.sh "$tag bash-suite" -- bash test/design-round-pointer.test.sh > $J/runs/$tag-bash.out 2>> $J/runs/$tag.env
for s in $(sed -n "/^registry='/,/'\$/p" test/all.sh | grep -o 'test/[a-z-]*\.test\.py'); do
  R2238_PYOUT=$J/runs/$tag-py.jsonl PYTHONPATH=$J/inst/py \
    $J/inst/envrec.sh "$tag $s" -- python3 $s > $J/runs/$tag-$(basename $s).out 2>> $J/runs/$tag.env
done
echo done >> $J/runs/$tag.env
```

`dv-noise.sh` (design-vault: check-flow, check-access and node, in turn):

```bash
#!/usr/bin/env bash
# dv-noise.sh <first round> <last round>: check-flow, check-access and node --test, in turn, instrumented.
J=/home/lucmo/.claude3/jobs/fde5c58e/tmp; cd $J/dv || exit 1
unset $(git rev-parse --local-env-vars)
for r in $(seq "$1" "$2"); do
  for s in test/check-flow.test.py test/check-access.test.py; do
    b=$(basename $s .test.py); rm -f $J/runs/dvn-$b-r$r.jsonl
    R2238_PYOUT=$J/runs/dvn-$b-r$r.jsonl PYTHONPATH=$J/inst/py $J/inst/envrec.sh "dvn $b r$r" -- python3 $s > $J/runs/dvn-$b-r$r.out 2>> $J/runs/dvn.env
  done
  rm -f $J/runs/dvn-node-r$r.jsonl
  R2238_OUT=$J/runs/dvn-node-r$r.jsonl NODE_OPTIONS="$NODE_OPTIONS --require $J/inst/preload.js" \
    $J/inst/envrec.sh "dvn node r$r" -- node --test --test-concurrency=1 --test-reporter=tap > $J/runs/dvn-node-r$r.tap 2>> $J/runs/dvn.env
done
echo done >> $J/runs/dvn.env
```
