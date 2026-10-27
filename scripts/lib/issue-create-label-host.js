/*
 * issue-create-label-host.js — the production ports guard-issue-create-label.js
 * wires into its core, lib/issue-create-label.js (#2796). gh carries 3 s a
 * call: the edit route's two fetches cost 6 s at worst under the hook's 10 s,
 * and the second-map list is never spent beside them.
 */

const fs = require("node:fs");
const { gh } = require("./gh.js");
const { readRuleTextOr } = require("./rule-text.js");

const GH_TIMEOUT_MS = 3000;

const ENTRY = "guard-issue-create-label.js";

/** @returns {import("./issue-create-label.js").LabelPorts} */
const buildHostPorts = () => ({
	/* One port per rule, its id a literal: check-guard-registry.js counts a
	 * fragment as printed only at a literal-id readRuleText call (#2796). */
	labelRule: () =>
		readRuleTextOr(
			"issue-takes-label",
			"Every gh issue create carries a takes: label.",
			ENTRY,
		),
	deliverableRule: () =>
		readRuleTextOr(
			"founder-deliverable",
			"A takes:human body carries the founder-deliverable template.",
			ENTRY,
		),
	readFile: (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined),
	gh: (args, cwd) => gh(args, { cwd, timeout: GH_TIMEOUT_MS }),
});

module.exports = { buildHostPorts };
