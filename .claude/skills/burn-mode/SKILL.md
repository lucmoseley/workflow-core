---
name: burn-mode
description: "Turn burn mode on or off, or report its state: Sonnet work up to Opus 5.5, and Opus 5.5 effort up to high. Use for any phrasing of burning tokens."
---

# Burn mode

The rule is `${CLAUDE_PLUGIN_ROOT}/docs/effort-guide.md` §Burn mode; this skill only drives the switch.

## Do this

Run the script — never hand-edit the marker or a settings file:

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/burn-mode.sh on
${CLAUDE_PLUGIN_ROOT}/scripts/burn-mode.sh off
${CLAUDE_PLUGIN_ROOT}/scripts/burn-mode.sh status
```

Report the state the script prints. On `on` and `off`, **say plainly that the
effort half needs a session restart**: Opus 5.5's effort in a plan's
`settings.json` is read at startup, so this session and every other running
one keep the effort they booted on — and so does the session the agents view
already created for its launch line, until one throwaway launch from there
(`/usage` serves) spends it. The dispatch half is live at once — the
next `Agent` call naming `sonnet` in any session runs as `opus`, rewritten by
`${CLAUDE_PLUGIN_ROOT}/scripts/lib/dispatch-rewrite.js`.

Relay the script's warnings where they print. **`off` exits 1 where a plan is
still at the burn effort when it finishes** — a failed revert, not a warning,
and the plan it names needs a hand.

## Notes

- The refill panel's Burn mode row shows on or off. The status line says
  `burn: on (restart: model)` or `burn: off (restart: model)` only while this
  session's model is out of step with the marker. It lives in
  `~/.claude/statusline.sh` — outside the repo, snapshotted in the settings
  snapshot (`userSettingsSnapshotPath` in `.claude/workflow-core.json`, else
  `docs/claude-user-settings.md`) — and latches each session's boot state to
  badge the flip until the session restarts. `(restart: model)` means the effort
  half (workflow-core#355).
