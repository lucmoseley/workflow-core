"""machine.py — the machine state every guard-port figure is read beside:
`date -Is`, load1 and `free -m` (#2733, #2783). load1 reads the real /proc,
never WFC_PROC's fake: the state is this machine's (#3608)."""

from __future__ import annotations

import subprocess


def machine_state() -> dict:
    with open("/proc/loadavg") as fh:
        load1 = fh.read().split()[0]
    date = subprocess.run(["date", "-Is"], capture_output=True, text=True).stdout
    free = subprocess.run(["free", "-m"], capture_output=True, text=True).stdout
    return {"at": date.strip(), "load1": load1, "free_m": free.splitlines()}
