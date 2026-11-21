# ADR-0010 — Guard logic lives in Node cores, behind a dispatcher per tool event

**Status:** accepted · 24 October 2026 · settled at #2733 (the core-and-shell testing spec), first built at #2784 (the parser's first half and its first two guards); the PreToolUse dispatcher built at #2786; every PreToolUse guard folded into it as ruled at #3211 Q3 (A), built at #3224–#3227

## Context

The 45 bash guards held their logic in bash, so none could be tested in-process. One guard run cost about 250 ms in tests, and bash-guard test files were 26% of CI per-file seconds (#2194). A plain Bash call started 18 always-on bash hooks, a median 515 ms of CPU and about 330 processes (#2711). Every guard read its command through one shared parser, so none could move until the parser had a Node form. The #2784 port cut the two moved guards' test time 75–80% and their per-call CPU by more than half.

## Decision

A guard's parsing and deciding logic is a Node **core** that does no I/O. Its **shell** is the hook command line plus a Node entry, the composition root: it builds the adapters, hands the core its ports, writes what the core decides and exits. The hook line's one branch is the fail-open where Node is missing: `command -v node >/dev/null 2>&1 || exit 0`.

`scripts/lib/shell-parse.js` is the parser's core; `scripts/lib/guard-entry.js` the kit every entry is built from. Each core keeps its guard's failure policy: an advisory core fails open on the record, a store fault fails closed. A refusal is `permissionDecision` JSON on exit 0, never an exit code a `|| true` could swallow. Every adapter carries a timeout below its hook's, and a timed-out adapter answers its own failure outcome.

Every PreToolUse guard runs as a core inside one Node dispatcher, `scripts/guard-dispatch.js`, `if`-narrowed guards included: a narrowed core's row in `scripts/lib/guard-cores.json` carries its `if` clauses, and the dispatcher loads its module only on a matching command. A PostToolUse guard joins that event's dispatcher when it is always-on, and keeps its own `if`-narrowed entry otherwise. The other events have no dispatcher, so each guard there keeps its own entry.

**Options:** porting each guard on touch lost because the repo would keep two parsers (#2733 story 32); a per-core time budget in a worker thread lost to per-adapter timeouts, since a core does no I/O and only an adapter can hang (#2733); `if`-narrowed guards keeping their own `sh` + `node` entries lost because the 24 that did cost about 50 processes per Bash call and 38% system time, the cause of the CPU load knee (#3211 Q3).

## Consequences

- **The Node parser reads only the variables it is handed**, never its own process's, such as `$PPID`.
- **Static readers learn a Node spelling.** `lib/rule-emission.js` and `check-guard-registry.js` read a core's `injectRules: [<id>…]` decision and follow a Node entry's `require`s into `scripts/lib`; a rule id built at run time is invisible to both.
- **An adopter's `disabled` list names the entry or the core**: a ported guard with its own entry as `guard-<name>.js`, a dispatched core by its row's `name` with no extension; listing `guard-dispatch.js` silences every dispatched core.
- **The dispatcher runs every matching core and merges**, a deny over an allow, every context joined under the 10,000-character persist cap. A core that throws, or whose module throws on load, gets its row's policy; a crash or timeout of the entry itself blocks the call (`onFailure: "block"`). Its hook timeout is 60 s, with the npm-install core's 30 s registry budget counted from the dispatcher's start (#3226).
