#!/usr/bin/env node
/*
 * inject-tracker-docs.js — the UserPromptSubmit and SessionStart hook that
 * hands a tracker command the project rules its vendored skill does not carry
 * (#5151): the composition root that wires lib/inject-tracker-docs-host.js's
 * ports into lib/inject-tracker-docs.js and prints what it returns. Why, what
 * it injects, and its limits: the core's header.
 *
 * Both events read plain stdout as context too, so any other event gets the
 * text bare. Never blocks: every path exits 0.
 *
 * IMPLICIT:  pastes the tracker overrides and the priced-options shape (a pointer to it where Core voice loads, #2039), and hands each of the seven tracker commands its own residue index of rule ids (mantahostels#2499), and names an issue whose `takes:` label is another command's (#1164), into the context of that command, at UserPromptSubmit and SessionStart, without the session asking.
 * JUSTIFIED: fail-safe — the rules' own home is not auto-loaded, and the vendored skills carry them only by a per-skill declared edit (mantahostels#1826), so an uninjected session follows the vendored instructions instead.
 * DEFEAT:    none — injection is keyed to the command's shape and nothing suppresses it.
 * TREE:      both — the injection from the host root's config and rule texts; the review-tier diff from the payload's cwd
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
