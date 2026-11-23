#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import os
import statistics as st
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import transcript_corpus as tc
from fail_open import expected, fail_open, tallied

WEIGHTS = {"fi": 15.0, "out": 75.0, "cw": 18.75, "cw1h": 30.0, "cr": 1.50}
WINDOW = ("2026-07-22", "2026-08-20T12:09")
CLASSES = ("fi", "out", "cw", "cr")
TOKEN_FIELDS = CLASSES + ("cw5m", "cw1h")
SYNTHETIC = "<synthetic>"
OVERFLOW_CLI = Path(__file__).resolve().parent.parent / "overflow-sessions.js"
LABELS = {"fi": "Fresh input", "out": "Output", "cw": "Cache write", "cr": "Cache read"}


def writes_by_ttl(tok):
    return tok["cw5m"] + max(0, tok["cw"] - tok["cw5m"] - tok["cw1h"]), tok["cw1h"]


def class_usd(tok):
    w5m, w1h = writes_by_ttl(tok)
    out = {f: tok[f] * WEIGHTS[f] / 1e6 for f in CLASSES if f != "cw"}
    out["cw"] = (w5m * WEIGHTS["cw"] + w1h * WEIGHTS["cw1h"]) / 1e6
    return out


def usd(tok):
    return sum(class_usd(tok).values())


def split_field(use, key):
    v = use.get(key)
    if v is None:
        v = (use.get("cache_creation") or {}).get(key)
    return v or 0


def tokens(use):
    return {
        "fi": use.get("input_tokens") or 0,
        "out": use.get("output_tokens") or 0,
        "cw": use.get("cache_creation_input_tokens") or 0,
        "cr": use.get("cache_read_input_tokens") or 0,
        "cw5m": split_field(use, "ephemeral_5m_input_tokens"),
        "cw1h": split_field(use, "ephemeral_1h_input_tokens"),
    }


def zero():
    return dict.fromkeys(TOKEN_FIELDS, 0)


def add_request(acc, tok):
    for f in CLASSES:
        acc[f] += tok[f]
    w5m, w1h = writes_by_ttl(tok)
    acc["cw5m"] += w5m
    acc["cw1h"] += w1h


UNKEYED = "unkeyed"
UNDATED_SESSIONS = "undated sessions"
UNDATED_REQUESTS = "undated requests"


def requests(tally, window=None, keep_records=False):
    agg, group_rel, group_path = {}, None, None
    for rel, path, is_sub, owner in tc.transcript_files():
        if rel != group_rel:
            yield from _in_window(agg, window)
            agg, group_rel, group_path = {}, rel, path
        for rec in tc.records(path, tally, needle='"assistant"'):
            if rec.get("type") != "assistant":
                continue
            msg = rec.get("message") or {}
            use = msg.get("usage")
            if not use or msg.get("model") == SYNTHETIC:
                continue
            ts = rec.get("timestamp") or ""
            rid = rec.get("requestId") or msg.get("id")
            if rid is None:
                tally[UNKEYED] += 1
                rid = rec.get("uuid")
            tok = tokens(use)
            extra = {
                "effort": rec.get("effort"),
                "think": (use.get("output_tokens_details") or {}).get("thinking_tokens")
                or 0,
                "tools": sum(
                    1
                    for c in (msg.get("content") or [])
                    if isinstance(c, dict) and c.get("type") == "tool_use"
                ),
            }
            cur = agg.get(rid)
            if cur is None:
                agg[rid] = {
                    **tok,
                    "ts": ts,
                    "path": group_path,
                    "sub": is_sub,
                    "owner": owner,
                    "session": rec.get("sessionId") or owner,
                    "entrypoint": rec.get("entrypoint"),
                    "model": msg.get("model"),
                    "skill": rec.get("attributionSkill"),
                    "version": rec.get("version"),
                    **extra,
                    "records": 1,
                    "seen": [tok] if keep_records else None,
                }
            else:
                for f in TOKEN_FIELDS:
                    cur[f] = max(cur[f], tok[f])
                cur["records"] += 1
                if ts and ts < cur["ts"]:
                    cur["ts"] = ts
                if keep_records:
                    cur["seen"].append(tok)
                cur["skill"] = cur["skill"] or rec.get("attributionSkill")
                cur["effort"] = cur["effort"] or extra["effort"]
                cur["version"] = cur["version"] or rec.get("version")
                for f in ("think", "tools"):
                    cur[f] = max(cur[f], extra[f])
    yield from _in_window(agg, window)


