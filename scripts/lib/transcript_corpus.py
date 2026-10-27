"""transcript_corpus.py — where this repo's transcripts live, across every seat: the
Python half of scripts/lib/project-dirs.js, reading the same seat set (workflow-core#379). Also
the reader and byte measure every transcript scanner shares.

The set is scripts/lib/arbiter-core.js's `sessionDirs()`: the config dir
(CLAUDE_CONFIG_DIR, else ~/.claude) first, then WFC_CLAUDE_CONFIG_A, _B and _C,
each falling back on its own to the sibling `.claude`, `.claude2` or `.claude3`,
deduped by realpath. Kept in sync by hand — a JS and a Python caller do not share
a runtime.

Each seat keeps its own sessions under its own `projects/<slug>`, a real
directory (workflow-core#375), so reading one alone drops the others'.
"""

import functools
import glob
import json
import os
from collections import defaultdict

from project_slug import slug_for_repo

# The two skip counts every transcript scanner prints (workflow-core#1274), one spelling each.
UNREADABLE = "unreadable files"
UNPARSED = "unparsed lines"

# What WFC_CLAUDE_CONFIG_A, _B and _C fall back to — arbiter-core.js's
# DEFAULT_CONFIG_DIR_NAMES.
_DEFAULT_CONFIG_DIR_NAMES = (".claude", ".claude2", ".claude3")


def _resolved(path):
    """Realpath where it resolves, the absolute literal path otherwise."""
    try:
        return os.path.realpath(path, strict=True)
    except OSError:
        # A seat dir that does not exist still dedupes by its literal path
        # (workflow-core#1274).
        return os.path.abspath(path)


def seats():
    """{config dir: label}, in arbiter-core.js's order, deduped by realpath.

    A knob's dir is labelled `plan A`, `plan B` or `plan C` after its letter; a
    CLAUDE_CONFIG_DIR that is none of them is labelled by its basename.
    """
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
def _slug(_declared, _cwd):
    """`slug_for_repo()`, once per CLAUDE_PROJECT_DIR and working directory, the
    two it reads: it runs git, and `seat_of` runs once per transcript (workflow-core#1275).
    A repo moved under an unchanged working directory keeps its old slug until
    the process ends."""
    return slug_for_repo()


def roots():
    """Every seat's projects directory for this repo, deduped by realpath —
    project-dirs.js's `projectDirs()`. Read at each call, so a test points it
    at a temp dir by CLAUDE_CONFIG_DIR and the WFC_CLAUDE_CONFIG_* knobs."""
    slug = _slug(os.environ.get("CLAUDE_PROJECT_DIR"), os.getcwd())
    out, seen = [], set()
    for d in seats():
        p = os.path.join(d, "projects", slug)
        k = _resolved(p)
        if k not in seen:
            seen.add(k)
            out.append(p)
    return out


def seat_of(path):
    """The label of the seat whose root holds `path`, or None."""
    labels = {_resolved(d): lab for d, lab in seats().items()}
    for root in roots():
        if path.startswith(root.rstrip(os.sep) + os.sep):
            seat = os.path.dirname(os.path.dirname(root))
            return labels.get(_resolved(seat), os.path.basename(seat))
    return None


def root_files():
    """{root: transcript file count} for every root whose seat exists, one
    with no directory for this repo reading 0."""
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
    """(relpath, path, is_subagent, owning_session_id), ordered so every copy
    of one relpath is adjacent.

    A root reached twice — one seat's slug symlinked to another's — is read
    once, deduplicated on realpath. The same relpath under two real roots is
    one session's transcript on two seats, and a caller merges those by
    keying on the relpath — `transcripts()`, which drops it, yields both.
    """
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
    """(path, is_subagent, owning_session_id) for every transcript, every
    seat root included."""
    for _rel, p, is_sub, owner in transcript_files():
        yield p, is_sub, owner


