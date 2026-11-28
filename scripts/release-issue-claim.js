#!/usr/bin/env node
// #5865

const { buildArbiterCommand } = require("./lib/build-arbiter-command.js");
const { run } = require("./lib/guard-entry.js");
const { decideRelease } = require("./lib/issue-claim-hook.js");
const { buildHostPorts } = require("./lib/gh-recorder-host.js");

run({
	field: "command",
	noun: "command",
	event: "PostToolUse",
	byHand: `\`${buildArbiterCommand`release-issue <n>`}\` to release a claim by hand`,
	decide: decideRelease,
	ports: buildHostPorts,
});
