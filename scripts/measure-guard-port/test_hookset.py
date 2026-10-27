"""Pins hookset.py's selection: which hooks one tool call fires, the set every
always-on guard port's latency gate is benched over (#2711, #2783).

A hook wrongly kept puts an `if`-narrowed guard into the always-on figure; one
wrongly dropped hides a guard's cost.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from hookset import hook_commands, layer_paths

HERE = Path(__file__).parent


def h(cmd, cond=None):
    return {"type": "command", "command": cmd, **({"if": cond} if cond else {})}


LAYERS = [
    {
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "Bash",
                    "hooks": [h("always"), h("git-only", "Bash(git *)")],
                },
                {"matcher": "Write|Edit", "hooks": [h("writes")]},
                {"matcher": "", "hooks": [h("everything")]},
            ],
            "PostToolUse": [{"matcher": "Bash", "hooks": [h("post")]}],
        }
    },
    {"hooks": {"PreToolUse": [{"matcher": "*", "hooks": [h("always"), h("user")]}]}},
]


def test_a_plain_call_fires_the_unnarrowed_hooks_of_matching_groups_once_each():
    assert hook_commands(LAYERS, "PreToolUse", "Bash", "ls -la") == [
        "always",
        "everything",
        "user",
    ]


def test_an_if_fires_only_on_a_matching_command():
    assert "git-only" in hook_commands(LAYERS, "PreToolUse", "Bash", "git status")


def test_an_if_naming_another_tool_never_fires():
    layers = [
        {"hooks": {"PreToolUse": [{"matcher": "*", "hooks": [h("x", "Read(*)")]}]}}
    ]
    assert hook_commands(layers, "PreToolUse", "Bash", "ls") == []


def test_the_matcher_is_a_full_match_of_the_tool_name():
    assert hook_commands(LAYERS, "PreToolUse", "Edit", "") == [
        "writes",
        "everything",
        "always",
        "user",
    ]
    assert "writes" not in hook_commands(LAYERS, "PreToolUse", "EditX", "")


def test_the_event_selects_its_own_groups():
    assert hook_commands(LAYERS, "PostToolUse", "Bash", "ls") == ["post"]


def test_layers_follow_the_plugin_and_config_dir_knobs():
    paths = layer_paths(
        "/repo", {"CLAUDE_PLUGIN_ROOT": "/p", "CLAUDE_CONFIG_DIR": "/c"}
    )
    assert paths == [
        "/p/hooks/hooks.json",
        "/repo/.claude/settings.json",
        "/repo/.claude/settings.local.json",
        "/c/settings.json",
    ]
    assert layer_paths("/repo", {})[0] == "/repo/self-plugin/hooks/hooks.json"


def test_an_if_matches_a_subcommand_of_a_compound_command():
    assert "git-only" in hook_commands(
        LAYERS, "PreToolUse", "Bash", "cd /x && git status"
    )
    assert "git-only" in hook_commands(
        LAYERS, "PreToolUse", "Bash", "ls; git log | head"
    )


def test_the_program_prints_the_set_from_the_layers_and_names_a_missing_one(tmp_path):
    plugin = tmp_path / "plugin" / "hooks"
    plugin.mkdir(parents=True)
    (plugin / "hooks.json").write_text(json.dumps(LAYERS[0]))
    env = dict(
        os.environ,
        CLAUDE_PROJECT_DIR=str(tmp_path / "repo"),
        CLAUDE_PLUGIN_ROOT=str(tmp_path / "plugin"),
        CLAUDE_CONFIG_DIR=str(tmp_path / "config"),
    )
    (tmp_path / "repo").mkdir()
    done = subprocess.run(
        [sys.executable, str(HERE / "hookset.py"), "PreToolUse", "Bash", "ls"],
        capture_output=True,
        text=True,
        env=env,
    )
    assert done.returncode == 0
    assert done.stdout.splitlines() == ["always", "everything"]
    assert f"no layer at {tmp_path / 'config' / 'settings.json'}" in done.stderr


def test_the_program_refuses_a_bad_invocation():
    done = subprocess.run(
        [sys.executable, str(HERE / "hookset.py"), "PreToolUse"], capture_output=True
    )
    assert done.returncode == 1
