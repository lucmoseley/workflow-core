"""Tests for the SessionStart-intent scanner (mantahostels#1142).

These pin the discrimination the scanner exists for — a fresh background-job
start against a resume — and the two markers it reads.

Each test writes job records and transcript attachment lines, shaped as the
harness writes them, under a temp config dir, with the seat env vars cleared so
no real job or transcript is read.

CI's pytest step runs this file; the scanner
gates nothing and is re-run after a CLI upgrade. Breaking it misreports whether
`name-issue-session.sh` and `inject-tracker-docs.sh` see a background job's
opening command, so sessions reason off a hook route that has stopped firing.
"""

import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import scan_sessionstart_intent as ssi  # noqa: E402 - imported after HERE, which the sys.path.insert above reads (#1272)


@pytest.fixture(autouse=True)
def _no_seat_knobs(monkeypatch):
    for var in ("WFC_CLAUDE_CONFIG_A", "WFC_CLAUDE_CONFIG_B", "WFC_CLAUDE_CONFIG_C"):
        monkeypatch.delenv(var, raising=False)


def hook_line(matcher, text, field="stdout"):
    """One transcript attachment line, as the harness writes it.

    The harness puts a hook's output in `stdout` on a `hook_success` line and in
    `content` on the `hook_system_message` beside it.
    """
    return json.dumps(
        {
            "type": "attachment",
            "attachment": {
                "type": "hook_success",
                "hookName": matcher,
                "hookEvent": matcher.split(":")[0],
                field: text,
            },
        }
    )


def build(tmp_path, jobs):
    """jobs: [(job_id, state_overrides, [transcript lines])] -> (jobs_dir, projects_dir)"""
    # A test may build twice under one tmp_path, so each build gets its own root.
    root = tmp_path / f"build{len(list(tmp_path.iterdir()))}"
    jobs_dir = root / "jobs"
    projects_dir = root / "projects"
    jobs_dir.mkdir(parents=True)
    projects_dir.mkdir(parents=True)
    for job_id, overrides, lines in jobs:
        state = {
            "sessionId": "sess-" + job_id,
            "intent": "/triage 1142",
            "cliVersion": "2.1.241",
            "createdAt": "2026-08-24T12:43:29.403Z",
        }
        state.update(overrides)
        job_dir = jobs_dir / job_id
        job_dir.mkdir()
        (job_dir / "state.json").write_text(json.dumps(state))
        session_id = state.get("sessionId")
        if session_id is not None and lines is not None:
            (projects_dir / (session_id + ".jsonl")).write_text("\n".join(lines) + "\n")
    return str(jobs_dir), str(projects_dir)


NAMED = hook_line(
    "SessionStart:startup", "Session named — Triage 1142: two headers disagree"
)
INJECTED = hook_line(
    "SessionStart:startup", "You invoked /triage, which reads the tracker."
)


def scan(tmp_path, jobs):
    jobs_dir, projects_dir = build(tmp_path, jobs)
    return ssi.scan(jobs_dir, projects_dir)


def test_counts_both_markers_on_a_fresh_start(tmp_path):
    result = scan(tmp_path, [("a", {}, [NAMED, INJECTED])])
    assert result["by_cli_version"]["2.1.241"] == {"jobs": 1, "named": 1, "injected": 1}


def test_a_resume_compact_fork_or_clear_firing_counts_for_neither(tmp_path):
    """The claim under test is about a fresh start."""
    lines = [
        hook_line("SessionStart:resume", "Session named — Triage 1142: x"),
        hook_line(
            "SessionStart:compact", "You invoked /triage, which reads the tracker."
        ),
        hook_line("SessionStart:fork", "Session named — Triage 1142: x"),
        hook_line("SessionStart:clear", "Session named — Triage 1142: x"),
        hook_line("SessionStart", "You invoked /triage, which reads the tracker."),
    ]
    result = scan(tmp_path, [("a", {}, lines)])
    assert result["by_cli_version"]["2.1.241"] == {"jobs": 1, "named": 0, "injected": 0}


def test_userpromptsubmit_firing_counts_for_neither(tmp_path):
    """The pre-2.1.241 route. Counting it would report the seam as always open."""
    lines = [
        hook_line("UserPromptSubmit", "Session named — Triage 1142: x"),
        hook_line("UserPromptSubmit", "You invoked /triage, which reads the tracker."),
    ]
    result = scan(tmp_path, [("a", {}, lines)])
    assert result["by_cli_version"]["2.1.241"] == {"jobs": 1, "named": 0, "injected": 0}


def test_each_marker_is_counted_independently(tmp_path):
    """A scanner collapsing the two markers hides a job one hook fired on and
    the other did not — the residual that says the seam is a race."""
    injected_only = scan(tmp_path, [("a", {}, [INJECTED])])
    assert injected_only["by_cli_version"]["2.1.241"] == {
        "jobs": 1,
        "named": 0,
        "injected": 1,
    }
    named_only = scan(tmp_path, [("a", {}, [NAMED])])
    assert named_only["by_cli_version"]["2.1.241"] == {
        "jobs": 1,
        "named": 1,
        "injected": 0,
    }


