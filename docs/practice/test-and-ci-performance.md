# test-and-ci-performance

Researched: 2026-10-22

Tier tags: [standard or field body], [named expert], [survey or curated list], [unverified]. An Agreement row takes the tiers of the rows it names.

## Test impact analysis and regression test selection

### Selection from changed files

- Leaders select tests from a dependency map. The map links each test to the files it uses. A change to a file causes all tests that use that file to run. Google TAP uses the build dependency graph: "The primary mechanism for determining which tests need to be run is an analysis of the downstream dependency graph for every change." https://abseil.io/resources/swe-book/html/ch23.html (Software Engineering at Google, ch. 23, "CI at Google" / TAP). [named expert]
- Microsoft TIA records which files each test reads when it runs (a dynamic map). It is the same model as a read-edge manifest. "we run all Testcasemethod(s) that had a.cs as their dynamic dependency." https://martinfowler.com/articles/rise-test-impact-analysis.html (Paul Hammant, "The Rise of Test Impact Analysis", Microsoft section). [named expert]
- Vitest `--changed` uses the static module graph. The experimental `experimental.recordDependencies` option records the modules each test file loads, and uses that record "instead of the static module graph". A test file with no record always runs. https://vitest.dev/guide/cli (`--changed`, `experimental.recordDependencies`). [standard or field body]
- Nx `affected` finds changed files with Git, then maps them to projects through the project graph: "Determine which projects depend on the projects you modified." https://nx.dev/docs/features/ci-features/affected. [standard or field body]
- Agreement (4 sources): select by a file-to-test dependency map, measured or static. The repo's read-edge manifest is the dynamic form (Microsoft TIA, Vitest recordDependencies).

### Safety rules that all leaders apply

- Always include new tests and tests that failed before. Azure TIA: "It includes existing impacted tests, previously failing tests, and newly added tests." https://learn.microsoft.com/en-us/azure/devops/pipelines/test/test-impact-analysis ("Test Impact Analysis has"), one vendor's product. [unverified] Vitest's no-record rule above and Bazel's `auto` rerun below are adopters too, so this sets no default.
- Fall back to the full suite when the selector cannot reason about a change. Azure TIA: "For commits and scenarios that TIA can't understand, it falls back to running all tests." Same source, one vendor's product. [unverified] The Vitest and Nx rows below are adopters too, so this sets no default.
- Vitest has the same fallback. `forceRerunTriggers` is a glob list that "will run the whole test suite if the trigger is found in the git diff". The default is `['**/package.json', '**/vitest.config.*', '**/vite.config.*']`. Use it for dependencies that the module graph cannot see, for example a test that calls a CLI on a built file. https://vitest.dev/config/forcereruntriggers. [standard or field body]
- Nx marks "all" projects as affected when the lock file changes, "as a failsafe" (default `projectsAffectedByDependencyUpdates: "all"`). https://nx.dev/docs/features/ci-features/affected. [standard or field body]
- Run the full suite at a set interval, to catch what selection misses. Azure TIA: "TIA can be conditioned to run all tests at a configured periodicity. Setting this option is recommended." https://learn.microsoft.com/en-us/azure/devops/pipelines/test/test-impact-analysis ("Manage Test Impact Analysis behavior"), one vendor's product [unverified]. Fowler/Hammant: a nightly full run can be the reference point for all the commits of that day. Source: https://martinfowler.com/articles/rise-test-impact-analysis.html. [named expert]
- Validate the selector: run the selected tests, then all tests, and compare. Azure TIA: "If T1 passes, check that T2 passes as well. If there was a failing test in T1, check that T2 reports the same set of failures." https://learn.microsoft.com/en-us/azure/devops/pipelines/test/test-impact-analysis ("To evaluate whether TIA is selecting the appropriate tests"). Only one vendor's product docs carry this, so it sets no default. [unverified]
- A dynamic map misses inputs that are not code, for example data files or external inputs. The user must name these files. Testar: "the user needs to explicitly specify all these files to Testar". https://martinfowler.com/articles/rise-test-impact-analysis.html (Testar section). [named expert]
- Agreement (Azure TIA, Vitest, Nx, Fowler/Hammant): safe selection needs (a) an always-run set for new and failed tests, (b) a full-suite fallback list for files the map cannot model, and (c) a periodic full run. (a) and (b) rest on adopters alone, so only (c), on Fowler/Hammant, sets a default.

### Hub files that fan out to most tests

