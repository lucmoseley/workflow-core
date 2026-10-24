"""Pins the `medium` frame's session-to-issue lookup across every seat root
(#375), its issue list taken from the `gh` that `WFC_GH` names (#1278), and the
skip counts its report prints (#947 review).

The `seat_roots` fixture points `transcript_corpus`'s seats at temp config
dirs, and `stub_bin` writes a `gh` that logs its argv, so each test proves the
stub ran without patching `subprocess` or reaching the network.

CI's pytest step runs this file; the scanner
gates nothing and is run by hand. Breaking it lets the mantahostels#1214
control draw from a frame that has silently shrunk or missed a seat, so the
`medium` arm's defect rate is compared on sessions nobody can re-derive.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import scan_medium_frame as smf  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)


def command_line(name, args):
    text = f"<command-name>/{name}</command-name><command-args>{args}</command-args>"
    return json.dumps({"type": "user", "message": {"content": text}}) + "\n"


def test_a_session_on_the_second_seat_root_is_found(seat_roots):
    roots = seat_roots(2)
    (roots[1] / "s1.jsonl").write_text(command_line("implement", 42))
    assert smf.session_issue("s1") == "42"
    assert smf.session_issue("absent") is None


def test_issue_numbers_come_from_the_binary_wfc_gh_names(stub_bin, monkeypatch):
    path, calls = stub_bin("gh", "12\n34\n")
    monkeypatch.setenv("WFC_GH", path)
    assert smf.gh_issue_numbers("kind:ticket") == {"12", "34"}
    assert calls()[0].startswith("issue list --state closed --label kind:ticket")


def test_the_frame_report_prints_what_the_corpus_skipped(
    seat_roots, stub_bin, monkeypatch, capsys
):
    # #947 review: the frame dropped its skip counts unseen.
    (seat_roots(1)[0] / "s1.jsonl").write_text('{"type": "assistant", broken\n')
    path, _ = stub_bin("gh", "")
    monkeypatch.setenv("WFC_GH", path)
    assert smf.main(["--seed", "1", "--n", "0"]) == 0
    assert "(unreadable files: 0, unparsed lines: 1)" in capsys.readouterr().out
