"""Pins how the rule-fetch scanner tells a `rule-text.sh` call from a mention,
and a resolved id from a refused one, and what it counts as a guard's emission
of a rule (mantahostels#2501).

Each test writes a synthetic transcript; nothing here reads the real corpus.

CI's pytest step runs this file; the scanner
gates nothing and is run by hand. Loosen a case and the per-command rule index
`scripts/inject-tracker-docs.sh` injects is scored as delivering rules that
sessions never fetched, or fetched and were refused.
"""

import json
import os
import sys
from collections import Counter

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import scan_rule_fetches as srf  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)

FETCH = "scripts/lib/rule-text.sh"

GUARD_TEXT = (
    "Every close says what is still outstanding, on an Outstanding line, and "
    "anything left is an OPEN issue before you close this one."
)


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    """A three-rule store, so `resolved` means the fetcher would have answered,
    and a guard routing one rule. guard_ids walks up two levels from the
    store's parent, so the store is nested to put the guard where that walk
    lands."""
    d = tmp_path / "docs" / "agents" / "rules"
    d.mkdir(parents=True)
    for rule in ("gh-cli-limits", "roadmap-gating", "card-close-route"):
        (d / f"{rule}.txt").write_text("text\n")
    (d / "close-outstanding-line.txt").write_text(GUARD_TEXT + "\n")
    guard = tmp_path / srf.GUARD
    guard.parent.mkdir(parents=True)
    guard.write_text("gp_rule close-outstanding-line\n")
    monkeypatch.setenv("WFC_RULES_DIR", str(d))


def injection(cmd="wayfinder"):
    """The attachment shape a hook injection takes in a transcript."""
    text = (
        f"You invoked /{cmd}, which reads or writes the issue tracker. "
        f"fetch the id below with `{FETCH} <id>`"
    )
    return {
        "type": "attachment",
        "timestamp": "2026-09-02T10:00:00.000Z",
        "attachment": {"type": "hook_additional_context", "content": text},
    }


def bash(command):
    return {
        "type": "assistant",
        "timestamp": "2026-09-02T10:01:00.000Z",
        "message": {
            "content": [
                {"type": "tool_use", "name": "Bash", "input": {"command": command}}
            ]
        },
    }


@pytest.fixture
def transcript(tmp_path):
    def write(name, records):
        p = tmp_path / f"{name}.jsonl"
        p.write_text(
            "".join(json.dumps(r, separators=(",", ":")) + "\n" for r in records)
        )
        return str(p)

    return write


def test_a_bare_id_resolves(transcript):
    p = transcript("s", [injection(), bash(f"{FETCH} gh-cli-limits")])
    row = srf.scan_file(p, Counter())
    assert row["called"] is True
    assert row["resolved"] == ["gh-cli-limits"]
    assert row["refused"] == []


def test_the_prefixed_spelling_the_index_shows_resolves(transcript):
    # Since 670224070 the fetcher strips one leading `rule:`, so a session
    # copying the index's own spelling GETS the rule (mantahostels#2718).
    p = transcript("s", [injection(), bash(f"{FETCH} rule:gh-cli-limits")])
    row = srf.scan_file(p, Counter())
    assert row["called"] is True
    assert row["resolved"] == ["gh-cli-limits"]
    assert row["refused"] == []


def test_a_doubly_prefixed_id_does_not_resolve(transcript):
    # One prefix comes off, so `rule:rule:x` bares to `rule:x` and fails the
    # fetcher's own id grammar. It names no id, so it refuses the call without
    # putting anything in the `refused` column.
    p = transcript("s", [injection(), bash(f"{FETCH} rule:rule:gh-cli-limits")])
    row = srf.scan_file(p, Counter())
    assert row["called"] is True
    assert row["resolved"] == []
    assert row["refused"] == []


def test_a_prefixed_id_naming_no_fragment_is_refused_under_its_bare_id(transcript):
    p = transcript("s", [injection(), bash(f"{FETCH} rule:no-such-rule")])
    row = srf.scan_file(p, Counter())
    assert row["resolved"] == []
    assert row["refused"] == ["no-such-rule"]


