#!/usr/bin/env python3
"""scan_ceiling.py — measure how much of the week this machine spends past the allowance ceiling.

Commissioned by mantahostels#1125 (the ticket that found every procurement option priced
against an unmeasured figure). The only number in evidence was the founder's
recollection on mantahostels#829 — "exhausts both subscriptions in roughly 5 days of a
7-day week" — and a policy that buys spillover capacity needs the measurement,
not the recollection.

The signal is exact, not inferred. When a window is exhausted Claude Code
writes a synthetic assistant record carrying `"error":"rate_limit"`,
`apiErrorStatus: 429` and a text saying when the allowance returns:

    You've hit your session limit · resets 6:40pm (Asia/Singapore)

That reset time is what makes blocked *duration* measurable rather than
guessable: the block runs from the first such record to the stated reset.

Three distinctions the report depends on:

  * **A 429 is not always a ceiling.** `Request rejected (429) · This request
    would exceed your account's rate limit` is a throughput rejection carrying
    no reset time, and it frees up in seconds. It is reported separately and
    never counted as ceiling time.
  * **One window blocks every session at once.** Events are grouped into
    episodes by the reset instant they name, so six sessions walking into one
    exhausted window is one outage of one duration, not six.
  * **Blocked wall-clock is not lost work.** A block at 03:00 local costs
    nothing if nobody was working. Both are reported, against the day's own
    active hours as well as against the clock.

Transcript layout, and the trap that subagent turns live in
`<session-id>/subagents/agent-*.jsonl`: https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/allowance-burn-measurement.md.
"""

import argparse
import datetime as dt
from dataclasses import dataclass, field
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import transcript_corpus as tc

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "measure-burn"))
import scan_burn as sb

UTC = dt.timezone.utc
# Asia/Singapore, which the reset messages are stamped in. Fixed +08:00 with no
# DST since 1935, so an offset is exact and needs no tz database.
SGT = dt.timezone(dt.timedelta(hours=8))
# The plan's rolling usage window, the counter behind every block in the corpus.
WINDOW_HOURS = 5
RESET_RE = re.compile(r"resets?(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)", re.I)


def parse_ts(value):
    """A transcript timestamp as an aware UTC datetime, or None — which each
    caller counts into its tally (#1274)."""
    try:
        return dt.datetime.fromisoformat(
            (value or "").replace("Z", "+00:00")
        ).astimezone(UTC)
    except ValueError:
        return None


def text_of(rec):
    msg = rec.get("message") or {}
    return " ".join(
        b.get("text", "") for b in (msg.get("content") or []) if isinstance(b, dict)
    )


def reset_at(text, at):
    """The instant the allowance returns, from the message's local wall time.

    The message gives a time of day only, so this takes the next occurrence of
    it strictly after the event — without which a 21:57 event resetting at
    00:20 reads as 21 hours in the past rather than 2 hours ahead.
    """
    m = RESET_RE.search(text or "")
    if not m:
        return None
    hour, minute, ampm = int(m.group(1)), int(m.group(2) or 0), m.group(3).lower()
    hour = hour % 12 + (12 if ampm == "pm" else 0)
    local = at.astimezone(SGT)
    cand = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if cand <= local:
        cand += dt.timedelta(days=1)
    return cand.astimezone(UTC)


def classify(rec, tally):
    """The event a record represents, or None where it is not a 429 at all.

    Three kinds, kept apart because they cost different things:
      window-exhausted  the rolling 5-hour allowance is spent; blocks until reset
      weekly-exhausted  the weekly counter is spent; blocks for far longer
      request-rejected  momentary throughput rejection; no reset, frees in seconds

    `tally` is the caller's accumulator: a 429 with no readable timestamp is
    counted into it.
    """
    if rec.get("error") != "rate_limit" and rec.get("apiErrorStatus") != 429:
        return None
    text = text_of(rec)
    if "429" not in text and "limit" not in text.lower():
        return None
    low = text.lower()
    if "weekly" in low and "limit" in low:
        kind = "weekly-exhausted"
    elif "session limit" in low or "usage limit reached" in low:
        kind = "window-exhausted"
    else:
        kind = "request-rejected"
    at = parse_ts(rec.get("timestamp"))
    if at is None:
        tally["undated 429s"] += 1
        return None
    return {
        "kind": kind,
        "at": at,
        "reset": reset_at(text, at),
        "session": rec.get("sessionId") or rec.get("session_id"),
        "rid": rec.get("requestId") or (rec.get("message") or {}).get("id"),
        "text": text,
    }


