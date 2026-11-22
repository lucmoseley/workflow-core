import functools
import glob
import json
import os
from collections import defaultdict

from fail_open import expected, fail_open, tallied
from host_root import host_root
from is_under import relative_under
from project_slug import project_slug

UNREADABLE = "unreadable files"
UNPARSED = "unparsed lines"

_DEFAULT_CONFIG_DIR_NAMES = (".claude", ".claude2", ".claude3")


def _resolved(path):
    try:
        return os.path.realpath(path, strict=True)
    except FileNotFoundError as error:
        expected(error, f"{path} absent: a seat or slug never created")
        return os.path.abspath(path)
    except OSError as error:
        fail_open(error, f"{path} deduped by its literal path")
        return os.path.abspath(path)


def seats():
    config = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    parent = os.path.dirname(config)
    knobs = [
        (
            os.environ.get(f"WFC_CLAUDE_CONFIG_{letter}") or os.path.join(parent, name),
            f"plan {letter}",
        )
        for letter, name in zip("ABC", _DEFAULT_CONFIG_DIR_NAMES, strict=True)
    ]
    labels = {}
    for d, label in knobs:
        labels.setdefault(_resolved(d), label)
    out, seen = {}, set()
    for d in [config] + [d for d, _ in knobs]:
        k = _resolved(d)
        if k in seen:
            continue
        seen.add(k)
        out[d] = labels.get(k, os.path.basename(d))
    return out


@functools.cache
def _slugs(_declared, _cwd):
    root = host_root()
    worktrees = os.path.join(root, ".claude", "worktrees")
    return project_slug(root), project_slug(worktrees) + "-"


def _repo_slugs():
    return _slugs(os.environ.get("CLAUDE_PROJECT_DIR"), os.getcwd())


def roots():
    per_seat = [roots_on(d) for d in seats()]
    out, seen = [], set()
    for p in [r[0] for r in per_seat] + [p for r in per_seat for p in r[1:]]:
        k = _resolved(p)
        if k not in seen:
            seen.add(k)
            out.append(p)
    return out


def roots_on(seat):
    main, worktree = _repo_slugs()
    projects = os.path.join(seat, "projects")
    try:
        names = sorted(os.listdir(projects))
    except FileNotFoundError as error:
        expected(error, f"{projects} absent: the seat never ran a session")
        names = []
    except OSError as error:
        fail_open(error, f"{projects} read as listing no worktree slug")
        names = []
    return [os.path.join(projects, main)] + [
        os.path.join(projects, n) for n in names if n != main and n.startswith(worktree)
    ]


def seat_of(path):
    main, worktree = _repo_slugs()
    for d, label in seats().items():
        rel = relative_under(os.path.join(d, "projects"), path)
        if not rel:
            continue
        slug = rel.split(os.sep, 1)[0]
        if slug == main or slug.startswith(worktree):
            return label
    return None


def root_files():
    return {
        r: sum(1 for _ in _files_under(r))
        for r in roots()
        if os.path.isdir(os.path.dirname(os.path.dirname(r)))
    }


def _files_under(root):
    """(path relative to root, path, is_subagent) for one root's transcripts.

    Subagent turns are NOT sidechain lines in the parent transcript, so a sweep
    of `*.jsonl` alone undercounts spend. How far:
    https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/burn-measurement-method-correction.md, re-derived at mantahostels#1121.
    """
    for p in glob.glob(os.path.join(root, "*.jsonl")):
        yield os.path.relpath(p, root), p, False
    for p in glob.glob(os.path.join(root, "*", "subagents", "agent-*.jsonl")):
        yield os.path.relpath(p, root), p, True


def transcript_files():
    seen, out = set(), []
    for root in roots():
        for rel, p, is_sub in _files_under(root):
            real = os.path.realpath(p)
            if real in seen:
                continue
            seen.add(real)
            owner = (
                os.path.basename(os.path.dirname(os.path.dirname(p)))
                if is_sub
                else os.path.basename(p)[:-6]
            )
            out.append((rel, p, is_sub, owner))
    out.sort(key=lambda t: (t[2], t[0]))
    return out


def transcripts():
    for _rel, p, is_sub, owner in transcript_files():
        yield p, is_sub, owner


def _size(path):
    try:
        return os.path.getsize(path)
    except FileNotFoundError as error:
        expected(error, f"{path} deleted since the listing")
        return -1
    except OSError as error:
        fail_open(error, f"{path} loses the largest-copy vote")
        return -1


def one_copy_each():
    groups = defaultdict(list)
    for rel, p, is_sub, owner in transcript_files():
        groups[rel].append((p, is_sub, owner))
    for copies in groups.values():
        yield max(copies, key=lambda c: _size(c[0]))


def main_transcripts():
    return sorted(p for p, is_sub, _ in one_copy_each() if not is_sub)


def all_transcripts():
    return sorted(p for p, _, _ in one_copy_each())


def files(root=None, subagents=True):
    found = (
        [(p, is_sub) for _, p, is_sub in _files_under(root)]
        if root
        else [(p, is_sub) for p, is_sub, _ in one_copy_each()]
    )
    return sorted(f for f in found if subagents or not f[1])


def records(path, tally, needle=None):
    return (rec for _line, rec in records_with_lines(path, tally, needle))


def records_with_lines(path, tally, needle=None):
    try:
        fh = open(path, encoding="utf-8", errors="replace")
    except OSError as error:
        tallied(error, tally, UNREADABLE)
        return
    with fh:
        yield from _pairs(fh, tally, needle)


def parsed(lines, tally, needle=None):
    return (rec for _line, rec in _pairs(lines, tally, needle))


def _pairs(lines, tally, needle):
    needles = (needle,) if isinstance(needle, str) else needle
    for line in lines:
        if not line.strip() or (needles and not any(n in line for n in needles)):
            continue
        try:
            rec = json.loads(line)
        except ValueError as error:
            tallied(error, tally, UNPARSED)
            continue
        if not isinstance(rec, dict):
            tally[UNPARSED] += 1
            continue
        yield line, rec


def skips(tally, *keys):
    return {k: tally[k] for k in keys or (UNREADABLE, UNPARSED)}


def counts_line(tally, *keys):
    return "(" + ", ".join(f"{k}: {v}" for k, v in skips(tally, *keys).items()) + ")"


def jlen(x):
    if x is None:
        return 0
    if isinstance(x, str):
        return len(x.encode("utf-8", "replace"))
    try:
        return len(json.dumps(x, ensure_ascii=False).encode("utf-8", "replace"))
    except (TypeError, ValueError, RecursionError) as error:
        fail_open(error, "value measured as 0 bytes")
        return 0
