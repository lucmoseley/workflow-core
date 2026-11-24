#!/usr/bin/env python3

import argparse
import sys
from pathlib import Path
from typing import NamedTuple

DEFAULT_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)

INSTALL_HINT = (
    "On this machine Playwright is the Python package under miniforge,\n"
    "installed once per machine rather than per repo:\n"
    "    python3 -m pip install --only-binary :all: playwright\n"
    "    python3 -m playwright install chromium"
)


def first_line(exc):
    for line in str(exc).splitlines():
        if line.strip():
            return line.strip()
    return exc.__class__.__name__


def parse(argv):
    p = argparse.ArgumentParser(
        prog="browse.py",
        description="Render one URL with a real browser and print or capture it.",
        epilog="exits: 0 rendered, 2 bad arguments, 3 Playwright or its browser "
        "missing, 4 the page did not render in time, 5 the browser refused the "
        "page, 6 --tiles rendered but the page does not show at real size.",
    )
    p.add_argument("mode", choices=("text", "html", "shot"))
    p.add_argument("url")
    p.add_argument(
        "--wait",
        metavar="SELECTOR",
        help="CSS selector to wait for before capturing — the reliable signal "
        "that a fetch-rendered page has actually arrived.",
    )
    p.add_argument(
        "--settle",
        type=int,
        default=0,
        metavar="MS",
        help="Extra milliseconds to wait after load. Use --wait where you can "
        "name a selector; this is the fallback when you cannot.",
    )
    p.add_argument("--timeout", type=int, default=30000, metavar="MS")
    p.add_argument("--ua", default=DEFAULT_UA, metavar="STRING")
    p.add_argument("--out", metavar="PATH", help="Required for `shot`.")
    shape = p.add_mutually_exclusive_group()
    shape.add_argument("--full-page", action="store_true")
    shape.add_argument(
        "--tiles",
        action="store_true",
        help="One PNG per viewport height, <out>-1.png onward.",
    )
    p.add_argument("--viewport", default="1280x800", metavar="WxH")
    at = p.parse_args(argv)

    if at.mode == "shot" and not at.out:
        p.error("shot needs --out PATH")
    try:
        w, h = (int(n) for n in at.viewport.lower().split("x", 1))
    except ValueError:
        p.error(f"--viewport wants WxH, e.g. 1280x800 — got {at.viewport!r}")
    at.viewport_size = {"width": w, "height": h}
    return at


class Shot(NamedTuple):
    paths: list
    faults: list


SHRUNK_IMAGES_JS = """[...document.images]
  .filter((i) => i.naturalWidth && i.clientWidth < i.naturalWidth)
  .map((i) => [i.getAttribute("src"), i.clientWidth, i.naturalWidth])"""


def tile_clips(page_height, viewport):
    return [
        {
            "x": 0,
            "y": y,
            "width": viewport["width"],
            "height": min(viewport["height"], page_height - y),
        }
        for y in range(0, page_height, viewport["height"])
    ]


def tile_paths(out, count):
    path = Path(out)
    return [
        str(path.with_name(f"{path.stem}-{n}{path.suffix}"))
        for n in range(1, count + 1)
    ]


def real_size_faults(page_width, viewport_width, shrunk):
    faults = [
        f"{src} is drawn {drawn}px wide, below its own {natural}px."
        for src, drawn, natural in shrunk
    ]
    if page_width > viewport_width:
        faults.insert(
            0,
            f"the page is {page_width}px wide in a {viewport_width}px viewport, "
            "so it scrolls sideways.",
        )
    return faults


class PageTimeoutError(Exception):
    pass


class NoBrowserError(Exception):
    pass


class RefusedError(Exception):
    pass


def render(at):
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import TimeoutError as PlaywrightTimeout
    from playwright.sync_api import sync_playwright

    with sync_playwright() as play:
        try:
            browser = play.chromium.launch()
        except PlaywrightError as exc:
            raise NoBrowserError(first_line(exc)) from exc
        try:
            context = browser.new_context(user_agent=at.ua, viewport=at.viewport_size)
            context.set_default_timeout(at.timeout)
            page = context.new_page()
            try:
                page.goto(at.url, wait_until="load")
                if at.wait:
                    page.wait_for_selector(at.wait)
                if at.settle:
                    page.wait_for_timeout(at.settle)

                if at.mode == "shot":
                    if not at.tiles:
                        page.screenshot(path=at.out, full_page=at.full_page)
                        return Shot([at.out], [])
                    page_height = page.evaluate("document.documentElement.scrollHeight")
                    clips = tile_clips(page_height, at.viewport_size)
                    paths = tile_paths(at.out, len(clips))
                    for path, clip in zip(paths, clips, strict=True):
                        page.screenshot(path=path, full_page=True, clip=clip)
                    faults = real_size_faults(
                        page.evaluate("document.documentElement.scrollWidth"),
                        at.viewport_size["width"],
                        page.evaluate(SHRUNK_IMAGES_JS),
                    )
                    return Shot(paths, faults)
                if at.mode == "html":
                    return page.content()
                return page.inner_text("body")
            except PlaywrightTimeout as exc:
                raise PageTimeoutError(first_line(exc)) from exc
            except PlaywrightError as exc:
                raise RefusedError(first_line(exc)) from exc
        finally:
            browser.close()


def main(argv, render=render):
    at = parse(argv)
    try:
        body = render(at)
    except ImportError:
        print(f"Playwright is not importable here.\n{INSTALL_HINT}", file=sys.stderr)
        return 3
    except NoBrowserError as exc:
        print(
            f"Playwright is installed but its browser is not: {exc}\n{INSTALL_HINT}",
            file=sys.stderr,
        )
        return 3
    except RefusedError as exc:
        print(
            f"the browser could not load {at.url}: {exc}\n"
            "Check the URL and that this machine is online; if both hold, the "
            "host refuses this route — the browser-ladder skill names the next route.",
            file=sys.stderr,
        )
        return 5
    except PageTimeoutError as exc:
        print(
            f"timed out after {at.timeout}ms on {at.url}: {exc}\n"
            "Raise --timeout, or name the element you are waiting for with "
            "--wait SELECTOR.",
            file=sys.stderr,
        )
        return 4

    if isinstance(body, Shot):
        for path in body.paths:
            print(f"wrote {path}", file=sys.stderr)
        if body.faults:
            print(
                "\n".join(body.faults) + "\nGive each image its natural width "
                "(`max-width: none`), and put anything wider than the viewport "
                "in its own `overflow-x: auto` box.",
                file=sys.stderr,
            )
            return 6
        return 0
    if at.out:
        with open(at.out, "w", encoding="utf8") as fh:
            fh.write(body)
        print(f"wrote {at.out}", file=sys.stderr)
    else:
        print(body)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
