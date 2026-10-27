/*
 * refuse-on-throw.js — an enforcing per-guard entry's failure policy, which
 * lib/guard-entry.js's `run({ onThrow: "refuse" })` applies (#2797, spec
 * #2733): a core that throws refuses the call, as the bash guard's crash did
 * under `"onFailure": "block"`, rather than the kit's fail-open.
 *
 * ONE THROW STAYS OPEN: the repo itself not resolving, which walkGit's
 * treeClass port throws (lib/git-tree.js's treeClassifier). The bash guards
 * allowed every command there, recorded (mantahostels#147), because with the
 * repo unknown no tree is the shared one; refusing would wedge every git call
 * in a repo git cannot read.
 */

const { caught } = require("./caught.js");

/**
 * @template {{ treeClass: (dir: string) => string,
 *   log: (what: string, detail?: string) => void }} C
 * @param {string} name the entry's file, as the refusal names it
 * @param {(command: string, ctx: C) => import("./guard-entry.js").Decision} decide
 * @returns {(command: string, ctx: C) => import("./guard-entry.js").Decision}
 */
function refuseOnThrow(name, decide) {
	return (command, ctx) => {
		/** @type {unknown} */
		let repoFault;
		const treeClass = (/** @type {string} */ dir) => {
			try {
				return ctx.treeClass(dir);
			} catch (e) {
				repoFault = e;
				throw e;
			}
		};
		try {
			return decide(command, { ...ctx, treeClass });
		} catch (e) {
			const why = caught(e).message;
			if (e === repoFault) {
				ctx.log(why);
				return null;
			}
			ctx.log("core threw — the command was refused", why);
			return {
				deny: `${name} could not judge this command, so it refuses it: ${why}`,
			};
		}
	};
}

module.exports = { refuseOnThrow };
