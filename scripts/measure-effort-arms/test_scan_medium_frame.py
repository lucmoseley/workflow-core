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
    (seat_roots(1)[0] / "s1.jsonl").write_text('{"type": "assistant", broken\n')
    path, _ = stub_bin("gh", "")
    monkeypatch.setenv("WFC_GH", path)
    assert smf.main(["--seed", "1", "--n", "0"]) == 0
    assert "(unreadable files: 0, unparsed lines: 1)" in capsys.readouterr().out