def dedupe(events):
    """One event per request. A transcript repeats a record across its blocks."""
    seen, out = set(), []
    for e in events:
        key = (e["session"], e["rid"], e["at"])
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    return out


def episodes(events):
    """Exhaustion episodes: one per window, however many sessions walked into it.

    Keyed on the reset instant the messages name — the identity of the window
    itself. An event carrying no reset time (a throughput rejection) starts no
    episode, because nothing says how long it blocked anything.
    """
    by_reset = defaultdict(
        lambda: {
            "events": 0,
            "sessions": set(),
            "start": None,
            "kinds": set(),
            "last": {},
        }
    )
    for e in events:
        if not e["reset"] or e["kind"] == "request-rejected":
            continue
        g = by_reset[e["reset"]]
        g["events"] += 1
        g["sessions"].add(e["session"])
        g["kinds"].add(e["kind"])
        if g["start"] is None or e["at"] < g["start"]:
            g["start"] = e["at"]
        # The session's last retry into this window, which is where its wait to
        # resume is timed from.
        if e["at"] >= g["last"].get(e["session"], e["at"]):
            g["last"][e["session"]] = e["at"]
    out = []
    for reset, g in sorted(by_reset.items()):
        out.append(
            {
                "start": g["start"],
                "end": reset,
                "sessions": g["sessions"],
                "events": g["events"],
                "kinds": g["kinds"],
                "last": g["last"],
                "minutes": (reset - g["start"]).total_seconds() / 60,
            }
        )
    return sorted(out, key=lambda e: e["start"])


def merge(intervals):
    """Overlapping [start, end) intervals collapsed, so nothing double-counts."""
    out = []
    for a, b in sorted(intervals):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def union_minutes(intervals):
    return sum((b - a).total_seconds() / 60 for a, b in merge(intervals))


def blocked_by_day(intervals, tz=SGT):
    """Blocked minutes per local calendar day, an interval split at midnight.

    Local, not UTC: "how much of the *day* was lost" is a question about the
    founder's day, and a UTC day cuts this one at 08:00 local.
    """
    per = defaultdict(float)
    for a, b in merge(intervals):
        a, b = a.astimezone(tz), b.astimezone(tz)
        while a < b:
            midnight = (a + dt.timedelta(days=1)).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
            end = min(b, midnight)
            per[a.date().isoformat()] += (end - a).total_seconds() / 60
            a = end
    return dict(per)


@dataclass
class Activity:
    """What one sweep of the corpus knows besides the events themselves.

    The five fields are read together by every caller, so they travel as one
    record rather than as a parameter list five long.
    """

    turns: dict = field(default_factory=dict)  # sessionId -> [(when, model)]
    skill: dict = field(default_factory=dict)  # sessionId -> attributionSkill
    title: dict = field(default_factory=dict)  # sessionId -> session name
    cost_by_day: dict = field(default_factory=dict)  # local day -> cost-equivalent
    series: list = field(default_factory=list)  # [(when, cost-equivalent)] sorted


def active_spans(turns, tz=SGT):
    """Each local day's working span: its first turn to its last.

    The honest denominator for lost time. Hour buckets undercount it — an hour
    with one turn and 58 idle minutes counts the same as a full one — but the
    span is what "the day's work" means when asking what a block interrupted.
    """
    per = {}
    for ts in turns.values():
        for at, _model in ts:
            day = at.astimezone(tz).date().isoformat()
            lo, hi = per.get(day, (at, at))
            per[day] = (min(lo, at), max(hi, at))
    return per


def overlap_minutes(intervals, spans):
    """Minutes of blockage that landed inside a day's working span.

    Blockage at 04:00 with nobody working is not lost work, so it does not
    count here — it is still in the wall-clock figure, which is the other half
    of the picture.
    """
    total = 0.0
    for a, b in merge(intervals):
        for lo, hi in spans.values():
            lo, hi = max(a, lo), min(b, hi)
            if hi > lo:
                total += (hi - lo).total_seconds() / 60
    return total


def window_cost(series, at, hours=WINDOW_HOURS):
    """Cost-equivalent spent in the `hours` before `at`.

    The counter that produced every block in this corpus is a *rolling* window,
    so the quantity that matters at an exhaustion is the burst behind it, never
    the calendar day's total.
    """
    lo = at - dt.timedelta(hours=hours)
    return sum(c for t, c in series if lo < t <= at)


