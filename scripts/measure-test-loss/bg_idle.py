import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import corpus
from blocked import kind_of, test_segment
from corpus import epoch

ASSISTANT = '"role":"assistant"'
ROLE_WITHIN = 600
NOTICE = "<task-notification>"


def scan_file(path, repo, start, end, *, tally):
    launches = {}
    fgtests = {}
    last_asst = None
    rows = []
    for line, r in corpus.records_with_lines(
        path, tally, (ASSISTANT, '"backgroundTaskId"', NOTICE)
    ):
        if ASSISTANT in line[:ROLE_WITHIN]:
            if not r.get("timestamp"):
                continue
            last_asst = r["timestamp"]
            content = (r.get("message") or {}).get("content")
            if '"tool_use"' in line and isinstance(content, list):
                for c in content:
                    if (
                        isinstance(c, dict)
                        and c.get("type") == "tool_use"
                        and c.get("name") == "Bash"
                    ):
                        inp = c.get("input") or {}
                        s = test_segment(str(inp.get("command", "")))
                        if s and inp.get("run_in_background"):
                            launches[c["id"]] = (r["timestamp"], kind_of(s), "bg")
                        elif s:
                            fgtests[c["id"]] = kind_of(s)
        elif '"backgroundTaskId"' in line and fgtests and '"tool_result"' in line:
            tur = r.get("toolUseResult")
            if not (isinstance(tur, dict) and tur.get("backgroundTaskId")):
                continue
            for c in (r.get("message") or {}).get("content") or []:
                if (
                    isinstance(c, dict)
                    and c.get("type") == "tool_result"
                    and c.get("tool_use_id") in fgtests
                ):
                    launches[c["tool_use_id"]] = (
                        r["timestamp"],
                        fgtests.pop(c["tool_use_id"]),
                        "autobg",
                    )
        elif NOTICE in line and launches:
            mt = re.search(r'"timestamp":"([^"]+)"', line)
            for i in re.findall(r"<tool-use-id>([^<]+)</tool-use-id>", line):
                if i in launches and mt:
                    t0, k, how = launches.pop(i)
                    if not (start <= t0 <= end):
                        continue
                    tn = mt.group(1)
                    idle = (
                        epoch(tn) - epoch(last_asst)
                        if last_asst and last_asst >= t0
                        else 0.0
                    )
                    rows.append(
                        {
                            "repo": repo,
                            "sub": corpus.is_subagent(path),
                            "at": t0,
                            "file": corpus.row_file(path),
                            "kind": k,
                            "how": how,
                            "run_s": epoch(tn) - epoch(t0),
                            "idle_s": max(0.0, idle),
                        }
                    )
    return rows


if __name__ == "__main__":
    corpus.run_scanner(
        "Idle wait for a background test run, from the transcripts.", scan_file
    )
