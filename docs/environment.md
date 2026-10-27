# Development environment

v1.19 · 4 October 2026

The dev machine and the guards that keep it alive. Snapdragon ARM64 under WSL2 — check architecture before suggesting binaries or native dependencies.

---

## 1. Host and guest configuration

⚠ **Every value in this section is one machine's, kept as a worked example, not a
figure the core asserts about yours.** The figures the guards act on — the memory
cap, `MemTotal`, earlyoom's 8% threshold — are declared in
`~/.claude/workflow-core/machine.json`, and the numbers below are the documented
defaults where that profile is absent. Read your own with `free -m`, `nproc` and
`cat /etc/default/earlyoom` before acting on any of them.

**`C:\Users\<you>\.wslconfig`**

```ini
[wsl2]
memory=10GB
swap=2GB
processors=8
[experimental]
autoMemoryReclaim=gradual
sparseVhd=true
```

**Do not raise memory or swap without a measured peak.** An earlier 8 GB swap caused an unrecoverable page-fault loop lasting over an hour, so swap stays at 2 GB — it converts a clean `earlyoom` kill into thrashing, and more RAM reduces the need for it rather than pairing with it.

**`memory` is 10 GB**, set on a measured peak of **7163 MB used of 7924 MiB — 90% of the 8 GB cap before it**, within ~130 MB of `earlyoom`'s threshold, read from `~/memwatch.log` across 17–18 August (the crossing counts behind it are on mantahostels#2766).

**Say the raise was licensed by a measured peak with no single-process spike (§6), and never quote a usable MiB that was not read from `/proc/meminfo`.** `MemTotal` at the 10 GB cap is **9,924 MiB**, read from `free -m` on 18 August 2026 — never computed.

**Why not 12 GB.** Past ~10 GB the failure mode changes rather than recedes: Linux stops reaching `earlyoom`'s threshold — which kills the largest process and costs one session — and Windows exhausts first, paging to disk with nothing to arrest it. A whole-machine freeze replaces a survivable kill.