def test_a_job_is_bucketed_by_its_own_cli_version(tmp_path):
    jobs = [
        ("old", {"sessionId": "sess-old", "cliVersion": "2.1.239"}, []),
        ("new", {"sessionId": "sess-new", "cliVersion": "2.1.241"}, [NAMED, INJECTED]),
    ]
    result = scan(tmp_path, jobs)
    assert result["by_cli_version"]["2.1.239"] == {"jobs": 1, "named": 0, "injected": 0}
    assert result["by_cli_version"]["2.1.241"] == {"jobs": 1, "named": 1, "injected": 1}


@pytest.mark.parametrize(
    "intent", ["/pick-next", "resume the wayfinder", "", "/unknown 12"]
)
def test_a_job_no_command_injects_for_is_not_scanned(tmp_path, intent):
    result = scan(tmp_path, [("a", {"intent": intent}, [NAMED])])
    assert result["jobs_scanned"] == 0


def test_a_job_whose_transcript_is_gone_is_reported_not_counted(tmp_path):
    result = scan(tmp_path, [("a", {}, None)])
    assert result["jobs_scanned"] == 0
    assert result["skipped_no_transcript"] == 1


def test_a_malformed_transcript_line_does_not_stop_the_scan(tmp_path):
    lines = ['{"hookEvent": broken', NAMED]
    result = scan(tmp_path, [("a", {}, lines)])
    assert result["by_cli_version"]["2.1.241"]["named"] == 1


def test_per_job_rows_carry_the_two_flags(tmp_path):
    result = scan(tmp_path, [("a", {}, [INJECTED])])
    row = result["jobs"][0]
    assert (row["job"], row["command"]) == ("a", "triage")
    assert (row["named_at_sessionstart"], row["injected_at_sessionstart"]) == (
        False,
        True,
    )


def test_a_marker_carried_in_content_rather_than_stdout_is_read(tmp_path):
    """Reading `stdout` alone misses the route entirely on a harness that stops
    emitting the paired line."""
    lines = [
        hook_line(
            "SessionStart:startup", "Session named — Triage 1142: x", field="content"
        ),
        hook_line("SessionStart:startup", "You invoked /triage, x", field="content"),
    ]
    result = scan(tmp_path, [("a", {}, lines)])
    assert result["by_cli_version"]["2.1.241"] == {"jobs": 1, "named": 1, "injected": 1}


def test_merge_adds_two_config_dirs_version_by_version(tmp_path):
    """Scanning only the live config dir makes an intermittent race read as a
    version cut-off."""
    old = scan(tmp_path, [("a", {"cliVersion": "2.1.233"}, [NAMED])])
    new = scan(tmp_path, [("b", {"sessionId": "sess-b"}, [NAMED, INJECTED])])
    merged = ssi.merge([old, new])
    assert merged["jobs_scanned"] == 2
    assert merged["by_cli_version"] == {
        "2.1.233": {"jobs": 1, "named": 1, "injected": 0},
        "2.1.241": {"jobs": 1, "named": 1, "injected": 1},
    }


def test_merge_sums_one_version_seen_in_both_dirs(tmp_path):
    left = scan(tmp_path, [("a", {"cliVersion": "2.1.237"}, [NAMED])])
    right = scan(
        tmp_path, [("b", {"sessionId": "sess-b", "cliVersion": "2.1.237"}, [])]
    )
    merged = ssi.merge([left, right])
    assert merged["by_cli_version"]["2.1.237"] == {"jobs": 2, "named": 1, "injected": 0}


def test_config_dirs_finds_both_the_live_dir_and_the_left_behind_one(
    tmp_path, monkeypatch
):
    """Both dirs must come back, not just the live one."""
    live = tmp_path / ".claude2"
    left_behind = tmp_path / ".claude"
    (live / "jobs").mkdir(parents=True)
    (left_behind / "jobs").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(live))
    monkeypatch.setenv("HOME", str(tmp_path))
    assert ssi.config_dirs() == [str(live), str(left_behind)]


def test_a_config_dir_holding_no_jobs_is_left_out(tmp_path, monkeypatch):
    """A machine that never set CLAUDE_CONFIG_DIR has one dir, not a crash."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "nonexistent"))
    monkeypatch.setenv("HOME", str(tmp_path))
    assert ssi.config_dirs() == []


def test_the_same_dir_named_twice_is_scanned_once(tmp_path, monkeypatch):
    """CLAUDE_CONFIG_DIR pointing at ~/.claude2 must not scan it twice and
    double every count."""
    live = tmp_path / ".claude2"
    (live / "jobs").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(live))
    monkeypatch.setenv("HOME", str(tmp_path))
    assert ssi.config_dirs() == [str(live)]
