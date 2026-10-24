# Formatting files written through Bash

The on-save Biome formatter, `scripts/post-write.sh`, runs after `Write`, `Edit` and `NotebookEdit` only. A file changed through Bash — a heredoc, `sed -i`, an inline `python3` — is not formatted until a session runs Biome itself or the pre-commit `check:staged` gate refuses it. This repo does not add a Bash-route formatter to close that gap.

## Why this is out of scope

The gap costs one tool call: over 30 days, 18 of 19 Biome format findings were cleared by the very next call (#918).

Closing it costs machinery with known faults. A `PostToolUse` hook on Bash must know which files the call wrote, and there are two ways to learn that, both bad:

- **Parse the command.** The parser is outrunnable (mantahostels#201), and mantahostels#287 declined a Bash-parsing guard on that price.
- **Diff the tree before and after.** The working tree is shared by parallel sessions, so the diff would include a neighbour's half-written file, and the hook would reformat it under them.

mantahostels#1772 ruled this limb "a delay, not a loss" with no work owed.

Revisit only on a fresh measurement showing a finding costs several calls to clear, not one.

## Prior requests

- mantahostels#1772: "Auto mode routes every write past the file-claim guard and the auto-format hook" — this limb closed with no machinery
- #918: "Edits made through Bash skip the on-save Biome formatter, so the commit is refused for formatting"
