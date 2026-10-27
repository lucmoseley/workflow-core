#!/usr/bin/env node
/*
 * guard-pull-form.js — PreToolUse guard: divergence on the shared `main` is
 * reconciled by fast-forward or not at all, `main` is never moved backwards
 * (workflow-core#765), and the shared tree's uncommitted work is never discarded wholesale
 * (workflow-core#768). The core is lib/pull-form.js.
 *
 * Why: the working tree is repo-global, so a `git pull`, `git merge` or `git
 * rebase` that does anything but fast-forward rewrites or re-parents commits
 * every parallel session can already be holding. On mantahostels#245 a `git
 * pull --rebase` rebased and re-picked a commit in the shared tree — the
 * failure of mantahostels#63 (one session's roadmap correction landing inside
 * another's commit) and mantahostels#87 (the wrong-branch commit), reached
 * through the one shared resource those guards do not cover: the ref.
 * `--ff-only` is the only spelling that cannot rewrite a neighbour's commit.
 *
 * DENIES, not warns: mantahostels#103 set deny on a structured fact where the
 * action has no legitimate use. Every legitimate reconciliation has a route
 * that passes — `--ff-only`, a repo configured `pull.ff=only`, or, for a
 * divergence that needs a real merge, the throwaway worktree the rule's own
 * recipe gives (workflow-core#290) — so a deny cannot wedge ordinary work.
 *
 * DENIES-THROUGH: lib/guard-entry.js — `run` writes the core's deny, so the
 * registration carries `"onFailure": "block"` and a crash or timeout refuses.
 *
 * FAILS CLOSED on a core that throws (lib/refuse-on-throw.js), but for a
 * repo git cannot resolve, which stays open, recorded.
 *
 * LIMITS
 *  - The rule it prints is docs/agents/rules/pull-fast-forward.txt
 *    (mantahostels#1648), or its `-landing` twin with the `landing` module on
 *    (workflow-core#2409). It prints it on two exclusive limbs (spec mantahostels#1762):
 *    inside the refusal, and, where nothing was refused, as context before an
 *    allowed `git pull --ff-only`, a bare pull the repo's `pull.ff=only` has
 *    already made safe, `git merge --ff-only`, or a bare pull whose tree could
 *    not be resolved (workflow-core#308) — latched once a session. `git pull --help` and a
 *    merge or rebase being finished or unwound are handed nothing.
 *  - It guards `git pull`, `git merge` and `git rebase`. `git fetch` is always
 *    safe — it moves no local ref. The rewrite reached directly after a fetch,
 *    as `git merge origin/main` or `git rebase origin/main`, is denied
 *    (mantahostels#245, workflow-core#290): a diverged session reconciles in a throwaway
 *    worktree and fast-forwards the shared tree onto the result.
 *  - It also refuses REWINDING `main` (workflow-core#765), docs/agents/rules/main-rewind.txt:
 *    a `git reset` naming a commit other than HEAD in the shared tree, and —
 *    from ANY tree of the repo, `main` being one ref for all of them — `git
 *    update-ref refs/heads/main`, `git branch` forcing, deleting, renaming or
 *    copying onto `main`, and `git checkout -B main`/`git switch -C main`. A
 *    reset FORWARD is refused too: the guard never compares the commit with
 *    `main`, and the refusal names `git merge --ff-only` for that case. `git
 *    branch -f`/`-D`/`-M` and `checkout -B` naming `main` are refused by git
 *    itself while any tree has it checked out, so in a linked worktree a
 *    branch word it cannot read passes on those — unless
 *    `--ignore-other-worktrees` lifts git's own refusal. `git update-ref HEAD`
 *    is refused in the shared tree only, and `--stdin` everywhere, because
 *    what it updates is unread. Pathspec resets pass, as does a `git reset
 *    --soft` or `--mixed` naming HEAD or nothing. Still unseen: `git fetch
 *    --update-head-ok . +<commit>:main`, `git symbolic-ref`, `git cherry-pick`
 *    and `git am` (which add commits rather than drop them), and `git revert`,
 *    which the pre-commit stack gates. Any other unreadable commit, ref or
 *    branch word, or an unresolved tree where the verdict needs one, FAILS
 *    CLOSED (workflow-core#301).
 *  - It also refuses DISCARDING the shared tree's uncommitted work (workflow-core#768),
 *    docs/agents/rules/shared-tree-discard.txt: in the shared tree only, a
 *    `git reset --hard`/`--merge`/`--keep` naming HEAD, the checked-out
 *    branch or nothing; a `git checkout` or `git restore` whose pathspec
 *    covers the whole tree, or is file-fed; a forced `git clean` naming no
 *    path or the whole tree, or an unforced one where `clean.requireForce` is
 *    false or `-i` is spelled; a `git stash` push or save naming no path or
 *    the whole tree; and a forced `git checkout`/`git switch` onto a branch. A
 *    pathspec covers the whole tree when it resolves to the root or above —
 *    `.` from the top, `..` from a subdirectory, `:/`, `:`, `:(top)`, `*`,
 *    `**\/*.md` — or is excludes alone; a bare `-p` covers it too. A glob
 *    after a partial name (`src/a*`) and a directory short of the root pass,
 *    though each can discard a neighbour's edits under it. `git restore
 *    --staged` without `--worktree` writes only the index, and passes. `git
 *    reset --keep` naming HEAD discards nothing (measured on git 2.43.0) and
 *    is refused anyway. A word before `--` it cannot read, or an unresolved
 *    tree under a whole-tree form, FAILS CLOSED; a named path passes in any
 *    tree. `git -c clean.requireForce=false clean` passes: the parser consumes
 *    git's own `-c` before the guard reads the arguments.
 *  - What passes on `git merge` and `git rebase`: `git merge --ff-only`, the
 *    worktree recipe's own last step, and `--abort`, `--continue`, `--quit`,
 *    `--skip`, `--edit-todo` and `--show-current-patch`, which finish or
 *    unwind something already under way; refusing those would strand a tree
 *    mid-merge. A rebase has no fast-forward-only spelling, so `--ff-only`
 *    excuses nothing there, and `pull.ff=only` is not consulted for either.
 *  - A bundled `-r` IS read: `pull.ff=only` does not stop an explicit
 *    `--rebase` (measured on git 2.43.0), so `git pull -qr` under that config
 *    would otherwise take the config exception and rewrite the shared tree.
 *    `pull.ff=only` does beat a configured `pull.rebase=true`, which is what
 *    makes the exception sound for a bare pull.
 *  - `git pull --ff-only -s -r` is ALLOWED: a value-taking short option takes
 *    the next word even when it begins with `-`, as git does (`git merge -s
 *    -r` answers "Could not find merge strategy '-r'", measured on git
 *    2.43.0), so the `-r` is a strategy name and git refuses the command.
 *  - `git -c pull.ff=only pull` is denied, a false deny: the parser consumes
 *    git's global `-c`, so the probe reads repo config only. Left alone —
 *    spelling `--ff-only` is shorter.
 *  - It matches the PARSED command form — a segment whose first word is `git`
 *    and whose subcommand is one it judges — never a substring, so a grep, an
 *    echo or a heredoc mentioning `git pull` passes.
 *  - It FAILS OPEN on anything it cannot resolve — a payload that is not JSON
 *    or carries no command, or a tree git cannot answer for — each RECORDED
 *    (mantahostels#147) for check-guard-errors.js under `npm run status`.
 *    THE UNRESOLVED TARGET TREE IS NOT AMONG THEM FOR `merge` AND `rebase`
 *    (workflow-core#301): an unexpanded `-C`, or a `cd` to a path the parser cannot expand,
 *    is DENIED on those two, since the shared tree is one of the candidates.
 *    `git pull` is judged on its flags alone (workflow-core#308), and only a bare pull —
 *    whose verdict hangs on the tree's `pull.ff` — keeps the fail-open and its
 *    record. A LITERALLY empty `-C` or `cd` is not this case: git and bash
 *    both stay in the cwd, and the command is judged where it lands. The
 *    `pull.ff` probe fails CLOSED: an unreadable config withholds the
 *    exception. A store fault fails CLOSED too: the refusal carries the rule's
 *    fallback sentence (mantahostels#1648), and an injection the store cannot
 *    give refuses through lib/guard-entry.js.
 *  - A pull, merge or rebase reached through a wrapper is not seen, because
 *    only a segment's own first word is read — `xargs git pull`, `env`,
 *    `sudo`, `timeout 5 git pull --rebase` and `sh -c "git pull --rebase"`
 *    (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/hook-if-bash-matching.md §1).
 *  - Wired with `if: Bash(git *)` (mantahostels#2127; best-effort:
 *    docs/agents/guard-authoring.md's surface 4, which fails toward running)
 *    — not started unless some segment of the command leads with `git`.
 *  - It guards the Bash tool. A command run outside Claude Code sees no hook,
 *    and there is no override: this binds agent sessions only, and an escape
 *    a session can spell for itself is not a deny (mantahostels#109).
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/pull-form.js");
const { buildHostPorts } = require("./lib/pull-form-host.js");

run({
	field: "command",
	noun: "command",
	onThrow: "refuse",
	decide,
	ports: buildHostPorts,
});
