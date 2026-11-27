#!/usr/bin/env node

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/failed-call-rules.js");

run({
	field: "hook_event_name",
	top: true,
	noun: "failed call",
	event: "PostToolUseFailure",
	decide,
	ports: ({ payload }) => ({ payload }),
});