- Leaders accept that a change to a hub file selects most tests. The saving goes to near zero for that change. Fowler/Hammant: "if a developer repeatedly changes a method that is used by most tests, the savings will be small." https://martinfowler.com/articles/rise-test-impact-analysis.html (Testar section). [named expert]
- Meta found that dependency-based selection over-selects for low-level libraries. It "could exercise up to a quarter of all tests" for each mobile change, and "it would be inefficient to rerun all tests on every project that uses that library." https://engineering.fb.com/2018/11/21/developer-tools/predictive-test-selection/. [named expert]
- Google: the size of the selected set sets the wait. "The difference in waiting time between a change that triggers 100 tests and one that triggers 1,000 can be tens of minutes". Engineers then make "smaller, targeted changes". https://abseil.io/resources/swe-book/html/ch23.html (TAP). [named expert]
- Google cannot run every test for every change at its scale. TAP "falls back to batching related changes together, which reduces the total number of unique tests to be run", then splits a failing batch to find the culprit. https://abseil.io/resources/swe-book/html/ch23.html (TAP). [named expert]
- Agreement (3 sources): a hub file causes a near-full run. The leaders' remedies are (a) accept it, (b) batch many changes into one run (Google), or (c) a learned selector that runs a subset with a measured miss rate (Meta). No source recommends that a hub file run fewer tests than its dependents without a measured miss rate.

### Safety against precision

- Meta's predictive selection runs about one third of the tests that transitively depend on the change. It still reports "over 95% of individual test failures and over 99.9% of faulty changes", and "reduces the total infrastructure cost of testing code changes by a factor of two." https://arxiv.org/abs/1810.05286 (Machalica et al., abstract). [named expert]
- Google: few tests fail, and those that fail are "closer" to the code they test. https://research.google/pubs/taming-google-scale-continuous-testing/ (Memon et al., abstract). [named expert]
- Fowler/Hammant: where there is enough hardware, "running all tests with a high degree of parallelization is more reliable" than selection. https://martinfowler.com/articles/rise-test-impact-analysis.html. [named expert]
- Agreement: a dependency-based selector is safe (it misses no test that reads the change, if the map is complete). A predictive selector is more precise but misses some failures. Use predictive selection only with a later full run that catches misses (Meta, Google post-submit).

## Shared test-execution capacity

### Cache test results by a hash of their inputs

- Bazel caches a test result and does not run the test again when the test and its dependencies did not change. With `--cache_test_results=auto` (the default), Bazel runs a test again only if the test or its dependencies changed, the last run failed, or more runs are asked for. "If 'no', all tests will be executed unconditionally." https://bazel.build/docs/user-manual (`--cache_test_results`). [standard or field body]
- Gradle makes a cache key from the inputs of a task. "Gradle can compute a build cache key that uniquely defines the task's outputs based on its inputs." The `Test` task is cacheable. A shared cache "even works across developer machines and build agents." Caution: "Missing task inputs can cause incorrect cache hits." https://docs.gradle.org/current/userguide/build_cache.html. [standard or field body]
- Turborepo hashes the inputs of a task into a "fingerprint". On a hit, it replays the logs of the first run. "Turborepo assumes that your tasks are deterministic." https://turborepo.dev/docs/crafting-your-repository/caching. [standard or field body]
- Bazel turns off test caching for tests with an external dependency: tag `external` means "test has an external dependency; disable test caching." https://bazel.build/reference/test-encyclopedia (tag conventions). [standard or field body]
- Agreement (Bazel, Gradle, Turborepo): key a cached test result on a hash of all its inputs (test file, files it reads, config, tool version, relevant env). Do not cache a failed result by default (Bazel `auto`). Do not cache a test that reads inputs outside the hash. For this repo, a read-edge manifest gives the input set. A hash of those files plus config can be the key. Three adopters alone, so this sets no default.

### Deduplicate identical runs that are in flight

- A result cache does not help two identical runs that start at the same time. BuildBuddy: "neither the local nor remote Bazel caches provide a mechanism for sharing the results of pending executions." BuildBuddy makes later identical requests wait on the first execution ("action merging"). https://www.buildbuddy.io/blog/action-merging. [named expert]
- Risks of in-flight merging (same source): if the first execution hangs, "all subsequent invocations of that action will be stuck"; merging "can amplify the negative impacts of flaky tests"; and the first run continues when no one waits for it. [named expert]
- Canva (BazelCon 2024 lightning talk) reported that its slowest action ran again without need 66% of the time before deduplication, and deduplication cut compute for builds and tests by 25%. https://bazelcon2024.sched.com/list/descriptions/type/Lightning+Talks (only seen through a search summary; not read in full). [unverified]
- GitHub Actions concurrency groups replace a waiting run with a newer one: "there can be at most one running job or workflow in a concurrency group at any time" and "any existing pending job or workflow in the same concurrency group will be canceled". `cancel-in-progress: true` also stops the running one. https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency. One vendor's product, cited as an adopter. [unverified]
- Agreement (BuildBuddy, GitHub Actions, Uber SubmitQueue cancellation below): do not run the same work two times. Either join a waiting caller to the identical run in flight (with a timeout, because a hung run blocks all joined callers), or let a newer request replace an older one that waits for the same thing.

