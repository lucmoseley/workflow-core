const path = require("node:path");
const { isQueueHead } = require("./landing-refs.js");
const { readPush } = require("./push-dests.js");
const { parseCommand, walkGit } = require("./shell-parse.js");

/**
 * @typedef {object} LanderPorts
 * @property {(tree: string, src: string) => string} symbolicName
 * @typedef {import("./kit-context.js").KitContext & LanderPorts} LanderContext
 */

/**
 * @param {string} command
 * @param {LanderContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	let toQueue = false;
	walkGit(
		parsed,
		({ tree, args }) => {
			const read = readPush(args, parsed.spans, (src) =>
				ctx.symbolicName(tree, src),
			);
			if (read.inert || read.all) return;
			if (read.rows.some((r) => r.kind === "push" && isQueueHead(r.ref)))
				toQueue = true;
		},
		ctx,
		{ subs: ["push"], noun: "lander start", scope: "repo", unwrap: true },
	);
	if (!toQueue) return null;
	return {
		launch: {
			script: path.join(__dirname, "..", "start-lander.js"),
			log: ".lander.log",
		},
	};
}

module.exports = { decide };
