# Workflow core

The machinery that lets many agent sessions work one shared repository at once: what a local suite run proves, and how a session earns the right to push or to report a result.

## Language

**Certificate**:
The record a green suite run leaves behind, one line in the marker store, a run that selected no test included — except a bare run under `landing`, which leaves none when it selects nothing, since no push there owes an attesting certificate. It attests a tree and a read closure, never a commit sha on its own.
_Avoid_: marker (the storage word), green, pass record

**Attests**:
What a certificate says of a commit: that every path the run's verdict depends on holds, at that commit, the content the run read. A sha match is one way to attest; a tree-and-closure match is the other. Several certificates attest a commit together when each holds at it and every change it carries was selected for by at least one of them.
_Avoid_: covers, proves, certifies

**Read closure**:
The set of paths a run's verdict depends on: the tests it ran, everything they import, the documents they read, and the roots that invalidate all of them. A full run's closure is every tracked path.
_Avoid_: coverage (a per-line figure, not a path set), scope (how much of the suite ran)

**Orphaned edit**:
An uncommitted change in the shared working tree that no live session holds, claims or wrote. Nobody may have abandoned it: its last writer can believe it belongs to someone else.
_Avoid_: stray dirt, abandoned work, neighbour's dirt (a live session's uncommitted edit, which has an owner)

**Founder hand-over**:
What an agent gives when work needs the founder's own hands, in four parts: every step the agent can take is taken first; each remaining step gives its literal text, where to paste it and what the founder should see; it ends with what to send back and what the agent then checks itself; and it sits at the end of the message. The long form is `rule:founder-handover`. A hand-over still open when the session ends sits in an open issue's body; chat walks the founder through it but never holds it alone.
_Avoid_: hand-off (passing an issue between commands), walkthrough, wizard

**Admission ceiling**:
The most sessions admission would let run at one moment, given the memory everything else holds then. It moves with that load, and the count actually running sits below it.
_Avoid_: capacity, target, average (a ceiling is none of them)

**Sustained concurrency**:
The time-average of sessions working on the machine while any is working, the founder's own included.
_Avoid_: concurrent sessions (ambiguous between this and a ceiling), slots

**Source repo**:
Someone else's repository a new repo starts as a copy of, its history carried over. Its git remote in the new repo stays named `upstream`.
_Avoid_: upstream (in prose, workflow-core relative to the repos that adopt it), fork (a GitHub relationship the copy does not have)

**Mod**:
A Claude Code plugin whose hooks are code run inside the session, not a separate process. It loads only where the folder is trusted, and sits above every settings hook.
_Avoid_: plugin (also names an installed bundle of skills and settings hooks with no code hooks), function hook (one part of a mod), extension

**Layered mod**:
A mod that runs beside the settings hook carrying the same rule, which stays in place and keeps the rule's marker. Every mod that carries a rule is layered; no settings hook is removed for a mod.
_Avoid_: migrated (a hook replaced by a mod and removed), ported, fallback (the kept hook is the rule, not a spare)