def peak_burst_by_day(series, hours=WINDOW_HOURS, tz=SGT):
    """Each local day's worst rolling window, by that window's end.

    Stepped over the events themselves rather than a fixed grid: the maximum of
    a rolling sum always ends at one of them, so this is exact and not a
    sampling.
    """
    series = sorted(series)
    peaks = defaultdict(float)
    lo = 0
    running = 0.0
    for t, c in series:
        running += c
        while series[lo][0] <= t - dt.timedelta(hours=hours):
            running -= series[lo][1]
            lo += 1
        day = t.astimezone(tz).date().isoformat()
        peaks[day] = max(peaks[day], running)
    return dict(peaks)


def scan_file(path, tally):
    """Ceiling events in one transcript, its skips counted into `tally`."""
    for rec in tc.records(path, tally, needle=('"rate_limit"', '"apiErrorStatus":429')):
        if rec.get("type") != "assistant":
            continue
        ev = classify(rec, tally)
        if ev:
            ev["path"] = path
            yield ev


def transcripts():
    """Every seat root's transcripts, one copy of each session."""
    for p, _is_sub, _owner in tc.one_copy_each():
        yield p


def activity(tally):
    """Per-session turn timestamps and attribution, for the denominators.
    `tally` is the caller's accumulator: the skips are counted into it.

    Answers what the events alone cannot: which hours the machine was working
    at all (so a 3am block can be priced at nothing), and what each blocked
    session was doing.
    """
    turns = defaultdict(list)
    skill, title = {}, {}
    cost_by_day = defaultdict(float)
    series = []
    for path in transcripts():
        # One billable unit per requestId, each field the MAX across that
        # request's records — scripts/measure-burn/scan_burn.py's rule (mantahostels#1121),
        # because a subagent transcript streams a rising output count across
        # several records of one request.
        billed = {}
        for rec in tc.records(path, tally, needle='"timestamp"'):
            sid = rec.get("sessionId") or rec.get("session_id")
            if rec.get("type") in ("custom-title", "ai-title", "agent-name"):
                t = rec.get("customTitle") or rec.get("aiTitle") or rec.get("agentName")
                if sid and t:
                    title.setdefault(sid, t)
                continue
            if rec.get("type") != "assistant":
                continue
            msg = rec.get("message") or {}
            use = msg.get("usage") or {}
            if not any(
                use.get(k)
                for k in ("output_tokens", "cache_read_input_tokens", "input_tokens")
            ):
                continue
            at = parse_ts(rec.get("timestamp"))
            if at is None:
                tally["undated turns"] += 1
                continue
            turns[sid].append((at, msg.get("model")))
            rid = rec.get("requestId") or msg.get("id") or rec.get("uuid")
            cur = billed.setdefault(rid, {"ts": at, **sb.zero()})
            tok = sb.tokens(use)
            for f in sb.TOKEN_FIELDS:
                cur[f] = max(cur[f], tok[f])
            cur["ts"] = min(cur["ts"], at)
            if rec.get("attributionSkill"):
                skill.setdefault(sid, rec["attributionSkill"])
        for r in billed.values():
            # Opus 5 API list ratios, each cache write at its TTL's rate — a
            # cost-equivalent, never a bill (mantahostels#829), put beside each
            # day's blockage as a comparable volume figure.
            c = sb.usd(r)
            cost_by_day[r["ts"].astimezone(SGT).date().isoformat()] += c
            series.append((r["ts"], c))
    return Activity(turns, skill, title, dict(cost_by_day), sorted(series))


def account_owner():
    """sessionId → the labels of the seats whose roots hold its transcripts.

    Nothing in a transcript names the account; the seat root it sits under
    does. A session resumed on another seat sits under both, and `owner_of`
    leaves it unattributed rather than guess.
    """
    owner = defaultdict(set)
    for _rel, path, _is_sub, sid in tc.transcript_files():
        seat = tc.seat_of(path)
        if seat:
            owner[sid].add(seat)
    return owner


def owner_of(sid, owner):
    if not sid:
        return None
    hit = owner.get(sid) or set()
    if len(hit) == 1:
        return next(iter(hit))
    return None


def fmt_h(minutes):
    return f"{minutes / 60:.1f}h"


