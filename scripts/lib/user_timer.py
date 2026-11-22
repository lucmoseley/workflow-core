import os
import subprocess
import sys
from pathlib import Path

from wfc_bin import bin_path

INSTALL_DIR = Path.home() / ".local/lib/workflow-core"
SHARED_LIBS = ("fail_open.py", "memwatch_minute.py")


def user_units():
    config = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(config) / "systemd/user"


def render(template, placeholders):
    for name, value in placeholders.items():
        template = template.replace(f"@{name}@", str(value))
    return template


def install(source, unit, placeholders):
    home = INSTALL_DIR / unit
    script = home / source.name
    rerun = f"python3 scripts/{source.name} install"
    (home / "lib").mkdir(parents=True, exist_ok=True)
    script.write_bytes(source.read_bytes())
    print(script)
    for name in SHARED_LIBS:
        (home / "lib" / name).write_bytes((source.parent / "lib" / name).read_bytes())
    units = user_units()
    units.mkdir(parents=True, exist_ok=True)
    for suffix in ("service", "timer"):
        template = (source.parent / f"{unit}.{suffix}.template").read_text()
        out = units / f"{unit}.{suffix}"
        out.write_text(render(template, {"SCRIPT": script, **placeholders}))
        print(out)
    systemctl = bin_path("systemctl")
    for args in (
        ["--user", "daemon-reload"],
        ["--user", "enable", "--now", f"{unit}.timer"],
    ):
        run = subprocess.run([systemctl, *args], capture_output=True, text=True)
        if run.returncode != 0:
            print(
                f"systemctl {' '.join(args)}: {run.stderr.strip()}; re-run: {rerun}",
                file=sys.stderr,
            )
            return 1
    state = subprocess.run(
        [systemctl, "--user", "is-active", f"{unit}.timer"],
        capture_output=True,
        text=True,
    ).stdout.strip()
    print(f"{unit}.timer: {state}")
    return 0 if state == "active" else 1
