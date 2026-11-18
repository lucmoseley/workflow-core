/*
 * landing-pin.js — whether a repo is pinned to a workflow-core release that
 * still let `landing` be switched off, and runs it off (workflow-core#5276).
 *
 * From ALWAYS_ON every repo lands through the queue, its main checkout cut
 * over at session start. A repo whose pin names an earlier tag runs that
 * release, so where its config's `modules` lacks `"landing"` its sessions
 * share one unguarded tree. A pin that is a branch or a SHA names no
 * release, so it is never judged older.
 */

const path = require("node:path");
const { caught } = require("./caught.js");
const { compareVersions } = require("./compare-versions.js");
const { readText } = require("./file-read.js");
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

const ALWAYS_ON_PARTS = (() => {
	const parts = parseTag(ALWAYS_ON);
	if (parts === null) throw new Error(`ALWAYS_ON ${ALWAYS_ON} names no x.y.z`);
	return parts;
})();

/**
 * Whether the config at `root` names `"landing"` in its `modules`, none
 * where it is absent, or why it would not read (workflow-core#5301).
 * @param {string} root
 * @returns {boolean|{unread: string}}
 */
function declaresLanding(root) {
	const file = path.join(root, ".claude", "workflow-core.json");
	const read = readText(file);
	if (read.state === "absent") return false;
	if (read.state === "unreadable")
		return { unread: `${file} would not read (${read.message})` };
	try {
		const raw = JSON.parse(read.data);
		return Array.isArray(raw?.modules) && raw.modules.includes("landing");
	} catch (err) {
		return { unread: `${file} would not parse (${caught(err).message})` };
	}
}

/**
 * Why the repo at `root` runs `landing` off on a release before ALWAYS_ON, or
 * might, its config unread, failing closed; null where it does not.
 * @param {string} root
 * @returns {string|null}
 */
function readLandingOffWhy(root) {
	const ref = readPin(root, "workflow-core").pin?.ref;
	const parts = ref ? parseTag(ref) : null;
	if (parts === null || compareVersions(parts, ALWAYS_ON_PARTS) >= 0)
		return null;
	const landing = declaresLanding(root);
	if (typeof landing === "object")
		return `pinned to workflow-core ${ref}, before ${ALWAYS_ON}, and ${landing.unread}, so whether it runs \`landing\` off is unknown`;
	if (landing) return null;
	return `pinned to workflow-core ${ref} with \`landing\` off, so its sessions share one unguarded tree — move its pin to ${ALWAYS_ON} or later`;
}

module.exports = { readLandingOffWhy };
