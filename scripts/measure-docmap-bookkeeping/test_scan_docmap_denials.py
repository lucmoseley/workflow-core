"""Pins the two counting edges mantahostels#2621 settled in scan_docmap_denials.py.

One over-counted the whole-file bucket and one under-counted it, so a test that
only asserted the total would pass with both still live. Each case feeds
`held_subjects` one literal refusal line, in-process, so the edge it pins is
the only thing that can move its answer.

CI's pytest step runs this file; the scanner
gates nothing and is run by hand. Breaking it misstates the doc-map family's
per-day denial rate, by bucket, against the baselines mantahostels#2409 and
mantahostels#2430 published.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from scan_docmap_denials import held_subjects

MAP = "docs/doc-map.md"
HOLDER = "735db33b (pid 762805) since 2026-08-30T11:12:13.456Z"


def subjects(blob):
    return list(held_subjects(blob))


def test_a_denial_delivered_as_a_tool_result_is_counted():
    assert subjects(f"{MAP} is held by session {HOLDER}, which is still running.") == [
        MAP
    ]


def test_the_arbiter_cli_refusal_is_counted_wherever_it_sits_on_the_line():
    # register-doc.js prefixes the arbiter's own line with the subject it asked
    # for, so the refusal is not always at the start of a line.
    assert subjects(
        f"A:docs/x.md — session-arbiter: {MAP} is held by session {HOLDER}."
    ) == [MAP]


def test_the_held_subject_is_counted_not_the_asked_one():
    assert subjects(
        f"{MAP}#B7 cannot be claimed while it is covered: {MAP} is held by session {HOLDER}."
    ) == [MAP]


# The over-count. This repo writes the deny string out in its own test files;
# a session grepping or reading them emits it in a tool result, which reaches
# the transcript by the same route a denial does.
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


# The under-count. A denial reaching a session as raw hook JSON sits behind a
# `"`, which the anchored regex drops.
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


# The two edges are settled independently: reading the hook route must not be
# spelled as admitting a leading quote.
def test_a_quote_prefixed_source_echo_is_still_refused():
    assert (
        subjects(f'\t\t"{MAP} is held by session {HOLDER}, which is still running.",')
        == []
    )


def test_a_hook_payload_matching_on_both_routes_yields_its_subject_once():
    # `it is covered: ` satisfies the anchor inside the raw JSON as well as in
    # the decoded reason, so an untruncated covered-by payload matches twice.
    payload = (
        '{"permissionDecisionReason":"docs/doc-map.md#B7 cannot be claimed while'
        f" it is covered: {MAP} is held by session {HOLDER}, which is still"
        ' running."}'
    )
    assert subjects(payload) == [MAP]


# The known cost of reading the trailer as proof: a denial that carries none is
# dropped.
def test_a_denial_naming_no_claim_time_is_dropped():
    assert subjects(f"{MAP} is held by session 735db33b, which is still running.") == []
