/*
 * landing-switch-on.js — whether a repo on a core that dropped the
 * shared-tree guards still runs as a shared tree (#4688).
 *
 * From SWITCH_ON_VERSION the core carries neither the shared-tree guard limbs
 * (#4251) nor the file-claim refusal (#4249). A repo with the `landing` module
 * off, or on with its main checkout not yet cut over (lib/cutover.js's mark),
 * is still one shared tree, with nothing left guarding it until the
 * SWITCH_ON_VERSION migration note's switch-on steps are done.
 */

const { compareVersions } = require("./compare-versions.js");

const SWITCH_ON_VERSION = "2.1.0";
const NOTE = `migrations/v${SWITCH_ON_VERSION}.md`;

/**
 * The version's numeric parts, any pre-release or build suffix dropped; null
 * where it is no `x.y.z`.
 * @param {string} version
 * @returns {number[] | null}
 */
function parseVersion(version) {
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
	return m ? m.slice(1).map(Number) : null;
}

/**
 * @typedef {{ version: string, landingOn: boolean, cutOver: boolean | null }} Reading
 *   `cutOver` null where git could not read the main checkout's mark
 * @typedef {{ state: "before" | "unread" | "off" | "not-cut-over" | "ok", line: string }} Judgement
 */

/**
 * @param {Reading} r
 * @param {{ note: string, cutoverCommand: string, stepsCommand: string }} how
 *   the note and both commands as the reader should spell them
 * @returns {Judgement}
 */
function judgeSwitchOn(r, { note, cutoverCommand, stepsCommand }) {
	const parts = parseVersion(r.version);
	if (parts === null)
		return {
			state: "unread",
			line: `workflow-core's version "${r.version}" is no x.y.z, so whether this repo owes the v${SWITCH_ON_VERSION} switch-on is unread.`,
		};
	const floor = /** @type {number[]} */ (parseVersion(SWITCH_ON_VERSION));
	if (compareVersions(parts, floor) < 0)
		return {
			state: "before",
			line: `workflow-core ${r.version} predates v${SWITCH_ON_VERSION}, so its shared-tree guards still run.`,
		};
	const exposed = `on workflow-core ${r.version}, which carries no shared-tree guard and no file-claim refusal (#4251, #4249)`;
	if (!r.landingOn)
		return {
			state: "off",
			line: `the \`landing\` module is off ${exposed}, so every session here shares one unguarded tree. Do the switch-on [act]s in ${note}'s Manual steps; \`${stepsCommand}\` lists the ones still owed.`,
		};
	if (r.cutOver === null)
		return {
			state: "unread",
			line: `git could not read whether the main checkout is cut over, so whether this repo is still a shared tree ${exposed} is unread.`,
		};
	if (!r.cutOver)
		return {
			state: "not-cut-over",
			line: `the \`landing\` module is on but the main checkout is not cut over ${exposed}, so sessions there still share one unguarded tree. Run \`${cutoverCommand}\`, the last of ${note}'s switch-on steps.`,
		};
	return {
		state: "ok",
		line: "the `landing` module is on and the main checkout is cut over, so each session works its own worktree.",
	};
}

module.exports = { NOTE, SWITCH_ON_VERSION, judgeSwitchOn, parseVersion };