### Queue order, priority and fairness

- Buildkite orders jobs by priority, then by the time they were scheduled (oldest first). "Job priority is 0 by default". Priority "does not reserve an agent for dependent jobs." https://buildkite.com/docs/pipelines/configure/workflows/job-priority. One vendor's product, cited as an adopter. [unverified]
- Slurm backfill lets a small or short job start before a larger queued job, but only if this "does not delay the expected start time of any higher priority jobs." Backfill needs time estimates: "reasonably accurate time limits are important for backfill scheduling to work well." Without backfill, a pending job at the head blocks all others in its partition. https://slurm.schedmd.com/sched_config.html (Backfill). [standard or field body]
- Shortest job first gives the minimum total waiting time for a set of jobs (exchange-argument proof). But job size is not known in advance and must be predicted from past runs. https://courses.physics.illinois.edu/cs374/fa2020/lec_prerec/19/19_3_0_0.pdf (UIUC CS374, greedy scheduling); https://courses.cs.washington.edu/courses/cse451/98au/Lectures/6-schedule/tsld006.htm (UW CSE 451). [named expert]
- Uber SubmitQueue ranks builds by the probability that they are needed, and cancels running builds that are no longer in the prioritised set. Result: CI resource use about 53% lower, CPU hours about 44% lower, P95 wait about 37% lower. https://arxiv.org/html/2501.03440v2 ("CI at Scale: Lean, Green, and Fast", Abstract, Sec. III-C, III-D, X). [named expert]
- Agreement (Buildkite, Slurm, scheduling theory): plain FIFO causes head-of-line blocking, where one large run delays many small runs. The leading fix is FIFO with backfill: a small run (predicted from its past duration or its selected test count) can take a free slot if it does not delay the start of the run at the head. Pure shortest-first can starve large runs, so keep an age bound. A predicted duration is necessary for backfill. Backfill rests on Slurm and Buildkite as adopters, so that half sets no default.

## Suite growth control

### Size classes with time limits

- Google classes tests by size: "small tests run in a single process, medium tests run on a single machine, and large tests run wherever they want". Small tests are not allowed to "sleep, perform I/O operations". Medium tests must not make network calls to any system other than localhost. https://abseil.io/resources/swe-book/html/ch11.html (Software Engineering at Google, ch. 11, "Test Size"). [named expert]
- Google gives a mix by test count as "a rough guideline": about 80% unit, 15% integration, 5% end-to-end. Same source ("Test Scope"). [named expert]
- Bazel ties each size to a default timeout and to an assumed peak resource use. small: 20 MB RAM, 1 CPU, short (1 minute); medium: 100 MB, 1 CPU, moderate (5 minutes); large: 300 MB, 1 CPU, long (15 minutes); enormous: 800 MB, 1 CPU, eternal (60 minutes). https://bazel.build/reference/be/common-definitions (attribute `size`, `timeout`). [standard or field body]
- Bazel warns about a test whose size or timeout is too generous: `--test_verbose_timeout_warnings` shows tests that end well under their limit, and the docs suggest a tighter `timeout` or `size`. https://bazel.build/reference/test-encyclopedia (Role of the test runner / timeouts). [standard or field body]
- Agreement (Google SWE book, Bazel common definitions, Bazel test encyclopedia): give each test a declared size class. The class sets a hard timeout and a resource budget. The tool reports tests that are in the wrong class (both too slow and too generous). The timeout, budget and report rest on Bazel alone, so only the size classes set a default.

### Per-test slow thresholds in the tools

- Vitest `slowTestThreshold`: "The number of milliseconds after which a test or suite is considered slow and reported as such in the results." Default 300 ms. https://vitest.dev/config/slowtestthreshold. [standard or field body]
- Jest `slowTestThreshold`: "The number of seconds after which a test is considered as slow". Default 5 s. Jest `testTimeout` default 5000 ms. https://jestjs.io/docs/configuration (`slowTestThreshold`, `testTimeout`). [standard or field body]
- pytest `--durations=N --durations-min=S` lists the N slowest tests over S seconds. https://docs.pytest.org/en/stable/how-to/usage.html (Profiling test execution duration). [standard or field body]
- Agreement (Vitest, Jest, pytest): every major runner has a built-in slow-test report. Use it to measure suite cost per test, and set the threshold in config so that new slow tests show in every run. Three adopters alone, so this sets no default.

