"""The whole-corpus scripts here read every seat root (#379).

Each script is spawned as a subprocess with `CLAUDE_CONFIG_DIR` pointed at a
temp dir and one transcript under each of two further seats, so the test
exercises the same seat discovery a real run does and never reads the real
corpus.

CI's pytest step runs this file; these scripts
gate nothing and are run by hand. Breaking it lets the arbiter's `list` cost
and the doc-map denial counts be taken from one seat's sessions and read as the
whole machine's.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _call(i):
    """One `session-arbiter.js list` call and its result, as two records."""
    ts = f"2026-09-0{i + 1}T10:00:00Z"
    use = {
        "type": "assistant",
        "timestamp": ts,
        "message": {
            "content": [
                {
                    "type": "tool_use",
                    "id": f"t{i}",
                    "name": "Bash",
                    "input": {"command": "node scripts/session-arbiter.js list"},
                }
            ]
        },
    }
    res = {
        "type": "user",
        "timestamp": ts,
        "toolUseResult": "x",
        "message": {
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": f"t{i}",
                    "content": "docs/doc-map.md#B1",
                }
            ]
        },
    }
    return json.dumps(use) + "\n" + json.dumps(res) + "\n"


def run(tmp_path, script, *args):
    env = {
        k: v for k, v in os.environ.items() if not k.startswith("WFC_CLAUDE_CONFIG_")
    }
    env.update(CLAUDE_CONFIG_DIR=str(tmp_path / ".claude"), CLAUDE_PROJECT_DIR="/p")
    for i, seat in enumerate((".claude2", ".claude3")):
        root = tmp_path / seat / "projects" / "-p"
        root.mkdir(parents=True, exist_ok=True)
        (root / f"s{i}.jsonl").write_text(_call(i))
    out = subprocess.run(
        [sys.executable, str(HERE / script), *args],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    return out.stdout


def test_list_shape_reads_both_seats(tmp_path):
    assert "post: 2 list calls" in run(tmp_path, "list_shape.py")


def test_scan_arbiter_reads_both_seats(tmp_path):
    line = next(
        ln
        for ln in run(tmp_path, "scan_arbiter.py").splitlines()
        if ln.startswith("list")
    )
    assert line.split()[1] == "2"


def test_scan_docmap_denials_reads_both_seats(tmp_path):
    out = run(
        tmp_path,
        "scan_docmap_denials.py",
        "--from",
        "2026-09-01T00:00:00Z",
        "--to",
        "2026-09-03T00:00:00Z",
    )
    assert "corpus  2 transcripts" in out
