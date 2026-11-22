import contextlib
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
    pass


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


def _child(
    file: "str | os.PathLike[str]",
    first: "str | bytes | os.PathLike[str] | os.PathLike[bytes] | None",
    root: str,
    cwd: str,
) -> str:
    name = os.path.basename(os.fspath(file))
    if first is None:
        return name
    return f"{name} {_shown_arg(os.fsdecode(first), root, cwd)}"


def _shell_child(command: "str | bytes", root: str, cwd: str) -> str:
    tokens = [
        t[1:-1] if len(t) > 1 and t[0] == t[-1] and t[0] in "\"'" else t
        for t in os.fsdecode(command).split()
    ]
    if not tokens:
        return ""
    return _child(tokens[0], tokens[1] if len(tokens) > 1 else None, root, cwd)


def _record_starts(children: list[str], root: str, cwd: str):
    popen = subprocess.Popen
    system = os.system
    spawn = os.posix_spawn
    spawnp = os.posix_spawnp
    inside = [0]

    class RecordingPopen(subprocess.Popen):
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
    vars(subprocess)["Popen"] = RecordingPopen
    os.system = recording_system
    os.posix_spawn = recorder(spawn)
    os.posix_spawnp = recorder(spawnp)

    def restore() -> None:
        vars(subprocess)["Popen"] = popen
        os.system = system
        os.posix_spawn = spawn
        os.posix_spawnp = spawnp

    return restore


class _ExitAsPython3(contextlib.AbstractContextManager):
    code = 0

    def __exit__(self, exc_type, error, tb):
        if isinstance(error, SystemExit):
            if isinstance(error.code, int):
                self.code = error.code
            elif error.code is not None:
                print(error.code, file=sys.stderr)
                self.code = 1
            return True
        if isinstance(error, Exception):
            traceback.print_exception(error)
            self.code = 1
            return True
        return False


def _invoke(script: str) -> int:
    outcome = _ExitAsPython3()
    with outcome:
        runpy.run_path(script, run_name="__main__")
    return outcome.code


def _run(script: str, argv: list[str], *, cwd: str, env, stdin: str | bytes) -> tuple:
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
        code = _invoke(script)
        for stream in (sys.stdout, sys.stderr):
            if not stream.closed:
                stream.flush()
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
