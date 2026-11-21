"""claude_sessions.py — the live-session count docs/environment.md §5 sets, and
admission's pairing of a session's processes, for the Python scripts that read
them off `ps` or /proc.

A session is a `bg-pty-host` whose `bg-spare` child has been claimed. The daemon
keeps one pre-warmed pair resident at all times, unclaimed, so counting every
host reads one high (#1798). The argv cannot tell them apart — every host
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

from fail_open import expected, fail_open

PS_ARGS = ["-eo", "pid=,ppid=,args="]


def parse_ps(text):
    """[(pid, ppid, argv)] from `ps -eo pid=,ppid=,args=`; a malformed line is skipped."""
    rows = []
    for line in text.splitlines():
        fields = line.split()
        if not fields:
            continue
        try:
            rows.append((int(fields[0]), int(fields[1]), fields[2:]))
        except (ValueError, IndexError) as error:
            fail_open(error, f"ps line {line!r} skipped")
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
    """`pid`'s cwd under WFC_PROC's root, or None where it has exited or is not ours to read."""
    try:
        return os.readlink(f"{os.environ.get('WFC_PROC') or '/proc'}/{pid}/cwd")
    except (FileNotFoundError, PermissionError, ProcessLookupError) as error:
        expected(error, f"pid {pid} exited or is another user's")
        return None


def _unclaimed(argv, cwd):
    if "--bg-spare" not in argv:
        return False
    at = argv.index("--bg-spare") + 1
    if at >= len(argv):
        return False
    sock = argv[at]
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


# DUPLICATED BY HAND from scripts/lib/claude-sessions.js's SPARE_SOCKET, and
# session_pair from scripts/lib/admission.js's sessionPairPids, the unit
# admission charges a session's pair in: move both, or neither (#2231).
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
