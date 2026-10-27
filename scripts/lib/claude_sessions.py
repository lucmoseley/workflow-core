"""claude_sessions.py — the live-session count docs/environment.md §5 sets, and
admission's pairing of a session's processes, for the Python scripts that read
them off `ps` or /proc.

A session is a `bg-pty-host` whose `bg-spare` child has been claimed. The daemon
keeps one pre-warmed pair resident at all times, unclaimed, so counting every
host reads one high (workflow-core#1798). The argv cannot tell them apart — every host
carries a `<daemon>/spare/<id>.pty.sock` path, claimed or not — but the child's
cwd can: an unclaimed `bg-spare` still sits in the directory of its own claim
socket, and a claim moves it to the job's cwd. A cwd that cannot be read counts
as claimed, so the figure errs high, never low.

lib/claude-sessions.sh is the shell twin, for readers that cannot start
python3, and lib/claude-sessions.js the Node one; a change to the unit lands
in all three. It compares the directory by inode
where this compares the path string, so a symlinked spare directory reads as
claimed here — high, the safe direction.
"""

import os
import re

PS_ARGS = ["-eo", "pid=,ppid=,args="]


def parse_ps(text):
    """[(pid, ppid, argv)] from `ps -eo pid=,ppid=,args=`; a malformed line is skipped."""
    rows = []
    for line in text.splitlines():
        fields = line.split()
        try:
            rows.append((int(fields[0]), int(fields[1]), fields[2:]))
        except (ValueError, IndexError):
            # A header or torn line names no process to count (workflow-core#1798).
            continue
    return rows


def is_claude(argv0):
    """§5's three argv[0] shapes: bare name, launcher path, versioned binary.

    Never `comm`, which is the version string for a backgrounded session
    (mantahostels#481). A Windows argv[0] carries backslashes.
    """
    base = argv0.replace("\\", "/").rsplit("/", 1)[-1]
    return base in ("claude", "claude.exe") or "/claude/versions/" in argv0


def _role(argv):
    return argv[1] if len(argv) > 1 and is_claude(argv[0]) else None


def live_cwd(pid):
    """`pid`'s cwd, or None where it has exited or is not ours to read."""
    try:
        return os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        # None reads as claimed, so the count errs high (workflow-core#1798).
        return None


def _unclaimed(argv, cwd):
    try:
        sock = argv[argv.index("--bg-spare") + 1]
    except (ValueError, IndexError):
        # No claim socket to sit beside: not the daemon's spare (workflow-core#1798).
        return False
    return cwd is not None and cwd == os.path.dirname(sock)


def count_sessions(rows, cwd_of=live_cwd):
    """Live sessions among `parse_ps` rows: pty hosts less the daemon's unclaimed spares."""
    hosts = {pid for pid, _, argv in rows if _role(argv) == "bg-pty-host"}
    spares = {
        ppid
        for pid, ppid, argv in rows
        if ppid in hosts and _role(argv) == "bg-spare" and _unclaimed(argv, cwd_of(pid))
    }
    return len(hosts - spares)


# DUPLICATED BY HAND from scripts/lib/admission.js's SPARE_SOCKET, and
# session_pair from its sessionPairPids, the unit admission charges a session's
# pair in: move both, or neither (workflow-core#2231).
SPARE_SOCKET = re.compile(r"/spare/([A-Za-z0-9]+)\.")


def spare_socket(argv):
    """The pool socket id a `claude` process's argv carries, else None."""
    if not argv or not is_claude(argv[0]):
        return None
    found = SPARE_SOCKET.search(" ".join(argv))
    return found.group(1) if found else None


def session_pair(pid, sockets):
    """`pid` and every process sharing its socket id in `sockets` (pid -> id);
    a pid with none is its own pair alone."""
    socket = sockets.get(pid)
    if socket is None:
        return [pid]
    return [p for p, s in sockets.items() if s == socket]