def report(events, act, owner, tally):
    """The whole corpus, always: the denominators (active hours, the
    working-day span, the burst series) are swept whole, so a windowed
    numerator would misstate every share."""
    turns, skill, title = act.turns, act.skill, act.title
    cost_by_day, series = act.cost_by_day, act.series
    evs = dedupe(events)
    kinds = defaultdict(list)
    for e in evs:
        kinds[e["kind"]].append(e)
    eps = episodes(evs)

    all_turns = sorted(t for ts in turns.values() for t, _m in ts)
    if all_turns:
        print(
            f"== Corpus ==\n  {len(all_turns):,} billable turns, "
            f"{all_turns[0].astimezone(SGT):%Y-%m-%d %H:%M} to "
            f"{all_turns[-1].astimezone(SGT):%Y-%m-%d %H:%M} (Asia/Singapore), "
            f"{(all_turns[-1] - all_turns[0]).total_seconds() / 86400:.1f} days.\n"
            "  Every figure below is measured over that whole window, "
            "never a slice of it.\n"
        )
    print(
        f"  {tc.counts_line(tally, tc.UNREADABLE, tc.UNPARSED, 'undated 429s', 'undated turns')}\n"
    )

    print("== Events ==")
    for k in ("window-exhausted", "weekly-exhausted", "request-rejected"):
        print(f"  {k:<18} {len(kinds[k]):>5,} record(s)")
    if not kinds["weekly-exhausted"]:
        print(
            "  No weekly-counter exhaustion appears anywhere in the corpus. "
            "Every block below is the rolling 5-hour window."
        )
    if not eps:
        print("\nNo exhaustion episode in this window.")
        return
    print(
        f"  {len(eps)} episode(s), {len({e['start'].astimezone(SGT).date() for e in eps})}"
        " distinct local day(s)\n"
    )

    spans = [(e["start"], e["end"]) for e in eps]
    total = union_minutes(spans)
    first, last = min(e["start"] for e in eps), max(e["end"] for e in eps)
    days = (last - first).total_seconds() / 86400
    print("== Time past the ceiling ==")
    print(
        f"  observed span      {first.astimezone(SGT):%Y-%m-%d %H:%M} to "
        f"{last.astimezone(SGT):%Y-%m-%d %H:%M} (Asia/Singapore), {days:.1f} days"
    )
    print(
        f"  blocked wall-clock {fmt_h(total)} = {total / (days * 1440) * 100:.1f}% "
        f"of the span, {fmt_h(total / days * 7)} per 7-day week"
    )
    mins = sorted(e["minutes"] for e in eps)
    print(
        f"  episode length     median {mins[len(mins) // 2]:.0f} min  "
        f"mean {sum(mins) / len(mins):.0f} min  max {mins[-1]:.0f} min"
    )

    # Wall-clock overstates the loss: a block at 04:00 local blocks nothing.
    # Active hours are the honest denominator.
    hours = {
        t.astimezone(SGT).strftime("%Y-%m-%d %H")
        for ts in turns.values()
        for t, _m in ts
    }
    per_day_blocked = blocked_by_day(spans)
    active_by_day = defaultdict(int)
    for h in hours:
        active_by_day[h[:10]] += 1
    span_days = {
        (first.astimezone(SGT).date() + dt.timedelta(days=i)).isoformat()
        for i in range(int(days) + 2)
    }
    obs = sorted(d for d in span_days if d in active_by_day)
    act_total = sum(active_by_day[d] for d in obs)
    print(
        f"  active hours       {act_total} hour-buckets carried a turn across "
        f"{len(obs)} day(s) — {act_total / max(len(obs), 1):.1f} h/day"
    )
    if act_total:
        print(
            f"  blocked / active   {total / 60 / act_total * 100:.1f}% of the hours "
            "the machine was actually working"
        )
    work_spans = active_spans(turns)
    inside = overlap_minutes([(e["start"], e["end"]) for e in eps], work_spans)
    span_total = sum(
        (hi - lo).total_seconds() / 60
        for d, (lo, hi) in work_spans.items()
        if d in set(obs)
    )
    if span_total:
        print(
            f"  working-day span   {fmt_h(span_total)} across those days "
            f"(first turn to last, each day)"
        )
        print(
            f"  blocked inside it  {fmt_h(inside)} = {inside / span_total * 100:.1f}% "
            "of the working day, the rest falling when nothing was running"
        )
    print()

    print("== By week (Mon-Sun, Asia/Singapore) ==")
    per_week = defaultdict(float)
    for d, b in per_day_blocked.items():
        per_week[dt.date.fromisoformat(d).isocalendar()[:2]] += b
    week_days = defaultdict(set)
    for d in obs:
        week_days[dt.date.fromisoformat(d).isocalendar()[:2]].add(d)
    for wk in sorted(set(per_week) | set(week_days)):
        d0 = dt.date.fromisocalendar(wk[0], wk[1], 1)
        print(
            f"  w/c {d0}  {fmt_h(per_week.get(wk, 0.0)):>7} blocked  "
            f"over {len(week_days.get(wk, ())):>1} active day(s)"
        )
    print(
        f"  last exhaustion anywhere in the corpus: "
        f"{max(e['start'] for e in eps).astimezone(SGT):%Y-%m-%d %H:%M} (SGT)"
    )
    print()

    # Turns per day sit beside blockage deliberately: a quiet day is only
    # evidence about capacity if the volume that day was comparable.
    turns_by_day = defaultdict(int)
    for ts in turns.values():
        for at, _m in ts:
            turns_by_day[at.astimezone(SGT).date().isoformat()] += 1
    peaks = peak_burst_by_day(series)
    print("== Shape of the week ==")
    print("  Day (SGT)   blocked   active h    turns   cost-eq   worst 5h   episodes")
    for d in sorted(set(obs) | set(per_day_blocked) | set(turns_by_day)):
        b = per_day_blocked.get(d, 0.0)
        n = sum(1 for e in eps if e["start"].astimezone(SGT).date().isoformat() == d)
        bar = "#" * int(b / 15)
        print(
            f"  {d}  {fmt_h(b):>7}   {active_by_day[d]:>6}   {turns_by_day[d]:>6}   "
            f"${cost_by_day.get(d, 0):>7,.0f}   ${peaks.get(d, 0):>7,.0f}   {n:>3}  {bar}"
        )
    by_dow = defaultdict(float)
    for d, b in per_day_blocked.items():
        by_dow[dt.date.fromisoformat(d).strftime("%a")] += b
    print(
        "  by weekday: "
        + "  ".join(
            f"{k} {fmt_h(v)}" for k, v in sorted(by_dow.items(), key=lambda kv: -kv[1])
        )
    )
    by_hour = defaultdict(int)
    for e in eps:
        by_hour[e["start"].astimezone(SGT).hour] += 1
    print(
        "  episode starts by local hour: "
        + "  ".join(f"{h:02d}:00 x{n}" for h, n in sorted(by_hour.items()))
    )
    # Blocked *minutes* by hour of day, which the start histogram cannot show:
    # a block beginning at 22:00 spends most of itself after midnight.
    mins_by_hour = defaultdict(float)
    for a, b in merge(spans):
        a = a.astimezone(SGT)
        b = b.astimezone(SGT)
        while a < b:
            nxt = min(
                b,
                (a + dt.timedelta(hours=1)).replace(minute=0, second=0, microsecond=0),
            )
            mins_by_hour[a.hour] += (nxt - a).total_seconds() / 60
            a = nxt
    print("  blocked hours by local hour:")
    for lo in range(0, 24, 8):
        print(
            "    "
            + "  ".join(
                f"{h:02d} {mins_by_hour[h] / 60:4.1f}h" for h in range(lo, lo + 8)
            )
        )
    print()

    print("== Burst, not daily total ==")
    print(
        "  Every block in this corpus came off the rolling 5-hour counter, so "
        "the\n  quantity to look at is the 5 hours behind each one. "
        "Cost-equivalent at Opus 5\n  list ratios (mantahostels#829) — a proxy for what "
        "the plan meters, which is unpublished."
    )
    # The first block of a local day only. A later one in the same day sits
    # behind hours the earlier block already suppressed, so its burst reads low
    # for the wrong reason.
    first_of_day = {}
    for e in eps:
        d = e["start"].astimezone(SGT).date().isoformat()
        if d not in first_of_day or e["start"] < first_of_day[d]:
            first_of_day[d] = e["start"]
    blocked_days = {d for d, b in per_day_blocked.items() if b > 0}
    at_block = sorted((window_cost(series, t), d) for d, t in first_of_day.items())
    clean = sorted((v, d) for d, v in peaks.items() if d not in blocked_days and v > 0)
    print(
        f"  5h burst behind a day's first block:  "
        f"median ${at_block[len(at_block) // 2][0]:,.0f}   "
        f"smallest ${at_block[0][0]:,.0f} ({at_block[0][1]})   "
        f"largest ${at_block[-1][0]:,.0f} ({at_block[-1][1]})"
    )
    if clean:
        print(
            f"  worst 5h on a day with no block:     "
            f"median ${clean[len(clean) // 2][0]:,.0f}   "
            f"largest ${clean[-1][0]:,.0f} ({clean[-1][1]})"
        )
        print(
            f"  The largest burst that blocked nothing is "
            f"{clean[-1][0] / at_block[-1][0]:.1f}x the largest that did, and "
            f"{sum(1 for v, _ in clean if v > at_block[0][0])} of {len(clean)} "
            "clean days ran"
        )
        print(
            "  hotter than the smallest burst that blocked. So this proxy does "
            "not predict the"
        )
        print(
            "  ceiling: either the ceiling moved over the month, or what the "
            "plan meters is"
        )
        print("  not what these ratios weight.")
    print()

    print("== What was blocked ==")
    blocked_sessions = {s for e in eps for s in e["sessions"]}
    print(
        f"  {len(blocked_sessions)} distinct session(s) hit a wall; "
        f"median {sorted(len(e['sessions']) for e in eps)[len(eps) // 2]} "
        "session(s) blocked per episode, "
        f"max {max(len(e['sessions']) for e in eps)}"
    )
    by_skill = defaultdict(int)
    for s in blocked_sessions:
        by_skill[skill.get(s) or "(unattributed)"] += 1
    for k, n in sorted(by_skill.items(), key=lambda kv: -kv[1]):
        print(f"    {k:<22} {n:>3} session(s)")
    named = [title[s] for s in blocked_sessions if s in title]
    for t in named[:12]:
        print(f"    · {t[:88]}")
    print()

    # Did the work resume when the allowance came back, or was the session
    # simply lost? Timed from each session's LAST retry into the window: a turn
    # landing seconds after the first refusal is an in-flight request, and
    # timing from the first refusal scores those as early resumptions — which
    # is what a second account picking the work up would also look like.
    print("== What happened next ==")
    before = after = never = 0
    waits, early_models = [], defaultdict(int)
    for ep in eps:
        for s_id, last in ep["last"].items():
            nxt = sorted(t for t in turns.get(s_id, []) if t[0] > last)
            if not nxt:
                never += 1
                continue
            at, model = nxt[0]
            if at < ep["end"] - dt.timedelta(minutes=1):
                before += 1
                early_models[model or "?"] += 1
            else:
                after += 1
            waits.append((at - last).total_seconds() / 60)
    print(
        f"  resumed before the stated reset  {before:>4}  (a second account or "
        "another model picking the work up would show here"
        + (
            ": " + ", ".join(f"{m} x{n}" for m, n in early_models.items())
            if early_models
            else ""
        )
        + ")"
    )
    print(f"  resumed at or after the reset    {after:>4}")
    print(f"  never produced another turn      {never:>4}")
    if waits:
        waits.sort()
        print(
            f"  wait from last retry to next turn: median {waits[len(waits) // 2]:.0f} min  "
            f"max {waits[-1]:.0f} min"
        )
    print()

    print("== Which plan was blocked ==")
    counts = defaultdict(int)
    for s in blocked_sessions:
        counts[owner_of(s, owner) or "(unattributable)"] += 1
    for k, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {k:<20} {n:>4} blocked session(s)")
    covered = sum(1 for s_id in blocked_sessions if owner_of(s_id, owner))
    ev_sessions = {e["session"] for e in evs}
    ev_covered = sum(1 for s_id in ev_sessions if owner_of(s_id, owner))
    print(
        "  Nothing in a transcript names the account; this is the seat root "
        "holding it, and a session on two seats is unattributable."
    )
    print(
        f"  Coverage: {covered} of {len(blocked_sessions)} blocked session(s) "
        f"attributable, {ev_covered} of {len(ev_sessions)} across every session "
        "carrying any 429."
    )


def main():
    argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    ).parse_args()
    tally = Counter()
    events = [e for p in transcripts() for e in scan_file(p, tally)]
    report(events, activity(tally), account_owner(), tally)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
