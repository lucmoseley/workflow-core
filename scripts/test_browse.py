"""Tests for scripts/browse.py — the browser helper every adopter repo gets (#133).

WHAT IS AND IS NOT EXERCISED HERE. Every test below hands `main` its own
`render`, so no test in this file launches Chromium or reaches the network.

What that leaves unguarded is the Playwright call itself — the user-agent
actually reaching the server, `wait_until="load"`, the selector wait, and
`--tiles`' page-size reads, image read and clipped screenshots. Check those by
hand against a live page when `render` changes.

What IS guarded is everything a caller gets wrong: the argument shapes, the
tile arithmetic, and the exits a session has to tell apart — a bad argument, an
absent Playwright, a page that did not arrive in time, a refused page, and a
page that does not show at real size.

`browse.py` is rung 2 of the `browser-ladder` skill: loosen a case and a session
reads a missing Playwright or a slow page as a site that cannot be reached, and
climbs the ladder or gives up for the wrong reason.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import browse


def test_defaults_do_not_advertise_headless():
    """The default UA is the whole reason a probe against a Cloudflare-fronted
    site works at all."""
    at = browse.parse(["text", "https://example.com"])
    assert "HeadlessChrome" not in at.ua
    assert "Chrome/" in at.ua


def test_parses_viewport_into_playwright_shape():
    at = browse.parse(
        ["shot", "https://x.test", "--out", "s.png", "--viewport", "800x600"]
    )
    assert at.viewport_size == {"width": 800, "height": 600}


def test_viewport_default_is_a_desktop_size():
    at = browse.parse(["text", "https://x.test"])
    assert at.viewport_size == {"width": 1280, "height": 800}


@pytest.mark.parametrize("bad", ["nope", "800", "800x", "x600", "800*600"])
def test_refuses_a_viewport_that_is_not_wxh(bad):
    with pytest.raises(SystemExit) as exc:
        browse.parse(["text", "https://x.test", "--viewport", bad])
    assert exc.value.code == 2


def test_refuses_a_shot_with_nowhere_to_write_it():
    with pytest.raises(SystemExit) as exc:
        browse.parse(["shot", "https://x.test"])
    assert exc.value.code == 2


def test_text_and_html_need_no_out():
    """Only `shot` requires --out; the other two default to stdout, which is how
    a session reads a page without leaving a file behind."""
    at = browse.parse(["text", "https://x.test"])
    assert at.out is None


def test_names_the_install_command_when_playwright_is_absent(capsys):
    """Exit 3 and the pip line. A session that gets this must not conclude the
    machine cannot browse — it concludes the package is missing."""
    assert (
        browse.main(["text", "https://x.test"], render=_raise(ImportError("no module")))
        == 3
    )
    err = capsys.readouterr().err
    assert "python3 -m pip install playwright" in err
    assert "python3 -m playwright install chromium" in err


def test_an_undownloaded_browser_gets_the_install_hint_too(capsys):
    """Exit 3 as well, and the reason it is not its own code: `import
    playwright` succeeding proves nothing about the browser, and the caller's
    next move is the same install block either way."""
    assert (
        browse.main(
            ["text", "https://x.test"],
            render=_raise(browse.NoBrowserError("no chromium")),
        )
        == 3
    )
    err = capsys.readouterr().err
    assert "no chromium" in err
    assert "python3 -m playwright install chromium" in err


def test_a_refused_page_exits_5_naming_the_reason_the_host_and_a_next_step(capsys):
    """Exit 5, so a caller can tell a dead host from a broken script, and a
    next step, so it does not stop at the refusal."""
    assert (
        browse.main(
            ["text", "https://nonexistent.invalid"],
            render=_raise(browse.RefusedError("DNS lookup failed")),
        )
        == 5
    )
    err = capsys.readouterr().err
    assert "DNS lookup failed" in err
    assert "nonexistent.invalid" in err
    assert "Check the URL and that this machine is online" in err


def test_reports_a_timeout_separately_from_a_bad_argument(capsys):
    assert (
        browse.main(
            ["text", "https://x.test", "--timeout", "1500"],
            render=_raise(browse.PageTimeoutError("nav timeout")),
        )
        == 4
    )
    err = capsys.readouterr().err
    assert "1500ms" in err
    assert "--wait SELECTOR" in err


def test_prints_the_body_to_stdout(capsys):
    assert (
        browse.main(["text", "https://x.test"], render=lambda at: "the page text") == 0
    )
    out = capsys.readouterr()
    assert out.out.strip() == "the page text"


def test_writes_the_body_to_out_and_says_so_on_stderr(capsys, tmp_path):
    """The path goes to stderr, never stdout: a caller piping `text` into a file
    would otherwise find the filename inside the page."""
    at = tmp_path / "page.txt"
    assert (
        browse.main(
            ["text", "https://x.test", "--out", str(at)],
            render=lambda at: "the page text",
        )
        == 0
    )
    assert at.read_text(encoding="utf8") == "the page text"
    out = capsys.readouterr()
    assert out.out == ""
    assert str(at) in out.err


def test_a_shot_reports_its_path_without_a_body(capsys, tmp_path):
    """`render` returns a Shot, having written the file itself."""
    at = tmp_path / "s.png"
    assert (
        browse.main(
            ["shot", "https://x.test", "--out", str(at)],
            render=lambda at: browse.Shot([str(at.out)], []),
        )
        == 0
    )
    out = capsys.readouterr()
    assert out.out == ""
    assert str(at) in out.err


def test_a_shot_with_real_size_faults_exits_6_naming_each(capsys):
    """A shrunk frame and sideways scrolling are the rendering faults a script
    can see for itself, so they are an exit rather than left to the eye (#2753)."""
    assert (
        browse.main(
            ["shot", "https://x.test", "--out", "s.png", "--tiles"],
            render=lambda at: browse.Shot(["s-1.png"], ["frame.png is drawn"]),
        )
        == 6
    )
    err = capsys.readouterr().err
    assert "frame.png is drawn" in err
    assert "max-width: none" in err


def test_real_size_faults_name_the_overflow_and_each_shrunk_image():
    faults = browse.real_size_faults(1606, 1366, [["a.png", 1300, 1606]])
    assert "1606px wide in a 1366px viewport" in faults[0]
    assert faults[1] == "a.png is drawn 1300px wide, below its own 1606px."


def test_a_page_at_real_size_has_no_faults():
    assert browse.real_size_faults(1366, 1366, []) == []


def test_tiles_cover_the_page_one_viewport_height_each():
    assert browse.tile_clips(2000, {"width": 1366, "height": 768}) == [
        {"x": 0, "y": 0, "width": 1366, "height": 768},
        {"x": 0, "y": 768, "width": 1366, "height": 768},
        {"x": 0, "y": 1536, "width": 1366, "height": 464},
    ]


def test_tiles_are_numbered_beside_out():
    assert browse.tile_paths("shots/page.png", 2) == [
        "shots/page-1.png",
        "shots/page-2.png",
    ]


def test_refuses_tiles_with_full_page():
    with pytest.raises(SystemExit) as exc:
        browse.parse(
            ["shot", "https://x.test", "--out", "s.png", "--tiles", "--full-page"]
        )
    assert exc.value.code == 2


def _raise(exc):
    def raiser(at):
        raise exc

    return raiser
