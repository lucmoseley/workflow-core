---
name: new-repo
description: Start a new repo on the workflow core.
disable-model-invocation: true
---

# new-repo

Takes the founder's idea to a private GitHub repo adopted onto the workflow
core, holding its first wayfinder map, with launch aliases in `~/.bashrc` —
through one call of `scripts/new-repo.js` in this folder.

**Source repo** is the term for a repo copied into the new one — in every line
you write.

## 1. Interview

Ask one at a time, in this order, each question's answer before the next:

1. **The idea**, in the founder's own words. Keep the reply verbatim, and never
   ask for it again in another shape.
2. **The repo name** — a GitHub repo name, made under `lucmoseley`.
3. **A source repo** to copy, as `owner/name`, or none.
4. **A spec already written** on another tracker, as a URL, or none.
5. **Other trackers holding rulings** for this repo, as `owner/name` — offer
   every tracker the idea names (an `owner/name` or a GitHub URL) as the
   pre-filled answer. None named means none: `--corpus` is left out, and the
   repo still searches its own tracker and `lucmoseley/workflow-core-tracker` by
   default.

Then summarise the five answers, and with them show two drafts for approval,
each editable:

- **The Project one-liner** — what it is and who it is for, one sentence.
- **The map title** — `<repo name>: <gist of the idea>`.

Once both are approved, ask the last question in a message of its own (#732):

6. **The prefix** for the launch aliases `<prefix>1`–`<prefix>3` — offer the
   repo name's initials, lower case (`design-vault` → `dv`), as the pre-filled
   answer.

Done when the founder has approved both drafts and answered the prefix.

## 2. Write the inputs

Write the idea (verbatim), the approved one-liner and the approved title to
three files under `.claude/tmp/new-repo/<name>/` — `idea.md`, `one-liner.md`,
`title.md`.

## 3. Dry run — the one confirmation

From the repo root, one plain line, no `cd`, no `&&`, no quoting beyond the
values themselves — the form the allow rule
`Bash(node .claude/skills/new-repo/scripts/new-repo.js *)` matches:

```
node .claude/skills/new-repo/scripts/new-repo.js --name <name> --prefix <prefix> --idea-file .claude/tmp/new-repo/<name>/idea.md --one-liner-file .claude/tmp/new-repo/<name>/one-liner.md --title-file .claude/tmp/new-repo/<name>/title.md [--source <owner/name>] [--spec-url <url>] [--corpus <owner/name>,…] --dry-run
```

Show its whole output in a code block and ask one yes-or-no question: run it?

- **Exit 0**: that output is the confirmation.
- **Exit 2 naming a prefix clash**: ask the prefix question again, pre-filled
  with another candidate, then dry run again.
- **Any other non-zero exit**: show the output — a bad argument prints its
  error and the usage line, with no report — and the lines after `STOPPED`
  word for word; the run waits on the founder.

## 4. Run

On a yes, run the same line without `--dry-run`. On anything but a yes, run
nothing.

## 5. Last reply

Built from the script's report, in this order:

- The `~/.bashrc` path, line range and full block, from the report's `bashrc`
  line and the block beneath it — or, where the run stopped before that step,
  that `~/.bashrc` is untouched.
- **On exit 1 or 2**: the step that `STOPPED`, and every line after it word
  for word — the `Manual step:` where there is one, then the re-run command or
  `Then start again: /new-repo`. Offer to run a printed re-run command; run it
  only on a yes.
- **On exit 0**: the new-tab line and the first prompt, both as the script
  printed them, the prompt in a code block ready to paste. Where the report
  prints a workflow-core checkout's once-per-machine command, it goes first, as
  a `!` line.
- The plain-language page:
  https://github.com/lucmoseley/workflow-core/blob/main/docs/new-repo.md