def overflow_sessions(session_ids):
    done = subprocess.run(
        ["node", str(OVERFLOW_CLI)],
        input="\n".join(session_ids),
        capture_output=True,
        text=True,
    )
    if done.returncode != 0:
        raise SystemExit(f"scan_burn: {done.stderr.strip()}")
    return set(done.stdout.split())


def _in_window(agg, window):
    for r in agg.values():
        if window and not (window[0] <= r["ts"] < window[1]):
            continue
        yield r


def totals(reqs):
    t = zero()
    for r in reqs:
        add_request(t, r)
    return t


def unkeyed_warning(tally):
    if not tally[UNKEYED]:
        return None
    return (
        f"⚠ {tally[UNKEYED]:,} record(s) carried neither requestId nor "
        f"message.id and were counted as one request each"
    )


def report(reqs, tally):
    tot = totals(reqs)
    cost = usd(tot)
    tokens = sum(tot.values())
    print(f"requests: {len(reqs):,}")
    print(f"  {tc.counts_line(tally)}")
    if warning := unkeyed_warning(tally):
        print(f"  {warning}")
    print(
        "Every dollar below is the four token classes weighted at Opus 5 API "
        "list ratios — a cost-equivalent, never a bill (mantahostels#829).\n"
    )
    if not reqs or cost <= 0 or tokens <= 0:
        print("Nothing to report: no billable request matched.")
        return

    print("== Totals ==")
    for f in ("fi", "out", "cw", "cr"):
        print(f"  {LABELS[f]:<13} {tot[f]:>16,}")
    print(f"  {'Cost-equivalent':<13} {'$' + format(cost, ',.0f'):>16}\n")

    print("== Shares by token class ==")
    by_class = class_usd(tot)
    for f in ("cr", "cw", "out", "fi"):
        c = by_class[f]
        print(
            f"  {LABELS[f]:<13} ${c:>9,.0f}  {c / cost * 100:5.1f}% of cost   "
            f"{tot[f] / tokens * 100:5.2f}% of tokens"
        )
    if tot["out"]:
        print(f"  cache reads : output tokens = {tot['cr'] / tot['out']:.0f}:1")
    print()

    subs = [r for r in reqs if r["sub"]]
    sub_tok = totals(subs)
    sub_cost = usd(sub_tok)
    print("== Fan-out ==")
    print(f"  subagent ${sub_cost:,.0f} of ${cost:,.0f} = {sub_cost / cost * 100:.1f}%")
    disp = defaultdict(zero)
    for r in subs:
        add_request(disp[r["path"]], r)
    dv = sorted((usd(v) for v in disp.values()), reverse=True)
    if dv:
        cw = sorted(v["cw"] for v in disp.values())
        print(
            f"  dispatches n={len(dv):,}  median ${st.median(dv):.2f}  mean ${st.mean(dv):.2f}  "
            f"p90 ${dv[int(len(dv) * 0.1)]:.2f}  max ${dv[0]:.2f}"
        )
        print(
            f"  top 10% carry {sum(dv[: max(1, len(dv) // 10)]) / sum(dv) * 100:.1f}%"
        )
        print(
            f"  cache write per dispatch: median {st.median(cw) / 1000:.1f}k  "
            f"mean {st.mean(cw) / 1000:.1f}k"
        )
    if subs:
        sub_class = class_usd(sub_tok)
        print(
            "  subagent spend by class: "
            + "  ".join(
                f"{LABELS[f].lower()} {sub_class[f] / sub_cost * 100:.1f}%"
                for f in CLASSES
            )
        )
        print()

    print("== By model ==")
    by_model = defaultdict(float)
    for r in reqs:
        by_model[r["model"] or "?"] += usd(r)
    for m, c in sorted(by_model.items(), key=lambda kv: -kv[1])[:8]:
        print(f"  {m:<32} ${c:>9,.0f}  {c / cost * 100:5.1f}%")
    print()

    print("== By attributionSkill ==")
    print("  A subagent inherits its parent's value, so a row is the skill that")
    print("  dispatched the work, never the work done. Never split cost by this alone.")
    by_skill = defaultdict(float)
    for r in reqs:
        by_skill[r["skill"] or "(unattributed)"] += usd(r)
    for s, c in sorted(by_skill.items(), key=lambda kv: -kv[1])[:12]:
        print(f"  {s:<26} ${c:>9,.0f}  {c / cost * 100:5.1f}%")
    print()

    entry = {
        r["owner"]: r["entrypoint"] for r in reqs if not r["sub"] and r["entrypoint"]
    }
    sess = defaultdict(
        lambda: {"own": 0.0, "all": 0.0, "ctx": [], "t0": None, "t1": None}
    )
    for r in reqs:
        s = sess[r["owner"]]
        s["all"] += usd(r)
        if not r["sub"]:
            s["own"] += usd(r)
            s["ctx"].append(r["cr"])
            if s["t0"] is None or r["ts"] < s["t0"]:
                s["t0"] = r["ts"]
            if s["t1"] is None or r["ts"] > s["t1"]:
                s["t1"] = r["ts"]
    cli = [v for k, v in sess.items() if entry.get(k) == "cli"]
    if cli:
        print(f"== Per session (cli only, n={len(cli):,}) ==")
        for key, lbl in (
            ("own", "parent turns only"),
            ("all", "with its subagents folded in"),
        ):
            v = sorted(s[key] for s in cli)
            print(
                f"  {lbl:<28} median ${st.median(v):6.2f}  mean ${st.mean(v):6.2f}  "
                f"p90 ${v[int(len(v) * 0.9)]:6.2f}  max ${max(v):7.2f}"
            )
        v = sorted((s["all"] for s in cli), reverse=True)
        for frac, lbl in ((0.5, "50%"), (0.8, "80%"), (0.9, "90%")):
            run, carried = 0.0, 0
            for c in v:
                carried += 1
                run += c
                if run >= sum(v) * frac:
                    break
            print(
                f"  top {carried / len(v) * 100:4.1f}% of sessions carry {lbl} of spend"
            )
        ctx = sorted(c for s in cli for c in s["ctx"])
        print(
            f"  context re-read per turn: median {st.median(ctx) / 1000:.0f}k  "
            f"mean {st.mean(ctx) / 1000:.0f}k  p90 {ctx[int(len(ctx) * 0.9)] / 1000:.0f}k  "
            f"max {ctx[-1] / 1000:.0f}k"
        )
        durs = []
        for s in cli:
            try:
                a = dt.datetime.fromisoformat(s["t0"].replace("Z", "+00:00"))
                b = dt.datetime.fromisoformat(s["t1"].replace("Z", "+00:00"))
                durs.append((b - a).total_seconds() / 60)
            except (AttributeError, TypeError, ValueError) as e:
                tallied(e, tally, UNDATED_SESSIONS)
        durs.sort()
        if durs:
            print(
                f"  duration (min): median {st.median(durs):.1f}  mean {st.mean(durs):.1f}  "
                f"p90 {durs[int(len(durs) * 0.9)]:.1f}  max {durs[-1]:.0f}"
            )
        print(f"  ({UNDATED_SESSIONS}: {tally[UNDATED_SESSIONS]})")
    sdk = [v["all"] for k, v in sess.items() if entry.get(k) == "sdk-py"]
    if sdk:
        print(
            f"  sdk-py population: n={len(sdk):,}  median ${st.median(sdk):.2f}  "
            f"${sum(sdk):,.0f} = {sum(sdk) / cost * 100:.1f}% of all spend"
        )