### Whole-suite budget

- Fowler: "For most projects, however, the XP guideline of a ten minute build is perfectly within reason." Put slow tests in a later stage of a pipeline, and keep the commit build fast. https://martinfowler.com/articles/continuousIntegration.html ("Keep the Build Fast"). [named expert]
- Google: "The slower a test suite, the less frequently it will be run, and the less benefit it provides." "Set appropriate performance goals and refactor slow or marginal tests." https://abseil.io/resources/swe-book/html/ch11.html. [named expert]
- Google presubmit: "only fast, reliable ones"; presubmit is usually limited "to just those for the project where the change is happening". https://abseil.io/resources/swe-book/html/ch23.html (Presubmit versus post-submit). [named expert]
- Google flakiness budget: "our flaky rate hovers around 0.15%", and "as you approach 1% flakiness, the tests begin to lose value." https://abseil.io/resources/swe-book/html/ch11.html. [named expert]
- Agreement (Fowler, Google ch. 11, Google ch. 23): set a time goal for the fast gate (Fowler gives 10 minutes for the whole commit build), keep only fast and reliable tests in it, and move slow tests to a later or periodic stage. No source gives a numeric per-file budget for a local agent gate; a value for this repo must come from its own measured durations.

## Measuring and alerting on CI wait and queue time

### Which metric

- Measure queue wait per job, from creation to start, as a histogram. GitLab: `job_queue_duration_seconds` "measures the time between job creation and runner assignment". https://runbooks.gitlab.com/ci-orchestration/alerts/CiOrchestrationServiceJobQueueDurationApdexSLOViolation/, one vendor's own runbook [unverified]. The histogram half rests on the Google SRE row below [named expert].
- Buildkite: "The queue wait time measures how long jobs wait before an agent starts processing them." https://buildkite.com/docs/pipelines/insights/clusters. GitHub Actions reports "average run time, average queue time, and job failures" per job. Source: https://docs.github.com/en/actions/concepts/metrics. Each one vendor's product. [unverified]
- Use percentiles of the distribution, not the mean. Google SRE: it is "tempting to design a system based upon the mean"; collect "request counts bucketed by latencies (suitable for rendering a histogram)". https://sre.google/sre-book/monitoring-distributed-systems/ ("Worrying About Your Tail"). [named expert]
- Uber reports P95 waiting time as its headline CI wait metric (P95 wait down about 37%). https://arxiv.org/html/2501.03440v2 (Sec. X-C). [named expert]
- Agreement (GitLab, Google SRE, Uber; Buildkite and GitHub for the per-job definition): the leading metric is per-run queue wait (enqueue to start), read as a tail percentile (p95) over a window. The mean (GitHub's default view) and a summed wait are weaker: no source uses summed wait as an alert signal. Also watch saturation (Google's fourth golden signal: "How 'full' your service is") as the queue length or slot use, because "many systems degrade in performance before they achieve 100% utilization". https://sre.google/sre-book/monitoring-distributed-systems/. [named expert]

### Which thresholds

- GitLab hosted runners: normal state is "Queue duration p95 < 2 minutes" and "Pending jobs < 1000"; alert state is "Queue duration p95 > 10 minutes" and "Pending jobs > 7000". https://runbooks.gitlab.com/ci-runners/alerts/CiRunnersServiceCiRunnerJobsApdexSLOViolationSingleShard/. One vendor's own runbook. [unverified]
- GitLab queue SLO as apdex: shared runners "Satisfied threshold: 1 second", "SLO: 90% apdex"; non-shared runners "Satisfied threshold: 30 seconds", "SLO: 95% apdex". Alerts use multi-window, multi-burn-rate rules, which "requires both short and long windows to breach simultaneously". https://runbooks.gitlab.com/ci-orchestration/alerts/CiOrchestrationServiceJobQueueDurationApdexSLOViolation/. One vendor's own runbook. [unverified]
- Google SRE workbook: alert on how fast an SLO budget burns, not on a raw threshold. A raw threshold has low precision: "The alert fires on many events that do not threaten the SLO." Starting values: page at 2% of budget in 1 hour (5-minute short window) or 5% in 6 hours (30-minute short window); ticket at 10% in 3 days (6-hour short window). https://sre.google/workbook/alerting-on-slos/ (Table 5-8). [named expert]
- Buildkite: "brief spikes during high-activity periods are normal", while "sustained high wait times may indicate underlying issues". https://buildkite.com/docs/pipelines/insights/clusters. [named expert]
- Agreement (GitLab runbooks, Google SRE workbook, Buildkite): set an SLO on per-run wait (for example "p95 wait under N" or "X% of runs start within N"), and alert only when both a short and a long window breach it. Do not alert on one slow run or one spike. No source gives a threshold for a local agent queue; the GitLab numbers are for a large hosted fleet, so this repo must set N from its own measured wait distribution.

