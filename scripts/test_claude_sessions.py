"""Tests for scripts/lib/claude_sessions.py — the live-session count the suite
bench's quiet gate and sample_load.py read, and the session pair the memory
sampler charges as admission does (docs/environment.md §5, #2231).

Break it and the gate refuses a machine one session quieter than it states, or
admits one busier: the daemon's standing spare is always resident (#1798). The
cwds are injected, or read from a fake WFC_PROC, so no case reads this
machine's /proc.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from claude_sessions import (
    count_sessions,
    is_claude,
    live_cwd,
    parse_ps,
    session_pair,
    spare_socket,
)

SPARE = "/tmp/cc-daemon-1000/5babd013/spare"


def pair(host, child, sock):
    return [
        f"{host} 546276 claude bg-pty-host --bg-pty-host {SPARE}/{sock}.pty.sock"
        f" 200 50 -- /home/l/.local/share/claude/versions/2.1.302"
        f" --bg-spare {SPARE}/{sock}.claim.sock",
        f"{child} {host} claude bg-spare --bg-spare {SPARE}/{sock}.claim.sock",
    ]


# Captured: two claimed sessions and the daemon's unclaimed spare,
# whose `bg-spare` cwd is still the spare directory.
CAPTURED = pair(628508, 628530, "d5f82b16") + pair(631360, 631382, "e5f120f6")
CAPTURED += pair(646413, 646834, "77b33c1f")
CAPTURED_CWDS = {
    628530: "/home/lucmo/workflow-core",
    631382: "/home/lucmo/workflow-core",
    646834: SPARE,
}

# A resumed session re-execs its child as the versioned binary, whose argv[0]
# basename is `2.1.234`, not `claude`.
RESUMED = [
    "700 1 claude bg-pty-host --bg-pty-host /tmp/b.pty.sock 200 50",
    "701 700 /home/l/.local/share/claude/versions/2.1.234 --resume /x/y.jsonl",
]
NOT_SESSIONS = [
    "800 1 /home/l/.local/bin/claude daemon run --origin transient",
    "801 1 claude agents --json",
    "802 1 node scripts/pick-next.js",
    # A shell pipeline that merely mentions the flag.
    "803 1 /bin/bash -c ps -eo args= | grep bg-pty-host",
]


def count(lines, cwds=None):
    cwds = cwds or {}
    return count_sessions(parse_ps("\n".join(lines)), cwds.get)


def test_the_unclaimed_spare_is_not_a_session():
    assert count(CAPTURED, CAPTURED_CWDS) == 2


def test_a_claimed_spare_is_a_session_whatever_its_job_record_says():
    # The claim with no job state #1798 found: counted, as it holds memory.
    cwds = {**CAPTURED_CWDS, 646834: "/home/lucmo"}
    assert count(CAPTURED, cwds) == 3


def test_an_unreadable_cwd_counts_as_claimed():
    assert count(CAPTURED, {}) == 3


def test_a_resumed_session_counts_once_not_twice():
    assert count(RESUMED) == 1


def test_the_daemon_the_agents_call_and_foreign_processes_are_not_sessions():
    assert count(NOT_SESSIONS) == 0


def test_a_session_is_not_counted_from_its_spare_alone():
    assert count([line for line in CAPTURED if "claude bg-spare" in line]) == 0


def test_a_spare_under_a_non_host_parent_subtracts_nothing():
    orphan = [f"900 1 claude bg-spare --bg-spare {SPARE}/x.claim.sock"]
    assert count(RESUMED + orphan, {900: SPARE}) == 1


def test_a_malformed_ps_line_is_skipped():
    assert parse_ps("\nabc def claude bg-pty-host\n12\n") == []


def test_claude_matches_section_5s_three_argv0_shapes():
    assert is_claude("claude")
    assert is_claude("C:\\Users\\u\\claude.exe")
    assert is_claude("/home/l/.local/bin/claude")
    assert is_claude("/home/l/.local/share/claude/versions/2.1.234")
    assert not is_claude("vim")
    assert not is_claude("2.1.234")


def test_spare_socket_reads_a_claude_process_and_never_a_shell_naming_the_path():
    host = ["claude", "bg-pty-host", "--bg-pty-host", f"{SPARE}/4c011d7b.pty.sock"]
    assert spare_socket(host) == "4c011d7b"
    assert spare_socket(["bash", "-c", f"ls {SPARE}/4c011d7b.pty.sock"]) is None
    assert spare_socket(["claude", "agents", "--json"]) is None


def test_a_session_pairs_through_its_spare_socket_and_alone_without_one():
    sockets = {10: "aa", 11: "aa", 20: "bb", 21: "bb"}
    assert sorted(session_pair(11, sockets)) == [10, 11]
    assert session_pair(30, sockets) == [30]


def test_live_cwd_reads_under_wfc_proc_and_is_none_for_a_pid_with_no_link(
    tmp_path, monkeypatch
):
    (tmp_path / "41").mkdir()
    (tmp_path / "41" / "cwd").symlink_to(SPARE)
    monkeypatch.setenv("WFC_PROC", str(tmp_path))
    assert live_cwd(41) == SPARE
    assert live_cwd(42) is None


def test_live_cwd_reads_proc_where_wfc_proc_is_empty(monkeypatch):
    # As the shell and Node twins do: an empty root is no root.
    monkeypatch.setenv("WFC_PROC", "")
    assert live_cwd(os.getpid()) == os.getcwd()
