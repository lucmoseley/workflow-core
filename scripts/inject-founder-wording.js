#!/usr/bin/env node
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
