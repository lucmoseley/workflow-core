"""call_cost_harness.py — what one call of a hot-path Python program costs:
the repo modules it loads and the child processes it starts (base §G13 (5),
workflow-core#5335).
The Python half of lib/call-cost-harness.js, for pytest.

FOR TESTS ONLY. A pin asserts both lists with exact equality, so any growth
fails the run naming what grew; no timing figure is ever read
(mantahostels#2255).

The program runs in this process as `__main__` through `runpy.run_path`, from
a purged registry: every repo module (one whose file sits under the scripts
root, site-packages aside) is dropped from `sys.modules` first, so the call
re-imports what it needs and `modules` is exactly what it loaded, the program
itself included. For the call only, `sys.argv`, `sys.path[0]` (the program's
directory, as `python3 <path>` sets it), the cwd, `os.environ` (replaced
whole by `env`, as a spawn's env is), fds 0, 1 and 2 with `sys.stdin`,
`sys.stdout` and `sys.stderr`, and every process starter are patched;
everything, the purged modules included, is put back after it, a throwing
call too.

A child is recorded as the executable's basename and its first argument,
joined by a space. An absolute first argument is shown relative to the scripts root, else to the call's cwd, else as its
basename, so a pin holds no machine path. A shell-string start (`os.system`,
or a `Popen` given a string) is split on whitespace.

Every call raises CallCostError where the program exits other than
`expect_status` (default 0) or writes stderr without `allow_stderr`. An exception escaping
the program is exit 1 with its traceback on stderr, as under `python3`.

BLIND SPOT: children are counted by replacing `subprocess.Popen`,
`os.system`, `os.posix_spawn` and `os.posix_spawnp` on their modules for the
call's duration; `subprocess.run`, `call`, `check_call`, `check_output`,
`getoutput` and `os.popen` all reach `Popen` and count once. A starter bound
by name before the call in a module the purge keeps (stdlib or
site-packages: `from subprocess import Popen`) is not seen, nor are
`os.fork`, the `os.exec*` and `os.spawn*` families, `pty.spawn` and
`multiprocessing`'s own starts.

BLIND SPOT: stdout and stderr are read at fd 1 and 2, so a child that
inherits them writes into the call's output, as it would into a real
process's; a program that holds its own dup of a real fd from before the call
writes past the capture.
"""

import io
import os
import runpy
import subprocess
import sys
import tempfile
import traceback
from dataclasses import dataclass, field
from pathlib import Path

from is_under import relative_under

_SELF = os.path.realpath(__file__)
_VENDORED = ("site-packages", "dist-packages")


class CallCostError(Exception):
    """The call broke: an unexpected exit or stray stderr."""


@dataclass
class CallCost:
    code: int
    stdout: str
    stderr: str
    modules: list[str] = field(default_factory=list)
    children: list[str] = field(default_factory=list)


def _scripts_root_of(script: str) -> str:
    for parent in Path(script).parents:
        if parent.name == "scripts":
            return str(parent)
    return os.path.dirname(script)


def _under(file: str, root: str) -> bool:
    return (
        bool(relative_under(root, file))
        and file != _SELF
        and not any(part in _VENDORED for part in Path(file).parts)
    )


def _repo_modules(root: str) -> dict[str, str]:
    found = {}
    for name, module in list(sys.modules.items()):
        file = getattr(module, "__file__", None)
        if not isinstance(file, str):
            continue
        real = os.path.realpath(file)
        if _under(real, root):
            found[name] = real
    return found


def _shown_arg(arg: str, root: str, cwd: str) -> str:
    if not os.path.isabs(arg):
        return arg
    for base in (root, cwd):
        rel = relative_under(base, arg)
        if rel:
            return rel
    return os.path.basename(arg)


def _child(file: object, first: object, root: str, cwd: str) -> str:
    name = os.path.basename(os.fspath(file))  # type: ignore[arg-type]
    if first is None:
        return name
    return f"{name} {_shown_arg(os.fsdecode(first), root, cwd)}"  # type: ignore[arg-type]


def _shell_child(command: object, root: str, cwd: str) -> str:
    tokens = [
        t[1:-1] if len(t) > 1 and t[0] == t[-1] and t[0] in "\"'" else t
        for t in os.fsdecode(command).split()  # type: ignore[arg-type]
    ]
    if not tokens:
        return ""
    return _child(tokens[0], tokens[1] if len(tokens) > 1 else None, root, cwd)


def _record_starts(children: list[str], root: str, cwd: str):
    """Replaces each starter with a recorder forwarding to the original, and
    returns the function putting them back. `children` is the caller's
    accumulator: each start is appended to it, in order."""
    popen = subprocess.Popen
    system = os.system
    spawn = os.posix_spawn
    spawnp = os.posix_spawnp
    # Popen itself may start its child through os.posix_spawn: that start is
    # the Popen's, counted once.
    inside = [0]

    class RecordingPopen(popen):  # type: ignore[valid-type, misc]
        def __init__(self, args, *rest, **kwargs):
            if isinstance(args, (str, bytes)):
                children.append(_shell_child(args, root, cwd))
            else:
                argv = list(args)
                children.append(
                    _child(argv[0], argv[1] if len(argv) > 1 else None, root, cwd)
                )
            inside[0] += 1
            try:
                super().__init__(args, *rest, **kwargs)
            finally:
                inside[0] -= 1

    def recording_system(command):
        children.append(_shell_child(command, root, cwd))
        return system(command)

    def recorder(original):
        def recording_spawn(path, argv, *rest, **kwargs):
            if not inside[0]:
                argv = list(argv)
                children.append(
                    _child(path, argv[1] if len(argv) > 1 else None, root, cwd)
                )
            return original(path, argv, *rest, **kwargs)

        return recording_spawn

    RecordingPopen.__name__ = RecordingPopen.__qualname__ = "Popen"
    subprocess.Popen = RecordingPopen  # type: ignore[misc]
    os.system = recording_system
    os.posix_spawn = recorder(spawn)
    os.posix_spawnp = recorder(spawnp)

    def restore() -> None:
        subprocess.Popen = popen  # type: ignore[misc]
        os.system = system
        os.posix_spawn = spawn
        os.posix_spawnp = spawnp

    return restore


