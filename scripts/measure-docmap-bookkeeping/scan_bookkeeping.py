#!/usr/bin/env python3
r"""
scan_bookkeeping.py — mantahostels#1139's measurement: what the ~8 MB of doc-map "bookkeeping" tool output
actually is, and whether other contended paths carry the same shape.

Supersedes the v2 doc-map read scanner (mantahostels#1082), whose two
classifier defects are pinned by name in test_scan_bookkeeping.py. v3
sub-classifies the non-read residue so "bookkeeping" can be separated into
removable and inherent.
"""

import os
import json
import re
import pickle
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import transcript_corpus as tc

OUTDIR = os.environ.get("CLAUDE_JOB_DIR", "/tmp") + "/tmp"

TARGETS = {
    "doc-map": re.compile(r"doc-map\.md(?!\.\w)"),
    "roadmap-html": re.compile(r"reference-roadmap\.html"),
    "digest": re.compile(r"roadmap-digest\.md"),
    "manual": re.compile(r"operating-manual\.md"),
    "CLAUDE.md": re.compile(r"\bCLAUDE\.md\b"),
    "AGENTS.md": re.compile(r"\bAGENTS\.md\b"),
    "issue-tracker": re.compile(r"issue-tracker\.md"),
}

READ_VERBS = {
    "cat",
    "head",
    "tail",
    "less",
    "bat",
    "sed",
    "awk",
    "grep",
    "rg",
    "ag",
    "nl",
    "cut",
    "diff",
    "comm",
    "sort",
    "uniq",
    "tr",
    "python3",
    "python",
    "perl",
    "jq",
}
SIZE_VERBS = {"wc", "ls", "stat", "du", "file", "find"}


def strip_heredocs(cmd):
    """Return (command_without_heredoc_bodies, heredoc_body_text)."""
    bodies = []
    out = cmd
    for m in re.finditer(r"<<-?\s*'?\"?([A-Za-z_][A-Za-z0-9_]*)'?\"?", cmd):
        tag = m.group(1)
        end = re.search(r"\n\s*" + re.escape(tag) + r"\s*(\n|$)", cmd[m.end() :])
        if end:
            body = cmd[m.end() : m.end() + end.start()]
            bodies.append(body)
            out = out.replace(body, "\n")
    return out, "\n".join(bodies)


def split_unquoted(s, seps):
    """Split s on any separator in `seps` (list of literal strings) that lies
    outside single/double quotes."""
    parts, buf = [], []
    i, n = 0, len(s)
    q = None
    while i < n:
        c = s[i]
        if q:
            buf.append(c)
            if c == q and (i == 0 or s[i - 1] != "\\"):
                q = None
            i += 1
            continue
        if c in "'\"":
            q = c
            buf.append(c)
            i += 1
            continue
        hit = None
        for sep in seps:
            if s.startswith(sep, i):
                hit = sep
                break
        if hit:
            parts.append("".join(buf))
            buf = []
            i += len(hit)
            continue
        buf.append(c)
        i += 1
    parts.append("".join(buf))
    return parts


LEADING_KEYWORDS = {
    "do",
    "then",
    "else",
    "elif",
    "if",
    "while",
    "for",
    "time",
    "!",
    "{",
    "(",
    "sudo",
    "command",
    "exec",
}
ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=\S*$")


def head_verb(stage):
    toks = stage.strip().split()
    for t in toks:
        t = t.strip("()${}")
        if not t:
            continue
        if t in LEADING_KEYWORDS or ASSIGN_RE.match(t):
            continue
        return os.path.basename(t)
    return ""


ARBITER_RE = re.compile(r"session-arbiter\.js\s+(\S+)")
GIT_SUB_RE = re.compile(r"\bgit\s+(?:-\S+\s+)*([a-z-]+)")


