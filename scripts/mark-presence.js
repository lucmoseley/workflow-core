#!/usr/bin/env node
/*
 * mark-presence.js — UserPromptSubmit hook. Records that the founder typed a
 * prompt, so the refill loop can tell present from away (workflow-core#2004, spec workflow-core#1995).
 *
 * WHAT IS NOT HIS TYPING, and writes nothing:
 *   - a background job's launch prompt: the prompt equal to the `intent` its
 *     job's state.json records. A launch from the agents view is skipped
 *     with the dispatcher's, since nothing on the job tells the two apart;
 *     his later prompts in that job count.
 *   - a prompt the harness writes: a subagent's hand-back or another
 *     session's message (`<agent-message`, as probed), a task notification, a
 *     mod's delivery. The payload carries no origin field, and at this hook
 *     the transcript does not yet hold the prompt's record, so the text is
 *     all there is to read.
 *   - a print-mode run (`claude -p`, `CLAUDE_CODE_ENTRYPOINT` `sdk-cli`): a
 *     script's prompt. It inherits its parent's `CLAUDE_JOB_DIR`, so the
 *     intent test alone would count it.
 *   - a subagent's payload (lib/subagent-payload.js).
 *
 * BLIND SPOTS: a scheduled task's or `/loop` iteration's prompt is its own
 * text, and counts. A session whose repo does not run this plugin writes
 * nothing, so a prompt typed there reads him as away.
 *
 * IN NO §N3 FAMILY: it refuses nothing and checks nothing — it writes a
 * marker.
 *
 * FAILS OPEN: prints nothing and never blocks the prompt.
 *
 * IMPLICIT:  at every prompt typed in an interactive session or into a running background job, writes the time to `~/.claude/.founder-presence`.
 * JUSTIFIED: fail-safe — a missed prompt reads him as away (workflow-core#1995).
 * DEFEAT:    none needed — it never blocks; `disabled` in .claude/workflow-core.json stands it down.
 */

const fs = require("node:fs");
const path = require("node:path");
const hookMessage = require("./lib/hook-message");
const { jobStateIn } = require("./lib/job-paths.js");
const { hostRoot } = require("./lib/host-root");
const { markPresent } = require("./lib/presence");
const { isSubagentPayload } = require("./lib/subagent-payload");
const { guardDisabled } = require("./lib/workflow-core-config");

const HARNESS_PROMPT =
	/^\s*(?:<agent-message |<task-notification>|Delivered by the wfc-delivery mod)/;

/** @param {string} prompt */
function isLaunchPrompt(prompt) {
	const jobDir = process.env.CLAUDE_JOB_DIR;
	if (!jobDir) return false;
	try {
		const { intent } = JSON.parse(fs.readFileSync(jobStateIn(jobDir), "utf8"));
		return typeof intent === "string" && intent.trim() === prompt.trim();
	} catch {
		/* No readable job record marks nothing a launch (workflow-core#2004). */
		return false;
	}
}

function main() {
	if (guardDisabled(path.basename(__filename), { root: hostRoot() })) return;
	if (process.env.CLAUDE_CODE_ENTRYPOINT === "sdk-cli") return;
	const payload = hookMessage.readPayload();
	if (isSubagentPayload(payload)) return;
	const prompt = typeof payload?.prompt === "string" ? payload.prompt : "";
	if (HARNESS_PROMPT.test(prompt) || isLaunchPrompt(prompt)) return;
	markPresent(new Date());
}

try {
	main();
} catch {
	/* Fail open (workflow-core#2004). */
}
