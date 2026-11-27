#!/usr/bin/env node

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/lost-verdict.js");
const { buildHostPorts } = require("./lib/lost-verdict-host.js");

run({
	field: "command",
	noun: "a suite run's lost verdict",
	event: "PostToolUse",
	decide,
	ports: buildHostPorts,
});
