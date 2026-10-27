#!/usr/bin/env node
/*
 * inject-founder-wording.js — the UserPromptSubmit route of the
 * founder-wording guard (#2792): the composition root that hands
 * lib/founder-wording.js's prompt route the prompt and its ports. The Skill
 * route is the same core, run by the PreToolUse dispatcher. Why, what it
 * injects, and its limits: the core's header.
 *
 * IMPLICIT:  injects the four recurrence checks and this host's tracker corpus into a session whose prompt names a fault coming back, or starts with `/diagnosing-bugs`, and the `/wait-what` re-pitch into one whose prompt asks for a simpler re-pitch — without the session asking.
 * JUSTIFIED: fail-safe — a recurrence diagnosed from scratch repeats the earlier fix's blind spot; a reply that missed is otherwise re-pitched from the agent's own defaults, since the founder never types `/wait-what` (#628).
 * DEFEAT:    the host's `disabled` list naming `inject-founder-wording`; otherwise none — keyed to the prompt's wording.
 *
 * It answers under the dispatcher row's name, so one `disabled` entry,
 * `inject-founder-wording`, silences both routes (#569).
 */

const { run } = require("./lib/guard-entry.js");
const { decidePrompt } = require("./lib/founder-wording.js");
const { buildHostPorts } = require("./lib/founder-wording-host.js");

run({
	field: "prompt",
	noun: "prompt",
	event: "UserPromptSubmit",
	top: true,
	name: "inject-founder-wording",
	decide: decidePrompt,
	ports: ({ root }) => buildHostPorts(root),
});
