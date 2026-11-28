#!/usr/bin/env node
// #5865

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/gh-acts.js");
const { buildHostPorts } = require("./lib/gh-recorder-host.js");

run({
	field: "command",
	noun: "command",
	event: "PostToolUse",
	decide,
	ports: buildHostPorts,
});
