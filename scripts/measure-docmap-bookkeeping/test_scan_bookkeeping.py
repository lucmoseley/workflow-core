"""Pins the two classifier defects mantahostels#1139 found in scan_docmap2.py (mantahostels#1082).

Both mis-sorted genuine targeted reads of docs/doc-map.md into the
"no content read" residue, which is what made mantahostels#1139's premise — 8 MB of
bookkeeping — wrong by roughly half.

The classifier is called directly on literal command strings taken from real
sessions, since the defects live in how one command line is split and no
transcript is needed to reach them.

CI's pytest step runs this file; the scanner
gates nothing and is run by hand. Loosen a case and the doc-map bookkeeping
figure can drift back to the inflated one mantahostels#1139's premise rested
on.
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from scan_bookkeeping import classify, strip_heredocs, split_unquoted

DOCMAP = re.compile(r"doc-map\.md(?!\.\w)")


def route(cmd):
    return classify(cmd, DOCMAP)[0]


# Defect 1: splitting a pipeline on a bare '|' also splits inside a quoted
# grep alternation, stranding the path in a fragment that leads with no verb.
def test_quoted_grep_alternation_is_a_read():
    assert (
        route(
            r"""grep -n -i "redemption\|node-unit\|reviewer-id-join" docs/doc-map.md | head -40"""
        )
        == "read"
    )
    assert (
        route(
            r"""cd /home/lucmo/mantahostels; grep -n 'shed\|always-loaded' docs/doc-map.md | head -20"""
        )
        == "read"
    )


# Defect 2: requiring the read verb to lead its segment drops any stage sitting
# behind a shell keyword.
def test_read_verb_behind_a_shell_keyword_is_a_read():
    assert (
        route(
            """for id in B95 B101; do awk -v s="^### $id" 'p' docs/doc-map.md; echo; done"""
        )
        == "read"
    )
    assert route("""if true; then sed -n '10,20p' docs/doc-map.md; fi""") == "read"


def test_pipeline_stage_reading_a_script_is_not_a_file_read():
    # `tail` here reads the script's stdout, not the file.
    assert (
        route("node scripts/check-doc-map.js docs/doc-map.md | tail -10")
        == "script_read"
    )


def test_bookkeeping_routes_stay_separated():
    assert route("git commit -m 'x' -- docs/doc-map.md") == "git_plumbing"
    assert route("git diff -- docs/doc-map.md") == "git_history"
    assert route("node scripts/session-arbiter.js claim docs/doc-map.md") == "arbiter"
    assert route("wc -l docs/doc-map.md") == "size"


def test_path_only_inside_a_heredoc_body_is_not_a_read():
    cmd = (
        "gh issue comment 5 --body \"$(cat <<'EOF'\nSee docs/doc-map.md §B7.\nEOF\n)\""
    )
    assert route(cmd) == "other"
    assert classify(cmd, DOCMAP)[1] == "heredoc"


def test_split_unquoted_ignores_separators_inside_quotes():
    assert split_unquoted("a; b", [";"]) == ["a", " b"]
    assert split_unquoted("echo 'a; b'; c", [";"]) == ["echo 'a; b'", " c"]


def test_strip_heredocs_removes_the_body_only():
    cmd = "cat <<'EOF' > f\nbody line\nEOF\necho done"
    stripped, body = strip_heredocs(cmd)
    assert "body line" not in stripped
    assert "body line" in body
    assert "echo done" in stripped


def test_main_transcripts_span_both_seat_roots(seat_roots):
    import scan_bookkeeping as sbk

    roots = seat_roots(2)
    (roots[0] / "a.jsonl").write_text("")
    (roots[1] / "b.jsonl").write_text("")
    (roots[1] / "b" / "subagents").mkdir(parents=True)
    (roots[1] / "b" / "subagents" / "agent-x.jsonl").write_text("")
    assert sbk.tc.main_transcripts() == [
        str(roots[0] / "a.jsonl"),
        str(roots[1] / "b.jsonl"),
    ]
