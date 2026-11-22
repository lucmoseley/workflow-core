import importlib.metadata
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
DIRECT = ROOT / "requirements-dev.in"
COMPILED = ROOT / "requirements-dev.txt"

_NAME_END = re.compile(r"[<>=!~;\[\s]")
_CONTINUATION = re.compile(r"\\\n")
_OPTIONS = re.compile(r"\s--")
_VALID_VERSION = re.compile(r"^\d+(?:!\d+)?(?:\.\d+)*[A-Za-z0-9.\-_+]*$")


def _parse(text):
    out = []
    for raw in _CONTINUATION.sub(" ", text).splitlines():
        line = _OPTIONS.split(raw.split("#", 1)[0], 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        line = line.split(";", 1)[0].strip()
        name = _NAME_END.split(line, 1)[0].strip()
        spec = line[len(name) :].strip()
        if spec.startswith("["):
            spec = spec.split("]", 1)[1].strip() if "]" in spec else ""
        out.append((name, spec))
    return out


def _canonical(name):
    """The PEP 503 spelling pip-compile writes: `pytest_xdist` as `pytest-xdist`."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _pin_version(spec):
    if not spec.startswith("=="):
        return None
    version = spec[2:].strip()
    if "," in version or not _VALID_VERSION.match(version):
        return None
    return version


def _requirements(path):
    return _parse(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "line,expected",
    [
        ("example==1.2.3", [("example", "==1.2.3")]),
        ("example==1.2.3  # pinned", [("example", "==1.2.3")]),
        ('example==1.2.3 ; python_version >= "3.11"', [("example", "==1.2.3")]),
        ("example[testing]==1.2.3", [("example", "==1.2.3")]),
        ("example >= 1, < 2", [("example", ">= 1, < 2")]),
        ("first==1.0\nsecond==2.0", [("first", "==1.0"), ("second", "==2.0")]),
        ("# a comment", []),
        ("", []),
        ("-r other.txt", []),
        ("--hash=sha256:abc", []),
        (
            "example==1.2.3 \\\n    --hash=sha256:abc \\\n    --hash=sha256:def\n"
            "    # via -r requirements-dev.in",
            [("example", "==1.2.3")],
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


def test_the_files_declare_requirements_at_all():
    assert _requirements(DIRECT)
    assert len(_requirements(COMPILED)) >= len(_requirements(DIRECT))


@pytest.mark.parametrize(
    "name,spec", _requirements(DIRECT) + _requirements(COMPILED), ids=lambda v: v or "-"
)
def test_every_requirement_is_an_exact_pin(name, spec):
    assert _pin_version(spec) is not None, (
        f"{name} is declared as {spec!r}, which is not an exact `==` pin"
    )


@pytest.mark.parametrize("name,spec", _requirements(DIRECT), ids=lambda v: v or "-")
def test_the_compiled_file_carries_each_direct_pin(name, spec):
    compiled = {_canonical(n): s for n, s in _requirements(COMPILED)}
    assert compiled.get(_canonical(name)) == spec, (
        f"requirements-dev.in pins {name}{spec} but requirements-dev.txt has "
        f"{compiled.get(_canonical(name))!r}: recompile with the command in "
        f"requirements-dev.in's header"
    )


@pytest.mark.parametrize("name,spec", _requirements(COMPILED), ids=lambda v: v or "-")
def test_the_pin_is_what_is_installed(name, spec):
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
