"""`requirements-dev.in` pins each direct dependency exactly, `requirements-dev.txt`
compiles those pins with every transitive one, and those pins are what is installed.

WHY THIS TEST EXISTS. The Python dependencies were declared as open ranges
(`pytest>=8,<10`, `numpy>=2.4`, ...) with no lockfile, so a fresh install and this
laptop could resolve to different versions, and a supply-chain advisory scan had
nothing to match against (mantahostels#930). The compiled file carries a hash for
every pin, so CI installs in pip's hash-checking mode (#3363).

WHY A requirements*.txt AND NOT A uv.lock. Settled at mantahostels#930. The auditor
credits a version as resolved only when `version_source` is `lockfile` or
`manifest-pin`; the sole Python lockfile it parses is `uv.lock`, and `uv` is not
installed on this machine; it globs `requirements*.txt` and does *not* follow `-r` or
`-c` includes. A compiled `requirements-dev.txt` is read by the auditor and
installed by the unchanged `python3 -m pip install -r requirements-dev.txt`.

WHAT WOULD BREAK IT. Adding a dependency as a range, loosening a pin back to `>=`,
editing a pin in the .in without recompiling, or bumping a pin without reinstalling.
Loosen this test and those land unseen: a fresh install and this laptop resolve
different versions again, and the supply-chain audit credits none as resolved, so an
advisory against the installed version goes unmatched. This test fails CI's python
job when red.

`_parse` and `_pin_version` take their input as arguments so the rejection branches
are reachable from a table of spellings these files do not contain — extras,
environment markers, wildcard pins. Asserting only against today's well-formed
lines would leave the branches doing the policing unexercised.
"""

import importlib.metadata
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
DIRECT = ROOT / "requirements-dev.in"
COMPILED = ROOT / "requirements-dev.txt"

_NAME_END = re.compile(r"[<>=!~;\[\s]")
# A backslash-newline continues a requirement onto the next line, and a ` --`
# opens its per-requirement options (`--hash`).
_CONTINUATION = re.compile(r"\\\n")
_OPTIONS = re.compile(r"\s--")
# What counts as an exact version. Mirrors the auditor's own rule that `1.0.*` is a
# range and not a pin, and admits a PEP 440 epoch (`1!2.0`).
_VALID_VERSION = re.compile(r"^\d+(?:!\d+)?(?:\.\d+)*[A-Za-z0-9.\-_+]*$")


def _parse(text):
    """(name, specifier) for every requirement in `text`, in order.

    Comments, blank lines, pip options (`-r`, `-c`) and a requirement's own options
    (`--hash`) are dropped, continuation lines joined first. An environment marker
    qualifies the requirement rather than the version, and an extras group is part
    of the name's spelling rather than the specifier, so both are stripped before
    the specifier is read.

    Deliberately not a PEP 508 parser: it splits on the first `#`, so a URL
    fragment would be mangled.
    """
    out = []
    for raw in _CONTINUATION.sub(" ", text).splitlines():
        line = _OPTIONS.split(raw.split("#", 1)[0], 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        line = line.split(";", 1)[0].strip()
        name = _NAME_END.split(line, 1)[0].strip()
        spec = line[len(name) :].strip()
        if spec.startswith("["):
            # A malformed extras group leaves an empty specifier, which fails the
            # pin assertion below rather than passing as an unrecognised shape.
            spec = spec.split("]", 1)[1].strip() if "]" in spec else ""
        out.append((name, spec))
    return out


def _canonical(name):
    """The PEP 503 spelling pip-compile writes: `et_xmlfile` as `et-xmlfile`."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _pin_version(spec):
    """The exact version `spec` pins, or None when `spec` is not an exact pin."""
    if not spec.startswith("=="):
        return None
    version = spec[2:].strip()
    if "," in version or not _VALID_VERSION.match(version):
        return None
    return version


def _requirements(path):
    return _parse(path.read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- #
# the parser, against spellings the file does not currently contain
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "line,expected",
    [
        ("numpy==2.4.6", [("numpy", "==2.4.6")]),
        ("numpy==2.4.6  # pinned", [("numpy", "==2.4.6")]),
        ('numpy==2.4.6 ; python_version >= "3.11"', [("numpy", "==2.4.6")]),
        ("pytest[testing]==9.1.1", [("pytest", "==9.1.1")]),
        ("pytest >= 8, < 10", [("pytest", ">= 8, < 10")]),
        ("# a comment", []),
        ("", []),
        ("-r other.txt", []),
        ("--hash=sha256:abc", []),
        (
            "ruff==0.16.4 \\\n    --hash=sha256:abc \\\n    --hash=sha256:def\n"
            "    # via -r requirements-dev.in",
            [("ruff", "==0.16.4")],
        ),
    ],
)
def test_parse_reads_each_requirement_spelling(line, expected):
    assert _parse(line) == expected


@pytest.mark.parametrize(
    "spec,expected",
    [
        ("==2.4.6", "2.4.6"),
        ("==1!2.0", "1!2.0"),
        ("==2.4.6rc1", "2.4.6rc1"),
        (">=2.4", None),
        ("==2.4.*", None),
        (">=2.4,==2.4.6", None),
        ("==2.4.6,!=2.4.5", None),
        ("", None),
    ],
)
def test_pin_version_accepts_only_an_exact_pin(spec, expected):
    assert _pin_version(spec) == expected


# --------------------------------------------------------------------------- #
# the file itself
# --------------------------------------------------------------------------- #


def test_the_files_declare_requirements_at_all():
    """Guards every assertion below against passing vacuously on an empty parse."""
    assert len(_requirements(DIRECT)) >= 5
    assert len(_requirements(COMPILED)) >= len(_requirements(DIRECT))


@pytest.mark.parametrize(
    "name,spec", _requirements(DIRECT) + _requirements(COMPILED), ids=lambda v: v or "-"
)
def test_every_requirement_is_an_exact_pin(name, spec):
    """No ranges."""
    assert _pin_version(spec) is not None, (
        f"{name} is declared as {spec!r}, which is not an exact `==` pin"
    )


@pytest.mark.parametrize("name,spec", _requirements(DIRECT), ids=lambda v: v or "-")
def test_the_compiled_file_carries_each_direct_pin(name, spec):
    """An edit to the .in that was never recompiled — the drift between the two."""
    compiled = {_canonical(n): s for n, s in _requirements(COMPILED)}
    assert compiled.get(_canonical(name)) == spec, (
        f"requirements-dev.in pins {name}{spec} but requirements-dev.txt has "
        f"{compiled.get(_canonical(name))!r}: recompile with the command in "
        f"requirements-dev.in's header"
    )


@pytest.mark.parametrize("name,spec", _requirements(COMPILED), ids=lambda v: v or "-")
def test_the_pin_is_what_is_installed(name, spec):
    """The pinned version is the one importable here — the drift check.

    Skipped rather than failed when the package is absent, so the file can be read
    on a machine that has never installed it.
    """
    pinned = _pin_version(spec)
    if pinned is None:
        pytest.skip(
            "not a pin; test_every_requirement_is_an_exact_pin owns that failure"
        )
    try:
        installed = importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        pytest.skip(f"{name} is not installed here")
    assert installed == pinned, (
        f"{name} pins {pinned} but {installed} is installed — "
        f"reinstall with the command in requirements-dev.in's header"
    )
