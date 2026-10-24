"""Pins that the tracker-doc read-rate scanner counts a read, or a rule fetch,
only from a session's own tool call -- never from the injection, prose or a
tool result -- over sessions that mutate the tracker (mantahostels#1869).

The measurement is only worth anything if a read means the session opened the
file itself.

Each test writes a synthetic transcript; nothing here reads the real corpus.

CI's pytest step runs this file; the scanner
gates nothing and is run by hand. Loosen a case and the before/after on
`scripts/inject-tracker-docs.sh` (mantahostels#1872) scores sessions as
following the tracker rules that never opened them.
"""

import json
import os
import sys
from collections import Counter

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import scan_doc_reads as sdr  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)

TRACKER = "docs/agents/issue-tracker.md"
LABELS = "docs/agents/triage-labels.md"


def injection(cmd="wayfinder", body=None):
    """The attachment shape a hook injection takes in a transcript."""
    text = (
        body
        if body is not None
        else (
            f"You invoked /{cmd}, which reads or writes the issue tracker. "
            f"--- BEGIN {TRACKER} ---\nrules\n--- END {TRACKER} ---"
        )
    )
    return {
        "type": "attachment",
        "timestamp": "2026-08-20T10:00:00.000Z",
        "attachment": {"type": "hook_additional_context", "content": text},
    }


def tool_use(name, inp):
    return {
        "type": "assistant",
        "timestamp": "2026-08-20T10:01:00.000Z",
        "message": {"content": [{"type": "tool_use", "name": name, "input": inp}]},
    }


def assistant_text(text):
    return {
        "type": "assistant",
        "timestamp": "2026-08-20T10:01:00.000Z",
        "message": {"content": [{"type": "text", "text": text}]},
    }