def test_a_session_that_retries_is_not_counted_as_lost(transcript):
    # The first call carries a bad id, so it delivers neither; the second
    # asks for the good one alone and gets it. `refused` nets the retry off.
    p = transcript(
        "s",
        [
            injection(),
            bash(f"{FETCH} gh-cli-limits no-such-rule"),
            bash(f"{FETCH} gh-cli-limits"),
        ],
    )
    row = srf.scan_file(p, Counter())
    assert row["resolved"] == ["gh-cli-limits"]
    assert row["refused"] == ["no-such-rule"]


def test_the_list_form_resolves_every_id_in_one_call(transcript):
    p = transcript(
        "s",
        [injection(), bash(f"{FETCH} gh-cli-limits roadmap-gating card-close-route")],
    )
    assert srf.scan_file(p, Counter())["resolved"] == [
        "card-close-route",
        "gh-cli-limits",
        "roadmap-gating",
    ]


def test_a_redirection_is_not_read_as_a_rule_id(transcript):
    # `2>&1` sits in the argument position and its leading token is a bare
    # word, so without the metacharacter stop it would score as the id "2".
    p = transcript("s", [injection(), bash(f"{FETCH} gh-cli-limits 2>&1 | head")])
    assert srf.scan_file(p, Counter())["resolved"] == ["gh-cli-limits"]


def test_a_pipeline_after_the_call_does_not_swallow_the_next_program(transcript):
    p = transcript("s", [injection(), bash(f"{FETCH} roadmap-gating | tee out")])
    assert srf.scan_file(p, Counter())["resolved"] == ["roadmap-gating"]


def test_quoted_ids_resolve(transcript):
    p = transcript(
        "s", [injection(), bash(f"{FETCH} \"gh-cli-limits\" 'roadmap-gating'")]
    )
    assert srf.scan_file(p, Counter())["resolved"] == [
        "gh-cli-limits",
        "roadmap-gating",
    ]


def test_a_flag_is_not_a_rule_id(transcript):
    # `called` stays True: whether the call was ANSWERED is this file's own
    # question (mantahostels#3279).
    p = transcript("s", [injection(), bash(f"{FETCH} --ids")])
    row = srf.scan_file(p, Counter())
    assert row["called"] is True
    assert row["resolved"] == []


def test_a_session_naming_no_tracker_command_is_not_a_session(transcript):
    p = transcript("s", [bash(f"{FETCH} gh-cli-limits")])
    assert srf.scan_file(p, Counter())["commands"] == []


def test_the_marker_is_taken_from_an_attachment_not_from_prose(transcript):
    # An assistant turn quoting the marker would otherwise invent a session.
    quoting = {
        "type": "assistant",
        "timestamp": "2026-09-02T10:00:00.000Z",
        "message": {
            "content": [{"type": "text", "text": "You invoked /wayfinder, it said"}]
        },
    }
    p = transcript("s", [quoting, bash(f"{FETCH} gh-cli-limits")])
    assert srf.scan_file(p, Counter())["commands"] == []


def test_a_tool_result_carrying_the_text_back_is_not_a_fetch(transcript):
    # The corpus false positive: a session that ran the fetcher gets the
    # command echoed back in the result, so a whole-record grep double-counts.
    result = {
        "type": "user",
        "timestamp": "2026-09-02T10:02:00.000Z",
        "message": {
            "content": [{"type": "tool_result", "content": f"$ {FETCH} gh-cli-limits"}]
        },
    }
    p = transcript("s", [injection(), result])
    assert srf.scan_file(p, Counter())["called"] is False


def test_an_unparsable_line_is_counted_not_skipped_silently(transcript, tmp_path):
    p = tmp_path / "s.jsonl"
    p.write_text(json.dumps(injection()) + "\n" + "{You invoked /wayfinder,\n")
    tally = Counter()
    srf.scan_file(str(p), tally)
    assert tally["unparsed lines"] == 1


