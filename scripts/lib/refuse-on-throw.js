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
 * `ctx` with its treeClass port and any `tree` port watched, and whether a
 * throw is the repo or the session's tree not resolving — the fault that
 * stays open, for this file and for lib/guard-judge.js's fail-closed cores
 * alike.
 * @template {{ treeClass: (dir: string) => string, tree?: () => unknown }} C
 * @param {C} ctx
 * @returns {{ ctx: C, isRepoFault: (e: unknown) => boolean }}
 */
function watchRepoFault(ctx) {
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
	/* The session's tree, where the context carries one: unresolved is the
	 * same fault (#4242). */
	const read = ctx.tree;
	const tree =
		read &&
		(() => {
			try {
				return read();
			} catch (e) {
				repoFault = e;
				throw e;
			}
		});
	return {
		ctx: { ...ctx, treeClass, ...(tree ? { tree } : {}) },
		isRepoFault: (e) => repoFault !== undefined && e === repoFault,
	};
}

/**
 * @template {{ treeClass: (dir: string) => string,
 *   log: (what: string, detail?: string) => void }} C
 * @param {string} name the entry's file, as the refusal names it
 * @param {(command: string, ctx: C) => import("./guard-entry.js").Decision} decide
 * @returns {(command: string, ctx: C) => import("./guard-entry.js").Decision}
 */
function refuseOnThrow(name, decide) {
	return (command, ctx) => {
		const watched = watchRepoFault(ctx);
		try {
			return decide(command, watched.ctx);
		} catch (e) {
			const why = caught(e).message;
			if (watched.isRepoFault(e)) {
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

module.exports = { refuseOnThrow, watchRepoFault };
