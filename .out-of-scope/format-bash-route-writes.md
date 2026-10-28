# Formatting files written through Bash

The on-save Biome formatter, the post-write core (`scripts/lib/post-write.js`), runs after `Write`, `Edit` and `NotebookEdit` only. A file changed through Bash — a heredoc, `sed -i`, an inline `python3` — is not formatted until a session runs Biome itself or the pre-commit `check:staged` gate refuses it. This repo does not add a Bash-route formatter to close that gap (#918, mantahostels#1772).

## Why this is out of scope

The gap costs one tool call: over 30 days, 18 of 19 Biome format findings were cleared by the very next call (#918).

Closing it costs machinery with known faults. A `PostToolUse` hook on Bash must know which files the call wrote, and there are two ways to learn that, both bad:

- **Parse the command.** The parser is outrunnable (mantahostels#201), and no guard here refuses a write-shaped Bash command on what the parser finds, on that price (mantahostels#287).
- **Diff the tree before and after.** The working tree is shared by parallel sessions, so the diff would include a neighbour's half-written file, and the hook would reformat it under them.

The gap is a delay, not a loss.

Revisit only on a fresh measurement showing a finding costs several calls to clear, not one.
