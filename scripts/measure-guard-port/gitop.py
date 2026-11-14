"""gitop.py — the git operations bench.py's paired gate times in place of a
hook set (#5207): a throwaway repo per side whose hooks are that side's
`.husky`, one timed operation per call, and an untimed reset back to the same
state after it.

Git reaches a `.husky` hook only through husky's dispatch directory: its
`pre-commit`, `commit-msg`, `prepare-commit-msg` and `pre-merge-commit` are not
executable, so `core.hooksPath` names a per-side copy of husky's `_/` whose
shim runs `sh -e <side>/.husky/<hook>`, as the host's own `.husky/_` does.

The fixture is built with its hooks off, on `main` in a main work tree (the
pre-commit branch pin's case), with a repo-local identity, and carries no
`.claude/workflow-core.json`, so the adopter's declared commands, identical on
both sides, stay out of the read. Every git command the bench itself runs, the
reset included, runs with hooks off.
"""

from __future__ import annotations

import json
import os
import resource
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from host_root import host_root

IDENTITY = {
    "GIT_AUTHOR_NAME": "bench",
    "GIT_AUTHOR_EMAIL": "bench@example.invalid",
    "GIT_COMMITTER_NAME": "bench",
    "GIT_COMMITTER_EMAIL": "bench@example.invalid",
}
# Gitleaks' github-pat rule refuses it; nothing accepts it (#5207).
# Joined at run time, so this file carries no token for the scan to find.
FAKE_SECRET = "ghp" + "_Z7VdR3InO7QbjVXdxBpX3E07M9bf82SZZ1iQ"
# Reported beside the gated shapes, never gated (#5207 §Latency gate).
UNGATED = {"am-refused"}
SHAPES = ("commit", "merge", "cherry-pick", "rebase", "am", "am-refused")
# The env a call must not inherit: a live session's records, and a git
# location that would point the operation elsewhere.
DROPPED = ("CLAUDE_CODE_SESSION_ID", "GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE")
DROPPED_PREFIX = ("HUSKY", "GIT_CONFIG_")
# The hooks husky 9 writes a shim for (husky's index.js).
HUSKY_HOOKS = (
    "applypatch-msg",
    "commit-msg",
    "post-applypatch",
    "post-checkout",
    "post-commit",
    "post-merge",
    "post-rewrite",
    "pre-applypatch",
    "pre-auto-gc",
    "pre-commit",
    "pre-merge-commit",
    "pre-push",
    "pre-rebase",
    "prepare-commit-msg",
)
# husky's own lookup in its `h` shim: the hook beside the `_/` directory.
HUSKY_LOOKUP = 's=$(dirname "$(dirname "$0")")/$n'


def git(repo: str, *args: str, env: dict | None = None) -> str:
    """A bench-side git command: hooks off, its failure raised."""
    done = subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", *args],
        cwd=repo,
        env=env if env is not None else bare_env(),
        capture_output=True,
        text=True,
    )
    if done.returncode:
        raise RuntimeError(f"git {' '.join(args)}: {done.stderr.strip()}")
    return done.stdout.strip()


def bare_env() -> dict:
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in DROPPED and not k.startswith(DROPPED_PREFIX)
    }
    return {**env, **IDENTITY}


def call_env(side_root: str, repo: str) -> dict:
    """A timed call's env: the side's scripts, the fixture as the project."""
    return {**bare_env(), "WFC_PLUGIN_ROOT": side_root, "CLAUDE_PROJECT_DIR": repo}


def husky_template(side_root: str) -> str:
    """husky's `h` shim as installed: the side's, else the bench's own
    checkout's, the same package version either way in practice."""
    for root in (Path(side_root), Path(host_root())):
        shim = root / "node_modules" / "husky" / "husky"
        if shim.is_file():
            return shim.read_text()
    raise FileNotFoundError("node_modules/husky/husky: npm install first")


