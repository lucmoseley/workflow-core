const { caught } = require("./caught.js");

/**
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
 * @param {string} name
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
