# Guard-port cut band: how much of the bash-guard test time a Node core removes (#2202, map #2186)

Machine: aarch64 (Snapdragon, WSL2), 8 cores, 10 GB. Date: 2026-10-19. The machine has neighbour sessions. Load1 at start: 12.2.

## Method

The F8 method (`docs/research/test-wait.md`) counts `execve` under strace. Then it multiplies the run count by a guard cost that it measured outside the test. strace makes the wall slow, so F8 could not use the wall of the same run. F8 then divides by a wall from a different run.

This note measures both parts of the ratio in the same run, with the instrument in the Appendix:

- A preload module (Appendix `preload.js`, given by `NODE_OPTIONS=--require`) wraps each `child_process` call (`spawnSync`, `execFileSync`, `execSync`, `spawn`, `execFile`, `exec`) in the vitest fork worker. It writes one line for each call: the program, the first arguments, and the wall time of the call. Then it calls `module.syncBuiltinESMExports()`, so the ESM named imports in the test files get the wrapper too.
- Only the vitest fork worker logs (depth 2: `run-vitest.js` is 0, vitest 1). Child Node processes do not log.
- The test files call the guard by `spawnSync` (a synchronous call). Thus the wall of the call is exactly the time that the test waits for the guard. This time includes the guard's own children (git, jq, realpath, and so on).
- File time: the "tests" figure of the vitest summary for a run of one file (`--maxWorkers=1`). This is the same unit as the CI file-seconds in F4.
- **Guard-run share = (sum of the wall of the guard calls) / (file time).**
- A "guard call" is a call whose program is a `scripts/**/*.sh` file, or `bash` with a script or a `source` of a `scripts/lib/*.sh` library. I give the git calls of the test itself (fixture work) as a separate figure. An in-process core does not remove them.
- Run command (a rerun gives a new measurement): `R2202_OUT=<log> NODE_OPTIONS="--max-old-space-size=2048 --require <dir>/preload.js" node scripts/run-vitest.js <file> > <vitest output>`, then `python3 <dir>/sum.py <log> <vitest output> <env file>`, the env file holding `date -Is`, `/proc/loadavg` and `free -m` taken before the run.

## Q4. In-process unit cost (what a call costs after the port)

**LABEL: measured.** Date 2026-10-19 20:08 +08:00. load1 8.1 (load5 11.9). `free -m`: used 4,554, available 5,369 MB. Node v24, aarch64. Plain `node`, outside vitest (no vitest transform).

| What | Calls | min (ms) | p50 (ms) | p90 (ms) |
| --- | --- | --- | --- | --- |
| A real Node guard core as a function: `hasPassingInventory` + `parkTargets` (`scripts/guard-inventory.js`), 3 messages | 2,000 | 0.003 | 0.008 | 0.035 |
| A proxy of a ported bash-guard decide step: tokenise one command, test 60 regex patterns | 5,000 | 0.014 | 0.016 | 0.020 |
| `runInProcess` of the whole `guard-inventory.js` CLI with a Stop payload (module cache purged on each call) | 35 (5 warm-up calls not counted) | 8.3 | 11.0 | 15.9 |
| Cold `require` of `guard-inventory.js` and its libs (the part a cache purge pays again) | 27 | 4.5 | 5.6 | 13.4 |

Findings:

- Q4.1. A direct call of decision logic costs **about 0.01 to 0.04 ms**. This is about 1/5,000 of a bash guard call (60 to 250 ms, below). Thus the after-port cost of a test case that calls the core directly is near zero.
- Q4.2. A test that goes through `runInProcess` costs **about 8 to 16 ms** a call, for a module tree the size of `guard-inventory.js`. Most of this cost is the cold `require` after the cache purge (4.5 to 13 ms). A Node port of `lib/guard-parse.sh` (3,367 lines of bash) is a larger module tree. Thus its `runInProcess` cost is probably higher (estimate: 15 to 40 ms; not measured, because no port exists).
- Q4.3. Thus the saving per guard run depends on the test style after the port:
  - A case that calls the core function: saves about 100% of the guard call.
  - A case that goes through `runInProcess` (the hook entry in-process): saves the guard call minus about 10 to 40 ms. At a guard call of 60 to 250 ms, that is about 60 to 95% of the call.
  - A boundary contract test that keeps the real spawn: saves nothing.
