#!/usr/bin/env node
/*
 * guard-issue-close.js — PreToolUse guard: a close must say what is still
 * outstanding (mantahostels#185), must not close a roadmap card's issue while
 * the card is still not done (mantahostels#220), must not complete an issue
 * over unmet acceptance criteria (#1640), and must not complete one over
 * census rows its commits expired (#1913). The core is lib/issue-close.js.
 *
 * Why: a closed issue is corpus, not a queue — nothing surfaces it again — so
 * residual work parked in one is found only when the founder happens to read
 * the comment.
 *
 * The rule this enforces: every close carries a line beginning
 * `**Outstanding:**` — in the close's own --comment, or else the issue's
 * newest comment; an older marker does not count (#984). It holds the bare
 * word `none`, or items only, each `#N (what is left)` citing an OPEN issue
 * other than this one.
 *
 * THE SECOND RULE (mantahostels#220): a roadmap card's own issue is closed by
 * /card-close, never by hand. Closing it by hand does not merely skip a step
 * — /card-close step 1 refuses to run on an issue that is already CLOSED, so
 * a hand close makes the command unusable and the roadmap edit has to happen
 * outside the one thing that sequences it (mantahostels#165).
 *
 * The discriminator, settled at mantahostels#275: a child ticket that merely
 * shares a card-id prefix has a parent, a card's own issue has none. Measured
 * there — 33 of 39 prefixed closed issues had a parent and were all children;
 * all 5 card issues had none. A `wayfinder:*` label was measured and rejected
 * as *the* discriminator: it separates only 26 of the 33, the
 * doc-map-nav-check children carrying `kind:ticket` instead.
 *
 * ON TOP of it, a `wayfinder:map` label exempts (mantahostels#1490). A map is
 * unparented like a card's own issue, so every card-prefixed map read as one
 * and would be denied at its close. The exemption survives mantahostels#275's
 * measurement because it does a different job: the rejected version had to
 * catch every CHILD, and a label missed 7 of 33; this one only has to be true
 * of maps, and a map is never a card's own issue.
 *
 * Known residual: an unparented issue that borrows a card's prefix, carries
 * no `wayfinder:map` label, and is neither that card's issue nor a map, is
 * indistinguishable from the real thing and would be denied wrongly. The
 * escape is the same --reason "not planned" the first rule already honours,
 * or /card-close itself.
 *
 * THE THIRD RULE (#1640): a completed close of an issue with unticked,
 * unwaived acceptance criteria is denied, whatever its labels — the same
 * refusal resolve-ticket.js makes, read through lib/ticket-criteria.js.
 *
 * THE FOURTH RULE (#1913): a completed close is denied where commits citing
 * the issue changed what an instruction-surface census row measured and HEAD
 * has not re-anchored it, unless a `**Census:**` line in the close's
 * --comment, or else the newest comment, says why — resolve-ticket.js's
 * refusal (#1876), read through lib/census-digest.js. A close naming another
 * repo owes none: the commits cite this one's tracker.
 *
 * DENY, not warn, and this is the distinction mantahostels#103 draws: deny on
 * a structured fact, warn where the hook is inferring. Whether a comment's
 * prose describes unfiled work is inference, and no detector is built on it
 * (mantahostels#185; examples on #1990): an accepted limit and a real escape
 * are written identically, so the prose around the line stays unread. The
 * LINE is a structured fact (#984, spec #958): lib/outstanding-line.js reads
 * its grammar and checks each cited carrier open, and a shape miss or a
 * closed, missing or self-referencing carrier is denied.
 *
 * DENIES-THROUGH: lib/guard-entry.js — `run` writes the core's deny, so the
 * registration carries `"onFailure": "block"` and a crash or timeout refuses.
 *
 * FAILS CLOSED on a core that throws (lib/refuse-on-throw.js). Every input and adapter it
 * cannot read fails open, recorded — see LIMITS.
 *
 * LIMITS
 *  - It matches the parsed command form — a segment whose command word is
 *    `gh`, subcommand pair `issue close` — never a substring, so a grep or a
 *    heredoc mentioning `gh issue close` passes.
 *  - A close through the GitHub UI, or through `gh api --method PATCH … -f
 *    state=closed`, is not seen. The UI cannot be reached from here at all;
 *    the api spelling is the known residual, left alone because
 *    guard-issue-body.js already carries the PATCH-shaped machinery and
 *    duplicating it here would put two readers on one endpoint.
 *  - It FAILS OPEN, house style (mantahostels#103 §6): an unparseable
 *    command, a missing or unreachable `gh`, a --comment it cannot wholly
 *    read, a census read that faulted or ran out of budget, an open-check the
 *    Outstanding-line parser could not make, and a run budget spent before a
 *    call are all allowed through — and all RECORDED (mantahostels#147) to the
 *    guard-error log, for check-guard-errors.js to report under `npm run
 *    status`. With no node on PATH the hook line exits 0 unrecorded.
 *  - THE TIME BUDGET: each gh call and the census read get what is left of an
 *    8 s run budget, at most 4 s, as their own timeout, so the last ends
 *    under the hook's 10 s however many closes one command holds; a call with
 *    under 1 s left is not made but recorded as a fail-open. The core
 *    bounds only each git read (lib/git-ceiling.js), so CPU work between
 *    reads that runs past the hook's 10 s meets `onFailure: block` and refuses the close.
 *  - THE RULE IT PRINTS lives in docs/agents/rules/, not here
 *    (mantahostels#1649, spec mantahostels#1641): CLAUDE.md keeps a trigger
 *    line naming the id, and this guard splices the fragment into its
 *    refusal. An unreadable fragment is the ONE fault this guard does not
 *    fail open on and does not log — the command is resolved and known bad,
 *    only the rule could not be read; it refuses with a pointer to the
 *    fragment instead.
 *  - Wired with `if: Bash(gh *)` (mantahostels#2127; best-effort:
 *    docs/agents/guard-authoring.md's surface 4, which fails toward running)
 *    — not started unless some segment of the command leads with `gh`.
 *    NEARLY the same test as the core's own basename check, which differs on
 *    one spelling: `/usr/bin/gh …` passes the basename and does not match the
 *    anchored form, so a path-spelled call is unjudged.
 *  - It guards the Bash tool, so it binds agent sessions and not the
 *    founder's own terminal (mantahostels#109).
 *  - A `-R`/`--repo` close is judged against the repo it names (#553), and
 *    the card rule stands down where that is not the tracker
 *    `.claude/workflow-core.json` declares, or the origin remote's where it
 *    declares none: this roadmap's cards, and /card-close, belong to that
 *    tracker. No tracker resolving leaves the card rule running. A
 *    `GH_REPO=… gh issue close N` is not seen: the parser strips the
 *    assignment, so that close is still read off this repo's #N.
 *  - A --comment it cannot wholly read — a `$` or backtick expansion, say —
 *    is not judged at all: the close is allowed and recorded, its marker
 *    unseen.
 *  - A chained `gh issue comment N … && gh issue close N` is judged before
 *    the comment lands: the close carries its own line, or runs in a later
 *    call.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/issue-close.js");
const { buildHostPorts } = require("./lib/issue-close-host.js");

run({
	field: "command",
	noun: "command",
	onThrow: "refuse",
	decide,
	ports: buildHostPorts,
});
