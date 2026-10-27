# Mutation testing — the ways a mutation test passes while proving nothing

An adopter's `AGENTS.md` §Supervision priors, written from
`scripts/templates/adopter/AGENTS.md`, requires the loop: break the fix,
confirm that specific test fails, then reverse the break. This repo has no
`AGENTS.md`; here the loop, and the bar on a whole-file restore below, are this
guide's own advice.

## Run the loop in one queue seat

**A scripted loop of many mutants waits in the suite queue once, not once per
mutant** (workflow-core#2918). Launch the driver through the seat:

    node scripts/queue-run.js --seat -- python3 <mutate.py>

and have it run each mutant as `node scripts/run-vitest.js <file> --queue`.
Inside the seat, each `--queue` run skips the queue and waits on the memory
rung alone; the rung charges each mutant's vitest while it runs, and the seat
nothing between mutants. A loop that launches `--queue` runs per mutant with no seat is the
slow form (workflow-core#2911). A per-mutant run without `--queue` is no shortcut: a launch
from inside a script skips the memory gate, which only sees the outer command
(docs/environment.md §6). `--seat` refuses a driver that is itself a suite,
such as `pytest`.

## Prove the mutation landed

- **`perl -pi -e 's/…/…/'` exits 0 when the pattern matches nothing**, so a
  mutant that "survives" may never have been applied — it reads as an
  uncovered guarantee. Use python with an exact string and assert the count
  first: `assert s.count(old)==1`.
- **An unescaped `&` in the *replacement* half expands to the whole match** —
  in `sed` always, and in bash `${var//pat/rep}` since 5.2 via
  `patsub_replacement`, which is **on by default**. Where the replacement
  contains `&`, `\` or `|`, use `perl -pi -e` or a python heredoc. Expect a
  clean mutation to fail *one* targeted test — a broad failure across many
  usually means the file was mangled (workflow-core#3059).
- **Never mutate to the empty string.** A generic helper of the form
  `sub <file> <needle> <replacement>` reversed by swapping the two runs
  `s/\Q\E/needle/g` on the reverse leg, and the empty pattern matches at every
  position, shredding the file (workflow-core#3059). A shredded `PreToolUse` Bash hook makes
  **every** Bash call in **every** session fail with `Syntax error: ")"
  unexpected` — recovery has to go through the Edit/Write tools, which still
  work. Mutate to something inert but non-empty of the same shape (`labelIds:`
  → `labelIdsZZ:`), so the reverse is a genuine two-way swap. Where you write a helper: refuse an empty needle *and* an
  empty replacement on both legs; abort unless exactly one substitution lands on
  each leg; and sha256 the file before the mutation, asserting it matches after
  the reversal.

**Supply a missing checker script by re-execing it, never by `require`ing
it.** A gate fixture that omits a script the gate under test invokes dies
`MODULE_NOT_FOUND`, hits the gate's fail-closed limb and exits non-zero — which
reads as a refusal and proves nothing (mantahostels#1998). The obvious repair, a one-line
`require('<real path>')` delegate, is worse: it defeats
`checker-new-faults.js`'s `require.main === module` guard, so the script loads
and runs nothing inside — the delegate exits 0, and the gate then reads *every*
fault as inherited from HEAD. Use
`writeCheckerDelegates` (`scripts/lib/precommit-gate-testkit.ts`), which
re-execs the real script in a child process (`spawnSync`) instead.

**A refusal assertion pins the refusal's reason, or says why it does not have
to — an exit code alone cannot tell a genuine refusal from the gate crashing
before it ever looked** (mantahostels#2019). Prior art to copy, by file and test:

- `scripts/pre-applypatch-gate.test.ts`, `"refuses when gitleaks itself
  cannot run, rather than passing vacuously"`.
- `scripts/check-guard-registry.test.ts`, `"fails when an Enforced rule names a
  guard that does not exist"` and `"fails when the guard exists but nothing
  triggers it, as UNWIRED"` — a structural pin off the checker's own `--json`
  envelope: `findings[0].detail`.
- `scripts/precommit-doc-map-gate.test.ts`, `"refuses the commit, naming the
  row and the regeneration command"` — a real-checker fixture, pinned on the
  refusal text naming the row and the fix command.
- `scripts/precommit-doc-map-gate.test.ts`, `"fails closed when the comparison
  cannot answer"` — a fail-closed message pinned distinctly from a refusal, so
  `BROKEN` and `FAIL` stay distinguishable.
- `scripts/prepare-commit-msg-gate.test.ts` — a causal pin,
  `expect(p.fired()).toEqual(["pre-commit"])`, naming which hook produced the
  exit rather than trusting the exit code alone.

**Git rename detection can void a pre-commit gate test.** Two staged files with
near-identical short bodies read to `git diff --cached` as one `R` rename rather
than a delete plus an add, so a test meant to prove `--diff-filter=ACMR` is
load-bearing passes even with the flag removed. Give the deleted file in such a
fixture a deliberately dissimilar body, so git cannot read it as a rename.

## Prove the killing test ran

- **A `vitest run <file> -t "<name>"` filter selects by test name, so it often
  skips the very test that covers the mutated line** — the run passes and the
  mutant reads as survived (mantahostels#504). Run the whole file
  unfiltered, or grep it for the test naming the behaviour and filter on that.
  **A narrowed run says so itself** (mantahostels#1230), on a line of its own after the
  summary: `FILTERED RUN — ran 1 of 8 tests in 1 of 123 files; 7 skipped; -t
  /ref/`. Its file denominator is the whole corpus, which vitest's own
  `Test Files 1 passed (1)` is not — that one counts the files it collected, so
  a one-file run reads as complete in its own terms. No line means the run was
  unfiltered.
- **A surviving mutation is as often a vacuous fixture as a missing
  guarantee** — check the fixture actually exercises the pattern before
  concluding either way: a fixture line can miss the pattern on one character,
  such as a backtick or a `${}` just before the keyword (mantahostels#358, workflow-core#3059).
  The mirror bug: filtering matches by slicing the text before `m.index` back
  to the line start works only when the pattern starts mid-line, so under a
  `/^…/gm` pattern that slice is always `""` and an "is this line commented
  out?" filter passes every match. Capture the prefix as a group (`/^([^#\n]*?)…/gm`) and test the group.
- **Run the suite with `GITHUB_ACTIONS=true` before pushing any change to the
  checker family or its tests.** `scripts/lib/check.js` writes
  `::error::`/`::warning::` workflow annotations to **stdout**, but only when
  `GITHUB_ACTIONS === "true"` — so a test that spawns a `scripts/check-*.js` and
  asserts on its output passes locally and fails only after the push (workflow-core#3059).
  Fix by spawning with `env: { ...process.env, GITHUB_ACTIONS: "" }`; annotation behaviour belongs to
  `scripts/lib/check.test.ts`, which sets the variable deliberately.
- **Clear `scripts/__pycache__` between mutating and restoring a Python file.**
  `.pyc` validation keys on source mtime **and size**, so a same-length edit
  restored within the same second still looks cached and Python runs the mutated
  bytecode — the suite then reports a failure against correct code (mantahostels#57, the
  pytest seam where this held after a clean restore).

## Reverse the mutation without clobbering a neighbour

**Never restore a mutated file whole from a copy.** When the inverse edit itself
refuses: a reverse `Edit` failing with `String to replace not found in file`
means a neighbour changed that same string, so **re-read the file, never fall
back to a copy** — the copy is what took three edits to `scripts/evidence-audit.py`
(mantahostels#250). After an exact-string reversal, confirm `git diff <file>` is **empty**.

## Test the ordering a mutation cannot reach

- **`/dev/full` aborts node only through `fs.writeSync`.** Piping a node
  subprocess's stdout at `/dev/full`, `console.log` swallows the ENOSPC and
  execution carries on at exit 0, while `fs.writeSync(1, …)` **throws**
  `ENOSPC: no space left on device, write` and the process dies non-zero. So
  `/dev/full` does test a "this side effect must not happen if the output
  failed" ordering, provided the code under test reports via `writeSync`, as
  `scripts/lib/check.js` does (workflow-core#3059). A script reporting some other way offers no
  route in, and its ordering has to be asserted on source order instead — checking each anchor `>= 0` first, since
  `lastIndexOf` returns `-1` and a bare `>` passes vacuously.
- **Differential-fuzz a `scripts/guard-*.sh` change against bash, never against
  your own reading of the payload.** Put a stub `git` (and `gh`) first on `PATH`
  that appends to a hit-file when it sees the operation in question, run each
  generated payload under `timeout 5 bash -c`, and treat the hit-file as ground
  truth. Score each payload three ways — truth, guard verdict before, guard
  verdict after — and count the two errors that matter: **false deny** (guard
  denies, bash runs nothing) and **miss** (bash acts, guard allows). Used at
  mantahostels#232 (a commit message quoting a shell command denied by `guard-branch.sh`);
  the harness is on that issue. Four
  traps:
  - A payload ending `echo it's fine` plus a real command is **unrunnable** —
    bash dies on the unterminated quote and executes nothing — so a deny there
    costs no real work and must be excluded from the false-deny figure.
  - A `cd /tmp` anywhere in a payload moves the judged tree, so the guard filters
    the command out and the test passes whatever the parser did.
  - **Vary the part of the payload the new code reads.** At mantahostels#232 the fuzz varied
    a commit message's body and the lines after it, never the *opening* command
    line, which is exactly what the new code inspected, and missed a hole
    `/code-review` found. A fresh reviewer is the control, not more payloads.
  - The guard runs with the *hook's* cwd, so run the harness from the repo root.
    Anywhere else, `git-tree.js`'s `treeClassifier` answers no to everything and every
    payload reports ALLOW, which looks like a clean result.