## Parallelism and CPU oversubscription

### Default worker counts in the tools

- Jest: in single-run mode `maxWorkers` "defaults to the number of the cores available on your machine minus one for the main thread". In watch mode it "defaults to half of the available cores on your machine to ensure Jest is unobtrusive and does not grind your machine to a halt." Adjust it "in resource limited environments like CIs". https://jestjs.io/docs/configuration (`maxWorkers`). [standard or field body]
- Vitest: without watch, `maxWorkers` "uses all available parallelism" (`os.availableParallelism`); with watch, half of that. https://vitest.dev/config/maxworkers. [standard or field body]
- pytest-xdist: "With `-n auto`, pytest-xdist will use as many processes as your computer has physical CPU cores." `-n logical` uses logical cores. `--maxprocesses` sets a cap. https://pytest-xdist.readthedocs.io/en/stable/distribution.html. [standard or field body]
- Agreement (Jest, Vitest, pytest-xdist): each tool sizes its default worker pool to the whole machine (cores, or cores minus one). Each tool assumes that it is the only run on the machine. Two default runs at the same time thus ask for about two times the cores. The tools reduce the default (half the cores) when they share the machine with other work (watch mode).

### Total workers across concurrent runs must fit the cores

- Vitest gives the arithmetic for many runs on one machine: on a 32-CPU machine, 4 shards with `VITEST_MAX_WORKERS=7` each, because each process also needs one main thread: (1+7) x 4 = 32. Vitest also says that with many workers "the main thread can become a bottleneck as it cannot handle all the requests". https://vitest.dev/guide/improving-performance (Sharding). [standard or field body]
- Bazel uses one resource budget for all local actions, not a worker count per action. `--local_resources`: "Bazel will limit concurrently running actions based on the available resources and the resources required." Tests can declare the resources they need. `--local_test_jobs` (default `auto`) is "The max number of local test jobs to run concurrently", and it accepts forms such as `HOST_CPUS*.5`. https://bazel.build/reference/command-line-reference (`--local_resources`, `--local_test_jobs`). [standard or field body]
- Bazel common definitions assume each test size uses 1 CPU core when it schedules local tests. https://bazel.build/reference/be/common-definitions (`size`). [standard or field body]
- Agreement (Vitest, Bazel user manual/command-line reference, Jest watch default): the sum of (workers + 1 main thread) over all concurrent runs must not exceed the cores. The leading design is one machine-wide budget of CPU (and RAM) that each run draws from, not a fixed count of slots that each start a full-size pool. The machine-wide budget rests on Bazel as an adopter, so that half sets no default; the worker sum rests on Vitest's own sharding guidance. For this repo: 3 slots on 8 cores leaves about 2 workers per slot, if each slot also has one main thread ((1+1) x 3 = 6, or (1+2) x 3 = 9 for a small oversubscription).

### Effects of contention on wall time and flakiness

- CPU contention makes tests flaky, not only slow. 46.5% of the flaky tests in a study of 52 projects (Java, JavaScript, Python) were resource-affected: "We find that 46.5% of the flaky tests in our dataset are RAFT". The tests "may be competing for access to limited computational resources (CPUs, memory etc.)". https://arxiv.org/abs/2310.12132 (Silva et al., "The Effects of Computational Resources on Flaky Tests", abstract). [named expert]
- Google: small tests that never make blocking calls "can effectively run as fast as the CPU can handle"; tests that span processes or machines have more "slowness and nondeterminism". https://abseil.io/resources/swe-book/html/ch11.html. [named expert]
- Google SRE: "many systems degrade in performance before they achieve 100% utilization, so having a utilization target is essential." https://sre.google/sre-book/monitoring-distributed-systems/ (saturation). [named expert]
- Agreement (Silva et al., Google SWE book, Google SRE): oversubscribed CPU increases wall time and causes timeout-based and latency-based flaky failures. Keep the utilisation target below 100% of cores. Per-test timeouts must allow for the contention that the shared pool permits.

## Splitting a suite across parallel jobs

