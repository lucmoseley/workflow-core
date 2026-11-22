const {
	callSignature,
	chainName,
	isNeighbours,
	responseHash,
} = require("./echo-chain.js");

/**
 * @typedef {{ hash: string, run: number, denies: number }} Prior
 * @typedef {{
 *   fileState: (file: string) => string | null,
 *   chain: (name: string, sig: string,
 *     next: (prior: Prior | null) => Prior) => boolean,
 * }} EchoPorts
 */

/**
 * @param {unknown} _subject
 * @param {import("./kit-context.js").KitContext & EchoPorts & {
 *   env: Record<string, string | undefined> }} ctx
 */
function decide(_subject, ctx) {
	if (ctx.env.WFC_NO_ECHO_CHAIN === "1") return null;
	const tool = ctx.tool ?? "";
	const command = ctx.input.command;
	if (isNeighbours(tool, typeof command === "string" ? command : ""))
		return null;
	const sig = callSignature(tool, ctx.input, ctx.fileState);
	const answered = responseHash(ctx.response);
	if (answered === null) return null;
	let hash = answered;
	if (!ctx.key) {
		ctx.log("no session_id in payload — echo record allowed unchecked");
		return null;
	}
	const unchanged =
		tool === "Read" &&
		/** @type {{ type?: unknown } | null} */ (ctx.response)?.type ===
			"file_unchanged";
	const stored = ctx.chain(chainName(ctx.key), sig, (prior) => {
		if (!prior) return { hash, run: 1, denies: 0 };
		/* #1090 */
		if (unchanged) hash = prior.hash;
		return {
			hash,
			run: prior.hash === hash ? prior.run + 1 : 1,
			denies: prior.denies,
		};
	});
	if (!stored)
		ctx.log("could not write the chain store — no echo chain recorded");
	return null;
}

module.exports = {
	field: ["command", "file_path"],
	noun: "echo record",
	decide,
};
