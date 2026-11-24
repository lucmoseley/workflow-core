import datetime
import json
import os
import re
import subprocess
from typing import NamedTuple

import transcript_corpus as tc
from fail_open import tallied
from wfc_bin import bin_path

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))


def git(*args):
    return subprocess.run(
        [bin_path("git"), "-C", REPO, *args], capture_output=True, text=True, check=True
    ).stdout


def window_days(start, end):
    d0 = datetime.date.fromisoformat(start)
    d1 = datetime.date.fromisoformat(end)
    return [
        (d0 + datetime.timedelta(days=n)).isoformat() for n in range((d1 - d0).days + 1)
    ]


def revision_on(day, path):
    return git("rev-list", "-1", f"--before={day}T23:59:59", "HEAD", "--", path).strip()


def parent_transcripts(tally, find):
    for fp in tc.main_transcripts():
        try:
            with open(fp, encoding="utf-8", errors="replace") as fh:
                raw = fh.read()
        except OSError as error:
            tallied(error, tally, tc.UNREADABLE)
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
    out = {}
    for r in recs:
        c = (r.get("message") or {}).get("content")
        if isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    out[b.get("id")] = (b.get("name"), b.get("input") or {})
    return out


def tool_route(name, inp):
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
    if re.search(r"\bgit (diff|show|log|blame)\b", cmd):
        return "git diff/show"
    if re.search(r"\bgrep\b", cmd):
        return "Bash grep"
    if re.search(r"\b(sed|awk|head|tail|cat)\b", cmd):
        return "Bash range/cat"
    return "Bash other"


def intent_text(res):
    return (res.command + json.dumps(res.input, ensure_ascii=False)).lower()


def landed_bytes(text, keep):
    return sum(len(s.encode("utf-8", "replace")) for s in text.split("\n") if keep(s))


def result_text(block):
    rc = block.get("content")
    if isinstance(rc, str):
        return rc
    if isinstance(rc, list):
        return "\n".join(x.get("text", "") for x in rc if isinstance(x, dict))
    return ""


def suffix_distinct_turns(recs):
    out = [0] * (len(recs) + 1)
    seen = set()
    for i in range(len(recs) - 1, -1, -1):
        r = recs[i]
        if r.get("type") == "assistant":
            seen.add((r.get("message") or {}).get("id") or f"_anon{i}")
        out[i] = len(seen)
    return out


def growth_per_day(sizes):
    pts = sorted(sizes.items())
    if len(pts) < 2:
        return 0.0
    xs = list(range(len(pts)))
    ys = [b for _, b in pts]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    den = sum((x - mx) ** 2 for x in xs)
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True))
    return cov / den if den else 0.0
