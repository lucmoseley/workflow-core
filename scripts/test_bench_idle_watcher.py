import types

import bench_idle_watcher as bw


def test_floor_is_earlyooms_line_plus_the_margin(monkeypatch):
    monkeypatch.setattr(bw, "meminfo", lambda: {"MemTotal": 10_000 * 1024})
    assert bw.floor_mb() == 10_000 * bw.EARLYOOM_PCT / 100 + bw.DEFAULT_FLOOR_MARGIN_MB


def test_rest_summarises_the_trees_readings(monkeypatch):
    readings = iter([(100.0, 1), (300.0, 3), (200.0, 1)])
    clock = iter([0, 0, 1, 2, 3])
    monkeypatch.setattr(bw, "tree_rss_mb", lambda pid: next(readings))
    monkeypatch.setattr(bw.time, "time", lambda: next(clock))
    monkeypatch.setattr(bw.time, "sleep", lambda s: None)
    watcher = types.SimpleNamespace(proc=types.SimpleNamespace(pid=1))
    assert bw.rest(watcher, 3) == {"rss_mean_mb": 200.0, "rss_max_mb": 300.0, "pids": 3}


def test_volunteer_passes_over_a_pid_that_is_gone(capsys):
    bw.volunteer(2**22 + 1)
    assert capsys.readouterr().err == ""


class _HungProc:
    pid = 4242

    def __init__(self):
        self.waits = 0

    def wait(self, timeout=None):
        self.waits += 1
        if timeout is not None:
            raise bw.subprocess.TimeoutExpired("vitest", timeout)


def _closing(proc):
    w = bw.Watcher.__new__(bw.Watcher)
    w.proc = proc
    w.log = types.SimpleNamespace(close=lambda: None)
    return w


def test_close_kills_a_watcher_that_ignores_sigterm(monkeypatch, capsys):
    sent = []
    monkeypatch.setattr(bw.os, "killpg", lambda pid, sig: sent.append(sig))
    _closing(_HungProc()).close()
    assert sent == [bw.signal.SIGTERM, bw.signal.SIGKILL]
    assert "fail-open: SIGKILL the watcher's group" in capsys.readouterr().err


def test_close_passes_over_a_group_already_gone(monkeypatch):
    def gone(pid, sig):
        raise ProcessLookupError

    monkeypatch.setattr(bw.os, "killpg", gone)
    _closing(_HungProc()).close()
