#!/usr/bin/env python3
"""browse.py — render a page with a real browser, for a session that needs one.

Playwright is installed machine-wide on this host as the Python package, not
per-repo and not as an npm dependency, so `import playwright` already works from
every checkout (workflow-core#133).

CORE-OWNED — DO NOT EDIT AN ADOPTER'S COPY. Init and every upgrade rewrite an
adopter's copy wherever it differs from this one, naming it as they do, so a
local change is lost (workflow-core#1453). Fix it upstream in workflow-core instead.

NOT A SCRAPER, AND NOT A CRAWLER. One URL per invocation, no link-following, no
retry loop. A session that wants several pages calls it several times and paces
itself — fantasy-books' `docs/sources.md` is the standing guidance on reading
someone's site politely.

WHY NOT THE PLAYWRIGHT MCP SERVER. Not context: with tool search on it costs
about 400 tokens a session (workflow-core#977). Its idle process tree holds about 226 MB in
every session, and ad-hoc Playwright scripts already did 24 of 28 no-login
interactive tasks unaided (workflow-core#953). Which route to try when this one fails: the
`browser-ladder` skill.

USAGE
  python3 scripts/browse.py text  <url> [common]
  python3 scripts/browse.py html  <url> [common]
  python3 scripts/browse.py shot  <url>  --out PATH [--full-page] [common]

  common: [--wait SEL] [--settle MS] [--timeout MS] [--ua STRING] [--out PATH]
          [--viewport WxH]

EXITS 0 rendered / 2 the arguments are wrong / 3 Playwright or its browser is
missing, with the install command named / 4 the page did not render in time /
5 the browser refused the page — DNS, a refused connection, a TLS failure.

Every exit is one of those five: `main` catches Playwright's own error class, so
nothing reaches the caller as a traceback.
"""

import argparse
import sys

# An ordinary desktop Chrome UA. Playwright's own advertises HeadlessChrome,
# which Cloudflare and Akamai both answer with a 403 and an interstitial — the
# single most common reason a probe "fails" against a site that is in fact open.
#
# The version is current as of September 2026 and goes stale on its own. A
# string a few majors behind is still served normally; one years behind starts
# drawing upgrade interstitials, so re-pin it when that shows up rather than on
# a schedule. `--ua` overrides it per call.
DEFAULT_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)

# Both exit-3 causes end at the same two commands, so the lead line says which
# one happened and this says what to do about either.
INSTALL_HINT = (
    "On this machine Playwright is the Python package under miniforge,\n"
    "installed once per machine rather than per repo:\n"
    "    python3 -m pip install playwright\n"
    "    python3 -m playwright install chromium"
)


def first_line(exc):
    """Playwright's errors open with a blank line and a box-drawn banner, so
    `splitlines()[0]` is the empty string. Take the first line with text."""
    for line in str(exc).splitlines():
        if line.strip():
            return line.strip()
    return exc.__class__.__name__


def parse(argv):
    p = argparse.ArgumentParser(
        prog="browse.py",
        description="Render one URL with a real browser and print or capture it.",
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
    # Playwright's own default, kept.
    p.add_argument("--timeout", type=int, default=30000, metavar="MS")
    p.add_argument("--ua", default=DEFAULT_UA, metavar="STRING")
    p.add_argument("--out", metavar="PATH", help="Required for `shot`.")
    p.add_argument("--full-page", action="store_true")
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


class PageTimeoutError(Exception):
    """The page did not render in time — its own exit code, so a caller can tell
    a slow page from a broken argument."""


class NoBrowserError(Exception):
    """Playwright imported but its Chromium is not downloaded. Shares exit 3
    with an absent package: both are answered by the same install lines, and a
    caller cannot act on the difference."""


class RefusedError(Exception):
    """The browser reached the network and got nothing usable — DNS, a refused
    connection, a bad TLS handshake. Not a timeout."""


def render(at):
    """Drive the browser. Returns the text to emit, or None for a shot that has
    already written itself."""
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import TimeoutError as PlaywrightTimeout
    from playwright.sync_api import sync_playwright

    with sync_playwright() as play:
        try:
            browser = play.chromium.launch()
        except PlaywrightError as exc:
            # The one Playwright error that is a setup fault rather than a page
            # fault: `launch()` fails this way when the browser was never
            # downloaded, which an `import playwright` alone cannot detect.
            raise NoBrowserError(first_line(exc)) from exc
        try:
            # A context rather than a bare page: the UA and viewport have to be
            # set at context level.
            context = browser.new_context(user_agent=at.ua, viewport=at.viewport_size)
            # Applies --timeout to the capture calls too. Without it
            # `screenshot`/`content`/`inner_text` keep Playwright's own 30s
            # default and ignore the flag entirely.
            context.set_default_timeout(at.timeout)
            page = context.new_page()
            try:
                # `load` and not `networkidle`: idle never fires on a page
                # holding a websocket or a polling beacon open, which is most
                # dashboards, and the wait then burns the whole timeout.
                page.goto(at.url, wait_until="load")
                if at.wait:
                    page.wait_for_selector(at.wait)
                if at.settle:
                    page.wait_for_timeout(at.settle)

                if at.mode == "shot":
                    page.screenshot(path=at.out, full_page=at.full_page)
                    return None
                if at.mode == "html":
                    return page.content()
                return page.inner_text("body")
            except PlaywrightTimeout as exc:
                raise PageTimeoutError(first_line(exc)) from exc
            except PlaywrightError as exc:
                # Ordered after PlaywrightTimeout, which subclasses this — the
                # reverse silently swallows every timeout into exit 5.
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

    if body is None:
        print(f"wrote {at.out}", file=sys.stderr)
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
