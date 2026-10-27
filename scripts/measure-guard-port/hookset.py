#!/usr/bin/env python3
"""hookset.py — print the hook commands that fire for one tool call, read from
the live layers, one per line (#2711, #2783).

  python3 scripts/measure-guard-port/hookset.py <event> <tool> <command>

Layers, in order: the plugin's `hooks/hooks.json` (CLAUDE_PLUGIN_ROOT, else the
host's `self-plugin/`), the host's `.claude/settings.json` and
`.claude/settings.local.json`, and the user's `settings.json` (CLAUDE_CONFIG_DIR,
else `~/.claude`). A missing layer is skipped and named on stderr.

A group fires where its matcher is empty, `*`, or fully matches the tool name; a
hook with an `if` fires where the rule names the tool and its pattern globs the
command or any of its subcommands split on `&&`, `||`, `;` and `|`. That split
ignores quoting, so it approximates the harness's permission-rule match. A
command named twice is printed once.

Feed the output to `bench.py`. Exit 0, or 1 on a bad invocation.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from host_root import host_root

SUBCOMMAND_SPLIT = re.compile(r"&&|\|\||;|\|")


def layer_paths(root: str, environ: dict) -> list[str]:
    plugin = environ.get("CLAUDE_PLUGIN_ROOT") or os.path.join(root, "self-plugin")
    config = environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    return [
        os.path.join(plugin, "hooks", "hooks.json"),
        os.path.join(root, ".claude", "settings.json"),
        os.path.join(root, ".claude", "settings.local.json"),
        os.path.join(config, "settings.json"),
    ]


def fires(hook: dict, tool: str, cmd: str) -> bool:
    cond = hook.get("if")
    if not cond:
        return True
    m = re.fullmatch(r"(\w+)\((.*)\)", cond)
    if not m or m.group(1) != tool:
        return False
    parts = [cmd, *(p.strip() for p in SUBCOMMAND_SPLIT.split(cmd))]
    return any(fnmatch.fnmatchcase(p, m.group(2)) for p in parts)


def hook_commands(layers: list[dict], event: str, tool: str, cmd: str) -> list[str]:
    out: list[str] = []
    for layer in layers:
        for group in layer.get("hooks", {}).get(event, []):
            matcher = group.get("matcher", "") or "*"
            if matcher != "*" and not re.fullmatch(matcher, tool):
                continue
            for hook in group.get("hooks", []):
                c = hook.get("command")
                if c and fires(hook, tool, cmd) and c not in out:
                    out.append(c)
    return out


def load_layers(paths: list[str]) -> list[dict]:
    layers = []
    for p in paths:
        try:
            with open(p) as fh:
                layers.append(json.load(fh))
        except FileNotFoundError:
            # Named so an unset plugin root is not mistaken for an empty set (#2783).
            print(f"hookset: no layer at {p}", file=sys.stderr)
            continue
    return layers


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 3:
        print(__doc__, file=sys.stderr)
        return 1
    event, tool, cmd = args
    layers = load_layers(layer_paths(host_root(), os.environ))
    for c in hook_commands(layers, event, tool, cmd):
        print(c)
    return 0


if __name__ == "__main__":
    sys.exit(main())