def test_a_session_outside_the_window_is_dropped(transcript, tmp_path):
    transcript("s", [injection(), bash(f"{FETCH} gh-cli-limits")])
    sessions, _ = srf.scan_dir(str(tmp_path), after="2026-09-03T00:00:00Z")
    assert sessions == []


def test_a_session_counts_under_every_command_it_names(transcript, tmp_path):
    transcript(
        "s",
        [
            injection("wayfinder"),
            injection("implement"),
            bash(f"{FETCH} gh-cli-limits"),
        ],
    )
    sessions, _ = srf.scan_dir(str(tmp_path))
    per = srf.tally(sessions)
    assert per["wayfinder"]["resolved"] == 1
    assert per["implement"]["resolved"] == 1


def test_the_refused_tally_counts_sessions_not_ids(transcript, tmp_path):
    transcript("s", [injection(), bash(f"{FETCH} no-such-a no-such-b")])
    sessions, _ = srf.scan_dir(str(tmp_path))
    assert srf.tally(sessions)["wayfinder"]["refused"] == 1


def test_an_id_the_store_cannot_answer_is_not_resolved(transcript):
    p = transcript("s", [injection(), bash(f"{FETCH} no-such-rule")])
    row = srf.scan_file(p, Counter())
    assert row["called"] is True
    assert row["resolved"] == []


def test_one_bad_id_refuses_the_whole_list(transcript):
    p = transcript("s", [injection(), bash(f"{FETCH} gh-cli-limits no-such-rule")])
    row = srf.scan_file(p, Counter())
    assert row["resolved"] == []
    assert row["refused"] == ["gh-cli-limits", "no-such-rule"]


def test_a_command_that_only_names_the_fetcher_is_not_a_call(transcript):
    # `git log -- <path> <pathspec>` would otherwise score its trailing words
    # as rule ids, and `cat`/`wc`/`sed` would inflate the `called` column.
    for command in (
        f"git log --oneline -- {FETCH} docs agents",
        f"cat {FETCH}",
        f"wc -c {FETCH}",
        f"grep -n rule_text {FETCH}",
    ):
        p = transcript("s", [injection(), bash(command)])
        row = srf.scan_file(p, Counter())
        assert row["called"] is False, command
        assert row["resolved"] == [], command


def test_an_interpreter_in_front_of_the_fetcher_is_still_a_call(transcript):
    p = transcript("s", [injection(), bash(f"bash {FETCH} gh-cli-limits")])
    assert srf.scan_file(p, Counter())["resolved"] == ["gh-cli-limits"]


def test_a_sourced_or_sh_fetcher_call_is_not_a_call(transcript):
    """`source`/`.` stop at the fetcher's `BASH_SOURCE[0] == $0` CLI guard
    (`scripts/lib/rule-text.sh:115`) and `sh` — dash here — dies on the bashism
    first, so none of them deliver any rule text."""
    for lead in ("source", ".", "sh"):
        p = transcript("s", [injection(), bash(f"{lead} {FETCH} gh-cli-limits")])
        row = srf.scan_file(p, Counter())
        assert row["called"] is False, lead
        assert row["resolved"] == [], lead


def test_a_fetcher_line_inside_a_heredoc_is_not_a_call(transcript):
    """`SEGMENT` splits on newlines, so a heredoc body line beginning with the
    fetcher path lands in program position, and the repo writes issue bodies
    exactly this way."""
    cmd = f"gh issue create --body-file - <<'BODY'\n{FETCH} gh-cli-limits\nBODY"
    p = transcript("s", [injection(), bash(cmd)])
    row = srf.scan_file(p, Counter())
    assert row["called"] is False
    assert row["resolved"] == []


def test_a_real_call_after_a_heredoc_still_counts(transcript):
    """Stripping the body must not swallow the rest of the command."""
    cmd = (
        "gh issue comment 1 --body-file - <<'BODY'\n"
        f"see {FETCH}\n"
        "BODY\n"
        f"{FETCH} roadmap-gating"
    )
    p = transcript("s", [injection(), bash(cmd)])
    assert srf.scan_file(p, Counter())["resolved"] == ["roadmap-gating"]