def husky_dispatch(side_root: str, out: str) -> str:
    """husky's `_/` dispatch directory, its lookup pinned to the side's
    `.husky`, at `out`."""
    body = husky_template(side_root)
    if HUSKY_LOOKUP not in body:
        raise ValueError("husky's h shim no longer carries its lookup line")
    pinned = 's="' + os.path.join(side_root, ".husky") + '/$n"'
    os.makedirs(out)
    Path(out, "h").write_text(body.replace(HUSKY_LOOKUP, pinned))
    for name in HUSKY_HOOKS:
        f = Path(out, name)
        f.write_text('#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n')
        f.chmod(0o755)
    return out


def write(repo: str, name: str, text: str) -> None:
    Path(repo, name).write_text(text)


def commit_all(repo: str, msg: str) -> str:
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", msg)
    return git(repo, "rev-parse", "HEAD")


class Fixture:
    """One side's throwaway repo, and the state each shape starts from."""

    def __init__(self, parent: str, side_root: str, shape: str):
        if shape not in SHAPES:
            raise ValueError(shape)
        self.side_root, self.shape = side_root, shape
        self.husky = os.path.join(side_root, ".husky")
        top = Path(parent)
        self.hooks = husky_dispatch(side_root, str(top / "husky" / "_"))
        self.repo = str(top / "repo")
        os.mkdir(self.repo)
        r = self.repo
        git(r, "init", "-q", "-b", "main")
        git(r, "config", "user.name", IDENTITY["GIT_AUTHOR_NAME"])
        git(r, "config", "user.email", IDENTITY["GIT_AUTHOR_EMAIL"])
        git(r, "config", "commit.gpgsign", "false")
        for name in ("a.txt", "b.txt", "c.txt"):
            write(r, name, f"{name} line one\n{name} line two\n")
        base = commit_all(r, "Add the bench files")
        git(r, "checkout", "-q", "-b", "side")
        write(r, "b.txt", "b.txt line one\nb.txt changed on side\n")
        side = commit_all(r, "Change b.txt on the side branch")
        git(r, "checkout", "-q", "-B", "topic", base)
        write(r, "c.txt", "c.txt line one\nc.txt changed on topic\n")
        topic = commit_all(r, "Change c.txt on the topic branch")
        self.patch = str(top / "one.patch")
        Path(self.patch).write_text(
            git(r, "format-patch", "-1", "--stdout", side) + "\n"
        )
        git(r, "checkout", "-q", "-B", "secret", base)
        write(r, "creds.txt", f'token = "{FAKE_SECRET}"\n')
        leak = commit_all(r, "Add the bench credentials file")
        self.leak_patch = str(top / "leak.patch")
        Path(self.leak_patch).write_text(
            git(r, "format-patch", "-1", "--stdout", leak) + "\n"
        )
        git(r, "checkout", "-q", "main")
        self.start = topic if shape == "rebase" else base
        self.command = {
            "commit": ["commit", "-q", "-m", "Change a.txt for the bench"],
            "merge": ["merge", "-q", "--no-ff", "-m", "Merge the side branch", "side"],
            "cherry-pick": ["cherry-pick", side],
            "rebase": ["rebase", "-q", "side"],
            "am": ["am", "-q", self.patch],
            "am-refused": ["am", "-q", self.leak_patch],
        }[shape]
        self.gitdir = git(r, "rev-parse", "--absolute-git-dir")
        self.use_hooks(self.hooks)
        self.reset_tree()
        self.gitdir_entries = set(os.listdir(self.gitdir))
        self.env = call_env(side_root, r)

    def use_hooks(self, hooks: str) -> None:
        git(self.repo, "config", "core.hooksPath", hooks)

    def reset_tree(self) -> None:
        """Back to the shape's start: no operation in progress, `main` at the
        start commit, a clean tree, and the commit shape's change staged."""
        g = self.gitdir
        for state in ("rebase-apply", "rebase-merge", "sequencer"):
            shutil.rmtree(os.path.join(g, state), ignore_errors=True)
        r = self.repo
        git(r, "symbolic-ref", "HEAD", "refs/heads/main")
        git(r, "update-ref", "refs/heads/main", self.start)
        git(r, "reset", "-q", "--hard", self.start)
        git(r, "clean", "-q", "-fdx")
        if self.shape == "commit":
            write(r, "a.txt", "a.txt line one\na.txt changed by the bench\n")
            git(r, "add", "a.txt")

    def reset(self) -> None:
        self.reset_tree()
        # What a hook or the operation left in the git dir: a stamp,
        # ORIG_HEAD, MERGE_HEAD, a stopped operation's heads.
        for name in set(os.listdir(self.gitdir)) - self.gitdir_entries:
            p = os.path.join(self.gitdir, name)
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p, ignore_errors=True)
            else:
                os.unlink(p)

    def state(self) -> tuple[str, str, str]:
        """HEAD, its symbolic name, and the porcelain status: what a reset
        must return to."""
        r = self.repo
        return (
            git(r, "rev-parse", "HEAD"),
            git(r, "symbolic-ref", "HEAD"),
            git(r, "status", "--porcelain"),
        )


