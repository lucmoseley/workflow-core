/*
 * landing-switch-on.js — whether a repo on a core that dropped the
 * shared-tree guards still runs as a shared tree (workflow-core#4688).
 *
 * From v2.1.0 the core carries neither the shared-tree guard limbs (workflow-core#4251)
 * nor the file-claim refusal (workflow-core#4249). A repo with the `landing` module off,
 * or on with its main checkout not yet cut over (lib/cutover.js's mark), is
 * still one shared tree.
 */

const { compareVersions } = require("./compare-versions.js");

const NOTE = "migrations/v2.1.0.md";
const FLOOR = [2, 1, 0];

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
 * @typedef {{ version: string, landingOn: boolean,
 *   cutOver: () => boolean | null }} Reading `cutOver` reads the main
 *   checkout's mark, null where git could not
 * @typedef {(
 *   | { outcome: "broken", line: string }
 *   | { outcome: "skip", line: string }
 *   | { outcome: "ok", line: string }
 *   | { outcome: "fail", tag: "LANDING-OFF" | "NOT-CUT-OVER", line: string }
 * )} Judgement
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
			outcome: "broken",
			line: `workflow-core's version "${r.version}" is no x.y.z.`,
		};
	if (compareVersions(parts, FLOOR) < 0)
		return {
			outcome: "skip",
			line: `workflow-core ${r.version} predates v2.1.0, so its shared-tree guards still run.`,
		};
	const exposed = `on workflow-core ${r.version}, which carries no shared-tree guard and no file-claim refusal (workflow-core#4251, workflow-core#4249)`;
	if (!r.landingOn)
		return {
			outcome: "fail",
			tag: "LANDING-OFF",
			line: `the \`landing\` module is off ${exposed}, so every session here shares one unguarded tree. Do the switch-on [act]s in ${note}'s Manual steps; \`${stepsCommand}\` lists the ones still owed.`,
		};
	const cutOver = r.cutOver();
	if (cutOver === null)
		return {
			outcome: "broken",
			line: "git could not read whether the main checkout is cut over.",
		};
	if (!cutOver)
		return {
			outcome: "fail",
			tag: "NOT-CUT-OVER",
			line: `the \`landing\` module is on but the main checkout is not cut over ${exposed}, so sessions there still share one unguarded tree. Run \`${cutoverCommand}\`, the last of ${note}'s switch-on steps.`,
		};
	return {
		outcome: "ok",
		line: "the `landing` module is on and the main checkout is cut over, so each session works its own worktree.",
	};
}

module.exports = { NOTE, judgeSwitchOn };
