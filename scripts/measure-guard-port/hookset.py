#!/usr/bin/env python3
from __future__ import annotations

import fnmatch
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from fail_open import expected
from host_root import host_root

USAGE = """usage: hookset.py <event> <tool> <command>

Print the hook commands that fire for one tool call, one per line.
Exit 0, or 1 on a bad invocation."""
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
        except FileNotFoundError as e:
            expected(e, f"no layer at {p}: a settings file the host never wrote")
            continue
    return layers


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 3:
        print(USAGE, file=sys.stderr)
        return 1
    event, tool, cmd = args
    layers = load_layers(layer_paths(host_root(), os.environ))
    for c in hook_commands(layers, event, tool, cmd):
        print(c)
    return 0


if __name__ == "__main__":
    sys.exit(main())
