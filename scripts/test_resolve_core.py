"""resolve_core.py against resolve-core.js (#465): the same fixture through both
resolvers must give the same directory, the same failure message and the same
warnings. Each case also pins the expected outcome, so the two cannot agree on
a wrong answer.

`env` always carries CLAUDE_CONFIG_DIR or a throwaway HOME, so no case reads
this machine's install record or its own WORKFLOW_CORE_* variables.

An adopter's Python scripts and pytest suite find the core's helpers only
through this resolver: loosen a case and they load a different core from the
one its JS checks use, or fail with a message naming the wrong fix.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

LIB = Path(__file__).resolve().parent / "lib"
sys.path.insert(0, str(LIB))
from project_slug import project_slug  # noqa: E402 - imported after LIB, which the sys.path.insert above reads (#1272)
from resolve_core import resolve_core  # noqa: E402 - imported after LIB, which the sys.path.insert above reads (#1272)

JS_RUN = """
const [file, root, env] = process.argv.slice(1);
const warnings = [];
let out;
try {
  const dir = require(file).resolveCore({
    ...(root ? { root } : {}),
    ...(env ? { env: JSON.parse(env) } : {}),
    warn: (line) => warnings.push(line),
  });
  out = { ok: true, value: dir, warnings };
} catch (err) {
  out = { ok: false, value: err.message, warnings };
}
process.stdout.write(JSON.stringify(out));
"""

PY_RUN = """
import json, sys
sys.path.insert(0, sys.argv[1])
from resolve_core import resolve_core
warnings = []
try:
    out = {"ok": True, "value": resolve_core(warn=warnings.append)}
except RuntimeError as err:
    out = {"ok": False, "value": str(err)}
out["warnings"] = warnings
sys.stdout.write(json.dumps(out))
"""


def _write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


@pytest.fixture
def adopter(tmp_path):
    """plugin-state-testkit.ts's adopterFixtures, in Python."""

    def make(pin_ref="v1.1.8", installed_version="1.1.8"):
        root = tmp_path / "adopter"
        config = tmp_path / "config"
        install = config / "plugins" / "cache" / "wc" / installed_version
        _write_json(
            root / ".claude" / "settings.json",
            {
                "enabledPlugins": {"workflow-core@wc": True},
                "extraKnownMarketplaces": {
                    "wc": {"source": {"source": "url", "ref": pin_ref}}
                },
            },
        )
        _write_json(
            config / "plugins" / "installed_plugins.json",
            {
                "plugins": {
                    "workflow-core@wc": [
                        {"projectPath": str(root), "installPath": str(install)}
                    ]
                }
            },
        )
        _write_json(
            install / ".claude-plugin" / "plugin.json",
            {"version": installed_version},
        )
        return root, config, install

    return make