- CircleCI: "timing data from the previous test run is used to split a test suite as evenly as possible over a specified number of test environments", and "Timings-based test splitting gives the most accurate split". https://circleci.com/docs/guides/optimize/parallelism-faster-jobs/. [named expert]
- Depot: "a shard with disproportionately slow tests becomes the bottleneck that determines when the suite finishes"; it uses "the time each candidate took in past runs to balance how long the shards take to run", and with no past results "filename candidates fall back to file-size splitting". https://depot.dev/docs/ci/how-to-guides/split-tests. [named expert]
- Buildkite Test Engine feeds historic timings to "a bin packing algorithm" across the parallel jobs, with per-test timings summed per file. https://buildkite.com/docs/test-engine/test-splitting. [named expert]
- Vitest's `sequence.sequencer` is "A custom class that defines methods for sharding and sorting", and "Sharding is happening before sorting, and only if `--shard` option is provided". Its default `BaseSequencer.shard` sorts files by a hash of their path and cuts equal counts (vitest 4.1.11 source). https://vitest.dev/config/sequence. [standard or field body]
- Agreement (CircleCI, Depot, Buildkite): split by each file's recorded time, packed so the jobs finish together, not by file count. One file longer than a job's budget caps that job whatever the packing, so it must be split or made faster. For a file with no timing Depot falls back to file size; this repo charges the dataset's median instead, since a file's size here says little about its spawns.

## Memory reservation for a test run

### Size the charge from the run's own peak

- Kubernetes VPA sizes memory from the container's own peak per interval: "there is one memory usage sample per interval (the maximum usage over that interval)". Target: p90 of those peaks (`target-memory-percentile` 0.9) plus `recommendation-margin-fraction` 0.15. After an OOM kill: +20%, at least 100 MiB. https://github.com/kubernetes/autoscaler/blob/master/vertical-pod-autoscaler/docs/flags.md. [standard or field body]
- Google Borg Autopilot keeps each task's peak per 5-minute window, "because we typically want to to provision for (close to) the peak memory usage". Limit: "𝑆𝑝98 for jobs with low OOM tolerance. 𝑆max for jobs with minimal OOM tolerance", then "a 10–15% safety margin". Memory history half-life 48 hours. https://john.e-wilkes.com/papers/2020-EuroSys-Autopilot.pdf (sec. 3.2). [named expert]
- HTCondor compares `request_memory` with `MemoryUsage`, "the peak memory usage for the job". `ProportionalSetSizeKb` is "the maximum observed proportional set size (PSS) in KiB, summed across all processes in the job". https://github.com/htcondor/htcondor/blob/main/docs/classad-attributes/job-classad-attributes.rst. [standard or field body]
- Slurm records `MaxRSS` per job ("Maximum resident set size of all tasks in job"), recommends cgroup accounting, and offers `UsePss` ("Use PSS value instead of RSS"). https://slurm.schedmd.com/sacct.html; https://slurm.schedmd.com/slurm.conf.html. [standard or field body] An HPC centre: request "something a little larger than what seff reports", from a run that completed. https://doc.hpc.iter.es/2023.11/en/slurm/slurm_memory_limits/. [named expert]
- CircleCI: use the job's Resources tab "to decide whether to make changes to the job's configured resource class". https://circleci.com/docs/guides/execute/resource-class-overview/. One vendor's product. [unverified]
- Agreement (VPA, Autopilot, HTCondor, Slurm, CircleCI): size the charge from the run's own process-tree or cgroup peak, over many runs, at a high percentile or the maximum. The 10–15% margin is Autopilot's and VPA's, one lineage, so it sets no default. No source sizes it from a host-wide free-memory dip.

### What to measure

- cgroup v2 `memory.peak`: "The max memory usage recorded for the cgroup and its descendants". https://docs.kernel.org/admin-guide/cgroup-v2.html. PSS divides each shared page "by the number of processes sharing it". https://docs.kernel.org/filesystems/proc.html. [standard or field body]
- HTCondor does not use `memory.peak` as is, because it includes "many caches and kernel data structures"; it reads anon + shmem from `memory.stat` by polling. https://github.com/htcondor/htcondor/blob/main/src/condor_utils/proc_family_direct_cgroup_v2.cpp. [standard or field body]
- Agreement (kernel docs, HTCondor, Slurm, Kubernetes): measure the job's own process tree: PSS summed over the tree, or the cgroup's working set or anon + shmem. A polled value can miss a short peak; a cgroup high-water mark cannot. The kernel rows say what each counter measures; the choice rests on adopters, so it sets no default.

### Keep the node floor out of the job charge

- Kubernetes: "'Allocatable' on a Kubernetes node is defined as the amount of compute resources that are available for pods." Eviction reserve and system reserve come off capacity one time ("resources reserved for evictions are not available for pods"); the scheduler keeps "the total memory `requests` across all pods" under Allocatable. https://kubernetes.io/docs/tasks/administer-cluster/reserve-compute-resources/. [standard or field body]
- Agreement (Kubernetes; VPA and Autopilot size the request without a node term): subtract the node floor (earlyoom, eviction) one time from the machine total. Each run's charge is only that run's sized need. Kubernetes alone, an adopter, so this sets no default.