def audit(reqs, windowed=False):
    ok = True
    mid_to_rid, rid_to_mid = defaultdict(set), defaultdict(set)
    skipped = Counter()
    for path, _is_sub, _owner in tc.transcripts():
        for rec in tc.records(path, skipped, needle='"assistant"'):
            if rec.get("type") != "assistant":
                continue
            msg = rec.get("message") or {}
            if not msg.get("usage") or msg.get("model") == SYNTHETIC:
                continue
            mid, rid = msg.get("id"), rec.get("requestId")
            if mid and rid:
                mid_to_rid[mid].add(rid)
                rid_to_mid[rid].add(mid)
    print("== Fact 1: message.id and requestId are 1:1 (whole corpus) ==")
    many_r = sum(1 for v in mid_to_rid.values() if len(v) > 1)
    many_m = sum(1 for v in rid_to_mid.values() if len(v) > 1)
    print(
        f"  distinct message.id {len(mid_to_rid):,}   distinct requestId {len(rid_to_mid):,}"
    )
    print(f"  {tc.counts_line(skipped)}")
    print(f"  message.id with >1 requestId: {many_r:,}")
    print(f"  requestId with >1 message.id: {many_m:,}")
    if not mid_to_rid:
        print("  FAIL: no record carried both a message.id and a requestId.")
        ok = False
    elif many_r or many_m:
        print(
            "  FAIL: the ids are no longer 1:1, so deduplicating on either "
            "is no longer the same operation."
        )
        ok = False
    else:
        print("  PASS")

    print(
        f"\n== Fact 2: within-request disagreement is monotonic, so MAX is the rule "
        f"({'windowed' if windowed else 'whole corpus'}) =="
    )
    for is_sub, lbl in ((False, "main-session"), (True, "subagent")):
        pop = [r for r in reqs if r["sub"] is is_sub and r["seen"]]
        if not pop:
            continue
        disagree = [
            r for r in pop if len({tuple(s[f] for f in CLASSES) for s in r["seen"]}) > 1
        ]
        mono, stream, cumul = 0, 0, 0
        for r in disagree:
            seen = r["seen"]
            if not all(
                seen[i][f] <= seen[i + 1][f]
                for f in CLASSES
                for i in range(len(seen) - 1)
            ):
                continue
            mono += 1
            if len({s["cr"] for s in seen}) == 1 and len({s["cw"] for s in seen}) == 1:
                stream += 1
            else:
                cumul += 1
        print(
            f"  {lbl:<13} {len(pop):>7,} requests, "
            f"{sum(r['records'] for r in pop) / len(pop):.2f} records each; "
            f"{len(disagree):,} disagree ({len(disagree) / len(pop) * 100:.1f}%)"
            + (
                f", of those {stream:,} stream-shaped and {cumul:,} cumulative-shaped"
                if disagree
                else ""
            )
        )
        if disagree and mono != len(disagree):
            print(
                f"  FAIL: {len(disagree) - mono:,} {lbl} request(s) have a token "
                f"field that falls between records, so MAX is no longer the right rule."
            )
            ok = False
    if ok:
        print("  PASS")

    print("\n== Consequence: what each candidate key totals ==")
    first = zero()
    mx = zero()
    tuple_key = zero()
    for r in reqs:
        if not r["seen"]:
            continue
        add_request(first, r["seen"][0])
        add_request(mx, r)
        keep = {}
        for s in r["seen"]:
            keep.setdefault((s["out"], s["cw"]), s)
        for s in keep.values():
            add_request(tuple_key, s)
    base = usd(mx)
    if base <= 0:
        print("  Nothing to compare: no billable request matched.")
        return ok
    for name, t in (
        ("mantahostels#830 tuple key", tuple_key),
        ("first record wins", first),
        ("MAX (correct)", mx),
    ):
        print(
            f"  {name:<20} ${usd(t):>9,.0f}   x{usd(t) / base:.3f} against the correct rule"
        )
    return ok