- Q4.4. Caution: the decision logic of `guard-inventory.js` took its early return on some of the 3 messages. The proxy (row 2) is synthetic. These two rows are a floor for a direct call.

## Q1. Prediction band: 9 bash-guard test files, measured

**LABEL: measured.** One run of each file, 2026-10-19 20:07 to 20:16 +08:00, in the order of the table. Method above. All runs passed. 11 files are measured.

"All-spawn share": as the guard share, over every child-process call of the worker (guard plus the test's own git fixture work and other tools).

| File | CI file-s (F4 run) | load1 before → after | used / avail MB (before) | File time here (s) | Guard runs | Guard run p10 / p50 / p90 (ms) | Mean per run (ms) | Guard share | All-spawn share |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `scripts/lib/guard-parse.test.ts` | 55.9 | 12.0 → 8.7 | 4,617 / 5,306 | 34.2 | 462 | 14 / 43 / 95 | 55 | **0.739** | 0.744 |
| `scripts/guard-commit-form.test.ts` | 171.7 | 8.7 → 12.7 | 4,578 / 5,345 | 195.7 | 486 | 83 / 226 / 784 | 351 | **0.872** | 0.907 |
| `scripts/guard-pull-form.test.ts` (F8's file) | 57.4 | 12.7 → 11.8 | 5,029 / 4,894 | 56.3 | 354 | 78 / 114 / 219 | 134 | **0.844** | 0.864 |
| `scripts/guard-echo-call.test.ts` | 42.3 | 11.8 → 13.9 | 5,452 / 4,471 | 28.0 | 296 | 48 / 82 / 153 | 93 | **0.990** | 0.990 |
| `scripts/guard-npm-install.test.ts` | 30.1 | 13.9 → 16.3 | 5,091 / 4,832 | 25.6 | 197 | 52 / 80 / 172 | 96 | **0.742** | 0.946 |
| `scripts/guard-bg-job.test.ts` | 2.4 | 16.3 → 19.1 | 4,930 / 4,993 | 2.0 | 18 | 29 / 85 / 356 | 105 | **0.958** | 0.960 |
| `scripts/guard-tracker-rules.test.ts` | 55.0 | 19.1 → 12.9 | 4,783 / 5,140 | 67.3 | 148 | 48 / 410 / 711 | 450 | **0.988** | 0.989 |
| `scripts/guard-push-rules.test.ts` | 76.8 | 12.9 → 13.9 | 4,690 / 5,233 | 51.1 | 86 | 46 / 544 / 927 | 532 | **0.895** | 0.955 |
| `scripts/guard-suite-concurrency.test.ts` | 62.3 | 13.9 → 10.5 | 4,972 / 4,951 | 36.2 | 376 | 66 / 81 / 130 | 94 | **0.973** | 0.973 |
| `scripts/guard-file-claim.test.ts` | 29.5 | 2.7 → 5.7 | 4,719 / 5,204 | 52.2 | 151 | 41 / 318 / 486 | 337 | **0.975** | 0.980 |
| `scripts/guard-issue-create-label.test.ts` | 58.1 | 5.7 → 5.8 | 4,644 / 5,279 | 34.2 | 441 | 44 / 72 / 115 | 75 | **0.973** | 0.974 |

Findings:

- Q1.1. **Guard share spread over 11 files: 0.739 to 0.990. Median 0.958. Weighted by CI file-seconds: 0.896** (over 641.6 of the class's 1,101.5 CI file-seconds; 58% of the class is measured). In the 5 repeated runs of Q2, the share of one file moved by 0.03 or less.
- Q1.2. The check against F8: F8 counted 353 guard runs in `guard-pull-form.test.ts` by strace. This method counts 354. F8 put the share at "almost all" (71 to 90 s of runs against a 57 to 78 s file). This method measures 0.844 in one run.
- Q1.3. The low two files have a known cause:
  - `guard-parse.test.ts` (0.739): each case is a short `bash -c 'source guard-parse.sh; <snippet>'`. The mean run is 55 ms, so vitest's own cost for each test is a larger part.
  - `guard-npm-install.test.ts` (0.742): the test builds git fixtures (git calls: 5.1 s, 20% of the file). An in-process core does not remove fixture work unless the test also changes to a fake git port.
- Q1.4. The cost of one guard run is not one figure. The mean is 55 ms (`guard-parse` snippets) to 532 ms (`guard-push-rules`). F8's 254 ms is in the middle. Large guards on a commit or push path run real git in their fixture (`guard-commit-form`: 26 runs over 1 s, 40.6 s together).
- Q1.5. The share is not the cut. The cut is the share less what stays after the port:
  - (a) the boundary contract tests that keep a real spawn (estimate: 3 to 10% of the guard runs of each file);
  - (b) the in-process cost of each moved case (Q4: about 0.01 ms for a direct call, 10 to 40 ms through `runInProcess`);
  - (c) the fixture git work, where the test keeps a real repo.
- Q1.6. **Estimate of the cut for each file: guard share × 0.80 to 0.97.** Low end: 10% of the runs stay real and the rest go through `runInProcess` at about 20 ms against a mean run of 100 to 500 ms (about 0.80 of the share). High end: 3% stay and the rest call the core directly (about 0.97). On the measured spread of the share (0.73 to 0.99), **the cut is 59% to 96% of a file's time. On the CI-weighted share (0.896): 72% to 87%.**
- Q1.7. **The band for the class.** The programme scope (the 55 `.sh` files that source `lib/guard-parse.sh`, plus the library) has 56 test files on CI, 1,101.5 CI file-seconds, 27.2% of 4,053 (F4 run). At a cut of 72% to 87% (CI-weighted) the class saves **about 790 to 960 file-seconds, 19.5% to 23.6% of the suite's file-seconds**. On F4's rule (Vitest wall ≈ file-seconds / 2.8), that is **about 280 to 340 s of CI Vitest wall** at the 18 Oct speed of the runner. Wide band (the file spread, 59% to 96%): 650 to 1,060 file-seconds, 16% to 26%.

## Q2. Noise: 3 files, 6 runs each

**LABEL: measured.** 2026-10-19. Run 1 of each file is the Q1 run (20:11 to 20:13). Runs 2 to 6 are 20:19 to 20:28 +08:00, in turn (pull, echo, npm, then again), so load changes reach all three files. Available memory before each run: 4,406 to 5,219 MB.

| File | Run | Start | load1 before → after | File time (s) | Guard runs | Guard share |
| --- | --- | --- | --- | --- | --- | --- |
| guard-pull-form | 1 | 20:11:33 | 12.7 → 11.8 | 56.30 | 354 | 0.844 |
| | 2 | 20:19:59 | 5.8 → 8.2 | 48.93 | 354 | 0.845 |
| | 3 | 20:21:33 | 5.3 → 5.8 | 48.70 | 354 | 0.844 |
| | 4 | 20:23:08 | 10.2 → 7.2 | 50.47 | 354 | 0.844 |
| | 5 | 20:24:44 | 6.9 → 11.7 | 61.76 | 354 | 0.855 |
| | 6 | 20:26:34 | 10.7 → 8.2 | 52.68 | 354 | 0.850 |
| guard-echo-call | 1 | 20:12:31 | 11.8 → 13.9 | 27.95 | 296 | 0.990 |
| | 2 | 20:20:49 | 8.2 → 6.4 | 24.44 | 296 | 0.989 |
| | 3 | 20:22:23 | 5.8 → 6.8 | 23.68 | 296 | 0.988 |
| | 4 | 20:23:59 | 7.2 → 6.2 | 22.67 | 296 | 0.988 |
| | 5 | 20:25:47 | 11.7 → 9.3 | 24.66 | 296 | 0.989 |
| | 6 | 20:27:27 | 8.2 → 8.5 | 23.77 | 296 | 0.988 |
| guard-npm-install | 1 | 20:13:00 | 13.9 → 16.3 | 25.58 | 197 | 0.742 |
| | 2 | 20:21:15 | 6.4 → 5.3 | 16.83 | 197 | 0.742 |
| | 3 | 20:22:48 | 6.8 → 10.2 | 18.76 | 197 | 0.752 |
| | 4 | 20:24:23 | 6.2 → 6.9 | 19.26 | 197 | 0.738 |
| | 5 | 20:26:14 | 9.3 → 10.7 | 18.62 | 197 | 0.733 |
| | 6 | 20:27:53 | 8.5 → 8.6 | 18.84 | 197 | 0.762 |

| File | Wall min / median / max (s) | Wall range / median | Wall CV | Share min / median / max | Share CV |
| --- | --- | --- | --- | --- | --- |
| guard-pull-form | 48.70 / 51.58 / 61.76 | 25% | 8.7% | 0.844 / 0.845 / 0.855 | 0.5% |
| guard-echo-call | 22.67 / 24.11 / 27.95 | 22% | 6.8% | 0.988 / 0.989 / 0.990 | 0.1% |
| guard-npm-install | 16.83 / 18.80 / 25.58 | 47% | 14.1% | 0.733 / 0.742 / 0.762 | 1.3% |

Findings:

- Q2.1. **The wall of one file moves by 22% to 47% of its median between runs (CV 7% to 14%)**, at load1 5 to 16.
- Q2.2. **The guard share moves by 0.03 or less (CV 0.1% to 1.3%).** The guard-run count does not move at all. Thus the ratio is about 10 to 100 times more stable than the wall. Use the share (or the count of guard runs) to read a port, not the wall.
- Q2.3. The load in this window (5 to 16) was lower than the 12 to 15 in the brief. A run at load1 20 or more can give a wider wall spread (F4 and mantahostels#2255 record up to ×1.7 on CI and a median ×39.6 for one spawning test under heavy local load). The share figure is safe from this, because both of its parts come from the same run.

## Q3. Pilot sizing

Choice: after `lib/guard-parse.sh` (the parser that all guards source), the 5 guards whose test files have the largest CI file-seconds (F4 run) and a measured guard share:

| Guard (test file) | CI file-s | Guard share (measured) | Predicted cut, CI file-s (share × 0.80 to 0.97) |
| --- | --- | --- | --- |
| guard-commit-form | 171.7 | 0.872 | 120 to 145 |
| guard-push-rules | 76.8 | 0.895 | 55 to 67 |
| guard-suite-concurrency | 62.3 | 0.973 | 48 to 59 |
| guard-issue-create-label | 58.1 | 0.973 | 45 to 55 |
| guard-pull-form | 57.4 | 0.844 | 39 to 47 |
| **5 guards** | **426.3** | | **307 to 373 (72% to 87% of the 5 files; 7.6% to 9.2% of the suite)** |
| lib/guard-parse (step 0) | 55.9 | 0.739 | 33 to 40 |
| **5 guards + parser** | **482.2** | | **340 to 413 (8.4% to 10.2% of the suite)** |

The cut is an estimate. Its inputs are measured (shares: Q1) and estimated (the 0.80 to 0.97 factor: Q1.6, Q4).

Findings:

- Q3.1. **On CI Vitest wall**, the 5-guard cut is about 307 to 373 / 2.8 = **110 to 133 s** (estimate). F4 records neighbour CI runs that differ by up to 400 s and a p50-to-max range of 689 to 1,546 s. It is under the CI runner noise.
- Q3.2. **On the 5 test files' own time, the pilot IS readable.** Here the cut is 72% to 87% of those files. The noise of one file's wall is 22% to 47% (range) at load1 5 to 16 (Q2). Locally, the 5 files took 369 s together in this session; the predicted cut is about 263 to 319 s. A cut of that size is 1.5 to 4 times the measured wall range of one file (22% to 47%), and 5 to 12 times its CV (7% to 14%). Thus it is readable in one before-and-after pair, and safely readable on the median of 3 runs each. Read it on CI as the file-seconds of the 5 files in one run, against the same 5 files in the F4 run or in the next untouched run.
- Q3.3. **The best reading is the count and share, not the wall.** After the port, the guard runs of each test file fall from a known count (commit-form 486, push-rules 86, suite-concurrency 376, issue-create-label 441, pull-form 354) to the kept contract tests. The guard share falls from 0.84 to 0.97 to near the kept fraction.

## Headline

- **Predicted cut for the bash-guard class: 72% to 87% of the class (wide band 59% to 96%), that is 790 to 960 CI file-seconds, 19.5% to 23.6% of the suite, about 280 to 340 s of CI Vitest wall.** Estimate on 11 measured files (58% of the class's CI file-seconds). The old prediction (80 to 95%, 21 to 25%) is a little high at its top.
- **A 5-guard pilot (plus the parser) is readable above noise on its own files' time and, better, on the guard-run count and share. It is not readable on the CI suite wall** (110 to 133 s against a runner noise of up to 400 s).

## Appendix: the instrument

Kept here so a port ticket can re-measure by the same method (§Method).

`preload.js`:

```js
// Times every child_process call made by a vitest worker. Research #2202. Untracked.
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const mod = require("node:module");
const depth = Number(process.env.R2202_DEPTH || 0);
process.env.R2202_DEPTH = String(depth + 1);
const OUT = process.env.R2202_OUT;
// Only the vitest fork worker logs: run-vitest.js is depth 0, vitest depth 1, its fork worker depth 2.
if (OUT && depth === Number(process.env.R2202_LOGDEPTH || 2)) {
	const log = (rec) => { try { fs.appendFileSync(OUT, JSON.stringify(rec) + "\n"); } catch {} };
	const desc = (file, args) => {
		const a = Array.isArray(args) ? args : [];
		return { file: String(file), a0: a.slice(0, 5).map((x) => String(x).slice(0, 120)) };
	};
	for (const name of ["spawnSync", "execFileSync", "execSync"]) {
		const orig = cp[name];
		cp[name] = function (file, args, ...rest) {
			const t = process.hrtime.bigint();
			try { return orig.call(this, file, args, ...rest); }
			finally { log({ k: name, ...desc(file, args), ms: Number(process.hrtime.bigint() - t) / 1e6, t0: Number(t / 1000000n) }); }
		};
	}
	for (const name of ["spawn", "execFile", "exec"]) {
		const orig = cp[name];
		cp[name] = function (file, args, ...rest) {
			const t = process.hrtime.bigint();
			const child = orig.call(this, file, args, ...rest);
			try { child.once("exit", () => log({ k: name, ...desc(file, args), ms: Number(process.hrtime.bigint() - t) / 1e6, t0: Number(t / 1000000n) })); } catch {}
			return child;
		};
	}
	mod.syncBuiltinESMExports();
	log({ k: "start", pid: process.pid, ts: Date.now() });
	process.on("exit", () => log({ k: "end", pid: process.pid, ts: Date.now() }));
}
```

`sum.py` (arguments: call log, vitest output, env file):

```python
import json, re, sys, collections as c

log, out, env = sys.argv[1:4]
txt = re.sub(r"\x1b\[[0-9;]*m", "", open(out).read())
m = re.search(r"tests ([0-9.]+)(m?s)", txt)
tests_s = float(m.group(1)) / (1000 if m.group(2) == "ms" else 1) if m else float("nan")
m = re.search(r"Tests\s+(.*)", txt)
tests_line = m.group(1).strip() if m else "?"
envl = open(env).read().split("\n")


def cls(r):
    f = r["file"]
    a = " ".join(r["a0"])
    base = f.split("/")[-1]
    if f.endswith(".sh"):
        return "guard-sh"
    if base == "bash" or base == "sh":
        if ".sh" in a or "source" in a or "pipefail" in a:
            return "guard-sh"
        return "bash-other"
    if base == "git":
        return "git"
    if base in ("node",) or f == process_exec:
        return "node"
    return "other:" + base


process_exec = "/usr/bin/node"
n = c.Counter()
s = c.Counter()
per = []
for line in open(log):
    r = json.loads(line)
    if "ms" not in r:
        continue
    k = cls(r)
    n[k] += 1
    s[k] += r["ms"]
    if k == "guard-sh":
        per.append(r["ms"])
per.sort()
p = lambda q: per[min(len(per) - 1, int(q * len(per)))] if per else float("nan")
res = {
    "file": out,
    "env": envl[:4] + envl[4:6],
    "tests": tests_line,
    "tests_s": round(tests_s, 2),
    "counts": dict(n),
    "sum_s": {k: round(v / 1000, 2) for k, v in s.items()},
    "guard_runs": n["guard-sh"],
    "guard_ms_p50": round(p(0.5), 1),
    "guard_ms_p10": round(p(0.1), 1),
    "guard_ms_p90": round(p(0.9), 1),
    "guard_share": round(s["guard-sh"] / 1000 / tests_s, 3),
    "all_spawn_share": round(sum(s.values()) / 1000 / tests_s, 3),
}
print(json.dumps(res))
```
