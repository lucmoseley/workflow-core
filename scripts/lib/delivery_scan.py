"""delivery_scan.py — what the two delivery-cost scanners, scan_long_lines.py and
scan_ledger.py, share: the parent transcripts a delivery could sit in, the
in-window tool results and the call behind each, how a Bash call read its
target, the text an intent check matches, the bytes that landed, the later
turns that re-read them, and the growth fit over a line's daily sizes (workflow-core#1322,
workflow-core#1351). scan_arbiter.py counts its byte figures through `result_text` too, so a
change there moves its figures as well.
"""

import datetime
import json
import os
import re
import subprocess
from typing import NamedTuple

import transcript_corpus as tc

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))


def git(*args):
    return subprocess.run(
        ["git", "-C", REPO, *args], capture_output=True, text=True, check=True
    ).stdout


def window_days(start, end):
    """Each ISO day from `start` to `end`, both included."""
    d0 = datetime.date.fromisoformat(start)
    d1 = datetime.date.fromisoformat(end)
    return [
        (d0 + datetime.timedelta(days=n)).isoformat() for n in range((d1 - d0).days + 1)
    ]


def revision_on(day, path):
    """The last commit to touch `path` by the end of `day`, or "" before its
    first."""
    return git("rev-list", "-1", f"--before={day}T23:59:59", "HEAD", "--", path).strip()


def parent_transcripts(tally, find):
    """(path, find's answer, records) for each parent transcript whose raw text
    `find` answers truthily — the cheap substring test before any line is
    parsed. `tally` is the caller's accumulator: a file that will not open
    counts as `tc.records` counts it (workflow-core#1274).

    The caller must `del recs` at the end of each iteration: its loop variable
    otherwise holds one file's records while the next file is read.
    """
    for fp in tc.main_transcripts():
        try:
            with open(fp, encoding="utf-8", errors="replace") as fh:
                raw = fh.read()
        except OSError:
            tally[tc.UNREADABLE] += 1
            continue
        found = find(raw)
        if not found:
            del raw
            continue
        recs = list(tc.parsed(raw.split("\n"), tally))
        del raw
        yield fp, found, recs
        del recs


def _tool_uses(recs):
    """{tool_use id: (tool name, input)} over every record."""
    out = {}
    for r in recs:
        c = (r.get("message") or {}).get("content")
        if isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    out[b.get("id")] = (b.get("name"), b.get("input") or {})
    return out


def tool_route(name, inp):
    """The route a non-Bash tool call delivered by, or None for Bash, whose
    route each scanner judges against its own target."""
    if name == "Read":
        partial = inp.get("offset") is not None or inp.get("limit") is not None
        return "Read (partial)" if partial else "Read (whole file)"
    if name == "Grep":
        return "Grep tool"
    if name != "Bash":
        return f"other ({name})"
    return None


class ToolResult(NamedTuple):
    pos: int
    timestamp: str
    text: str
    name: str
    input: dict
    command: str


def tool_results(recs, start, end):
    """Each non-empty `tool_result` in a record dated `start`..`end`, with the
    call behind it. `pos` is its record's position in `recs`; `command` is a
    Bash call's command with whitespace runs collapsed, and "" for any other
    tool."""
    calls = _tool_uses(recs)
    for i, r in enumerate(recs):
        ts = r.get("timestamp", "")
        if not (start <= ts[:10] <= end):
            continue
        c = (r.get("message") or {}).get("content")
        if not isinstance(c, list):
            continue
        for b in c:
            if not (isinstance(b, dict) and b.get("type") == "tool_result"):
                continue
            txt = result_text(b)
            if not txt:
                continue
            name, inp = calls.get(b.get("tool_use_id"), ("?", {}))
            cmd = (
                re.sub(r"\s+", " ", inp.get("command") or "") if name == "Bash" else ""
            )
            yield ToolResult(i, ts, txt, name, inp, cmd)


def bash_read_kind(cmd):
    """How a Bash command read its target: "git diff/show", "Bash grep",
    "Bash range/cat" or "Bash other", first match winning in that order."""
    if re.search(r"\bgit (diff|show|log|blame)\b", cmd):
        return "git diff/show"
    if re.search(r"\bgrep\b", cmd):
        return "Bash grep"
    if re.search(r"\b(sed|awk|head|tail|cat)\b", cmd):
        return "Bash range/cat"
    return "Bash other"


def intent_text(res):
    """A result's command and whole tool input, lowercased: what an intent
    check matches a session's words against."""
    return (res.command + json.dumps(res.input, ensure_ascii=False)).lower()


def landed_bytes(text, keep):
    """UTF-8 bytes of the lines of `text` that `keep` answers truthily — the
    lines that landed, as truncated by whatever ran."""
    return sum(len(s.encode("utf-8", "replace")) for s in text.split("\n") if keep(s))


def result_text(block):
    rc = block.get("content")
    if isinstance(rc, str):
        return rc
    if isinstance(rc, list):
        return "\n".join(x.get("text", "") for x in rc if isinstance(x, dict))
    return ""


def suffix_distinct_turns(recs):
    """For each record index, how many distinct assistant *turns* follow it.

    A parent transcript emits 2-3 `type:"assistant"` records per request, all
    carrying one `message.id` (mantahostels#1121). Dedupe on the id here or not at all:
    window_cost() dedupes, so counting records inflates only the numerator.
    """
    out = [0] * (len(recs) + 1)
    seen = set()
    for i in range(len(recs) - 1, -1, -1):
        r = recs[i]
        if r.get("type") == "assistant":
            seen.add((r.get("message") or {}).get("id") or f"_anon{i}")
        out[i] = len(seen)
    return out


def growth_per_day(sizes):
    """Least-squares slope of {day: size} against day index, in bytes/day."""
    pts = sorted(sizes.items())
    if len(pts) < 2:
        return 0.0
    xs = list(range(len(pts)))
    ys = [b for _, b in pts]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    den = sum((x - mx) ** 2 for x in xs)
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True))
    return cov / den if den else 0.0
