#!/usr/bin/env node
// #5865
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
	host.logFailOpen("inject-tracker-docs threw", String(e));
}
