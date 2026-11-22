#!/usr/bin/env node
/*
 * inject-founder-wording.js — the UserPromptSubmit route of the
 * founder-wording guard (workflow-core#2792): the composition root that hands
 * lib/founder-wording.js's prompt route the prompt and its ports. The Skill
 * route is the same core, run by the PreToolUse dispatcher. Why, what it
 * injects, and its limits: the core's header.
 *
 * It answers under the dispatcher row's name, so one `disabled` entry,
 * `inject-founder-wording`, silences both routes (workflow-core#569).
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
	ports: ({ root }) => buildHostPorts({ root }),
});
