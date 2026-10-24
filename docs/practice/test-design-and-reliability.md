# test-design-and-reliability

Researched: 2026-10-21

## Flaky tests: root causes

- Luo et al. studied 161 commits that fix flaky tests in 51 Apache projects. The top three causes are Async Wait (74 of 161, 45%), Concurrency (32, 20%) and Test Order Dependency (19, 12%). 78% of flaky tests are flaky when they are first written; 96% do not depend on the platform but can depend on the environment (file system, event order, time). Luo, Hariri, Eloussi, Marinov, "An Empirical Analysis of Flaky Tests", FSE 2014, §Table 1 (mir.cs.illinois.edu/lamyaa/publications/fse14.pdf) [standard or field body]
- Fowler gives five causes: lack of isolation, asynchronous behaviour, remote services, time, and resource leaks. martinfowler.com/articles/nonDeterminism.html [named expert]
- Google (Micco, 2016): about 1.5% of all test runs give a flaky result, and "Almost 16% of our tests have some level of flakiness". The causes include "concurrency, relying on non-deterministic or undefined behaviors, flaky third party code, infrastructure problems". About 84% of pass-to-fail changes in post-submit CI "involve a flaky test". testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html [named expert]
- Google (Listfield, 2017): "the larger the test (as measured by binary size, RAM use, or number of libraries built), the more likely it is to be flaky". Thus keep tests small, and make the large ones few. testing.googleblog.com/2017/04/where-do-our-flaky-tests-come-from.html [named expert]
- pytest: "a flaky test indicates that the test relies on some system state that is not being appropriately controlled". A test that fails only under `pytest-xdist` can show a dependency on test order. docs.pytest.org/en/stable/explanation/flaky.html [standard or field body]

## Flaky tests: fix, quarantine or re-run

- Fix the cause; do not delete the test. In Luo et al., 24% of fixes changed the code under test, and 94% of those fixed a real bug: "Flaky tests should not simply be removed or disabled because they can help uncover bugs". 74% of Test Order Dependency fixes clean the shared state between tests. Luo et al. FSE 2014, F.10, F.12 [standard or field body]
- Quarantine is a short holding area with a limit, not a home. Fowler: "Place any non-deterministic test in a quarantined area", fix it fast, and limit the area (for example "only allow 8 tests in quarantine", or a stay of "no longer than a week"). martinfowler.com/articles/nonDeterminism.html [named expert]
- Google quarantines a test automatically when its flakiness is too high. The quarantine "files a bug for developers", but "could easily mask a real race condition". testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html [named expert]
- Re-runs reduce noise but hide bugs. Google lets a marked test fail only after "3 times in a row", and says this "encourages developers to ignore flakiness ... which is hardly a perfect solution". Its re-run "is only used for tests that are marked as flaky or when users specifically request it" (blog team reply in the comments). Same post [named expert]
- pytest: re-run plugins (`pytest-rerunfailures`, `pytest-replay`, `pytest-flakefinder`) "can mitigate the negative effects"; `xfail(strict=False)` is "like a manual quarantine, and is rather dangerous to use permanently". Random-order plugins (`pytest-randomly`, `pytest-random-order`) expose tests with state problems. docs.pytest.org/en/stable/explanation/flaky.html [standard or field body]

## Time: clocks, fake timers and bounds

- Inject the clock. Do not read wall time in the code under test. Java SE: "Best practice for applications is to pass a `Clock` into any method that requires the current instant", so that a test can use a `fixed` or `offset` clock. docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/Clock.html, a vendor's reasoned guidance [named expert]
- Fowler: "Always wrap the system clock, so it can be easily substituted for testing." martinfowler.com/articles/nonDeterminism.html [named expert]
- Go: a fixed real-time wait is "slow" and "flaky", because "it isn't unusual to see pauses lasting several seconds on shared and overloaded CI systems". `testing/synctest` gives a fake clock that advances only when all goroutines in the bubble are blocked. go.dev/blog/synctest [standard or field body]
- Google SWE book: small tests "aren't allowed to sleep, perform I/O operations". abseil.io/resources/swe-book/html/ch11.html [named expert]

## Time: fake timers in Vitest and Jest

