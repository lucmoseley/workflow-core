# Research: test-cost practices and their efficacy hazards (ticket #1792)

Question: Which test-cost practices did this project's precedent fixes and published guidance validate? Which of them caused a test to lose efficacy?

Parent map: #1771. Rule from the founder: do not trade efficacy for speed.


## Part 1: Precedent

### P1. design-vault#349: index the copy search one time

Source: `gh issue view 349 --repo lucmoseley/design-vault --comments` (body, Deviations comment, resolution comment, follow-up comment).

- Cause of the slow time: each of 107 records had two tests. Each test called `copies()` two times, approximately 430 calls in total. Each call normalised 80 files (1.2 MB) again and did a `String.includes` over the full file for each 8-word window. One call took 2.27 to 2.54 s (issue body).
- Before: 759 s for 220 tests, run alone, load approximately 11 on 8 cores (issue body). The resolution comment measured 722 s at HEAD a32c970, load 12 to 15.
- Change (commit 3d1804c): index the word runs of the gate questions one time. Slide one window over the words of each file and look up each window in the index. Cache the result of each file by a SHA-1 of its text and of the question set. `parseGate` runs one time for each gate text.
- After: 8.1 to 8.4 s for 220 tests over two runs at load 5.5 to 6; 8.8 s at load 10 to 12 (resolution comment). Gain: approximately 90 times.
- Rejected design: the prototype cached a per-file set of all word runs. Each test plants new text into the 358 KB `data/gallery.json`. Thus the prototype would keep approximately 214 near-copies, each with approximately 400k strings: "gigabytes" (Deviations comment). Lesson: a cache that is keyed by content must not keep one large entry for each mutated copy of a fixture.
- How efficacy was kept:
  - Contract test: old and new `copies()` gave byte-identical JSON on 26 trees (the real tree, 24 single plants over 8 questions, 1 tree with 13 copies).
  - All existing tests passed without change (220 of 220; 222 of 222 on the working tree).
  - 4 mutations, all caught. The window-one-word-short mutation failed 217 tests. The mutation "drop the questions from the cache key" was caught only by a new test, and only after that test planted a line that no earlier test planted.
  - Two new tests: one pins `words` as the first window (no earlier test asserted it); one checks that a gate added after a search is still looked for in files that search already read. That test guards the cache key.
- Efficacy hazard found: a cache key that omits an input is a stale-cache fault. The old tests did not catch it. A new test was necessary.
- One edge changed: a question with no words outside its `<…>` slots is now skipped. Before, it compared an empty run (Deviations comment).
- Follow-up 53e9221: three tests now share one `CALM_GATE` fixture, after the founder ruled "a test may change where it still does its job". Mutations were run again and all were caught.
- Bound stated on the issue: the JSON comparison sampled the plants for 8 of 106 questions.

### P2. mantahostels#3535: speed up the six slowest test files

Source: `gh issue view 3535 --repo lucmoseley/mantahostels --comments` (body and 7 comments).

- Ticket rule (body): "Keep at least one test per file that spawns the real shell or child process: that path is the only thing covering the real process boundary." The ticket called this lever "the reserve lever with no coverage cost".
- Ticket rule (body): time each file on the 2-core CI runner, not locally. Reason: mantahostels#313 "measured a local 2.26x speedup landing as ~7% on CI".
- Change 1 (commit 0e272fa93), `scripts/guard-echo-call.test.ts`: one test made 260 real spawns only to fill the 200-line cap of `ec_store`. Now it seeds 259 records directly in the tab format and keeps one real `call()` to exercise the trim. Local: 39.58 s to 9.62 s, 32 of 32 pass. CI: 70.6 s to 20.9 s (run 35072299114 against run 35073206469).
  - Mutation: bump `EC_MAX_LINES`; the moved test failed (first comment).
  - Efficacy hazard found by code review (commit ff31955d7): the seeded test used `toBeLessThanOrEqual`. It could pass on far fewer than 200 lines if `ec_store` silently dropped malformed seeds. Fix: `toBe(200)` and a check that the survivor is not a seed. Lesson: a seeded (synthetic) fixture can let a weak assertion pass vacuously; pin the exact count.
- Change 2 (commit c3c3b5962), `scripts/dispatch-sessions.test.ts`: two tests took 36 s each to drive the real 3 x 12 s wedge. One now reads the exported default (15 ms) from `lib/interop-probe.sh`. The "refuses inside 45s" case still drives the wedge for real: the one process-boundary test. Local: 137 s to 101 s, 87 of 87 pass. Mutation done (one reset line alone survives, for a stated reason).
  - Review (22f37af6b): the unit case moved to a new `scripts/lib/interop-probe.test.ts` beside the library, under code-standards §X3. The CI saving for this change is projected, not measured.
- Files left unchanged, with reasons (first and fourth comments):
  - `dispatch-sessions` (before change 2): two tests deliberately exercise the real shipped probe-timeout default; "shortening it stops testing the guarantee".
  - `guard-commit-form.test.ts`: already uses `runInProcess`; the remaining cost is 178 real `spawnSync(GUARD)` calls on a bash script with no in-process path. Per-test median 187 ms over 388 tests.
  - `bg-run.test.ts`: timing thresholds already near minimum. Five kill-record tests at 5.7 s each could share one killed run for approximately 23 test-seconds, but that is "a race-prone restructure" and was not done.
  - `pick-next.test.ts`, `check-doc-map.test.ts`: diffuse cost (medians 134 ms and 84 ms); git-fixture setup, not sleeps.
- Whole-suite effect on CI: sum of 325 files 1,538.0 to 1,533.0 test-seconds; Vitest step wall 594 s both runs; job 707 s both runs. Noise band of four sweeps: 573 to 611 s, so plus or minus 20 s is noise. Ratio measured: 2.59 test-seconds per wall-second on the 2-core runner.
- Lessons:
  - A large per-file gain did not move the whole-suite wall time or the billed minute. Per-file time is a weak proxy for the cost of the suite when the suite runs in parallel.
  - A per-test profile (JSON reporter) found the outliers. A read of the file did not.
  - Do not shorten a timeout that is the guarantee under test.
  - Shared state across tests (one killed run for five tests) was rejected as race-prone for a small gain.

### P3. mantahostels#1907, mantahostels#1945, mantahostels#1951: move program tests onto the in-process seam

Sources: `gh issue view 1945 --repo lucmoseley/mantahostels --comments` (body and 14 comments); `gh issue view 1951 ... --comments` (body and ruling comment). Figures for mantahostels#1907 are as quoted in the body of mantahostels#1945.

