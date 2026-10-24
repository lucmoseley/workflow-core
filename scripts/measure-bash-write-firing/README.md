# What the inline-interpreter arm costs, re-derived (mantahostels#2865)

The figures behind `scripts/guard-claimed-bash-write.sh`'s inline-interpreter
arm — the firing rate, the false-warn rate, and the per-session candidate
distribution the 2,000 B session budget rests on — were measured at mantahostels#2854 over
this machine's own transcript corpus and are carried on mantahostels#2854, none of them in
the guard's header any longer (mantahostels#2874, and mantahostels#2854's own concision pass for the
distribution). Nothing runs these on a schedule and nothing gates them. The
corpus is `~/.claude/projects/` (override with `WFC_TRANSCRIPT_DIR`), is not
in the repo, and is not reproducible on another machine: expect the same shape
and different numbers.

**These are JavaScript where every other `scripts/measure-*/` is Python**, so
`docs/code-standards-base.md` binds them (§N, §G, Biome, `tsc --checkJs`) where it
does not bind their Python neighbours — the stricter direction.

## The pipeline

```
node extract-bash-commands.js corpus.jsonl        # every Bash command, + session id
node measure-firing-rate.js corpus.jsonl fires.jsonl
node classify-false-warns.js fires.jsonl sample60.txt
node measure-claimable-share.js fires.jsonl marginal.jsonl
```

`lib.js` holds the classifiers all of these share — the tier-1 test, the token
scan and the write-call list — because two copies drifting apart would give two
answers to one question with nothing saying which run used which.

`measure-firing-rate.js` is the deliberate exception: it re-spells the guard's
two limbs itself rather than importing them, so that running the guard over the
sample it writes CHECKS the two against each other. Sharing an implementation
would make the check check itself. The price is that it must be kept in step by
hand, and it has been out of step once already — see below.

**The two-variant runner is not a file here.** mantahostels#2854's *137 before, 206 after*
came from running the guard, and a copy of it with the `INLINE_INTERP` arm
disabled, over the same 4,000-command random sample of `fires.jsonl` — a shell
loop, written inline and not worth keeping, since the copy has to be made
against whatever the guard says today.

## The published figures over-count

mantahostels#2854's 137/206 firings and its 33%/46% false-warn rates predate the scan's stop
at the script, so they count firings the guard does not make. Re-deriving means
re-running the pipeline, never adjusting the numbers — `measure-firing-rate.js`'s
header has the mechanism.