UNATTRIBUTED = "(unattributed)"


def seat_map(tally):
    owner, ambiguous, read = {}, set(), []
    for cfg, d in tc.seats().items():
        try:
            fh = open(os.path.join(cfg, "history.jsonl"), "r", errors="replace")
        except FileNotFoundError as e:
            expected(e, f"seat {d} never typed a prompt, or was never created")
            continue
        except OSError as e:
            fail_open(e, f"seat {d} history left unread")
            continue
        read.append(d)
        with fh:
            for line in fh:
                try:
                    sid = json.loads(line).get("sessionId")
                except (ValueError, AttributeError) as e:
                    tallied(e, tally, "unparsed history lines")
                    continue
                if sid and owner.setdefault(sid, d) != d:
                    ambiguous.add(sid)
    return owner, ambiguous, read


def seat_accounts():
    out = {}
    for cfg, label in tc.seats().items():
        try:
            with open(os.path.join(cfg, ".claude.json"), errors="replace") as fh:
                acct = (json.load(fh) or {}).get("oauthAccount") or {}
                if isinstance(acct, dict) and acct.get("emailAddress"):
                    out[label] = acct["emailAddress"]
        except FileNotFoundError as e:
            expected(e, f"seat {label} never signed in, or was never created")
            continue
        except (OSError, ValueError, AttributeError) as e:
            fail_open(e, f"seat {label} account read as unknown")
            continue
    return out