def tool_result(text):
    return {
        "type": "user",
        "timestamp": "2026-08-20T10:02:00.000Z",
        "message": {"content": [{"type": "tool_result", "content": text}]},
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


def test_a_real_read_is_counted(transcript):
    p = transcript("s", [injection(), tool_use("Read", {"file_path": TRACKER})])
    assert sdr.scan_file(p, Counter())["read"] == ["issue-tracker"]


def test_a_bash_command_naming_the_path_is_a_read(transcript):
    p = transcript(
        "s", [injection(), tool_use("Bash", {"command": f"sed -n '1,40p' {LABELS}"})]
    )
    assert sdr.scan_file(p, Counter())["read"] == ["triage-labels"]


def test_the_injection_naming_the_document_is_not_a_read(transcript):
    """The payload fences both documents by path. That is delivery, not a read."""
    p = transcript("s", [injection()])
    assert sdr.scan_file(p, Counter())["read"] == []


def test_assistant_prose_quoting_the_path_is_not_a_read(transcript):
    """A whole-transcript grep matches this line."""
    p = transcript(
        "s", [injection(), assistant_text(f"Per {TRACKER} §Claiming, assign first.")]
    )
    assert sdr.scan_file(p, Counter())["read"] == []


def test_a_tool_result_carrying_the_path_back_is_not_a_read(transcript):
    """A result is the file's own bytes returning, not a decision to open it."""
    p = transcript("s", [injection(), tool_result(f"--- BEGIN {TRACKER} ---")])
    assert sdr.scan_file(p, Counter())["read"] == []


def test_an_edit_is_recorded_separately_and_never_as_a_read(transcript):
    p = transcript(
        "s", [injection(), tool_use("Edit", {"file_path": TRACKER, "old_string": "a"})]
    )
    row = sdr.scan_file(p, Counter())
    assert row["read"] == []
    assert row["edited"] == ["issue-tracker"]


def test_a_session_naming_no_tracker_command_is_not_one(transcript):
    """No injection means no denominator."""
    p = transcript("s", [tool_use("Read", {"file_path": TRACKER})])
    assert sdr.scan_file(p, Counter())["commands"] == []


def test_the_strict_detector_ignores_a_quoted_marker(transcript):
    """`--loose` matches an assistant explaining the hook; the default must not."""
    quoting = assistant_text("The hook emits `You invoked /triage` at the top.")
    p = transcript("s", [injection("wayfinder"), quoting])
    assert sdr.scan_file(p, Counter())["commands"] == ["wayfinder"]
    assert sdr.scan_file(p, Counter(), loose=True)["commands"] == [
        "triage",
        "wayfinder",
    ]


def test_an_attachment_of_another_type_is_not_an_invocation(transcript):
    other = injection()
    other["attachment"]["type"] = "file_read"
    p = transcript("s", [other, tool_use("Read", {"file_path": TRACKER})])
    assert sdr.scan_file(p, Counter())["commands"] == []


def test_an_unparsable_line_is_counted_not_swallowed(tmp_path):
    """A dropped transcript line makes the denominator a guess; it must show."""
    p = tmp_path / "s.jsonl"
    p.write_text(
        json.dumps(injection(), separators=(",", ":"))
        + "\n"
        + '{"broken": "docs/agents/issue-tracker.md"\n'
    )
    tally = Counter()
    sdr.scan_file(str(p), tally)
    assert tally["unparsed lines"] == 1


def test_the_window_drops_a_session_that_started_before_it(tmp_path):
    p = tmp_path / "old.jsonl"
    p.write_text(json.dumps(injection(), separators=(",", ":")) + "\n")
    kept, _ = sdr.scan_dir(str(tmp_path), after="2026-08-01T00:00:00.000Z")
    dropped, _ = sdr.scan_dir(str(tmp_path), after="2026-09-01T00:00:00.000Z")
    assert len(kept) == 1
    assert dropped == []


def test_a_session_naming_two_commands_counts_under_both(transcript):
    p = transcript(
        "s",
        [
            injection("wayfinder"),
            injection("implement"),
            tool_use("Read", {"file_path": TRACKER}),
        ],
    )
    per = sdr.tally([sdr.scan_file(p, Counter())])
    assert per["wayfinder"]["n"] == 1
    assert per["implement"]["n"] == 1
    assert per["implement"]["read"]["issue-tracker"] == 1


def test_prose_beside_a_tool_call_in_the_same_turn_is_not_a_read(transcript):
    """An assistant turn that BOTH names the document in its text and calls a
    tool on something else. Scanning the record rather than the tool's own input
    scores this as a read."""
    turn = {
        "type": "assistant",
        "timestamp": "2026-08-20T10:01:00.000Z",
        "message": {
            "content": [
                {"type": "text", "text": f"Next I check {TRACKER} for the claim rule."},
                {
                    "type": "tool_use",
                    "name": "Bash",
                    "input": {"command": "gh issue view 1"},
                },
            ]
        },
    }
    p = transcript("s", [injection(), turn])
    assert sdr.scan_file(p, Counter())["read"] == []


def hook_success(cmd="wayfinder"):
    """The shape an UNDER-CAP payload takes: the hook's own output, logged whole."""
    return {
        "type": "attachment",
        "timestamp": "2026-08-20T10:00:00.000Z",
        "attachment": {
            "type": "hook_success",
            "output": f"You invoked /{cmd}, which reads or writes the issue tracker.",
        },
    }


def test_an_under_cap_injection_counts(transcript):
    p = transcript(
        "s", [hook_success("triage"), tool_use("Read", {"file_path": LABELS})]
    )
    row = sdr.scan_file(p, Counter())
    assert row["commands"] == ["triage"]
    assert row["read"] == ["triage-labels"]


def test_both_shapes_of_the_same_command_count_once(transcript):
    p = transcript("s", [injection("wayfinder"), hook_success("wayfinder")])
    assert sdr.scan_file(p, Counter())["commands"] == ["wayfinder"]


def test_a_command_the_hook_never_fires_on_is_not_counted(transcript):
    """The marker regex accepts any name; COMMANDS is what keeps prose out."""
    p = transcript("s", [injection("pick-next"), injection("wayfinder")])
    assert sdr.scan_file(p, Counter())["commands"] == ["wayfinder"]


def test_a_git_command_naming_the_path_is_not_a_read(transcript):
    """Committing the file names it without opening it."""
    p = transcript(
        "s",
        [injection(), tool_use("Bash", {"command": f'git commit -m "x" -- {TRACKER}'})],
    )
    assert sdr.scan_file(p, Counter())["read"] == []


def test_a_reading_segment_beside_a_non_reading_one_still_counts(transcript):
    """`cd` then `grep` is one line and two segments; the grep is a real read."""
    p = transcript(
        "s",
        [
            injection(),
            tool_use(
                "Bash",
                {
                    "command": f"cd /repo && git add {TRACKER} && grep -n Claim {TRACKER}"
                },
            ),
        ],
    )
    assert sdr.scan_file(p, Counter())["read"] == ["issue-tracker"]


def test_an_unparsable_line_counts_even_where_the_file_is_not_a_tracker_session(
    tmp_path,
):
    """No marker survived, so the file is dropped — and its unparsed count with
    it, unless it is taken first."""
    p = tmp_path / "s.jsonl"
    p.write_text('{"broken": "docs/agents/issue-tracker.md"\n')
    sessions, skipped = sdr.scan_dir(str(tmp_path))
    assert sessions == []
    assert skipped["unparsed lines"] == 1


def test_a_cutoff_without_milliseconds_keeps_that_second(tmp_path):
    """`"…24.500Z" >= "…24Z"` is False, so an unpadded cutoff drops a session
    that is genuinely after it."""
    rec = injection()
    rec["timestamp"] = "2026-08-28T14:03:24.500Z"
    p = tmp_path / "s.jsonl"
    p.write_text(json.dumps(rec, separators=(",", ":")) + "\n")
    kept, _ = sdr.scan_dir(str(tmp_path), after="2026-08-28T14:03:24Z")
    assert len(kept) == 1


def test_a_session_with_no_timestamp_is_dropped_from_a_window(tmp_path):
    """Unplaceable, so dropped rather than assumed inside the window."""
    rec = injection()
    del rec["timestamp"]
    p = tmp_path / "s.jsonl"
    p.write_text(json.dumps(rec, separators=(",", ":")) + "\n")
    assert sdr.scan_dir(str(tmp_path), after="2026-08-01T00:00:00.000Z")[0] == []
    assert len(sdr.scan_dir(str(tmp_path))[0]) == 1


def persisted(cmd="wayfinder"):
    """The stub shape: same record type, content opening with the marker."""
    rec = injection(cmd)
    rec["attachment"]["content"] = (
        "<persisted-output>\nOutput too large (38.2KB). Full output saved to: /tmp/x.txt\n\n"
        f"Preview (first 2KB):\nYou invoked /{cmd}, which reads or writes the issue tracker."
    )
    return rec


def test_persistence_is_read_off_the_marker_not_the_record_type(transcript):
    """Both are `hook_additional_context`; only the content tells them apart."""
    p = transcript("s", [persisted(), injection("triage")])
    assert sdr.scan_file(p, Counter())["shapes"] == {"persisted": 1, "inline": 1}


def test_the_execution_log_is_counted_as_neither(transcript):
    p = transcript("s", [hook_success()])
    assert sdr.scan_file(p, Counter())["shapes"] == {"log": 1}


def test_a_program_not_on_the_allowlist_is_not_a_read(transcript):
    """A blocklist would score this; the allowlist is why it does not."""
    p = transcript(
        "s",
        [injection(), tool_use("Bash", {"command": f"somethingnew --file {TRACKER}"})],
    )
    assert sdr.scan_file(p, Counter())["read"] == []


def test_a_heredoc_hiding_the_path_inside_a_commit_is_not_a_read(transcript):
    """The shape that defeats a blocklist: the segment's program is `git`."""
    cmd = f"git commit -F - <<EOF\nsee {TRACKER}\nEOF"
    p = transcript("s", [injection(), tool_use("Bash", {"command": cmd})])
    assert sdr.scan_file(p, Counter())["read"] == []


def test_a_session_with_no_tracker_mutating_call_is_not_conditioned_in(transcript):
    p = transcript(
        "s", [injection("implement"), tool_use("Read", {"file_path": TRACKER})]
    )
    assert sdr.scan_file(p, Counter())["mutated_tracker"] is False


def test_gh_issue_edit_is_a_mutating_call(transcript):
    p = transcript(
        "s",
        [
            injection("implement"),
            tool_use("Bash", {"command": "gh issue edit 3214 --add-assignee @me"}),
        ],
    )
    assert sdr.scan_file(p, Counter())["mutated_tracker"] is True


def test_gh_issue_close_is_a_mutating_call(transcript):
    p = transcript(
        "s",
        [injection("implement"), tool_use("Bash", {"command": "gh issue close 3214"})],
    )
    assert sdr.scan_file(p, Counter())["mutated_tracker"] is True


def test_gh_issue_comment_is_a_mutating_call(transcript):
    p = transcript(
        "s",
        [
            injection("implement"),
            tool_use("Bash", {"command": 'gh issue comment 3214 --body "x"'}),
        ],
    )
    assert sdr.scan_file(p, Counter())["mutated_tracker"] is True


def test_gh_issue_create_is_a_mutating_call(transcript):
    p = transcript(
        "s",
        [
            injection("implement"),
            tool_use("Bash", {"command": 'gh issue create --title "x" --body "y"'}),
        ],
    )
    assert sdr.scan_file(p, Counter())["mutated_tracker"] is True


def test_gh_issue_view_is_not_a_mutating_call(transcript):
    p = transcript(
        "s",
        [
            injection("implement"),
            tool_use("Bash", {"command": "gh issue view 3214 --comments"}),
        ],
    )
    assert sdr.scan_file(p, Counter())["mutated_tracker"] is False


def test_gh_issue_list_is_not_a_mutating_call(transcript):
    p = transcript(
        "s",
        [
            injection("implement"),
            tool_use("Bash", {"command": "gh issue list --label bug"}),
        ],
    )
    assert sdr.scan_file(p, Counter())["mutated_tracker"] is False


def test_gh_api_post_to_issues_is_a_mutating_call(transcript):
    p = transcript(
        "s",
        [
            injection("implement"),
            tool_use(
                "Bash",
                {"command": "gh api -X POST repos/x/y/issues/1/comments -f body=x"},
            ),
        ],
    )
    assert sdr.scan_file(p, Counter())["mutated_tracker"] is True


def test_gh_api_get_to_issues_is_not_a_mutating_call(transcript):
    p = transcript(
        "s",
        [
            injection("implement"),
            tool_use("Bash", {"command": "gh api repos/x/y/issues/1"}),
        ],
    )
    assert sdr.scan_file(p, Counter())["mutated_tracker"] is False


def test_gh_api_graphql_mutation_is_a_mutating_call(transcript):
    p = transcript(
        "s",
        [
            injection("implement"),
            tool_use(
                "Bash",
                {
                    "command": "gh api graphql -f query='mutation { addComment(input: {}) { clientMutationId } }'"
                },
            ),
        ],
    )
    assert sdr.scan_file(p, Counter())["mutated_tracker"] is True


def test_gh_api_graphql_query_is_not_a_mutating_call(transcript):
    p = transcript(
        "s",
        [
            injection("implement"),
            tool_use(
                "Bash",
                {"command": "gh api graphql -f query='query { viewer { login } }'"},
            ),
        ],
    )
    assert sdr.scan_file(p, Counter())["mutated_tracker"] is False


def test_gh_api_graphql_read_with_explicit_post_is_not_a_mutating_call(transcript):
    """A `graphql` call with no `mutation` keyword must never fall through to
    the REST method check just because the query mentions `issues`."""
    p = transcript(
        "s",
        [
            injection("implement"),
            tool_use(
                "Bash",
                {
                    "command": "gh api graphql -X POST -f query='query { repository { issues } }'"
                },
            ),
        ],
    )
    assert sdr.scan_file(p, Counter())["mutated_tracker"] is False


def test_a_mutating_line_inside_a_heredoc_is_not_a_call(transcript):
    """A script being written to disk can quote a `gh issue close` line as
    example text; `SEGMENT` splits on newlines, so without stripping the
    heredoc body that quoted line lands in program position (mantahostels#3264)."""
    cmd = "cat > script.sh <<'EOF'\ngh issue close 3214\nEOF"
    p = transcript("s", [injection("implement"), tool_use("Bash", {"command": cmd})])
    assert sdr.scan_file(p, Counter())["mutated_tracker"] is False


def test_a_real_mutating_call_after_a_heredoc_still_counts(transcript):
    """Stripping the body must not swallow the rest of the command."""
    cmd = (
        "cat > script.sh <<'EOF'\n"
        "gh issue close 3214\n"
        "EOF\n"
        "gh issue edit 1 --add-assignee @me"
    )
    p = transcript("s", [injection("implement"), tool_use("Bash", {"command": cmd})])
    assert sdr.scan_file(p, Counter())["mutated_tracker"] is True


def test_a_here_string_does_not_swallow_the_next_line(transcript):
    """`<<<"gh"` is a here-string, not a heredoc opener — read as one with
    terminator `gh`, it would swallow the real mutating call on the next line
    (mantahostels#3283)."""
    cmd = 'grep gh <<<"gh"\ngh issue close 3214'
    p = transcript("s", [injection("implement"), tool_use("Bash", {"command": cmd})])
    assert sdr.scan_file(p, Counter())["mutated_tracker"] is True


def test_an_escaped_heredoc_opener_still_strips_its_body(transcript):
    """HEREDOC_OPEN must recognise `<<\\EOF` too, or the body's
    mutating-looking line is scored as a real call (mantahostels#3283)."""
    cmd = "cat > script.sh <<\\EOF\ngh issue close 3214\nEOF"
    p = transcript("s", [injection("implement"), tool_use("Bash", {"command": cmd})])
    assert sdr.scan_file(p, Counter())["mutated_tracker"] is False


def test_a_mutating_call_beside_a_non_mutating_segment_still_counts(transcript):
    p = transcript(
        "s",
        [
            injection("implement"),
            tool_use(
                "Bash",
                {"command": "gh issue view 1 && gh issue edit 1 --add-assignee @me"},
            ),
        ],
    )
    assert sdr.scan_file(p, Counter())["mutated_tracker"] is True


def test_tally_conditions_read_rate_on_mutating_sessions_only(transcript):
    """The subset with a mutating call has its own n and read count, distinct
    from the unconditioned figures on the same command."""
    untouched = transcript("untouched", [injection("implement")])
    mutated_no_read = transcript(
        "mutated_no_read",
        [
            injection("implement"),
            tool_use("Bash", {"command": "gh issue edit 1 --add-assignee @me"}),
        ],
    )
    mutated_and_read = transcript(
        "mutated_and_read",
        [
            injection("implement"),
            tool_use("Bash", {"command": "gh issue close 1"}),
            tool_use("Read", {"file_path": TRACKER}),
        ],
    )
    rows = [
        sdr.scan_file(p, Counter())
        for p in (untouched, mutated_no_read, mutated_and_read)
    ]
    per = sdr.tally(rows)
    assert per["implement"]["n"] == 3
    assert per["implement"]["n_mutated"] == 2
    assert per["implement"]["read"]["issue-tracker"] == 1
    assert per["implement"]["read_mutated"]["issue-tracker"] == 1


FETCHER = "scripts/lib/rule-text.sh"


def test_a_bare_fetcher_call_is_a_rule_text_read(transcript):
    p = transcript(
        "s",
        [
            injection("implement"),
            tool_use("Bash", {"command": f"{FETCHER} rule:gh-cli-limits"}),
        ],
    )
    row = sdr.scan_file(p, Counter())
    assert row["read"] == ["rule-text"]
    assert row["rule_ids"] == ["gh-cli-limits"]


def test_a_fetcher_call_is_not_a_read_of_either_document(transcript):
    p = transcript(
        "s",
        [
            injection("implement"),
            tool_use("Bash", {"command": f"{FETCHER} rule:gh-cli-limits"}),
        ],
    )
    assert "issue-tracker" not in sdr.scan_file(p, Counter())["read"]


def test_the_fetcher_run_through_bash_counts(transcript):
    p = transcript(
        "s",
        [
            injection("implement"),
            tool_use("Bash", {"command": f"bash {FETCHER} card-close-route"}),
        ],
    )
    row = sdr.scan_file(p, Counter())
    assert row["read"] == ["rule-text"]
    assert row["rule_ids"] == ["card-close-route"]


def test_a_sourced_or_sh_fetcher_call_is_not_a_read(transcript):
    """`source`/`.` stop at the fetcher's `BASH_SOURCE[0] == $0` CLI guard
    (`scripts/lib/rule-text.sh:115`) and `sh` — dash here — dies on the bashism
    first, so neither delivers any rule text (mantahostels#3275).
    """
    for lead in ("source", ".", "sh"):
        p = transcript(
            "s",
            [
                injection("implement"),
                tool_use("Bash", {"command": f"{lead} {FETCHER} roadmap-gating"}),
            ],
        )
        assert sdr.scan_file(p, Counter())["read"] == [], lead


def test_naming_the_fetcher_without_running_it_is_not_a_read(transcript):
    """`cat`ing the script reads the fetcher, not a rule; and `git log --` would
    otherwise score its trailing pathspec words as rule ids."""
    for command in (
        f"cat {FETCHER}",
        f"git log -- {FETCHER} docs agents",
        f'gh issue comment 1 --body "run {FETCHER}"',
    ):
        p = transcript(
            "s", [injection("implement"), tool_use("Bash", {"command": command})]
        )
        assert sdr.scan_file(p, Counter())["read"] == [], command


def test_a_fetcher_call_beside_a_non_running_segment_still_counts(transcript):
    p = transcript(
        "s",
        [
            injection("implement"),
            tool_use("Bash", {"command": f"cat {FETCHER} && {FETCHER} rule:x-y"}),
        ],
    )
    assert sdr.scan_file(p, Counter())["read"] == ["rule-text"]


def test_an_id_built_from_a_variable_ends_the_run_but_not_the_call(transcript):
    """Unresolvable statically, so the call counts and the run STOPS there —
    a word after it is not an argument this scan can place."""
    p = transcript(
        "s",
        [
            injection("implement"),
            tool_use("Bash", {"command": f'{FETCHER} "$id" gh-cli-limits'}),
        ],
    )
    row = sdr.scan_file(p, Counter())
    assert row["read"] == ["rule-text"]
    assert row["rule_ids"] == []


def test_prose_naming_the_fetcher_is_not_a_rule_text_read(transcript):
    p = transcript(
        "s",
        [
            injection("implement"),
            assistant_text(f"Fetch it with `{FETCHER} rule:gh-cli-limits`."),
        ],
    )
    assert sdr.scan_file(p, Counter())["read"] == []


def test_the_fetch_channel_is_tallied_beside_the_documents(transcript):
    """Per-channel n, unconditioned and conditioned on a mutating call."""
    fetched = transcript(
        "fetched",
        [
            injection("implement"),
            tool_use("Bash", {"command": "gh issue close 1"}),
            tool_use("Bash", {"command": f"{FETCHER} rule:close-outstanding"}),
        ],
    )
    read_doc = transcript(
        "read_doc", [injection("implement"), tool_use("Read", {"file_path": TRACKER})]
    )
    per = sdr.tally(
        [sdr.scan_file(fetched, Counter()), sdr.scan_file(read_doc, Counter())]
    )
    assert per["implement"]["n"] == 2
    assert per["implement"]["read"]["rule-text"] == 1
    assert per["implement"]["read"]["issue-tracker"] == 1
    assert per["implement"]["n_mutated"] == 1
    assert per["implement"]["read_mutated"]["rule-text"] == 1
    assert per["implement"]["read_mutated"]["issue-tracker"] == 0


def test_a_fetch_line_does_not_move_the_session_in_the_window(tmp_path):
    """`--after` cuts on the first line surviving the OLD prefilter (mantahostels#3275)."""
    early = tool_use("Bash", {"command": f"{FETCHER} rule:gh-cli-limits"})
    early["timestamp"] = "2026-08-01T00:00:00.000Z"
    late = injection("implement")
    late["timestamp"] = "2026-09-01T00:00:00.000Z"
    p = tmp_path / "s.jsonl"
    p.write_text(
        "".join(json.dumps(r, separators=(",", ":")) + "\n" for r in (early, late))
    )
    rows, _ = sdr.scan_dir(str(tmp_path), after="2026-08-15T00:00:00.000Z")
    assert len(rows) == 1
    assert rows[0]["timestamp"] == "2026-09-01T00:00:00.000Z"
    assert rows[0]["read"] == ["rule-text"]


def test_a_fetcher_line_inside_a_heredoc_is_not_a_call(transcript):
    """`SEGMENT` splits on newlines, so a heredoc body line beginning with the
    fetcher path lands in program position, and the repo writes issue bodies
    exactly this way (mantahostels#3275)."""
    cmd = f"gh issue create --body-file - <<'BODY'\n{FETCHER} rule:gh-cli-limits\nBODY"
    p = transcript("s", [injection("implement"), tool_use("Bash", {"command": cmd})])
    row = sdr.scan_file(p, Counter())
    assert row["read"] == []
    assert row["rule_ids"] == []


def test_a_real_call_after_a_heredoc_still_counts(transcript):
    """Stripping the body must not swallow the rest of the command."""
    cmd = (
        "gh issue comment 1 --body-file - <<'BODY'\n"
        f"see {FETCHER}\n"
        "BODY\n"
        f"{FETCHER} rule:close-outstanding"
    )
    p = transcript("s", [injection("implement"), tool_use("Bash", {"command": cmd})])
    assert sdr.scan_file(p, Counter())["rule_ids"] == ["close-outstanding"]


def test_a_call_that_asks_for_no_rule_is_not_a_read(transcript):
    """`--ids` enumerates the store and exits; a bare call is a usage error.
    Neither delivers rule text, so neither is a read."""
    for command in (f"{FETCHER} --ids", FETCHER):
        p = transcript(
            "s", [injection("implement"), tool_use("Bash", {"command": command})]
        )
        assert sdr.scan_file(p, Counter())["read"] == [], command


def test_the_default_corpus_spans_both_seat_roots(seat_roots):
    roots = seat_roots(2)
    (roots[0] / "a.jsonl").write_text("")
    (roots[1] / "b.jsonl").write_text("")
    (roots[1] / "b" / "subagents").mkdir(parents=True)
    (roots[1] / "b" / "subagents" / "agent-x.jsonl").write_text("")
    assert sdr.corpus_paths() == [str(roots[0] / "a.jsonl"), str(roots[1] / "b.jsonl")]
    assert sdr.corpus_paths(str(roots[1])) == [str(roots[1] / "b.jsonl")]