def both(root, env):
    """Each resolver's {ok, value, warnings} for the same root and env."""
    warnings = []
    try:
        py = {
            "ok": True,
            "value": resolve_core(root=str(root), env=env, warn=warnings.append),
        }
    except RuntimeError as err:
        py = {"ok": False, "value": str(err)}
    py["warnings"] = warnings
    js = subprocess.run(
        [
            "node",
            "-e",
            JS_RUN,
            str(LIB / "resolve-core.js"),
            str(root),
            json.dumps(env),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return py, json.loads(js.stdout)


def agreed(root, env):
    py, js = both(root, env)
    assert py == js
    return py


def test_takes_the_override_ahead_of_the_checkout_and_the_install(adopter, tmp_path):
    root, config, _ = adopter()
    (tmp_path / "override").mkdir()
    (tmp_path / "checkout").mkdir()
    out = agreed(
        root,
        {
            "CLAUDE_CONFIG_DIR": str(config),
            "WORKFLOW_CORE_DIR": str(tmp_path / "override"),
            "WORKFLOW_CORE_CHECKOUT": str(tmp_path / "checkout"),
        },
    )
    assert out["value"] == str(tmp_path / "override")


def test_takes_the_checkout_ahead_of_the_install(adopter, tmp_path):
    root, config, _ = adopter()
    (tmp_path / "checkout").mkdir()
    out = agreed(
        root,
        {
            "CLAUDE_CONFIG_DIR": str(config),
            "WORKFLOW_CORE_CHECKOUT": str(tmp_path / "checkout"),
        },
    )
    assert out["value"] == str(tmp_path / "checkout")


def test_skips_a_variable_set_empty(adopter, tmp_path):
    root, config, install = adopter()
    out = agreed(root, {"CLAUDE_CONFIG_DIR": str(config), "WORKFLOW_CORE_DIR": ""})
    assert out["value"] == str(install)


def test_takes_the_last_install_row_for_this_root_not_another_projects(
    adopter, tmp_path
):
    root, config, install = adopter()
    older = tmp_path / "older"
    older.mkdir()
    _write_json(
        config / "plugins" / "installed_plugins.json",
        {
            "plugins": {
                "workflow-core@wc": [
                    {"projectPath": str(root), "installPath": str(older)},
                    {"projectPath": str(root), "installPath": str(install)},
                    {"projectPath": "/another/project", "installPath": str(older)},
                ]
            }
        },
    )
    out = agreed(root, {"CLAUDE_CONFIG_DIR": str(config)})
    assert out == {"ok": True, "value": str(install), "warnings": []}


def test_names_the_pin_and_the_missing_record_where_nothing_resolves(adopter, tmp_path):
    root, _, _ = adopter()
    empty = tmp_path / "empty-config"
    empty.mkdir()
    out = agreed(root, {"CLAUDE_CONFIG_DIR": str(empty)})
    assert out["value"] == (
        "resolve-core: no workflow-core directory for pin v1.1.8 — WORKFLOW_CORE_DIR"
        " and WORKFLOW_CORE_CHECKOUT are unset, and"
        f" {empty}/plugins/installed_plugins.json records no workflow-core@wc install"
        f" for {root}"
    )


def test_names_a_set_variable_that_names_no_directory_rather_than_falling_through(
    adopter, tmp_path
):
    root, config, _ = adopter()
    gone = tmp_path / "never-checked-out"
    out = agreed(
        root, {"CLAUDE_CONFIG_DIR": str(config), "WORKFLOW_CORE_CHECKOUT": str(gone)}
    )
    assert out["value"].endswith(
        f"for pin v1.1.8 — WORKFLOW_CORE_CHECKOUT names {gone}, which is not a directory"
    )


def test_names_a_recorded_install_gone_from_disk(adopter):
    root, config, install = adopter()
    (install / ".claude-plugin" / "plugin.json").unlink()
    (install / ".claude-plugin").rmdir()
    install.rmdir()
    out = agreed(root, {"CLAUDE_CONFIG_DIR": str(config)})
    assert out["value"].endswith(f"records {install}, which is not a directory")


def test_names_pin_none_where_the_settings_enable_no_workflow_core(adopter):
    root, config, _ = adopter()
    (root / ".claude" / "settings.json").unlink()
    out = agreed(root, {"CLAUDE_CONFIG_DIR": str(config)})
    assert out["value"].startswith(
        "resolve-core: no workflow-core directory for pin none"
    )


@pytest.mark.parametrize(
    ("enabled", "known"),
    [
        ("workflow-core@constructor", {"wc": {"source": {"ref": "v1.1.8"}}}),
        ("workflow-core@wc", "wc"),
        ("workflow-core@0", [{"source": {"ref": "v1.1.8"}}]),
    ],
)
def test_counts_only_the_marketplaces_the_settings_themselves_name(
    adopter, enabled, known
):
    root, config, _ = adopter()
    _write_json(
        root / ".claude" / "settings.json",
        {"enabledPlugins": {enabled: True}, "extraKnownMarketplaces": known},
    )
    out = agreed(root, {"CLAUDE_CONFIG_DIR": str(config)})
    assert out["value"] == (
        "resolve-core: no workflow-core directory for pin none — WORKFLOW_CORE_DIR"
        " and WORKFLOW_CORE_CHECKOUT are unset, and"
        f" {root}/.claude/settings.json enables no workflow-core from a known"
        " marketplace"
    )


@pytest.mark.parametrize(
    "record",
    [
        {"plugins": {"workflow-core@wc": {"installPath": "x"}}},
        {"plugins": []},
        [],
    ],
)
def test_names_the_missing_install_where_the_record_is_malformed(adopter, record):
    root, config, _ = adopter()
    _write_json(config / "plugins" / "installed_plugins.json", record)
    out = agreed(root, {"CLAUDE_CONFIG_DIR": str(config)})
    assert "records no workflow-core@wc install" in out["value"]


@pytest.mark.parametrize(
    ("pin_ref", "install_path"),
    [(True, None), ("v1.1.8", []), ("v1.1.8", {}), ("v1.1.8", True), ("v1.1.8", 5)],
)
def test_fails_in_both_naming_the_pin_on_values_the_cli_never_writes(
    adopter, pin_ref, install_path
):
    root, config, _ = adopter()
    settings = root / ".claude" / "settings.json"
    shape = json.loads(settings.read_text())
    shape["extraKnownMarketplaces"]["wc"]["source"]["ref"] = pin_ref
    _write_json(settings, shape)
    if install_path is not None:
        _write_json(
            config / "plugins" / "installed_plugins.json",
            {
                "plugins": {
                    "workflow-core@wc": [
                        {"projectPath": str(root), "installPath": install_path}
                    ]
                }
            },
        )
    env = {"CLAUDE_CONFIG_DIR": str(config), "WORKFLOW_CORE_DIR": ""}
    if install_path is None:
        env["WORKFLOW_CORE_CHECKOUT"] = str(root / "absent")
    py, js = both(root, env)
    prefix = "resolve-core: no workflow-core directory for pin "
    for out in (py, js):
        assert not out["ok"]
        assert out["value"].lower().startswith(prefix + str(pin_ref).lower())


@pytest.mark.parametrize(
    ("pin_ref", "installed", "warned"),
    [
        ("v1.1.11", "1.1.8", True),
        ("v1.1.8", "1.1.11", True),
        ("v1.1.8", "1.1.8", False),
        ("main", "1.1.8", False),
        ("b88b6baafe3998bb3f84a5aa495d4ab01c2945f4", "1.1.8", False),
    ],
)
def test_warns_naming_both_versions_only_where_a_version_pin_differs_and_still_resolves(
    adopter, pin_ref, installed, warned
):
    root, config, install = adopter(pin_ref=pin_ref, installed_version=installed)
    out = agreed(root, {"CLAUDE_CONFIG_DIR": str(config)})
    assert out["value"] == str(install)
    assert out["warnings"] == (
        [
            f"resolve-core: the installed workflow-core is {installed}, not the pinned"
            f" {pin_ref} — local results can differ from CI's until the install catches up"
        ]
        if warned
        else []
    )


def _git(cwd, *args):
    subprocess.run(
        ["git", "-c", "user.email=a@a", "-c", "user.name=a", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
    )


def test_resolves_with_no_harness_variables_from_a_checkout_and_a_linked_worktree(
    adopter, tmp_path
):
    root, config, install = adopter()
    _git(root, "init", "-q", "-b", "main")
    _git(root, "commit", "-q", "--allow-empty", "-m", "x")
    worktree = tmp_path / "wt"
    _git(root, "worktree", "add", "-q", "--detach", str(worktree))
    home = tmp_path / "home"
    home.mkdir()
    (home / ".claude").symlink_to(config)
    plain = {"PATH": os.environ["PATH"], "HOME": str(home)}

    for cwd in (root, worktree):
        py = subprocess.run(
            [sys.executable, "-c", PY_RUN, str(LIB)],
            cwd=cwd,
            env=plain,
            capture_output=True,
            text=True,
            check=True,
        )
        js = subprocess.run(
            ["node", "-e", JS_RUN, str(LIB / "resolve-core.js")],
            cwd=cwd,
            env=plain,
            capture_output=True,
            text=True,
            check=True,
        )
        assert json.loads(py.stdout) == json.loads(js.stdout)
        assert json.loads(py.stdout)["value"] == str(install)


# The adopter's pytest seam end to end (#465): a fixture adopter holding only
# its copy of resolve_core.py imports the surface from a rendered release tree,
# the way CI hands it one through WORKFLOW_CORE_CHECKOUT.

REPO = LIB.parent.parent

CONFTEST = """
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from resolve_core import resolve_core

sys.path.insert(0, os.path.join(resolve_core(), "scripts", "lib"))
"""

SURFACE_TEST = """
import os

import project_slug


def test_imports_the_surface_from_the_core():
    assert project_slug.__file__.startswith(os.environ["EXPECT_CORE"])
    assert project_slug.slug_for_repo() == os.environ["EXPECT_SLUG"]
"""


@pytest.fixture(scope="module")
def release(tmp_path_factory):
    out = tmp_path_factory.mktemp("release") / "tree"
    subprocess.run(
        ["node", "scripts/generate-plugin-tree.js", str(out)],
        cwd=REPO,
        check=True,
        capture_output=True,
    )
    return out


@pytest.fixture
def surface_adopter(adopter, release, tmp_path):
    root, _, _ = adopter(pin_ref="v1.2.0")
    lib = root / "scripts" / "lib"
    lib.mkdir(parents=True)
    (lib / "resolve_core.py").write_bytes(
        (release / "scripts" / "lib" / "resolve_core.py").read_bytes()
    )
    (root / "scripts" / "conftest.py").write_text(CONFTEST)
    (root / "scripts" / "test_surface.py").write_text(SURFACE_TEST)
    (tmp_path / "home" / ".claude").mkdir(parents=True)

    def run(**env):
        return subprocess.run(
            [sys.executable, "-m", "pytest", "scripts", "-q", "-p", "no:cacheprovider"],
            cwd=root,
            env={
                "PATH": os.environ["PATH"],
                "HOME": str(tmp_path / "home"),
                "CLAUDE_PROJECT_DIR": str(root),
                **env,
            },
            capture_output=True,
            text=True,
        )

    return root, run


def test_an_adopter_suite_imports_the_surface_from_a_rendered_release_tree(
    surface_adopter, release
):
    root, run = surface_adopter
    assert not list(root.rglob("project_slug.py"))
    r = run(
        WORKFLOW_CORE_CHECKOUT=str(release),
        EXPECT_CORE=str(release),
        # Checks which root is slugged, not the rule — test_project_slug.py pins that.
        EXPECT_SLUG=project_slug(str(root.resolve())),
    )
    assert r.returncode == 0, r.stdout + r.stderr


def test_an_adopter_suite_fails_naming_the_pin_where_the_core_is_unreachable(
    surface_adopter,
):
    _, run = surface_adopter
    r = run()
    assert r.returncode != 0
    assert (
        "resolve-core: no workflow-core directory for pin v1.2.0 — WORKFLOW_CORE_DIR"
        " and WORKFLOW_CORE_CHECKOUT are unset"
    ) in (r.stdout + r.stderr)