def peak_window(points, hours=5):
    pts = sorted(points)
    span = hours * 3600
    best, best_at, run, lo = 0.0, None, 0.0, 0
    for t, c in pts:
        run += c
        while pts[lo][0] <= t - span:
            run -= pts[lo][1]
            lo += 1
        if run > best:
            best, best_at = run, pts[lo][0]
    return best, best_at


def seat_report(reqs, tally):
    owner, ambiguous, roots = seat_map(tally)
    emails = seat_accounts()
    cost = usd(totals(reqs))
    by = defaultdict(lambda: {"cost": 0.0, "sessions": set(), "pts": []})
    for r in reqs:
        sid = r["owner"]
        seat = UNATTRIBUTED if (sid in ambiguous or sid not in owner) else owner[sid]
        c = usd(r)
        b = by[seat]
        b["cost"] += c
        b["sessions"].add(sid)
        try:
            b["pts"].append(
                (
                    dt.datetime.fromisoformat(
                        r["ts"].replace("Z", "+00:00")
                    ).timestamp(),
                    c,
                )
            )
        except (ValueError, AttributeError) as e:
            tallied(e, tally, UNDATED_REQUESTS)

    def label(seat):
        return f"{seat} {emails.get(seat, '')}".strip()

    print("== By seat ==")
    print("  A subagent books to the seat of the session that dispatched it; a session")
    print("  that never received a typed prompt cannot be attributed at all.")
    print(
        f"  Roots read: {', '.join(roots) if roots else 'NONE — every seat will read as unattributed'}"
    )
    print(f"  (unparsed history lines: {tally['unparsed history lines']})")
    if ambiguous:
        print(
            f"  ⚠ {len(ambiguous):,} session(s) resolve to more than one root — "
            f"resumed on another seat, and counted as unattributed"
        )
    if not by or cost <= 0:
        print("  Nothing to report: no billable request matched.")
        return
    order = sorted(by.items(), key=lambda kv: -kv[1]["cost"])
    for seat, b in order:
        print(
            f"  {label(seat):<44} ${b['cost']:>9,.0f}  {b['cost'] / cost * 100:5.1f}%  "
            f"{len(b['sessions']):>5,} sessions"
        )
    print()
    print("== Peak 5-hour window, per seat ==")
    print("  A cost-equivalent, never the percentage the seat's own meter reports —")
    print(
        "  what a Max plan meters is unpublished (mantahostels#829). Compare seats and days with"
    )
    print("  it; never compare it against a limit. Read the meter itself with")
    print(
        "  `node scripts/check-seat-utilisation.js`. The meter's own window is anchored"
    )
    print("  at its resets_at, and a rolling maximum can straddle two of those.")
    if tally[UNDATED_REQUESTS]:
        print(
            f"  ⚠ {tally[UNDATED_REQUESTS]:,} request(s) carried no parsable timestamp and are in the "
            f"totals above but not in any window"
        )
    for seat, b in order:
        peak, at = peak_window(b["pts"])
        when = (
            "—"
            if at is None
            else dt.datetime.fromtimestamp(at, dt.timezone.utc).strftime(
                "%Y-%m-%dT%H:%MZ"
            )
        )
        print(f"  {label(seat):<44} ${peak:>9,.0f}  window opens {when}")


