# pick-next — measured figures (reference)

The evidence appendix to `${CLAUDE_PLUGIN_ROOT}/.claude/skills/pick-next/SKILL.md` — measurement
the readings and verdicts behind its figures.

Every figure this loop rests on, with what invalidates it. Quote none of them
without the condition beside it.

**What a run costs.** ~21 s over 105 open issues, warm — roughly 0.20 s per open
issue (18 August 2026); one later sample ran ~2x slower, undiagnosed. End to
end a real `/pick-next` costs **~14 minutes**, invocation
to §6's dispatch lines, on a frontier of 89 at 128 open (mantahostels#1012, which timed a
real run end to end and holds both figures).

**How long the text output runs.** ~1,300 lines at 171 open issues (24 August
2026). **The open count is the measurement's condition, not today's**: it has
since been read at 73 (6 September 2026).

**A recompute costs O(issues created or body-edited since the last run), not
O(frontier)** (mantahostels#690, which measured it against the cache).

**The band read was 5m10s of a 10-minute run** — two parallel subagents at 310 s
and 306 s, ~53k and ~56k tokens, 20 issues read, on the frontier of 80 at 119
open of 26 August 2026 (mantahostels#1484, which opened on that reading). Six of the 20 were
plausible merge partners; the other 14 bought nothing.

**Nomination cuts the band read by about a fifth, not by two thirds** (mantahostels#1484,
measured on the frontier of 75 at the same date, 33 warm / 42 provisional / 0
cold). `conflictGraph.nominated` named **33 of the 42 sizeless candidates** — a
**21%** cut against reading every one. ⚠ **mantahostels#1484 predicted 6 of 20 and was
wrong**, and the mechanism is known: the grep-derived write-set runs at ~29%
precision on non-stamp paths (mantahostels#587, above), and a handful of hot infrastructure
files put nearly every candidate in a pair with something. ⚠ **Measured over all
75 candidates**, before in-flight and clashing ones are dropped, so the cut a run
actually sees may differ. **Nomination cannot beat the
predictor's precision**, so aim any further attempt at the write-set grep, never
at the nomination rule.

**Measured end to end with nomination, 26 August 2026** (mantahostels#1484).
Frontier 54 at 101 open, 0 cold, 2 nominated (mantahostels#1534, mantahostels#1554 — both sizeless,
both sharing `docs/compliance/processing-register.md` with other candidates).
Script run (`--dump-bodies --no-log`): **20.7 s**. Band read: **3 parallel
Sonnet subagents, one per ~18-issue slice of the full 54-issue tie band**
(nomination narrows *sizing*, not the ordering read every tie-band member
still needs — §4), wall time **101 s** (the slowest of 35 s / 86 s / 101 s),
217.9k subagent tokens total. Script + band read: **~122 s**, under two
minutes, against the ~14-minute mantahostels#1012 baseline. ⚠ **Not a like-for-like
saving**: mantahostels#1012's frontier and composition differ, and the 5m10s/20-issue figure
above fused ordering and sizing in two bigger subagents rather than three
smaller ones — the drop is consistent with nomination doing nothing here, not
proof of it.

**Both nominated issues came back `large`, not the `medium` each had
predicted** — a second miss for `predictedSize` (below) — and `large`
disqualifies both from §5's merge test regardless of what they pair with, so
this run's nomination bought zero new merges.

**2 of 5 recorded runs hit the empty case (mantahostels#1485).** Every run this section
documents that carries both counts: 26 August 2026 (frontier 75) — 33
nominated, 0 cold; 26 August 2026 re-measure (frontier 54) — 2 nominated, 0
cold; a live run of mantahostels#1485 itself (26 August 2026, frontier 57, 100 open)
— 1 nominated, 1 cold; a second live run minutes later (frontier unlogged,
100 open) — **0 nominated, 0 cold, empty**, alongside 10 already-`mergeable`
pairs that merged in §5 unaffected — direct confirmation that skipping the
band read here forecloses no merge already in reach; and a run of 27 August
2026 (frontier 27 at 58 open, 27 warm / 0 provisional) —
**0 nominated, 0 cold, empty** again. No log records
`bandReadRequired` historically —
`${CLAUDE_PLUGIN_ROOT}/scripts/lib/warm-fraction-log.js` does not carry it — so this is a hand count
off the runs already written into this section, not a systematic sample. At 2
of 5 the short-circuit is **not rare** — but 5 runs cannot tell 40% from 10%,
and both empty runs sat on a fully warm cache, which is the condition to
suspect rather than the frequency. ⚠ **Invalidated by** any hand-counted run that comes back empty
(`bandReadRequired: false`), which raises the count above — no log records
this figure automatically, so re-count by hand each time this paragraph is
revised.

**Time to first launch, two-wave dispatch: components measured, end to end NOT
yet** (mantahostels#1486, 27 August 2026). The script alone is **15.4 s** on a frontier of
27 at 58 open (`--no-log --limit 5`, warm), consistent with the 20.7 s and ~21 s
readings above. Against it, the 26 August single-wave run put the band read at
**5m10s strictly after** the script and its reader — so the overlap removes that
whole interval from the first session's start, predicting first launch at
**~2-3 minutes**. ⚠ **That figure is arithmetic on two
separately-measured stages, not a stopwatch on a two-wave run**: nobody has
timed one yet. **Record the real
one on the next live `/pick-next`** — the clock runs from invocation to
`dispatch-sessions.sh` returning on the wave-1 call — and replace this
paragraph with it. **Invalidated by** any run whose nomination and cold lists
are both empty: that run has no wave 1 at all (mantahostels#1485) and its first launch is
the ordinary single-wave one.

**`predictedSize` is not a band-read skip.** On that same run the predictor
called **1 of 42** provisional entries `small` (25 `medium`, 11 `large`, 5 none)
while band reads called **11 of 33** warm entries `small`. It puts nearly
everything in `medium`/`large`, so skipping a band read on that answer drops most
genuinely-small issues (mantahostels#1484). **Invalidated by** any change to
`${CLAUDE_PLUGIN_ROOT}/scripts/lib/write-set-predict.js`'s size heuristic.

**Per-ticket band-read cost:** ~3.2 s and ~7.9k subagent tokens cold; ~4 ms and
no subagent warm, so the per-ticket cut is 100% (mantahostels#611). ⚠ **A floor, not an
average** — one machine, one run, at the parallelism of two subagents of 6, and
those subagents did nothing but derive the write-set while a real band read also
carries ordering judgement. **Quote it as the per-ticket cost, never as a run
saving:** the run-level cut is the warm fraction × this, and the picker's own
wall time is unmoved.

**Band-read warmth of the frontier, before pre-warming: 85.3%** — 3,621 of 4,247
frontier tickets across 58 real re-picks, per-run mean 84.9% ± 3.0, per-run range
34.8–100.0% (mantahostels#789, over 2.1 days). Its first 24 runs are the 24 mantahostels#628
read, so this is one sample grown, never an independent test. **Verdict against
mantahostels#385's predicted 60–80% saving** — the claim that a warm cache cuts most of a
re-pick's dominant cost — **INCONCLUSIVE, and the two are different quantities**:
the fraction bounds that cut from *above* and cannot reach it. The sample is not
provably free of tooling runs, and the cache's upkeep was never priced against
the hit rate, so this is **not** a net-benefit finding. **With pre-warming, the
figure to read is `covered`, not this one** — table below.

**Churn is not what cools a ticket.** Of cold tickets **96.5% are `never
derived`**, against **3.5% `body-changed`**; that 3.5% is what 5.8 days of log
gives where the first 25 hours gave 2.7%, so waiting does not lower the warm
fraction. Cold starts do the cooling.

**Pre-warming raised `covered` to near-total and cut `pooled`** (mantahostels#1054,
mantahostels#789: 96 usable re-picks spanning 5.8 days on 25 August 2026, split at
`2026-08-21T14:53:19.873Z` — the first run a pre-warming build wrote):

| | runs | span | `pooled` (band-read warm) | `covered` (warm + provisional) |
| --- | --- | --- | --- | --- |
| before | 58 | 2.1 days | **85.3%** (3,621 of 4,247) | 85.3% — no line carried a provisional count |
| after | 107 | 6.9 days | **64.2%** (5,472 of 8,519) | **99.5%** (95% band 99.3–99.8%; 3,006 provisional; 41 cold, 26 distinct) |

⚠ **The `before` sample is closed and cannot be extended.** That split is where
`pooled` stopped counting the same thing, so band-read warmth is frozen at 58
runs / 2.1 days and any later run lengthens `after` alone. mantahostels#789 asked for a
fortnight and this is 5.8 days: the shortfall is real and now unfixable, and the
flat `body-changed` share above is the evidence it does not change the answer.

**mantahostels#1338's gated re-read, 28 August 2026 (count gate ≥40 cold entries / ≥25
distinct tickets — met at 41 / 26): `covered` held, 99.8% → 99.5%, inside its
own band both times, so 99.8% is confirmed rather than superseded.** The
`body-changed` share of cold is **26 of 41 entries = 63.4%, Wilson 95%
48.1%–76.4%, over 16 of the 26 distinct tickets** (against 6.4% across the
whole log, this growth included). The band is
still wide enough that "churn inverted post-split" is not settled, but the
direction has not reversed across four gate checks (25–28 August) and one
gated read. Per-ticket re-read concentration: mantahostels#1338.

`pooled` is the check that pre-warming left band-read warmth alone, and **it did
not**: a covered ticket is never band-read, so nothing ever `put`s a real
write-set over its provisional entry, and pre-warming **substitutes** provisional
coverage for band-read warmth rather than adding to it (70%, 55–82%; the rival
explanation is on mantahostels#1054). ⚠ **Never quote `pooled` and `covered` for each
other**, and never pool across the split — the whole-log 77.2% is two
mechanisms averaged.

**Verdict against mantahostels#385's 60–80% claim: INCONCLUSIVE.** `npm run
warm-fraction`'s AGAINST block (mantahostels#1327) flags as `UNINTERPRETABLE`
the cross-split pooled figure the paragraph above forbids quoting, and states the
verdict off `covered`'s after-side bound, with its own run-to-run 95% band,
pointing at mantahostels#789. Read the script's own AGAINST
block for the current figure rather than quoting one here — the `after` row
above grows with every run, so a number written into this paragraph is stale
on arrival.

**De-duplication of that log** (`${CLAUDE_PLUGIN_ROOT}/scripts/lib/warm-fraction-log.js`): a duplicate
is an **identical frontier** — same issue numbers warm, same cold ones with the
same cause — within **10 minutes**, with nothing `put` in between. The key is
frontier membership, **never the session**, so a cross-session near-duplicate
collapses to one. The 10 minutes is a judgement, not a measurement, inclusive at
the boundary. **Two residual biases, which travel with any quoted figure:**
`collapsedQuiet` pulls the pooled figure **DOWN** (a genuine re-pick over an
unchanged frontier is indistinguishable from a `--json` re-run, and the second is
dropped); `runsKeptOnPutsCrossSession` pulls it **UP** (any session's band read
anywhere keeps a pair of parallel pickers apart — mantahostels#680 ruled the put need not
touch the frontier, and a reading above zero reopens that). Never quote a pooled
warm fraction without both directions; never read a collapse as a lost
measurement.

**Band-read wall times: 86–147 s** for 12–14 issues, first scratch line within
~45 s of dispatch, then one line per ~7–10 s. **Stalls are episodic, neither
load-related nor endemic:** 16 bands across four repetitions on 19 August 2026
gave **zero stalls**, under load from 7 busy sessions down to 3 — against the 18
August incident's 2 of 4 stalling to the 600 s watchdog (mantahostels#585, which ran the
comparison). Episodes cluster in time, not with load; likely a brief WiFi drop
the stream never recovers from. **Keep the detection-and-fallback even
though the measured rate is zero** — episodic means it returns without warning —
and never wait toward the 600 s watchdog when a healthy band finishes by ~150 s.
Not measured: a truly idle machine, or the stall mechanism itself.

**The `§B` body pattern predicts a `docs/doc-map.md` write at 79% precision /
97% recall** — n=48, every open body, re-scored 17 August 2026. Three rivals lost
against the same ground truth (mantahostels#414). It misses bodies announcing a *new* entry,
which name no number because none is assigned yet. 31 of those 48 issues would write the file — and
they do **not** serialise on that account, a §B entry being a stamp.

**The grep-derived write-set is exact where it counts and noisy everywhere
else** (mantahostels#587). Cost 0.095 s over 13 bodies, 0.674 s over all 89 — against 176.7 s
and ~70k subagent tokens for the band read over the same 13. Overall accuracy is
poor: scoring a named path correct only where the band read said the work
*writes* it gives **63 named, 20 written, 45 false positives, 2 false negatives —
~29% precision, ~90% recall** (n=13, small); the false positives are peripheral
citations. On `docs/doc-map.md` it is still **100% precise, 11/11** — a §B hint
is itself a write phrase. `docs/reference-roadmap.html` is not: measured **13 of
22, ~59% precision** on the full open population of 22 August 2026 (mantahostels#1072) — the roadmap is this repo's
most-discussed file, so a body backticks its path to say where something was
*searched*, what a gate *validates*, or which paths a predictor is *exact on*,
as often as to say what the ticket writes; a bare path token carries no
direction. Recall on that file is **55–70%** (n=12 of 24 judged). §4 trusts
the grep-derived write-set only on
`docs/doc-map.md`, and reads the band for `docs/reference-roadmap.html`. Of 12
sampled issues writing `docs/doc-map.md` the band read called **7 substrate and
5 stamp**, so the "canonically a stamp" default held for fewer than half:
**grep-first loses the refinement, not the default.** Ambiguity across all 89
bodies, counting non-stamp paths: 21 name none, 39 name one or two, 18 name three
to five, 11 name six or more. **Invalidated by** any change to §4's matching rule
or by either correction being dropped.

**Merging pays, and by how much** (mantahostels#1030): an
extra bundle member costs about **1.88 min of active time** against **31.6 min
for a single-issue session**, so the saving outruns the barrier around **17:1** —
**never refuse a merge on cost**. But **bundle size explains little of how long a
session runs, residual sd 18.8 min**, so never quote an expected finish time from
it. These are evidence that merging pays, **never a cap**: mantahostels#508 and
mantahostels#1094 bar a member-count cap, a numbered cap being the threshold
mantahostels#218 barred, and accumulated context is capped instead.

**What merging costs in tokens, not minutes** (mantahostels#1094, measured 22 August 2026
over the 400 `cli` sessions since 18 August that closed at least one issue, 486
issues in all; weighted at the Opus 5 list ratios mantahostels#830's allowance-burn note
uses, and re-derivable with `node ${CLAUDE_PLUGIN_ROOT}/scripts/measure-bundle-cost.js --since
2026-08-18`). Cost-equivalent **per issue closed** *falls* as the bundle grows —
**$21.38** solo (n=344), **$11.50** at two (n=42), **$9.53** at three (n=6),
**$4.84** at five (n=5) — while mean context per turn barely moves with bundle
size (110k solo, 141k at five). The mechanism is turns: **76 turns per issue
solo against 12 at five members**. ⚠ **Confounded, and not by a little.** The
merge rule admits only members judged `small`, so a bundled issue is a cheap
issue by construction; the gap is the size band as much as the merging, and
nothing here separates them. What it does establish is the negative that
matters: **the marginal cost of member N rising with N — the premise mantahostels#1094 was
opened on — is not visible in this data at all**.

**Why the merge rule ignores the substrate/stamp split** (mantahostels#503, 18 August 2026):
820 of 933 possible-collision pairs were `docs/doc-map.md`, genuine substrate
collisions were **zero**, and the apparent source-code collisions are mentions,
not edits. Same run: 39 open debt entries, 35 of them `docs/doc-map.md` — an
upper bound, since `debt list` makes no network call. ⚠ **That zero is weaker
than it looks:** the claim guard refuses only on `docs/`, `.claude/`, `CLAUDE.md`
and `AGENTS.md`, so a substrate collision on product code registers no debt, and
the underlying reason is phase — pre-launch, almost every open issue is
documentation. **Re-derive once `app/` carries real work.** ⚠ **The assumption
that would reverse the rule:** that the band read's `small` sizing is reliable.
Removing the split makes that sizing the *sole* guard against spending one
session's context on two large jobs, and there is **no measurement of how often
it is wrong**.

**In-flight collision pairs print capped at 20** (`INFLIGHT_PRINT_CAP`), because
candidates are cross-paired against in-flight issues, so the count grows as
candidates × in-flight rather than as a count of issues: one live run on 16
August 2026 produced **94** pairs, nearly all `docs/doc-map.md`. `--json` stays
uncapped. **Never take contention from the printed count** — past 20 it says only
"at least 20".

**The conflict graph was wrong in both directions about one file** on the mantahostels#1012
run — `docs/reference-roadmap.html`. It dropped candidates for naming a file a
higher-ranked candidate already named — but a `wayfinder:grilling` issue does
not write the roadmap at all, it cites it (§5's third bucket; mantahostels#1074), so four
exclusions were overturned by hand; and it missed mantahostels#983, whose body-named write-set was
`AGENTS.md` alone while its real substrate is the roadmap.
The script does not derive the substrate/stamp split: mantahostels#506 bars it, and the
signal is timing, not path. The graph never refuses a candidate (one enforcement
tier only).

**An assignee is not a liveness signal.** Every assignee here is the founder's
login, so nothing maps one back to the session that set it. Measured
19 August 2026: **27 open issues carried an assignee against 8 live sessions**,
at most 4 of which mapped to an assigned open issue — **21–23 of 27 stale,
78–85%**; oldest, mantahostels#79, held since 13 August. The arbiter store is the authority,
and selection excludes only where a matching claim exists **and** its session is
live. **It fails open deliberately** — an unrecorded claim leaves the issue
selectable rather than hiding it for good.
Neither the reaper nor a start-up sweep unassigns a stale assignee: both would
need the very session-to-issue mapping that is missing (mantahostels#633).

**The claim prune spares on both oracles** (mantahostels#704): `pruneIssueClaims` deletes a
record only where the sessions registry **and** `claude agents --json` both call
the session finished, and sweeps nothing where either refuses to answer. Its
only caller is a `SessionStart` hook, where the starting session is not yet
listed, so it takes `sweepSessionIds` (mantahostels#710). **Residual:** a session the agents
oracle lists, absent from the short list for some other reason, and stale in the
registry, is still swept.

**`CLAIMS DEGRADED` is a linked-worktree test, not a root mismatch** (mantahostels#703). A
root mismatch cannot see the failure that matters: neither `WFC_REPO_ROOT` nor
`CLAUDE_PROJECT_DIR` is set here, so a run from a throwaway worktree has both
sides resolving to that worktree — they agree, every claim is still filed under
the canonical checkout's slug, and the empty read looks exactly like a genuinely
unclaimed frontier.

**How the sum in §5 is enforced** (mantahostels#844). `${CLAUDE_PLUGIN_ROOT}/scripts/pick-next.js` writes one marker
per session under gitignored `.claude/tmp/markers/.pick-next/selection-sessions/<session-id>.json` as
it finishes, carrying that run's frontier size; a session with no marker is never
examined, and a `--no-log` run mints nothing. Markers are swept on age alone, at
a week. **Known residuals:**
the counts are read, never verified against the issues named, so a plausible sum
whose disqualifiers were never named still passes; a dispatch message spelled
outside §6's contract is not recognised as one; and a marker that cannot be
written or read disarms the guard silently, deliberately — every failure path
exits 0. The block cap is **3**, counted per guard against its own prefix, so
this guard never spends `guard-priced-options.js`'s allowance.

**Why the skip is not keyed on `covered`** (§4). The version first considered was
"skip when `covered` >= 95%", which is wrong and would have been a trap:
`covered` is measured at 99.8% above, so a 95% threshold would fire on
essentially every run and permanently disable merging.

**Why nomination is the whole set** (§4). A band read buys `sizeBand`, and `sizeBand` is
consumed by one thing only — §5's merge test. A candidate sharing no file with
anything can never be in a merge, so its size is never consulted; a candidate
already band-read has one.

**Why skipping the band read forecloses no merge** (§4, mantahostels#1485). §5's merge test
already ran off whatever sizes were known before the band read, so
`graph.mergeable`'s existing pairs still merge unaffected; skipping the read
only means no *further* candidate acquires a `sizeBand`, so no pair beyond
`mergeable` can qualify. Nominated being empty is not "nothing to merge": a pair
can be `mergeable` — both sides already sized `small` — without either side
being nominated, since nomination only ever names the *sizeless* side of a pair.

**Why mantahostels#588 bars reordering** (§4). `docs/doc-map.md`, the one file the grep is
exact on, is a *stamp*, which disqualifies nothing (§5), and elsewhere the grep
is imprecise — the silent side of §5's asymmetry. Reordering buys no time
either: the bands run in parallel, so a smaller set costs the same wall clock,
and splitting the *band read* into two rounds would serialise them — which is
not §6's two-wave **dispatch**, whose first wave launches while the read runs.
Aim any future attempt at the cold-re-pick cost at **tokens and subagent
count**, which is where mantahostels#588 located it, never at wall clock.

**Why no `ListAgents` poll during the band-read watch** (§4). The harness wakes
you on completion, nothing you run makes it arrive sooner, and the elapsed time
`ListAgents` prints goes stale, so a poll cannot even tell you whether an agent
is progressing.

**What mantahostels#1486 measured about wave 1** (§4). Every session in the set waited on a
band read most of them were never candidates for.

**Why release is not batched** (§5). Handing out a set, then waiting for all
of it to drain before handing out more, leaves slots idle while later issues are
already unblocked.

**What a recompute's cost breaks down into** (§5, mantahostels#690 — see also the entry
above). The closed issue is pruned, and only what that close newly unblocked is cold, so a close with
nothing filed in between dispatches no band-read subagent at all — the script
plus §4's grep, ~21 s. The expensive recompute is a charting burst that files a
batch of issues, never a close.

**What mantahostels#422 rules** (§5): the picker writes no claim to reserve a stamp
(mantahostels#101/mantahostels#111 bar this skill from writing at all, and a reservation for a
session that never starts strands a claim with no holder). **A live trigger:**
splitting `docs/doc-map.md` so §B entries stop contending, an authority-model
change, **is to be raised if the stamp queue keeps biting.**

**Why a card-count proxy fails** (§5). mantahostels#858 (adopt a trimmed unslop tells list
into the brand sheet) names three cards and is a stamp; mantahostels#917 (concision findings
on two cards) names two and is substrate.

**How large the roadmap's non-writer bucket is** (§5). Nine of the 22 issues the
graph predicts write the roadmap pair only *cite* the path.

**The roadmap pair has never moved apart** (§5, mantahostels#1075). In 172 commits touching
`docs/roadmap-digest.md`, every one also touched `docs/reference-roadmap.html`;
none has ever moved alone.

**Why `CLAUDE.md` is a stamp** (§5, mantahostels#1281). Three measurements carry it, none a
writer count. Of the 34 open issues `predict()` calls writers, 30 only cite the
path and **none** uses the file as a substrate, so `predict()` is 12% precise as
a writer predictor here against 59% on the roadmap (mantahostels#1279). A collision costs
the `docs/doc-map.md` regime — abandon that one edit, register the debt, finish
the ticket — which is what all 12 measured denials did (mantahostels#1277). And the
always-loaded byte cap, the one coupling unique to this file, is orthogonal: it
discharges onto `docs/doc-map.md`, itself a stamp (mantahostels#1280).

**Contention is not the test, and `docs/doc-map.md` is the counter-example**
(§5). `CLAUDE.md` collides on 11.2% of writing sessions and makes 496 conflict
pairs, the most of any path. `docs/doc-map.md` collides on **32%** — nearly
three times as often — and is the ruled stamp (mantahostels#422).

**The two open sentence-deliverable tickets** (§5): mantahostels#1262 (say that Biome
rewrites every tool-route write) and mantahostels#1263 (name the debt-drain script). mantahostels#1263
exists because a parallel session held `CLAUDE.md` mid-shed.

**The undecidable `CLAUDE.md` bucket** (§5, mantahostels#1279): 7 issue-file pairs, 18% of
the population, where a decision ticket's *chosen option* rewrites a `CLAUDE.md`
sentence — a property of the answer, undecidable at the moment a per-ticket test
would run.

**The run that went silently short** (§5). The run of 2026-08-26T00:14Z
dispatched 7 sessions / 8 issues against a DISPATCHABLE FLOOR of 11, its
arithmetic added up, and the only thing that caught it was the founder asking
why the number was low.

**How stale the admission figure got over one band read** (§5, mantahostels#943): a set
sized against a figure ~1 GB low and a count 40% high.

**Why the reap's second reason no longer holds** (§5). The sessions that made
§4's reading stale, the ones that finished during the band read, used to sit
inside the reaper's grace window, but at the 1-minute grace a ~150 s band read
outlasts it.

**Why the admission overflow is named individually** (§5). It is bounded by
construction, usually 0-3 issues, every one of them takeable *right now* and cut
only because a session had not finished a minute earlier. It is also the only
disqualifier the next recompute may not revisit promptly, because nothing about
a slot changes when an issue closes.

**Why `predictedSize` is not a skip** (§4, mantahostels#1289, mantahostels#1484). It is derived from
body length, path count and section-anchor count, and it puts nearly everything
in `medium`/`large`, so skipping a band read on that answer drops most genuinely
small issues.

**What the provisional grep is precise on** (§4, mantahostels#587, mantahostels#1107).
`docs/doc-map.md` is exact; `docs/reference-roadmap.html` measured ~59%
precision, not exact.
