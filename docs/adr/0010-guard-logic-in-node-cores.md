# ADR-0010 — Guard logic lives in Node cores, behind one dispatcher per event

**Status:** accepted · 24 October 2026 · settled at #2733 (the core-and-shell testing spec), first built at #2784 (the parser's first half and its first two guards); the PreToolUse dispatcher built at #2786

## Context

The 45 bash guards hold their logic in bash, so none can be tested in-process. One guard run costs about 250 ms in tests (the library's load plus about 24 child processes), and bash-guard test files were 26% of CI per-file seconds (#2194). Live sessions pay too: a plain Bash call starts 18 always-on bash hooks, a median 515 ms of CPU, about 330 processes and 93,000 page faults, and at 10 concurrent callers the set waits 725 ms (#2711, findings F1 and F3).

Every guard reads its command through one shared parser, so no guard can move until the parser has a Node form.

## Decision

A guard's parsing and deciding logic is a Node **core** that does no I/O. Its **shell** is the hook command line plus a Node entry. The entry is the composition root: it builds the adapters, hands the core its ports, writes what the core decides and exits. The hook line holds no logic. Its one branch is the fail-open where Node is missing: `command -v node >/dev/null 2>&1 || exit 0`.

`scripts/lib/shell-parse.js` is the parser's Node core. `scripts/lib/guard-entry.js` is the kit every entry is built from: the payload read, the `disabled` stand-down, the module gate, the once-a-session rule latch and its cap, and the fault arms. Each core keeps its guard's failure policy. An advisory core fails open on the record. A store fault fails closed. A refusal is `permissionDecision` JSON on exit 0, never an exit code that a `|| true` could swallow. Every adapter a core is handed carries a timeout below the hook's 10 s, and a timed-out adapter answers that adapter's own failure outcome.

Always-on guards, those with no `if` narrowing, run as cores inside one Node dispatcher entry per hook event. They go straight into the dispatcher and never get an entry of their own first. `if`-narrowed guards keep their own entries, so each still starts only on a matching command.

## Measurements

The #2784 port moved two `if`-narrowed guards, `guard-node-heap` and `guard-headroom-read`. It was read with `scripts/measure-guard-port/`'s two instruments on 24 October 2026 at load1 11–16, which is not quiet. The before and after figures were taken back to back.

| | before (bash) | after (Node) |
|---|---|---|
| The two guards' test files, `tests` time | 1.76 s (0.44 + 1.32) | 0.35–0.44 s over four files |
| The same with the kit's own test file added | — | 0.57–0.65 s |
| Cut against #2733's 72–87% prediction and 59% stop | — | 75–80% for the guards' files; 63–68% with the kit's file |
| `free -m`, wall / CPU median per call (15 calls, two runs) | 100 / 85 ms and 96 / 81 ms | 44 / 35 ms and 49 / 36 ms |
| `node --max-old-space-size=2048 x.js`, wall / CPU median | 82 / 68 ms and 85 / 66 ms | 39 / 34 ms and 43 / 34 ms |
| Minor page faults per call | 14,000–18,400 | 3,400 |

## Consequences

- **The Node parser reads only the variables it is handed**, never its own process's, such as `$PPID`.
- **Static readers learn a Node spelling.** `lib/rule-emission.js` and `check-guard-registry.js` read a core's `injectRules: [<id>…]` decision, and follow a Node entry's `require`s into `scripts/lib`. A rule id built at run time is invisible to both.
- **An adopter's `disabled` list names the entry or the core.** A ported guard with its own entry is listed as `guard-<name>.js`; a dispatched core by its row's `name` in `scripts/lib/guard-cores.json`, with no extension; listing `guard-dispatch.js` silences every dispatched core.
- **The PreToolUse dispatcher is `scripts/guard-dispatch.js`** over `scripts/lib/guard-dispatch.js`. Its cores are listed in `scripts/lib/guard-cores.json`, with each row's tools, failure policy and module. It runs every core that matches and merges the results deny > defer > ask > allow, joining every context under the 10,000-character persist cap. A core that throws gets its row's policy. A crash or a timeout of the entry itself blocks the call (`onFailure: "block"`). The static readers see each core as its own registration on its own tools (`lib/guard-cores.js`'s `expandDispatched`).