- Vitest `vi.useFakeTimers()` fakes `setTimeout`, `setInterval`, `setImmediate`, their clear functions and `Date`. It "does not automatically mock `process.nextTick` and `queueMicrotask`"; add them with `toFake`. "Mocking `nextTick` is not supported when running Vitest inside `node:child_process` by using `--pool=forks`." vitest.dev/api/vi §vi.useFakeTimers [standard or field body]
- Vitest `vi.setSystemTime` with fake timers changes `Date`, `hrtime` and `performance.now`, "however, it will not fire any timers". Use `vi.advanceTimersByTimeAsync` when timers are set from async code. vitest.dev/api/vi §vi.setSystemTime, §vi.advanceTimersByTimeAsync [standard or field body]
- Jest: for a timer that sets a new timer in its callback, `runAllTimers` loops and aborts ("Aborting after running 100000 timers"); use `jest.runOnlyPendingTimers()`. `doNotFake` keeps one API real. jestjs.io/docs/timer-mocks [standard or field body]
- Fake timers fake only the test's own process. A child process keeps its real clock. Thus a test that spawns a process cannot use fake timers for the child; give the child a time seam (an argument or an environment variable), or wait on an event. Derived from the Vitest and Node child_process rows [unverified]

## Time: a test that must cross a real process kill

- Wait on the event, not on a fixed time. Fowler: "Never use bare sleeps to wait for asynchonous responses: use a callback or polling", with a generous overall limit and a clear timeout error. martinfowler.com/articles/nonDeterminism.html [named expert]
- Luo et al.: 57% of Async Wait fixes use `waitFor`, and 55% of those remove the flakiness completely; a fix with `sleep` "only decreas[es] the chance of a flaky failure". Developers set "much higher timeouts" with `waitFor` (mean 13.04 s) than with `sleep` (mean 1.52 s), because a high bound costs nothing when the condition comes early. Luo et al. FSE 2014 §5.1 Async Wait, F.8 [standard or field body]
- Node: `spawn` takes `timeout` and `killSignal` (default `'SIGTERM'`). The signal "may not actually terminate the process". Wait for `'exit'` (status) or `'close'` (status and all stdio closed); one of `code` and `signal` "will always be non-`null`". A signal to an exited child can reach a new process with the same PID. nodejs.org/api/child_process.html §options.timeout, §subprocess.kill, §Event 'exit', §Event 'close' [standard or field body]
- Bazel: the whole-test timeout is a backstop (short 60 s, moderate 300 s, long 900 s, eternal 3600 s). "Set your timeout as tight as you can without incurring any flakiness". The runner "must not report the test as passing after sending a signal to the test process or any children". bazel.build/reference/test-encyclopedia §Role of the test runner [standard or field body]
- Thus, for a test that kills a real process: assert on the `exit` or `close` event and its `signal` value, not on elapsed time; give the event wait a generous ceiling below the runner timeout; and say at the site why a real kill is necessary. Derived from the four rows above [unverified]

## Tests that spawn real processes or scripts

- Make each test hermetic. Google SWE book: "a test should contain all of the information necessary to set up, execute, and tear down its environment" and "should assume as little as possible about the outside environment". A test that spans processes on one machine is a medium test; it can call only localhost. abseil.io/resources/swe-book/html/ch11.html [named expert]
- Bazel gives each test a private `TEST_TMPDIR`, sets `HOME` to it, and says a test "should not depend on the presence, absence, or value of any environment variable not listed". A test "should not leak processes", and must not make process groups or sessions. bazel.build/reference/test-encyclopedia [standard or field body]
- Pass an explicit `env` to the child. Node: `env` defaults to `process.env`, so the child gets all of the parent's variables. If `env` has no `PATH`, Unix lookup uses `/usr/bin:/bin`. With `shell` on, "do not pass unsanitized user input"; prefer `spawn` or `execFile` with an argument array. nodejs.org/api/child_process.html §options.env, §Shell requirements [standard or field body]
- Stub a binary with a fake on `PATH`. pytest: `monkeypatch.setenv("PATH", value, prepend=os.pathsep)`, and "All modifications will be undone after the requesting test function or fixture has finished". docs.pytest.org/en/stable/how-to/monkeypatch.html [standard or field body]
- bats-mock puts a binstub in a directory on `PATH`; `unstub` checks that the planned calls happened. A shell function with the same name hides the stub, and the default stub directory is shared, so set `BATS_MOCK_TMPDIR` for each test. github.com/jasonkarns/bats-mock README [survey or curated list]
- Vitest: `vi.stubEnv` changes `process.env`; `vi.unstubAllEnvs` restores the values. Use it for the parent; give the child its own `env` object. vitest.dev/api/vi §vi.stubEnv [standard or field body]

## CPU load and parallel runners

