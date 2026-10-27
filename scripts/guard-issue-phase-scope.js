#!/usr/bin/env node
/*
 * guard-issue-phase-scope.js — PreToolUse guard: no issue is created for a
 * roadmap card the founder has not called (mantahostels#1613, which built and
 * ruled it). The core is lib/issue-phase-scope.js.
 *
 * Why: on 26 August 2026 decision map mantahostels#1489 (`search-core`)
 * opened nine child issues in one day, against a Phase-1 card nobody had
 * asked for. It was not alone — 33 open issues turned out to be work spun up
 * against Phase-1 cards while the project is still validating Phase 0.
 *
 * The rule: a `gh issue create` whose TITLE begins `<card-id> — ` is denied
 * when that card's phase in docs/reference-roadmap.html is not 0 and the card
 * has no row in docs/called-cards.md.
 *
 * DENY, not warn, and this is the distinction mantahostels#103 draws: deny on
 * a structured fact, warn where the hook is inferring. The founder chose the
 * deny explicitly over a warn-only report, on the ground that warn-only
 * machinery here is absorbed as noise.
 *
 * WHY THE TITLE PREFIX AND NOTHING CLEVERER. `<card-id> — <subject>` is this
 * repo's title convention for card-derived issues, and every one of the 33
 * retired issues that carried a card carried it that way. The BODY is not
 * scanned for card ids: a workflow ticket that merely mentions `privacy-ops`
 * in passing would be refused, and refusing legitimate machinery work is a
 * worse failure than missing an occasional product ticket.
 *
 * DENIES-THROUGH: lib/guard-entry.js — `run` writes the core's deny, so the
 * registration carries `"onFailure": "block"` and a crash or timeout refuses.
 *
 * FAILS CLOSED on a core that throws (lib/refuse-on-throw.js). Every input it
 * cannot resolve fails open, recorded — see LIMITS.
 *
 * LIMITS
 *  - AN ISSUE CARRYING NO CARD PREFIX ESCAPES ENTIRELY, and re-titling to
 *    drop the prefix is therefore a one-keystroke bypass. mantahostels#927
 *    (validate the launch catalogue before it publishes) was exactly that
 *    shape — Phase-1 seed-listings work with a bare title — and would pass.
 *    THE PREFIX IS AN HONESTY MARKER, NOT A SYNTAX RULE: nothing here can
 *    close that, so the deny text names the bypass and forbids it rather than
 *    pretending it does not exist. scripts/check-issue-card-drift.js is the
 *    reporting-tier control.
 *  - A WRAPPED COMMAND whose wrapper takes arguments of its own — `env FOO=1
 *    gh …`, `timeout --signal=INT 60 gh …`, `xargs gh …`, `sh -c '…'` — is
 *    not followed. The no-argument wrappers ARE, so the common `env gh …` and
 *    `timeout 60 gh …` spellings are judged.
 *  - It matches the parsed command form, never a substring, so an echo or a
 *    heredoc mentioning `gh issue create` passes.
 *  - `gh api --method POST …/issues` IS chased, gh's own POST default with
 *    it. `gh api graphql` is NOT: a createIssue mutation's title would have
 *    to be read out of query text, and the guard would be inferring rather
 *    than reading.
 *  - A PreToolUse hook sees Bash tool calls only, so AN ISSUE CREATED BY A
 *    SCRIPT OR FROM THE WEB UI ESCAPES.
 *  - Wired with `if: Bash(*gh *)` (mantahostels#2127; best-effort:
 *    docs/agents/guard-authoring.md's surface 4, which fails toward running)
 *    — not started unless the command carries `gh ` somewhere, quoted spans
 *    included.
 *  - IT IS DELIBERATELY NOT THE ANCHORED `Bash(gh *)`. The core walks past a
 *    no-argument wrapper, so `timeout 60 gh issue create` and
 *    `nohup gh issue create` reach the judge — and the anchored form matches
 *    neither, which would leave those two spellings unjudged in silence.
 *  - ANY SESSION WRITES THE REGISTER (mantahostels#3483); only the founder
 *    CALLS a card. Nothing checks a row against his instruction, and this
 *    guard reads the file from disk, so a row need not even be committed.
 *  - It FAILS OPEN, house style (mantahostels#103 §6): an unreadable title,
 *    an unreadable roadmap or a missing register allow the creation, and all
 *    are RECORDED (mantahostels#147) for check-guard-errors.js to report
 *    under `npm run status`, and so does every payload fault
 *    lib/guard-entry.js names. With no node on PATH the hook line exits 0
 *    unrecorded.
 *  - It guards the Bash tool, so it binds agent sessions and not the
 *    founder's own terminal (mantahostels#109).
 *
 * IMPLICIT:  besides refusing the create, WRITES a fail-open record whenever it cannot read a title, the roadmap or the register — a file this session never asked it to touch.
 * JUSTIFIED: fail-safe — a guard that allowed unchecked in silence would report itself as protecting work it never judged, which is what check-guard-errors.js exists to surface (mantahostels#147).
 * DEFEAT:    none for the record itself; the deny it guards is escaped by a row in docs/called-cards.md for a card the founder has called, never by a session calling its own.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/issue-phase-scope.js");
const { buildHostPorts } = require("./lib/issue-phase-scope-host.js");

run({
	field: "command",
	noun: "command",
	onThrow: "refuse",
	decide,
	ports: buildHostPorts,
});
