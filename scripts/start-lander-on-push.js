#!/usr/bin/env node
// #5865

const { readSymbolicName } = require("./lib/git-tree.js");
const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/lander-on-push.js");

run({
	field: "command",
	noun: "lander start",
	event: "PostToolUse",
	decide,
	ports: () => ({ symbolicName: (tree, src) => readSymbolicName(tree, src) }),
});
