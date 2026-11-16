/*
 * landing-pin.js — whether a repo is pinned to a workflow-core release that
 * still let `landing` be switched off, and runs it off (#5276).
 *
 * From ALWAYS_ON every repo lands through the queue, its main checkout cut
 * over at session start. A repo whose pin names an earlier tag runs that
 * release, so where its config's `modules` lacks `"landing"` its sessions
 * share one unguarded tree, the night #5246 maps. The refill loop serves no
 * such repo. A pin that is a branch or a SHA names no release, so it is
 * never judged older.
 */

const fs = require("node:fs");
const path = require("node:path");
const { compareVersions } = require("./compare-versions.js");
const { readPin } = require("./plugin-state.js");

const ALWAYS_ON = "v3.0.0";

/**
 * The tag's numeric parts, any pre-release or build suffix dropped; null
 * where it names no `x.y.z`.
 * @param {string} tag
 */
function parseTag(tag) {
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(tag);
	return m ? m.slice(1).map(Number) : null;
}

/**
 * Whether the config at `root` names `"landing"` in its `modules`.
 * @param {string} root
 */
function declaresLanding(root) {
	try {
		const raw = JSON.parse(
			fs.readFileSync(path.join(root, ".claude", "workflow-core.json"), "utf8"),
		);
		return Array.isArray(raw?.modules) && raw.modules.includes("landing");
	} catch {
		/* Fails open: a config that will not read is refill-repos.js's to
		 * exclude, by its own fault (#5276). */
		return true;
	}
}

/**
 * Why the repo at `root` runs `landing` off on a release before ALWAYS_ON, or
 * null where it does not.
 * @param {string} root
 * @returns {string|null}
 */
function readLandingOffWhy(root) {
	const ref = readPin(root, "workflow-core").pin?.ref;
	const parts = ref ? parseTag(ref) : null;
	if (
		parts === null ||
		compareVersions(parts, /** @type {number[]} */ (parseTag(ALWAYS_ON))) >= 0
	)
		return null;
	if (declaresLanding(root)) return null;
	return `pinned to workflow-core ${ref} with \`landing\` off, so its sessions share one unguarded tree — move its pin to ${ALWAYS_ON} or later`;
}

module.exports = { readLandingOffWhy };