- Scale (mantahostels#1907, quoted in mantahostels#1945 body): 725 `execSync`/`execFileSync`/`spawnSync` sites in 153 of 210 test files; 56 call `process.execPath`, 45 call a guard binary.
- First five files (mantahostels#1907, quoted in mantahostels#1945 body): 264.0 s to 86.5 s in total, as mantahostels#1945 quotes it; mantahostels#1907 records 71.5 s once the git fixture template also landed (P3a). Examples: `session-arbiter.test.ts` 116.3 s to 36.6 s; `guard-priced-options.test.ts` 17.5 s to 2.1 s. Gain range: "8x on a hook guard, which was almost all startup, to 2.5x on a checker that does real work".
- Later conversions (mantahostels#1945 comments): `reap-finished-sessions.test.ts` 30.6 s to 12.6 s; `guard-selection-sum.test.ts` 26.7 s to 5.3 s; `check-context-budget.test.ts` 26.67 s to 15.82 s (2 of 3 sites); `gh.test.ts` 7.49 s to 1.00 s; `check.test.ts` 25.09 s to 22.02 s (1 of 8 sites; the other 7 must keep a real fd).
- Four shapes that must keep a spawn (mantahostels#1945 body; now in code-standards §X3): an async entry point; a timeout or signal; two processes at once; a real fd.
- Efficacy faults found and fixed:
  - Lost exit-code check (mantahostels#1945, comment 2; commit 9d266b6b): `execFileSync` throws on a non-zero exit. `runInProcess` does not. On 5 call sites, a crashed script passed silently. Fix: `expect(res.status).toBe(0)`, verified by a mutation that forces `main()` to throw. The same fault class came back on `guard-commit-form.test.ts` and review caught it again (commit d23847e3: a shared `arbiter()` helper that throws on non-zero).
  - Hidden real-fd site (mantahostels#1945, comments 3 to 5): `lib/check.js` `reread()` gives a grandchild `stdio: "inherit"`. That writes to the OS fd and bypasses the captured stderr of the seam. A real test failure (4 reds) found it. It became item 7 in the header of `run-in-process.js`.
  - A conversion missed a third spawn site, and the deviation comment stated a wrong claim; review found both.
  - A mutation was left live in the shared tree for a short time during re-verification (spec F1, declined as a timing artefact). Hazard: a mutation test in a shared tree can affect a neighbour.
- What the seam loses (mantahostels#1951 body; ruling comment): the founder chose option A. §X3 now prescribes the seam and names the four shapes. The standards line of §W said a conversion "stops testing the shebang, argv and exit-code seam the husky hooks depend on". After the ruling, argv and the exit code cross the seam; only the shebang is lost. The trade was about 180 s of suite wall time against the shebang and process-crash boundary.
- Fork attribution (mantahostels#1945, comment from mantahostels#2066): the vitest suite was 76.1% of forks on the loaded machine (approximately 660 of 868 forks/s). Each guard run forks approximately 14 children, so one guard test case is approximately 15 processes. 48.4% of `git` processes came from a vitest worker (git fixtures).

### P3a. mantahostels#1907 (parent) and mantahostels#1993: what the seam must keep, and how to rank

Sources: `gh issue view 1907 --repo lucmoseley/mantahostels --comments` (body and 4 comments); `gh issue view 1993 ... --comments` (body and 7 comments).

- Cost model (mantahostels#1907 body): 115 ms for each `node` spawn, 5 ms for each `bash` spawn (timed 20 times). `check-doc-map.test.ts` cost 380 ms for each test: approximately 115 ms node start and approximately 90 ms git fixture.
- Two hazards that mantahostels#1907 named before it started (body):
  1. "Exit codes and stdout are the assertion in most of these tests." A seam must return them.
  2. "Process isolation is doing real work." A spawn gives a clean module registry, `process.env` and `cwd`. In-process calls share all three. Vitest isolates per file, not per test. Thus a converted file needs explicit teardown, or state leaks between cases.
- Design (mantahostels#1907, comment 1): one generic loader, `scripts/lib/run-in-process.js`. No production script changed, "so a gate cannot be loosened by the conversion". The loader purges the module registry for each call.
- Result (mantahostels#1907, comment 2): five files 264.0 s to 71.5 s, every test green. `check-doc-map.test.ts` 74.2 s to 29.5 s (seam) to 17.7 s (git fixture template).
- Mutation evidence (mantahostels#1907, comment 2): 5 checker mutations (6, 2, 31, 14, 5 tests failed) and 13 mutations on the seam itself, all caught.
- Shared-state faults found by review (mantahostels#1907, comments 2 and 3): the seam leaked a crash-reporter listener pair for each call onto the vitest worker; an uncaught throw was not given to the script's own handler (so exit 1, not BROKEN exit 2); a restore that threw was swallowed; exit status was not masked to 8 bits. All fixed. Later verify: 837 of 837 pass, no `MaxListenersExceededWarning`.
- Acceptance rule (mantahostels#1907 body): "No test's assertion weakened to accommodate the seam; a case that genuinely needs a subprocess keeps one."
- Rank method (mantahostels#1993 and its comments): the static score "spawn sites x test count" was wrong three ways: a line-based regex missed wrapped calls; most sites in `check.test.ts` must keep a real fd; a helper-based site is called fewer times than the test count. The last pick in mantahostels#1993 measured the current inner time of five candidates first and took the outlier (`admission.test.ts`, approximately 25 s against 4.7 to 6.5 s). Lesson: measure, then pick.
- Noise (mantahostels#1993, last comment): the same unchanged code read 25.02 s, 25.88 s and 16.16 s under neighbour load. No clean A/B was possible.

### P4. mantahostels#2016, mantahostels#2023 (and mantahostels#2048, mantahostels#2068, mantahostels#2070): build the fixture once and copy it

Sources: `gh issue view 2016 --repo lucmoseley/mantahostels --comments`; `gh issue view 2023 ... --comments` (body, benchmark comment, resolution comment).

- Before (mantahostels#2016 body): `guard-commit-form.test.ts` made 13 `git` spawns for each test (two `git init` repos and one `git worktree add`). 283 tests gave 3,679 git processes for each run of one file. Profile: fixture 63 ms and guard spawn 64 ms for each test. The file took 233.8 s in a loaded full-suite run, against approximately 60 s quiet.
- Change: build the fixture one time in `beforeAll` into a template directory; give each test an `fs.cpSync` copy. Each test still gets a fresh copy, so this is a fresh fixture from a cached template, not a shared mutable fixture.
- After: git spawns for each test 13 to 0. Wall 59.80 s to 33.00 s and 49.42 s on two runs. The issue claims no single speedup figure because of neighbour load; "the durable, load-independent result is the spawn count, 14 per test down to 1" (mantahostels#2016 body).
- Earlier figure (mantahostels#1907 body): a per-test fixture rebuild costs 90 ms; `cp -r` from a template costs 16 ms (5.5 times on that term).
- Efficacy hazard, and its guard (mantahostels#2016 body): git writes absolute paths into the copy (`core.hooksPath`, the `.git` file of the worktree, the `gitdir` pointer). If they stay, "a commit made in the copied worktree lands in the template's object store and leaks into the next test — it does not fail loudly". Guard: `relink()` rewrites them; two new isolation tests assert that a commit in the copy and in the copied worktree is invisible to the template. Mutation: disabling `relink` killed 7 old worktree tests and the 2 new isolation tests.
- Defect found in passing (mantahostels#2016 body): `core.hooksPath` pointed at a path that did not exist, so husky was disabled by accident. Now it points at an empty directory that exists, and a test asserts it.
- Generalisation (mantahostels#2023 resolution): shared helper `scripts/lib/git-fixture.ts` (mantahostels#2068). mantahostels#2048 found a fifth kind of path carrier (an arbiter store, a written `CLAUDE_PROJECT_DIR`) that the four hard-coded paths of mantahostels#2016 missed. Now the helper discovers path carriers by walking the copy, and a leak check scans each copy for a template path and throws. Lesson: a hard-coded list of shared-state carriers misses one; detect the leak generically.
- Where to stop (mantahostels#2023 resolution, ruling mantahostels#2070): convert only a file at or above 9.27 test-side git spawns for each test (the census p90) and at or above 5 s. 11 files converted; the tail stays as it is. The census figures: `docs/data/git-spawn-census-2026-08-30.csv` in mantahostels.
- Pricing caution (mantahostels#2023 body): the top five spawn-heavy files held approximately 660 s of approximately 2,980 s test time in a loaded run, approximately 9% of the suite.
- Two limbs (mantahostels#2023 benchmark comment): after mantahostels#2016, `guard-commit-form.test.ts` still made 2,288 git spawns, from inside the guard under test. A fixture copy does not remove those. The fixture limb and the subject limb need separate pricing and separate levers.
- Timing hazard (mantahostels#2023 body, from mantahostels#2035): "Removing a subprocess removes latency a test may silently have been relying on." Pre-conversion check: grep for `budget`, `timeout`, `deadline`, `elapsed`, `Date.now` and small millisecond literals; give such a branch a deterministic seam (injected clock or predicate) before conversion. "Widening the budget and the corpus instead trades flakiness for a slow test and is the worse trade."

### P5. mantahostels#2022: more workers rejected; the suite is spawn-bound

Source: `gh issue view 2022 --repo lucmoseley/mantahostels --comments`.

- Three whole-suite rows: 2 workers, heavy load, 432.61 s; 3 workers on a clear machine, 311.69 s; 3 workers with 9 sessions live, 474.7 s.
- "Worker count is not the dominant term — session load is." The first "28% improvement" compared a quiet 3-worker run to a loaded 2-worker run. That pair was not fair.
- CPU: `cpu 187.9%` of an 800% ceiling with 3 workers allowed. "Spawn-bound, not CPU-bound."
- Cost: 3 workers add approximately 950 MB of resting memory floor (1,850 MB to 2,800 MB).
- Decision: `maxWorkers` stays at 2. "The lever is removing spawns, not adding workers."
- Lessons for a rule: (1) compare timings only as a controlled pair at the same load; (2) parallelism does not fix a spawn-bound test; it adds memory cost. Efficacy is not at risk here, but measurement validity is.

### P6. mantahostels#2035: a test lost its process-start latency and its 1 ms budget assertion broke

Source: `gh issue view 2035 --repo lucmoseley/mantahostels --comments` (body and 3 comments).

- Fault: the test asserted that `--budget-ms 1` stopped a 40-file scan short. The assertion was true only because a spawn paid approximately 80 ms of Node start before the scan. The in-process seam (commit f238514c) removed that time; the branch was no longer taken. The commit said "80/80 green", so the conversion passed when it was run and failed later on a quiet machine.
- Fix (commits 3cef17d6, d20aaa66): a predicate seam `MANTA_CENSUS_BUDGET_AFTER=<n>` (a file count). The count caps the clock and does not replace it. The test sets n = 5 against 40 files and a 60 s budget, and pins two independent outputs ("Budget spent at 5 of 40" and "300 failed / 0 succeeded") so an off-by-one fails both.
- Residual efficacy loss, stated and declined (resolution comment): the real wall-clock arm (`Date.now() >= deadline`) is now reached by no test. A mutation that removes it fails nothing. The alternative was the flaky timing assertion the ticket removes.
- Rule written from it (body): "a test that depends on how long a process takes to start is not testing the budget, it is testing the runtime." Do the pre-conversion grep (see P4).
- Lesson: a green run after a speed change is not evidence that a timing assertion still means anything.

### P7. Later faults in the seam and the shared fixture (lucmoseley/mantahostels#2239, mantahostels#2254, mantahostels#2178, mantahostels#3158, mantahostels#3168)

Sources: `gh issue view <n> --repo lucmoseley/mantahostels --json body,comments` for 2239, 2178, 3158, 3168. mantahostels#2254 is as quoted in lucmoseley/mantahostels#2239.

- lucmoseley/mantahostels#2239: a full suite on a loaded machine failed 189 of 189 tests in `pick-next.test.ts` with the seam's re-entrancy error. Cause (from mantahostels#2254, as quoted): a case that timed out did not release the process-wide claim flag of the seam. Each later, sequential case then found a live claim and threw. Fix: a 2000 ms `staleMs` takeover. Residual, stated in the seam header: a late write from the abandoned call can land in the captured stdout of the next holder (a `SyntaxError` in one test was seen). Hazard class: in-process shared state (globals patched for each call) turns one timeout into a cascade of failures. A spawn does not have this fault.
- mantahostels#2178: two hazards in the copy-fixture pattern. (1) The builder was copied verbatim into each converted file; fix: one shared builder in `scripts/lib/git-fixture.ts`. (2) A non-discriminating test: "a commit made in the copy leaves the template untouched" wrote into the real `.git` of the copy, which no relink target touches, so it "cannot fail on any relink regression". Fix: delete it or assert a real path carrier. A relink assertion `startsWith(fresh)` was too weak; it became exact path, exists and empty directory. A similar test was ticketed as mantahostels#2193. Lesson: an isolation test for a shared template must fail when the isolation breaks; prove it by mutation.
- mantahostels#3158: after fixture roots moved inside the repo (mantahostels#3149), three "not a repo" cases "stayed green for the wrong reason". They passed through a different branch of the guard, so the branch they pinned was untested. Found by reading, then proven by mutation. Fix: a helper `mkDirOutsideRepo` that refuses a base under a `.git`. Lesson: moving a fixture to save cost or isolate CI can make a test vacuous with no red test.
- mantahostels#3168: a test `rmSync`ed the shared fixture base while other workers minted under it: intermittent `ENOTEMPTY`, and other files saw "template dir had vanished". It passed in a 53-file run minutes earlier. Fix: an optional `base` parameter so the case uses a private base; regrow branch proven by mutation; five-file run passed three times. Residual, stated: the memoised shared base regrowing is now exercised by no test end to end. Hazard class: Interacting Tests through a shared fixture across parallel workers.

### P8. Timeouts, load and the price of a sweep (mantahostels#2255, mantahostels#2262, mantahostels#3493, mantahostels#3541)

Sources: `gh issue view <n> --repo lucmoseley/mantahostels --json title,body,comments` for 2255, 2262, 3493 (body and last two comments). mantahostels#3541 is as quoted in mantahostels#3493.

- mantahostels#2255: in the worst of four full runs, 299 of 300 failures were `Test timed out in 5000ms`; one was a real assertion. Re-run unloaded, all 28 failures of a loaded run passed, max 3,141.6 ms, 24 of 28 under 1 s. Load multiplied a spawning test by a median x39.6 (min x1.7, max x386.2). Quiet distribution: 99.1% of 8,754 bound tests at 2x margin or better.
- Ruling (founder, option B, 31 Aug 2026): raise the fixed per-test timeout to 90 s; do not scale it on machine load. Scaling "would make the suite's verdict a function of the machine". `retry: 1` was declined: the retry runs under the same contention and pays the time two times.
- Unpriced risk stated on mantahostels#2255: the cost of a true hang at 90 s.
- mantahostels#2262: the four per-file timeout raises (20 s, 30 s) became reductions against 90 s and were removed. Mutation: reverting to 5,000 ms failed a 12 s-by-design test. Lesson for a per-test time rule: a hard per-test time ceiling is a correctness gate only for a hang. It must not be the tool for a cost budget, because load moves timings by up to two orders of magnitude.
- mantahostels#3493 resolution: the price lever chosen was "skip a sweep's tests when the head sha already has a green sweep". It costs nothing for new code (54% of sweeps re-tested a commit already green). Speeding up the six slowest files (mantahostels#3535) gave no billed saving. Splitting the suite into fast and slow sets was declined at mantahostels#3541: "every sweep keeps the whole suite", because a ~20 h coverage hole is not worth approximately $3 a month (as quoted in mantahostels#3493). Lesson: the founder chose coverage over a lower bill when the two conflicted.

### P9. workflow-core precedents (#1150, #65, #154, #1480)

Sources: `gh issue view <n> --repo lucmoseley/workflow-core-tracker --json title,body,comments` (body and last two comments).

- #1150 (cut `new-repo.test.ts`): two cuts. (1) Hooks off in the `--resume` groups, with one guard case that asserts a hooked and an unhooked clean run give an equal `endState()` and `maskedTree`. The ticket said: "If they differ, step 1 does not ship." One hook-refusal case stays on the real hook stack. (2) Each part-way world is built one time per describe and restored at the same sandbox path for each case. A path rewrite could not reach HOME inside git blobs, so restore-in-place was used; "safe because a file's cases run one at a time".
  - Figures: resume groups 181.7 s to 104.1 s and 130.1 s (28 to 43% less) at load 2 to 4 times higher than baseline. Whole file 258 s to 227 s and 277 s: not settled. Cause stated: "`beforeAll` now builds the worlds, and that time does not show up in any case's duration."
  - Lessons: (a) when you remove a real dependency (hooks) from a test, add an equivalence test that proves the result is the same, and keep one case on the real dependency; (b) a per-test duration hides `beforeAll` cost, so measure file wall time, not the sum of test durations; (c) a fixture restored at a fixed path is safe only while the file runs its cases one at a time.
- #65: a test wrote its fixture into the real `scripts/` directory; a render test in a parallel worker saw it and failed. It passed alone. Fix: skip the fixture by name before any filesystem read. Hazard class: Interacting Tests through a shared real directory.
- #154: a test wrote a 484,021-byte stall fixture log into the real log store. The store keeps 30 runs, so each fixture run evicted a real suite log. Fix: point the child at an isolated `CLAUDE_PROJECT_DIR`; two assertions pin it, keyed on pid so a neighbour suite cannot flake them. CI then found an `ENOENT` regression in an isolated worktree. Hazard: a test that writes to shared real state harms other runs, not only itself.
- #1480 (ruled 13 Oct 2026, built at #1500): move the wait and deadlock verdict logic out of the CLI into a pure module (readings in, verdict out). The verdict table then becomes an in-process, no-real-time test surface. Spawned tests shrink to exit-code mapping, signal handling and oracle cadence. This is the design-level form of candidate (c): extract a pure seam, and keep spawned tests for only what the process boundary owns.

### P10. design-vault timing flakes and suite selection (design-vault#148, design-vault#351, design-vault#146)

Sources: `gh issue view <n> --repo lucmoseley/design-vault --json title,body,comments` (body and last comment, each cut to 1,800 characters).

- design-vault#148: a morph-length test failed by 0.1 ms (999.9 against a floor of 1000) at load 28.6. The ticket blamed load. The fix found the real cause: the observer skips a write that does not change the value, so a correct measurement can be up to 3.3 ms early. Floor now `1000 - 4` with a comment. Mutations: an early morph and a wrong checker each still fail. Lesson: before you widen a tolerance to make a test pass under load, find the mechanism, then mutation-test the new tolerance.
- design-vault#351: a 400 ms animation fixture could finish before the script first read it on a loaded machine. Fix: `fill: "backwards"` keeps it visible however late the first read is; a longer duration was rejected because it made the test wait to `--timeout`. A scratch checker that ignores scans before 1500 ms told the old and new fixtures apart; plain CPU load did not (15 of 15 passed on the old fixture). Lesson: make a fixture deterministic against delay; do not make it slow.
- design-vault#146: the commit gate runs only the suites that the staged files can break, read from path literals in tests and scripts. Any file the mapping does not know runs every suite; each skipped suite prints a `SKIP` line. Ten mutations. A commit staging nothing ran 2 of 9 suites in about 5 s. This is suite selection, not a per-test rule; workflow-core already has its own (`scripts/run-vitest.js`, CLAUDE.md §Conventions).

### P11. What this repo already says (read in this repo)

Sources: [docs/research/test-vectorisation.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/test-vectorisation.md) (read in full); [docs/research/suite-file-timings.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/suite-file-timings.md) (read in full); `docs/code-standards-base.md` §X1 to §X7, lines 323 to 375 (read in full); `scripts/lib/run-in-process.js` lines 1 to 140 (header and claim guard); `vitest.config.ts` (read in full); `scripts/run-vitest.js` lines 395 to 430 and a grep for `duration`.

- [docs/research/test-vectorisation.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/test-vectorisation.md) §2: `.each(` is in 61 of 240 mantahostels test files (approximately 25%). "No issue proposes `.each`-ing the biggest repetitive files." The repo's repetition lever is shared harness and fixture extraction (mantahostels#953), not `.each`. §2: `test.concurrent` and `describe.concurrent` have zero live uses; `pick-next.test.ts` forbids them because of shared global-mutating state.
- [docs/research/suite-file-timings.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/suite-file-timings.md): median file 0.80 s; top 5 files 25.9% of file-seconds in run 1, 37.2% in run 2. Run 2 was 3.7 times slower (1,069.8 s against 292.3 s). "Contention concentrates the distribution rather than scaling it: the heavy files are the spawn-bound ones." The document withdrew every percentile share as a property of the suite (mantahostels#2039). Lesson for candidate (a): a stated wall time is valid only with its machine state; a share or a rank is not stable across load.
- `docs/code-standards-base.md` §X2 (hard): "Isolation comes from a real seam, not from mocking." `vi.mock` is the breach. Spies only to capture output, to watch a real call, or to force a failure no real seam reaches, with the reason at the site.
- §X3 (hard): a program test runs the real program end to end against a throwaway directory. House clause, Node programs only: run through `run-in-process.js`, not a subprocess (mantahostels#1951). "Three shapes keep a spawn": a timeout or a signal, two processes at once, a real fd. An async entry point uses `runInProcessAsync`. Stack clause: a `beforeEach` mints a temp directory with `mkdtempSync` and `afterEach` removes it. Note: this stack clause prescribes a fresh per-test fixture; a once-per-file build (candidate b) must be stated against it, for example as "build once, copy fresh for each test" (P4), which keeps the per-test fresh directory.
- §X3 does NOT keep "one real-boundary test" for a converted program. The ticket rule at mantahostels#3535 did. The shebang is the one boundary item no test then covers (mantahostels#1951 ruling). Gap for candidate (c).
- `run-in-process.js` header: seven things "a spawn gave free and this does not": clean module registry (purged for each call), clean process (no concurrency; re-entrancy throw), uncatchable exit (a `finally` still runs), listeners (removed after), closed stdin, timer-free exit (a leaked timer or handle stays in the worker), real fd for a grandchild. This list is the efficacy-hazard checklist for candidate (c).
- `vitest.config.ts`: `testTimeout` and `hookTimeout` are 90 s (from `scripts/lib/test-ceiling.js`; mantahostels#2255). `pool: "forks"`, `maxWorkers: 3`. The comment says mantahostels#2217 re-ran 2 against 3 workers after the spawn sweep: 3 workers approximately 26% faster (414.1 s to 308.0 s), CPU 169.5% to 229%, "still spawn-bound". So mantahostels#2022's rejection of 3 workers was reversed after spawns were removed. No `slowTestThreshold` is set; reporters are `default` plus two house reporters.
- `scripts/run-vitest.js:413` records only `durationMs` for the whole run (in the stall record). Nothing records a per-file duration in this repo's runner today (grep for `duration` found only whole-run sites).

## Part 2: Published guidance

### G1. xUnit Test Patterns (Gerard Meszaros): Slow Tests, Shared Fixture, Erratic Test

Sources (downloaded over plain HTTP; HTTPS refused the connection): http://xunitpatterns.com/Slow%20Tests.html ; http://xunitpatterns.com/Shared%20Fixture.html ; http://xunitpatterns.com/Erratic%20Test.html .

- Slow Tests, Impact: "A common reaction to Slow Tests is to immediately go for a Shared Fixture but this almost always results in other problems including Erratic Tests. A better solution is to use a Fake Object to replace slow components ... However, if all else fails and we must use some kind of Shared Fixture, we should try making it immutable if at all possible."
- Slow Tests, Trouble-Shooting: build a "mini profiler": write the duration of each test to a log, "sort by duration and voila, we have found the culprits."
- Cause "Slow Component Usage": the most common cause is a database; a fake can make tests run "on average fifty times faster". In this repo the slow component is process start (P3).
- Cause "General Fixture": "Tests are consistently slow because each test builds the same fixture." Solution: a Shared Fixture "unless we can make this Shared Fixture immutable, ... is likely to lead to Erratic Tests and so should be avoided. A better solution is to reduce the amount of fixture being set up by each test."
- Cause "Asynchronous Test": explicit delays. "The best way to address this is to avoid the asynchronicity in tests by testing the logic synchronously", by Extract Testable Component / Humble Object.
- Cause "Too Many Tests": "We don't have to run all the tests all the time! The key is to ensure that all the tests get run regularly." (Subset Suite.)
- Shared Fixture, When To Use It: "The biggest issue with a Shared Fixture is that it can lead to 'collisions' between tests possibly resulting in Erratic Tests since tests may depend on the outcomes of other tests." It also tends to give an Obscure Test and a Fragile Fixture.
- Immutable Shared Fixture: partition the fixture. The part that "every test needs to have present but which is never modified by any tests" is shared; "the objects which any test needs to modify or delete ... should be built by each test as a Fresh Fixture." Rule: "if any test perceives something done by another test as a change to an object in the Immutable Shared Fixture, then it shouldn't be allowed."
- Erratic Test, Interacting Tests root cause: "Anything that outlives the lifetime of the test can lead to interactions; static variables ... Singletons and Registries are good examples of things to avoid ... If we must use them, it is best to include a mechanism to reinitialize their variables at the beginning of each test."
- Erratic Test, fix: "Using a Fresh Fixture is the preferred solution for Interacting Tests." Detection: "run the tests in a different order from normal. Running the entire test suite in reverse order would do the trick nicely."
- Other named causes that match precedents: Lonely Test (a test that passes only in the suite, because it depends on a shared fixture another test made); Resource Leakage (#154, the leaked listener in #1907); Test Run War (several people run tests on one shared resource: mantahostels#3168, #65); Nondeterministic Test.

### G2. Fixture scope: pytest, vitest, jest

- pytest fixture scopes. Source: https://docs.pytest.org/en/stable/how-to/fixtures.html (fetched 16 Oct 2026). Scopes: `function` (default; "the fixture is destroyed at the end of the test"), `class`, `module`, `package`, `session`. "Fixtures are created when first requested by a test." For the expensive `smtp_connection` fixture, `scope="module"` makes it "only be invoked once per test module", and the tests "each receive the same `smtp_connection` fixture instance, thus saving time." Per-test fixtures make sure "each test gets its own fresh batch of data and is starting from a clean state."
- pytest, "Running multiple assert statements safely" (same page): move to a larger scope, make the state-changing act step an autouse fixture at that scope, then the tests make read-only checks "without risking stepping on the toes of the other tests". This is the published form of candidate (d) and of a once-per-file parse (b): one act, many read-only assertions. Hazard: valid only while every test that shares it is read-only.
- pytest, "Safe teardowns" (same page): "if any of those steps in the setup raise an exception, none of the teardown code will run." Advice: one state-changing action for each fixture, each with its own teardown. Compare mantahostels#2178 (`freshCopy` leaked a temp directory on a throwing `instantiate()`) and mantahostels#1150 review (a failed world build left snapshots).
- Vitest hooks. Source: https://vitest.dev/api/hooks (fetched 16 Oct 2026). `beforeEach`: "Register a callback to be called before each of the tests in the current suite runs." `beforeAll`: "Register a callback to be called once before starting to run all tests in the current suite." Each can return a cleanup function. The page says nothing about shared state; the hazard is left to the author.
- Jest `resetModules`. Source: https://jestjs.io/docs/configuration (fetched 16 Oct 2026): "By default, each test file gets its own independent module registry. Enabling `resetModules` goes a step further and resets the module registry before running each individual test ... so that the local module state doesn't conflict between tests." This is the same isolation the in-process seam rebuilds with its per-call purge (P3a).

### G3. Test size budgets: Google and Bazel

- Google Testing Blog, "Test Sizes", Simon Stewart, 13 Dec 2010. Source: https://testing.googleblog.com/2010/12/test-sizes.html (downloaded 16 Oct 2026). Table:

  | Feature | Small | Medium | Large |
  |---|---|---|---|
  | Time limit (seconds) | 60 | 300 | 900+ |

  Also: "a requirement that tests can be run in any order (they frequently are!) which in turn means that tests need high isolation --- you can't rely on some other test leaving data behind."
- Software Engineering at Google, chapter 11 "Testing Overview". Source: https://abseil.io/resources/swe-book/html/ch11.html (fetched 16 Oct 2026). Small tests "must run in a single process", often a single thread, and "aren't allowed to sleep, perform I/O operations". Medium tests "can span multiple processes, use threads, and can make blocking calls" but only to localhost. "The most important qualities we want from our test suite are speed and determinism." The restrictions exist "to ensure that small tests don't have access to the main sources of test slowness or nondeterminism." Also: "at Google, we prefer to keep the real dependencies in place when it is feasible to do so" and "Some of the worst offenders of brittle tests come from the misuse of mock objects."
- Bazel Test Encyclopedia. Source: https://bazel.build/reference/test-encyclopedia (fetched 16 Oct 2026). Size to timeout: small = short = 60 s; medium = moderate = 300 s; large = long = 900 s; enormous = eternal = 3600 s. Default size is medium. "A test is not penalized for an overgenerous timeout, although a warning may be issued"; "you should generally set your timeout as tight as you can without incurring any flakiness"; `--test_verbose_timeout_warnings` shows tests "whose specified size is too big".
- Mapping to this repo: a test that spawns a process or writes a temp git repo is a Google "medium" test by the table (file system, multiple processes). The in-process seam does not make it "small": it still does file I/O. The Google limits are per test target (a whole test binary), far above any precedent figure here, so they are a ceiling for a hang, not a cost budget. Compare mantahostels#2255: the 90 s per-test ceiling is a hang guard.

### G4. Slow-test reporting in the runners

- Vitest `slowTestThreshold`. Source: https://vitest.dev/config/slowtestthreshold (fetched 16 Oct 2026): "The number of milliseconds after which a test or suite is considered slow and reported as such in the results." Type number, default `300`, CLI `--slow-test-threshold=<number>`. This repo's `vitest.config.ts` does not set it, so the default 300 ms applies to the `default` reporter.
- Jest `slowTestThreshold`. Source: https://jestjs.io/docs/configuration (fetched 16 Oct 2026): default `5`, "The number of seconds after which a test is considered as slow and reported as such in the results."
- pytest `--durations`. Source: https://docs.pytest.org/en/stable/how-to/usage.html (fetched 16 Oct 2026): "To get a list of the slowest 10 test durations over 1.0s long: `pytest --durations=10 --durations-min=1.0`". "By default, pytest will not show test durations that are too small (<0.005s) unless `-vv` is passed."
- Note: the three runners report; none of them refuses a slow test by default. That matches the lean in #1771 (report, not refuse) and the ruling at mantahostels#2255 (a time ceiling must not depend on machine load).

### G5. Test doubles, the real boundary, and process spawn cost

- Software Engineering at Google, chapter 13 "Test Doubles". Source: https://abseil.io/resources/swe-book/html/ch13.html (fetched 16 Oct 2026; read through a summarising fetch, so quotes are short). "Prefer Realism Over Isolation": "We prefer realistic tests because they give more confidence that the system under test is working properly." Fidelity: "how closely the behavior of a test double resembles the behavior of the real implementation." A double is useful "when the real implementation is slow"; for a borderline case, start with the real implementation and change to a double only when it becomes too slow. A fake needs its own tests (contract tests that run the same tests against the real implementation and the fake).
- Martin Fowler, "ContractTest" (bliki). Source: https://martinfowler.com/bliki/ContractTest.html (fetched 16 Oct 2026). A double stops tests being slow and unreliable, but raises the question "whether the double is indeed an accurate representation of the external service." A contract test checks that the calls the doubles make "return the same results as a call to the external service would." It can run on a slower rhythm: "just once a day is plenty."
- Mapping to this repo: the in-process seam is not a mock of the script (the real script runs), so it has high fidelity. Its fidelity gap is the process boundary: the seven items in the `run-in-process.js` header, plus the shebang (mantahostels#1951). The "one real-boundary test" of mantahostels#3535 is the contract test for the seam: one spawned case per program checks that the real process gives what the in-process cases assume. §X2 of this repo already bans `vi.mock`, so the mock hazard is mostly closed here; the residual hazard is a seeded or synthetic fixture (P2: 259 seeded records let a weak assertion pass).
- Node.js `child_process.fork()`. Source: https://nodejs.org/api/child_process.html (fetched 16 Oct 2026): "Each process has its own memory, with their own V8 instances. Because of the additional resource allocations required, spawning a large number of child Node.js processes is not recommended."
- Vitest, "Improving Performance". Source: https://vitest.dev/guide/improving-performance (fetched 16 Oct 2026). "By default Vitest runs every test file in an isolated environment based on the pool." With `isolate: false`, "files in the same worker share the environment and module state," so "tests must not depend on a clean `window` or module state". First section: "Profile First". Of the `tests` phase: "A run dominated by this phase has little to gain from configuration changes."
- Vitest, "Profiling Test Performance". Source: https://vitest.dev/guide/profiling-test-performance (fetched 16 Oct 2026). The `Duration` line splits into transform, setup, import, tests and environment. "The reporter output shows timings per file and per test." Relevance to candidate (a): the file wall time includes `beforeAll` and import time, which no per-test duration shows (#1150 found this).

### G6. Parametrised tests

- Vitest `test.each`. Source: https://vitest.dev/api/ (fetched 16 Oct 2026): "Use `test.each` when you need to run the same test with different variables."
- pytest `parametrize`. Source: https://docs.pytest.org/en/stable/how-to/parametrize.html (fetched 16 Oct 2026): the decorator "defines three different (test_input,expected) tuples so that the test_eval function will run three times using them in turn."
- Finding: both runners make one test for each parameter set, and each runs its own per-test setup. Thus parametrisation removes duplicated test code; it does not by itself remove run time. The speed gain in candidate (d) comes from computing a shared, expensive input one time (design-vault#349: one index, one window pass over each file), not from `.each`. pytest's "act once in a wider-scope fixture, then many read-only assertions" (G2) is the published form of that gain.
- No source fetched publishes a speed rule for "vectorising" a per-case loop. The evidence for (d) is precedent (design-vault#349) plus the general "General Fixture" smell (G1).

## Synthesis: which practices cost efficacy

Each speed practice in the precedents caused at least one efficacy fault. No green run of the change itself found any of them: review, mutation or a later red run did. Faults by class:

| Practice | Efficacy fault seen | Where | Found by |
|---|---|---|---|
| Index or cache a search | cache key omitted an input (stale result) | design-vault#349 | mutation plus a new test |
| Index or cache a search | one edge changed (empty question now skipped) | design-vault#349 | contract review |
| Build once, copy | absolute paths leak a commit into the template | mantahostels#2016 | design, then mutation |
| Build once, copy | a fifth kind of path carrier missed by a hard-coded list | mantahostels#2048 (as quoted in mantahostels#2023) | spec work |
| Build once, copy | isolation test that cannot fail | mantahostels#2178 | code review |
| Build once, copy | shared base deleted under parallel workers | mantahostels#3168 | intermittent red |
| Fixture moved (cost or CI reasons) | three cases green for the wrong reason | mantahostels#3158 | reading, then mutation |
| In-process seam | non-zero exit no longer fails the test | mantahostels#1945 (two times) | code review, mutation |
| In-process seam | grandchild writes past the captured stream | mantahostels#1945 | a real red test |
| In-process seam | 1 ms budget assertion lost its 80 ms of start latency | mantahostels#2035 | a later red on a quiet machine |
| In-process seam | one timeout cascades to 189 failures (global claim) | lucmoseley/mantahostels#2239, mantahostels#2254 | full-suite red |
| In-process seam | listeners leaked onto the worker | mantahostels#1907 | code review |
| In-process seam | shebang no longer tested by anything | mantahostels#1951 | stated loss, accepted by ruling |
| Seed state, keep one real call | `toBeLessThanOrEqual` could pass vacuously | mantahostels#3535 | code review |
| Predicate seam in place of the clock | wall-clock arm reached by no test | mantahostels#2035 | mutation (declined) |
| Hooks off, worlds restored | none found; guarded by an equivalence case | #1150 | design |

No precedent kept a speed change that reduced what the tests catch, except where a ruling accepted a named residual (the shebang at mantahostels#1951; the wall-clock arm at mantahostels#2035; the memoised base regrowth at mantahostels#3168).

## Candidate asks for a new test

Each candidate below gives its evidence, the measured speed gain, the efficacy hazard, and how to guard against that hazard. "Supported" means precedent and published guidance both agree.

### (a) State the file's wall time. Supported, with conditions.

- Evidence: design-vault#349 (before and after on one machine at a stated load), mantahostels#3535 (local and CI tables), mantahostels#2016, #1150. Published: xUnit Test Patterns, Slow Tests, Trouble-Shooting ("sort by duration ... found the culprits"); Vitest reports timings for each file and test (G5); Vitest `slowTestThreshold` default 300 ms, Jest 5 s, pytest `--durations` (G4).
- Speed gain: none by itself. It is the measurement that the other asks need.
- Hazard: not efficacy, but a false figure. (1) Load moves timings very much: x39.6 median for a spawning test (mantahostels#2255); 3.7 times for a whole run ([docs/research/suite-file-timings.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/suite-file-timings.md)); 25.02 s, 25.88 s and 16.16 s for the same code (mantahostels#1993). (2) Local time is not CI time: a 2.26 times local gain was approximately 7% on CI (mantahostels#313, as quoted in mantahostels#3535). (3) A sum of test durations hides `beforeAll` and import time (#1150; Vitest Duration phases, G5). (4) A per-file gain can leave the suite wall time and the bill unchanged (mantahostels#3535: 594 s both runs).
- Guard: state the isolated file wall time (not the sum of test durations) with the machine state beside it (1-minute load average and `free -m` available). Where a speed claim is made, give a pair at the same load, or a load-independent count beside it: spawns per test (mantahostels#2016: "the durable, load-independent result is the spawn count"). Report, do not refuse (mantahostels#2255 ruling: a verdict must not be a function of the machine).

### (b) Build an expensive fixture, index or parse one time for each file, not for each test. Supported, as "build once, give each test a fresh copy or a read-only view".

- Evidence: design-vault#349 (722 to 759 s down to 8.1 to 8.8 s, approximately 90 times); mantahostels#2016 (13 git spawns per test to 0; 59.80 s to 33.00 s and 49.42 s, load-noisy); mantahostels#1907 (90 ms per-test fixture to 16 ms copy; `check-doc-map.test.ts` 29.5 s to 17.7 s); #1150 (resume groups 28 to 43% less). Published: xUnit Test Patterns Immutable Shared Fixture plus Fresh Fixture (G1); pytest `scope="module"` for an expensive fixture, and act-once then read-only assertions (G2).
- Hazards: (1) a shared mutable fixture gives Interacting Tests and Erratic Tests (xUnit, G1; the book says the first reach for a Shared Fixture "almost always results in other problems"); (2) state leaks through the copy (absolute paths, mantahostels#2016; a fifth carrier, mantahostels#2048); (3) an isolation test that cannot fail (mantahostels#2178); (4) a cache key that omits an input (design-vault#349); (5) parallel workers that share a base directory (mantahostels#3168); (6) a cache of one large entry for each mutated copy uses gigabytes (design-vault#349 deviation); (7) teardown skipped when the build throws (mantahostels#2178; pytest "Safe teardowns"); (8) restore at a fixed path is safe only while the file runs its cases one at a time (#1150).
- Guard: share only what no test changes; give each test that writes a fresh copy from the template. Key a cache on every input, and add a test that changes each input after the cache is warm. Prove the isolation by mutation: break the relink or the copy, and an isolation test must go red (mantahostels#2016 did; mantahostels#2178 found one that did not). Keep each worker's base private. Register teardown before the expensive step can throw. Note: the stack clause of §X3 prescribes a `beforeEach` that mints a temp directory; "build once in `beforeAll`, copy fresh in `beforeEach`" keeps that clause.

### (c) Prefer the in-process seam to a spawned process, and keep one real-boundary test. Supported. The "one real-boundary test" part is not yet in §X3.

- Evidence: mantahostels#1907 (five files 264.0 s to 71.5 s; 8 times on a hook guard, 2.5 times on a checker); mantahostels#1945 and mantahostels#1993 (for example 26.7 s to 5.3 s; 7.49 s to 1.00 s; 5.16 s to 1.24 s inner time); mantahostels#2255 (loaded x39.6 on spawning tests). mantahostels#3535 and mantahostels#1945 kept a spawn where the boundary is the guarantee. Published: Node `fork()` docs (each child has its own V8; many spawns "not recommended"); SWE at Google ch11 (small tests stay in one process for speed and determinism) and ch13 (prefer realism; fidelity; test the fake); Fowler ContractTest (a double can drift; check it against the real thing).
- Where it buys nothing: a `bash` guard (5 ms per start against 115 ms for `node`, mantahostels#1907); a file whose cost is git fixtures or spawns inside the subject (mantahostels#2023 benchmark: 2,288 git spawns inside the guard under test).
- Hazards: the seven items in the `run-in-process.js` header (registry, process globals, uncatchable exit, listeners, stdin, timers, a grandchild's real fd); a lost exit-code check (mantahostels#1945); removed latency that a timing assertion relied on (mantahostels#2035); one timeout that cascades through a global claim (lucmoseley/mantahostels#2239); the shebang (mantahostels#1951).
- Guard: assert the exit status on every in-process call (do not rely on a thrown error). Before you convert, grep for `budget`, `timeout`, `deadline`, `elapsed`, `Date.now` and small millisecond literals, and give such a branch a deterministic seam first (mantahostels#2023 pre-conversion check). Keep one spawned case for each program as its contract test, which covers the shebang, argv and exit code across a real process boundary. Mutation-test one converted assertion for each file (mantahostels#1993 "How to work it").

### (d) Change a per-case loop over a shared input into one pass, where the result is identical. Supported by one precedent and by general guidance; prove the identity.

- Evidence: design-vault#349 only (each test searched the whole tree again; one index and one window pass took the file from 722 s to 8.1 s). Published support is indirect: xUnit "General Fixture" (each test builds the same expensive thing) and pytest "act once in a wider scope, then read-only assertions" (G1, G2). No fetched source names "vectorising" a test loop.
- Not this: `test.each` or `parametrize`. Each row is still one test with its own setup (G6). This repo already uses `.each` in approximately 25% of mantahostels files with no speed claim ([docs/research/test-vectorisation.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/test-vectorisation.md) §2).
- Hazards: the new pass is not identical in an edge case (design-vault#349: an empty question now skipped; "first matching window" now pinned by a new test); a cache key that omits an input; the identity check samples only part of the input (8 of 106 questions).
- Guard: a differential test. Run the old and new code on the real input and on planted variants, and compare the output byte for byte before you delete the old code (design-vault#349: 26 trees). Mutation-test the new pass. Add tests for any behaviour the old code had that no test pinned. State the sample in a Bound line.

### Other candidates that the evidence supports

- (e) Do not make a time guarantee pass by the cost of the runtime. Assert a budget, timeout or deadline through a deterministic seam (an injected clock or a count), not through wall time; do not shorten a shipped timeout that is itself the guarantee. Evidence: mantahostels#2035 (a 1 ms budget passed only because of process start); mantahostels#3535 (dispatch-sessions kept the real wedge as its one boundary case); design-vault#148 and design-vault#351 (find the mechanism; make the fixture deterministic against delay, not longer); xUnit "Asynchronous Test" (test the logic synchronously). Gain: dispatch-sessions 137 s to 101 s local. Hazard: the real clock arm becomes untested (mantahostels#2035); guard: let the seam cap the clock, not replace it, and say the residual at the site.
- (f) Reach a state by seeding it directly, not by many real calls, and keep one real call. Evidence: mantahostels#3535 (`guard-echo-call`: 260 spawns to 259 seeded records and one real `call()`; 39.58 s to 9.62 s local, 70.6 s to 20.9 s CI). Hazard: a seed in the wrong format can be dropped silently and a loose assertion still passes; guard: pin the exact count and check that the survivor is not a seed (review fix ff31955d7).
- (g) Prove the test still catches its fault after any speed change: one mutation for each changed assertion, reversed after. Evidence: every precedent above did this, and mutation found faults that green runs did not (design-vault#349 cache key; mantahostels#2178; mantahostels#3158). Gain: none; this is the efficacy guard for (b) to (f).
- (h) When a test removes a real dependency for speed (hooks, a service), add one equivalence case that proves the result is the same with and without it, and keep one case on the real dependency. Evidence: #1150 ("If they differ, step 1 does not ship").

### Candidates the evidence does NOT support

- A hard per-test time limit that refuses a slow test. Load multiplies a spawning test by up to x386.2 (mantahostels#2255); the founder ruled that a verdict must not depend on the machine, and a fixed 90 s ceiling is a hang guard only. Google's 60 / 300 / 900 s and Bazel's limits are hang ceilings for each target, not cost budgets (G3). Reporting is supported (G4); refusing is not.
- A shared mutable fixture (state that tests change) for speed. xUnit says it "almost always" brings Erratic Tests (G1); mantahostels#3535 declined one shared killed run for five tests as "race-prone".
- More workers, `test.concurrent` or `isolate: false` as a per-test ask. mantahostels#2022 rejected a third worker on a spawn-bound suite (later reversed at mantahostels#2217 only after spawns were removed); the seam forbids concurrency in a file; Vitest says `isolate: false` shares module state (G5).
- `test.each` or `parametrize` as a speed lever (G6; [docs/research/test-vectorisation.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/test-vectorisation.md)).
- Splitting the suite so that slow tests run less often. The founder declined it at mantahostels#3541: "every sweep keeps the whole suite" (as quoted in mantahostels#3493).
- Widening a tolerance or a budget until a flaky timing test passes. mantahostels#2035 called it "the worse trade"; design-vault#148 showed the cause was not load.
- `retry` on a timeout (declined at mantahostels#2255: the retry runs under the same contention and pays two times).

## Bound

- Read in full (body and every comment): design-vault#349; mantahostels#3535, mantahostels#1907, mantahostels#1945, mantahostels#1951, mantahostels#1993, mantahostels#2016, mantahostels#2023, mantahostels#2022, mantahostels#2035, lucmoseley/mantahostels#2239, mantahostels#2178, mantahostels#3158, mantahostels#3168.
- Read in part (body and last one or two comments): mantahostels#2255, mantahostels#2262, mantahostels#3493; #1150, #65, #154, #1480; design-vault#148, design-vault#351, design-vault#146 (each cut at 1,800 characters).
- Not read, quoted only from other issues: mantahostels#313, mantahostels#2048, mantahostels#2068, mantahostels#2070, mantahostels#2114, mantahostels#2217, mantahostels#2254, mantahostels#3541. The body of #1792 did not print; the question came from the dispatch prompt and map mantahostels#1771 (read in full).
- Closed-issue search: 11 terms in each of three repos (`gh search issues --state closed`). Four design-vault queries hit the API rate limit and returned nothing: "durations", "parametrize", "slowTestThreshold", "vectoris". Titles were screened; about 25 relevant issues were opened, not all 300-odd hits.
- Repo files read in full: [docs/research/test-vectorisation.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/test-vectorisation.md), [docs/research/suite-file-timings.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/suite-file-timings.md), `docs/code-standards-base.md` §X (lines 323 to 375), `vitest.config.ts`. Read in part: `scripts/lib/run-in-process.js` lines 1 to 140 of 802; `scripts/run-vitest.js` lines 395 to 430 and a grep. Not read: the `tdd` and `codebase-design` skills.
- Web sources: xUnit Test Patterns pages downloaded over HTTP (the site says the printed book can differ); Google Testing Blog post downloaded and its table read in full; SWE at Google ch11 and ch13, the Vitest, Jest, pytest, Bazel and Node pages read through a summarising fetch, so their quotes are short and a page longer than 100,000 characters (Jest configuration, Node child_process) was read only in part.
- No figure in this note was measured again by this session; each comes from the issue or page named beside it.
