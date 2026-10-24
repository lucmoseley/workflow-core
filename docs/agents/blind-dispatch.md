# Blind dispatch — keeping the answer out of a blind subagent's start context

A **blind** subagent scores, rates or judges something without seeing the
expected answer: a regression row's target score, a ruling, an earlier verdict.

## What leaks

Every subagent but Explore and Plan starts with a git snapshot **taken at
dispatch**: the branch, `git status` entries, and the five most recent commit
subjects. No dispatch can switch it off for one subagent (Claude Code sub-agents
docs, read 16 Oct 2026).

<!-- guard-registry:begin -->
- **Before a blind dispatch, read what its snapshot will show — `git log -5
  --format=%s`, `git status --short` and the branch name.** Where any of it
  names an item under test or its expected answer: hold back your own commit
  until the run reports, or give a commit that must land first a subject naming
  neither; where the commit has already landed, yours or a neighbour's, run the
  blind work through the recipe below. **Unenforceable** (#1783, which rejected
  a guard judging subjects as too noisy): whether a subject names an answer is
  a judgement no hook makes.
- **Then put `Blind-checked: <HEAD sha>` in the dispatch prompt; a fork is never
  blind.** **Enforced** (#1783): `scripts/guard-blind-dispatch.sh` refuses an
  `Agent` dispatch whose prompt or description says "blind" and carries no
  `Blind-checked:` line naming the current HEAD, and refuses a blind fork
  outright.
<!-- guard-registry:end -->

## The recipe — a child session with no git snapshot

```
CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1 claude -p "<the blind brief>"
```

The child starts with no branch, status or commit lines, and so does every
subagent it dispatches. The variable reaches the child's hooks too, so
`guard-blind-dispatch.sh` stands down there. `--settings
'{"includeGitInstructions":false}'` hides the snapshot as well, but no hook can
see a settings flag, so the guard still asks that child's dispatches for a
`Blind-checked:` line.

Evidence: #1783, on Claude Code 2.1.301.

The recipe hides the snapshot only. A child with Bash can still run `git log`
itself, so the brief bars that as it bars reading the answers.
