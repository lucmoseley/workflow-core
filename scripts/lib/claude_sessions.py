import os
import re

from fail_open import expected, fail_open

PS_ARGS = ["-eo", "pid=,ppid=,args="]


def parse_ps(text):
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
    base = argv0.replace("\\", "/").rsplit("/", 1)[-1]
    return base in ("claude", "claude.exe") or "/claude/versions/" in argv0


def _role(argv):
    return argv[1] if len(argv) > 1 and is_claude(argv[0]) else None


def live_cwd(pid):
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
    hosts = {pid for pid, _, argv in rows if _role(argv) == "bg-pty-host"}
    spares = {
        ppid
        for pid, ppid, argv in rows
        if ppid in hosts and _role(argv) == "bg-spare" and _unclaimed(argv, cwd_of(pid))
    }
    return len(hosts - spares)


SPARE_SOCKET = re.compile(r"/spare/([A-Za-z0-9]+)\.")


def spare_socket(argv):
    if not argv or not is_claude(argv[0]):
        return None
    found = SPARE_SOCKET.search(" ".join(argv))
    return found.group(1) if found else None


def session_pair(pid, sockets):
    socket = sockets.get(pid)
    if socket is None:
        return [pid]
    return [p for p, s in sockets.items() if s == socket]
