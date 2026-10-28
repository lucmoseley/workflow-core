# Code standards — the core's local file

The core's own choices beside the plugin's standards base, `docs/code-standards-base.md`, which holds every rule and its §-id. `/code-review`'s Standards axis reads both. It changes the base only through its changes table and route rows.

## Changes to the base

None.

## Route rows

| Path | Code kind |
|---|---|
| `scripts/**/test_*.py`, `scripts/conftest.py`, `scripts/pytest_pass_plugin.py` | test: pytest's cases and the support files only pytest loads (#1262) |
| `scripts/**/*.py`, shebang or not | program, the `scripts/lib/` modules included (#1262) |
| `.claude/skills/*/types/*.d.ts` | hook module: a mod's `$.state` contract, typing the state its hooks module keeps (#3267) |

---

## §W — what tooling already enforces

**Check a candidate rule against base §0's floor, then this, before writing one, and a finding before citing one.** A breach a tool already refuses is a duplicate finding, not a standard: formatting, import order, `any` *presence*, `==`, unused variables, the `node:` protocol, nullish dereference, `catch (e): unknown`.

Measured at mantahostels#1537; pinned by `scripts/tooling-matrix.test.ts`, which fails naming the row a config change falsifies.

**"Enforced" is three claims, not one:**

- **on** — the rule is configured, or auto-enabled without being configured;
- **run** — a gate invokes the checker;
- **refuses** — that gate fails rather than warns.

A rule can be on and never run (nothing gated ESLint until mantahostels#1133), or run and never refuse (`tsc` at commit: base §0's `commands.typecheck` row).

### Which checker sees which surface

| Surface | Biome | ESLint | `tsc` |
|---|---|---|---|
| `app/**`, `lib/**` `.ts`/`.tsx` | yes | **yes — 38 rules** (mantahostels#999, mantahostels#1133) | yes, plus `noUncheckedIndexedAccess` via `tsconfig.strict.json` (mantahostels#1064) |
| `scripts/**` `.js`, `.claude/skills/*/scripts/*.js` | yes | **no — zero rules survive into its config** | in the program (mantahostels#1067) and checked, `checkJs` being on across it since mantahostels#1464 (§N8), plus `noUncheckedIndexedAccess` via `tsconfig.strict.json` outside test files (#1336) |
| `scripts/**` `.ts`, `.claude/skills/*/scripts/*.ts` | yes | no | yes (mantahostels#1138), plus `noUncheckedIndexedAccess` via `tsconfig.strict.json` outside test files (#1336) |
| `.claude/skills/wfc-delivery/{hooks,tests}/*.ts`, the delivery mod | yes | no | yes locally, against its own `tsconfig.json` and an untracked copy of the engine's declarations: `npm run typecheck`'s third pass (#854), skipped on CI, which has no copy (#1960) |
| `.claude/skills/wfc-liveness/{hooks,tests,types}/*.{ts,tsx}`, the liveness mod | yes | no | yes locally, as the delivery mod: `npm run typecheck`'s fourth pass (#865), skipped on CI (#1960) |
| `hooks/register.ts`, the plugin's entry module | yes | no | yes locally, against `hooks/tsconfig.json` with the liveness mod's engine declarations and contract: `npm run typecheck`'s fifth pass (#946), skipped on CI (#1960) |
| Every tracked shell file `scripts/lib/formatters.js shell-files --tracked` lists: the seven husky hooks, `.sh` and `.bash` files, and extensionless files with a shell shebang, minus `.gitattributes`' vendored and generated paths (#1828) | no | no | no |
| `.github/workflows/*.yml` | no | no | no |
| `*.py` | no | no | no |
| `*.md` | no | no | no |
| `app/globals.css` | yes | no | no |
| `.agents/skills/*/agents/*.yaml` | no | no | no |
| `scripts/win-interop-watchdog/*.ps1`, `*.vbs` | no | no | no |

Shell is shellcheck's (mantahostels#1134), which `npm run check:sh` runs in CI at `-x --severity=style --exclude=SC2016` (#1315 Q2, #1331, #3032), workflow YAML is actionlint's (mantahostels#1137), Python is ruff's at `select = ["E4","E7","E9","F","B","BLE001","N","PLR0917","RUF100"]` (mantahostels#1135, #1314, #1333, #1443), so a catch-all `except` names its exceptions or carries a `noqa`, whose reason base §G3 asks review to check, and a Python name breaking base §G5's scheme is refused, as is an exception class whose name does not end in `Error` and that carries no `# noqa: N818 - <reason>` (#1406 Q3 (A)). **Markdown is nobody's, by decision (mantahostels#1540)**, and so are the two Windows-side watchdog scripts (mantahostels#1131) — both under *Not measured, by decision* below. Biome cannot take Markdown: it has no `markdown` language key, so covering it means a new dependency, never a config line.

**The 25 `.yaml` files under `.agents/skills/` are vendored and get nothing** (mantahostels#1131). actionlint locates `.github/workflows` itself and never opens them; they are upstream's to fix, so a finding here would be unactionable.

Excluded from everything: `docs/`, `public/`, `skills-lock.json`, `hooks/hooks.json` (#946 — the plugin hook manifest, rendered by `scripts/generate-plugin-hooks.js`), `scripts/fixtures`, `scripts/templates` (#5 — an adopter skeleton's templates, whose `{{placeholder}}` does not parse as the language they template), `.claude/worktrees`, `.claude/tmp`, `.claude/settings*.json`, `.claude/skills/*/.claude-plugin/types` (#854 — a mod's untracked copy of the engine's API declarations, #1960), `.local` (mantahostels#2206 — sessions put throwaway git worktrees there, and a worktree's own `biome.json` reads as a nested root configuration Biome refuses on repo-wide, blocking every commit in the tree). `.claude/` as a whole is no longer excluded (mantahostels#1138), and Biome cannot re-include inside an excluded path, so no narrower spelling exists.

### Which gate runs it in CI

At commit, the core's `commands.check_staged` is Biome over the staged paths (mantahostels#179) and `commands.test` writes a test-pass marker, so no commit runs the suite.

| Checker | CI `Lint and tests` |
|---|---|
| Biome | refuses — whole repo |
| ESLint | refuses |
| `tsc` | refuses |
| shellcheck, through `npm run check:sh` | refuses |
| actionlint | refuses |
| ruff | refuses, in the `python` job |
| `scripts/check-swallowed-errors.js` | refuses — `--all` over the whole tree, in the `python` job |
| shfmt, `ruff format` | refuse — shfmt in this job, `ruff format` in the `python` job |
| Vitest, pytest | refuses |
| The read-shape warning, `scripts/generate-test-read-edges.js --check` | not run; `--unseen` lists every read the diff selector cannot attribute, on demand |
| The run-cost report, `scripts/run-vitest.js` and `scripts/run-pytest.js` (a new or changed test file over 10 s of its own wall time, base §X8 (5); pytest's in worker-seconds) | not run — silent under `CI` (#1797). Locally it **reports only, never refuses**: printed after every suite run through either wrapper, never at commit, and never changing the suite's exit code (#1883, #1884) |

Every push to `landing` runs the full suite, and the lander reads that run as its tester (#2413), so a pushed head's CI verdict lags it by one run: 8.2 min at worst, or up to 30 min where a red is re-run (measured on #3349). Four scheduled sweeps a day (mantahostels#3490) re-test the still tree. The cron asks for a 6h gap; GitHub delivers the slots late, and the gap is not this repo's to set (mantahostels#2204).

### Biome's effective set is wider than `biome.json`

`biome.json` names `recommended` plus 223 explicit entries, 28 of them `nursery`. **On top of that, Biome 2.5's `react` and `next` domains auto-enable off the installed dependencies**, so rules fire that the config never names: `correctness/useHookAtTopLevel` and `correctness/useExhaustiveDependencies` both fire at `error` on `app/**/*.tsx`, deliberately kept out of `biome.json` since they already fire this way (mantahostels#1616). Read the effective set, never the config file.

Deriving it: `biome lint --only=<rule>` **cannot** verify a rule's config took effect — it forces the rule on globally and ignores both configured severity and `overrides` (mantahostels#1518). Write a probe file at a real repo path and read `biome lint --reporter=json`. `--stdin-file-path` does not work with that reporter, and a probe outside the repo matches no `overrides` glob, so neither can test a path-scoped rule.

**Path scope follows #1318's merit ruling** (the re-judge of rules declined on corpus or fix-up cost). The `app/**`+`lib/**` override holds 15 rules today, each product-only on merit: `noImplicitCoercions`, `useMaxParams` (which `scripts/` carries under its own override, below), `useSimplifiedLogicExpression`, `noGlobalDirnameFilename`, `noProcessGlobal`, `noAwaitInLoops`, `noDelete`, `noCommonJs`, `noParameterAssign`, `noProcessEnv`, `noConsole`, `noEqualsToNull`, `noMisplacedAssertion`, `noUnnecessaryConditions` and `useArraySortCompare`. Cognitive complexity covers four paths under its own override, below. `nursery/noImpliedEval` is the reverse case: on repo-wide, off under `scripts/**` and `.claude/**`.

**#1318's defect and spelling rules refuse repo-wide.** A defect rule refuses code that is wrong wherever it sits (#1318 Q4 (A)). A spelling rule enforces one form where it reads at least as clearly and raises no false findings (Q1 (A)). Landed — defect: `useUniqueElementIds`, `noUnusedInstantiation`, `useConsistentMethodSignatures`, `useErrorCause`, `noShadow`, `noEmptyBlockStatements`, `noUndeclaredDependencies` (off under `hooks/**` and `.claude/skills/wfc-*/**`, where the engine supplies `claude-code`), `useReduceTypeParameter`, `useDomNodeTextContent`, `useIncludes`; spelling: `useStringStartsEndsWith`, `useArraySome`, `useRegexpTest`, `useFlatMap`, `useIndexOf`, `useExponentiationOperator`, `useShorthandFunctionType`, `useForOf`, `useArrayFind`, `noInferrableTypes`, `noExcessiveClassesPerFile`, `useNumberNamespace`, `useConsistentArrayType`, `noUselessUndefined`, `useAtIndex`, `noUnusedTemplateLiteral`, `useNumericSeparators`, `useExplicitLengthCheck`, `noNestedTernary`, `noNegationElse`, `noForEach`, `useConsistentTypeDefinitions`. **Do not raise what these refuse, on any path**: it is a duplicate.

**`nursery/useExplicitReturnType` refuses a missing return type in `lib/**/*.ts` and `app/**/*.ts`, tests excluded** (#1335). It is `nursery` under a caret pin, so a Biome bump is re-checked by `scripts/tooling-matrix.test.ts`. **Raise a missing return type only in a `.tsx` file's non-component function**; elsewhere in the library it is a duplicate.

**`complexity/useMaxParams` also refuses in the JS and TS under `scripts/**` and `.claude/skills/*/scripts/**`** (#1313), at Biome's default of 4 positional parameters — no measurement argued for another. Python's is ruff's `PLR0917`, at the same 4, over every tracked `.py` file (#1314). **Do not raise a long parameter list in JS or TS on any of these paths, or in any Python**: it is a duplicate.

**`complexity/noExcessiveCognitiveComplexity` refuses a function scoring over 15 in `app/**`, `lib/**`, `scripts/**` and `.claude/**`** (mantahostels#1518; widened by #1318 Q2 (A), #1400), at Biome's default. **Do not raise a tangled function on any of these paths**: it is a duplicate.

**`style/useNamingConvention` refuses base §G5's tool-checkable names repo-wide, tests included** (#1328, #1418): an all-capitals `const` below module scope, `describe`/`it` bodies included; a `let` or parameter in all-capitals; a snake_case local, parameter or class method, bar a shorthand destructure of an external key (`const { tool_input } = payload`); a class, interface or type alias not in PascalCase. **Do not raise these shapes on any path**: it is a duplicate. **Four limbs of §G5 stay review's**, since no selector expresses them:

- module-scope constants in `SCREAMING_SNAKE` — the `const` + `global` selector cannot tell a literal-valued constant from a `require` or function binding, so a top-level `const maxTries = 3` passes;
- React components in PascalCase — no selector marks a component;
- house object keys, type members, and object-literal and interface methods in camelCase — no selector separates them from external keys;
- `isX`/`hasX` predicates, `buildX` builders, `parseX` parsers, `readX` readers — no selector works by role or by type.

### A warning is a refusal here

`lint`, `check` and `check:staged` all carry `--error-on-warnings`; `check:eslint`, ESLint's entry point under `lint` and in CI, carries `--max-warnings 0`. So a rule sitting at `warn` fails `check:staged` at commit, and CI, exactly as an `error` does — never read a rule's severity as making it advisory. (`suspicious/noExplicitAny` and `style/noNonNullAssertion` are `error` outright, so they do not depend on this.) §G3 governs what a *retained* one owes; never also write a rule saying to avoid one.

### Not measured, by decision

- **Test coverage — declined outright** (mantahostels#1136): not measured on a schedule, not reported, not gated, Python included. The 39.5% figure for `scripts/` measures test *style*, not test absence: most of that corpus is driven by spawning a child process, which vitest's v8 provider does not instrument (mantahostels#1136). A floor would make "convert a subprocess test into an in-process import" the cheapest way to raise it, which stops testing the parts of the process boundary the husky hooks depend on that §X3's in-process seam does not carry, the shebang among them.
- **The mutation hold — off here, for the same reason** (#1851, #1871). `mutation` stays out of `modules`: Stryker's per-test coverage cannot see code a test spawns in a child, so on most of `scripts/` every mutant would read NoCoverage and refuse the commit.
- **Markdown formatting, linting and link integrity — all three declined** (mantahostels#1540, which holds the 26 August 2026 measurements; re-measure before quoting one). **Formatting** (re-judged on merit at #1822): no defect behind the gap, since nothing Prettier 3.9.10 changes at `proseWrap: "preserve"` renders differently in CommonMark. Its one structural change does harm here: it pads every table column to its widest cell, so a one-cell edit rewrites the whole table. The only setting that stops the padding, `proseWrap: "never"`, joins hard-wrapped lines, which is the rewrap that fights `concision-pass`. Biome has no Markdown formatter as of 2.5.15; re-measure when it ships one. **Linting**: the corpus passed every rule that carries meaning when measured, so there is nothing to ratchet. **Link integrity**: a checker scoped as hard as it can be still flags more legitimate prose than dead paths.
- **The Windows-side watchdog scripts — declined, because the only free checker is the thing they exist to catch** (mantahostels#1131). `scripts/win-interop-watchdog/` is the whole surface, 191 lines across `watchdog.ps1`, `launcher.vbs` and `task.xml.template`; re-measure that before re-opening this, since the decline is priced on it. Nothing in the repo imports or runs them, and `scripts/install-interop-watchdog.sh`, which copies them to the Windows side, is shellcheck's already. `[System.Management.Automation.Language.Parser]::ParseFile` needs no module, but it reaches the file across the WSL-to-Windows interop bridge, and a wedged bridge is the exact fault `watchdog.ps1` was written to catch — so a gate on it would block commits precisely when the machine is already broken. **PSScriptAnalyzer, the real linter, is not installed and has no npm route**, so adopting it means a Windows-side `Install-Module` — a third hand-placed toolchain after shellcheck and actionlint. **Failure here is loud**, unlike the silent fail-open that justified shellcheck at mantahostels#1134: a broken watchdog shows up as the launch hang it was written to prevent.
- **The CRAP score (Crap4J's `comp² × (1−cov)³ + comp`) — declined** (mantahostels#1131): both its inputs are missing — per-method coverage is declined above (mantahostels#1136), per-method complexity was unconfigured until mantahostels#1518. CRAP cubes `(1−coverage)`, and mantahostels#1136 measured this corpus's uncovered fraction as an artefact of test *style*, so CRAP would rate the best-tested guards as the most defect-prone. **Re-read rather than re-derive once product code lands**: the decline is priced against a pre-launch landing page plus repo machinery, not against the auth/RLS, availability, money and reward-code paths CRAP is designed for.
- **Function and file length — declined** (mantahostels#1518): `complexity/noExcessiveLinesPerFunction` and `style/noExcessiveLinesPerFile`, each on its own measurement. Length and tangle identify near-disjoint sets in this corpus, and most length findings are table-driven test cases (mantahostels#1518). Cognitive complexity was adopted instead, at Biome's own default rather than a corpus percentile.

### Unclaimed by any tool

`exactOptionalPropertyTypes` and `noPropertyAccessFromIndexSignature` are the only `tsc` flags still off; mantahostels#1065 and mantahostels#1444 turned the other six on. Everything else the base rules on is unclaimed by construction — §T1's component limb and a `.tsx` file's helpers, whether to throw at all versus return an outcome (§T3 — `style/useThrowOnlyError` only catches a throw of a non-`Error` value, not this choice), what a retained escape hatch owes (§G3), the exit-code alphabet (§N4), fail-open in guards (§N5, §S3), which shell options a script's kind needs (§S5). **Adding a rule here means first showing its row above is empty.**

### Base rules, as the core's tools meet them

- **§G3** — Biome already refuses `any` and `!`: `biome.json` pins `noNonNullAssertion` (mantahostels#1120) and `noExplicitAny` (mantahostels#1380) to `error`, so either needs a `biome-ignore` carrying the reason §G3 asks for. Biome reads all of `.claude/` since mantahostels#1138 bar `worktrees` and `settings*.json`, so both rules bind there too. In non-test code, a `require` of an untyped CommonJS module is the only reason this corpus has ever accepted for an `any` that owes one (mantahostels#991). An empty `catch`, or any empty block, is refused by Biome (`noEmptyBlockStatements`, #1383) unless it holds a comment, so review judges only whether that comment is a reason.
- **§N8** — enforced (mantahostels#1062): `npm run typecheck` gates CI hard; on a host deploying to Vercel (`"deploy": "vercel"`, which the core does not declare), its `next build` checks the same program on every push to `main`, so an error fails production rather than a gate.
- **§S2** — no shellcheck exclusion beyond `SC2016` is ever added (#1315 Q2, #753, #3032); `scripts/precommit-shellcheck-gate.test.ts` refuses one, so review leaves it to that test.
- **§T4** — its object-shape limb is Biome's: `style/useConsistentTypeDefinitions` refuses a `type` alias for an object shape repo-wide (#1388), so review leaves that limb to it.

---

## Smells not raised

Baseline smells this repo's practice deliberately contradicts. **Do not raise these** — a documented repo standard overrides the baseline.

- **Middle Man**, on `scripts/lib/gh.js`, which wraps the `gh` binary and adds little of its own. That is the point — *"they route every call through here and never name the binary themselves"* (`scripts/lib/gh.js:1-3`), which is what makes `WFC_GH` injection possible (base §N7).
- **Primitive Obsession**, on the three-value exit-code alphabet in `scripts/lib/check.js:8-13`. The integers are the process contract with CI and with the shell; wrapping them in a type would not survive the `process.exit` boundary.

## Out of scope

- **The two checks mantahostels#1015 measured and declined, one since re-judged.** `useExplicitType` — declined on a real false finding, line 34 of mantahostels's `lib/review-strip/fake-llm-port.ts` (**mantahostels#1066**). `useExplicitReturnType` was declined beside it on corpus practice; #1316 Q4 re-judged it on merit, and it enters at `error` scoped to the library kind (`lib/**/*.ts`, `app/**/*.ts`, tests excluded), which keeps §T1's components unflagged, with #1335. `exactOptionalPropertyTypes` — declined at **mantahostels#1065** because not one of its findings was a defect, so there is no convention to describe.
- **Three more `tsc` flags, declined at mantahostels#1444.** `noPropertyAccessFromIndexSignature` — no defect stands behind it: it changes no type and catches no typo, the missing-key defect being `noUncheckedIndexedAccess`'s, and it fights Biome's recommended `useLiteralKeys` (re-judged on merit at #1316 Q6); **do not raise `obj.foo` over `obj["foo"]`**. `erasableSyntaxOnly` — **do not raise a parameter property** (`constructor(readonly x: T)`); nothing here runs `.ts` under a type-stripping runtime. `isolatedDeclarations` cannot run at all against `allowJs`.
- **`.claude/`'s prose and configuration.** The code under `.claude/skills/` — skill scripts, a mod's hooks module and their tests — is routed by the base's map like any other, and covered by Biome and `tsc` since **mantahostels#1138**.