**Door**:
Whether a change can be walked back. A two-way door is undone by a later commit; a one-way door is not, and is named on the one-way list in `docs/agents/issue-tracker.md` §Every close that names a commit says whether it can be undone.
_Avoid_: blast radius (the autonomy ceiling's R1–R3 scale of what an action writes), reversible

**Founder-facing item**:
Work a session leaves that only the founder can finish: a deliverable still to act on, such as a draft to send; an act named only inside a comment, such as a check by eye; or a decision not yet answered. It counts as tracked only while an open issue carries it — never chat, a status line or a closed issue's comment.
_Avoid_: outstanding (the close line's word, which covers agent work too), loose end, follow-up

**Inventory**:
The founder-facing items a session's ending names, each by the open issue that carries it, or the plain statement that nothing waits on the founder.
_Avoid_: summary, hand-off, which names passing work on (#1178)

**Standards base**:
The one code-standards rulebook the plugin ships for every repo that adopts it, holding the rules true in any repo. Every repo reads the same text from the plugin; none keeps a copy.
_Avoid_: template (a starting file each repo then edits), copy, shared file

**Local standards file**:
One repo's own code-standards choices, kept in that repo and read beside the standards base. A repo with no choices of its own has none.
_Avoid_: template, override file (it may add rules as well as change base ones), copy

**Line pin**:
A `path:line` or `path:line-line` reference in a code-standards file to the lines that show a rule in practice. In the standards base, a line pin points into a file the plugin ships and is read at the plugin root.
_Avoid_: pin (also the release an adopter is locked to), citation (a `#N` tracker reference), anchor (the stored digest of a line pin's lines)

**Code kind**:
What a file is, for the code standards: a library, a program, a test, a shell script or a hook module. Rules bind a kind, never a directory, and the standards base's default path map routes each path to one.
_Avoid_: corpus (the files a rule was drawn from), surface (a checker's reach in §W), file type

**Stack clause**:
A clause of a standards-base rule that spells the rule for one tool, such as Vitest or TypeScript, and binds only where the repo has that tool's tell, such as a Vitest config or a `tsconfig.json`. A repo without the tell writes nothing; a local standards file may switch one off, or except named paths from the rule it sits in.
_Avoid_: house clause (a default keyed to no tool, on until switched off), tool rule (one a tool already enforces)

**Local rule**:
A rule a local standards file adds, with an id of its own, `§L` then a code-kind letter and a number, such as `§LX1`.
_Avoid_: override (it changes no base rule), extension, custom rule

**Exception**:
A row in a local standards file's changes table that exempts named paths from one base rule, with a reason and a ticket. Narrowing a base rule's scope is an exception over a path glob. It takes no id of its own; a finding cites it as "§X2 (base), excepted by local row 2".
_Avoid_: suppression (a smell the review does not raise), waiver, carve-out

**Switch-off**:
A row in a local standards file's changes table that turns one stack or house clause off for the whole repo. It never reaches the rest of the rule, a principle or a severity.
_Avoid_: exception (named paths, not the whole repo), opt-out, disable

**Unreachable**:
A page still stuck after at least three genuinely different free methods, each run, recorded with a `Tried:` list of each method and what it showed.
_Avoid_: blocked (one method's failure), down, inaccessible

**False limit**:
A hand-back that names something a tool cannot do which no session tried.
_Avoid_: limitation, can't, tool limit (a limit observed on a tried method)

**Standing yes**:
An act a Chrome child takes in the founder's profile without asking, reported afterwards: reading pages, dashboards and consoles, and changing a reversible setting only the founder sees.
_Avoid_: permission, pre-approval, auto-approve

**Commit route**:
The git operation a commit is made by: an ordinary commit, a merge, a rebase, a cherry-pick, a revert or an applied patch. It decides which commit gates the commit meets and how a refused one is cleared.
_Avoid_: replay path (only the rebase, cherry-pick and patch routes), commit shape (the spelling of the git command, which the commit-form guard judges)

**Send hand-over**:
The one route by which anything a person outside reads leaves: the founder himself sends the exact draft he approved with an agent, who at most sets it up as a pre-filled Gmail compose window. A yes to a purpose is a yes to a draft only.
_Avoid_: live yes (the retired tier where an agent sent), approval (of a purpose), go-ahead

**Sensitive path**:
A part of an adopting repo whose miss costs money or leaks data, declared by that adopter with the focus a reviewer brings to it. It is an area named and described, not a list of files, so it can be declared before any of its code exists. A change touching one earns more review than ordinary work.
_Avoid_: critical path (a scheduling term), hot path (a performance term)

**Mission-critical change**:
A change on a sensitive path that alters an access rule or a money calculation itself — who may read or write what, an amount, a redemption state. Touching a file on that path is not enough, and size has no part in it.
_Avoid_: high-risk change, production-bound change (every push is, where an adopter deploys on push)

**Live sensitive path**:
A sensitive path its adopter has declared relied on by real users or real money.
_Avoid_: in production, deployed (true of every push, where an adopter deploys on push)

**Escaped defect**:
A defect in a reviewed change that no review run raised and that a later fix found after the change landed.
_Avoid_: regression (one may predate the review), missed finding (says nothing of when it was found)

**House decision**:
A choice research cannot make, because it turns on something only the founder holds: the business's goals and limits, a fact about his world, his own preference, or which point to take on a curve research has measured. Only a house decision is put to him as a question.
_Avoid_: house choice, judgement call (a gap the session has not yet searched)

**House value**:
A value a house decision on record set. A value called house only because it is established, or because the founder accepted an agent's advice on it, is unsourced until traced to a source or to such a decision.
_Avoid_: house number, house rule (each said of values never traced), house clause (a code-standards default keyed to no tool)

**Untraced value**:
A value a decision relies on that has neither a source nor a house decision behind it: one an agent proposed, or one called house that was never traced. It stays untraced until research gives it a source or the founder makes it a house decision.
_Avoid_: agent-proposed (says where it came from, not whether it was ever checked), assumption (also said of sourced premises)

**Delegated decision**:
A choice that is neither a house decision nor an act hard to undo or seen outside, which the session makes itself and records for the founder to review and reverse — including one still caught once research is spent, its top two rivals still close or no option likely right, there being no confidence floor. The line is drawn per choice, not per topic, and is the same by day and by night: code structure and implementation detail are the session's, while a choice turning on his preference, such as the layout of a report he reads, is a house decision. The record is one call, `node scripts/record-delegated-decision.js <n>` with the entry's fields.
_Avoid_: autonomous decision, judgement call (each silent on the record the founder reviews)

**Research ladder**:
The three kinds of new evidence a session tries, in turn, on a choice still close, or with no option likely right, after one round of research: the founder's past rulings, the web or a vendor's docs, then one fresh subagent given the evidence so far. Each step is a **rung**; research is spent when every rung has been tried.
_Avoid_: escalation (says it gets louder, not that the method changes), more research (the repeat it exists to replace)

**Leading practice**:
How the leading professionals of a task's field do it and the tools they use, Claude-compatible ones included, ranked by evidence: a standard or field body's free guidance first, then named experts' verdicts with reasons, then adoption surveys and curated lists. A practice no source vouches for is unverified and is not leading practice.
_Avoid_: best practice (unranked), industry standard (only the first evidence tier), popular (adoption alone)

**Away mode**:
The machine's one refill loop scoped to every included workflow-core repo, bar any the founder names, picking the next ticket and launching it whenever a session finishes or parks and frees a slot. It starts only on his explicit ask (`refill-loop.js start --away`); `/pick-next` runs the same loop in normal mode, over its own repo and any he names, and never narrows a running away mode. It stops 24 hours after the last start or renewal, on request, at dispatch's allowance cut, or after three sessions in a row make no progress. Its launches, and normal mode's, are driven sessions (`docs/agents/autonomy-ceiling.md`).
_Avoid_: night mode, night loop (it is not tied to the clock), autopilot (says nothing of the 24-hour bound)

**Parked**:
Said of a ticket whose session ended waiting on the founder: it posted a house-decision round there, or the refill loop stopped it at a block it will not resume, such as a question, a permission prompt or an API error past retrying. The `parked` label marks it, applied by a `Stop` hook or the refill loop and never by a session by hand, so the loop never relaunches it, though `/pick-next` may still choose it. It comes off when a session claims the ticket or, where the `Stop` hook parked it, when he answers in that session.
_Avoid_: blocked (a native dependency edge), waiting (the `waiting:external` label, for someone outside), paused

**Morning review issue**:
The one issue filed each morning on workflow-core's tracker, covering every repo away mode serves, that lists, since the previous one, the delegated decisions still caught after the research ladder (still close, or with no option likely right), a count of the clear ones, a count of the tickets closed with a search link per repo, and every one-way close. The founder writes `reverse <n>` against an entry he disagrees with, and closes it once read.
_Avoid_: digest, daily report (each suggests every commit is listed)

**Primitive**:
The one way a repo does a recurring job, such as finding the host root or reading a JSONL file: a shared module, a file to copy, and the check that keeps every caller on it. A repo lists its primitives in its code standards.
_Avoid_: helper, utility (each names any shared code, not the one sanctioned way), building block, golden path (an opt-in default, where a primitive is checked)

**Heresy**:
A pattern practised against a primitive that agents copy from neighbouring files until it spreads, in code or in prose. Each heresy, once named, becomes a check whose message names the primitive to use instead.
_Avoid_: anti-pattern, code smell (neither says it spreads by copying), drift (the effect, not the pattern)

**Heresy sweep**:
A recurring agent pass over one repo's code and docs that looks for heresies not yet named and files each as a ticket.
_Avoid_: architecture scan (it hunts deepening, not copied patterns), audit, review (one diff, not the standing tree)
