#!/usr/bin/env node
// #5865

const { run } = require("./lib/guard-entry.js");
const { decideClaim } = require("./lib/issue-claim-hook.js");
const { buildHostPorts } = require("./lib/gh-recorder-host.js");

run({
	field: "command",
	noun: "command",
	event: "PostToolUse",
	byHand: "`node scripts/claim-issue.js <n>` to claim an issue by hand",
	decide: decideClaim,
	ports: buildHostPorts,
});
