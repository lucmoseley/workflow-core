#!/usr/bin/env node
/*
 * guard-issue-body.js — PreToolUse guard: the raw issue-body write
 * (mantahostels#132). The core is lib/issue-body-write.js.
 *
 * Why: a GitHub issue body is download-whole/edit/upload-whole, so two
 * sessions editing one issue means the second silently erases the first, and
 * GitHub offers no conditional write to prevent it (mantahostels#128). The
 * answer is scripts/issue-body.js (mantahostels#131), which re-fetches after
 * writing and re-applies your change onto a rival's body where it was
 * overwritten.
 *
 * DENY, not warn. With every caller routed through the script there is no
 * legitimate direct use of `gh issue edit --body` left at all —
 * mantahostels#103's deny side, which is deny on a structured fact where the
 * action has no legitimate use, warn where the hook is inferring.
 *
 * No WFC_ALLOW_* escape, and none is needed: issue-body.js calls GitHub from
 * Node rather than through the Bash tool, so the permitted path never reaches
 * this hook.
 *
 * DENIES-THROUGH: lib/guard-entry.js — `run` writes the core's deny, so the
 * registration carries `"onFailure": "block"` and a crash or timeout refuses.
 *
 * FAILS CLOSED on a core that throws (lib/refuse-on-throw.js).
 *
 * THE OTHER SPELLINGS
 *  - `gh api --method PATCH repos/…/issues/<n>` IS chased — the spelling a
 *    session reaches for the moment the flag form is denied. Where the PATCH
 *    is aimed at an issue but the guard cannot see its fields — a fully
 *    quoted `-f "body=…"`, or `--input` — it WARNS rather than denying,
 *    because there it is inferring, not reading (mantahostels#103).
 *  - `gh api graphql` carrying an `updateIssue` mutation with a body field IS
 *    chased (mantahostels#284), by reading its `query` field back out of the
 *    span the parser blanked. Where the guard cannot see that text it WARNS,
 *    the same inferring tier as the unreadable PATCH — `-F query=@file`,
 *    `--input`, a variable, a command substitution, or an input object passed
 *    whole as one variable. Denying every opaque `gh api graphql` would
 *    refuse the read-only queries that are routine here.
 *  - The graphql deny is judged on the `query=` field's VALUE, concatenated
 *    by scanGraphql and scoped by mutationArgs (both lib/gh-api-call.js), and
 *    `body:` counts only between `updateIssue(` and its first `)` — a
 *    response selection (`{issue{body}}`, the `{issue{body:bodyHTML}}` alias)
 *    reads and runs; whitespace is squashed first; an `input:$var` argument
 *    names no field and drops to the warn tier. The deny is deliberately NOT
 *    gated on the endpoint being `graphql` — a masked or variable endpoint
 *    would otherwise walk past a mutation in plain sight — and a query only
 *    partly readable is still denied on what can be seen. THE WARN IS GATED,
 *    though: the warn for an unreadable query sits behind isGraphql, so a
 *    masked endpoint carrying an unreadable query gets neither deny nor warn
 *    and passes in silence.
 *  - RESIDUAL, what still reaches a body: the warn cases above; a wrapper or
 *    non-`gh` client; `updateIssue(` inside a string literal in a read-only
 *    query; and the founder's own terminal, which no Bash hook binds.
 *    check-clobbered-bodies.js covers those after the fact.
 *
 * LIMITS
 *  - It matches the *parsed command form* — a segment whose command word is
 *    `gh`, whose subcommand pair is `issue edit`, carrying a body flag — never
 *    a substring, so a grep, an echo or a heredoc mentioning `gh issue edit
 *    --body` passes. The parser is lib/shell-parse.js, shared with every
 *    Node guard (mantahostels#123).
 *  - Scope is the ISSUE body. `gh issue create --body` writes a body that
 *    does not exist yet; `gh issue comment` creates a new resource and reads
 *    no existing state; `gh pr edit --body` is a different resource with no
 *    helper to route to.
 *  - It FAILS OPEN (mantahostels#103 §6): every payload fault
 *    lib/guard-entry.js names is allowed through and RECORDED
 *    (mantahostels#147), for check-guard-errors.js to report under `npm run
 *    status`. With no node on PATH the hook line exits 0 unrecorded. The
 *    unreadable-PATCH case is not one of these: it warns rather than failing
 *    open.
 *  - A write reached through a wrapper — `xargs gh issue edit`, a shell
 *    function, a script — is not seen, because only a segment's own command
 *    word is read.
 *  - Wired with `if: Bash(gh *)` (mantahostels#2127; best-effort:
 *    docs/agents/guard-authoring.md's surface 4, which fails toward running)
 *    — not started unless some segment of the command leads with `gh`.
 *    NEARLY the same test as the core's own basename check, which differs on
 *    one spelling: `/usr/bin/gh …` passes the basename and matches the
 *    anchored form in neither spelling, so a path-spelled call is unjudged
 *    (mantahostels#2127).
 *  - THE RULE IT PRINTS lives in docs/agents/rules/, not here
 *    (mantahostels#1649, spec mantahostels#1641): CLAUDE.md keeps a trigger
 *    line naming the id, and this guard splices the fragment into its
 *    refusal. An unreadable fragment is the ONE fault this guard does not
 *    fail open on and does not log — the command is resolved and known bad,
 *    only the rule could not be read; it refuses with a pointer to the
 *    fragment instead.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/issue-body-write.js");

run({
	field: "command",
	noun: "command",
	onThrow: "refuse",
	decide,
});
