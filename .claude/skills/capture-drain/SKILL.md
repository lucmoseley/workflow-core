---
name: capture-drain
---

# capture-drain

A `**Captured fact:**` comment carrying no drain reaction is a fact that reached no document.

**This loop is the residue loop, not the routing one (mantahostels#2748).** A fact settled
today is filed in the session that settles it, so nothing new should reach this
queue: what it holds is the historical backlog on mantahostels#678 (the standing capture
surface, now closed) and any capture that escaped the rule. A queue that keeps
growing is a finding about the rule, not a backlog to clear quietly — say so in
the resolution.

The rule this loop applies is `docs/doc-map.md` §Capture and placement. **Read
that section in full before step 3.**

## 1. Take the queue

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/capture-drain.js list
```

Oldest first, which is drain order. One call covers every capture comment in the
repo, on open and closed issues alike (`${CLAUDE_PLUGIN_ROOT}/scripts/lib/captures.js`).

## 2. Is it already in the repo?

**For a residue capture this is the only place duplicate-checking happens**, the
capture having deliberately done none (mantahostels#637, which measured how many captures
were repo duplicates).

Search files *and* closed issues (`gh issue list --state all --search`): a
ruling lives on the issue and nowhere else. Already recorded → nothing to write;
mark it consumed at step 4.

## 3. Place it

Two decisions, both made under §Capture and placement: which document owns the
fact's **body**, and which trigger buys its **retrieval**.

Adding bytes to `CLAUDE.md` or a file it `@`-imports? §Capture and
placement §4 binds — read it before writing.

## 4. Mark it consumed

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/capture-drain.js mark <comment-id>
```

A reaction, never an edit to the comment text (mantahostels#640, which ruled how a capture
is caught and consumed).

**A capture you deliberately skip gets no reaction**, so it stays visibly
undrained.

## 5. Close the loop

Report per capture: placed (name the file), dropped as already recorded (name
where), or skipped (say why). Release any doc you claimed
(`node ${CLAUDE_PLUGIN_ROOT}/scripts/session-arbiter.js release <path>`), then call the
Skill tool with "concision-pass" over the prose you added.

## When it speaks

`${CLAUDE_PLUGIN_ROOT}/scripts/check-capture-drain.js`'s `--notify` route is wired to nothing since
`ad6edc1e4` (2 Sep 2026) lifted the checker off `SessionStart`. `npm run
status` now runs it flagless — a live scan every time, not `--notify` — and
is silent until the **oldest** undrained capture passes **7 days** — age, not
count.

**A deliberately-skipped capture keeps speaking.** It carries no reaction by
design (step 4), so it ages past the threshold and is named on every
`npm run status` run thereafter. Expect that of mantahostels#2753's vitest capture;
the residue is static, so a line here is not new work
arriving.

**The 7 days is an unmeasured first guess, and one day of drain history already
cuts against age alone** (mantahostels#679; mantahostels#695, the first
drain): that run's captures were all under a day old, so the threshold never
spoke. It lives in `STALE_CAPTURE_DAYS` in
`${CLAUDE_PLUGIN_ROOT}/scripts/lib/captures.js`, with that measurement and the shape it points at
beside it; read them before re-deriving.

The shape that one day of history points at is **age OR count** — a productive
day is what buries the queue, not what a threshold safely ignores; mantahostels#695's drain
took 26 captures in 16h46m with the check silent throughout. It sets no
number (n=1; nothing bounds a quiet week). The check **never gates**: an
undrained capture is safe where it sits.

**The cache is now write-only.** A full scan costs **20.3 seconds over 12
paginated pages** (measured 19 August 2026 against ~1,100 issue comments) — a
cost the flagless route `npm run status` runs pays live against GitHub every
time, unlike the **15-second** `SessionStart` hook allowance the checker ran
under before the lift above, which read `.capture-drain-state.json`
(gitignored) instead of scanning, to avoid a kill that would have printed
exactly what a clean check prints and failed silent. That cache is still
written after every flagless scan, but nothing reads it: the `--notify` route
that read it, and the detached re-kick past `REFRESH_MIN_AGE_HOURS` (1h) that
refreshed it stale, are both dead with the lift. `STATE_STALE_HOURS` (24h) is
a figure nothing consults today. It stores each capture's `createdAt`, never
a computed age, so a stale cache would still have aged correctly had anything
kept reading it. A scan now, in the foreground, is `npm run check:captures` —
the same live GitHub call `npm run status` already makes.

The comments query takes no `since=`: it would narrow away the old capture the
check exists to find. Neither `+1` nor `eyes` is the consumed marker: both get
added by hand while reading, which would retire a capture nobody placed
(mantahostels#640).

**What invalidates the above:** the tracker's comment count growing enough to
move the 20.3 seconds; a narrower query for capture comments existing; or
auto-memory being switched back on, which removes the reason captures exist.
