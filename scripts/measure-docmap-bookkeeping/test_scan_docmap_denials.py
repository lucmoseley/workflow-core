import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from scan_docmap_denials import held_subjects, scan

MAP = "docs/doc-map.md"
HOLDER = "735db33b (pid 762805) since 2026-08-30T11:12:13.456Z"


def subjects(blob):
    return list(held_subjects(blob))


def test_a_denial_delivered_as_a_tool_result_is_counted():
    assert subjects(f"{MAP} is held by session {HOLDER}, which is still running.") == [
        MAP
    ]


def test_the_arbiter_cli_refusal_is_counted_wherever_it_sits_on_the_line():
    assert subjects(
        f"A:docs/x.md — session-arbiter: {MAP} is held by session {HOLDER}."
    ) == [MAP]


def test_the_held_subject_is_counted_not_the_asked_one():
    assert subjects(
        f"{MAP}#B7 cannot be claimed while it is covered: {MAP} is held by session {HOLDER}."
    ) == [MAP]


def test_this_repos_own_test_fixture_is_not_a_denial():
    assert (
        subjects(
            'guard-fires.test.ts:212:\t"session-arbiter: docs/doc-map.md is held by'
            ' session 735db33b, which `claude agents --json` still lists as live.",'
        )
        == []
    )


def test_an_earlier_measurements_truncated_quote_is_not_a_denial():
    assert subjects(f"  81 | session-arbiter: {MAP} is held by session <uuid> (") == []


def test_a_denial_delivered_as_permission_decision_reason_is_counted():
    payload = (
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":'
        f'"deny","permissionDecisionReason":"{MAP} is held by session {HOLDER},'
        ' which is still running.\\n\\nA claim is taken by writing the file."}}'
    )
    assert subjects(payload) == [MAP]


def test_a_hook_payload_the_transcript_truncated_is_still_counted():
    assert subjects(
        f'"permissionDecision":"deny","permissionDecisionReason":"{MAP}#A:docs/x.md'
        f" cannot be claimed while it is covered: {MAP} is held by session 3b05684e (pid"
    ) == [MAP]


def test_a_quote_prefixed_source_echo_is_still_refused():
    assert (
        subjects(f'\t\t"{MAP} is held by session {HOLDER}, which is still running.",')
        == []
    )


def test_a_hook_payload_matching_on_both_routes_yields_its_subject_once():
    payload = (
        '{"permissionDecisionReason":"docs/doc-map.md#B7 cannot be claimed while'
        f" it is covered: {MAP} is held by session {HOLDER}, which is still"
        ' running."}'
    )
    assert subjects(payload) == [MAP]


def test_a_denial_naming_no_claim_time_is_dropped():
    assert subjects(f"{MAP} is held by session 735db33b, which is still running.") == []


def test_a_truncated_hook_payload_is_unescaped_by_hand_silently(capsys):
    subjects(f'"permissionDecisionReason":"{MAP} is held by session {HOLDER}\\')
    assert capsys.readouterr().err == ""


def test_an_undated_record_is_counted_silently(corpus, capsys):
    corpus(
        "s1",
        [{"type": "user", "timestamp": "not-a-date", "text": "is held by session"}],
    )
    tally = Counter()
    start = datetime(2000, 1, 1, tzinfo=timezone.utc)
    events, _ = scan(start, datetime.now(timezone.utc), tally)
    assert (events, tally["undated records"]) == (set(), 1)
    assert capsys.readouterr().err == ""