def test_a_redirection_butted_against_the_id_does_not_truncate_it(transcript):
    p = transcript("s", [injection(), bash(f"{FETCH} gh-cli-limits>out.txt")])
    row = srf.scan_file(p, Counter())
    assert row["resolved"] == []
    assert row["refused"] == []


def test_a_trailing_comment_is_not_read_as_rule_ids(transcript):
    p = transcript(
        "s", [injection(), bash(f"{FETCH} gh-cli-limits # the rule the index named")]
    )
    assert srf.scan_file(p, Counter())["resolved"] == ["gh-cli-limits"]


def test_an_id_built_from_a_variable_ends_the_run_rather_than_scoring(transcript):
    p = transcript("s", [injection(), bash(f"{FETCH} $id")])
    row = srf.scan_file(p, Counter())
    assert row["called"] is True
    assert row["resolved"] == []
    assert row["refused"] == []


def test_a_call_later_in_a_pipeline_is_found(transcript):
    p = transcript("s", [injection(), bash(f"cd /tmp && {FETCH} roadmap-gating")])
    assert srf.scan_file(p, Counter())["resolved"] == ["roadmap-gating"]


def emission(text):
    """The attachment shape a `gp_rule` emission takes in a transcript."""
    return {
        "type": "attachment",
        "timestamp": "2026-09-02T10:01:30.000Z",
        "attachment": {"type": "hook_additional_context", "content": text},
    }


def test_a_guard_routed_rule_in_a_hook_attachment_is_an_emission(transcript):
    p = transcript("s", [injection(), emission(GUARD_TEXT)])
    assert srf.scan_file(p, Counter())["emitted"] == ["close-outstanding-line"]


def test_a_truncated_emission_still_counts(transcript):
    p = transcript("s", [injection(), emission(GUARD_TEXT[:70] + " …")])
    assert srf.scan_file(p, Counter())["emitted"] == ["close-outstanding-line"]


def test_a_session_quoting_the_rule_back_is_not_an_emission(transcript):
    # Only the hook's own attachment counts; an assistant turn restating a rule
    # would otherwise score as having been handed it.
    # The text carries `docs/agents/` so the record survives the prefilter and
    # the attachment test is what actually rejects it.
    quoting = {
        "type": "assistant",
        "timestamp": "2026-09-02T10:01:30.000Z",
        "message": {
            "content": [{"type": "text", "text": GUARD_TEXT + " (docs/agents/)"}]
        },
    }
    p = transcript("s", [injection(), quoting])
    assert srf.scan_file(p, Counter())["emitted"] == []


def test_a_rule_the_guard_does_not_route_is_not_counted(transcript):
    p = transcript("s", [injection(), emission("text")])
    assert srf.scan_file(p, Counter())["emitted"] == []


def test_the_emitted_tally_counts_sessions(transcript, tmp_path):
    transcript("s", [injection(), emission(GUARD_TEXT)])
    sessions, _ = srf.scan_dir(str(tmp_path))
    assert srf.tally(sessions)["wayfinder"]["emitted"] == 1


def test_the_guard_ids_read_bares_a_prefixed_call(tmp_path):
    # Without the prefix in the argument run the prefixed token would end the
    # run and `beta` would go uncounted (mantahostels#2719).
    (tmp_path / srf.GUARD).write_text("gp_rule rule:alpha beta\ngp_rule gamma\n")
    assert srf.guard_ids() == {"alpha", "beta", "gamma"}


def test_the_default_corpus_counts_sessions_on_both_seat_roots(seat_roots):
    roots = seat_roots(2)
    for r, name in zip(roots, ("a", "b"), strict=True):
        (r / f"{name}.jsonl").write_text(json.dumps(injection()) + "\n")
    sessions, _ = srf.scan_dir()
    assert len(sessions) == 2