def _exit_code(exc: SystemExit) -> int:
    if exc.code is None:
        return 0
    if isinstance(exc.code, int):
        return exc.code
    print(exc.code, file=sys.stderr)
    return 1


def _run(script: str, argv: list[str], *, cwd: str, env, stdin: str | bytes) -> tuple:
    """Runs `script` with every process-wide patch in place, and returns its
    exit, stdout and stderr."""
    saved_fds = {fd: os.dup(fd) for fd in (0, 1, 2)}
    saved_streams = (sys.stdin, sys.stdout, sys.stderr)
    saved_argv, saved_path, saved_cwd = sys.argv, list(sys.path), os.getcwd()
    saved_env = dict(os.environ)
    files = [tempfile.TemporaryFile() for _ in range(3)]
    try:
        files[0].write(stdin.encode() if isinstance(stdin, str) else stdin)
        files[0].seek(0)
        for fd, f in enumerate(files):
            os.dup2(f.fileno(), fd)
        sys.stdin = io.TextIOWrapper(
            io.BufferedReader(io.FileIO(0, "r", closefd=False)), encoding="utf-8"
        )
        sys.stdout, sys.stderr = (
            io.TextIOWrapper(
                io.BufferedWriter(io.FileIO(fd, "w", closefd=False)),
                encoding="utf-8",
                errors="backslashreplace" if fd == 2 else "strict",
            )
            for fd in (1, 2)
        )
        sys.argv = [script, *argv]
        sys.path.insert(0, os.path.dirname(script))
        os.chdir(cwd)
        if env is not None:
            os.environ.clear()
            os.environ.update(env)
        try:
            runpy.run_path(script, run_name="__main__")
            code = 0
        except (
            SystemExit
        ) as exc:  # the program's exit is its code, as under python3 (#5338)
            code = _exit_code(exc)
        except Exception:  # noqa: BLE001 - an escaping exception is exit 1, as under python3 (#5338)
            traceback.print_exc()
            code = 1
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.flush()
            except (
                OSError,
                ValueError,
            ):  # a stream the program closed has nothing left to flush (#5338)
                pass
    finally:
        os.environ.clear()
        os.environ.update(saved_env)
        os.chdir(saved_cwd)
        sys.argv = saved_argv
        sys.path[:] = saved_path
        sys.stdin, sys.stdout, sys.stderr = saved_streams
        for fd, saved in saved_fds.items():
            os.dup2(saved, fd)
            os.close(saved)
    out, err = files[1], files[2]
    texts = []
    for f in (out, err):
        f.seek(0)
        texts.append(f.read().decode("utf-8", "backslashreplace"))
    for f in files:
        f.close()
    return code, texts[0], texts[1]


def call_cost(
    path: str | os.PathLike,
    argv: list[str] | tuple[str, ...] = (),
    *,
    cwd: str | os.PathLike | None = None,
    env: dict[str, str] | None = None,
    stdin: str | bytes = "",
    expect_status: int = 0,
    allow_stderr: bool = False,
) -> CallCost:
    """Runs the program at `path` once in-process and returns its exit, its
    output, the repo modules it loaded and the children it started.

    `env`, where given, replaces the environment for the call; `stdin` is
    what fd 0 holds, empty by default as a spawn's closed pipe reads."""
    script = os.path.realpath(path)
    scripts_root = _scripts_root_of(script)
    call_cwd = os.path.realpath(cwd) if cwd else os.getcwd()
    purged = {name: sys.modules.pop(name) for name in _repo_modules(scripts_root)}
    children: list[str] = []
    restore = _record_starts(children, scripts_root, call_cwd)
    loaded: dict[str, str] = {}
    try:
        code, out, err = _run(script, list(argv), cwd=call_cwd, env=env, stdin=stdin)
        loaded = _repo_modules(scripts_root)
    finally:
        restore()
        for name in _repo_modules(scripts_root):
            del sys.modules[name]
        sys.modules.update(purged)
    label = os.path.relpath(script, scripts_root)
    problems = []
    if code != expect_status:
        problems.append(f"exited {code}, not {expect_status}")
    if err and not allow_stderr:
        problems.append("wrote to stderr")
    if problems:
        raise CallCostError(
            f"call_cost: {label} {' and '.join(problems)}, so this is no pin of "
            f"its common path.\n--- stderr ---\n{err}--- stdout ---\n{out}"
        )
    modules = sorted(
        {os.path.relpath(f, scripts_root) for f in loaded.values()} | {label}
    )
    return CallCost(code, out, err, modules, children)