- Load changes timing, so a test that depends on timing fails under load. Go: "pauses lasting several seconds on shared and overloaded CI systems" are not unusual. go.dev/blog/synctest [standard or field body]
- Luo et al.: 60% of `sleep` fixes made an existing sleep longer, which "shows the effect that machine speed variation can have on flaky tests". Luo et al. FSE 2014 §5.1 [standard or field body]
- Use load to find flaky tests. Shaker adds CPU and memory stress while the tests run. On 11 Android apps it found 95% of the known flaky tests, against 37.5% for plain re-runs, and found them faster. Silva, Teixeira, d'Amorim, "Shake It! Detecting Flaky Tests Caused by Concurrency with Shaker", ICSME 2020 (cin.ufpe.br/~damorim/publications/Silva_ETAL_ICSME20.pdf) [standard or field body]
- Repeat a suspect test many times to reproduce it. Chromium uses `--gtest_repeat=100`, and copies the bot's build arguments to match its environment. chromium.googlesource.com/chromium/src/+/HEAD/docs/testing/gtest_flake_tips.md [named expert]
- Vitest pools: the default is `forks` (child processes). `threads` cannot use `process.chdir()`, and a change to `process.env.TZ` has no effect in a worker thread. Use `forks` when native modules segfault in threads. vitest.dev/config/pool [standard or field body]
- Vitest `maxWorkers` defaults to "all available parallelism" (`os.availableParallelism`), half in watch mode; it takes a number or a percentage. Test files run in parallel; `isolate: false` is safe only when tests "must not depend on a clean `window` or module state". vitest.dev/config/maxworkers; vitest.dev/guide/improving-performance [standard or field body]
- Vitest `testTimeout` is 5000 ms in Node. Under load, a wall-time bound that is close to the real run time fails by chance; Bazel says to set it "as tight as you can without incurring any flakiness". vitest.dev/config/testtimeout; bazel.build/reference/test-encyclopedia [standard or field body]
- Jest: on CI with few cores, `--runInBand` or a lower `--maxWorkers` can make runs faster, "up to 50%". jestjs.io/docs/troubleshooting [standard or field body]
- Find order dependence with a shuffle. Vitest `sequence.shuffle` "may be useful to track tests that accidentally depend on another test run previously"; pin `sequence.seed` to replay one order. pytest gives `pytest-randomly`. vitest.dev/config/sequence; docs.pytest.org/en/stable/explanation/flaky.html [standard or field body]
- pytest-xdist runs each worker in its own process. It "does not have a builtin support for ensuring a session-scoped fixture is executed exactly once"; use a `FileLock` and the `worker_id` fixture to share or split resources. pytest-xdist.readthedocs.io/en/stable/how-to.html [standard or field body]

## Tools

- Runner features first. Vitest: `vi.useFakeTimers`, `vi.setSystemTime`, `vi.stubEnv`, `sequence.shuffle` with `sequence.seed`, the `forks` pool. Jest: `jest.useFakeTimers`, `runOnlyPendingTimers`, `--runInBand`. vitest.dev/api/vi; vitest.dev/config/sequence; jestjs.io/docs/timer-mocks [standard or field body]
- pytest plugins that the pytest docs name: `pytest-rerunfailures`, `pytest-replay`, `pytest-flakefinder` (re-run and reproduce), `pytest-randomly`, `pytest-random-order` (order), `pytest-xdist` (parallel); `monkeypatch` for environment and `PATH`. docs.pytest.org/en/stable/explanation/flaky.html [standard or field body]
- Detection tools from research: DeFlaker (Bell et al., ICSE 2018), named by the pytest docs; Shaker (CPU and memory noise, ICSME 2020). docs.pytest.org flaky page; Silva et al. ICSME 2020 [standard or field body]
- Shell: bats-core with bats-mock for `PATH` stubs. github.com/jasonkarns/bats-mock [survey or curated list]
- Claude-compatible: the Superpowers plugin (Jesse Vincent; MIT; github.com/obra/superpowers) has `test-driven-development` and `systematic-debugging`, with a `condition-based-waiting.md` page: "Wait for the actual condition you care about, not a guess about how long it takes", and "Always document WHY if using arbitrary timeout". Simon Willison vouches for the plugin as a whole, not for this page. simonwillison.net/2025/Oct/10/superpowers/ [named expert]; 302,929 stars on 2026-10-21 (check only)
- Superpowers is a full workflow plugin with always-on skills. Its test advice repeats Fowler and Luo et al. and adds nothing new. Under this repo's rule a plugin needs a proposal ticket; this note does not propose one. The repo already has `tdd` and `diagnosing-bugs` skills. Derived [unverified]
- No MCP server for test work was found that a standard body or a named expert vouches for. Search of 2026-10-21 [unverified]
