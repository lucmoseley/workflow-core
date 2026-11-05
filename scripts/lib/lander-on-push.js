/*
 * lander-on-push.js — start-lander-on-push.js's core (#2785): after a push to
 * a queue ref, `queue/<name>`, start the queue lander detached (#2405, spec
 * #2261; #4458).
 *
 * Each destination is read by lib/push-dests.js. `--all`, `--branches`,
 * `--mirror`, `--delete` and a dry run start nothing, whatever they push.
 *
 * The module is read only once a push reaches a queue ref, so an adopter with
 * `landing` off pays one config read on such a push and none on any other.
 */

const { QUEUE_PREFIX } = require("./landing-refs.js");
const { readPush } = require("./push-dests.js");
const { parseCommand, walkGit } = require("./shell-parse.js");

/* A push to a queue ref with the `landing` module on starts the lander. */
const QUEUE_HEADS = `refs/heads/${QUEUE_PREFIX}`;

/**
 * @typedef {object} LanderPorts
 * @property {(tree: string, src: string) => string} symbolicName `git -C
 *   <tree> rev-parse --symbolic-full-name <src>`, "" where it fails
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
			if (
				read.rows.some(
					(r) =>
						r.kind === "push" &&
						r.ref.startsWith(QUEUE_HEADS) &&
						r.ref.length > QUEUE_HEADS.length,
				)
			)
				toQueue = true;
		},
		ctx,
		{ subs: ["push"], noun: "lander start", scope: "repo", unwrap: true },
	);
	if (!toQueue || !ctx.moduleOn("landing")) return null;
	return { launch: { script: "start-lander.js", log: ".lander.log" } };
}

module.exports = { decide };
