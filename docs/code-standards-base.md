# Code standards base

The rules `/code-review`'s Standards axis cites in every repo the workflow-core plugin runs in. Every rule here is **citable as a breach**.

Every repo reads this text from the plugin, in place, and keeps no copy. A repo's own choices sit in its local `docs/code-standards.md`, which may be absent; with none, this base applies unchanged.

**Every line pin here resolves at the plugin root**, not in the repo under review: `scripts/lib/check.js:8-13` means that file inside the plugin.

## §0 How to use this

### Route by code kind

Every rule binds a **code kind**, never a directory. Route each path in the diff to its kind by the default map below; a local file may add rows or override one, and may send a path to no kind at all only as the local-file rules below allow.

| Code kind | Default paths | Sections that bind |
|---|---|---|
| test | any `*.test.js`, `*.test.jsx`, `*.test.ts`, `*.test.tsx`, their `*.spec.js`, `*.spec.jsx`, `*.spec.ts` and `*.spec.tsx` forms, or one of those with `c` or `m` before its extension (`*.test.mjs`, `*.spec.cts`); pytest's `test_*.py`, `*_test.py` and `conftest.py`; anything under a `test/`, `tests/`, `fixtures/`, `testkit/`, `testkits/`, `stubs/` or `fakes/` directory; a testkit, harness, fixture, stub or fake module named for what it is (§G6's test support) | §G + §X, and §N2 |
| shell | any `*.sh`; `.husky/*` | §G + §S, and §N2 |
| hook module | a mod's hooks module (`.claude/skills/*/hooks/**`); a plugin's entry module (`hooks/register.ts`) | §G, and §N2 |
| program | the `.js` and `.ts` files under `scripts/**` and `.claude/skills/*/scripts/**`, the modules under `scripts/lib/` included; any other file opening with a shebang | §G + §N |
| library | `lib/**` and `app/**`, and their `src/` spellings `src/lib/**` and `src/app/**` (#1961), components, layouts and static data tables included; a Next.js Pages Router app's `pages/**` and `src/pages/**` (#2061); a web app's root entry points: `proxy`, `middleware` and `instrumentation`, as `.ts` or `.js`, at the root or under `src/` (#1923) | §G + §T, and §N2 |

A path matching several rows takes the first that matches, top down: a test under `scripts/` is a test, and a shell script with a shebang is shell. A code file no row matches binds §G alone: say so in the finding, since the fix is a local route row.

**Presentational code takes its kind's full rule set, as any other code does** (#1824). The I/O a web app's edge does is excepted in §T7.

### Risk paths

A **risk path** is code that moves money, decides identity or authorisation, handles personal data, or writes something another system trusts. A local file names its own product's risk paths, for its own rules to key on.

### The design vocabulary

Rules here use seven design words in these senses only.

- **Module** — anything with an interface and an implementation, at any scale: a function, a class, a file, a package, or a slice across tiers.
- **Interface** — everything a caller must know to use a module correctly: its signature, and also its invariants, the order its calls must come in, how it fails, the configuration it needs and what it costs. Not the TypeScript keyword, which §T4 calls "the `interface` keyword".
- **Seam** — the place a module's interface sits, where behaviour can be changed without editing that place.
- **Adapter** — a concrete thing that fills a seam by satisfying its interface, such as the production implementation or a test fake.
- **Depth** — how much behaviour a caller or a test reaches per unit of interface it must learn. A **deep** module hides much behind a small interface; a **shallow** one has an interface nearly as large as its body.
- **Core** — a module that does no I/O itself and takes its I/O through injected ports: §T7's shape, whatever its route kind, so a lib module of program kind can be a core.
- **Shell** — the program or composition root that builds the adapters, hands them to the core, writes what the core returns and exits. A shell is a composition root in §T7's sense. Not the shell code kind §S binds.

### Stack clauses and house clauses

Most rules hold in any repo. Two kinds of clause inside them do not:

- A **stack clause** spells a rule for one tool and binds only where the repo has that tool's tell. The tells: a Vitest config (`vitest.config.*`); `tsconfig.json`; `biome.json`; any `*.sh` file, for shellcheck; `ruff.toml`, `.ruff.toml` or a `[tool.ruff]` table in `pyproject.toml`, for ruff; a `pytest.ini`, a `[tool.pytest.ini_options]` table in `pyproject.toml` or a `conftest.py`, for pytest; `docs/test-read-edges.json`, for the read-edge manifest; and `checkJs` set in `tsconfig.json`, for §N8. Read the tell from the repo under review. Where it is absent, the clause does not bind, and the repo writes nothing to say so. Where it is present, the clause binds only the files its tool reads: a Vitest clause binds the tests Vitest runs, never a pytest file beside them.
- A **house clause** is a choice no tool keys on — CommonJS, a single trailing `module.exports`, the four program families, `runCheck`, the naming scheme, the plugin's own helpers. It is on by default in every plugin repo. A house clause naming its languages — *House, Node programs only* — binds those alone, so a file in another language takes only the rules that hold in any language.

Each is marked where it stands, *Stack (tell)* or *House*. A local file may switch either off; it may never switch off the rest of a rule.

### How a rule enters

A rule enters this base because it is right, never because the code already does it (#1312). The spec that adds a rule fixes every existing breach of it in workflow-core itself in the same change, and gives every other repo the plugin runs in a required `[act]` step in that release's migration note, with the command that lists its breaches (#1406). A rule whose breach exists only in a change, never in a standing tree, has nothing to list, so it enters with a `[notice]` that says so in place of that step (#1495); a repo adopting the plugin later meets every rule at adoption. How much fixing that takes is never a reason to decline a rule or soften its severity. A decline gives one of five merit grounds: false findings, no defect behind the rule, a tool already enforcing it, a stack it cannot fit, or code the repo never has or does — never code it merely lacks today.

**The same test settles every scoping decision about a repo the plugin runs in, what the plugin ships to it as well as what this base asks of it** (#1380). Whether the repo already follows a practice, or already has the setup the practice needs, is never a reason to leave a rule, a gate or a script out of its reach, or to soften one. A stack clause's tell is no such setup: it says whether the repo uses the tool at all.

### Severity

- **hard** — the breach is evident from the diff alone, no code breaks the rule without a written reason, and a deviation is a defect rather than a taste call. A breach elsewhere in the code is a second finding, never a reason to downgrade this one.
- **judgement** — real, citable, but a change may have a good reason to differ. Say what the reason would have to be.


### A local file changes this base only through its changes table, its route rows and its local rules

A repo's local file makes exactly four kinds of change. Two are rows of its changes table: it switches off a stack or house clause, or excepts named paths from a base rule, with a reason and a ticket. The reason names one of the five merit grounds above; a reason that the code does not do it yet, lacks the setup, or would cost work to bring up names none, and is itself a finding. The third, adding or overriding route rows and risk paths, sits in its route-rows section. A route row may send a path to "none", binding no section, only where the repo neither writes nor runs that code (#1262): vendored, generated, or a reference export nothing imports. Such a row says which of the three it is and cites its ruling. The fourth adds a local rule (`§L` + kind letter + number, such as `§LX1`) in its own section, and contradicts nothing. It never switches off a principle and never changes a severity.

**A sentence in a local file that contradicts this base outside its changes table, its route rows and its local rules is itself a finding, and the base wins. So is a local rule that contradicts it, a row that switches off a principle or changes a severity, a "none" row over code the repo writes or runs, or a route row that sends code to a kind it is not, which excepts it from its own kind's rules with no reason or ticket.** A finding narrowed by a local row cites both: *§X2 (base), excepted by local row 2*.

**A documented rule overrides the Fowler smell baseline.** The local file's "Smells not raised" names the smells that repo deliberately contradicts; do not raise them.

### The citations rot

The plugin's citation checker (`scripts/check-code-standards.js`) reports a quotation that no longer sits in the lines it cites, and a quotation-less line pin whose lines have changed. Findings never gate. Fix the citation, never the file it points at (mantahostels#1095).

### A rule a tool enforces is not a standard

Nothing here restates a rule a tool already enforces. Check a candidate rule, and a finding, against the floor below and then the local file's §W before writing or citing it. A breach a tool already refuses is a duplicate finding.

The floor is every gate in the plugin's own `.husky/pre-commit` that judges code, whether it refuses or warns only, in every repo it runs in, so no local file restates it (#1826). The hook's other gates judge documents, the roadmap, the copy and the repo's own registers, and no code finding repeats them. A local §W lists only what its repo adds: the rule sets its own linter configs and declared commands carry, what its CI runs, floor gates included, and the gates its `.husky/pre-commit.local` runs.

| Gate | Refuses | Where it runs |
|---|---|---|
| gitleaks | a secret in the staged content | every commit; a missing binary refuses |
| `commands.check_staged` | whatever the declared command refuses, under the repo's own config | where declared |
| ESLint, `--max-warnings 0` | a finding or warning under the repo's ESLint config | staged `app/` and `lib/` `.ts`/`.tsx`, where `commands.lint` is declared; skips with no `eslint` on `PATH` |
| `commands.typecheck` | **nothing: it warns only**, reading the whole worktree | a commit staging `.ts`, `.tsx`, `.mts` or `tsconfig.json`, where declared |
| `scripts/check-code-standards.js` | **nothing: it warns only** of an export block offering names nothing takes, or only tests do (§N7, §G6) | every commit, reading the worktree against `HEAD` |
| shellcheck, `-x --severity=style --exclude=SC2016` | any finding at style severity or above, bar that one code | staged shell files: a husky hook or its `.local` companion, `.sh` and `.bash` files, and extensionless files with a shell shebang, minus `.gitattributes`' `linguist-vendored` and `linguist-generated` paths; skips with no binary |
| shfmt at `-i 2 -ci`, `ruff format` at its defaults | any layout difference, so layout in either language is never a finding | the same shell files, and staged `.py`; a missing formatter refuses unless a workflow runs it |
| actionlint | a workflow fault, shellcheck over each `run:` block included | staged `.github/workflows/*.yml` and `*.yaml`; skips with no binary |
| ruff | a finding the commit introduces, under the repo's root ruff config, else the plugin's `ruff.toml` | staged `.py` outside `ruffExclude`; a missing binary refuses unless a workflow runs `ruff check` |
| `scripts/check-swallowed-errors.js` | an `except` the commit adds that neither raises nor exits and cites no ticket (§N5) | staged program-routed `.py`; a missing `python3` refuses |
| `scripts/check-cli-args.js` | a program reading its command line without a strict parser | a `scripts/*.js` the commit adds or edits; an inherited one only warns |
| `scripts/check-guard-test-isolation.js`, `scripts/check-host-root-test-isolation.js`, `scripts/check-git-fixture-identity.js` | a `scripts/` test that spawns a guard without redirecting `CLAUDE_CONFIG_DIR`, spawns a `hostRoot()`- or `gr_root`-rooted script without redirecting `CLAUDE_PROJECT_DIR`, or commits in a git fixture it gave no identity | a commit staging `scripts/` code, each judging the whole repo |
| `scripts/check-host-root.js` | a script finding the host repository other than through the one host-root seam, or a file shipping with the plugin reached through the host root | a commit staging `scripts/`, `.claude/` or `.husky/`, judging the whole repo; skips in a repo shipping no plugin |
| `scripts/check-registrations.js` | a hook, guard or checker the commit adds unregistered or untested | a commit staging `scripts/`, `.husky/`, `.github/workflows/` or the registration files, judging the whole repo |
| `scripts/check-workflow-permissions.js` | a workflow job reaching past the timer-triggered autonomy ceiling | staged `.github/workflows/*.yml` and `*.yaml`, read from the worktree |
| `scripts/generate-test-read-edges.js --check` | a `docs/test-read-edges.json` the commit's tests no longer match; a test read the selector cannot attribute only warns | staged test files or the manifest, where the manifest exists |
| `scripts/check-skill-frontmatter.js`, `scripts/check-skill-body-size.js` | a skill's frontmatter YAML rejects, or a skill or command body holding an unescaped `$<digit>` | staged `.claude/skills/*/SKILL.md`; the body check on every commit |
| `commands.test` | a red suite, run whole | where declared and it writes no test-pass marker |
| `scripts/mutation-hold-gate.js` | a changed line on a declared sensitive path where a planted bug survives every test | with the `mutation` module on |

A gate that skips here refuses nothing, so a finding it would have refused is no duplicate in that repo; nor is one a gate only warns of.

---

## §G — every code kind

### §G1 · A non-obvious decision is written at the site, with its ticket and its residual — **judgement**

A decision that could reasonably have gone the other way carries, in a comment beside the code: what was chosen, the issue number that settled it, and what the choice leaves broken.

The corpus does this three ways: `scripts/check-restatement-edges.js:52-55` cites the ticket beside the choice it made, *"reading those would silence the exceptions they were written to flag (mantahostels#1472)"*; residuals are headed `Residual:` (`scripts/check-self-throttling.js:238-240`); and the counterfactual is stated — `scripts/pick-next.js:1998-1999` *"a probe that could not run would read as 0 to anyone who cannot see the JSON"*.

### §G2 · A magic value carries its derivation — **hard**

A value that was chosen — a threshold, a size, a count, a timeout — states where it came from, and says so when it is a guess, wherever it sits: a module constant, a parameter's default, a call-site argument or a local name (#1406). The derivation explains the value as it stands, never a change to it (#2351). Several sites holding one value for one reason take it from one constant that carries the derivation. A name for a fixed path or label is not one, nor is a value nothing chose, such as a unit conversion or a command's argument count.

`scripts/lib/gh.js:17-32` carries the measurement behind `MAX_BUFFER = 256e6` (*"the widest query any checker makes … was 26.67 MB across 2,456 issues"*); `scripts/lib/hook-block.js:23-25` for `MAX_BLOCKS = 3`; `scripts/lib/report-once.js:16-19` labels `INPUT_CHARS` *"A first guess, and stated as one"* and names what nobody has measured.

### §G3 · A retained escape hatch owes a written reason — **hard**

An empty `catch`, and every spelling below that silences a checker, carries the reason it is kept, at the site.

- *Stack (`tsconfig.json`)*: `any`, `!` and `@ts-ignore`. Prefer `unknown` and narrow (§T2). For example `// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import`, above a `require` of an untyped CommonJS module.
- *Stack (`biome.json`)*: a `biome-ignore` states its justification in its own text.
- *Stack (`*.sh`)*: `# shellcheck disable=<code> # <reason>`, inline on the line it excuses, one code per directive — never a file-top blanket.
- *Stack (`ruff.toml`)*: `# noqa: <code> - <reason>`, one code per directive, the directive inline on the line it excuses — never a bare `# noqa`, nor a file-top `# ruff: noqa` or `# flake8: noqa` (#1284). For example `# noqa: E402 - imported after the path constant the sys.path.insert above reads`: ruff exempts the insert itself, so the reason names the line it actually fires on. The reason may instead head the code it excuses, as a comment block above the enclosing `try`.

### §G4 · A file departing from its family's policy says so in its header — **judgement**

Families disagree with each other on purpose: error policy is *opposite* between a fail-loud writer and a fail-open guard.

`scripts/issue-body.js:50` is the pattern: *"This script FAILS LOUD. The guards in this repo fail open because a broken guard must not block work; a broken writer must not silently drop a decision."*

### §G5 · Names follow one scheme the repo states — **hard**

A repo's names follow one scheme, and a name breaking it is the breach.

*House, JS, TS and shell files only*: files kebab-case (`check-digest-version.js`, `guard-dispatch.js`), React components PascalCase; a Node program file that joins a family is prefixed by it (§N3). In JS and TS, module-scope constants `SCREAMING_SNAKE`; predicates `isX`/`hasX`, builders `buildX`, parsers `parseX`, readers `readX`: a reader's job is returning what it read from a file, a directory or a command's output, raw or parsed (#2750). A reader named by a noun breaches; one another verb leads (`renderX`, `loadX`) does not, nor does a wrapper named for the command it runs (`git`, `gh`) (#2654). In any other language — and for shell's own identifiers — the scheme is the one the local file states, else that language's own convention: snake_case for Python; for shell, lower snake_case functions and variables and UPPER_SNAKE constants and environment variables, as the Google Shell Style Guide has it (#1252, #1406).

### §G6 · Nothing is exported only for its tests — **hard**

**Program, library and test.** A program is tested by running it. A module is tested through the exports its real callers use. Logic that deserves its own tests becomes a module with a real caller, never a helper exported for the test (#1348).

The fixes, best first: the test drives the program end to end through `run-in-process`, and the export goes; the logic moves into a module whose real caller is the program, tested through that module's exports; or the name becomes file-local, and the test reaches it through an export a real caller uses. `scripts/lib/launch-route.js:5` is the second, a module of its own so *"the route table is tested through its export"*. A comment is never the fix.

Three kinds of export are not test-only:

- **A program's entry point**, exported so `run-in-process` can run it: a `main` exported by a file carrying a `require.main` guard, as `scripts/audit-escape-lines.js:447` does — *"module.exports = { main };"*.
- **Test support.** A testkit, harness, fixture, stub or fake module, named for what it is, and anything under a `fixtures/` directory. `scripts/lib/precommit-gate-harness.js:2` is *"the machinery the .husky/pre-commit gate suites share"*.
- **A module built ahead of its caller**, whose opening comment names that caller and its ticket on a line spelt `Unbuilt caller: <caller> (#N)`.

**Reported, never gated** (#1361): the plugin's citation checker reports a name only test-kind files consume as it does one nothing consumes, under §N7's scan and its limits.

### §G7 · An injected seam has a second adapter — **judgement**

**Program, library and shell.** Every injected seam — a dependency parameter, a port, or an env var standing in for a binary, a file or a clock — has a second adapter beside production's, and a test fake counts. Otherwise a comment at the seam names the caller that will supply one.

`scripts/lib/suite-queue.js:92` takes *"{ alive = pidAlive, startTime = readStartTimeOf } = {}"*, and its module test fills both with fakes; `scripts/bg-run.sh:169` reads *"${WFC_BG_MEMINFO:-/proc/meminfo}"*, which its test points at a fixture file.

Where neither fits, remove the seam: create the dependency in place, and let the test reach it another way, through a temp directory, the real clock, or a binary stubbed at its §N7 var (#1374).

**Outside the rule:** an env var that tunes a value (a timeout, a ceiling, a poll interval), and one a program sets for its own child.

**The good reason to differ is a second adapter that lives outside the repo** — a parameter another release of the plugin fills, or an env var the founder or an adopter sets by hand — said at the seam, naming who fills it.

**A fake the repo owns is held to its production adapter by a contract test** (#2207). It binds a fake a change adds or touches, so each standing owned fake (`claude`, `ps`, `gitleaks`, `ruff`, `journalctl`, `dmesg`, the `/proc/meminfo`, `/proc` and `loadavg` fixtures) comes under it when touched, its live cases using free calls only: `--help`, or a read of the real `/proc/meminfo` through the same parser.

1. A fake this repo owns for a seam — a shared testkit fake, a stub executable standing in for a binary, or a fixture file standing in for a system file — is held to the production adapter by a contract test: one list of cases, run against both.
2. The real side runs where the production adapter runs: in the ordinary suite wherever the dependency is reachable with no spend and no side effect, and skipped elsewhere with the reason. For `gh`, `claude`, `ps`, `journalctl` and `dmesg` the live cases run on the founder's machine, never in CI. A case that needs nothing, such as a logged-out `gh` with an empty `GH_CONFIG_DIR`, runs wherever the binary is installed. A case that would spend tokens or write somewhere visible is kept as a recorded response, beside the command that re-records it.
3. The contract checks shape and verdict, not values: the real and fake answers give the same verdict from the production reader, and a JSON answer has the same keys and types. Its fixtures are synthetic.
4. One shared fake per owned port, and a test picks which answer it serves. A hand-written double for a port that has a shared fake is the breach.
5. Outside it: a fake whose production adapter is a single standard-library read with no behaviour of its own, such as an injected `now`, and a value passed in place of a port.

- *House*: the fake and its fixtures live in a `<port>-fake` module in the lib directory and the contract in `<port>.contract.test.ts`, which names its fixture paths as literals so a change to either selects it (§X10).

### §G8 · A new name for a glossary concept uses the glossary's term — **judgement**

**Every code kind.** Where the repo has a `GLOSSARY.md`, a new name for a concept the glossary defines uses the glossary's term and none of its *Avoid* words.

A homonym, a name for a different concept that happens to share a word, is outside the rule: `unreachableRemedy` at `scripts/lib/gh.js:310` names GitHub not answering, not the glossary's *Unreachable* page.

The push gate asks whether certificates attest a commit, so its verdict is `attestationOf` (`scripts/lib/test-pass-marker.js:1256`), never `coverOf`; a standards file's line pins are read by `parseLinePins` (`scripts/lib/standards-pins.js:176`), never `parsePins` (#1373).

### §G9 · State kept between calls has one writer, or writers named for what each does to it — **judgement**

**Program, library and hook module.** §N9 holds what a function is passed; this holds the state it reaches without being passed: Fowler's Global Data smell, and the other half of his Mutable Data smell (#1308, #1821). That state is a module-scope `let`, a module-scope object, array, Map or Set, or `process.env`. It is written by one function, or only by functions whose names say what each does to it, so a reader finds every write from the declaration. Another module never writes it directly, only through one of those functions. `process.env` has no declaration, so each variable counts as state of its own, and a write through a general setter such as `setEnv` is its caller's. The breach is a second writer named for something else.

`scripts/lib/suite-handoff.js:162-180` keeps `report` behind `fillRunReport` and `takeRunReport`, declared beneath it. `scripts/session-arbiter.js:171-181` keeps its oracle memo behind `listedOnce` and `relistSessions`; `scripts/check-hook-liveness.js:397`'s `saidBeforeElseQueue` names the stamp it queues as well as the question it answers.

The fixes, best first: return the value, so the caller holds it; pass it in, so the write shows at the call site, where §N9 holds a program to it; or move each write into a function named for it, declared beside the state (Fowler's Encapsulate Variable).

**Outside the rule:** a memo its one getter fills; a binding set once at load and only read after; an environment variable set for a child process (§G7); and an environment variable test support sets for the code under test.

**The good reason to differ is state a signal or exit handler reads**, since nothing can hand a handler an argument. Each write sits beside its undo in the function that took the thing, and the declaration names the handler, as `heldMarkers` and `heldWorktrees` in `scripts/run-vitest.js` do; `releaseAndExit` drains both on a kill.

**Not test or shell, on purpose.** In a test, a setup hook resets the shared fake and each test writes the answer its own case needs, so the write and its reader sit in one test; a test reading what an earlier test left is order dependence, a different defect. A shell function hands back more than its exit status only by printing or by setting a global, so a global written by several functions is the language's return channel.

---

## §T — library code

§T2, §T3 and §T7 hold for a library in any language. The rest of §T, and every TypeScript spelling inside those three, is *Stack (`tsconfig.json`)*.

### §T1 · Library functions annotate their return type; components do not — **hard**

*Stack (`tsconfig.json`)*. Every exported *and* module-private library function carries an explicit return type, the trivial ones included, and an async function annotates the `Promise<…>`. Where the local §W hands this to a linter, raise only what it cannot reach — such as a non-component function inside a `.tsx` file, like a page's `generateStaticParams` (#1335).

A React component's JSX return type is left to inference — e.g. `export function Nav() {`.


### §T2 · Untrusted input is checked at runtime before its type is trusted — **hard**

Input from outside the library is narrowed by a runtime check before any code relies on its shape. A type assertion that no runtime check precedes is the breach.

*Stack (`tsconfig.json`)*: zero `any`. Untyped input is modelled `unknown` and narrowed before use — e.g. `Array.isArray`, then a `typeof` check on each element — and only then asserted (`as string[]`).

### §T3 · An invariant breach throws; an expected failure returns as an outcome — **hard**

- **Throw** a named error for a policy invariant that must stop the process, carrying the offending data as a field so the caller gets it programmatically rather than by parsing the message.
- **Return** an outcome value for an expected operational failure. Every failure route — a throw, a timeout, an unreadable answer — lands as an outcome with an empty result, never as a thrown error and never as an unreadable answer passing for "nothing found".

**Failing open is the defect here** — the opposite of §N5.

*Stack (`tsconfig.json`)*: the class subclasses `Error`, sets `this.name` in the constructor, is named `<Subject><Problem>Error`, and takes the offending data as a parameter property (`readonly fields: readonly string[]`).

### §T4 · The `interface` keyword for declared object shapes, `type` for unions and function types — **hard**

*Stack (`tsconfig.json`)*. The rule is the choice between the `interface` keyword and a `type` alias when declaring a named type: an object shape, a type literal `{ … }`, is declared with the `interface` keyword; a union, or a function type such as `type LlmPort = (prompt: string) => Promise<string>`, is a `type`. A type literal written inline in a signature declares nothing, so it is outside the rule (#1406). *Stack (`biome.json`)*: where the local §W hands the object-shape limb to Biome's `style/useConsistentTypeDefinitions` (#1327), a review leaves it to that rule. Biome's recommended `style/useShorthandFunctionType` refuses an `interface` holding only a call signature, so a review raises the function-type limb only where the repo's `biome.json` turns that rule off.

### §T5 · Every field and array in a library is `readonly` — **hard**

*Stack (`tsconfig.json`)*. Without exception; arrays are `readonly string[]`.

**Library kind only, on purpose.** A program's or a test's types are not held to it, because `readonly` guards the data a library hands to callers it does not know, and a program's or a test's types stay inside their file; a shared testkit's are read by tests alone (#1317).

### §T6 · No `satisfies`; `as const` narrows, an annotation declares — **hard**

*Stack (`tsconfig.json`)*. No `satisfies`. A const object wanting literal narrowing takes `as const`; anything with a declared shape takes an annotation.

### §T7 · Dependencies are injected; the library does no I/O — **judgement**

The clock arrives as a function, an external supplier as a one-function transport port, and the module header states that it performs no I/O, so every branch is exercised in-process.

**Two kinds of module at a web app's edge may do I/O, on the ground of a stack this rule cannot fit** (#1872). Each says in its §N2 header which it is, in place of the no-I/O statement, and names the suppliers it touches:

- **A production adapter** fills a port against a real supplier — the network, a database, the filesystem, `process.env`, an SDK. It holds the transport and nothing a test needs to reach: it branches on the supplier's answer only to turn a transport failure into the port's outcome (§T3). Next.js, for one, keeps these in its Data Access Layer (`import 'server-only'`).
- **A composition root** is a module the framework invokes as an entry point. It builds the adapters and hands them to the library. In the Next.js App Router, for example: a server-rendered `page.tsx` or `layout.tsx` and its `generateMetadata`; a `route.ts` handler; a `"use server"` function or module; `proxy.ts` (`middleware.ts` before Next 16); `instrumentation.ts`. In its Pages Router: a page's `getServerSideProps`, `getStaticProps` and `getStaticPaths`, which run only on the server, and a `pages/api/*` handler (#2061); the page's component hydrates in the browser, so it is a client component. Its body wires and delegates; a branch worth testing moves into the library behind a port.

Every other library module stays under the rule, and a client component is never either kind.

**A dependency with a legally load-bearing consequence is required with no default**, so no caller inherits that choice by accident (mantahostels#817). A timeout, by contrast, may default.

*Stack (`tsconfig.json`)*: the clock is `readonly now: () => Date`.

### §T8 · A list or map entry is read as possibly missing — **hard**

*Stack (`tsconfig.json`)*. The type check runs with `noUncheckedIndexedAccess`, so `arr[0]` and `record[k]` read as `T | undefined` and the code handles a missing entry on purpose (#1316, #1380). `tsc` has no per-path compiler options, so a repo keeping it off its tests sets it in a second config that extends its own.

**A finding is cleared by one of these shapes only:**

- restructure so nothing is indexed: `for…of`, `.entries()`, a destructure;
- move an existing length or presence check onto the element: read it into a local and test that for `undefined`;
- a regex capture group the pattern guarantees: read it through a helper that throws when the group did not take part — never for an optional group, `(…)?` or one branch of an alternation;
- an expected failure, such as a missing argument or a key absent from outside input: the code's existing failure route, a usage error or an outcome value (§T3);
- `?? null`, only where the declared return already includes `| null`;
- a broken invariant no restructure removes: throw an `Error` saying what was missing (§T3).

**Each of these is a breach**, since it silences the check and leaves the missing case unhandled: the non-null assertion `!`; `?? ""` or any default that changes what the code does; `?.` where the code used to throw; an `as` or JSDoc cast that drops `undefined`; `@ts-ignore` or `@ts-expect-error`; and a dead `continue` or other unreachable branch. §G3's written reason does not make one a clearing shape: a site none of the shapes fits is raised on a ticket (#1336).

**Test files stay outside the check** (#1316).

---

## §N — programs

### §N1 · CommonJS, and a shebang on an executable — **hard**

*House, Node programs only*. Every `.js` program uses `require`, never `import`, and an executable carries `#!/usr/bin/env node` as line 1.

A non-test `.ts` program is ESM; where it needs a CommonJS lib it reaches it through `createRequire`, because the lib is spawned as a plain node script by a bash hook and stays CommonJS. **Always `createRequire(import.meta.url)`, never `createRequire(__filename)`** (mantahostels#2191): `__filename` only resolves under Vitest's compatibility shim, so a non-test file copying it breaks when run directly by `node` — `scripts/vitest-inflight-reporter.ts:23` is the portable exemplar: *"const require = createRequire(import.meta.url);"*.

### §N2 · Every program, library module, hook module, shell script and test opens with a header block saying why — **hard**

Every program, library module, hook module and shell script opens with a block comment giving the filename, one line on what it is, then the *why* and the ticket that settled it. A test's header gives one line on what it pins, then the ticket, why the test is built the way it is, and what breaking it costs — for example, that it runs inside a throwaway repository rather than against the real one, and that it is a hard gate in CI, so loosening it loosens CI. Either header's why explains the code as it stands, never a change to it (#2351). A test header need not name itself or its subject, though it may: the runner prints a test's path on every result and failure, and a self-name goes stale on a rename (#1279, #1406).

**Capitalised sentence-heads mark a caveat the reader must not skim** — `scripts/guard-priced-options.js:359` *"EVERY FAILURE PATH IS SILENT AND EXITS 0"*.

### §N3 · The filename prefix is the contract — **hard**

A filename prefix selects a contract. Where the repo has families for a program's language, a new program joins one and takes its contract whole, or states in its header why it is not in one (§G4). Where its language has no families, it owes no such line, since a header saying "no family" carries no contract (#1250, #1406); nor does it take another language's family prefix unless it keeps that family's contract, so a Python hook that always exits 0 is never a `check-*` (#1406).

*House, Node programs only*: the four families, under `scripts/`:

| Prefix | Contract |
|---|---|
| `check-*` | gates through `runCheck` and the five-outcome alphabet (§N4) |
| `guard-*` | a Claude Code hook: fails open on a fault it catches, exiting 0; a deny-capable one fails closed when the harness ends it (§N5, §S3) |
| `generate-*` | writes a file, returns 0/1 from `main` and exits on it |
| `report-*` | files a GitHub issue, exits 0 — never fails a build |

The prefix selects a family only under `scripts/`. A skill's own scripts join none by name, so citing §N3 or §N4 against one on the strength of a coincidental prefix is a false finding (mantahostels#1189) — `.claude/skills/concision-pass/scripts/check-facts.js:12` answers to its own three-code alphabet. §G4 still binds it.

### §N4 · One place owns process exit, and the body returns a result — **hard**

A checking program's body returns a result and never ends the process itself; one function owns process exit. A subcommand that does no checking may exit on its own path; the rule binds the checking path.

Three sub-rules a reviewer may cite directly against a program reporting in the five-outcome alphabet below:

- **SKIP versus BROKEN turns on subject-versus-apparatus** (`scripts/lib/check.js:15-23`): what the checker is *asking about* is unavailable → SKIP; what it *reads the repo with* failed → BROKEN.
- **Severity is a property of the finding**; a caller-side cap such as `--warn` lowers the outcome only, never the findings, and cannot cap BROKEN (`scripts/lib/check.js:29-32`).
- **A bad invocation is BROKEN, never a finding** — `scripts/lib/check.js:323` *"Bad invocation is BROKEN, never a finding: nothing was checked."*

*House, Node programs only*: a `check-*` program delegates its reporting tail to `runCheck` from `scripts/lib/check.js` (mantahostels#994). Its body returns a small record (`{ okLine }` or `{ noun, count, data }`, contract at `scripts/lib/check.js:197-198`), or a Promise of one, which `runCheck` awaits, a rejection reading as a throw (#1586); and `runCheck` owns the exit — `scripts/lib/outcome-error.js:8` *"Thrown, not exited, so lib/check.js's runCheck stays the single place a process ends."* The five outcomes, stated once at `scripts/lib/check.js:8-13`:

```
OK      ran, found nothing                            exit 0
SKIP    could not run, and not the repo's fault       exit 0
WARN    real findings, deliberately not gating        exit 0
FAIL    real findings that gate                       exit 1
BROKEN  the checker itself cannot do its job          exit 2
```

### §N5 · A fail-open is written down, cited, and printed — **hard**

A program that swallows an error to keep working does so as a design choice that (a) is commented at the site, explaining the code as it stands and never a change to it, (b) cites the ticket that chose it, and (c) **where a human reads the output, is printed** (#2351). See §S3 for the shell half.

**Gated for Python** (#1830): the plugin's pre-commit refuses an `except` a commit adds to a program-routed `.py` that neither raises nor exits and cites no ticket, so (b) is a duplicate finding there. Whether (a)'s comment gives a reason, and (c), stay review's.

The `guard-*` family swallows every error and exits 0 — *"breaking a session is worse than missing one"* (`scripts/guard-priced-options.js:359-360`) — and `scripts/session-arbiter.js:2408` names the rule's source, *"catches to fail open (mantahostels#103 §6)"*. Printed: `scripts/pick-next.js:3285` *"Assigned, but no live session recorded a claim: fail open, and say so"*.

### §N6 · Output that must survive `process.exit` on a pipe is written synchronously — **hard**

Node programs. On any path whose output precedes a `process.exit` **and** whose stdout may be a pipe — every hook, every checker, and any script an agent runs through Bash — write synchronously, never through `console`: `scripts/lib/check.js:353-354` *"node buffers writes to a PIPE and drops whatever is still buffered at process.exit — and a hook's stdout is always a pipe."* The hazard is the pipe, not the call: a subcommand only a human runs at a terminal is outside it.

A bare `fs.writeSync` is not enough — `scripts/lib/write-fd.js:7-8` *"it drops the tail of a partial write without saying so, and it throws EAGAIN on a full pipe that is non-blocking"*. The writer loops until every byte is taken, waiting out EAGAIN up to a ceiling.

*House, Node programs only*: that writer is `writeFd` from `scripts/lib/write-fd.js` (#1676). A bare `fs.writeSync` to fd 1 or 2 stays only where a comment says why.

Stream discipline (`scripts/lib/check.js:34-38`): stdout is for machine readers (a `--json` envelope, Actions `::error::` commands); human text goes to stderr. A `SessionStart` hook inverts it, because its stdout is what is injected into the session — and it exits 0 unconditionally, BROKEN included, because a non-zero `SessionStart` hook is read as broken and dropped (`scripts/lib/check.js:1635-1638`).

### §N7 · An export nothing consumes is a breach, and a binary a test stubs or a machine may lack is injected at one named var — **judgement**

**An export nothing consumes is a breach of this rule, not a spare part.** Make the name file-local, or **keep it with a comment directly above the entry, naming the caller that wants it**. On the one-line form the comment goes above the whole block. The caller is never a test: an export only tests consume is §G6's.

**An external binary a test needs to stub, or a machine running the code may lack, is injected at one named env var, never by `PATH`** — `scripts/lib/gh.js:6-8` *"The binary is injected at one named point: WFC_GH, pointing at an executable. Tests set it to a stub"*. **One var per binary, repo-wide**, and a shell caller takes that same var rather than minting a name or shadowing `PATH` of its own (mantahostels#1374).

**Outside the rule: `git`, the repo's own runtimes and their package managers (`node`, `npm`, `python3`) and standard system tools (`free`, `tar`, `sh`, `bash`, `setsid` and their like)** — tests run these for real, and the few that fake one need every call to fail, which a decoy ahead of the real one on `PATH` gives as well as a var would (#1283, #1406). A test of a detached launcher can put a stub `node` there, or pass the code under test an exec function. One of these enters the rule when tests feed it chosen output, as they do `ps`, and an exit code chosen per call is chosen output: a decoy cannot pass some calls and fail others (#2266). `git` enters it so at `WFC_GIT` (#2581), `python3` at `WFC_PYTHON`, `npm` at `WFC_NPM` and `node` at `WFC_NODE`; elsewhere `python3` may be missing from a machine, and code that runs it handles that absence rather than taking a var.

*House, Node programs only*: a file that exports uses a single trailing `module.exports = { … }` of named functions, never the `exports.foo =` form — bar a file in a require cycle, which ends on a run of `exports.foo = foo;` lines instead, because a cycle hands a sibling its exports object before the file ends, so replacing that object leaves the sibling a half-filled one (`scripts/lib/arbiter-store.js`'s THE SPLIT RULE, mantahostels#1795).

*House*: the plugin's vars take a `WFC_` prefix — `WFC_GH` for `gh`, `WFC_CLAUDE_BIN` for `claude` (`scripts/lib/claude-bin.js:9`), `WFC_GITLEAKS` for `gitleaks` (`.husky/pre-commit`), `WFC_PS` for `ps` (`scripts/lib/admission.js`), `WFC_PYTHON` for `python3` (`scripts/run-pytest.js`, `scripts/bisect-step.sh`), `WFC_NPM` for `npm` and `WFC_NODE` for `node` (`scripts/bisect-step.sh`), `WFC_CURL` for `curl` (`scripts/lib/npm-install-host.js`) and `WFC_GIT` for `git` (`scripts/lib/git.js`).

**Reported, never gated** (mantahostels#1799): the plugin's citation checker WARNs each unconsumed name. **A file spelling the name counts as a consumer only if it is neither a test nor test support (§G6), does not define one of its own, and names the exporting module** — a `require` or `import` of it, or its basename in a `path.join` or a spawned command (#1616); a definer reading the name off an object is a consumer again, so a caller rebinding an import under its own name is safe. The scan is **textual**, so a name and module path spelled in a comment or a JSON value read as consumed. And the exemption is **the comment's presence, never its content**: any comment-shaped line silences the finding. A test's or test support's own exports are never scanned.

### §N8 · Every program `.js` is type-checked, and opting out owes a reason — **hard**

*Stack (`checkJs`)*. With `checkJs` on across the program `.js` files the repo's `tsconfig.json` includes, every file is checked at full `strict` and a new one needs nothing to opt in. No per-file `// @ts-check` pragma is owed (mantahostels#1464).

**Full `strict` is the bar, and the target is zero errors under it** — `noImplicitAny` is not relaxed for scripts alone (mantahostels#1392).

**§T8's missing-entry check is part of the bar** (#1380): programs are held to it as library code is, wherever `tsc` checks them.

**Cannot satisfy it? `// @ts-nocheck`, and say why in the header per §G3**, naming what the file does that defeats inference. The reason line is **machine-read**, so its spelling is fixed: `` NO type checking (§N8). `` followed by why. **Cost is not a reason** — a file declining on its own error count is one to convert, not to exempt (mantahostels#1397).

**Reported, never gated** (mantahostels#1464): the plugin's `scripts/check-scripts-typecheck.js` names every in-scope file carrying `// @ts-nocheck`, at WARN.

**A catch binding stays `unknown`, as `strict` types it, and is read through `instanceof Error` or the plugin's `caught` (`scripts/lib/caught.js`)** (#1329, ruled at #1317). A thrown value promises no field at all: a thrown `null` makes `e.code` throw inside the handler meant to fail open. A cast of the binding — `NodeJS.ErrnoException`, `Error`, a hand-written shape — is §T2's unchecked assertion unless a runtime check precedes it. **An `any`, on a catch binding or anywhere else, owes its reason in a comment beside it.**

**Annotate by hand, never through a generated pass such as TypeScript's `inferFromUsage` codefix** (mantahostels#1409).

### §N9 · A function returns its result rather than changing what it was passed — **judgement**

**Program kind only**: library code leans on §T5's `readonly` instead, which holds a passed record's fields and arrays but not a passed Map, Set or regex. A function returns its result rather than changing an object or array it was passed, so every value a call changes shows at the call site. A field write, a push, an in-place sort and a reset of a regex's `lastIndex` all count, and so does a write to an element of a passed list or through a destructured options field. `scripts/lib/issue-gate.js:126` runs a caller's regex on a copy rather than resetting it: *"const local = new RegExp(re);"*.

**The good reason to differ is a caller-owned accumulator or counter passed in for that purpose** — a findings list, a tally, a cache, the state a split-out loop step advances — the house shape (#1297). It is said at the parameter: in JS the `@param` description opens `accumulator:`, as at `scripts/lib/arbiter-core.js:1057` *"accumulator: each readable entry is pushed here"*; in Python a docstring sentence opens with the backticked parameter and calls it the caller's accumulator, as at `scripts/lib/transcript_corpus.py:232-233` *"accumulator: the skips are counted into it"* (#1375). A record handed in with one field for the callee to fill is an accumulator for that field alone, and the note names it. A record, a regex, a parsed document or a list handed in to be read is never an accumulator.

---

## §X — tests

### §X1 · Titles are behaviour sentences — **hard**

A test title is a third-person statement of the behaviour and never begins "should" — and it carries the *quality* of the failure, not just the verdict: *fails on a tracked file with no register entry, naming it*. A group names the situation or flag under test, lower case, often with the ticket that created it: *rotation — bounding a log nothing else trims (mantahostels#181)*.

*Stack (Vitest config)*: `describe`/`it`, never `test()` (mantahostels#991).

### §X2 · Isolation comes from a real seam, not from mocking — **hard**

A test fills its seam with a real temp directory, a real subprocess, an injected binary or an injected dependency. Replacing a module the code under test imports is the breach, and the fix is usually that the code needs a seam (§T7, §N7).

**A spy is judged by what it is for** (#684). Three uses are sanctioned: capturing output (`process.stdout`/`stderr.write`, `console`, `fs.writeSync` to fd 1 or 2); watching a real call it lets through; and forcing a failure no real seam reaches, **with the reason no real seam reaches it written at the site**. A spy standing in for a collaborator the test depends on, where a temp directory, a subprocess or an injected dependency would do, is the breach.

Prefer a shared testkit's fake to a hand-rolled one; for a port the repo owns, §G7 requires it.

- *Stack (Vitest config)*: the breach is `vi.mock`; `vi` itself is for spies, env stubs and waits.
- *House*: a test reaches `gh` through `WFC_GH`, pointed at a stub executable, never through a `PATH` prepended with a fake.

### §X3 · A program test is black-box, and asserts the message as well as the code — **hard**

A case that runs a file as a program — a top-level script, a lib module's `require.main === module` path (#686), or a Python module's `if __name__ == "__main__":` path (#2249) — runs the real program **end to end** against a throwaway directory it creates and removes: never a unit of it, and never a mock standing in for it.

Both halves are asserted: the exit code, against §N4 where the program is a checker, *and* that the output names the offending thing **and the way out**.

**A builder earns a docstring where its name and signature do not already say what it builds** (mantahostels#3118) — why the builder exists at all, or which real-world act it stands in for. What an absent argument means is §X5's, and citable there; outside it, do not raise a missing docstring against a builder whose name and signature are the documentation.

**A module test is the deliberate opposite** — in-process, with injected deps, and held to §X6 instead: a lib test that imports its module and calls it, and any library-kind test. Do not cite this rule against one. A file holding both kinds owes it on its program cases only.

- *Stack (Vitest config)*: `// @vitest-environment node` as line 1, named local builder arrows, and a `beforeEach` minting a temp directory via `mkdtempSync`, a git repo where the program reads git state, with an `afterEach` removing it (#1406).
- *House, Node programs only*: **run the program through `scripts/lib/run-in-process.js`, not a subprocess** (settled at mantahostels#1951). It loads the script as the entry module of the test process and reproduces the exit code, both streams, argv, cwd, the environment and fd 0; what it does not reproduce is at the head of that file. **Three shapes keep a spawn, and each says so where it stands**: a timeout or a signal, two processes running at once, and a real fd. An async entry point goes through `runInProcessAsync` (mantahostels#1944), so a file that still spawns for that reason states which of its preconditions the script fails — no `require.main` guard, no exported `main`. A spawn kept for any other reason owes the reason in the file's header, per §G4.

### §X4 · A regression case cites its incident and is paired with a positive case — **hard**

Tests of any extension. A `#N` reference names the regression the case pins (mantahostels#991) — e.g. a title ending *mantahostels#137 (the hook reads the exit status)*.

Every regression case is paired with a positive case proving the signal still fires.

### §X5 · A test builder says what an absent argument means — **judgement**

A test builder with a nullable or optional parameter states in a docstring what that parameter's absence means, unless the builder's own body shows it (#1317 Q4, #1330). Absence is a `null`, an `undefined`, an omitted parameter or option field, or a Python `None` default. The body shows it where a reader learns what the absence builds without opening another file, a testkit's option type or the module under test: a branch or default on the parameter whose outcome reads plainly, the value written unchanged into the fixture it returns, or a hand-off to a builder in the same file that shows or states it.

### §X6 · A module test checks what the interface returns or does, never the internals — **hard**

A module test, §X3's in-process kind, asserts what the module's interface returns or does: the value returned, the files or records left, the output written, the calls made on a dependency it was handed. It never asserts the module's internal state, or how often its internals were called (#1308 Q4). A spy on captured output, or on an injected dependency, is at the interface and conforms; so is counting the calls a test's own fake receives. §X2's watched real call is held to this too. A breach owes the written reason a hard rule asks for, beside the assertion: for instance, a test counting an internal call because no return value shows the cost it guards (#1497).

### §X7 · Deepening or replacing a module deletes the old module's tests the new ones cover — **judgement**

When a module is deepened or replaced, the unit tests of the old module that the new module's tests now cover are deleted in the same change (#1308 Q7). A program keeps its §X11 boundary set; its other program cases are deleted under §X11 once a module case covers them (#2206).

The good reason to differ: the old module still runs on a path the new module's tests never reach, such as a caller of its own. The kept test says so at the site.

<!-- rule:test-run-cost:begin -->
### §X8 · A new test costs no more to run than its fitness needs — **judgement**

It binds the test cases a change adds or rewrites (#1771).

1. Build an expensive fixture, index or parse once per file. Each test that writes gets a fresh copy; each that only reads gets a read-only view. Key any cache on every input it reads.
2. Reach a state by seeding it, or a subject with a real dependency removed, and keep one case on the real call or dependency. For a program with a core, the real call is each production adapter its shell wires, crossed once for real: fs and git in the test's temp directory, and a binary at its §N7 var (§X11 item 3). *House*: `gh` is crossed through `WFC_GH`, its stub held to the real binary by §G7's contract test. Any other program test's process boundary stays §X3's.
3. Replace a per-case search over a shared input with one pass, proven byte-identical to the old output on the real input and on planted variants.
4. A change made for speed proves the test still fails: one mutation per changed assertion, reverted, named in the commit message.
5. A new test file that the suite's run-cost report names over budget is made cheaper, or its header says why (§G4). A line the report marks pre-existing is excepted.

- *Stack (Vitest config)*: build in `beforeAll` or at module scope, copy fresh in `beforeEach`. §X3's `beforeEach` temp-directory clause still holds: the copy lands in the directory `beforeEach` mints. `.each` is no speed lever, since each row still runs its own setup.
- *Stack (pytest config)*: build in a `module`-scoped fixture and copy in a function-scoped one. Under xdist, a build stays in its own worker's directory, never a path another worker shares.
<!-- rule:test-run-cost:end -->

Judge (4) from the full commit messages, `git log <fixed-point>..HEAD` with no `--oneline` (#1848). Judge (5) from the over-budget lines the dispatching session hands over; where none were handed over, the finding says (5) was not judged. A good reason to differ: a fixture cheaper to build than to copy, under (1); a subject with no seedable state, under (2); or a file whose cost the run's own load explains, shown by a re-run at low load, under (5).

<!-- rule:test-time-seam:begin -->
### §X9 · A test asserts time through a seam, never through wall time — **hard**

A budget, timeout or deadline is asserted through an injected clock or a count of what was done. Never assert real elapsed time measured around the call (mantahostels#2035, mantahostels#3535). A shipped timeout that is itself the guarantee is never shortened to make a test fast. A case that must cross the real clock (a signal, a kill, a process timeout) says why at the site.

- *Stack (Vitest config)*: fake timers or an injected `now`.
<!-- rule:test-time-seam:end -->

<!-- rule:test-reads-visible:begin -->
### §X10 · A test names what it reads where the repo's test selector can see it — **judgement**

A test that reads a tracked file at runtime names it as a literal path, in the test or in a helper it loads directly, so a change to that file selects the test. Where it cannot, its header carries a `full-sweep-only:` line saying why, and the test runs only on a full run. This binds every test, standing or new: a read the selector misses loses an assertion, not time, so no #1771 exception reaches it.

- *Stack (read-edge manifest)*: the read shapes the plugin's read-edge extractor (`scripts/lib/test-read-edges.js`) attributes, and the shapes its header lists as getting no edge, are the shapes this clause means. A read in an unseen shape, with no `full-sweep-only:` line, is the breach. `node <plugin root>/scripts/generate-test-read-edges.js --unseen` lists each one the extractor can judge; its header names the reads it cannot.
<!-- rule:test-reads-visible:end -->

`judgement` because a two-hop helper chain shows only when the helper is opened, not from the diff alone, and whether a read reaches a tracked document or a fixture the test wrote also needs a reading.

### §X11 · A program with a core keeps its boundary set end to end — **judgement**

A program whose logic sits in a core keeps its **boundary set** as program cases under §X3; its branch cases are module cases on its core under §X6 (#2206). The boundary set, where one case may cover several items:

1. Each exit path: every exit code the program's exit owner (§N4) can produce, with its stream, asserting code and message.
2. Each input channel the shell reads: argv, a bad invocation included; each env var; fd 0.
3. Each production adapter the shell wires, crossed for real once, as §X8 (2) spells out.
4. The boundary shapes by nature: §X3 House's three spawn shapes (a timeout or a signal, two processes, a real fd), a §N5 fail-open, a §N6 synchronous write. Where a case spawns the program, as Python's `sys.executable <program>` does, this item reduces to the §N5 fail-open.
5. A §X4 regression case whose incident was at the boundary. One whose incident was a branch moves to the core with its citation and positive pair.

Three conditions hold it:

1. The core returns the exit outcome and the complete message text.
2. A module case uses a fake only where §G7's contract test holds it to the production adapter; otherwise the real dependency, in-process.
3. A program case is deleted only in the change that adds a module case asserting the same outcome, code and message, and each moved assertion carries §X8 (4)'s mutation proof.

A shell branches only to (a) choose which core entry to call from argv or the subcommand, (b) turn the core's outcome into an exit code and a stream (§N4), or (c) fail open on a missing or broken adapter (§N5). Any other conditional in a shell — one choosing what is written, what text is built, which exit is taken, or whether an adapter is called — is a finding. For a ported guard, the shell is the hook command line plus its Node entry, and the hook line holds no logic (#2247).

A program case runs a top-level script, a lib module's `require.main === module` path, or a Python module's `if __name__ == "__main__":` path; a case calling a core function is a module case (#2249).

It binds the cases and shells a change adds or rewrites, as §X8 does. A program with no core is not in breach. A Next.js composition root owes no boundary set (#2249).

- *House*: a `check-*` program's exit paths are each of the five outcomes it can reach.

`judgement` because whether a shell's conditional dispatches or decides needs a reading: argv dispatch and a branch on output look alike to a lexical check (#2247).

---

## §S — shell

*Stack (`*.sh`)*: shellcheck at `--severity=style` (#1315 Q2) refuses an unquoted expansion (`SC2086`), `read` without `-r` (`SC2162`), a `$?` test on the next line (`SC2181`) and a `source` it cannot follow (`SC1091`).

### §S1 · Every expansion is quoted — **hard**

Binds wherever no shellcheck gate refuses `SC2086`: a repo with no gate, a script outside the gate's file set, or a gate that excludes the code or runs at `--severity=warning` or above. §0's floor gives the shipped gate's file set and severity, the local §W any gate of the repo's own, and its changes table any switch-off of the stack clause above (#1350).

### §S2 · Every `source` line carries a `# shellcheck source=` directive — **hard**

The directive names the real path where the sourced file is in the repo (`# shellcheck source=scripts/lib/<lib>.sh`). Where it is not — an adopter sourcing a plugin lib through `$WFC_PLUGIN_ROOT` — it reads `source=/dev/null`, with the reason on the same line.

*Stack (`*.sh`)*: a shebang-less file that is sourced rather than run opens with `# shellcheck shell=<sh|bash>`, as `scripts/lib/precommit-gate.sh` does (#753).

### §S3 · A gate fails open by default and logs each swallowed error — **hard**

Any hook that gates an act. A missing tool, a payload it cannot parse or a library it cannot read ALLOWS the act rather than wedge every session at once, and each swallowed error leaves a log line.

**Fail open is the default, not the only answer** (#339). A limb may fail CLOSED only where the gate's header names it and its reason; its refusal is its own record. Judging a value the gate can prove — an empty variable target read as the cwd — is not a departure.

**The default covers a fault the gate catches itself; a gate that can refuse fails closed when the harness ends it** (#2670 Q1 (A)): a timeout, a start failure, an exit other than 0 or 2 or invalid JSON refuses the act where the harness lets the registration say so, as Claude Code's `"onFailure": "block"` does from 2.1.295.

*House*: a `guard-*.sh` logs through the plugin's `scripts/lib/guard-log.sh` (`gl_log`) and names its fail-closed limbs under a `LIMITS` header. `scripts/generate-plugin-hooks.js` writes `onFailure` onto each deny-capable registration.

### §S4 · Deny on a structured fact, warn on an inference — **hard**

A gate refuses only on a structured fact where the act has no legitimate use, and warns where it is inferring (mantahostels#103). A deny that a legitimate spelling cannot escape is a wedge, not a guard.

*House*: a guard never emits `permissionDecision` itself. Its core returns a `deny` or `context` decision, a refusal splicing the offending command in at the `@CMD@` placeholder through `scripts/lib/guard-verdict.js` (mantahostels#994), and `scripts/lib/guard-entry.js` owns the JSON shape (`:125-131`).

### §S5 · A script sets the shell options its kind needs — **hard**

A run script sets `-uo pipefail`.

A script that stops at its first failure also sets `-e`: an installer, a mode switch, a snapshot, a launcher or probe, where a half-done run must not go on. A script that goes on past a failure on purpose leaves it off. That covers a gate or other hook, which `-e` would end on an untested failure with no `gl_log` line, §S3's breach by default. It also covers a launcher, benchmark or instrument that records a failure and carries on.

A sourced library sets nothing. Husky hooks set `-e` and nothing else (#745): they fail closed, refusing the commit. Any other `sh` script sets `-u` alone, since dash has no `pipefail`.

Under `-u`, a guard reads a positional that may be absent as `${2-}`. An abort still owes §S3's log line. In a gate whose caller refuses on any non-zero exit, as a husky hook does, it fails closed, and the header names that limb.

