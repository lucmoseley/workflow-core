---
name: design-mode
description: "Turn design mode on or off, or report its state: the `impeccable` frontend-design plugin, off by default. Use for any phrasing of switching design mode, the design plugin or skills on or off, a design session starting or ending, or why the design skills are unavailable."
---

# Design mode

Toggles `impeccable@impeccable` for this repo. Off by default: its hooks spawn Node on every edit.

## Do this

Run the script — never hand-edit `enabledPlugins`:

```bash
scripts/design-mode.sh on
scripts/design-mode.sh off
scripts/design-mode.sh status
```

Report the state the script prints. On `on` and `off`, **say plainly that the
session must be restarted before the skills actually load**. This matters: the status line reads `.claude/settings.json` live, so it flips to `design: ON` immediately, but the plugin itself is only read at startup. Between the toggle and the restart the status line is ahead of reality — do not let the user believe `impeccable` is callable yet.

If the user is turning design mode *on* in order to do a specific piece of UI work, tell them to restart first, then make the request again.

## Notes

- The status-line segment lives in `~/.claude/statusline.sh` — outside this repo, user-level so there is only one copy. It keys off the `impeccable@impeccable` boolean and latches each session's boot state, which is how it knows to show `(restart)`.