### Scale the charge to the size of the run

- Snakemake: memory "based on the input file size of that particular rule instance"; default `mem_mb=min(max(2*input.size_mb, 1000), 8000)`. https://snakemake.readthedocs.io/en/stable/snakefiles/rules.html. [standard or field body]
- Nextflow: "using a higher limit that fits all the tasks in your execution could significantly decrease the execution priority of your jobs"; directives can be "evaluated based on the process inputs", grow per attempt, or follow `task.previousTrace.memory`. https://www.nextflow.io/docs/latest/process.html. [standard or field body]
- HTCondor: for memory that "depends on the data that is being processed", request the typical value and give "only the single worst-case value for retry_request_memory". https://github.com/htcondor/htcondor/blob/main/docs/users-manual/automatic-job-management.rst. [standard or field body]
- GitLab Kubernetes executor sets memory per job (`KUBERNETES_MEMORY_REQUEST`), capped by `memory_request_overwrite_max_allowed`. https://docs.gitlab.com/runner/executors/kubernetes/. One vendor's product. [unverified]
- Agreement (Snakemake, Nextflow, HTCondor, GitLab, Bazel `size`): the charge follows the run's input (for a test rerun: its file count), with a floor and a cap at the full-run value. Adopters alone, so this sets no default.

## A red base in a landing queue

### The base is green by construction

- bors-ng: "Since the main branch contains the exact contents that were just tested, bit-for-bit, it's not broken." On red, "it splits the batch into two batches". https://github.com/bors-ng/bors-ng/blob/master/README.md. [standard or field body]
- Zuul tests each change "applied to the tip of the branch", assumes the changes ahead pass, and drops the first failed change. https://zuul-ci.org/docs/zuul/latest/gating.html. [standard or field body]
- GitHub merge queue removes a failed pull request and rebuilds the groups behind it; GitLab merge trains do the same. https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue; https://docs.gitlab.com/ci/pipelines/merge_trains/. Each one vendor's product. [unverified]
- Agreement (bors-ng, Zuul, GitHub, GitLab): no queue tests the base alone. The base passed when it landed, so a failure in the batch is blamed on the batch. Adopters alone, so this sets no default.

### Culprit search starts from a known pass, per test

- Google: culprit finding looks for c with "a < c ≤ b where a given test t was passing at a, failing at b"; "we consider the passing status of a test to be 100% reliable and therefore version a cannot be a culprit". Verifying every culprit costs too much, so Google audits "1% of culprit finding conclusions". https://hackthology.com/pdfs/icst-2023.pdf (Henderson et al., ICST 2023). [named expert]
- LUCI Bisection (Chromium) bisects only changepoints (pass-to-fail), skips a failure whose regression range overlaps an existing analysis, and verifies a culprit by rerunning only the failed tests at the suspect and its parent. https://github.com/luci/luci-go/tree/main/bisection (`testfailuredetection`, `culpritverification`). [standard or field body]
- Agreement (Google FACF, LUCI Bisection, git bisect): search only the tests that changed from pass to fail since the base. A test that already fails on the base is a known breakage, not a batch culprit. Confirm a culprit with the failed tests at the culprit and at its parent, not with the whole suite.

### Stop landing while the base is red

- Chromium: "If the tree is closed, CL will NOT be submitted until the tree is reopened." The tree opens again when "all (tree-closer) builds pass". https://github.com/luci/luci-go/blob/main/lucicfg/doc/README.md; https://github.com/luci/luci-go/blob/main/luci_notify/notify/tree_status.go. [standard or field body]
- Mergify: "pause the merge queue until the incident is resolved". https://docs.mergify.com/merge-queue/pause/. GitLab: "Merge immediately" lands an urgent fix past the train, "only in critical situations". https://docs.gitlab.com/ci/pipelines/merge_trains/. Each one vendor's product. [unverified]
- Agreement (Chromium, Mergify, GitLab): when the base is red, stop landing (close the tree or pause the queue) and land the fix by a separate path. Do not run each queue cycle against a base that is known red. Closing the tree rests on Chromium alone and landing the fix by a separate path on GitLab alone, both adopters, so this sets no default.

## Mutation-test runs