def normalise_bound(ap, raw, flag):
    if not raw:
        return None
    try:
        parsed = dt.datetime.fromisoformat(raw)
    except ValueError:
        ap.error(
            f"{flag} needs an ISO date or timestamp, not {raw!r}: write it as "
            "2026-08-22 or 2026-08-22T12:00:00Z."
        )
    if parsed.utcoffset() not in (None, dt.timedelta(0)):
        ap.error(
            f"{flag} must be UTC. Every corpus timestamp ends in Z, and the "
            f"filter compares strings, so {raw!r} would be read as its "
            "local wall clock rather than converted — up to 14h of spend in or "
            "out. Convert it to UTC and end it in Z."
        )
    return parsed.replace(tzinfo=None).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--all", action="store_true", help="whole corpus, not mantahostels#830's window"
    )
    ap.add_argument(
        "--since",
        metavar="ISO",
        help="everything from this UTC date or timestamp onward, e.g. "
        "2026-08-22 — a rolling reading, where the default is "
        "mantahostels#830's fixed window",
    )
    ap.add_argument(
        "--by-seat",
        action="store_true",
        help="add spend and the peak 5-hour window per subscription "
        "seat, joined on each config root's own history.jsonl",
    )
    ap.add_argument(
        "--until",
        metavar="ISO",
        help="exclusive upper bound, same UTC rules as --since; with it a "
        "route that has since been replaced can be priced over its "
        "own era rather than to today",
    )
    ap.add_argument(
        "--audit",
        action="store_true",
        help="re-verify the method's two premises; exits 1 if either fails",
    )
    args = ap.parse_args(argv)
    if (args.since or args.until) and args.all:
        ap.error(
            "--since/--until and --all are mutually exclusive: one windows, the other does not. "
            "Drop --all to window, or drop --since/--until to read the whole corpus."
        )
    if args.until and not args.since:
        ap.error(
            "--until needs a --since: the default window is mantahostels#830's fixed one, and "
            "half-overriding it would price a period nobody chose. Add a --since, or drop "
            "--until to keep the fixed window."
        )
    since = normalise_bound(ap, args.since, "--since")
    until = normalise_bound(ap, args.until, "--until")
    if since and until and until <= since:
        ap.error(
            f"--until {args.until!r} is at or before --since {args.since!r}, so the window is empty. "
            "Move --until later than --since."
        )
    if since:
        window = (since, until or "9999")
    elif args.all:
        window = None
    else:
        window = WINDOW
    tally = Counter()
    reqs = list(requests(tally, window, keep_records=args.audit))
    overflow = overflow_sessions({r["owner"] for r in reqs})
    reqs = [r for r in reqs if r["owner"] not in overflow]
    if window is None:
        label = "whole corpus"
    elif since:
        label = f"{since} to {until}" if until else f"{since} onward"
    else:
        label = " to ".join(WINDOW)
    print(f"window: {label}")
    home = os.path.expanduser("~")
    counts = [
        f"{r.replace(home, '~', 1)} {n:,}"
        + (" (symlink, read once)" if os.path.islink(r) else "")
        for r, n in tc.root_files().items()
    ]
    print(
        "transcript files per root: "
        + (", ".join(counts) or "NONE — no seat root holds this repo's transcripts")
    )
    if overflow:
        print(f"overflow sessions left out: {len(overflow):,}")
    print()
    ok = True
    if args.audit:
        ok = audit(reqs, windowed=window is not None)
        print()
    report(reqs, tally)
    if args.by_seat:
        print()
        seat_report(reqs, tally)
    if not ok:
        print(
            "\nAUDIT FAILED — the corpus no longer matches the method's "
            "premises. Do not trust the figures above."
        )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
