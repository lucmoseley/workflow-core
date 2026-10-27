#!/usr/bin/env node
/*
 * guard-issue-create-label.js — PreToolUse guard: every issue created from a
 * Bash call carries a `takes:` label (mantahostels#453, which ruled it). A
 * create on an Anthropic repo is the guard-anthropic-report core's to refuse
 * (workflow-core#1987).
 *
 * Why: `takes:` is the label naming the command that opens an issue, and
 * every open issue must carry exactly one — a missing value is a defect,
 * never a state to interpret. The guard reads the COMMAND, never the call's
 * output: a backgrounded call's output is the harness's job stub
 * (mantahostels#453).
 *
 * mantahostels#136 rejected a label deny as "not always knowable at creation"
 * — true of `wayfinder:*` and `kind:`, never of `takes:`, where
 * `takes:triage` always fits. It stands, and does not cover this axis
 * (mantahostels#470).
 *
 * The value is validated too: a misspelt value aborts a flag-form create at
 * exit 0, and on the REST route files a label nothing reads.
 *
 * DENY, not warn (mantahostels#103): a label's presence and value are read
 * off the command.
 *
 * DENIES-THROUGH: lib/guard-entry.js — `run` writes the core's deny, so the
 * registration carries `"onFailure": "block"` and a crash or timeout refuses.
 *
 * FAILS CLOSED on a core that throws (lib/refuse-on-throw.js).
 *
 * LIMITS
 *  - It matches the parsed command form — a segment whose command word is
 *    `gh`, subcommand pair `issue create` — never a substring, so a grep, an
 *    echo or a heredoc mentioning `gh issue create` passes. So does a wrapped
 *    call — `timeout N gh …`, `env gh …` — whose command word is not `gh`.
 *  - `gh api --method POST …/issues` IS chased (mantahostels#511), and gh's
 *    own default with it — a call carrying fields and no --method at all is a
 *    POST.
 *  - `gh api graphql` carrying a `createIssue` mutation IS chased
 *    (mantahostels#519), by reading its `query` field back out of the span the
 *    parser blanked. A mutation carrying no `labelIds` at all is denied; one
 *    carrying labelIds is WARNED, GraphQL taking opaque node ids that name no
 *    label this guard can read. A query it cannot read at all — `-F
 *    query=@file`, `--input`, a variable, a command substitution — is left in
 *    SILENCE, the residual this route keeps: warning there would fire almost
 *    entirely on the read-only queries this repo runs daily, and
 *    guard-issue-body.js already warns on exactly those commands, so the
 *    opacity still reaches the session. A `)` inside a string literal
 *    truncates the arguments, and warns rather than denying.
 *  - A PreToolUse hook sees Bash tool calls only, so AN ISSUE CREATED BY A
 *    SCRIPT ESCAPES ENTIRELY. The GitHub web UI and the founder's own
 *    terminal escape the same way (mantahostels#109).
 *    scripts/check-issue-labels.js stays the only control for all three.
 *  - THE `takes:human` LIMB (mantahostels#2775) reads the create's BODY, and
 *    only on the flag form and the REST form, where the body text is on the
 *    command, in a file on disk, or in a heredoc piped into `--body-file -`
 *    (mantahostels#3439) — see lib/gh-body.js for the one-create shapes it
 *    trusts. A body it cannot read — a `$VAR`, a `$(cat …)`, `--body-file -`
 *    fed from anything but such a heredoc or a `cat <path> |`, an unquoted
 *    heredoc whose body would expand, a `-F body=@file` — is REFUSED (workflow-core#668),
 *    and the refusal names the heredoc form. The GraphQL route never reaches
 *    it at all: labels there are opaque node ids, so the guard cannot tell a
 *    `takes:human` creation from any other one.
 *  - THE OUTSIDE-LINE LIMBS are lib/takes-label.js's four tests, in its
 *    order, on create and on relabel: no act named (mantahostels#2775); a
 *    prohibition named rather than an act (workflow-core#140); a repo file as the act's
 *    product (mantahostels#3555, ruled on mantahostels#3503); none of the
 *    founder's own acts and no `Tried:` list of three (workflow-core#1097, ruled on
 *    workflow-core#1077). Each reads the Outside line alone and lexically, so a line
 *    naming the act without the path, or a list word in a non-act sense,
 *    passes.
 *  - THE CLOSE-WHEN LIMB (workflow-core#983) refuses a `takes:human` body, on create and
 *    on relabel, carrying no `**Close when:**` line, after the four
 *    Outside-line tests pass. Presence only. The refusal carries the
 *    `founder-deliverable` fragment; a body passing every limb gets a
 *    one-line pointer to it.
 *  - THE EDIT ROUTE (mantahostels#3555) reaches the same limbs through `gh
 *    issue edit <n>… --add-label takes:human`. The body is read off the
 *    command where the edit also carries an inline `--body`, and otherwise
 *    FETCHED — `gh issue view <n> --json body`, in the directory the edit
 *    runs in where it already exists, else the hook's, and against the repo
 *    an issue URL or `--repo` names, at most TWO
 *    fetches a command, each bounded by the host's GH_TIMEOUT_MS; a third
 *    number and beyond fail open, recorded. `gh` is
 *    `$WFC_GH`, else `gh` (base §N7). A fetch that fails, a `gh` that cannot
 *    be found, a number or a `--repo` the guard cannot read all FAIL OPEN,
 *    recorded. A `--body` it cannot read, or any `--body-file`, is REFUSED
 *    (workflow-core#669): relabelling alone always has its body fetched, and the refusal
 *    names that spelling. `--remove-label` and every other edit pass
 *    unjudged, and a relabel by script, GraphQL or the web UI still escapes;
 *    check-issue-labels.js catches those after the fact.
 *  - THE BLANK-BODY LIMB (mantahostels#3443) refuses, whatever the label, a
 *    flag-form create whose body is empty or whitespace-only — on the
 *    command, in a heredoc, or in a file — or whose `--body-file` path, or
 *    the one `cat <path> | gh issue create … --body-file -` pipes in, is
 *    absent from disk. A relative path resolves against the directory the
 *    command walk tracks (mantahostels#3453); a directory it cannot know and
 *    an unreadable body file both fail open, recorded — on a takes:human
 *    create, refused (workflow-core#668). A command naming the file's basename BEFORE the
 *    read is taken to write it first and passes unread, unrecorded: a script
 *    writing a path the command never names is the false refusal left, and a
 *    same-named file in another directory, or a basename inside a longer
 *    word, the missed one. The REST and GraphQL routes are not judged, and
 *    neither is a create carrying no body flag at all, which gh itself
 *    refuses outside a terminal.
 *  - THE BASIS LIMB (workflow-core#672) refuses, on a body the blank-body limb read, a
 *    gate line or a prose wait with no `**Gate basis:**`, or a window in
 *    either that the basis does not name (workflow-core#823), through lib/issue-gate.js.
 *    It checks the basis names each window, never that it holds up.
 *  - THE SECOND-MAP LIMB (workflow-core#717) refuses a flag-form or REST create carrying
 *    `wayfinder:map` while an open map's Destination still reads the new-repo
 *    placeholder (workflow-core#1464). The GraphQL route is not judged: its labels are
 *    opaque node ids, so telling a map create apart takes a lookup the hook's
 *    time limit has no room for — mantahostels#519's ground for the takes:
 *    limb. A `GH_REPO=…` on the create is not read: where no --repo or
 *    spelled-out REST endpoint names the repo, the maps are listed for the
 *    create's cwd, so that create is judged against the wrong repo.
 *  - It says nothing about PLACEMENT. The parent is not in the create
 *    command, so an unparented issue still passes;
 *    scripts/check-issue-orphans.js remains the only control there
 *    (mantahostels#453).
 *  - Wired with `if: Bash(gh *)` (mantahostels#2127; best-effort:
 *    docs/agents/guard-authoring.md's surface 4, which fails toward running)
 *    — not started unless some segment of the command leads with `gh`.
 *    NEARLY the same test as the core's own basename check, which differs on
 *    one spelling: `/usr/bin/gh …` passes the basename but matches no
 *    `Bash(gh *)` pattern, so a path-spelled call is unjudged.
 *  - It FAILS OPEN, house style (mantahostels#103 §6): a label value it
 *    cannot read — an unexpanded $VAR, a command substitution — lets the
 *    whole call through unjudged, RECORDED (mantahostels#147) for
 *    check-guard-errors.js to report under `npm run status`, and so does
 *    every payload fault lib/guard-entry.js names. With no node on PATH the
 *    hook line exits 0 unrecorded.
 *  - THE RULE IT PRINTS lives in docs/agents/rules/, not here
 *    (mantahostels#1649, spec mantahostels#1641): CLAUDE.md keeps a trigger
 *    line naming the id, and this guard splices the fragment into its
 *    refusal. An unreadable fragment is one of THREE faults this guard does
 *    not fail open on and does not log — the command is resolved and known
 *    bad, only the rule could not be read; it refuses with a pointer to the
 *    fragment instead. The others are an unreadable takes:human body on a
 *    create (workflow-core#668) and on a relabel (workflow-core#669), refused above.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/issue-create-label.js");
const { buildHostPorts } = require("./lib/issue-create-label-host.js");

run({
	field: "command",
	noun: "command",
	onThrow: "refuse",
	decide,
	ports: buildHostPorts,
});
