#!/usr/bin/env node
/*
 * guard-anthropic-report.js — PreToolUse guard: nothing is written to an
 * Anthropic repo from a Bash call (#1967, which ruled that nothing is
 * reported or requested to Anthropic; #1987, which gave the ruling one guard
 * of its own). The core is lib/anthropic-report.js.
 *
 * DENY, not warn (mantahostels#103): which repo a command writes to is a fact
 * read off the command, its environment or its clone.
 *
 * DENIES-THROUGH: lib/guard-entry.js — `run` writes the core's deny, so the
 * registration carries `"onFailure": "block"` and a crash or timeout refuses.
 *
 * FAILS CLOSED on a core that throws (lib/refuse-on-throw.js).
 *
 * WHAT IT JUDGES — a command whose command word is `gh`, after the launcher
 * wrappers shell-words.js's unwrap strips (`timeout`, `env`, `nohup`…):
 *  - `gh issue <sub>` and `gh pr <sub>`, for every <sub> but the reads. An
 *    unknown subcommand counts as a write, so a verb gh adds later is refused
 *    rather than missed.
 *  - `gh api` with a writing method — POST, PUT, PATCH or DELETE, or none at
 *    all on a call carrying a payload, which gh sends as a POST — on a
 *    `repos/<owner>/<repo>/…` endpoint.
 *  - `gh api graphql` carrying a mutation, where the call names `anthropics`
 *    anywhere it can read: a variable, a field, the query text.
 *
 * WHICH REPO, in gh's own order:
 *  1. an issue or PR URL among the arguments, which gh acts on whatever else
 *     the command says;
 *  2. `-R`/`--repo` after the subcommand, or the endpoint's owner/repo on
 *     `gh api`;
 *  3. `GH_REPO`, set on the command itself or in the environment;
 *  4. the clone the command runs in: ANY of its remotes naming an
 *     `anthropics` repo counts, gh choosing among them by rules the command
 *     does not show. Read with `git -C <dir> remote -v`, at the hook's 3 s git
 *     ceiling; a git that cannot answer reads as no remote.
 *
 * LIMITS
 *  - GraphQL names its target by opaque node id, so a mutation whose call
 *    never spells `anthropics` — a `repositoryId` or `subjectId` looked up in
 *    an earlier call — passes unseen. So does a query read from a file
 *    (`-F query=@file`, `--input`).
 *  - A `gh api` method it cannot read (`-X "$M"`) is judged as a write, so a
 *    call to an Anthropic repo carrying one is REFUSED.
 *  - A repo it cannot read — a `--repo "$R"` it cannot resolve, a placeholder
 *    endpoint in a directory it cannot know — FAILS OPEN, recorded
 *    (mantahostels#147) for check-guard-errors.js to report under `npm run
 *    status`, and so does every payload fault lib/guard-entry.js names. With
 *    no node on PATH the hook line exits 0 unrecorded.
 *  - Only `gh issue`, `gh pr` and `gh api` are judged: `gh release`, `gh
 *    label` and the other groups write nothing a report travels by. A `gh`
 *    alias or extension expands out of sight and passes.
 *  - A PreToolUse hook sees Bash tool calls only. A script the call runs, a
 *    `curl` to api.github.com, the web UI and a Chrome child's form
 *    submission all escape it.
 *  - Wired with `if: Bash(*gh *)`, the wrapper-tolerant spelling, because the
 *    walker judges `timeout 60 gh …` (docs/agents/guard-authoring.md surface
 *    4).
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/anthropic-report.js");
const { buildHostPorts } = require("./lib/anthropic-report-host.js");

run({
	field: "command",
	noun: "command",
	onThrow: "refuse",
	decide,
	ports: buildHostPorts,
});
