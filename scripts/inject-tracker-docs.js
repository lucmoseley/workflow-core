#!/usr/bin/env node
/*
 * inject-tracker-docs.js — the UserPromptSubmit and SessionStart hook that
 * hands a tracker command the project rules its vendored skill does not carry
 * (#5151).
 *
 * Both events read plain stdout as context too, so any other event gets the
 * text bare. Never blocks: every path exits 0.
 */

const { readFdAll } = require("./lib/read-fd.js");
const { writeFd } = require("./lib/write-fd.js");
const { injectTrackerDocs } = require("./lib/inject-tracker-docs.js");
const host = require("./lib/inject-tracker-docs-host.js");

try {
	const out = injectTrackerDocs(
		readFdAll(0).toString("utf8"),
		host.buildHostPorts(host.logFailOpen),
	);
	if (out) writeFd(1, out);
} catch (e) {
	/* fail open: the session runs without the payload, recorded (#5151) */
	host.logFailOpen("inject-tracker-docs threw", String(e));
}