def timed_call(fx: Fixture, reap) -> dict:
    """One operation, timed with every hook it fires, then the reset."""
    r0 = resource.getrusage(resource.RUSAGE_CHILDREN)
    t0 = time.monotonic()
    done = subprocess.run(
        ["git", *fx.command],
        cwd=fx.repo,
        env=fx.env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
    )
    t1 = time.monotonic()
    detached = reap()
    r1 = resource.getrusage(resource.RUSAGE_CHILDREN)
    fx.reset()
    return {
        "wall": (t1 - t0) * 1000,
        "cpu": (r1.ru_utime - r0.ru_utime + r1.ru_stime - r0.ru_stime) * 1000,
        "sys": (r1.ru_stime - r0.ru_stime) * 1000,
        "minflt": r1.ru_minflt - r0.ru_minflt,
        "denies": int(done.returncode != 0),
        "exit": done.returncode,
        "detached": detached,
        # The tail a refused pair reports: a guess, stated as one, at room for a
        # hook's last few lines, where its refusal says why; a refusal cut short
        # in a real run would refine it.
        "stderr": done.stderr[-400:].decode(errors="replace"),
    }


WRAPPER = """#!{python}
import json, os, resource, subprocess, sys
real = {real!r}
done = subprocess.run([real, *sys.argv[1:]])
ru = resource.getrusage(resource.RUSAGE_CHILDREN)
with open({log!r}, "a") as fh:
    fh.write(json.dumps({{"hook": {name!r}, "exit": done.returncode,
        "cpu": (ru.ru_utime + ru.ru_stime) * 1000}}) + "\\n")
sys.exit(done.returncode)
"""


def write_wrappers(dispatch: str, husky: str, out: str, log: str) -> list[str]:
    """A wrapper per `dispatch` shim whose hook `husky` holds: it runs the
    shim, and so the hook, as its child on the same argv and stdin, appends
    that child's CPU to `log`, and exits with the hook's code."""
    os.makedirs(out, exist_ok=True)
    names = []
    for entry in sorted(os.listdir(dispatch)):
        real = os.path.join(dispatch, entry)
        if entry == "h" or not os.path.isfile(os.path.join(husky, entry)):
            continue
        w = Path(out, entry)
        w.write_text(
            WRAPPER.format(python=sys.executable, real=real, log=log, name=entry)
        )
        w.chmod(0o755)
        names.append(entry)
    return names


def hook_cpu(fx: Fixture, calls: int, workdir: str, reap) -> dict:
    """The median CPU each hook spends per call, read through the wrappers
    after the gated pairs so they never perturb them."""
    log = os.path.join(workdir, "hook-cpu.jsonl")
    write_wrappers(fx.hooks, fx.husky, os.path.join(workdir, "wrapped"), log)
    fx.use_hooks(os.path.join(workdir, "wrapped"))
    per_call: list[dict[str, float]] = []
    try:
        for _ in range(calls):
            Path(log).write_text("")
            timed_call(fx, reap)
            seen: dict[str, float] = {}
            for line in Path(log).read_text().splitlines():
                row = json.loads(line)
                seen[row["hook"]] = seen.get(row["hook"], 0) + row["cpu"]
            per_call.append(seen)
    finally:
        fx.use_hooks(fx.hooks)
    names = sorted({h for c in per_call for h in c})
    return {
        h: round(statistics.median(c[h] for c in per_call if h in c)) for h in names
    }
