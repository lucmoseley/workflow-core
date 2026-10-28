"""Tests for scripts/lib/project_slug.py — the Python mirror of
scripts/lib/project-slug.js's slug rule (mantahostels#2148).

Pins the same guarantee project-slug.test.ts pins on the JS side: every
non-alphanumeric character becomes its own hyphen, case preserved, and the
two languages agree on this checkout's own slug.

The agreement case runs the JS sibling through `node` in this checkout rather
than restating its rule, so a change to either side fails here. Loosen it and
`transcript_corpus.py`'s scanners look for this repo's transcripts under a slug
Claude Code never wrote, and report a near-empty corpus as if it were real.
"""

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from project_slug import project_slug, slug_for_repo

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_maps_a_dot_to_a_hyphen_not_only_the_slashes():
    assert project_slug("/home/lucmo/.claude3/jobs/12fb6c3a/tmp") == (
        "-home-lucmo--claude3-jobs-12fb6c3a-tmp"
    )


def test_the_slug_keeps_each_letters_case():
    assert project_slug("/tmp/armA") == "-tmp-armA"


def test_one_hyphen_per_character_never_one_per_run():
    assert project_slug("/a..b") == "-a--b"


def test_slug_for_repo_names_this_checkout(monkeypatch):
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(REPO_ROOT))
    assert slug_for_repo() == project_slug(str(REPO_ROOT))


def test_agrees_with_the_js_sibling(monkeypatch):
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(REPO_ROOT))
    got = subprocess.run(
        ["node", "-e", "console.log(require('./project-slug.js').slugForRepo())"],
        cwd=REPO_ROOT / "scripts" / "lib",
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert slug_for_repo() == got