def classify(cmd, target_re):
    """Return (route, detail). Highest-priority route across all stages."""
    body_stripped, heredoc = strip_heredocs(cmd)
    in_heredoc_only = bool(
        heredoc and target_re.search(heredoc) and not target_re.search(body_stripped)
    )

    best = ("other", "")
    priority = {
        "read": 0,
        "git_history": 1,
        "script_read": 2,
        "arbiter": 3,
        "gh": 4,
        "git_plumbing": 5,
        "size": 6,
        "write": 7,
        "other": 8,
    }

    for seg in split_unquoted(body_stripped, [";", "\n", "&&", "||"]):
        if not target_re.search(seg):
            continue
        stages = split_unquoted(seg, ["|"])
        for st in stages:
            if not target_re.search(st):
                continue
            v = head_verb(st)
            cand = None
            if v in READ_VERBS:
                cand = ("read", v)
            elif v in SIZE_VERBS:
                cand = ("size", v)
            elif v == "git":
                m = GIT_SUB_RE.search(st)
                sub = m.group(1) if m else "?"
                if sub in ("log", "show", "diff", "blame"):
                    cand = ("git_history", sub)
                else:
                    cand = ("git_plumbing", sub)
            elif v in ("node", "npm", "npx", "bash", "sh"):
                am = ARBITER_RE.search(st)
                if am:
                    cand = ("arbiter", am.group(1))
                else:
                    sm = re.search(r"(scripts/[\w.-]+|run\s+[\w:-]+)", st)
                    cand = ("script_read", sm.group(1) if sm else v)
            elif v == "gh":
                cand = ("gh", (st.strip().split() + ["?", "?"])[1])
            elif v in ("tee", "cp", "mv", "rm", "touch", "mkdir", "echo", "printf"):
                cand = ("write", v)
            else:
                cand = ("other", v or "?")
            if priority[cand[0]] < priority[best[0]]:
                best = cand
    if best[0] == "other" and in_heredoc_only:
        best = ("other", "heredoc")
    return best


def get_result_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, str):
                parts.append(b)
            elif isinstance(b, dict):
                t = b.get("text")
                parts.append(
                    t if isinstance(t, str) else json.dumps(b, ensure_ascii=False)
                )
        return "".join(parts)
    if isinstance(content, dict):
        return json.dumps(content, ensure_ascii=False)
    return ""


def scan_file(path, tally):
    pending = {}
    out = []
    for d in tc.records(path, tally):
        t = d.get("type")
        if t == "assistant":
            msg = d.get("message", {})
            content = msg.get("content")
            if not isinstance(content, list):
                continue
            for b in content:
                if not isinstance(b, dict) or b.get("type") != "tool_use":
                    continue
                name = b.get("name")
                inp = b.get("input", {}) or {}
                if name == "Bash":
                    cmd = inp.get("command", "") or ""
                    hits = {}
                    for tname, tre in TARGETS.items():
                        if tre.search(cmd):
                            hits[tname] = classify(cmd, tre)
                    if hits:
                        pending[b.get("id")] = ("Bash", cmd, hits)
                elif name in ("Read", "Edit", "Write", "MultiEdit", "NotebookEdit"):
                    fp = inp.get("file_path", "") or ""
                    hits = {}
                    for tname, tre in TARGETS.items():
                        if tre.search(fp):
                            r = (
                                "Read-partial"
                                if (
                                    name == "Read"
                                    and (inp.get("offset") or inp.get("limit"))
                                )
                                else ("Read-whole" if name == "Read" else name)
                            )
                            hits[tname] = (r, "")
                    if hits:
                        pending[b.get("id")] = (name, fp, hits)
        elif t == "user":
            msg = d.get("message", {})
            content = msg.get("content")
            if not isinstance(content, list):
                continue
            for b in content:
                if not isinstance(b, dict) or b.get("type") != "tool_result":
                    continue
                info = pending.pop(b.get("tool_use_id"), None)
                if info is None:
                    continue
                tool, cmd, hits = info
                rc = b.get("content")
                sz = tc.jlen(rc)
                out.append(
                    {
                        "tool": tool,
                        "cmd": cmd[:4000],
                        "bytes": sz,
                        "hits": hits,
                        "n_targets": len(hits),
                        "head": get_result_text(rc)[:600],
                        "session": os.path.basename(path)[:-6],
                    }
                )
    return out


def main():
    files = tc.main_transcripts()
    print(f"transcripts: {len(files)}")
    rows = []
    tally = Counter()
    for i, p in enumerate(files):
        rows.extend(scan_file(p, tally))
        if (i + 1) % 400 == 0:
            print(f"...{i + 1}/{len(files)}", flush=True)
    os.makedirs(OUTDIR, exist_ok=True)
    with open(os.path.join(OUTDIR, "bookkeeping_rows.pkl"), "wb") as f:
        pickle.dump(rows, f)
    print(f"rows: {len(rows)} -> {OUTDIR}/bookkeeping_rows.pkl")
    print(tc.counts_line(tally))


if __name__ == "__main__":
    main()
