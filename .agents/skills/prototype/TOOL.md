# Tool-surface Prototype

Generate **several radically different candidates** for a surface that is not a web route — a terminal or tmux panel, a CLI or TUI screen, a status line — rendered side by side on **one page the user can view**: a plain HTML page published as an artifact, or the file itself where artifacts are unavailable. Show every candidate frame and capture at 100% size, never on a scaled canvas or an Artifact type's design canvas; a frame wider than the window scrolls sideways in its own box. No route hosts them, so there is no `?variant=` switcher. Where the ask wants behaviour, make each candidate clickable and show what a press does.

[UI.md](UI.md)'s rule that variants differ in structure (the last paragraph of its §2) and its anti-patterns hold here too. If the question is about logic or state, use [LOGIC.md](LOGIC.md).

## Process

Steps 1–5 come before any candidate is drawn. The page opens with a groundwork checklist, one line per step ticked with what it found, then the must-have list (step 5).

### 1. Load design-vault's critique rules

Read design-vault's `design-critique` skill and its rule records (`plugin/skills/design-critique/rules.md` and `rules/`, in a design-vault clone or `lucmoseley/design-vault` on GitHub): draft every candidate to them. Once the candidates are drawn, a fresh subagent runs `design-vault:design-critique` on them before the user sees the page. A tool surface takes design-critique rather than a whole `design-round`, whose web-surface stages (impeccable, the width sweep, the precedent survey) need a browser page.

### 2. Capture the host surface

Capture the host at its real size, in **every state it has** (idle, working, needs-you, error…). For a terminal host, run it at its real size in a detached tmux session where it is not in one already; `tmux capture-pane -p -e` gives the text with its colours and `tmux display -p '#{pane_width}x#{pane_height}'` its size; put the capture on the page beside each candidate. Measure the columns and rows the panel will really get, and draw every candidate at that size. Show an animated state moving, or as a strip of frames. Where a state cannot be produced live, ask the user for a screenshot of it, and mark it missing on the page until one comes.

### 3. Take the host's palette and type as constraints

Read the host's colours and font from the capture or its config. Each candidate keeps text at 4.5:1 contrast or better against the host background, and a control's boundary or state mark at 3:1 against its neighbours (WCAG 2.2, 1.4.3 and 1.4.11, which bind terminal software too). Where colours come from a palette the user can retheme (a terminal's 16 ANSI slots), check against the theme in use, or against one light and one dark theme where it is unknown. Every state carries a glyph or word beside its colour.

### 4. Fixtures from real data

Take every fixture from the live system: the real session list, the real labels and counts the host shows next to the panel. Where the real data is too thin to show a state, say so on the page and leave that state empty. Where a ruling has changed what the panel will show and no live data has that shape yet, keep the live values in the ruled shape and say so beside it.

### 5. List the must-have controls

Copy every control and piece of information the ask requires, from the issue or map in hand, into the page's numbered must-have list, each line as its latest ruling leaves it.

### 6. Draw standard controls to a published spec

For each standard control a candidate draws — a switch, a badge, a progress mark — take its geometry from a published spec (Material 3's component tokens, the WAI-ARIA pattern for its states and keys), read at the time, and cite it beside the candidate. In a character grid, keep the spec's proportions and its non-colour cue, scaled to the cell, and say on the page that the mapping to cells is yours.

### 7. Hand it over

Tick each candidate against every must-have line; a candidate missing one is fixed or dropped. Each candidate carries a line on what it gives up.

Lay the candidates out as the plain 100%-size page this file opens with. Render that local page before publishing — the published link is private, so a headless browser gets the sign-in page — at 1366×768, 1536×864 and 1920×1080: the commonest laptop and desktop sizes, and the founder's 1920-px screen at 125% and 100% scaling (#2753, its research comment, issuecomment-6382827617):

```bash
for v in 1366x768 1536x864 1920x1080; do python3 scripts/browse.py shot "file://$PWD/<page>.html" --tiles --viewport "$v" --out "<page>-${v%x*}.png"; done
```

`--tiles` writes one PNG per screenful, so each is read at full size; one full-page PNG is shrunk before you see it. Exit 6 names each image drawn below its own size and any sideways scroll of the page itself. Read every tile, and fix and re-render while it exits 6 or any text is smaller than the host shows it. Then publish the page and give the user its link, saying it was rendered and at which widths. Capture the answer and the page as [SKILL.md](SKILL.md) rule 6 describes.
