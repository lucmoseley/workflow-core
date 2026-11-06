/*
 * shared-fault-checkers.js — the checkers report-new-shared-faults.js reads by
 * --root, keyed by lib/fault-profiles.js profile name (#4246).
 */
const path = require("node:path");

/* Core content: every checker below ships in scripts/, beside this lib's
 * directory (#1). */
const CORE_SCRIPTS = path.join(__dirname, "..");

/** Profile name -> the checker script that emits its --json envelope, for the
 * checkers that take --root. check-doc-map.js is not in this table: its
 * envelope is read by report-new-shared-faults.js's readDocMapEnvelope(), on a
 * different calling convention (that file's header comment). */
const CHECKERS = {
	"guard-registry": path.join(CORE_SCRIPTS, "check-guard-registry.js"),
	"guard-test-isolation": path.join(
		CORE_SCRIPTS,
		"check-guard-test-isolation.js",
	),
	"host-root-test-isolation": path.join(
		CORE_SCRIPTS,
		"check-host-root-test-isolation.js",
	),
	"context-budget": path.join(CORE_SCRIPTS, "check-context-budget.js"),
	"website-copy": path.join(CORE_SCRIPTS, "check-website-copy.js"),
	"git-fixture-identity": path.join(
		CORE_SCRIPTS,
		"check-git-fixture-identity.js",
	),
	"host-root": path.join(CORE_SCRIPTS, "check-host-root.js"),
	"skill-frontmatter": path.join(CORE_SCRIPTS, "check-skill-frontmatter.js"),
	"jsonl-reads": path.join(CORE_SCRIPTS, "check-jsonl-reads.js"),
	"gh-route": path.join(CORE_SCRIPTS, "check-gh-route.js"),
	"arbiter-commands": path.join(CORE_SCRIPTS, "check-arbiter-commands.js"),
	"clock-copies": path.join(CORE_SCRIPTS, "check-clock-copies.js"),
	"report-programs": path.join(CORE_SCRIPTS, "check-report-programs.js"),
	"precommit-exit": path.join(CORE_SCRIPTS, "check-precommit-exit.js"),
	"cli-args": path.join(CORE_SCRIPTS, "check-cli-args.js"),
	"test-spawn": path.join(CORE_SCRIPTS, "check-test-spawn.js"),
	registrations: path.join(CORE_SCRIPTS, "check-registrations.js"),
};

module.exports = { CHECKERS };
