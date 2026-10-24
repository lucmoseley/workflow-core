# Research: design for testability (ports and adapters, functional core / imperative shell, test-shape models) (ticket #2192)

Question: What does published research and practice say about ports and adapters, functional core / imperative shell, the test pyramid, the testing trophy and the Google test sizes? What is the measured effect on suite run time and on defects found? How many end-to-end or real-boundary cases does each model tell you to keep? What are the known failure modes (for example, a fake that drifts from its real adapter), and which contract tests prevent them?

Prior art: `docs/research/test-cost-practices.md` (#1792).

Evidence classes in this note:
- **[M]** a measurement or an empirical paper (data that you can examine or re-run).
- **[V]** a vendor or tool document, or a standard.
- **[P]** practice: a blog post, a talk, a book chapter of opinion. Practice is not measurement.

## Findings

### F1. Ports and adapters (Cockburn) [P]

Source: Alistair Cockburn, "The Hexagonal (Ports & Adapters) Architecture", HaT Technical Report 2005.02, dated 2005-09-04, v0.9. https://alistair.cockburn.us/hexagonal-architecture/.

- Intent, as written: "Create your application to work without either a UI or a database so you can run automated regression-tests against the application, work when the database becomes unavailable, and link applications together without any user involvement."
- A port is "a purposeful conversation". Each port has many adapters. The paper names "a test harness", "a batch driver" and "a mock (in-memory) database" as adapters, beside the real database.
- The paper gives an order of use (Figure 3): (1) a FIT harness drives the application with an in-memory database; (2) add a GUI, still on the in-memory database; (3) "In integration testing, with automated test scripts (e.g., from Cruise Control) driving the application against a real database containing test data"; (4) real use.
- Number of ports: "two, three, or four (four is most I have encountered to date)".
- What the paper does NOT give: no measurement of run time or of defects; no count of real-boundary tests; no word about a fake that drifts from the real adapter, or about a test that holds the two adapters to one contract. Step (3) implies that the real adapter gets an integration run, but the paper does not say how many cases.

### F2. Functional core, imperative shell (Bernhardt) [P]

Sources: Gary Bernhardt, "Functional Core, Imperative Shell", Destroy All Software screencast, published 2012-07-12 (https://www.destroyallsoftware.com/screencasts/catalog/functional-core-imperative-shell); "Boundaries", talk at SCNA 2012 (https://www.destroyallsoftware.com/talks/boundaries).

- Screencast summary: a Twitter client has a functional core (timeline sync, cursor positions, render to text). "This functional core is surrounded by a shell of imperative code: it manipulates stdin, stdout, the database, and the network, all based on values produced by the functional core." Claimed effects: "testing the functional pieces is very easy, and it often naturally allows isolated testing with no test doubles. It also leads to an imperative shell with few conditionals".
- Talk summary: "using simple values (as opposed to complex objects) not just for holding data, but also as the boundaries between components", with "isolated unit testing with and without test doubles".
- The pattern's test claim is: put the branches in the core (tested in-process with values, no doubles), and keep the shell so thin that few integration tests cover it. The summaries do not give a count of shell tests, and give no measurement.
- Relevance: the core needs no fake at all, so there is no fake to drift. The drift hazard moves to the shell, and the shell has few branches. This is the strongest design argument against a fake per boundary: where a value can replace a port, no contract test is necessary.

### F3. Google Testing Blog, "Just Say No to More End-to-End Tests" (Wacker, 2015) [P]

Source: Mike Wacker, 22 Apr 2015, https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html.

- The evidence is a "composite sketch based on a collection of real experiences". It is not a measurement. The sketch: a nightly end-to-end run; pass rate 5%, 4%, 54%, 54%, 54%, 1%, 84%, 87%, 89.54% over nine days; the team was a week late. Causes named: one break (sign-in, save) fails most tests; partner and lab failures; "Many smaller bugs were hidden behind bigger bugs"; flakes; next-day feedback.
- It grants that "the tests ultimately did catch real bugs" and "Customer-impacting bugs were identified and fixed before they reached the customer."
- Criteria for a feedback loop: fast, reliable, isolates failures. Only the end-to-end column "Simulates a Real User".
- "one tenth of a second is considered slow for unit tests."
- Integration test: "a small group of units, often two units". "why write an end-to-end test when you can write a much smaller, more focused integration test that will detect the same bug?"
- Count: "you probably still will want a small number of end-to-end tests". "As a good first guess, Google often suggests a 70/20/10 split: 70% unit tests, 20% integration tests, and 10% end-to-end tests. The exact mix will be different for each team". The post gives no source or data for 70/20/10. Named anti-patterns: the inverted pyramid ("ice cream cone") and the "hourglass" (many unit and many end-to-end, few integration).
- A reader comment (23 Apr 2015) notes that a share by count does not measure cost or coverage: "a few E2E test can generate much higher coverage than several unit tests".

### F4. The test pyramid (Cohn; Fowler) [P]

Source: Martin Fowler, "TestPyramid" (bliki), 1 May 2012, revised 2016 and 2017. https://martinfowler.com/bliki/TestPyramid.html.

- Origin: Mike Cohn, *Succeeding with Agile* (2009), "Test Automation Pyramid"; drawn with Lisa Crispin in 2003-4.
- Claim: "you should have many more low-level UnitTests than high level BroadStackTests running through a GUI". UI end-to-end tests are "brittle, expensive to write, and time consuming to run" and "more prone to non-determinism problems".
- The pyramid's premise is conditional (footnote 2): "The pyramid is based on the assumption that broad-stack tests are expensive, slow, and brittle compared to more focused tests ... If my high level tests are fast, reliable, and cheap to modify - then lower-level tests aren't needed."
- Middle layer: "SubcutaneousTests" that act through a service layer, below the UI.
- Count: no number. High-level tests are "a second line of test defense": "before fixing a bug exposed by a high level test, you should replicate the bug with a unit test."
- No measurement of time or defects in the page.

### F5. The testing trophy (Dodds) and the honeycomb (Spotify) [P]

Sources: Kent C. Dodds, "Write tests. Not too many. Mostly integration.", 13 Jul 2019, https://kentcdodds.com/blog/write-tests ; "The Testing Trophy and Testing Classifications", 3 Jun 2021, https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications. André Schaffer and Rickard Dybeck, "Testing of Microservices", Spotify Engineering, 11 Jan 2018, https://engineering.atspotify.com/2018/01/testing-of-microservices.

- Trophy layers, bottom to top: static, unit, integration (the largest), end-to-end. Dodds' definitions (2021): a unit test tests a unit with "no dependencies (collaborators) or which have those mocked"; an integration test tests "multiple units integrating with one another"; an end-to-end test runs "without any (or more practically 'as little as possible') mocking".
- Dodds' scope: frontend JavaScript, "within the confines of my own code ownership"; "I never considered whether it applied to microservices or even backend services at all"; backends "only ... for monoliths".
- His argument against the pyramid: the pyramid's speed premise is "less true" because "Our tools are awesome now". He gives no measurement. He states that confidence rises as you go up. Guiding rule: "The more your tests resemble the way your software is used, the more confidence they can give you."
- Lever: "stop mocking so much stuff. When you mock something you're removing all confidence in the integration between what you're testing and what's being mocked."
- Spotify honeycomb: "focus on Integration Tests, have a few Implementation Detail Tests and even fewer Integrated Tests (ideally none)". "Integrated Test" is from J.B. Rainsberger: "A test that will pass or fail based on the correctness of another system". Their integration test spins up the service's own real database and queries its real API. Trade-off stated: "we might lose some feedback accuracy when a test fails". No time or defect figures.
- Count: neither the trophy nor the honeycomb gives a number of end-to-end cases. The honeycomb wants zero tests that depend on another team's system, but many tests against its own real database.

### F6. Fowler, "On the Diverse And Fantastical Shapes of Testing" (2021) [P]

Source: https://martinfowler.com/articles/2021-test-shapes.html, 2 Jun 2021.

- Fowler says the pyramid against honeycomb/trophy dispute is mostly about words. Honeycomb and trophy authors mean "solitary" unit tests (every collaborator a double) by "unit", and "sociable" unit tests by "integration". "any descriptions I've heard of the test pyramid consider unit tests to be sociable and/or solitary."
- Quoted test expert: "I cover 24 different definitions of unit test".
- His "biggest issue", in Justin Searls' words: "People love debating what percentage of which type of tests to write, but it's a distraction. Nearly zero teams write expressive tests that establish clear boundaries, run quickly & reliably, and only fail for useful reasons."

### F7. Software Engineering at Google: the mix, flake cost, and fakes (ch11, ch13) [P, with Google-internal figures]

Sources: Winters, Manshreck, Wright (eds.), *Software Engineering at Google* (O'Reilly 2020), free HTML: ch11 "Testing Overview" (Adam Bender), https://abseil.io/resources/swe-book/html/ch11.html ; ch13 "Test Doubles" (Andrew Trenk, Dillon Bly), https://abseil.io/resources/swe-book/html/ch13.html. The prior art (#1792 G3, G5) has the size rules and "prefer realism".

- **Count, ch11**: "As a very rough guideline, we tend to aim to have a mix of around 80% of our tests being narrow-scoped unit tests ...; 15% medium-scoped integration tests ...; and 5% end-to-end tests". Figure 11-3 caption: "percentages are by test case count, and every team's mix will be a little different".
- **Scope against size**: Google rates a test on two axes. Size (small: one process; medium: one machine, localhost only; large: anything) is about the resources the test may use. Scope (unit, integration, end-to-end) is about how much code it checks. The 80/15/5 mix is a scope mix.
- **What larger tests are for (ch11)**: "Larger tests act as sanity checks as the product develops; they should not be viewed as a primary method for catching bugs." Trade-off, stated without data: more integration tests means "your test suites take longer to run but catch more issues between components"; unit tests "cannot verify the interactions between components".
- **Hourglass cause (ch11)**: "The hourglass pattern occurs when tight coupling makes it difficult to instantiate individual dependencies in isolation." This ties the test shape to the design: ports remove the cause.
- **Flake arithmetic (ch11)**: "If each test has even a 0.1% of failing when it should not, and you run 10,000 tests per day, you will be investigating 10 flakes per day." "as you approach 1% flakiness, the tests begin to lose value. At Google, our flaky rate hovers around 0.15%". The 1% threshold is "our experience", not a study.
- **Historic defect figure (ch11)**: on Google Web Server in 2005, "more than 80% of production pushes contained user-affecting bugs that had to be rolled back", before the team adopted automated tests. The chapter gives no after figure for that rate.
- **Mock drift at scale (ch13)**: an API "mocked thousands or even tens of thousands of times"; "These test doubles are very likely to exhibit behavior that violates the API contract of the type being mocked—for instance, returning null for a method that can never return null."
- **When is a real dependency too slow (ch13)**: "There is no exact answer"; "one second extra per test case may be reasonable if there are five test cases, but not if there are 500". "For borderline situations, it is often simpler to use a real implementation until it becomes too slow".
- **Fake ownership (ch13)**: "the team that owns the real implementation should write and maintain a fake." "a fake should typically be created only at the root of the code that isn't feasible for use in tests" (one fake for the database API, not one for each caller).
- **Fidelity scope (ch13)**: "For any given input to an API, a fake should return the same output and perform the same state changes of its corresponding real implementation." "the fake must have perfect fidelity to the real implementation, but only from the perspective of the test". For an unsupported path, "It is best to have the fake fail fast".
- **Contract test (ch13)**: "A fake must have its own tests to ensure that it conforms to the API of its corresponding real implementation. A fake without tests might initially provide realistic behavior, but without tests, this behavior can diverge over time". The method: run tests "against the API's public interface ... against both the real implementation and the fake (these are known as contract tests)". The real-side runs "will likely be slower, but ... they need to be run only by the owners of the fake."
- **Fake as optimisation (ch13)**: "if the speedup from a fake doesn't outweigh the work it would take to create and maintain the fake, it would be better to stick with using the real implementation."
- **Stub hazard (ch13)**: a stub that "hardcodes part of the contract" has "no way to guarantee that the contract is correct".

### F8. Software Engineering at Google ch14 "Larger Testing": unfaithful doubles, and record/replay as a contract guard [P, Google-internal]

Source: ch14, Joseph Graves, https://abseil.io/resources/swe-book/html/ch14.html.

- **Why larger tests exist**: "The primary reason larger tests exist is to address fidelity." The named gaps of unit tests: "Unfaithful doubles", "Configuration issues", problems under load, unexpected behaviour, and Hyrum's Law ("the effective user contract applies to all visible behaviors, not just a stated contract").
- **Drift mechanism**: the author of a mock "usually did not write the thing being mocked and can be misinformed about its actual behavior"; "mocks become stale. If this mock-based unit test is not visible to the author of the real implementation and the real implementation changes, there is no signal that the test ... should be updated". "if teams provide fakes for their own services, this concern is mostly alleviated."
- **Configuration gap**: "Usually a binary has some kind of deployment configuration or starter script." "Unit tests alone cannot verify this compatibility." (In this repo: the shebang, the `hooks.json` wiring and the `settings.json` matcher are this kind of gap.)
- **Compounding doubles**: an illustration, not a measurement: with two doubles that are "10% accurate", "the likelihood of a bug is 99% (1 – (0.1 ∗ 0.1))"; "the chance of bugs when putting it all together is exponential in N".
- **Medium SUT**: "one or more separate binaries (same as production) and the test is its own binary. But everything runs on one machine. This is used for 'medium' tests." A test that spawns this repo's real script against a temp git repo is this shape.
- **Contract guards named**: (a) consumer-driven contract tests: "a client defines a mock of the service saying that, for these input arguments, I get a particular output. Then, the real service uses this input/output pair in a real test"; tools named: Pact and Spring Cloud Contract. Google does not use them internally because of protocol buffers. (b) Google's "most popular approach": record/replay. The larger "Record Mode" test "runs continuously on post-submit" and generates traffic logs; the smaller "Replay Mode" test "is used during development and presubmit". When a request does not match the recording, "the engineer must run the test in Record mode", so record runs must be "easy, fast, and stable".
- **Order (ch14)**: "move toward the test pyramid within the first few days of development by building out unit tests, and then to top it off after that point by introducing automated integration tests".
- **Flake guidance (ch14)**: "Minimizing flakiness starts with reducing the scope of the test"; replace timed sleeps with event-driven waits.

### F9. Google flake data by test size (Micco 2016; Listfield 2017) [M, Google-internal, not re-runnable]

Sources: John Micco, "Flaky Tests at Google and How We Mitigate Them", 27 May 2016, https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html ; Jeff Listfield, "Where do our flaky tests come from?", 17 Apr 2017, https://testing.googleblog.com/2017/04/where-do-our-flaky-tests-come-from.html. These are measurements on Google's own corpus. The data is not public, so you cannot re-run them, but they are the largest published flake counts by test size that I found.

- Micco: "a continual rate of about 1.5% of all test runs reporting a 'flaky' result"; "about 84% of the transitions we observe from pass to fail involve a flaky test"; "the insertion rate is about the same as the fix rate". With 1000 tests at 1.5%, "15 tests will likely fail". A test marked flaky reports failure only after 3 failures in a row, so a 15-minute integration test hides a real break for 45 minutes. Quarantine "could easily mask a real race condition".
- Listfield: "around 4.2 million tests"; "around 63 thousand have a flaky run over the course of a week" (less than 2%).
- **Flake rate by size label, one week: small 0.5%, medium 1.6%, large 14%.**
- Flake likelihood against objective size, equal-sized buckets: r2 = 0.82 for binary size, 0.76 for RAM used; 0.94 for the smallest 96% of tests with smaller buckets. "the larger the tests get, the more likely they are to be flaky."
- Tools: Java WebDriver 10.45% of its tests flaky, Python WebDriver 18.72%, an internal integration tool 14.94%, Android emulator 25.46%; all tests 1.65%. "Size is more predictive than tool": at equal RAM, tools differ by about 4-5%; from the smallest test to the 95th percentile of RAM, by 8-10%.

### F10. Luo, Hariri, Eloussi, Marinov, "An Empirical Analysis of Flaky Tests", FSE 2014 [M]

Source: FSE 2014 paper, author PDF copy at https://huang.isis.vanderbilt.edu/cs8395/paper/flakytest.pdf (11 pages, extracted to text and searched; I read the findings table, the root-cause sections and the fix sections). The data is a set of public Apache commits, so you can examine it again.

- Corpus: "201 commits that likely fix flaky tests in 51 open-source projects" from the Apache Software Foundation. 161 commits got a root-cause category.
- Root causes of the 161: Async Wait 74 (45%), Concurrency 32 (20%), Test Order Dependency 19 (12%); these three are 77%. Others: Resource Leak 11, Network 10, Time 5, IO 4, Randomness 4, Floating Point 3.
- **External resources are not the main cause**: "63 out of 74 (85%) Async Wait flaky tests do not depend on external resources and involve only one ordering"; "31 out of 32 (97%) Concurrency flaky tests do not depend on external resources". But "Many Test Order Dependency flaky tests (47%) are caused by dependency on external resources", and 74% of those are fixed "by cleaning the shared state between test runs".
- Time waits: "25 out of 74 (34%) Async Wait flaky tests use sleep or waitFor with a time delay to enforce ordering". Of the 20 fixes by `sleep`, 60% "increase the waiting time of an already existing sleep", which shows "the effect that machine speed variation can have".
- "Most flaky tests (78%) are flaky the first time they are written." "Almost all flaky tests (96%) are independent of the platform".
- "Some fixes to flaky tests (24%) modify the CUT, and most of these cases (94%) fix a bug in the CUT." So a flaky test sometimes points at a real product bug.
- Quoted Google figure: TAP had "1.6M test failures on average each day", and "73K out of 1.6M (4.56%) test failures" were caused by flaky tests.

### F11. Spadini, Aniche, Bruntink, Bacchelli, "To Mock or Not To Mock? An Empirical Study on Mocking Practices", MSR 2017 [M]

Source: accepted author manuscript, TU Delft repository, DOI 10.1109/MSR.2017.61, https://repository.tudelft.nl/file/File_dcb7ec41-615b-457c-9b5f-e6c6de2dea7e (17 pages, extracted to text and searched; I read the RQ1 and RQ3 results). Data and tool are on 4TU.ResearchData (dataset a6a43620-28fc-456e-bf13-7a091682e95c), so you can re-run it.

- Corpus: Sonarqube, Spring Framework, VRaptor, Alura (Java); 4,419 test units; interviews; a survey of 105 developers.
- "4,419 test units of which 1,122 (25.39%) contain at least one mock object." Of 38,313 dependencies, 2,568 (6.71%) are mocked. 650 dependencies, "70% of all dependencies mocked at least once", were both mocked and not mocked in the same suite.
- What developers mock: web services (~82% of survey respondents always or almost always), external dependencies (~79%), databases (~71%). Domain objects are mocked about 36% of the time, with no clear trend. Spring mocks 94% of its database dependencies.
- **Main challenge (RQ3)**: "maintaining the behavior of the mock compatible with the behavior of original class is hard and that mocking increases the coupling between the test and the production code." Also: "if code has not been written with proper decoupling and dependency isolation, then mocking is difficult (if not impossible)"; "in legacy systems ... mocking is the only way to perform some testing."
- Not measured: the paper does not measure defects found, run time, or how often a mock actually drifted. The drift hazard is a developer report (interview and survey), not a count.

### F12. Trautsch, Herbold, Grabowski, "Are unit and integration test definitions still valid for modern Java projects?", JSS 2020 [M]

Source: Journal of Systems and Software, DOI 10.1016/j.jss.2019.110421; preprint (16 May 2019) at https://www.swe.informatik.uni-goettingen.de/sites/default/files/publications/main2_0.pdf (extracted to text; I read the abstract, the method and the conclusion, and searched the rest). Dataset published by the authors; the method uses the PIT mutation tool, so you can re-run it.

- Method: "We classify 38782 test cases into unit and integration tests according to the definition of the IEEE and use mutation testing to assess their defect detection capabilities." 17 Java projects, picked at random from 41 that fit the criteria. Each test runs alone under PIT. Mutants are put into five defect types.
- A unit test under the IEEE definition, applied to Java, "tests only units from within one package".
- Result: "We could not find any evidence that certain defect types are more effectively detected by either one of the test types." "there seems to be no need to focus on the type of test developed, at least if we only consider the effectiveness of tests".
- Limits: mutants are a proxy for real defects. The paper itself cites work that finds only a weak link between mutation score and real defects once suite size is controlled. The study asks which defect *types* each kind finds, not what a whole suite finds per second of run time. A mutant inside one process cannot stand for a boundary defect (a wrong argv, a shebang, a changed `gh` JSON field).
- Relevance: this is the only empirical comparison of unit and integration tests on defect detection that I found. It does not support the claim that the larger test finds more of a given in-code defect type. So, for an in-code fault, the in-process test is not weaker in this data.

### F13. James Shore, "Testing Without Mocks: A Pattern Language" (2023 revision) [P, one re-runnable speed comparison]

Source: https://www.jamesshore.com/v2/projects/nullables/testing-without-mocks.

- Position against hexagonal and functional core: those patterns fix "the problem... for logic. But infrastructure is often left untested". (In Shore's words, infrastructure is "code that involves external systems or state".)
- Its main example is a Node.js command-line program: `App` takes a `CommandLine` infrastructure wrapper; the test uses `CommandLine.createNull({ args })` and `trackOutput()`. "it's actually production code with an 'off' switch". This is the same shape as a Node CLI with an injected process port.
- **Count**: "Write one or two end-to-end tests that make sure your code starts up and runs a common workflow." "Don't rely on smoke tests to catch errors ... If the smoke tests catch something the rest of your tests don't, fill the gap with more narrow tests."
- **Real boundary**: one "Infrastructure Wrapper" for each external system, tested with "Narrow Integration Tests": "Test your external communication for real. For file system code, read and write real files." Run them on test systems "reserved exclusively for one machine's use", started and stopped by the tests. High-level wrappers that delegate to a low-level wrapper "don't need Narrow Integration Tests".
- **Drift guard (Embedded Stub)**: stub the third-party code, not your own code; "Be careful to have your stub mimic the behavior of the third-party code exactly. To help you do so, write Narrow Integration Tests that document the behavior of the real code, paying particular attention to edge cases such as error handling and asynchronous code. Then write additional tests of the Nulled instance that will fail if your stub doesn't have the same behavior." This is a contract test pair: one set of facts, checked on the real path and on the nulled path.
- External drift: "Paranoic Telemetry may be supplemented with Contract Tests. Contract Tests are most effective when run by the supplier (but provided by you), because they can't catch changes that happen between test runs."
- Speed claim: "In a head-to-head comparison, tests using these patterns were 2–3 orders of magnitude faster than tests using a mocking framework." The comparison code is linked, so you can re-run it, but it compares against a mock framework, not against a spawned process. No defect data.
- Trade-offs he states: changes to production code that "will only be used by tests"; hand-written stub code; "Multiple test failures" from sociable tests.
- Note for this repo: the "off switch" in production code conflicts with this repo's §G6 ("Nothing is exported only for its tests") unless the null path has a production caller.

### F14. Ham Vocke, "The Practical Test Pyramid" (martinfowler.com, 2018) [P]

Source: https://martinfowler.com/articles/practical-test-pyramid.html, 26 Feb 2018.

- Narrow integration test: "test one integration point at a time by replacing separate services and databases with test doubles. Together with contract testing and running contract tests against test doubles as well as the real implementations". For a file: "you need to save a file to your disk and load it in your integration test."
- Drift: with a fake HTTP server (Wiremock), "the separate service could change its API and our tests would still pass. Right now we're merely testing that our WeatherClient can parse the responses that the fake server sends." Fix: "Running contract tests against the fake and the real server ensures that the fake we use in our integration tests is a faithful test double."
- In-memory substitute hazard: an H2 in-memory database for tests is "risky business. After all, our integration tests run against a different type of database than they would in production."
- Consumer-driven contracts: consumers publish their expectations; the provider runs them. Tool named: Pact.
- **Count**: "reduce the number of end-to-end tests to a bare minimum"; translate "the most important steps" of the core user journeys; "Maybe you'll find one or two more crucial user journeys ... Everything more than that will likely be more painful than helpful."
- **Duplication rules**: "If a higher-level test spots an error and there's no lower-level test failing, you need to write a lower-level test"; "Push your tests as far down the test pyramid as you can"; "If you have tested all conditions confidently on a lower-level test, there's no need to keep a higher-level test". The higher-level test checks "exactly that - but nothing more" (for example, that the endpoint responds), not the edge cases again.
- No measurement.

### F15. Fowler, "Mocks Aren't Stubs" (2007) and "SelfInitializingFake" (2009) [P]

Sources: https://martinfowler.com/articles/mocksArentStubs.html (2 Jan 2007); https://martinfowler.com/bliki/SelfInitializingFake.html (4 Aug 2009).

- Definitions: "Fake objects actually have working implementations, but usually take some shortcut which makes them not suitable for production". The classical (Detroit) style uses real objects where it can; the mockist (London) style mocks every collaborator.
- Failure modes of each, as Fowler states them: classical tests make "a ripple of failing tests all across the system" when a much-used object breaks; mockist tests "lose" the quality of "mini-integration tests", and "you also run the risk that expectations on mockist tests can be incorrect, resulting in unit tests that run green but mask inherent errors". Rule of thumb for a classical cluster: "no more than half a dozen" objects.
- "whichever style of test you use, you must combine it with coarser grained acceptance tests that operate across the system as a whole." No number.
- Self-initializing fake (a record/replay double): the first call goes to the real service and saves the answer; later calls replay it. Drift guard in the example: "a special test suite that would get all self-initializing fakes to call the remote service and check that they returned the same value that was saved"; "early stages of their build pipeline ran against the fake, and the last (slowest) stage ran against the service itself". Compare F8 (Google record/replay) and the prior art (ContractTest: "just once a day is plenty").

### F16. Fazzini et al., "Use of Test Doubles in Android Testing: An In-Depth Investigation", ICSE 2022 [M]

Source: author PDF, https://www-users.cse.umn.edu/~mfazzini/publications/2022_icse_fazzini.pdf (13 pages, extracted to text; I read the abstract and RQ5).

- Corpus: 1,006 apps with public test suites; the ten apps that defined the most doubles; "2,365 test doubles that replace a total of 784 classes".
- RQ5, what problems doubles bring: "106,545 unnecessary and 19 mismatched stubs". An unnecessary stub is never called; a mismatched stub is called with other arguments than the stub names. Example (AnkiDroid): "a test meant to exercise specific lines in the code never reaches them because the call to a mismatched stub returns a value different from the expected one, which causes the execution of a different control flow without affecting the outcome of the test."
- Relevance: this is a measured case of a double that lets a test pass while it checks a path other than the one intended. It is the same failure class as a drifted fake, found by a tool, not by a contract test.

### F17. Pact documentation: when consumer-driven contracts fit [V]

Source: https://docs.pact.io/getting_started/what_is_pact_good_for (last updated 13 Apr 2022).

- Good for: "You ... control the development of both the consumer and the provider"; both under active development; the provider team can control the data in its responses.
- Not good for: "Testing APIs where the consumers cannot be individually identified (eg. public APIs)"; "Situations where you cannot control the data being used to generate the provider's responses"; "Functional testing of the provider".
- Relevance: `git` and `gh` are public tools that this repo consumes and does not own. By Pact's own scope, a consumer-driven contract does not fit them. What fits is the owner-side contract test of SWE at Google ch13 (F7) and Shore's Embedded Stub pair (F13): this repo owns the fake, so this repo runs the same checks against the real binary.

## Measurements in this repo (re-runnable)

### M1. Share of test files that cross a process boundary

Command: `git ls-files '*.test.ts' '*.test.js' '*.test.mjs' '*.spec.ts'`, then `grep -l` for each pattern. HEAD b7204d58c, 19 Oct 2026. These are text matches, not a trace of what runs: a file that spawns through a testkit helper is not counted, and a file that imports `child_process` only for a type is counted.

| Pattern | Files of 542 |
|---|---|
| `spawnSync`, `execFileSync`, `execSync`, `spawn(`, `execFile(` or `child_process` | 334 (61.6%) |
| `run-in-process` or `runInProcess` | 194 |
| both of the two rows above | 121 |
| a literal `'git'`, `git init` or a repo-builder name | 203 |
| `WFC_GH` (the `gh` stub) | 60 |
| a literal `'bash'` or a `.sh` path | 203 |

The ticket's "about 60%" agrees with 334 of 542.

### M2. Cost of one crossing of each boundary

Script: under **M2 script** at the end of this note (median of 30 calls, `spawnSync`). Machine: aarch64, 8 cores, Node v24.18.0, gh 2.95.0. **Load average 27.2 (1 min) at start and 25.9 at end, 5,067 MB available.** That is more than three times the core count, so these figures are high; the prior art (#1792 P8) records that load multiplies a spawning test by up to 39.6 times at the median.

| Crossing | Median ms |
|---|---|
| in-process function call | 0.00 |
| `bash -c :` | 3.01 |
| `git --version` | 7.27 |
| `git init -q` into a fresh directory | 8.30 |
| `node -e 0` | 34.40 |
| `gh --version` | 135.53 |

Reading: a Node start costs about 4 to 5 times a `git` call and about 11 times a `bash` start. So for a Node program test, most of the boundary cost is the Node start of the program itself, not the git or filesystem work inside it. This is the cost that `run-in-process.js` removes and that a git port would not remove. Re-run at a low load before you quote a ratio.

### M3. A fidelity gap in the shared `gh` fake

- `scripts/lib/gh-stub.ts` defines `GH_FAILING_SCRIPT`: it prints `gh: not authenticated` to stderr and exits 1. Its comment says it is "the canonical failure mode" for "an unreachable gh". 56 test files import `gh-stub`.
- Real gh 2.95.0, logged out (`GH_CONFIG_DIR` set to an empty temp directory, `GH_TOKEN` unset), for both `gh api user` and `gh issue list -R cli/cli -L 1`: stderr is "To get started with GitHub CLI, please run:  gh auth login" plus a `GH_TOKEN` line; **exit status 4**. The gh manual (https://cli.github.com/manual/gh_help_exit-codes, [V]) says: "If a command requires authentication, the exit code will be 4".
- `scripts/lib/gh.js` lines 244-270 classify a failure as "unreachable" by stderr text. Its list holds both `/gh auth login/i` (the real text) and `/not authenticated/i` (the stub's text). So production is correct today, and the tests pass.
- The gap: `scripts/lib/gh.test.ts` line 269 pins the phrase with the hand-written string "gh auth login required", and `scripts/check-open-maps.test.ts` line 69 uses the same string. So if the `/gh auth login/i` entry were removed, a test would fail. But each phrase in those tests was written by hand, not taken from a real gh, and no test that I found runs a real gh. The canonical stub's own text and exit code (1) differ from the real logged-out gh (exit 4, other text). If a future gh release changes its wording, every test stays green. A contract test of the kind in F13 (one real logged-out gh call, offline, with an empty `GH_CONFIG_DIR`, asserting the classifier's verdict "unreachable") would close it. In my run it needed no token; it does need the gh binary, so it must skip, and say so, where gh is absent.
- The repo has no fake of `git` or of the filesystem: tests use real temp repos and real temp directories (§X2). So for those two boundaries there is no fake that can drift. The process boundary has `run-in-process.js`, whose header lists what it does not reproduce; #1792 already recommends one spawned case per program as its contract test.


## Answers to the four parts of the question

### Q1. Measured effect on suite run time

- No source that I found measures what ports and adapters, or functional core / imperative shell, do to suite run time. Cockburn (F1) and Bernhardt (F2) give no figures.
- The only speed figure tied to a design pattern is Shore's: Nullables tests were "2–3 orders of magnitude faster than tests using a mocking framework" (F13). It is one re-runnable comparison against mocks, not against real processes.
- This repo's own figures are the strongest evidence for this repo: the in-process seam precedents in #1792 (for example five files 264.0 s to 71.5 s, mantahostels#1907), and M2 here (a Node start is about 34 ms under load 27, against about 7-8 ms for a git call).

### Q2. Measured effect on defects found

- Trautsch et al. 2020 (F12, mutation testing, 38,782 tests, 17 Java projects): no evidence that unit or integration tests find different defect types better. This is the only controlled comparison that I found.
- Luo et al. (F10): 24% of flaky-test fixes changed the code under test, and 94% of those fixed a real bug. So a flaky large test can carry a real defect signal.
- No study that I found counts the defects that a contract test caught, or that a drifted fake let through. The drift hazard is a developer report (Spadini, F11), a mechanism (SWE ch14, F8), and a measured stub mismatch rate in Android apps (Fazzini, F16: 19 mismatched stubs in 4 of 10 apps).

### Q3. How many end-to-end or real-boundary cases each model keeps

| Model | Count it gives | Source class |
|---|---|---|
| Ports and adapters (Cockburn) | none; an integration stage against the real database, count not given | P (F1) |
| Functional core / imperative shell (Bernhardt) | none; a thin shell with "few conditionals" | P, summary only (F2) |
| Test pyramid (Cohn, Fowler) | none; "many more" unit than broad-stack tests; high-level tests are "a second line of test defense" | P (F4) |
| Google, 2015 blog | 70/20/10 unit/integration/end-to-end, "a good first guess" | P, no data (F3) |
| Google, SWE book 2020 | 80/15/5 by test-case count, "a very rough guideline" | P, no data (F7) |
| Testing trophy (Dodds) | none; "mostly integration"; frontend scope | P (F5) |
| Honeycomb (Spotify) | "even fewer Integrated Tests (ideally none)", but many tests against the service's own real database | P (F5) |
| Practical Test Pyramid (Vocke) | end-to-end for the core user journey, "Maybe ... one or two more" | P (F14) |
| Testing Without Mocks (Shore) | "one or two" smoke tests for each app, plus narrow integration tests for each low-level infrastructure wrapper | P (F13) |

- The sources agree on one structure, not on a number: a small, fixed set of top-level cases (a smoke path or the core journeys), plus one real-boundary test set for each adapter, plus the branches at the lowest level that can see them. And: when a top-level test finds a bug, add a lower-level test for it (F4, F14).

### Q4. Failure modes and their guards

| Failure mode | Evidence | Guard named in the sources |
|---|---|---|
| A fake or mock drifts from the real adapter | SWE ch13 and ch14 (F7, F8), mechanism; Spadini (F11), developer report; Fazzini (F16), measured stub mismatches | A contract test: one set of tests run against the real adapter and against the fake (F7; Fowler ContractTest in #1792; Vocke F14; Shore's Embedded Stub pair F13). The fake's owner runs the real side (F7). |
| A third-party service changes its interface | Vocke (F14); Fowler SelfInitializingFake (F15) | Record/replay with a post-submit record run (Google, F8); a suite that compares saved answers to live ones, as the last pipeline stage (F15); consumer-driven contracts, only where you own both sides (F17). |
| Configuration and start-up are not covered by in-process tests | SWE ch14 (F8) | A larger test that runs the real binary with its real configuration (F8); one or two smoke tests (F13). |
| An in-memory substitute behaves unlike the real store | Vocke on H2 (F14); SWE ch13 fidelity (F7) | Run the real store in the test; or the fake fails fast on a path it does not support (F7). |
| Low-fidelity doubles compound | SWE ch14, illustration only (F8) | Fewer doubles; fakes owned by the real implementation's owner (F7). |
| Mocks couple the test to the implementation | Spadini (F11); Fowler (F15); Shore (F13) | State-based tests on real or fake collaborators; this repo's §X2 already bans `vi.mock`. |
| Large tests are flaky | Google: small 0.5%, medium 1.6%, large 14% (F9); Luo (F10) | Smaller scope (F8); event waits in place of sleeps (F8, F10); clean shared state between tests (F10). |
| Ripple failures in sociable tests | Fowler (F15); Shore (F13), stated trade-off | Accept it; keep clusters small; add a finer test where the root cause is hard to find. |
| Hourglass shape | SWE ch11 (F7): caused by "tight coupling" | Injected dependencies, so a medium test can build one unit and its real neighbour. |

## Weighing against this repo

Facts of this repo: Node CLI programs and bash hooks; boundaries are processes, git, the filesystem and `gh`. 334 of 542 test files cross a process boundary (M1). §T7 and §G7 prescribe injected dependencies and a second adapter. §X2 requires a real seam (temp directory, subprocess, injected binary or dependency), and bans `vi.mock`. §X3 runs every program case end to end, through `run-in-process.js` for Node programs. §X8(2) says "keep one case on the real call or dependency".

1. **git and the filesystem are already real, so they have no fake to drift.** SWE ch13 (F7) prefers this, and says to change to a double only when the real thing "becomes too slow". M2 puts a git call at about 7-8 ms under heavy load. The sources give no reason to put a port in front of git for speed alone. Such a port, with a fake, would bring the drift hazard and the contract-test cost of F7, for a small gain. (The exception is where a test needs a git state that is slow or hard to build for real; there, §X8(2) "reach a state by seeding it" applies.)
2. **The cost driver is the Node start of the program under test** (M2: about 34 ms each, against 3 ms for bash). `run-in-process.js` already removes it for most program cases, and the prior art measures the gain. Functional core / imperative shell is the design that removes the need for even the in-process seam: a program whose body returns a result (§N4) and whose branches live in a library with no I/O (§T7) has its branches tested as values (F2), with no double.
3. **§X3 against the literature.** Every source in Q3 keeps the count of top-level cases small and puts the branches lower. §X3 instead runs *every* program case at the program level. Two points soften the conflict. (a) Through `run-in-process.js`, a §X3 case is not an end-to-end test in the sense of F3, F4 or F14: it has no deployment, no network, no partner service. In Google terms it is closer to a medium test on one machine (F8), or Fowler's "subcutaneous" test (F4). (b) §X7 keeps program tests when logic moves to a library, so the repo's choice is deliberate. What the literature would add: where a program's branches already have module tests on its library, its program-level cases need cover only what a module test cannot see: argv parsing, the exit code, the message text, the wiring (F14: "exactly that - but nothing more"; F4: the second line of defense). #2206 settles it by research: a program keeps a boundary set end to end, and its branch cases are module cases on its core.
4. **The contract test for a fake that this repo owns.** #2207 rules that every owned fake is held to its production adapter by a contract test, written into §G7. Every source that discusses fakes requires that check (F7, F13, F14, F15). M3 is the concrete case (#2220 fixes it). Pact does not fit, because gh is a public tool (F17); an owner-side contract case fits (F7, F13). The same logic covers `run-in-process.js`: the prior art (#1792 candidate (c)) proposes one spawned case per program as its contract test.
5. **Flake.** Google's data (F9) puts multi-process tests at about three times the flake rate of single-process tests. Luo (F10) finds that most flakes come from waits and ordering, not from the external resource. So for this repo, §X9 (time through a seam) and per-test temp directories (§X3 stack clause) address the larger causes; moving cases in-process addresses the smaller one.

## Where the evidence is thin

- No empirical study measures ports and adapters, or functional core / imperative shell, on run time or on defects. Both rest on design argument (F1, F2, F13).
- Both Google splits (70/20/10 and 80/15/5) are given without data, and they disagree with each other.
- The testing trophy and the honeycomb give no figures. Dodds says that his only number (70% coverage) is invented.
- No study that I found measures how often a fake drifts in practice, or how many defects a contract test catches. The drift evidence is mechanism (F8), self-report (F11), and a stub-mismatch count in Android apps (F16).
- The Google flake figures (F9) are a correlation on Google's corpus, and you cannot re-run them.
- Trautsch (F12) uses mutants inside one process, which cannot stand for a boundary defect.
- The best evidence for this repo is this repo's own: the precedents in #1792 and M1 to M3 here.

## Bound

- Read in full (downloaded, then read or searched section by section): Cockburn 2005; Wacker 2015; Fowler TestPyramid, ContractTest (in #1792), Test Shapes 2021, SelfInitializingFake; Dodds 2019 and 2021; Spotify 2018; Micco 2016; Listfield 2017; Pact "what is Pact good for".
- Read in part (the cited sections, with the rest searched by keyword): SWE at Google ch11, ch13, ch14; Vocke 2018; Fowler "Mocks Aren't Stubs"; Shore "Testing Without Mocks"; Luo et al. 2014; Spadini et al. 2017; Trautsch et al. 2020 (preprint); Fazzini et al. 2022.
- Only the free summary page: Bernhardt's screencast and his "Boundaries" talk (I did not watch either video).
- Not read: Cohn's *Succeeding with Agile*; Spadini et al. 2019 (EMSE; Springer refused the download); Memon et al. 2017 (the copies did not download); Trautsch's thesis (downloaded, not searched); Rainsberger's "Integrated Tests Are A Scam" (seen only as quoted by Spotify).

## M2 script

Run with `node spawn-cost.js [N]` (default N = 30).

```js
// Measure the median wall time of one spawn of each boundary this repo's tests cross.
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const N = Number(process.argv[2] || 30);
function med(f) { const t = []; for (let i = 0; i < N; i++) { const s = process.hrtime.bigint(); f(i); t.push(Number(process.hrtime.bigint() - s) / 1e6); } t.sort((a, b) => a - b); return t[Math.floor(N / 2)].toFixed(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r2192-'));
const rows = {
  'in-process fn call': () => JSON.parse(JSON.stringify({ a: 1 })),
  'bash -c :': () => spawnSync('bash', ['-c', ':']),
  'node -e 0': () => spawnSync(process.execPath, ['-e', '0']),
  'git --version': () => spawnSync('git', ['--version']),
  'git init (fresh dir)': (i) => spawnSync('git', ['init', '-q', path.join(tmp, 'r' + i)]),
  'gh --version': () => spawnSync('gh', ['--version']),
};
for (const [k, f] of Object.entries(rows)) console.log(k.padEnd(22), med(f), 'ms');
fs.rmSync(tmp, { recursive: true, force: true });
```
