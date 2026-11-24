---
name: pressure-test
description: "Pressure-testing an agent-facing rule on a baseline agent. Use before shipping a new skill, a CLAUDE.md or AGENTS.md line, or a doc a skill points at."
---

# pressure-test

**A rule you have not watched an agent break is a guess about what agents get
wrong** — mantahostels#802 (the priced-options rule, written and then broken twice before a
guard held it) is what that guess costs.

The writing levers — hierarchy, progressive disclosure, hunting no-ops, clear
done-conditions — live in `${CLAUDE_PLUGIN_ROOT}/.claude/skills/writing-for-agents/SKILL.md`, vendored
from `mattpocock/skills` and re-pulled. Read it for the prose; this skill decides
whether the prose works. Point at it rather than copying it here: a copy goes
stale on the next vendor pull and the two then disagree.

## The loop

### 1. Ask what already covers this need — the always-loaded pool only

**What already covers this need, and why is a pointer to it not enough?**

Governs the always-loaded pool alone — the files `.claude/workflow-core.json`
declares under `alwaysLoaded` (workflow-core#33), four here,
`.claude/output-styles/core-voice.md` among them (mantahostels#1504). **Not** a skill,
**not** `docs/agents/`, **not** a guard: none of those are always-loaded, so
none pay the cost this question prices (mantahostels#1177, the ticket that measured the
pool's growth and ruled it).

Two shapes refused outright in that measurement: always-loaded prose
**restating a guard's own denial text**, and always-loaded prose **restating a
CI or hook message**. Either is a **navigation pointer**: a pointer waiting to
be written, not a rule. The hook or the CI check is already the enforcement;
the pool line just repeats what a session sees at the moment it matters anyway.

If the answer is "nothing covers it" or "a pointer isn't enough because
`X`" — where `X` is a concrete gap, not convenience — the rule is admissible;
carry on to step 2. If a refusal is right, record it in the resolution
comment of the issue proposing the rule, phrased as a pointer to the
mechanism that already covers the need. No register, no index — closed
issues are the store (`CLAUDE.md` §Ground truth).

### 2. Name the failure you are writing against

In one sentence, in behavioural terms: *"a session dispatches a question to the
founder as a bulleted list with no confidence band"*. If you cannot state it, you
are writing a preference, not a rule (`writing-for-agents` §Pruning, on
no-ops).

### 3. Build the scenario that puts a session under the pressure

The scenario is a **real task**, never a quiz. Asking a subagent "what should you
do before asking the founder a question?" tests recall; the rule fails in the
wild under *load* — a session mid-ticket, with a cheaper path available.

Reproduce the pressure that actually causes the breach:

- **Hurry** — the task is nearly done and the rule adds a step.
- **Ambiguity** — two readings of the rule, one cheaper.
- **Volume** — the rule sits in a file the session already scrolled past.
- **Plausible substitute** — a neighbouring convention that looks close enough.

### 4. Run the baseline — the subagent must not have the rule

Dispatch a subagent on the scenario with the rule absent from its context.

Dispatch it under `docs/agents/guard-registry.md` §Subagent dispatch — artefact path, timed checks,
turn ended in between. **A stalled baseline is no evidence**: re-dispatch rather
than infer what it would have done.

**Read the transcript, not the outcome.** A baseline that happens to comply tells
you the rule may be a no-op; a baseline that fails tells you *how* — and the how
is what the rule has to name.

### 5. Write the rule against what you saw

Name the observed failure in the rule, as `CLAUDE.md`'s convention lines name
their incidents (mantahostels#63, the session whose roadmap correction landed inside another
session's commit).

Then check its form:

- **A step that runs another skill** reads `Call the Skill tool with "<name>"`.
  Where the target carries `disable-model-invocation: true` the Skill tool
  refuses it, so the step reads "tell the user to run `/<name>`" instead.
- **A skill's description** takes the shape its invocation calls for:
  `${CLAUDE_PLUGIN_ROOT}/.claude/skills/writing-for-agents/SKILL-MECHANICS.md` §Invocation.

### 6. Re-run the same scenario, rule in context

Same task, same pressure, rule present.

- **Complies** → ship it.
- **Still fails** → re-emphasising the sentence is not the fix. Mechanical
  mistakes become deterministic checks; judgement calls become coding
  standards. A mechanical rule needs a guard (`${CLAUDE_PLUGIN_ROOT}/scripts/guard-*.sh`, wired in
  `.claude/settings.json`); a judgement call about code goes to
  `${CLAUDE_PLUGIN_ROOT}/docs/code-standards-base.md` where it holds in any repo, or the repo's local
  `docs/code-standards.md` where it does not, and `/code-review` cites it there; otherwise the
  process the rule describes is wrong. Always-loaded bytes are capped
  (`npm run check:context`).
  Building a guard: `docs/agents/guard-authoring.md` — the eight surfaces, the
  deny-vs-warn split, and the rule that a guard is not shipped until it has been
  seen firing through the real hook seam.
- **Complies for the wrong reason** — it read the rule as forbidding something
  wider — is a fail. Over-reach shows up as sessions refusing legitimate work.

### 7. Record what the baseline did

A `**Captured fact:**` comment on the issue being worked — what the baseline did
without the rule, in plain prose, marked consumed as you write it (mantahostels#2748). It is
the evidence for the rule's
`**Enforced**` / `**Advisory**` / `**Unenforced**` / `**Unenforceable**` claim if the rule ever
reaches `docs/agents/guard-registry.md` or an always-loaded file.

## When to skip it

- **A value, not a behaviour.** A figure in §B or a research finding posted on an issue is
  looked up, not obeyed. Nothing to fail.
- **A guard already refuses the action.** The hook is the test.
- **A one-line pointer to an existing body.** The body was tested; the pointer
  only has to be found, which `writing-for-agents` §Context pointers covers.
