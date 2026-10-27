"""Time sessions sit blocked in a test run, from the Claude Code session transcripts.
Counting rules: #2812 (the baseline)'s, unchanged.
Usage: python3 -I blocked.py <out.jsonl> [<projects-dir>...] [--start ISO] [--end ISO]
(corpus.py: which transcripts are read; default window #2812's, 10-24 Oct)
A row is written for each test call found:
  fg      a Bash call, not run_in_background, whose command runs a test suite: blocked time is
          the tool_result timestamp minus the tool_use timestamp (if the harness moved it to the
          background, the row is marked autobg and the time is up to that point)
  bg      a Bash call with run_in_background true that runs a suite, launched in the window
          (no blocked time here)
  wait    a Monitor call, or a TaskOutput/BashOutput call with block true, whose target is a
          background test call in the same transcript (Monitor: when its command names a test log
          or suite): blocked time as for fg
Test command: a shell segment (split on && ; || |) whose head, after env, timeout, nice, cd and
bg-run.sh prefixes, is npm test, npm run test*, run-vitest.js, vitest, pytest, run-pytest.js or
queue-run.js."""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import corpus
from corpus import epoch

# #2812's: how much of a command a row keeps. Untraced.
CMD_CHARS = 160

PREFIX = re.compile(
    r"^(?:\s*(?:[A-Z_][A-Z0-9_]*=\S*|env|timeout\s+(?:-\S+\s+)*\d+[smh]?|nice(?:\s+-n\s*-?\d+)?|ionice\s+-c\s*\d+|time|exec|(?:bash\s+)?(?:\S*/)?bg-run\.sh\s+run\s+\S+|cd\s+\S+\s*)\s+)*"
)
HEAD = re.compile(
    r"^(?:npm\s+(?:run\s+)?test(?::[\w-]+)?\b|npm\s+t\b|(?:node\s+)?\S*run-vitest\.js|(?:npx\s+)?(?:\S*/)?vitest\b|(?:python3?\s+(?:-\S+\s+)*-m\s+)?pytest\b|(?:node\s+)?\S*run-pytest\.js|(?:node\s+)?\S*queue-run\.js)"
)


def test_segment(cmd):
    """The first shell segment of `cmd` that runs a test suite, prefixes stripped, or None."""
    for seg in re.split(r"&&|\|\||;|\||\n", cmd):
        s = PREFIX.sub("", seg.strip())
        if HEAD.match(s):
            return s
    return None


def kind_of(s):
    if re.search(r"test:py|pytest", s):
        return "pytest"
    if "--full" in s:
        return "full"
    if "--changed" in s or "test:changed" in s:
        return "changed"
    if "--adopt" in s:
        return "adopt"
    if "--retest" in s or re.search(r"\.test\.[jt]s|\s-t\s", s):
        return "named"
    return "bare"


def scan_file(path, repo, start, end, *, tally):
    """blocked.py's rows for one transcript, for test calls launched in [start, end]."""
    sub = corpus.is_subagent(path)
    pend = {}
    rows = []
    for _line, r in corpus.records_with_lines(
        path, tally, ('"tool_use"', '"tool_result"')
    ):
        t = r.get("timestamp")
        msg = r.get("message")
        if (
            not t
            or not isinstance(msg, dict)
            or not isinstance(msg.get("content"), list)
        ):
            continue
        for c in msg["content"]:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "tool_use":
                name = c.get("name")
                inp = c.get("input") or {}
                if name == "Bash":
                    cmd = str(inp.get("command", ""))
                    s = test_segment(cmd)
                    if not s:
                        continue
                    if inp.get("run_in_background"):
                        if start <= t <= end:
                            rows.append(
                                {
                                    "repo": repo,
                                    "sub": sub,
                                    "at": t,
                                    "cls": "bg",
                                    "kind": kind_of(s),
                                    "s": 0,
                                    "file": corpus.row_file(path),
                                    "cmd": cmd[:CMD_CHARS],
                                }
                            )
                    else:
                        pend[c["id"]] = (t, "fg", kind_of(s), cmd[:CMD_CHARS])
                elif name == "Monitor":
                    cmd = (
                        str(inp.get("command", ""))
                        + " "
                        + str(inp.get("description", ""))
                    )
                    if re.search(r"test|suite|vitest|pytest", cmd, re.I):
                        pend[c["id"]] = (t, "wait", "monitor", cmd[:CMD_CHARS])
                elif name in ("TaskOutput", "BashOutput") and inp.get("block", True):
                    pend[c["id"]] = (t, "wait", name, str(inp)[:CMD_CHARS])
            elif c.get("type") == "tool_result":
                i = c.get("tool_use_id")
                if i not in pend:
                    continue
                t0, cls, k, cmd = pend.pop(i)
                if not (start <= t0 <= end):
                    continue
                tur = r.get("toolUseResult")
                autobg = isinstance(tur, dict) and bool(tur.get("backgroundTaskId"))
                if cls == "wait" and k in ("TaskOutput", "BashOutput"):
                    # keep only waits that read a test's output, judged on its first 4,000 characters (#2812, untraced)
                    txt = json.dumps(c.get("content"))[:4000]
                    if not re.search(
                        r"vitest|Test Files|pytest|run-vitest|TEST LOG|passed|failed",
                        txt,
                    ):
                        continue
                rows.append(
                    {
                        "repo": repo,
                        "sub": sub,
                        "at": t0,
                        "cls": cls,
                        "kind": k,
                        "autobg": autobg,
                        "s": max(0.0, epoch(t) - epoch(t0)),
                        "file": corpus.row_file(path),
                        "cmd": cmd,
                    }
                )
    return rows


def foreground(rows):
    """The fg rows that count as blocked: one per (file, at, cls, command head), since a resume
    repeats a line, and none over the cap (blocked_sum.py's rules)."""
    seen = {}
    for r in rows:
        if r["cls"] == "fg":
            seen[(r["file"], r["at"], r["cls"], r["cmd"][: corpus.CMD_KEY_CHARS])] = r
    return [r for r in seen.values() if r["s"] <= corpus.CAP_S]


if __name__ == "__main__":
    corpus.run_scanner(__doc__, scan_file)
