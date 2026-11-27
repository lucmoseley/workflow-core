---
name: burn-mode
description: "Turn burn mode on or off, or report its state: the code-review and legal-research dispatches move to the routing file's burn rows. Use for any phrasing of burning tokens."
---

# Burn mode

The rule is `docs/effort-guide.md` §Burn mode; this skill only drives the switch.

## Do this

Run the script — never hand-edit the marker or a settings file:

```bash
scripts/burn-mode.sh on
scripts/burn-mode.sh off
scripts/burn-mode.sh status
```

Report the state the script prints. The flip is live at once and needs no
restart: the next `Agent` call in any session runs on the mode's row in
`docs/effort-guide.md` §Routing, rewritten by `scripts/lib/dispatch-rewrite.js`.
Only an `opus`-named dispatch moves — the code reviewer and legal and
regulatory research — and the session model, settings and launches stay as
they are.

Relay the script's warnings where they print. **It exits 1 where a plan
departs from the routing file's settings when it finishes** — the plan it
names needs a hand.

The refill panel's Burn mode row shows on or off.