**`processors` is 8**, the host's full count (Snapdragon X Plus, 8 Oryon cores, no SMT, homogeneous — so the two added are full-speed cores). 8 is WSL2's own default. **It can freeze the VM — 4 Oct 2026 proved it (§7)**: with every host core given to the guest, a saturated guest starved its own system services and the interop channel. The founder kept 8 cores and chose a load ceiling on new work instead (#830, §6 *The load ceiling*); cutting to 6 is the rejected alternative, and the one to revisit if the ceiling fails to hold.

**Nothing else turns on the cap.** admission fits sessions into whatever `MemAvailable` reports (§5); `vitest.config.ts`'s `maxWorkers` of 5 (#2772) and 1024 MB worker heap (§2) bind below it; and §2's heap bound rests on a reason independent of it (mantahostels#465).

⚠ **`.wslconfig` is read at VM boot, so a change to either needs a `wsl --shutdown`** — which kills every WSL process, agent sessions included. `nproc` and `free -m` are the tests that it took.

**`autoMemoryReclaim=gradual` means dynamic reclaim is already handled** — measured 17 August 2026: under it, free memory went ~96 MB → 2.9 GiB in ~80 s unaided, with zero dead-but-resident processes. So memory that stays occupied is memory something is still holding: look for the holder, and **never propose a reclaim setting as the fix**. The holder measured to date is the pool of finished-but-resumable Claude sessions, which `scripts/reap-finished-sessions.js` stops (§5, mantahostels#421).

**`/etc/wsl.conf`** — `[boot] systemd=true`, `[user] default=<login>`, `[network] generateResolvConf = false`. `systemd=true` is load-bearing: both guards below are systemd units, and `systemd-sysctl` applies the file below at boot.

**`/etc/sysctl.d/99-wsl-hvsock.conf`: `net.core.wmem_default = 28672`, `net.core.rmem_default = 28672`** (#2640). Every new WSL window and interop call opens a Hyper-V socket channel whose ring is sized from these defaults. At the stock 212,992 each ring needs one 512 KB (order-7) contiguous block, with no smaller fallback, so on fragmented memory the channel never opens (§7, 23 Oct). At 28,672 a ring is 24 KB (microsoft/WSL#40795); upstream's fix (PR microsoft/WSL#41690) is unmerged as of WSL 2.7.11. Cost: other non-TCP sockets get the smaller default too (TCP uses `tcp_rmem`/`tcp_wmem`), and upstream measured bulk Windows↔Linux transfers ~20% slower. Only channels opened after the change are small, so a session started before it keeps its old rings. Undo: `sudo rm /etc/sysctl.d/99-wsl-hvsock.conf && sudo sysctl -w net.core.wmem_default=212992 net.core.rmem_default=212992`.

**`/etc/resolv.conf` is hand-written, with `options timeout:1 attempts:3`** (#1564, #1565), so a router that never answers IPv6 lookups costs a lookup about 3 s, not 10-15 s. WSL hands every lookup to Windows through DNS tunnelling (`nameserver 10.255.255.254`), whatever address `resolv.conf` names, and `gh` (a static Go binary) honours these options but not glibc's `no-aaaa`. dnsmasq's `filter-AAAA` still forwards the lookup and waits (#1564). A `gh` ETIMEDOUT on a router slower than 3 s per lookup is this cap. Undo: `sudo bash ~/wsl-dns-1564/undo.sh`. Windows' IPv6 prefix-policy table is its nine-row default with `::ffff:0:0/96` raised to 45, so IPv4 is preferred (#1565).

**Windows Defender exclusions** — path `C:\Users\<you>\AppData\Local\wsl\<your WSL distro id>\ext4.vhdx`; processes `wslservice.exe`, `wsl.exe`, `wslhost.exe`.

---

## 2. Node heap bound

`~/.bashrc` exports `NODE_OPTIONS="--max-old-space-size=4096"`, which sets V8's `heap_size_limit` to 4288 MB (2240 MB without it). Claude Code inherits it.

Two limits:

- **Interactive-bash-only.** Anything not sourcing `~/.bashrc` — a systemd unit, `wsl.exe <cmd>` directly — gets 2240 MB. The normal path (terminal → login bash → `claude`) inherits it.
- **Bounds the JS old-space heap, not RSS.** Off-heap allocations sit outside it, so a process can still exceed 4288 MB resident.

**A vitest fork worker is capped lower, at 1024 MB** (`heap_size_limit` 1216 MB): `WORKER_HEAP_MB` in `scripts/lib/test-ceiling.js`, which holds the why, passed through `vitest.config.ts`'s `execArgv`. A runaway test then dies in its own worker, printing `FATAL ERROR: … JavaScript heap out of memory` and `Worker exited unexpectedly`, at about 1.1 GB resident (#3164).

<!-- guard-registry:begin -->

- **4096 stays. Never remove it, and never raise it. If a session needs more heap, cut concurrent sessions instead.** **Advisory** (#2025, mantahostels#465): `scripts/guard-node-heap.js` hands over `rule:node-heap` on a Bash command naming `max-old-space-size` or `max_old_space_size`, once a session. A `Write` or `Edit` of `~/.bashrc`, a heap set inside a script the command runs, and a mixed spelling such as `max-old_space-size` are never seen.

<!-- guard-registry:end -->

**Derived at mantahostels#465** for the 10 GB cap, on a reason independent of the cap:

- **Price a ceiling against headroom under load, never against MemTotal.** Parallel sessions are the intended workload (§6), so the loaded case binds: real headroom under load is **~1.5 GB**, already less than the 4288 MB ceiling.
- **The bound caps a runaway (§7); it does not license a large session**, so headroom is never the argument for raising it.

**It is not lowered either.** A bound under the ~1.5 GB of real headroom would sit below V8's own 2240 MB no-flag default; any value safe for sessions stays above headroom, so it buys nothing `earlyoom` is not already doing. A measured per-session high-water distribution would move it. The only sensible future direction is down.

---

## 3. earlyoom — the OOM safety net

```sh
# /etc/default/earlyoom
EARLYOOM_ARGS="-r 3600 -m 8 -s 100 --avoid '(^|/)(init|systemd|sshd|bash|sleep|dbus-daemon|[(]sd-pam[)]|memwatch[.]sh|[0-9]+[.][0-9]+[.][0-9]+)$'"
```

Sole OOM safety net while swap stays at 2 GB.

**`--avoid` spares what a kill frees nothing by (#3082, #3094).** earlyoom 1.7 matches it against comm and takes 300 off a match's `oom_score`. Claude hosts, pty hosts and spares are named by version (`2.1.310`). No `--prefer`: every node process's comm is `MainThread`, so no name can single out a test worker. **Spell a literal with brackets, never a backslash**: the value passes through systemd's `EnvironmentFile` quoting first.

**Each kill incident files one `takes:triage` ticket** — kills no more than 30 min apart, titled `Memory kill incident from <first kill's minute> UTC` — once 30 min pass with no kill (`scripts/file-memory-kill-tickets.js`, each refill-loop tick), and the morning review lists the window's kills by kind with each incident's ticket. Both read earlyoom's own journal lines, so it takes no `-N` script: Debian's unit runs earlyoom under `DynamicUser`, leaving such a script nowhere uid 1000 can read.

> **Trap — `-M` is not a swap flag.** It sets *minimum memory in KiB*. Passing `-M` alongside `-m` silently overwrites the percentage threshold to ~0.00%: earlyoom stays `active` and never fires. Swap flags are `-s`/`-S`. Conditions are **ANDed**, so `-s` must be `100` for the memory threshold to govern alone.
>
> Verify: `systemctl status earlyoom --no-pager` must report `mem <= 8.00%`.

---

## 4. memwatch — the incident recorder

`~/memwatch.sh` polls every 20s, appending a block to `~/memwatch.log` whenever used memory exceeds **7500 MB** **or busy CPU exceeds `MEMWATCH_CPU_THRESHOLD_PCT`, 600 of 800 by default (mantahostels#1953)**: top-6 processes by RSS plus the Claude session count and combined RSS, and the CPU split and load average. **A CPU-triggered block also carries** (#830) a `--- runnable N, uninterruptible N, of N tasks | runnable by command: … ---` line — a node, bash or python process named by its first non-flag argument — and the eight busiest tasks over one second, measured by memwatch itself from each task's `utime + stime` in `/proc/<pid>/stat`, because a lifetime %CPU average ranks an old idle session above a fresh spinning fork. **Every listing reads `/proc` itself, keeping each task's first 512 characters of argv (#2669)**: `ps` and `top -c` read every task's whole argv, so their memory had no bound. **Each pass also checks the scheduler clock, whatever the thresholds (#2779)**: it appends a dated `--- sched clock: frozen <time>: … ---` line when the run queues' summed `rq_cpu_time` (`/proc/schedstat`) advanced under 10% of the busy time in `/proc/stat` over at least 0.5 CPU-s, and `--- sched clock: running <time>: … ---` when it moves again. Read the session count to tell a runaway from ordinary parallel work (§6–7). **The 7500 MB is unmeasured at the 10 GB cap** (#2866).

⚠ **The two triggers are disjoint on this machine, so neither substitutes for the other** (mantahostels#1953). **A block whose CPU figure reads `cpu: unreadable` predates the delta** — the first pass after every restart has no previous sample to difference against. **The CPU limb averages over the 20 s poll, so a shorter spike is missed**, and it has a **60 s cooldown** so a sustained episode logs about once a minute rather than every pass.

Runs as systemd user unit `~/.config/systemd/user/memwatch.service` — enabled, `Restart=always`, `MemoryMax=128M`, `OOMScoreAdjust=-500`. The cap is about twice a measured pass at the per-user task ceiling, a headroom that is untraced (#2669). Lingering is enabled, so it starts at boot and survives logout; verify with `loginctl show-user <login> --property=Linger` (must be `Linger=yes`).

⚠ **`OOMScoreAdjust=-500` is declared but inert, so the kernel's OOM killer takes the recorder *first*, not last** (mantahostels#1127). The live process reads `oom_score_adj` **100**, because `user@1000.service` is itself pinned at `OOMScoreAdjust=100` and an unprivileged user manager cannot lower a unit below its own value. earlyoom spares `memwatch.sh` and its `sleep` by name (§3), but the kernel's killer, which fires only where earlyoom has not, still ranks them first. Fixing that needs root — a drop-in lowering `user@1000.service`'s `OOMScoreAdjust`, or moving `memwatch` to a system unit — and neither is done.

⚠ **Check it is actually running before reading anything into a gap in the log** — `systemctl --user is-enabled memwatch.service` must read `enabled` and `is-active` must read `active` (mantahostels#1495): a quiet stretch may be the recorder being off rather than a quiet machine.

Rotation is built into the poll loop — no cron, no logrotate. Above **500** blocks it truncates to the last **200**, appending the blocks it trims to **`~/memwatch-archive.log`**, which keeps the last **28 days** (`MEMWATCH_ARCHIVE_DAYS`) (#2741). The live log holds about a day, so a longer reading takes the archive and the log together.

**Every minute, quiet or not, memwatch also appends one JSON line to `~/memwatch-minute.jsonl`** (#3214), so a trend reading has a row for every hour, not only the busy ones the blocks record: `load1`, `load5`, `running` and `threads`; the `avg60` of CPU `some`, memory `some`/`full` and IO `some`/`full`; `mem_avail_mb`; `cpu_busy_pct` and `cpu_sys_pct`, of 800, and `forks`, the processes created, each since the previous line (null on the first line after a start); counts of `procs`, `node`, `guards` (a node running `scripts/guard-*.js`), `vitest`, `tsc` and `lander` processes running at that instant — a guard lives ~0.1 s, so read hook fan-out from `forks`, not `guards`; and `sessions`, §5's count less the daemon's spare, read through `scripts/lib/claude-sessions.sh` in this checkout and null where that is missing. It reads `/proc` alone, never `claude agents --json`, which times out under the load it is recording. Lines older than **28 days** (`MEMWATCH_MINUTE_DAYS`) are pruned once a day, so the file holds up to 29. A pass more than a minute late skips that minute.

---

## 5. Daily use

| Command | Does |
|---|---|
| `memcheck` | The only command needed by hand. Memory vs cap, sessions with each one's live heap bound, earlyoom state and threshold, memwatch state, last incident. |
| `claude-count` | pid / RSS / elapsed / role per Claude process, plus session count, process count and combined total. |

A warning prints on interactive shell start only when `MemAvailable` is under **2200 MB** — under what one more session's draw needs at p95 above earlyoom's kill line, with nothing else running. Owned by `scripts/shell-start-warn.sh` (`WFC_HEADROOM_FLOOR_MB`, default 2200), sourced from `~/.bashrc` when the repo is present, silent-by-absence otherwise.

**Derived, not measured:** earlyoom fires at 8% free ≈ **794 MiB** of the 10 GB cap (§3), admission holds a **300 MB** margin above it, and one session's draw at p95 is the default μ + 1.645σ = 587 + 501 = **1,088 MB** (below): 794 + 300 + 1088 = 2182, rounded up to 2200. **Re-derive the floor when any input moves**, and with it `WFC_HEADROOM_FLOOR_MB`'s default, which the swap hold's computed figure must equal (#2690) — it follows the default draw, never a repo's declared one (#2139). Session count and combined RSS appear in the message as diagnostic context only — an upper bound. **Never re-baseline a session-count threshold here**: a count fires on the intended workload (§6), and finished sessions are the reaper's job (mantahostels#578).

**Match Claude processes on `argv[0]`, never `comm`.** The binary lives under `.../claude/versions/<version>`, so a backgrounded session's `comm` is the version string, and a `comm`-only matcher misses every session (mantahostels#481). Three `argv[0]` shapes run at once: bare `claude`/`claude.exe`, the launcher path `.../bin/claude`, and the versioned binary itself, which is what a **resumed** session runs — miss the third and one live session goes uncounted.

A **session** is counted from its `bg-pty-host` — the pseudo-terminal host process, one per session alongside its `bg-spare` worker. **Not from `bg-spare`**, which undercounts: a resumed session re-execs its spare. A host outliving its session inflates the count, and a session driven interactively in a terminal spawns neither process and is missed entirely — so the process count and combined RSS are reported beside it, not derived from it. **Match `argv[0]` here too**: a shell pipeline whose command line merely mentions `bg-pty-host` otherwise reads as a session. **Combined RSS double-counts pages shared across these near-identical processes and can exceed the machine's own total**; it bounds the workload from above, and the `free -m` figure on the same line is the real one.

**Less the daemon's unclaimed spare (#1798).** The daemon keeps one pre-warmed `bg-pty-host`/`bg-spare` pair resident and unclaimed at all times, so counting every host reads one high. Every host carries a `<daemon>/spare/<id>.pty.sock` argv, claimed or not, so no argv match tells them apart; the `bg-spare` child's cwd does — an unclaimed one still sits in its own claim socket's directory, and a claim moves it to the job's cwd. `scripts/lib/claude_sessions.py` and its twins `scripts/lib/claude-sessions.sh` and `scripts/lib/claude-sessions.js` hold that test; a cwd they cannot read counts as claimed. **A claim with no job record counts as a session** — from outside the same as a job seconds before its first turn, and real load either way. **Rows recorded before 17 October 2026 00:54 UTC count the spare** — the bench's `sessions_live` and `record-divergence.js`'s `sessions` read one high wherever the daemon ran. `claude-count` (`~/.bashrc`) and `~/memwatch.sh`, outside this repo, still count every host.

**This is the reporting unit, not the admission unit.** Session *admission* counts what `claude agents --json` lists — see *Session admission* below. The commands above and `scripts/bench_suite_concurrency.py` keep the pty-host count deliberately: it is sampled repeatedly on a machine whose memory is the thing being measured, and the oracle starts a Claude process of its own to answer.

**A watchdog holding pids must be told when each is reaped**, or it kills a neighbour's live session. A reaped pid is free for the kernel to reuse immediately, so `os.killpg(pid, SIGKILL)` after the reap signals whatever now owns it (mantahostels#463). Two traps in the same harness: `preexec_fn` in `subprocess.Popen` is unsafe once any thread exists — set `oom_score_adj` from the parent after `Popen`, re-applying across the tree each sample, since it is inherited only at fork and npm forks vitest ~1 s later. And killing a process group means `npm` never reaps its `vitest` children, so their rusage never rolls up into `wait4` — **CPU on an aborted run reads near zero and is not a measurement**; label it rather than reporting it.

### Session admission — the aggregate draw at p95, never a fixed count

Owned by `scripts/lib/admission.js` (`DEFAULT_SESSION_DRAW`, `drawSlots()`, `admissionFrom()`, `strictAdmission()`), which `scripts/pick-next.js` and `scripts/admission.js` — the dispatch-time re-read — share (mantahostels#1144). **How many sessions may run is read per run, not fixed**, and **at least one is always admitted when nothing of ours is running** (Bazel's local resource tracker rule). Ruled at #2221 (the ticket that replaced the per-slot price with the aggregate draw). k more sessions are admitted while

`Σμ + k·μ + 1.645·√(Σσ² + k·σ²) − the live sessions' current PSS + (k − 1) · pending pair ≤ MemAvailable − pool reserve − lander reserve − 794 − 300 + reclaim credit`

**One session's draw is its pair plus every process it starts** — a *pair* being the session process and every `claude` process sharing its `/spare/` socket id, its `bg-pty-host` where it came from the pool, and a session with no such socket its own process alone — measured as a mean μ and a standard deviation σ. Σ runs over the live sessions (*Counting live sessions* below), each at its own repo's draw; the bare μ and σ are this host repo's, whose sessions are the ones admitted. **Current PSS counts descendants too**, the unit μ is measured in, so a running suite's memory is charged once, through it. 1.645 is the normal p95; the 300 MB margin above earlyoom's **794 MB** kill line is the suite gate's (mantahostels#463), fitted, not measured.

**No memory is held back for sessions' suites** (#2305). The pooled μ and σ carry the suites #2231's sample saw, a vitest suite being live in 39% of its working samples, so they charge suites at the rate it saw them; and a suite launched short of its §6 ladder rung is refused and waits in the queue until the rung is free. A wait the rung still holds at the queue's 40-minute timeout is refused (#2421). A part-suite the count cap holds at that timeout runs anyway with memory unread, the guard judging the cap first: that is the residual that lands a queued suite on memory admission sold. The suite-free draw, μ 440 MB, σ 260 MB, is not declared: no aggregate check has tested it against measured sums, as N4 and N5 tested the pooled one.

**The lander reserve holds the lander's suite** (#2416; `landerHeldMb()`), which runs outside every session, so no draw carries it. Each live `lander` queue marker, waiting or running, holds the local tester's `SLOT_MB` less the 794 + 300 above, less the current PSS of the processes it started, which `MemAvailable` already shows. A lander a session started is held its whole draw, since that session's PSS already credits it.

**A session floor overrides the p95 pricing while `~/.claude/session-floor` holds an integer** (#2501, the founder's stopgap of 22 Oct 2026 until #2495's spec lands; `sessionFloorSlotsOf()`): admission admits at least that many working sessions less those the oracle reads `state: working`, the caller counted, and prints `FLOOR:` and a `session floor` line. The CPU ceiling and the overload hold still bind it, and each floor slot needs free memory, less the pool reserve but not the lander's, to hold one more session's μ above the 794 + 300. A file that will not read or holds no non-negative integer is no floor, and the `session floor` line says why. The file is host configuration, like `~/.claude/refill-seats`, because every repo's sessions share the machine; `WFC_SESSION_FLOOR` replaces it, and the suite sets it empty.

**The floor grants no slot while swap and free memory are both short** (#2690, ruled at #2668; `swapHoldOf()`): `SwapFree` under 25% of `SwapTotal` and `MemAvailable` under 2,200 MB, the shell-start floor in §5 above, read off the same `/proc/meminfo` read. The p95 slots, the CPU ceiling and the overload hold are unchanged, both verdicts carry it, and the `session floor` line names the hold with the swap and available figures. No swap, or no swap lines, is no hold. `SWAP_HOLD_AVAILABLE_MB` derives the 2,200 from the same inputs, so it moves with the floor; the suite holds it equal to `WFC_HEADROOM_FLOOR_MB`'s default.

**A repo declares its own draw, `sessionMeanMb` and `sessionSigmaMb` in `.claude/workflow-core.json`.** An undeclared or malformed figure reads as the default, **μ 587 MB, σ 304 MB** — the pooled draw of every working session #2231 (the ticket that last measured it) sampled, every one of them workflow-core's. The ADMISSION block says which applied. **Recompute a repo's figures when a hook or suite runner in it changes, and after earlyoom kills one of its sessions:** `python3 scripts/sample_session_memory.py run <dir> --duration 2700 --interval 3` under normal load, then `analyse <dir>`, whose `working_total` mean and sd are the figures; its aggregate check compares the model's p95 with the measured sum's per session count.

**The pool reserve is one idle spare pair's PSS** (#2223, the ruling; `poolReserve()`): this pool's idle pairs' PSS over their count, the `daemon run` process left out (#2283), or 106 MB where it holds no idle pair, plus that price again for the spare a launch is about to warm (`--launch`, and pick-next's free slots, each a launch), and on those reads again for each slot past the first, so N slots are N launches each re-read admits (#2511, #2568). Not the whole pool: it is resident, so `MemAvailable` already excludes it; one pair is what a spawn beyond the daemon's claims can add before the next reading. The breakdown's `daemon + spares` row still shows the whole pool as resident. An unreadable pool reserves nothing, failing open.

**Price a session off its whole run, never off age or context** (mantahostels#537).

**Refill continuously, not in batches (mantahostels#384):** release one job as one completes. What that bars is the synchronisation barrier, not filling idle slots up to the admission limit — selection answers with the whole startable set and recomputes on every issue close (mantahostels#510).

**Counting live sessions (mantahostels#437):** the count is the sessions `claude agents --json` lists, read through `scripts/lib/agent-liveness.js`, **less this run's own** — that reader's self-test guarantees it lists its own caller. It **degrades to unknown, never to a number**: on any answer the reader will not vouch for, admission falls through to the headroom. The process scan survives as a **display-only** count printed beside it, matched by the `argv[0]` rule above. An **interactively-driven terminal session** spawns neither `bg-pty-host` nor `bg-spare`, so the display-only scan counts it as none — but the oracle lists it (`kind: "interactive"`, within 5 s of launch, while idle at the input box; measured 19 August 2026 at mantahostels#594), so the session count reaches it and the memory figure sees it either way. Its record carries no `state` or short `id` field, so the reaper's background-only conjunction can never take it. Not listed: a `claude` spawned with another session's `CLAUDE*` env inherited — a fresh terminal launch does not inherit. ⚠ Untested, 19 August 2026: a session mid-turn (only idle was measured) and a resumed interactive session.

Cost is measured by **PSS, never RSS**, combined RSS being the double-counted upper bound described above (mantahostels#504).

### The bg-shell pressure reaper — a different reaper, captured and switched off

**Not the finished-session reaper below, and not `earlyoom` (§3).** This one lives in the CLI binary and kills a *backgrounded Bash job* of a main session (mantahostels#2690, mantahostels#2694): it arms on memory pressure and fires only while the session is idle — unless the session interacted within 30 minutes, the main loop is busy, or a subagent is live. The kill is a `SIGTERM` to the job's whole **process group**, issued by the session's own pid, and the `killed` notification is emitted *before* it, so a `killed` reports a kill **requested**. **So neither this document's memory ladder nor the suite gates are the place to look when a background job dies**; the trigger is idleness, and `docs/agents/guard-registry.md` §Subagent dispatch mandates exactly that idleness while a job runs.

⚠ **A background-job session is NOT exempt: both session kinds arm the reaper** (mantahostels#2694, mantahostels#2695). A neighbour's resumed session may also reap your jobs, outside your own subtree (mantahostels#2695 §4.3, 45%).

**`CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1` is the escape, it works, and it is in force.** It has to reach the HARNESS's environment, not the job's: a prefix on the backgrounded command reaches only the child process, which the reaper never reads. Two placements do reach it — **`.claude/settings.json`'s `env` block** (mantahostels#2763), no agent having got a write to that file past the auto-mode permission classifier on four routes across two sessions; and **an export in the shell that launches `claude`**, a per-terminal alternative no agent session can set for itself. Both are read at session start, so **neither takes effect in the session that sets it** — unlike the `permissions.allow` edits §10 describes, which do. `.claude/settings.local.json` was declined rather than untried: it is gitignored, so the setting would leave no repo record, and §10 bars an agent editing it at all. **`scripts/bg-shell-reaper-escape.test.ts` holds the settings-file placement** — a revert, a merge or a `claude` upgrade dropping the key fails the suite rather than silently restoring the hazard (mantahostels#2851). It sees neither the shell-export placement nor a session launched outside this repo.

**Verified at mantahostels#2694, held at ~95% (88-98%)** (mantahostels#2695 holds the evidence). A session wanting the arm read live must read `/proc/<pid>/environ` itself, from its own process chain. **The protection is per-session and repo-scoped:** a `claude` launched with a cwd outside this repo reads neither `.claude/settings.json` nor `CLAUDE.md`, and is unprotected — that is how mantahostels#2694's window 3 died. `bg-run.sh` writes `bg-launches.jsonl` beside `bg-kills.jsonl` in the git common dir, one line per launch carrying its arm, so a kill RATE stays readable rather than an anecdote (mantahostels#2763); it counts LAUNCHES, not survivals, and where the founder takes the shell-export placement every launch carries the same arm and the split reads nothing. `scripts/bg-run.sh` stays the defence regardless, a dropped notification being a separate hazard this setting does not touch.

**A known unknown, and settled as one (mantahostels#2695).** Why the reaper should fire 2.2x more often per idle-hour on a queued suite than on other work is **unexplained and unreachable by userland instrumentation**: `strace` on `kill`/`tgkill` plus `/proc` sampling names the sender, and did, but cannot see what emits `memoryPressure` inside Bun's native watcher. The two methods that could — kernel-side tracing of the PSI trigger fd, or disassembling the ARM64 native section — are named at mantahostels#2695 and neither is ticketed, mantahostels#2692's posture having declined the first. **Do not reopen it from the corpus:** mantahostels#2517's counts are exhausted and mantahostels#2678 ruled a re-count out of scope. The leading candidate, **55% (40-70%)**, is that the event rate tracks machine pressure and a queued suite is alive by construction beside a running one — testable only from `kills.jsonl`'s accumulated `mem_available_mb` and `queue_state`.

**The variable also suppresses the phenomenon mantahostels#2694 was provoking.** Any instrumented run that needs kills must unset it for that session.

### The finished-session reaper — five figures, two checked, three unchecked

Owned by `scripts/lib/reaper.js`, which `scripts/reap-finished-sessions.js` calls — the constants `GRACE_MS`, `HOLD_MS`, `MAX_PER_RUN`, `RETRY_BASE_MS` and `RETRY_CAP_MS`.

A background Claude session that has finished does not exit; it stays resumable and keeps its memory, so `pick-next.js` under-admits against real capacity (measured at mantahostels#421). The reaper stops one only when its registry record reads `kind: bg` and its job record `state: done` with `tempo` not `active`, it is not the reaper's own session, its registry record names a job id, it **finished** — the grace is **0** (mantahostels#1290), a strict-past check, not a wait — and its transcript tail shows its last turn ended. **Nothing waives it.** At most **10** sessions are stopped per run.

**A job reads `done` before its Stop hooks run** (#2980), and a hook that blocks forces a turn under that same `done`; a stop inside it kills the corrected ending and can write `stopped` over the result. So a transcript whose last turn row is not a `turn_duration` holds the job until it is, or for **15 minutes** (`HOLD_MS`) from that last turn row's own timestamp (the file's mtime moves with bookkeeping rows); a transcript that cannot be read holds it the same 15 minutes from its last write. The refill loop re-ticks once, 10 s on, after a wake whose session it still lists `done`, so a held job is not left to the 5-minute fallback poll. **`HOLD_MS` is measured** (#2983): the longest silence inside each of 7,848 completed forced turns in background-job transcripts (to 26 Oct 2026) runs p99 553 s and p99.9 612 s — the Bash tool's 600 s timeout cap plus overhead — and 3 (0.04%) passed 900 s, so 15 minutes is the p99.9 plus padding. An unreadable tail's clock is never earlier than the last turn row, so it holds at least as long; a missing transcript runs from the first sighting, where no silence can be measured — **quote the window as unchecked for that case**. Of the 51 reaps in the first 10.5 h under the gate (from 2026-10-25T20:25:58Z, when the refill loop adopted it), the 50 forced turns ran p50 10.9 s, p99 115 s, max 167 s from `firstTerminalAt` to their closing `turn_duration`; none reached the hold and none lost its result to `stopped`.

**It reaps every seat, not only the one it runs under** (#1571). The listing spans every seat; `claude stop` and the job record are per seat, so each session is stopped on the seat whose `jobs/<id>/state.json` names it, and a stop refused with `No job matching` is tried on the other seats before it is reported. A seat whose record of that id names another session is never asked.

**The reaper reads no memory at all**: admission's figures are `scripts/lib/admission.js`'s alone, with nothing here to keep equal to them.

**Idleness runs from when the session finished, not from when the reaper first saw it finished** (mantahostels#655) — the gate `GRACE_MS` compares against, whatever its current value. Idleness is `now − max(firstTerminalAt, transcript mtime)`: `firstTerminalAt` comes from `jobs/<job-id>/state.json` on that seat, read only after the liveness gate and never advanced by a resume. **Both terms or neither** — if either read fails, the reaper falls back to the first-sighting clock. The transcript path is derived from the job record's `cwd` plus the listing's `sessionId`, never the record's own `linkScanPath`, which on a resumed session names the transcript it resumed *from*.

**A file claim does not keep a finished session from being reaped** (mantahostels#747), and `release --force` reaches any holder the oracle has called ended, a finished one included (#268).

**No claim is released, and that is why expiry stays refused.** The reaper reads no lock and breaks none. A lock is breakable once its holder's **host process** is dead, so `claude stop` drops it into the ordinary stale class and the next claimant breaks it by the rule already there — not an expiry, and not `release --force`, which is never called. The run **names** each lock it leaves stale, marking one carrying uncommitted work `(DIRTY)`; that naming gates nothing. **An unreadable claim store costs the naming alone** — it aborted the whole run until mantahostels#747.

**A stop is not a kill: it returns ~300 MB and leaves the conversation intact** (mantahostels#492).

**Every run leaves a record at `~/.claude/wfc-reap-run.json`**, one row per mode (`live`, `dry`). **This is where to look when a session start went quiet**: the start half is written before the listing read and the stops, so a row with a start stamp and no finish stamp is a reap that died mid-run, and every session it should have stopped is still resident. Not a run cancelled at a ceiling: the registration is `async: true`, where the `timeout` is inert ([docs/research/async-hook-timeout-enforcement.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/async-hook-timeout-enforcement.md)), so a live run ends with the session instead. `scripts/check-hook-liveness.js --only reap` reads it and says so, on `npm run status` (mantahostels#1931). **A single row's own age only ever catches the `dry` half** — the `live` one reopens at every session start whether or not the previous attempt closed, so a live row read here is always the current start's, never old enough to call dead. **mantahostels#1952 closed the gap with a count carried in the row itself**: `openRun` tracks `deaths`, consecutive un-closed opens of one mode, ageing from `openedSince` (fixed at the first open of an unbroken run, not overwritten by a reopen) rather than `startedAt`; a row closing at all resets it to zero. `check-hook-liveness.js` reports a `live` mode once `deaths` reaches **3** (`REAP_LIVE_DEATHS_TO_REPORT`, a guess mirroring detached-run.js's own — quote it as unchecked) — a healthy `live` close takes about **5 s**, so a row still open on the next read is not a run merely running long.

**The two window figures — the stop cap of 10 and the grace window — were reasoned to, not derived.** Only the cap carries a check (mantahostels#492, whose live day ran a since-cut window). The cap has yet to bind. Stop latency is hook cadence — a session start, or `npm run test`'s `pretest` since mantahostels#1840 — not the grace window, so a cut buys a reap only where two of those straddle the window it replaced. **Quote the 0-minute grace as unchecked.**

**A stop that failed is not retried at the next session start** (mantahostels#846). The listing and the stop oracle can diverge: a job record reading `state: done` is still listed after the daemon has forgotten the job, so `claude stop <id>` answers *"No job matching '<id>'"* and exit 1 however often it is asked. A failure is recorded beside the stamp and the next attempt held off **1 hour**, doubling per consecutive failure to a **24-hour** cap; the record is dropped by a stop that works, or by the session leaving the listing. **A stop that hits its 15 s timeout opens no window** (#2665): it is a busy daemon, not a refusal, so it is retried at the next run. **Nothing else waives this window** — as with the grace above, and for its own reason: a refused retry returns no memory. The held-back session is still named in every run's report. **Both figures are reasoned, never measured — quote them as unchecked.**

**The reaper reads no CLI listing** (#2665): its pool is `scripts/lib/registry-agents.js` — each seat's `sessions/<pid>.json`, kept only where `/proc/<pid>/stat`'s start time matches its `procStart`, joined to that seat's `jobs/<jobId>/state.json`, which must name the same session. Safe only because the reaper acts on what a record says: a missing or garbled record reaps less, never the wrong session. Every reader that judges a session dead by its absence keeps the CLI listing. A seat whose registry will not read is named in the report, its sessions' state rows are kept, and the other seats are reaped; where no seat reads, the run reports BROKEN. The refill loop reads both listings each tick and logs `listing drift:` where they disagree.

**Admission credits the reaper's own dry-run plan, never a re-derivation (mantahostels#1288).** `claude agents --json` lists a finished-but-resident session exactly as a working one, so its memory reads as spent even though the next session start's reap (§5's own account above) is about to return it. `scripts/lib/admission.js`'s `reclaimableMb()` spawns `reap-finished-sessions.js --dry-run --json` — which applies every gate above, grace window included — and sums `pss` across its `reaped` list; a spawn failure, an unparseable plan, or an individual entry whose own `pss` cannot be read all credit **0**, never a guess. **The credit reaches `slots` in full, and `suites` only to lift 0 to 1** (mantahostels#1930). mantahostels#1840 then gave the suite its own reap, as an npm `pretest` (`scripts/pretest-reap.js`), so **below the one-suite rung the pool is returned by the run itself**. Two limits keep it honest: admission cannot know how many suites a launched session will find running, so it credits only the one-suite rung, although the pretest reaps against the rung for the suite being started (#631); and it never refuses, printing and continuing on a pool that stays short, so the credit answers *may this run at all* and never *may a second suite join it*. `scripts/admission.js`, the dispatch-time re-read, wires this in; `scripts/pick-next.js`'s own (stale-by-design, per §5's re-read pointer) ADMISSION block does not, to avoid a second oracle spawn against the very figure it is measuring (mantahostels#653) — its `reclaimable` row still reports the raw finished-session count, ungated by the reaper's grace window, and continues to mean the headroom above may be understated.

---

## 6. Parallel sessions are the intended workload

Deliberate, not accumulation. Steady state ~250–500 MB per session plus ~200 MB MCP overhead. **No fixed session count applies**: `scripts/pick-next.js` admits against headroom measured per run against the live sessions' draw at p95, above earlyoom's floor (§5), dividing whatever `MemAvailable` reports.

The binding constraint **on memory** is **single-session runaway growth**, not session count. earlyoom kills the largest consumer and leaves the rest running, so a runaway costs one session rather than the machine.

⚠ **On CPU it is the other way round, and session count is exactly what binds** (mantahostels#1953, 30 Aug 2026). At ~36 session processes this machine sustained **553–778% of its 800% ceiling**, and **71–100% of that busy CPU was Claude sessions** — test suites drew 0–187% across the same windows.

**Do not raise the WSL cap on parallelism grounds alone.** Raise it only if `~/memwatch.log` shows total above ~**8.8 GB** — 88% of the cap, the same fraction ~7 GB was of 8 GB — **with no single process spiking**.

**This test fired on 17 August 2026 and is what licensed the 8 → 10 GB raise** (§1). In every crossing the largest process was 620–772 MB — accumulation, against the §7 runaway's *single* process at 7317 MB, which is the distinction this test draws.

### Concurrent test suites — one whole suite at a time, on a headroom ladder; builds stay at one

**All three rungs are measured at 3 workers a suite (#1603), off one interleaved six-row bench.** **A whole suite runs 5 workers, W** (`maxWorkers`, `WHOLE_SUITE_WORKERS`; #2772): with one whole suite at a time, a lone run's 5 worker processes plus vitest's main process make 6. Any number of part-suites may run beside it (under 121 files, or a touched run at any count, #2931, #2935), each adding up to 6, held by the memory rung rather than a count cap, and each yields the CPU to the whole suite by `YIELD_NICE` (#2955). A rung is priced by total workers, so a lone W ≤ 9 stays inside the measured ladder; a lone 5-worker suite's 2,900 MB rung is interpolated between the 1- and 2-suite rows, not measured at 5 workers.

A count is admitted by what it needs *resting* in `MemAvailable` immediately before the set launches: **~2.15 / 3.25 / 3.65 GB for 1/2/3 three-worker suites** (3 / 6 / 9 workers; a lone whole suite at W = 5 is charged ~2.9 GB), and there is no flat allowance above the ladder. The constraint is the trough staying clear of `earlyoom`'s 794 MB line. **Four is unmeasured on today's suite and nothing here licenses it** (mantahostels#462). Builds and dev servers stay at **one** — an unmeasured workload keeping the conservative limit; never generalise the suite figures to `next build`. **`tsc` runs at one too, machine-wide, on a rung of its own: ~2.75 GB resting** — its 1,638 MB peak RSS (`~/memwatch-archive.log`, 23–27 Oct 2026) above the 794 MB line and the 300 MB margin (#3163, after #3113's earlyoom kill of a `tsc`). `npm run typecheck` waits for that slot through `queue-run.js --tsc`, in a queue of its own, so it never waits behind a suite; a bare `tsc` the slot would hold is refused and handed that form. An open `tsc --watch` holds the slot for as long as it runs, so a type-check behind it waits out the queue's 40-minute bound and is refused. The pre-commit hook's warn-only type-check never waits: its commit holds `.git/index.lock`, so it tries the slot once and skips on a held one (#3278).

⚠ **THIS LADDER PRICES A SUITE THAT IS RUNNING. It says nothing about one that has STOPPED, and the two look identical from the outside except in one respect: a stopped run emits no output at all.** The whole 223-file suite is ~270 s on a quiet machine (mantahostels#1910, measured at 8,024 MB resting); a run past that printing nothing is parked, not slow. A parked worker consumes no memory and no CPU, so no rung, `maxWorkers` value or heap cap can move it. The cause is a synchronous call that never returns; vitest cannot time one out, because `testTimeout` is enforced on the event loop such a call never yields to. The measured example is `fs.mkdirSync(p, { recursive: true })` under `/proc`, which on this kernel never returns at all. `scripts/run-vitest.js` kills a run after **5 minutes of silence** and names the file it parked in; `WFC_TEST_STALL_MS` moves that watchdog, 0 disables it.

**No suite run holds the machine past 14 minutes** (#2667, the ruling; #2680, the spec). `scripts/run-vitest.js` kills every run **840 s after vitest spawns**, whatever its output or the load, and the clock starts after any queue wait, load hold or worktree setup. The kill takes vitest's whole process group, exits 1, writes no pass marker, records a `ceilingKill` row in the fail store, and prints the files in flight, the files never started and how many finished. `WFC_SUITE_CEILING_MS` may lower it, never raise or disable it; the figure lives in `scripts/lib/suite-ceiling.js`. `npm run test:py` (`scripts/run-pytest.js`) runs under the same ceiling: the kill takes pytest's group, xdist workers included, exits 1, writes no marker, and prints the tests in flight with their stage and the never-started and finished counts (#2702). The two timers are independent: whichever is due first kills the run. **It wraps `npm run test` and `npm run test:changed` and nothing else** — the registry bullet below has what that leaves open.

**A green whole vitest suite is held to 80% of that ceiling (672 s)** (#2729), an untraced margin that warns before the ceiling and does not hold a week's growth (23% in the week #2729 measured). The figure is `TARGET_MS` in `scripts/lib/suite-ceiling.js`, a fraction of `CEILING_MS`. `scripts/check-suite-margin.js`, on `npm run status`, reports the latest green whole suite (`scope.full` set, every module run) that took longer, or, where the lander splits it by `fullTestShards` (#2996), the latest green run of each shard over the target, each shard holding its own ceiling (`scope.shard`, or `--shard=k/n` in the argv of a marker older than #3090), with its sha, duration, machine reading and slowest files. A whole suite or shard the fail store records as killed at the ceiling since that green run is named too, with what was in flight, and a shard with no run to judge warns (#3237). It never refuses (#1797).

**The lander's whole run is split into `fullTestShards` shards (2 here), each a `--shard=k/n` run in a suite slot of its own and under its own ceiling** (#2996). Two, because the whole run on 8c5262228 reached 540 of about 667 files in its 840 s at load ~18; a shard that nears the ceiling wants a third. The batch is red where either shard is, and no verdict at the first shard that reaches none. `scripts/lib/local-tester.js` builds the shards from `.claude/workflow-core.json`; an adopter with no `fullTestShards` runs `full_test` whole.

**Here the lander's tester is the Actions one** (`landingTester: "actions"`, #2413). `scripts/lib/actions-tester.js` reads the `scheduled-checks.yml` run that a push to `landing` started at the batch tip; that run's Vitest is an 8-job `--shard` matrix in `.github/workflows/ci.yml`. A missing, unfinished or unreadable run is no verdict. The local tester runs only what no push run covers: a rerun of named files, or a bisect commit no push ran. So the suite loads this machine only on a red batch.

**The count is of concurrent suite launches, never of sessions** (mantahostels#1476, the ticket that corrected `.claude/skills/pick-next/SKILL.md` §5 on this). The ladder is applied per launch, inside an already-admitted session, by `scripts/guard-suite-concurrency.js`, a `PreToolUse` hook that WARNS on the ladder and DENIES a suite only past its last rung. How many sessions may run or be dispatched is session admission's to judge (§5).

**A suite vitest does not run counts too (#330): `node --test`, `pytest`, `python3 -m pytest|unittest`, a bare `python3 <x>.test.py`, and any script a host declares under `suiteRunners` in its `.claude/workflow-core.json`.** Each is counted and judged as one full vitest suite — an assumption, since the ladder was measured on vitest alone. A declared runner is visible only to the guard running in the host that declares it. **Each queues through `scripts/queue-run.js`** (#1776): `node scripts/queue-run.js -- <command>` takes a place in `--queue`'s line, waits on the same gate, and is what the count-cap deny hands such a launch as its line one, and an npm `test` script that does not run `run-vitest.js` too. It runs no launch `--queue` can reach.

**One whole suite runs at a time, machine-wide (#2680), so no run is stretched by others beside it.** `WHOLE_SUITE_MAX` (1, `scripts/lib/suite-ladder.js`) is the count cap; `SUITE_MAX` (3) stays the ladder's top. Rungs 2 and 3 price a second or third whole suite that runs anyway through the `WFC_SUITE_CONCURRENT=1` escape, and the part-suites beside a whole one.

**An open watcher — `npm run test:watch`, a bare `npx vitest`, or `npm test -- --watch` — counts as one suite on the ladder for as long as it stays open, not only while a re-run is in flight** (mantahostels#1927). The guard's runner line cannot tell an idle watcher from one mid-run — a watcher's argv is fixed at spawn and identical either way. Two things justify the full rung over a re-run-only price: **the reading is a snapshot and the admitted suite runs for minutes** — "idle right now" says nothing about the window a suite launched beside it is actually exposed to; and the asymmetry of the costs — over-counting costs a refusal until memory frees, under-counting costs an `earlyoom` kill. ⚠ **The basis is explicitly unmeasured**: no bench row below has ever held a watcher open, and `scripts/bench_suite_concurrency.py` cannot, since it waits for every suite to exit — what an *idle* watcher actually dips is unknown. **What would settle it:** a bench row that holds a watcher open through another suite's dip.

**For suites, memory binds, not CPU.** Three suites draw **537.6% of the 800% ceiling** (mantahostels#1841, `rusage`-derived across a 194-file suite).

⚠ **Four things invalidate the ladder, not three: a total worker count past the ladder's measured 9, a heap change that reaches what a legitimate worker uses (§2's 1024 MB worker cap clears every one memwatch has recorded), or a core-count change — and A CHANGE IN THE SIZE OF THE SUITE ITSELF** (mantahostels#954, where the suite grew 175% with the other three untouched and two suites then aborted at a headroom the ladder called safe). **`scripts/check-suite-size-drift.js` reports that fourth one** — WARN-only, on `npm run status` and in the daily repo-checks run, off `SUITE_LADDER_MEASURED_AT` in `scripts/lib/admission.js`. It counts test *files*, not tests, and a file that grows its own assertion count without being added is its blind spot.

**THE WHOLE LADDER IS MEASURED AT 3 WORKERS A SUITE, 16 October 2026 (#1603)** — one interleaved six-row bench on a 485-file / 19,646-test suite (485 tracked, the drift check's count; 483 collected), two stationary rows per count. ⚠ **File count is a weak proxy for the dip**, though it is what `check-suite-size-drift.js` watches: against mantahostels#2705's 282-file bench, a suite 72% larger in files dipped 25%, 6% and 14% less at the three rungs, all twelve rows of both benches `baseline_stationary: true`, so the stationarity check does not explain it and the cause is unmeasured. **A third worker's per-suite cost is not constant in the suite count**, so no rung is scaled from another worker count's dips (mantahostels#2705). **`SUITE_LADDER_MEASURED_AT` names #1603's bench**: with all three rungs off one run there is no stalest rung for it to track.

**The rungs: ~2.15 / 3.25 / 3.65 GB resting for 1/2/3 three-worker suites** — `earlyoom`'s 794 MB + that count's dip (**1,046 / 2,124 / 2,546 MB**, #1603) + the **~300 MB margin that is fitted, not measured** (mantahostels#463) — one flat margin across all three counts, never a per-count one — rounded up to the next 50 MB (2,140.4 / 3,218.4 / 3,640.0 MB before rounding).

**A run is charged by the vitest workers its test files can occupy** (#2558, ruled at #2557): a run resolving to fewer than 121 test files in its own repo (`WHOLE_SLOT_FILES`, a quarter of the 485 the ladder was measured on, #2931) is a part-suite of `w` = its files, up to `maxWorkers`, adding `w/3` of the dip the next suite would, 3 being the workers per suite the ladder was measured at; any other run is whole, at `maxWorkers` (5, `WHOLE_SUITE_WORKERS`). **A touched run is a part-suite at any count** (#2935): one naming its test files, a `--retest`, or the bare `npm run test` under `landing`. It never takes or waits for the whole-suite slot, and forks `w` workers; at launch the bare one, its selection unresolved, is charged `maxWorkers`. At launch the guard counts the files a command names; `run-vitest.js` resolves its selection once before it queues and carries the count in its launch record. **A running run is weighed by that carried count** (#2931), read off its process's environment; a run carrying none is weighed off the test files its runner line names (#2560, ruled at #2559), and a watcher, a run naming none, a non-vitest runner and one carrying a bare filter word each weigh `maxWorkers`. The rung is a function of the total worker count, the running weights plus `w`, and only a whole run counts toward the cap. The table's rows are whole suites running:

| whole suites running | 1 file | 2 files | 5–120 files (5 workers) | 121+ files (whole, unless a touched run) |
|---|---|---|---|---|
| 0 | 1,450 | 1,800 | 2,900 | 2,900 |
| 1 | 3,250 | 3,400 | 4,000 | refused by the count cap |
| 2 (past the ladder; the escape only) | 4,350 | 4,700 | 5,750 | refused by the count cap |

⚠ **The past-the-ladder row, and row 1's 5–120-file cell, are extrapolated**: their 10–12 workers pass the 9 measured, so it charges `w × 349 MB` per worker past 9, the one-suite dip's share per worker, on top of the 3-suite dip.

**Every rung rests on two rows of its own at 3 workers a suite** (#1603).

**Each rung takes the HIGHER raw dip of that count's two rows** — raw, not attributable: the attributable figure prices out a baseline shift that may be the suite's own unreturned memory, so it is the *lower* bound and a rung wants the upper.

⚠ **A `baseline_stationary: true` is NOT self-sufficient** — the harness's own docstring says a `false` is trustworthy and a `true` is not, and names `dip_over_rss_peak` as the corroborator, which mantahostels#1841's six all pass at 0.72-0.82. Quote it alongside the stationarity flag or the claim is unbacked. **mantahostels#1841's six ran grouped as `1 1 2 2 3 3`, not interleaved** — so a contaminant drifting across the 40-minute run was shared by each pair rather than split across it, visible in swap deltas that tracked run order (69.0/44.2/10.6 MB against 3.6/5.3/2.0 MB) rather than suite count. **mantahostels#1875 re-ran interleaved as `1 2 3 1 2 3`** (`~/bench-1875/waiter.log`) and the swap-delta split disappeared (84.6/95.1/0/72.6/44.5/41.6 MB, no run-order pattern) — the contamination signature is gone.

⚠ **The one-suite dip FELL 28% while the suite GREW 28%, and that is contamination in the old figure, not a saving in the new one.** mantahostels#954's three usable rows are all `baseline_stationary: false` under today's harness (`scripts/test_bench_suite_concurrency.py::test_the_three_954_rows_are_all_reported_contaminated`), most of the one-suite dip being drift.

⚠ **The whole ladder is extrapolated to where it is applied: no clean row has ever completed below 7,689 MB resting.** mantahostels#1841's six rested 8,865–8,987 MB and mantahostels#1449's three at 7,689–7,792 MB; the only rows that ever rested near a rung — mantahostels#463's 1,588–2,288 MB and mantahostels#954's two suites at 2,537 MB — hit the watchdog and yield no dip, and mantahostels#954's green rows are contaminated. **The gate cannot be measured at the gate**: `--require-quiet=3` is what makes a row trustworthy, and a machine quiet enough to pass it is a machine with 7+ GB free. **No row anywhere has produced an actual `earlyoom` kill** — the watchdog stops 150 MB clear of the 794 MB line, so every "unsafe" verdict on record is its, not the machine's.

**Two reading traps:** `SwapUsed` is a system-wide monotone gauge — quote a delta measured across the run, never the gauge. Read CPU from `wait4` rusage, never a 1 Hz sampler (4.1–4.7× under-report) and never a sampled RSS peak — **the dip in `MemAvailable` is the memory figure.**

**The six rows the ladder now stands on (#1603, 16 October 2026, 3 workers a suite, 485-file / 19,646-test suite, interleaved `1 2 3 1 2 3`, `--require-quiet=3`):**

| suites | raw dips | rung | wall | CPU of 800% | `dip_over_rss_peak` | swap delta |
|---|---|---|---|---|---|---|
| 1 | 943.1 / **1,046.4** | 2,150 MB | 638.1 / 634.2 s | 258.1 / 258.6% | 0.70 / 0.78 | 101.2 / 49.7 MB |
| 2 | **2,124.4** / 2,112.2 | 3,250 MB | 713.4 / 700.3 s | 468.8 / 472.8% | 0.75 / 0.79 | 182.7 / 87.5 MB |
| 3 | **2,546.0** / 2,390.5 | 3,650 MB | 935.9 / 863.6 s | 603.8 / 617.3% | 0.69 / 0.66 | 130.7 / 268.3 MB |

All six `baseline_stationary: true` (shifts 0–102.2 MB), `cpu_valid: true`, none aborted, none trivially aborted, none a `dip_is_lower_bound`. Resting 8,224–8,830 MB, troughs 5,859–7,718 MB. Never quote the absolute trough, which is a fact about how loaded the machine was. ⚠ **Three of the six `dip_over_rss_peak` readings sit under mantahostels#1841's 0.72–0.82 band**; quote both. **`sessions_live` read 3 for the first two rows and 2 after, but the founder's only other session finished before the bench began** — the count included the daemon's standing unclaimed spare and a claim with no job behind it (#1798, the counter's overcount). The first three-suite row saw that claim exit mid-row (3→2, shift 0 MB). **No row was green, for one reason**: each suite failed `scripts/run-vitest.test.ts > the stall ceiling from the environment > defaults where the variable is unset or empty`, whose unset case inherited the bench's own `WFC_TEST_STALL_MS=0` — a test defect fixed at #1603, never a memory effect. Raw JSON and per-suite vitest logs under `~/bench-1603/run-01/`.

**The mutation hold's Stryker run, off the ladder (#1851, #1912).** One cold run at concurrency 2 over Manta's 3,694 sensitive-path lines (the count is #1871's): 285 MB peak parent RSS, `MemAvailable` falling 2,796 → 2,072 MiB, a **724 MiB dip inside the one-suite rung's 1,046 MB** (the bench's MB is MiB), in 5 min 05 s. Its tests ran under vitest's `node` environment; a `jsdom` one's cost per worker is unmeasured. That is `CONCURRENCY` in `scripts/mutation-hold-gate.js`, the only setting measured. **`scripts/guard-suite-concurrency.js` never counts the run**: a commit starts it, and Stryker drives vitest through its API rather than `.bin/vitest`. commit-paths' pre-lock suite is started unjudged too, but a running one's `.bin/vitest` line is counted like any other run's (#2830). The pre-lock suite runs only where `commands.test` is gated at commit, which a command running `run-vitest.js` never is while the `suites` module is on, as it is here (`scripts/lib/test-gate.js`), so it never runs a suite sized by this repo's `maxWorkers`. One reading, not a bench row: no stationarity check, and nothing measured it beside a running suite.

**Measurement record:** full tables on mantahostels#229, mantahostels#352, mantahostels#462, mantahostels#463, mantahostels#954, mantahostels#1449, mantahostels#1841, mantahostels#1875, mantahostels#2673 and mantahostels#2705 and **#1603 (all three rungs)**; harness `scripts/bench_suite_concurrency.py`, raw JSON and per-suite vitest logs under `~/bench-1603/run-01/`. **Idle `MemAvailable` wanders up to 214 MB between two 20 s resting settles** with three sessions live (mantahostels#1449) — what `BASELINE_SHIFT_TOLERANCE_MB` is set from; mantahostels#1841 re-read it at **8.0 MB** on the same gate.

<!-- guard-registry:begin -->
<!-- Every rule here carries **Enforced** / **Advisory** / **Unenforced** / **Unenforceable**; `scripts/check-guard-registry.js` gates it. -->

- **A short memory reading is not by itself a reason to stop and report** — finished-but-resident sessions hold memory they are about to return, and `npm run test` reaps them before vitest starts. Only a machine still under the rung *after* a reap refuses a run. **Unenforceable** (mantahostels#1933, which built the guard after mantahostels#1843 deferred it): `scripts/guard-dispatch.js` (its `guard-headroom-read` core) hands a session the whole rule — which command reaps for itself, which needs the reap run for it, and the two limits — on its first memory read of the session (`rule:headroom-reap`). No hook can observe the conclusion a session draws from a reading, only the reading itself.
- **A suite launched under its ladder rung is refused and waits in the queue** (#2305). **Enforced**: `scripts/guard-suite-concurrency.js` denies a test launch while `MemAvailable` is under the rung for the workers it would add, its first line the same launch with `--queue`, or through queue-run.js for a runner that takes no flag, whose poll asks the guard until the rung is free. The queue re-reads it every poll. At its 40-minute timeout the last poll decides (#2421): a wait the memory rung holds is refused, the run leaving the queue, naming the reading and the reap, and exiting non-zero without spawning; a part-suite the count cap holds runs anyway. `npm run test`'s `pretest` reaps finished sessions before the wait. A run naming its test files is judged on its own rung (the table above), and a queued one waits for that rung; one resolving below 121 files takes none of the queue's slots (#2558, #2931). A `--queue` launch and a build are warned, never refused; a watcher is told to free memory first, no queue taking one. The escape is `WFC_SUITE_CONCURRENT=1`, recorded with `limb: memory`. Admission holds no memory for suites because of this refusal (§5).
- **A SECOND concurrent whole suite is refused: one runs at a time** (#2680). **Enforced**: `scripts/guard-suite-concurrency.js` denies the launch, as it denies one under its ladder rung (the bullet above), its first line the same launch with `--queue`. A run resolving below 121 test files takes no whole-suite slot and runs beside a whole suite, judged on its own rung (#2931), and so does a touched run at any count (#2935). Where another process's whole suite is running, `run-vitest.js` raises either's vitest nice by `YIELD_NICE`, so the whole suite takes the cores first (#2955). A whole suite let through past the cap — a `--queue` launch, or the escape — is warned "one at a time" where its rung is met, and on memory where it is short. **The escape is `WFC_SUITE_CONCURRENT=1` on the command, and every use of it is recorded** (mantahostels#2183) — one JSON line in `.suite-standdowns.jsonl` under .claude/tmp/markers, carrying the time, the session, the command, the concurrent count the guard saw and the limb stood down, `count` or `memory`. **The guard reads that prefix off the command's leading assignments, not out of its own environment** (mantahostels#2486) — a `PreToolUse` hook runs before the command, so a prefix never reaches it. The environment is still read as a second limb, for a script, a benchmark or CI with no command to prefix. Only the stand-down is written: a launch allowed for any other reason — a launch inside the cap, a `--queue` — leaves nothing, or the file would count launches rather than overrides. **It is not a record of refusals, and a `running`/`nth` pair in it is not the count cap biting** (mantahostels#2826): the deny branch logs nothing (the guard core's `denyToQueue`, which returns without calling `logStanddown`). **One line per COMMAND**, not per segment, which undercounts a compound command standing down twice — and **the escape is decided command-wide for the same reason**, a `PreToolUse` deny stopping the whole command. Its residual is the one `lib/suite-background.js` names: a command holding one escaped launch and one unescaped is exempted whole. The `command` field is the segment as the guard's parser rendered it, quoted spans left as a literal `"…"`, so it will not replay. The store is gitignored and machine-local like `.test-pass-markers.jsonl`, and never pruned. **The join to the markers is by time and runs forward**: the record is written at `PreToolUse`, so it always precedes its own run's `startedAt` and belongs to the next marker that session writes — a run that went red left nothing in the pass store at all, its marker being in `.test-fail-markers.jsonl`, and a stand-down whose run was killed joins nothing. It fails open at every step: an unwritable log costs the record and never the launch, and the drop goes to `guard-errors.log`, an undercount here reading as compliance. **`--queue` is a lever a session may choose, not the sanctioned way round a deny** (mantahostels#2024, #155): `npm run test -- --queue`, or the wrapper's own `node scripts/run-vitest.js --queue`, waits for this same guard to stop denying, on the count or the ladder, and then runs. A running whole suite is what the queue waits out. **It replaces a hand-rolled waiter**, so the wrapper's own `gateDenies` asks the guard itself and never `ps`. **Waiting on the gate alone is not enough**: every waiter would see the same open gate on the same tick and launch together (mantahostels#2024). **So a waiter also takes a place in line**: a marker file per process at `$TMPDIR/wfc-suite-queue/wfc-suite-queue-<pid>.json`, a directory of its own so a read never lists the shared temp root (#2889), and only the `WHOLE_SUITE_MAX` (1) oldest live waiter launches, ties broken on pid so two waiters reading the same millisecond still agree. **Liveness alone does not make that self-healing** (mantahostels#2034). A pid is not an identity over time: a marker is written 6-8 s after its process starts, pids recycle, and a leaked marker whose pid is reused reads as a live claimant for as long as the new process lives, which disables the liveness check exactly when there is debris for it to clear. **So a marker carries `(pid, start)`** — start time in clock ticks from `/proc/<pid>/stat` field 22 — **and is dropped by a `SIGTERM`/`SIGINT`/`SIGHUP` handler as well as on resolution.** A marker with no start time, or one recording 0 where procfs could not be read, falls back to liveness alone rather than being swept. There is still no lock, lease or expiry, but that is now a tested property rather than an argument: the covering test spawns a real process holding a real marker and kills it. **A waiter never liveness-checks itself**, the probe being allowed to be wrong where sweeping your own marker means losing your place for good. **The marker is held until the run ends, not dropped at launch**, or a later waiter takes this run's slot in the gap before vitest is far enough up for the guard to count it. **Two limits it keeps deliberately**: it fails open at every step — an unreadable queue or a guard that will not run lets the suite start rather than stranding it; and the wait has a 40-minute bound. **A whole suite still held there — on the count cap, the memory rung or a closed turn — is refused** (#2421, #2714): it leaves the queue, spawns nothing, exits non-zero and names the bound, since running it would put a second whole suite beside the first. A part-suite is refused there only on its memory rung; held on the count cap or the turn, it runs anyway. **Every exit from the wait is logged** (#1215, for #1157's daily wait figure): one JSON line in `.suite-queue-exits.jsonl` under the canonical checkout's .claude/tmp/markers per gate opening, early leave, timeout, refusal or signal kill, carrying the wait, the run kind, the session, whether the selection had emptied, and on a timeout or refusal the limb that held it (`count`, `memory` or `turn`). Lines are kept 30 days; an unwritable log costs the line, never the run. `scripts/report-suite-queue-wait.js` reads it at most hourly at session start (#1219), stamping `.suite-queue-wait-read` beside it, and files or refreshes one `takes:wayfinder` issue once the last 24 h hold 2 h of wait. **Scope includes `node scripts/run-vitest.js`**, the form `rule:vitest-wrapper` sends every one-shot to — left out it would be a one-line bypass. On the wrapper or the npm route, a run naming its test files is a touched run at any count, refused under its own rung alone, never at the count cap. **Three residuals it names itself**: an open watcher counts as a whole suite already running, holding its rung and its count-cap slot until it closes, so a session whose neighbours are all watchers waits out the queue's bound and is refused; `ps` drops a command's quoting, so a `-t "a b"` run reads as a whole one; and a build is never counted as a suite, being off the ladder — a second build or dev server is refused by `rule:build-concurrency` instead (#1733, #1759). Its worker count also carries lib/suite-bounded.js's two residuals, named under the timeout refusal below.
- **A vitest run outside `scripts/run-vitest.js` has no stall watchdog** — a synchronous call that never returns parks a worker for good, and vitest cannot time one out, because `testTimeout` is enforced on the event loop that call never yields to. The run then produces no output and no error for as long as you wait (mantahostels#1910). **Advisory** (mantahostels#2002, which built the guard after mantahostels#1910 built the watchdog; #185, which admitted the marker): `scripts/guard-vitest-wrapper.js` warns on a one-shot that skips the wrapper and hands over the whole rule plus the wrapped command to type instead (`rule:vitest-wrapper`). **The rule comes once a session, the wrapped command every time** (mantahostels#2275): the guard latches its own delivery, and a later firing carries a one-line reminder plus the command to type. It warns rather than denies because the unwrapped form is still the right one for a watcher or a bench, so there is no escape to spell. **Two blind spots it names itself**: it reads the command word, so a runner spelled another way — `node node_modules/vitest/vitest.mjs`, a shell function, anything behind `sh -c`, or any launcher but `npx` — is invisible; and `npm run test:watch`, `vitest bench` and `vitest related` cannot be wrapped at all, the watcher because an idle one is silent by design and the other two because the wrapper hardcodes `run`, so all three stay unbounded and nothing warns. **The subcommand is read in the first position only** (mantahostels#2002's review): scanning every word let a flag's VALUE silence it, so `vitest run -t bench a.test.ts` — an ordinary filtered one-shot — drew nothing. The residual runs the other way now, a `vitest --silent bench` drawing a warning it cannot act on. **The wrapped form it prints carries `NODE_OPTIONS=--max-old-space-size=2048`**, the cap every vitest `test*` script in `package.json` sets: `~/.bashrc`'s default is double it, and a suggestion without it would steer every session onto a form whose main process runs at twice the heap the ladder above was measured under (its workers hold §2's 1024 MB either way).
- **A suite DETACHED INSIDE THE SHELL — `&`, `nohup`, `setsid`, `disown` — registers no job for the RUN**, so nothing will ever wake the session and the `waiting:` turn that follows sits in `working` until the founder notices. **A FOREGROUND suite is deliberately allowed** — a call that overruns the Bash timeout is backgrounded by the harness and notifies (mantahostels#2485). **Enforced** (mantahostels#2485): `scripts/guard-dispatch.js` (its `guard-suite-background` core) denies the launch and hands back the foreground form, with `timeout: 600000` (#545). **A re-issue may then be refused outright by `guard-suite-concurrency.js`**, which creates no job either, so nothing is running to report `waiting:` on. **`run_in_background: true` alongside a detachment is refused too, and the flag is never read as an exemption**: set with one, the job describes the WRAPPER, which exits at once and reports success while the suite runs on unattached. **Scope is `guard-suite-concurrency.js`'s suite set plus `test:py`**, and both limbs must hold on the same call — but unlike that rule it carves out no bounded run, so `node scripts/run-vitest.js foo.test.ts &` is denied like any other. **The escape is `WFC_SUITE_DETACH=` carrying any non-empty value, as a prefix on the command** — `=0` exempts too —, read off the command string rather than out of the hook's own environment (mantahostels#2486). **An `env` prefix carries it too** (mantahostels#2524). **Detaching to survive a harness kill does not pay**: a queued suite job is killed far more often than other work, for reasons unestablished (mantahostels#2517) — §5's bg-shell pressure reaper is the named candidate, though it is switched off repo-wide (§5), so for a session started here it accounts for no kill at all — but a kill still EMITS a notification carrying `<status>killed</status>`, where a detached run emits nothing, ever. **And emitting is receiving**: 97% of notifications enqueued while a tool call is in flight are folded into the next tool result and read, ~92% when idle (#845, overturning mantahostels#2516's "about a third"). **It fails open**: an unreadable payload, or a core that throws, allows every detached suite through, the drop going to `guard-errors.log` — its silence is not proof. **Five residuals it names itself**: the WRAPPER CLASS the strip handles is not closed, so a `sh -c "…"` and a heredoc each hide their launch and it goes unjudged — `sh` is not a wrapper the strip knows, so it stands as the command word with its payload blanked to a sentinel, and a heredoc's body is dropped as data before segmentation, leaving only the opener line's own segments — **`sudo`, `xargs`, `nice`, `ionice`, `stdbuf -o L` and `env -S <string>` are in reach and stripped** (mantahostels#2524, mantahostels#2552); `detaches` is LEXICAL, so a detachment inside a script, behind `sh -c`, via `at`, `systemd-run` or a multiplexer passes unseen while a `&` inside a quoted string reads as one, though not inside a heredoc's body, which it neither reads nor rewrites (#2384); it cannot see that it is in a SUBAGENT, where detaching is equally wrong; the escape is OR-ed across segments, so a command holding one escaped launch and one unescaped is exempted whole; and `detaches` reads the WHOLE command where the suite test reads a segment, so an unrelated detachment anywhere on the command denies the launch — `sleep 1 & npm run test` is refused.
- **A suite with no upper bound on its selection, wrapped in a shell `timeout N`, is refused** — the wrapper kills it at its clock with no result and no pass/fail marker, and the clock counts time spent waiting in `--queue` too (#1155). The Bash tool's own `timeout: 600000` backgrounds an overrun rather than killing it (#545). **Enforced** (#1186, ruled at #1181): `scripts/guard-dispatch.js` (its `guard-suite-background` core), on the command string alone, whatever the suite count and whether or not `run_in_background` is set. **Unbounded is an `npm test`/`npm run test`, `test:changed` or `node scripts/run-vitest.js` naming no test-file-shaped word, or carrying a bare word that is no flag's value**, as lib/suite-bounded.js reads its argv, so `-t foo` is unbounded (#1196), as are `--changed`'s ref (#2454) and `run a.test.ts`, vitest reading `run` as a path filter (#2558) — a named file outranks `--full=<cause>`. A watcher and `test:py` are out. **The escape is `WFC_SUITE_TIMEOUT=<non-empty>` as a prefix on the command, or through an `env`**, judged per segment. **Four residuals**: a `timeout` inside an `env -S` string is unseen; a directory or bare-name filter (`-- scripts/lib/`) reads as unbounded, so a narrow timed run is refused; a valued flag off lib/suite-bounded.js's `SUITE_VALUED_FLAGS` has its value read as a filter, so the run reads unbounded; and the refusal's first line re-joins a timed segment's words on single spaces.
- **A session's first bare `npm run test`, `npm test` or `npm run test:changed` whose tree is already attested by certificates from any sessions is refused** — HEAD plus its own uncommitted files, the tree such a run reads — so it can only repeat their verdict (#787). **Re-typing the same command runs it**, and nothing after the first refusal in a session is refused. **Enforced** (#815, ruled at #790 Q3 and Q7): `scripts/guard-unasked-rerun.js` denies once, naming the attesting certificates (`rule:unasked-rerun`, or `rule:unasked-rerun-landing` with the `landing` module on, #2936), and appends each refusal to `.unasked-rerun-refusals.jsonl` under .claude/tmp/markers, the record #810's post-change count reads. **`--queue` counts as bare** — it changes when a run starts, not what it tests (#1153 Q1). **Never refused**: a run naming files or a filter, any other flag (`--full=<cause>`, `-t`), a run in another checkout, a payload with no session id. **It fails open** on an unreadable ledger, marker store or git, logging why to `guard-errors.log`.
- **A suite run whose output lost its pass/fail line is read from its log, never re-run to see the verdict** — a `grep` or `head` on the output drops vitest's summary and the runner's closing `TEST LOG:` line, and the runner's own lines can push the summary out of a short `tail` (#1379). **Advisory** (#1575, ruled at #1379 Q1 (D)): `scripts/guard-lost-verdict.js`, on `PostToolUse` and on `PostToolUseFailure` — where a call exiting non-zero lands — hands the session that run's verdict lines and its log path after any run through `scripts/run-vitest.js` whose output shows no `Test Files` or `Tests` line. **Silent** on a backgrounded, killed or timed-out run, on two launches inside one call, and on a launch inside `bash -c`, a script or a heredoc; each silence but the first and last is logged to `guard-errors.log`. A `head` that closes the pipe early kills the run itself, so no log holds its verdict.
<!-- guard-registry:end -->

### Isolation — run the suite against a worktree frozen at HEAD

**A full run isolates by default** (mantahostels#2278, below); `npm run test -- --isolated` names the same path explicitly and is what a filtered run needs to opt into it. Either way runs the suite in a detached worktree checked out at HEAD (mantahostels#2169). **Since mantahostels#3208 a bare `npm run test` is no longer a full run** — it narrows to the diff. **From a session, that narrowed run reads a worktree at HEAD carrying the session's own uncommitted files and nobody else's** (#812): the attribution below picks them, a live neighbour's claim subtracted, and a file it misses is read at HEAD's version. Where that worktree cannot be built the run says so and reads the shared tree; with no session id, or under `--shared`, it reads the shared tree as before. The isolating full run is `npm run test -- --full=<cause>` (#182: a required, closed-vocabulary reason), and the default's own escalation to the whole suite isolates too. **A narrowing that fails — the diff, `vitest list` or its timeout, or any other throw — is refused, never widened** (#2698): the run spawns nothing, exits 1 and names the cause and the `--full=<cause>` route; an explicit `--changed <ref>` is refused the same way. Type `npm run test`, not a bare `node scripts/run-vitest.js`: the npm script carries `NODE_OPTIONS=--max-old-space-size=2048` and the bare one hands `~/.bashrc`'s 4096, twice the heap the ladder above was measured under, to vitest's main process — the workers hold §2's 1024 MB either way — and this binds every bare-wrapper full run, isolated or not. **It composes with `--queue`**, which is the sanctioned form for a full run here — the concurrency guard refuses a second suite outright. Nothing but that run writes into the worktree, for its tracked content, and its HEAD cannot move, so `headMovedDuringRun` is structurally false and the re-run a neighbour's mid-run commit forces disappears (mantahostels#2098). The certificate follows the run there: `scripts/vitest-tree-watch.ts` takes its drift snapshot against the worktree, while the marker still lands in the canonical checkout's store, keyed by the sha that ran and flagged isolated (the launch record's `isolated`, `scripts/lib/suite-handoff.js`). `--isolated --changed <ref>` stays admissible at the push (mantahostels#2146): isolation freezes what the suite READS, it does not narrow what it SELECTS.

**`--isolated` is the default for a full run** (mantahostels#2278, ruled on certificate honesty rather than the red rate mantahostels#2169 §4 gated on and never cleared). 62% of this machine's full runs (58 of 94 in the marker stores) read between 1 and 15 of another session's uncommitted files while depositing a certificate keyed to a sha whose tree they had not read; isolation makes that 0%. The measured price: the own-uncommitted-work refusal fires on **1.1%** of historical full runs (a floor — a Bash-route write is invisible to the attribution ledger, mantahostels#296), and the wall cost is **1 s in 301** on the one same-sha paired point in the corpus, plus 0.17 s `git worktree add` and 0.02 s `git worktree remove` measured live. mantahostels#2169 §4's red-rate gate is retired as un-passable (mantahostels#2278). A run naming test files, a `nameFilter`, or `--changed` keeps today's non-isolated behaviour — the ruling is scoped to full runs; an explicit `--shared` escape restores the old shared-tree path for a full run. mantahostels#2156's exposure-window inference is corrected rather than confirmed (mantahostels#2173): 299 of the worst pre-ruling run's 300 failures were timeouts, 298 of them `Test timed out in 5000ms` and 279 of those one file's cascade off 16 slow cases (mantahostels#2254), leaving a single genuine assertion — the mechanism was the fixed per-test timeout under concurrent-suite load (whether it should scale with that load is open at mantahostels#2255), not tree mutation.

**Four refusals, each printing what to do instead** (`scripts/run-vitest.js`; the first three are `isolatedRefusal` and `isolatedArgvRefusal`, the fourth inline in `runIsolated`). Since isolation is now the default for a full run, all four fire unasked on `npm run test -- --full=<cause>` — and on a bare `npm run test` only where its narrowing escalates (mantahostels#3208) — not only on a run naming `--isolated` explicitly: a file THIS SESSION wrote sitting uncommitted, since a worktree at HEAD reads not one byte of it and its certificate would look exactly like one that attested it; a bare `--changed`, which selects nothing against HEAD and would exit 0 having tested nothing; an argument naming an absolute path inside the canonical checkout, which the worktree would read live rather than frozen; and a git that will not say whether the tree is clean. **A neighbour's uncommitted file only warns** — this tree is never clean, so refusing on the whole dirty set would refuse every isolated run this machine will ever start. **That split needs a session id and a readable ledger, and degrades to a warn on the whole dirty set without either** — so from a hook or in CI, where no session id exists, the first refusal above does not fire at all. Attribution is the ledger `scripts/guard-uncommitted-work.js` uses, so it inherits that ledger's blind spot too: a file this session wrote from Bash — a `>` redirect, a heredoc, `sed -i` — is invisible to it and warns as a neighbour's (mantahostels#296).

**Three surfaces a worktree does not freeze.** `/proc` and the git common dir, which worktrees share, are named at mantahostels#2173 and unmeasured. The third is measured and is the one that has already cost a reading: a gitignored artefact the suite needs is not reproduced by `git worktree add`, so it is symlinked in from the canonical checkout off a **declared list** in `scripts/run-vitest.js` — `node_modules` and `.husky/_` — and is a neighbour's to mutate mid-run. **An artefact missing from that list is missing from the run**, and the red it fabricates looks like a genuine one: an unlisted `.husky/_` made `prepare-commit-msg-gate.test.ts` fail 28 of 31 on `ENOENT … .husky/_/h` in every isolated reading before mantahostels#2213 fixed it. **That residual is closed, at those two shas**: two isolated full runs have gone green over 244/244 and 245/245 tracked test files with zero failures. A file added to the suite since either sha has not yet had an isolated green of its own — compare `git ls-tree -r --name-only HEAD | grep -cE '\.test\.(ts|tsx)$'` against the newest isolated marker's file count before treating the residual as still closed today. The worktree itself goes under gitignored `.claude/worktrees/`, pid-scoped, and a leftover from a dead process is swept at the next isolated run.

### What the gates above actually refuse

Measured 24 August 2026 at mantahostels#1127 ([docs/research/machine-binding-constraints.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/machine-binding-constraints.md),
re-runnable via `python3 scripts/measure-machine/scan_machine.py`), over the 7
days to 24 Aug 01:00 SGT and every `free -m` a session ran in them (n=1,211):
**session admission refused none**: **142 admit verdicts and no genuine
hold** over 17–24 Aug. The nine apparent holds in the transcripts all quote
`scripts/admission.test.ts`'s 400 MB fixture, which no real reading came
within 200 MB of — **do not re-derive a hold rate by grepping for `HOLD`.** What
this machine's memory refuses is test-suite concurrency; re-run the scan before
quoting a refusal rate. **Quote that split rather than "memory is the
constraint"**, which is true of suites and false of sessions. ⚠ **What the suite
bind costs is unmeasured** — nothing records a deferral.

⚠ **CPU binds at high session counts (mantahostels#1953).** At ~36 session
processes this machine sustained **553–778% of the 800% ceiling** across six
windows, load1 48–68: session count is the variable that drives it.

**What binds is sessions, and what it costs is kernel time.** Claude sessions
drew **71–100% of all busy CPU** across those windows.

⚠ **Over half of it is not work.** **`system` time was 52–55% of all busy CPU**
(300–400% of 800) at a fork rate of **535–625/s**, against **2–4% in `user`** —
process creation and syscall overhead, not computation. **And a Claude session
runs at NI 5, so its CPU lands in `nice` (253–293%), never in `user`**.
Quote the split, never a bare busy figure.

**The lander runs in a cgroup of its own** (#2956). `scripts/start-lander.js` starts it under `systemd-run --user --scope`, in `user.slice`. At the cgroup root that is one of three siblings at equal `cpu.weight`, beside `/init.scope`, where every session and hook sits, and `system.slice`. A nice level reaches only its own cgroup, so a touched run never yields to the lander's suite (`scripts/lib/cpu-yield.js`, #2955). The scope lives only while the user manager does, which `Linger=yes` keeps up (`loginctl show-user $USER -p Linger`). Where the manager makes no scope, the lander starts in its starter's cgroup and its log says so. To check one: `cat /proc/$(cat .claude/tmp/markers/.lander.pid)/cgroup`.

**The suite ladder is the wrong gate to answer this with.** The gate that
governs the workload that *does* saturate the CPU is **session admission**, and
every admission verdict holds at the load ceiling, whatever memory is free
(#830, #834, mantahostels#1953; *The load ceiling* below).

⚠ **THE MARKER CANNOT SEE THE RUNS THIS WAS BUILT FOR, AND THE WATCHDOG IS WHAT
COVERS THEM.** A marker is written only for a run that finished with an observed
verdict (`scripts/vitest-tree-watch.ts`, both branches gated on `outcome`), so a
run that was killed, hung or interrupted records **nothing** — and those are
exactly the runs a saturated machine produces (mantahostels#1953). So the `machine`
block explains a run that was *slow*, never one that never returned, and a
history built from it is **survivorship-biased towards the healthy**. Read it
alongside `~/memwatch.log`, whose CPU trigger is time-driven and does not care
whether anything finished. Fixing the marker properly means writing a
provisional record at run start and upgrading it on the verdict; not done, and
**mantahostels#1979 is gated on a rate this instrument alone cannot supply.**

**Both instruments record CPU** (mantahostels#1953). A test
run's marker carries a `machine` block — `busyPct`, `systemPct`, `nicePct`,
`userPct`, `iowaitPct`, `load1`, against `ceilingPct` — measured as a delta
across the run itself (`scripts/lib/cpu-sample.js`, bracketed by
`vitest-pass-reporter.ts`); absence means unreadable, never a quiet machine. And
`~/memwatch.sh` gained a **CPU trigger of its own**, at `MEMWATCH_CPU_THRESHOLD_PCT`
(default **600** of 800) — the two triggers are disjoint here (§4).

### The load ceiling — new work holds at load1 3 per core (#830, #3223)

Two launch points read `/proc/loadavg` before adding work, against
`lib/cpu-sample.js#overloadReading`'s ceiling of **3 per core — 24 here**:

| Launch | At or above the ceiling |
|---|---|
| A test run through `scripts/run-vitest.js` — every `npm run test` and `test:changed` | **holds**, re-reading every 15 s, and **refuses** if still over after 5 minutes, as `--queue` refuses at its timeout on the memory rung: a refusal costs one session a retry, a freeze (§7) costs all of them. A `--queue` run holds again once its gate opens, before it spawns (#834) |
| A session, at `lib/admission.js`'s verdicts — `dispatch-sessions.sh` re-reads `scripts/admission.js` before every member | **HOLD**, exit 1, 0 slots and a `cpu load` line — `dispatch-sessions.sh` skips that member with a load remedy. `--force-memory` re-reads the load alone (`--load-only`), so no flag lifts the hold (#834). pick-next's ADMISSION block holds and reads 0 free slots too, and prints a `cpu load` line over the ceiling or where the load is unreadable |

**Why 24.** Above load1 24 hook-timeout refusals run about 10 times higher
(7 → 72 an hour), the Bash round-trip doubles and closes per hour halve, across
the 13–27 Oct hours (#3209). A stopgap, ruled on #3211, held until #3223's
switchback reads it. `WFC_LOAD_CEILING=<n>` overrides it; where that is unset,
`~/.claude/load-ceiling` does, re-read at every launch so a change reaches
running sessions; `0` turns it off. Both launch points **fail open** on an
unreadable load.

**What it cannot do.** It gates *new* work only: sessions already running can
still saturate the machine between them, and nothing here throttles a live one. A
`vitest run` invoked directly, a build and `test:watch` bypass the wrapper. And
load1 is a one-minute average, so a burst lands before the reading rises; the
session ceiling below covers that.

<!-- guard-registry:begin -->

- **Synthetic load on this shared machine is always capped, at most half the cores, never every core.** Run a load generator inside `systemd-run --user --scope -p CPUQuota=400% -- …` or `taskset -c 0-3 …`. **Enforced** (#2710): `scripts/guard-dispatch.js` (its `guard-cpu-load` core) refuses an uncapped `yes` not piped into a command, `stress`, `stress-ng` or a backgrounded shell busy loop, and two caps that add up past one, in the command, a `bash -c` or `eval` string, or a `.sh` script run, sourced or handed to `bg-run.sh run`. An interpreter's own busy loop (`node -e 'for(;;);' &`) and a heredoc fed to a shell are never seen.

<!-- guard-registry:end -->

### The session ceiling — at most 1.5 sessions per core (#2141)

Both admission verdicts also cap their slots at
`lib/cpu-sample.js#sessionCeiling`, **1.5 sessions per core — 12 here**, less
the sessions already running. A session is counted as a `claude bg-pty-host`
process on the machine: every plan's, the reading run's own included. A host
whose daemon has gone (parent pid 1) is left out, and an interactive terminal
session runs no host, so it goes uncounted. At the ceiling, `scripts/admission.js`
prints **HOLD** with a `cpu sessions` line, and `dispatch-sessions.sh` skips that
member with a session remedy. `--force-memory`'s `--load-only` judges this ceiling
too. pick-next's ADMISSION block prints the same line, and the breakdown has a
`cpu slots` row. `WFC_SESSION_CEILING=<n>` overrides it, `0` turns it off, and an
override under 1 keeps the default. An unreadable `ps` caps nothing.

**Why 12.** Each point of load1 slows work by about 3.5%, with no knee, and load1
runs about 2.2 per session. So total progress peaks near 13 sessions, and at 12
each session runs about 1.5× slower than on an idle machine. The measurement and
its biases are on #2141.

Subagent transcripts sit inside a session's own memory slot and must never be
pooled with it as separate sessions.

---

## 7. Measured incidents

- **Single runaway (30 Jul 2026) — the real failure mode.** One `claude.exe` grew 3826 → 7317 MB in ~60s; total hit 7841/7924 MiB. Recurred within the hour. The heap bound did **not** apply.
- **Concurrent sessions (31 Jul 2026) — normal operation.** 5–6 sessions at 250–500 MB, baseline never below 4 GB, some resident 3+ hours.
- **Interop-bridge wedge (1 Aug 2026) — not a memory fault.** Every `claude` launch hung with no output; memory was fine. §9.
- **Host suspend (27 Aug 2026) — a freeze no recorder here can catch.** Windows entered Modern Standby on its 60-minute mains idle timeout at 17:20:53 and the WSL2 VM froze for 22 minutes: the guest journal is silent 17:25:36 → 17:47:52, `earlyoom` missed its 17:39 report and `wsl-pro` its ~17:45 restart. **Memory was not the cause and never close to it** — `earlyoom` read 6765 of 9924 MiB available at 16:39 and `~/memwatch.log` has no block after 12:11. On resume `claude agents` crashed and a new session would not start, their daemon sockets under `/tmp/cc-daemon-1000/` having died in the freeze. **Fixed by `powercfg /change standby-timeout-ac 0`**, so mains sleep is now never; **battery is still 25 minutes and a closed lid still suspends**, which is the residual. This is an ARM64 machine, so Modern Standby is the only sleep state available — `powercfg /a` reports S1, S2 and S3 all unavailable.
- **CPU saturation (4 Oct 2026).** Between 20:43 and 21:35 WSL froze repeatedly and the founder restarted Windows at 21:34:58 (Event 1074). `~/memwatch.log` read **load 112, 143 and 171** at 21:06, 21:29 and 21:35, at 705–781% of 800% busy, almost all of it `nice` — Claude sessions and what they spawn — with only **3.3–4.2 GB used**. At 21:28–21:29 systemd's 3-minute watchdog SIGABRTed journald, resolved, udevd and timesyncd, the kernel reported an RCU stall, and the interop vsock timed out (`accept4 failed 110`), which is what froze the terminals. Ruled out: memory (`earlyoom` read 7,059 MiB available at 21:18 and killed nothing) and host suspend (no Kernel-Power 506/507 between 19:51 and the restart). In the window: a full suite at 20:43 (605 s), a 51-file run at 21:05 that took 260 s, and a run at 21:24 the stall detector killed at ~21:35. **What filled the run queue went unrecorded** — memwatch then listed the top six processes by RSS only. New work now holds at the load ceiling (§6) (#830).
- **Battery standby, resumed broken (7 Oct 2026) — the 27 Aug residual, firing.** Unplugged, Windows entered Modern Standby on the 25-minute battery idle timeout at 09:08, deepened it at 12:24 ("Austerity Battery Drain Budget Exceeded") and woke on the lid at 22:39:30 (Kernel-Power 506/507). Unlike 27 Aug the VM did not simply pause and resume: from 22:43 the kernel reported RCU stalls (`timer wakeup didn't happen … Possible timer handling issue on cpu=0`), at 22:52 a Claude process sat stuck in-kernel in `link_path_walk` on CPU 1, the interop bridge wedged (§9), and `~/memwatch.log` read **load 27 at 60% busy** at 22:54 — tasks queued, not working. The guest journal stops at 23:02:53; Hyper-V removed the VM's NIC at 23:17:24. **Not the workload** — three Claude sessions, 2,370 MB combined, and `earlyoom` read 2,636 MiB available at 23:02 and killed nothing. **Why a resume breaks CPU 0's timer is unknown.** An RCU stall now warns at session start and refuses a dispatch — `scripts/check-kernel-stall.js` (#867). Battery standby stays on: never-sleep on battery was declined (#867). **Remedy after any long battery sleep: `sync`, then `wsl --shutdown`, before carrying on.**
- **New windows black, then closed (23 Oct 2026) — fragmentation, not exhaustion.** From ~09:50 a new `wsl.exe` tab showed only a cursor for about a minute, then closed; open shells kept working. Signature: `dmesg` repeating `page allocation failure: order:7` in `vmbus_alloc_ring ← vmbus_open ← hvs_probe`, and `/proc/buddyinfo` with **no free block of order 7 or above in either zone** while `MemAvailable` reads gigabytes. A finished-session reap frees memory but no order-7 block. **Fixed by the socket-buffer file in §1** (#2640).
- **Scheduler clock frozen (23 Oct 2026).** From 17:52 +08 every run queue's clock stood still while `/proc/stat` showed the CPUs busy: memwatch's one-second samples read 0.0 %CPU for every task. arm64 has no upstream fix (#2708). RCU stalls followed from 21:18, 3 h 26 min later, and the boot ran 2 h 10 min past the first until shut down by hand — unlike the 4 and 7 Oct stalls, which ended the VM within ~20 minutes (#2681). **A frozen clock now warns at session start and refuses a dispatch** — `scripts/check-kernel-stall.js` (#2779).
- **Orphaned guard subshells (25 Oct 2026) — hooks timed out machine-wide for eleven hours.** From 04:20 +08 a scratch harness in `/tmp` ran a guard under `spawnSync("bash", [guard], { timeout: 8000 })`, whose timeout kills only the `bash` it spawned. Ten of the guard's forked subshells, still named `bash …/scripts/guard-cpu-load.sh`, were orphaned and kept spinning at 5–100% CPU each until the founder ran `wsl --shutdown` at 15:25. Kernel time rose from ~300% of 800% to 700–765% by 10:00, at load 20–100 with 2–3 GB used, and every session's guards hit their 10 s ceiling and blocked. No RCU stall (`check-kernel-stall.js --boot -1`); the boot ended in a clean poweroff. The boot before logged 73 `page allocation failure: order:6` lines in `vmbus_alloc_ring ← hvs_probe`, the 23 Oct fragmentation signature, which was secondary. **An orphaned hook run is now killed at session start** — `scripts/reap-orphan-hooks.js` (§8, #2922).

---

## 8. Post-incident triage

```sh
memcheck                                          # start here
node scripts/check-kernel-stall.js --boot -1      # a VM that froze or died: did its kernel stall?
cat ~/memwatch.log
sudo journalctl -u earlyoom --no-pager | tail -20
dmesg | grep -i "killed process"
```

**An RCU stall on the boot that died is the 4 and 7 Oct signature (§7)**, and no memory figure will show it — `--boot -1` is the boot before this one. Without `--boot` the check reads the running boot and its scheduler clock, where a stall or a freeze means the VM is unhealthy, whether it dies in minutes or runs degraded for hours (§7): `sync`, then `wsl --shutdown`.

**Every session start SIGKILLs an orphaned hook run** — a process running any `scripts/guard-*` script, or a registered hook command with exactly its arguments, with an init for a parent (pid 1, WSL's session `/init` or a `systemd`), older than the longest registered hook timeout plus 60 s — with its process group where it leads one or the group holds nothing else, else its descendant tree (`scripts/reap-orphan-hooks.js`, #2922). Each kill is one JSON line in `.orphan-hook-reaps.jsonl` under `.claude/tmp/markers`, carrying the argv and age.

A build or test that dies with no error of its own was most likely killed by earlyoom — check before hunting a code bug. A backgrounded Bash job is the exception: §5's bg-shell pressure reaper is the lead, and it arms in a headless session too (mantahostels#2694). It is switched off repo-wide, so for a session started here neither it nor `earlyoom` (mantahostels#2689) explains a dead job — §5.

**A freeze leaving no `~/memwatch.log` block and no `earlyoom` kill is not a memory fault — it is the host suspending the VM, and no guest log can show it**. Ask Windows instead:

```sh
powershell.exe -NoProfile -Command "Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'} -MaxEvents 20 | Select-Object TimeCreated,Id,Message | Format-List"
```

Event **506** (entering Modern Standby) and **507** (exiting) bracket the freeze, and the guest's first line on resume is `systemd-resolved`'s `Clock change detected. Flushing caches.`

**Known failure mode: every Bash call fails machine-wide with `PreToolUse:Bash hook error: … Syntax error`.** A `scripts/guard-*.sh` that will not parse takes Bash down in *every* parallel session, not just the one that broke it.

Read/Edit/Write keep working, so **a bystander session can repair it without Bash and without knowing the file's contents** (mantahostels#641, which records the 18 Aug 2026 outage). Because the corruption inserts one fixed fragment between every character, a single `Edit` with `replace_all: true`, `old_string` the fragment and `new_string` empty reconstitutes the original byte-exactly — Edit rewrites real bytes, so non-ASCII survives even though Read renders it as replacement characters, and any legitimate occurrence of the fragment in the source survives too, its own characters being separated by fragments in turn. Confirm by reading line 1 back: it should be the shebang. **Prefer that to `git checkout HEAD -- <path>`**, which throws away whatever uncommitted work the holder had. Never hand-rewrite a guard you cannot test with `bash -n`.

**Known failure mode: all `wsl` commands hang indefinitely.** An orphaned WSL partition in HCS. Fix from an **elevated PowerShell**:

```powershell
hcsdiag list
hcsdiag kill <GUID>
```

---

## 9. Interop-bridge wedge

**Symptom: `claude` produces no output and never returns.** No crash, no error, memory normal — `memcheck` shows nothing.

Claude Code queries Windows managed policy on every launch, via the interop bridge (`/init`):

```
/init /mnt/c/Windows/System32/reg.exe query HKLM\SOFTWARE\Policies\ClaudeCode /v Settings
/init /mnt/c/Windows/System32/reg.exe query HKCU\SOFTWARE\Policies\ClaudeCode /v Settings
```

**1 Aug 2026, ~11:12.** These stopped returning and accumulated, all state `S` at 0:00 CPU — nothing in `D` state, so not a storage stall. **Root cause unknown.** A healthy query takes 0.03–0.04s, so seconds is already pathological.

**Recovery:** close every WSL/terminal window → `wsl --shutdown` in PowerShell → reopen.

⚠ **`wsl --shutdown` is an abrupt kill of the VM and discards guest writes still sitting in page cache.** On 27 Aug 2026 it left a job's `state.json`, the tail of `guard-errors.log` and six `refs/arbiter/*` claim pins as correct-length runs of NUL bytes — a zeroed `refs/arbiter/*` cannot even be removed by `git update-ref -d`, which answers `reference broken`, so delete the loose file under `.git/refs/arbiter/` instead. Where the machine still responds at all, run `sync` before the shutdown.

**5 Sep 2026, ~14:12 (mantahostels#3111).** Again, this time inside a script: `scripts/dispatch-sessions.sh` ran the bare binary from a non-interactive shell, so Guard 1 — a shell function — never fired.

**7 Sep 2026, ~13:20 (mantahostels#3306) — a SECOND fault, and the probe could not tell it from the first.** Two `/pick-next` dispatch waves were refused minutes apart, and both times the bridge tested healthy again shortly after with no `wsl --shutdown`. Timing six consecutive probes caught the mechanism: five returned in **0.03–0.04s**, one took **10.06s** and printed `WSL (3656361 - ) ERROR: UtilAcceptVsock:273: accept4 failed 110` — `ETIMEDOUT` on the interop vsock accept.

**The stall is per-call and about 10s, and the next call is normal.** So the old 5s attempt and its 10s retry would each have hit a fresh stall and both expired — inferred from one timed sample, not measured across the pair. The refusals clustered on session spawns (load average 3.19–7.01), not at rest.

**Two fault modes, and only one wants `wsl --shutdown`:**

| | Wedge (1 Aug, 5 Sep) | Vsock stall (7 Sep) |
| --- | --- | --- |
| Shape | queries accumulate, never return | one ~10s call, then normal |
| Clears itself | no | yes, within minutes |
| Remedy | `wsl --shutdown` | none — retry |

**The vsock stall's cause is known: a failed order-7 ring allocation** (fantasy-books#1268); see §1's socket-buffer file.

### The probe itself

`scripts/lib/interop-probe.sh` — `claude_interop_wedged` and `claude_interop_recovery_text`, sourced by Guards 1 and 3 alike.

- **12s per attempt, three attempts, wedged only if all three expire.** The flat budget alone sits above the ~10s stall that was measured; the attempts guard only a stall LONGER than the budget or one recurring across calls, neither of which has been measured, so three is a cheap margin on an unmeasured tail rather than a derived figure. Override the budget with `CLAUDE_INTEROP_PROBE_TIMEOUT` and the count with `CLAUDE_INTEROP_PROBE_ATTEMPTS`; a non-integer or zero count is reset rather than honoured.
- **Two exit codes mean "expired", not one.** 124 is the ordinary expiry; **137** is 128+SIGKILL, what `-k` escalates to when the target ignores the TERM, which is a bridge stuck in the kernel (mantahostels#3111).
- **Fails open** — no `reg.exe`, a non-executable one, no `timeout`, not WSL, or a library the shell cannot parse → the caller launches. The probe must never be why Claude won't start. A non-integer or zero value of either override is the one thing reset rather than honoured, and both are tested numerically so `00` cannot slip through: `timeout 0` never expires, and zero attempts would fall straight through to *wedged* with no probe made.
- **Worst case 42s** at the defaults — 3 x (12 + 2), the graces elapsing only against a TERM-ignoring target, against the **45s** ceiling `scripts/dispatch-sessions-bridge.test.ts` pins. Raise the budget or the count and Guard 3's reporting time goes with it.
- **Simulate a wedge** by pointing `CLAUDE_INTEROP_REG` at an executable that sleeps.

### Guard 1 — pre-flight wrapper

`scripts/claude-interop-guard.sh`, sourced from `~/.bashrc`. A `claude` function runs the probe, then hands off.

- Answers or errors → launches, **prints nothing**. Happy-path silence is required; never add output.
- Hangs → does not launch; prints the recovery above.
- **`command claude "$@"`, never `exec`** — `exec` would replace the interactive shell, closing the terminal on exit. Args pass through untouched; `agents`, `--resume`, `--bg`, `attach` and `ca` unaffected. Interactive shells only.

### Guard 2 — Windows watchdog

Guard 1 can't help once a session is already frozen. Scheduled task **"WSL Interop Watchdog"** (logon + every 2 min), installed by `scripts/install-interop-watchdog.sh`.

Interop-spawned `reg.exe` is parented to `wsl.exe`, which excludes ordinary Windows registry use. Toasts when such a process exceeds **60s** *and* either matches `Policies\ClaudeCode` or three-plus are stuck at once — age alone would trip on a slow recursive query. Max one toast per 30 min.

> **Never make it run `wsl --shutdown` automatically.** A false positive would kill live background sessions — worse than the fault. Detect and notify only.

Logs to `%LOCALAPPDATA%\wsl-interop-watchdog.log` only on detection; empty is healthy. Re-run the installer to deploy a change; remove with `schtasks.exe /Delete /TN "WSL Interop Watchdog" /F`.

### Guard 3 — the dispatch launcher

`scripts/dispatch-sessions.sh` sources the probe itself, because Guard 1 cannot reach it (mantahostels#3111).

- **Probes before both gates and again before every member's spawn.** Before the gates because each shells out to `claude` too — the duplicate gate for its live oracle, the allowance gate under a 120s ceiling — so a wedge caught only at the launch would be reported minutes late. Before every spawn because the bridge can wedge mid-set.
- **Refuses the whole call, exit 5.** Nothing is recorded where the wedge precedes the first spawn; where it arrives mid-set the refusal **names the members that did launch**, because they are on the ledger and re-running the whole command would hit the duplicate gate on them. A `--dry-run` can exit 5 too — the opening probe precedes both gates, and both shell out to `claude` on a dry run as well.
- **An RCU stall this boot or a frozen scheduler clock refuses it the same way, exit 5** (#867, #2779), checked at both points the probe runs, and the refusal names which signal fired. A freeze is read live over 1 s, so its refusal lifts once the clock moves again; a stall holds for the boot. `scripts/check-kernel-stall.js` fails open on an unreadable kernel log or `/proc` file, and says so where the check itself cannot run.
- **A launch ceiling as the second line.** `timeout -k 5 120` around the spawn, so a hang arriving by some route the registry probe does not read is killed and reported rather than awaited. Override with `WFC_DISPATCH_LAUNCH_TIMEOUT`; absent `timeout`, it fails open like the probe.
- **No `--foreground` on that ceiling.** It confines the kill to the direct child — but the launch is piped into `head -1`, and a surviving grandchild holds that pipe open, so the shell waits forever. **Residual:** the group kill takes down a session `claude` had forked before it hung. `--bg` returns in well under a second, so that is the remote case and a hung launcher is the certain one.
- **A launch that returns and then wedges is on the ledger like any other, so the relaunch needs `--force`** (mantahostels#3127). `claude --bg` returns in under a second and the launcher records on that exit. Nothing writes early: `scripts/lib/dispatch-ledger.js#record` appends once, from the single `--record` call site, inside the `exit 0 || 141` branch.

**Every other script that starts `claude` was already bounded**, so none took a probe: the `agents --json` oracle caps at 10s and retries once at 20s (`scripts/lib/agent-liveness.js`), `claude stop` carries its own timeout in `reap-finished-sessions.js` and `rescue-sessions.js`, and `measure-spare-warm.js` spawns detached and never waits.

---

## 10. Shell and CLI gotchas

**`jq` 1.7 is installed system-wide at `/usr/bin/jq`** and resolves under `env -i`, so it is safe in hooks, cron and `sudo` — no absolute path needed. **Version 1.7, not 1.8** — avoid 1.8-only builtins.

**`~/.claude/daemon.log` is binary to `grep`.** It carries NUL bytes, so GNU grep treats it as binary and **prints nothing at all** — even for `-c`, even for strings `head` plainly shows — and exits 1, which looks exactly like a genuine no-match. Use `LC_ALL=C grep -a`, or read it in Python as bytes. It is the source for host and session lifecycle events (`daemon start`, `bg claimed-spare`, `bg spare spawned host pid=N`, `bg adopt:`) but records **no host exit event**, so host lifetime is not recoverable from it after the fact.

**Opening a generated HTML report:** `xdg-open` is not installed here, `wslview` is absent, and a `/tmp` file is not reliably reachable from the Windows browser over `\\wsl$`. Copy it to the Windows Desktop and call `explorer.exe`, which exits 0 and prints nothing on success:

```bash
U=$(powershell.exe -NoProfile -Command '$env:USERNAME' | tr -d '\r')
cp /tmp/<file>.html "/mnt/c/Users/$U/Desktop/"
explorer.exe "C:\\Users\\$U\\Desktop\\<file>.html"
```

The `tr -d '\r'` is not optional — `powershell.exe` emits CRLF and the stray `\r` corrupts the path silently.

**`git merge-tree --write-tree <a> <b>` dry-runs a merge** without touching tree, index or HEAD, printing the merged tree oid and then any conflicted paths — use it to prove a reconcile is conflict-free before asking permission to run the real thing.

**`.claudeignore` is not a Claude Code feature** — the string appears 0 times in the installed binary, so creating one is inert. `.ignore` and `.rgignore` are real, hard-coded into the file index, and `.ignore` is not switched off by `respectGitignore` — but both filter **discovery only**: a file under an ignored path is still readable by `cat` and by the Read tool. `permissions.deny` is the only access boundary. Its `Read(...)` rules hot-reload mid-session and fire before the file-existence check, and they stop the recognised Bash read commands (`cat`, `head`) but not an arbitrary subprocess — `python3 -c "open(...)"` passes. Web search returns the wrong answer here confidently — check the binary's strings.

**`npx biome` caches its impostor.** The unrelated `biome` package lands in `~/.npm/_npx/<hash>/` on first run, after which `npx --no-install biome` in a fresh worktree resolves the cached impostor silently and offline.

**`ENABLE_TOOL_SEARCH` (`true` / `auto` / `auto:N`) is real but stays unset here** — it exists for non-first-party proxies forwarding `tool_reference` blocks, and tool search already self-enables on this setup.

<!-- guard-registry:begin -->
<!-- Every rule here carries **Enforced** / **Advisory** / **Unenforced** / **Unenforceable**; `scripts/check-guard-registry.js` gates it. -->

- **A `find` started at `/` is refused, at any depth** — neither `-maxdepth` nor `-xdev` makes it cheap under WSL2, while `~` and named roots (`find /usr /opt /home -xdev …`) are; there is no escape variable. **Enforced** (#1006, which carries the timings): `scripts/guard-root-find.js` denies it and prints this plugin's own root as a literal path. It reads `find`'s start points behind the shared walker's launchers, so `sh -c "find / …"`, `fd`, `locate` and `du /` are unjudged.
<!-- guard-registry:end -->

### Browsing a page

**Playwright is installed once per machine, as the Python package, and every repo on this host already reaches it** — `/home/lucmo/miniforge3/lib/python3.12/site-packages/playwright`, browsers cached at `~/.cache/ms-playwright`. It is **not** an npm dependency and appears in no `package.json`, so a `grep playwright package.json` finding nothing is not evidence it is missing; `python3 -c "import playwright"` is the test. A fresh machine needs `python3 -m pip install playwright && python3 -m playwright install chromium`; `node scripts/init-adopter.js` names it on its MISSING-tools line.

**Use `scripts/browse.py` rather than writing a probe** — `text`, `html` or `shot` against one URL, with `--wait <selector>` for a page whose content arrives by fetch. It is core-owned: init and every upgrade bring each adopter's copy back to this one (#1501), so a fix belongs upstream here, not in the copy. Exits 3 when Playwright is absent, 4 on a timeout and 5 on a refused page, so a session can tell those apart from a bad argument. `shot --tiles` writes one PNG per viewport height, so each is read unshrunk, and exits 6 where the page does not show at real size (#2753).

**Its default user-agent is an ordinary desktop Chrome string**: Playwright's own advertises `HeadlessChrome`, which Cloudflare and Akamai answer with a 403 and an interstitial. A site reading as blocked under the default UA is usually open.

**There is no Playwright MCP server, deliberately.** mantahostels dropped `@playwright/mcp` in `909179cc1` for its context cost, which tool search has since cut to ~400 tokens a session (#977). The reason now is its idle process tree, ~226 MB in every session, and that ad-hoc Playwright scripts already did 24 of 28 no-login interactive tasks unaided (#953). Which route to climb to when `browse.py` fails: the `browser-ladder` skill. Stale `mcp__playwright__*` entries still sitting in a `settings.local.json` point at nothing.

**One browser at a time.** A Chromium launch is a second process outside the suite ladder in §6 above; `browse.py` closes it in a `finally`, but a killed run can leave one resident — check with `ps -e -o pid,comm | grep -iE 'chrome|headless'` after an interrupted call. Not `pgrep -f chromium`, which matches the shell running it and so never reports empty.

### What a hook sees

**Hook processes do receive `CLAUDE_JOB_DIR` and `CLAUDE_PROJECT_DIR`** — Claude Code injects them per tool/hook invocation, not onto the `claude` process. So `/proc/<claude-pid>/environ` reporting them absent is **not** evidence a hook cannot see them, and the Bash tool's own env is not a proxy either: it has `CLAUDE_JOB_DIR` set but `CLAUDE_PROJECT_DIR` empty. (Settled at mantahostels#183.)

### Auto mode's permission classifier

`permissions.defaultMode: "auto"` runs an LLM classifier, which a matching `permissions.allow` rule short-circuits entirely, except on a protected path such as `.claude/` (§12) — but **a compound command defeats the match.** Claude Code splits on `&&`, `||`, `;`, `|`, `|&`, `&` and newlines, and *every* subcommand must match a rule independently, so `gh pr merge 516 --squash 2>&1 | head -20; echo "EXIT=$?"` falls through because `head` and `echo` are unlisted even though `Bash(gh pr *)` is allowed. Redirects are part of the string and don't break matching. **Run a legitimately-needed command bare**, with no pipe or trailing `; echo`, so its allow rule fires deterministically.

**A denial often means the verb has no rule at all, not that it is forbidden.** Check `jq -r '.permissions.allow[]' .claude/settings.local.json | grep <verb>` before concluding a command is barred by policy. **Verdicts are non-deterministic** — so never conclude from one sample in either direction. The classifier also reads *intent*: a `python3 - <<'PY'` heredoc rewriting a file was denied though `Bash(python3 *)` is allowed, so use the Edit tool for file edits rather than an inline interpreter.

Blocked by default: `curl | bash`, production deploys and migrations, force push, `git reset --hard` / `git checkout -- .` / `git clean -fd`, `terraform destroy`, merging a PR no human approved, disabling CI checks, production feature-flag changes. **Also blocked: the agent editing `.claude/settings.local.json` to widen its own allow list** — privilege escalation. Never route around a denial on your own initiative; an explicit founder instruction to change the settings is the authorisation, and such an edit takes effect within the same session with no restart. That file is globally gitignored, so it is personal and never committed.


---

## 11. Auto-memory is off

`"autoMemoryEnabled": false` in this repo's `.claude/settings.json` is the whole mechanism. Verified at mantahostels#642 (the ticket that flipped the switch and tested what it stops) on Claude Code 2.1.237.

- **Project scope, deliberately.** The key is read from the *merged* settings, so the project-level spelling binds. Chosen over `claude --bare` (per-session, so every session must remember) and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (global — every other project on this machine).
- **`false` stops reading, recall and writing together** — a fresh session loads no `MEMORY.md` and is offered no memory-saving tool.
- **A session already running keeps auto-memory until it restarts** — merged settings are memoised per session. So the store can still gain entries from a session that predates the flip.
- **The store is untouched:** the files come back byte-identical if the key is removed or set back to `true`.

---

## 12. In-repo scratch lives in `.claude/tmp/`, and nowhere else

**`.claude/tmp/` is the one sanctioned in-repo scratch directory.** Founder ruling (mantahostels#2089, the ticket that chose it over an out-of-repo-only rule). Put session scratch there under a name of your own — a mutation log, a captured run, an intermediate grep, a subagent's findings file. A repo-relative path is the reason: it cannot fail to resolve, which `$CLAUDE_JOB_DIR` demonstrably can (mantahostels#2088) — the surviving hazard. The earlier claim that `gh` itself cannot read a `$CLAUDE_JOB_DIR` path was falsified (mantahostels#2688) and the rule was corrected around mantahostels#2088 alone at `docs/agents/issue-tracker.md:179-181`.

**This counter-instructs the background-job preamble, which says the opposite.** Every background job opens with harness text sending temporary files to `$CLAUDE_JOB_DIR/tmp` instead of `/tmp`. That is a harness default and this is a repo rule, but the ranking that actually settles it is `CLAUDE.md` §Ground truth's **first** limb — a guard's text beats any file, unconditionally — so the rule reaches a background job through `scripts/guard-dispatch.js` (its `guard-job-dir-scratch` core), which refuses a file straight into `$CLAUDE_JOB_DIR/tmp` and warns on any deeper job-dir write (#1139; `docs/agents/rules/job-dir-scratch.txt`), rather than through this section or an always-loaded line, which is too general to beat a preamble scoped to background jobs (mantahostels#2406, mantahostels#2407).

**The scope is the scratch path YOU choose.** A repo script writing its own job-dir path is compliant — `scripts/bg-run.sh` and `scripts/issue-body.js` both do it deliberately (mantahostels#2340). The guard cannot breach that scope: a `PreToolUse` hook reads your own tool input and never a script's internal write. A path a skill hands its subagents is not that — each subagent's own tool call reaches the hook (#1140).

**The exception: a headless `claude -p --permission-mode dontAsk` session can never write here.** `.claude/` is a Claude Code protected path, and in `dontAsk` mode a write to one is denied whatever `--allowedTools` or `permissions.allow` say — the safety check runs before allow rules, so not even `Edit(.claude/**)` lifts it (`code.claude.com/docs/en/permission-modes` §Protected paths). The bare denial under `--allowedTools "Write"` was verified on 2.1.294, 8 Oct 2026; the scoped-rule case rests on the docs alone (#922). **So a headless session's scratch goes to a repo-relative directory outside `.claude/`, and a prompt replayed into one has its `.claude/tmp/` paths rewritten first.** That directory has none of the five exclusions below, and `npm run status` names what is left in it as a stray, so delete it when the run ends. The same check means an ordinary auto-mode session's writes here are routed to the classifier, not pre-approved: this directory stays sanctioned only while the classifier consents.

**Nothing here is kept, and a reaper enforces that (mantahostels#2214)** — `scripts/lib/scratch-sweep.js`, spawned detached at every session start by `scripts/sweep-debts-detached.sh`.

**A file goes only where both limbs hold: it is over 24 hours old, AND no session `claude agents --json` currently lists started before its write time.** Limb 2 is the safety proof — a session that started after a file was last written has never written it — and limb 1 is the retention floor covering limb 2's one hole, a detached child outliving its session and still writing. **The write time is the later of mtime and ctime** (#1003). An entry whose name contains `research`, and anything under the top-level `agents/` directory where `scripts/lib/dispatch-rewrite.js` supplies a dispatch's artefact, answers to 7 days instead of 24 hours — the path being the only signal the sweep has that a dispatched agent's evidence may still await landing (#1009). A research artefact named without the word gets 24 hours, accepted at that ruling. A subdirectory the sweep has emptied goes too, on the same two limbs. On an unreadable liveness oracle nothing is deleted at all, and the refusal goes to the arbiter's error log.

**Its one silent failure mode: a live record whose `startedAt` cannot be read spares every file.** That is deliberate — the oracle degrades to doubt, never to "dead" — but if the field ever stops being emitted, the sweep goes quiet for good and only the file count says so.

Nothing warns you before a file goes, and nothing records what went.

**A research artefact is drafted here and does not stay:** it is posted on its issue (`docs/agents/issue-tracker.md` §Research artefacts).

**Five exclusions:**

| Where | What it stops |
|---|---|
| `.gitignore` | scratch reaching a commit — and, through `biome.json`'s `vcs.useIgnoreFile`, Biome's scope as well |
| `biome.json` `files.includes` | Biome and the post-write core (`scripts/lib/post-write.js`) reformatting scratch on every write, independently of that flag staying true |
| `vitest.config.ts` `exclude` | a frozen copy of an older test file there failing the local suite (mantahostels#2018) |
| `scripts/lib/arbiter-core.js` `EXEMPT` | the claim guard taking a claim on every scratch write, which stranded two of them (mantahostels#2053) |
| `tsconfig.json` `exclude` | nothing live — `**` globs already skip dot-directories (`tsconfig.json`:59-65, mantahostels#1138), so a fixture `.ts` here was never in `tsc --noEmit`'s scope. Named explicitly anyway, as a pin against that mechanism changing (mantahostels#3159) |

Vitest reads neither `.gitignore` nor `biome.json`, so its leg stands on its own.

<!-- guard-registry:begin -->
<!-- Every rule here carries **Enforced** / **Advisory** / **Unenforced** / **Unenforceable**; `scripts/check-guard-registry.js` gates it. -->

- **Every Bash write the guard tier reads — a redirect, `tee`, a `cp` or `mv` destination, `sed -i` (#1827) — and every `Write`, `Edit` or `NotebookEdit`, into a dot-prefixed file at the repo root is REFUSED before it runs.** **Enforced** (mantahostels#2104, which ruled a warn; mantahostels#2319, which measured the `Stop` one delivering to nobody; mantahostels#2323, which ruled a deny and made a zero-false-positive measurement its gate; mantahostels#2340, which measured that gate failing and landed the pre-agreed warn; mantahostels#2436, which re-measured and took the deny anyway; mantahostels#3380, which added the file tools after a `Write` stray landed past the Bash deny): `scripts/guard-dispatch.js` (its `guard-root-scratch` core, on all four tools) denies the call and names the stray, the spelling of it inside the sanctioned directory above, and the escape. It fires only where the target is dot-prefixed, sits **directly** at the root, and git neither ignores nor tracks it — the ignore limb being what separates this section's breach from a root dotfile `.gitignore` sanctions. The guard tier writes its own markers under .claude/tmp/markers, never at the root.
  - **TWO LEGITIMATE ROOT WRITES ARE REFUSED BY IT**, and the escape below is what carries them: a mutation arm breaking the declined-Markdown-tooling guarantee, across every name `markdown-tooling-declined.test.ts` enumerates (`.remarkrc`, `.prettierrc`, `.textlintrc`, `.prettierignore`, `.lycheeignore`), and mantahostels#2340's `.tsconfig-checkjs.tmp.json`, whose `extends` globs resolve relative to itself. **Gitignoring them is not the fix**: the ignore limb means *sanctioned root dotfile*, and these are its opposite. **Nor is an in-guard allowlist** of those six names — it would be kept in step with a test file by hand, and would silently permit a real stray called `.prettierrc`. mantahostels#2436 carries the measurement, its method and the correction to both.
  - **THE ESCAPE IS ANOTHER WRITE SPELLING, AND THE REFUSAL HANDS IT OVER**: this reads lib/shell-parse.js's `writeTargets` spellings and file-tool paths only, so a `dd of=` or a `node -e` writing the same file is not seen, and the refusal itself hands the session the `dd` route rather than a flag. **It is therefore trivially defeated by anyone who means to defeat it**, and what it stops is the reflexive `> .foo.out` or `| tee .foo.out`.
  - **WHAT IT BUYS is measured on mantahostels#2436**: at least 95.2% of the root strays then on disk were named by a redirect target in a command it refused. mantahostels#2321's 81.5% is not a ceiling on it — that is the share a parent's transcript traces to a Bash redirect, and a subagent's calls, absent from that transcript, reach this hook with their own `agent_id` (mantahostels#1804, #1106). mantahostels#2349 owns what does pass it, visible only as a tree state afterwards.
  - **THERE IS NO LATCH, AND ITS ABSENCE IS DELIBERATE.** mantahostels#2401 (ruled at mantahostels#2377, which measured the two candidate latch keys) bounded the WARN to one full delivery per `(agent, session)`; a latched deny would allow every stray after the first, so each refusal fires on its own — no `ctx.told` latch and no gitignored marker prefix.
  - **A target it cannot read literally is judged as a SYNTHETIC WHOLE NAME** (mantahostels#2372, built at mantahostels#2398): every `${…}`, `$(…)`, `$VAR` and backtick span becomes a single `X`, and that name takes the same two git reads, so `… > .a2357.$c.json` is refused while `.env.$SID` stays silent on `.gitignore`'s `.env*`. The TRACKED limb is asked as a pathspec with each span as `*` instead. **Two shapes are still unread**: an UNQUOTED `$(…)` or backtick, which the flattener splits into a segment of its own before the redirect walker sees the target (quoted, it is read); and a `.gitignore` pattern constraining the VARIABLE span rather than the suffix — `.mut-[0-9]*.out` would claim the real name and not `.mut-X.out`, so a sanctioned file would be refused, and no pattern of that shape is in this repo today.
  - **Three further limits**: it guards the Bash tool, so a command in a terminal sees no hook; a git that cannot answer `check-ignore` allows the write, recorded; and a refusal whose stdout is discarded — a hook cancelled at its 10 s ceiling — reads to Claude Code as an allow, so the write lands unrefused and unreported. **The `Stop`-hook warn this replaces is deleted** (mantahostels#2338): it reached no reader on either side, model or terminal — the figures are on mantahostels#2319 and mantahostels#2338.

- **A stray that reaches the tree anyway is named to whoever next runs `npm run status`, and never to the session that wrote it.** **Advisory** (mantahostels#2349, which built it; #185, which admitted the marker): `scripts/check-stray-scratch.js`, on `npm run status` since `ad6edc1e4` lifted it off `SessionStart`, counts the untracked paths sitting in the repo outside the sanctioned directory above, **names the first five it has CONDEMNED on both limbs of the reaper's own test above (mantahostels#2505)** — 24 hours old or more (the same age the sanctioned directory's own reaper uses) AND confirmed by the liveness oracle as predating no live session — and hands over `git status --porcelain | grep '^??'` for the rest. **A younger path, and one whose mtime it could not read at all, is counted and never named** (mantahostels#2436, mantahostels#2418): naming them put a live session's working scratch under an `rm` remedy. **The oracle is read once per run and only where the age cut named a candidate at all; an age-settled path a live session predates is spared and counted separately, and an unreadable oracle spares every age-settled candidate rather than naming one under `rm` on a guess — but WARNs rather than reading the tree as tidy**, the same "subject, not apparatus" direction as the SKIP below. **It reports and moves nothing** — the reaper named earlier in this section works inside that directory alone, mantahostels#2323 having declined extending it to the repo root. **`docs/research/` IS ITS SECOND BUCKET, NOT AN EXCLUSION** — counted and capped as scratch is, but named whatever its age and with no liveness read, under the finding code `STRANDED-UNTRACKED` and **the opposite remedy: post it on its issue, then delete it, never a bare `rm`** (mantahostels#2447, mantahostels#2455; #2335). An untracked path there is somebody's finished research, which `docs/agents/issue-tracker.md` §Research artefacts posts on its issue and never commits. **Both buckets come from one tree read, so an untracked `docs/research/` collapses to a single line.** **It reads the whole tree and not this session's own writes**, so a neighbour's stray is named to whoever next runs the report, unattributed — the breach route is a Bash redirect, which records no author. **Its silence proves nothing where git is unreadable**: a `git status` that will not answer SKIPs rather than reporting a tidy tree. **No hook ceiling truncates the liveness read**: nothing runs this with `--notify`, so the `async: true` / `WFC_NOTIFY_PERSIST=1` wiring mantahostels#2537 gave it is gone. The persist-and-replay route itself is live, and still carries `check-ci-status.js` and the reaper. **The trade is that a stray sits unnamed until someone runs the report.**

- **The first `Write` over a file in the sanctioned directory that this session has not written is REFUSED, naming a session-suffixed name; the same call re-sent goes through.** **Enforced** (#1167, which ruled a warn; #1728, which made it refuse once): `scripts/guard-dispatch.js` (its `guard-scratch-overwrite` core, on `Write`) records each path a session writes in that directory and refuses once per path where the target already exists, is off that record, and its name, before the extension, does not already end in `-` and the session's first eight id characters. The refusal puts the path on the record, so the re-send passes and the path is never refused again that session. **The claim exemption in the table above stands** — no claim and no version. **It sees no Bash-route write**, so a file a session made with `>` and then `Write`s over is refused once, unless its name, before the extension, ends in the session's id.
<!-- guard-registry:end -->

**A subagent in a throwaway worktree resolves `.claude/tmp/` inside that worktree**, not the canonical checkout, so a parent watching the artefact sees nothing (mantahostels#2093).

## 13. Three Claude plans, one shared config

`~/.bashrc:199-211` runs Claude off `~/.claude`, `~/.claude2` and `~/.claude3`, each pinned by `CLAUDE_CONFIG_DIR`. **A background job inherits the config dir of the session that launched it** — nothing in the repo or in `~/.bashrc` binds it to one. Read it rather than assuming: `$CLAUDE_JOB_DIR` sits under the config dir in force, so a job on plan 2 has `/home/<login>/.claude2/jobs/<id>`.

**Every plan trusts the same project folders** (#828). Workspace trust is per plan, in `.claude.json`, and a mod loads only in a trusted folder; settings hooks run either way. Plan 1 has not trusted workflow-core because its subscription is lapsed, so when it is renewed, accept the trust prompt in every folder plans 2 and 3 trust.

**Shared config is one copy, symlinked** (#107, which ruled drift between the dirs must be impossible, reversing mantahostels#3233's keep-in-step-by-hand). `settings.json`, `keybindings.json`, `statusline.sh`, `CLAUDE.md`, `practice-crafts.md`, `skills/`, `plugins/`, `agents/`, `commands/` and `output-styles/` in every `~/.claude<n>` are meant to be symlinks to `~/.claude`'s — `--check` below lists any that are not; credentials, `.claude.json`, sessions, jobs, projects and history stay per plan. So a plugin installed, updated or removed under any plan changes all three.

**`node scripts/link-config-dirs.js` restores it** — merges each diverged entry into `~/.claude` (the plugin registries entry by entry; elsewhere `~/.claude`'s copy wins a clash), moves the sibling's copy to `<sibling>/.pre-link/`, and links. `--check` reports, and `npm run status` runs it (#2038). **Unenforced**: nothing stops a write replacing a link with a real file — the next `npm run status` names it.

**Edit a shared entry at `~/.claude/<entry>` only, never through a plan dir's path** (#2174). An editor that writes a temporary file and renames it over the path it was given replaces a link with a plain file: GNU `sed -i` does, unless run with `--follow-symlinks`. Run `node scripts/link-config-dirs.js --check` after any such edit.

**A workflow-core checkout needs its `wfc-self` self-plugin set up once per machine** (#2446). The core's own guards register from `self-plugin/hooks/hooks.json` (#2447), which loads only through a marketplace the machine knows, and a `directory` source takes an absolute path, so no committed file can declare it. Without it, the canary in `.claude/settings.json` (`scripts/self-plugin-canary.sh`) refuses every tool call. Run, naming the main checkout, never a worktree:

```
claude plugin marketplace add '<absolute path to the main checkout>/self-plugin' --scope user
```

then restart any session open there. It enables nothing: the committed `enabledPlugins` entry in `.claude/settings.json` enables the plugin for this repo alone, and no `claude plugin install` is needed (#2446). Never enable `wfc-self` at user scope: its hooks would run in every repo on the machine. Re-copy `~/.claude/settings.json` into `docs/claude-user-settings.md` after the run.

**A cloud session of this repo is always refused by the canary**: no repo-declared plugin's hooks run in the cloud (#1892), so it would run with no guards. **A guard added to `self-plugin/hooks/hooks.json` reaches a live session only at its next start or `/reload-plugins`**: plugin hooks are read at session start and do not reload live, unlike `.claude/settings.json`'s (spec #2295).

⚠ **A `claude plugin` command writes enablement keys into `.claude/settings.json` — this repo's tracked file — and can empty the user one.** Measured at mantahostels#3246. **Read `git diff .claude/settings.json` and the user file's `enabledPlugins` after any plugin command**, and reverse what you did not intend with a targeted edit, never `git checkout --` (mantahostels#250).

**A plugin update lands in a fresh cache directory carrying the upstream's hook files.** The version is in the path, so a hand edit to a plugin's `hooks.json` does not survive an update. `scripts/silence-last30days-hook.sh` does that for the one plugin this repo silences; `--check` reports without writing.