def _size(path):
    try:
        return os.path.getsize(path)
    except OSError:
        # A copy gone since the listing loses the largest-copy vote; the
        # scanner opening it counts the failure (workflow-core#1274).
        return -1


def one_copy_each():
    """`transcripts()`, but one copy per relpath — the largest, which holds the
    most of that session. For a scanner that tallies whole files, where a
    session on two seats would otherwise count twice."""
    groups = defaultdict(list)
    for rel, p, is_sub, owner in transcript_files():
        groups[rel].append((p, is_sub, owner))
    for copies in groups.values():
        yield max(copies, key=lambda c: _size(c[0]))


def main_transcripts():
    """Every seat root's main-session transcripts, one copy each, sorted."""
    return sorted(p for p, is_sub, _ in one_copy_each() if not is_sub)


def all_transcripts():
    """Every seat root's transcripts, main and subagent, one copy each, sorted."""
    return sorted(p for p, _, _ in one_copy_each())


def files(root=None, subagents=True):
    """(path, is_subagent), sorted: under `root` alone, or every seat root's,
    one copy each, where it is None. For a scanner taking a one-directory flag."""
    found = (
        [(p, is_sub) for _, p, is_sub in _files_under(root)]
        if root
        else [(p, is_sub) for p, is_sub, _ in one_copy_each()]
    )
    return sorted(f for f in found if subagents or not f[1])


def records(path, tally, needle=None):
    """Each JSON object in the transcript at `path`, in order. A line holding
    none of `needle` (a string or a tuple of them) is passed over unparsed. Its
    skips are counted as `records_with_lines` counts them."""
    return (rec for _line, rec in records_with_lines(path, tally, needle))


def records_with_lines(path, tally, needle=None):
    """`records`, each paired with its line as written: (line, record).

    A file that will not open counts `tally[UNREADABLE]` and yields nothing; a
    line that is not a JSON object counts `tally[UNPARSED]`, a blank one
    nothing. Counted, never fatal: one bad transcript must not sink the corpus,
    and the caller prints the counts (workflow-core#1274). `tally` is the caller's
    accumulator, its own Counter, so nothing carries over between runs (workflow-core#1290).
    """
    try:
        fh = open(path, encoding="utf-8", errors="replace")
    except OSError:
        tally[UNREADABLE] += 1
        return
    with fh:
        yield from _pairs(fh, tally, needle)


def parsed(lines, tally, needle=None):
    """`records` over lines already in hand."""
    return (rec for _line, rec in _pairs(lines, tally, needle))


def _pairs(lines, tally, needle):
    """(line, record) for each JSON-object line. `tally` is the caller's
    accumulator: the skips are counted into it (workflow-core#1274)."""
    needles = (needle,) if isinstance(needle, str) else needle
    for line in lines:
        if needles and not any(n in line for n in needles):
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            if line.strip():
                tally[UNPARSED] += 1
            continue
        if not isinstance(rec, dict):
            tally[UNPARSED] += 1
            continue
        yield line, rec


def skips(tally, *keys):
    """{key: count} for `keys`, in order, zeros included — the two skip counts
    where none are named. What a `--json` output carries."""
    return {k: tally[k] for k in keys or (UNREADABLE, UNPARSED)}


def counts_line(tally, *keys):
    """`skips()` as the line a scanner prints."""
    return "(" + ", ".join(f"{k}: {v}" for k, v in skips(tally, *keys).items()) + ")"


def jlen(x):
    """Byte length of a transcript value as it sits in the prompt: a str measured
    directly, anything else as the JSON the transcript holds it as."""
    if x is None:
        return 0
    if isinstance(x, str):
        return len(x.encode("utf-8", "replace"))
    try:
        return len(json.dumps(x, ensure_ascii=False).encode("utf-8", "replace"))
    except (TypeError, ValueError, RecursionError):
        # A value json.loads produced always dumps; 0 keeps a caller passing
        # anything else from sinking the run (workflow-core#1274).
        return 0