- PIT runs mutants in child JVMs and applies each mutant by rewriting a loaded class, which is "orders of magnitude faster than starting a new jvm or creating a new classloader"; a new JVM starts only on a timeout. https://pitest.org/faq/. [named expert]
- Stryker keeps each test-runner worker alive across mutants: `maxTestRunnerReuse` "Restart each test runner worker process after `n` runs", default `0`, "infinite reuse", restart "Not recommended unless you are experiencing memory leaks". `concurrency` caps the workers, default `n-1` cores. https://stryker-mutator.io/docs/stryker-js/configuration/. One adopter [unverified]
- mutmut imports the test suite once and "forks one child per mutant"; in forkserver mode there is "only one pytest import for the whole run". https://mutmut.readthedocs.io/en/latest/. One adopter [unverified]
- Agreement (PIT, Stryker, mutmut): a mutation run loads its test runner once and swaps mutants inside it, under one bounded worker count for the whole run. It never starts and admits a fresh runner per mutant. The default rests on PIT's reasoned verdict; Stryker and mutmut are adopters.

## A memory bound per test worker

- Node: `--max-old-space-size=SIZE` (MiB) "Sets the max memory size of V8's old memory section"; "On a machine with 2 GiB of memory, consider setting this to 1536 (1.5 GiB) to leave some memory for other uses and avoid swapping." Of a single-value option given twice, "the last passed value is used. Options from the command line take precedence over options passed through the `NODE_OPTIONS` environment variable." https://nodejs.org/api/cli.html. [standard or field body] for the flag's behaviour; its sizing advice [named expert]
- Jest: `workerIdleMemoryLimit` checks a worker "After the worker has executed a test", and kills and restarts it if over the limit. https://jestjs.io/docs/configuration. [standard or field body]
- Vitest: `vmMemoryLimit` is "the memory limit for workers before they are recycled", `vmForks` and `vmThreads` pools only; `execArgv` passes "additional arguments to `node` in the runner worker". https://vitest.dev/config/vmmemorylimit, https://vitest.dev/config/execargv. [standard or field body]
- Agreement (Node, Jest, Vitest): the runners' own memory limits act between tests, recycling a worker after it finishes one, so they never stop a test that is still allocating. Only V8's heap limit bounds a worker mid-test. Set it per worker as a command-line flag, which beats an inherited `NODE_OPTIONS`, and size it below the memory the machine can spare.

## Comparing two forms' latency on a loaded host

- Interleave the two forms and randomise the order each round (RMIT): consecutive trials on EC2 traces "falsely report that the performance of two identical systems differ by 38%". Abedi & Brecht, ICPE 2017. [named expert] Laaber, Scheuner & Leitner, EMSE 2019, adopt it as best practice. [named expert]
- Read a paired same-moment ratio new/old, so load that hits both calls cancels to first order. Bulej et al., "Duet Benchmarking", ICPE 2020 (arXiv 2001.05811); Kalibera & Jones, arXiv 2007.10899. [named expert]
- CPU time (user + sys) excludes run-queue wait (`getrusage(2)`, [standard or field body] for what it counts) and is the low-noise metric; wall is noisier but is what a caller waits for (Tratt, "What Metric to Use When Benchmarking?", 2022). [named expert]
- 95% confidence, about 30 samples to start, a bootstrap CI of the ratio (1,000+ replicates; Duet uses 10,000), compared against a stated threshold. Kalibera & Jones; Georges, Buytaert & Eeckhout, OOPSLA 2007; Duet. [named expert] A rank test at α 0.05 (Google Benchmark `compare.py`, Mozilla PerfCompare) tests for a difference and cannot show "no worse".
- Refuse on precision, never on load: stop when the CI is tight enough, and at a sample cap report the CI as inconclusive. Georges et al.; Kalibera & Jones; Abedi & Brecht. [named expert]
- Agreement (3+): a paired, randomised-order ratio with a bootstrap CI against a non-inferiority margin, more samples while the CI straddles it, inconclusive at the cap. This repo's form is `scripts/measure-guard-port/bench.py --paired` (#3216); its 3% margin, +30 step and 90 cap are untraced, and its median of ratios departs from Duet's geometric mean so one loaded call does not move it.

## Gaps

- No free source gives a numeric per-file or per-run time budget for a local, multi-agent test gate. Values for this repo must come from its own measured run durations.
- No free source gives a queue-wait alert threshold for a small local pool. The GitLab values are for a large hosted fleet.
- Paywalled source named as unread: Mor Harchol-Balter, "Performance Modeling and Design of Computer Systems" (Cambridge University Press), on SRPT and queue fairness.
- No free source gives a numeric margin for a local test-suite memory charge. The 10–15% values are for Borg and Kubernetes services and batch jobs. None gives one for a test worker's heap cap over its measured peak either.
