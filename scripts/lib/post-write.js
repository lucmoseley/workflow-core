const { treeOrHost } = require("./tree-or.js");
const { relativeUnder } = require("./is-under.js");

const BIOME_KIND = /\.(c|m)?[jt]sx?$|\.jsonc?$/;

/**
 * @typedef {{
 *   inRoot: (root: string, file: string) => boolean,
 *   digest: (root: string, file: string) => string | null,
 *   hasBiome: (root: string) => boolean,
 *   runBiome: (root: string, file: string) => void,
 *   formatOther: (root: string, file: string) => "shell" | "",
 *   recordWrite: (file: string, session: string) => void,
 *   scanFaults: (root: string, file: string) => string,
 * }} WritePorts
 */

/**
 * @param {string} file
 * @param {string} root
 * @param {{ changed: boolean, unformatted: boolean }} what
 */
function noticeOf(file, root, { changed, unformatted }) {
	const rel = relativeUnder(root, file) || file;
	if (changed)
		return `post-write reformatted ${rel}: re-read it before your next Edit to it.`;
	if (unformatted)
		return `post-write ran no Biome on ${rel}: this checkout has no node_modules, so the file stays as you wrote it.`;
	return "";
}

/**
 * @param {string} written
 * @param {import("./core-contract.js").CoreContext & WritePorts} ctx
 */
function decide(written, ctx) {
	const file =
		typeof ctx.input.file_path === "string" ? ctx.input.file_path : "";
	const root = file === "" ? ctx.root : treeOrHost(ctx).root;
	const inside = file !== "" && ctx.inRoot(root, file);
	const before = inside ? ctx.digest(root, file) : null;
	const biome = inside && ctx.hasBiome(root);
	if (biome) ctx.runBiome(root, file);
	const kind = inside ? ctx.formatOther(root, file) : "";
	const session = ctx.session || ctx.env.CLAUDE_CODE_SESSION_ID;
	if (session) ctx.recordWrite(written, session);
	const fault = inside ? ctx.scanFaults(root, file) : "";

	const notice = noticeOf(file, root, {
		changed: before !== null && ctx.digest(root, file) !== before,
		unformatted: inside && !biome && BIOME_KIND.test(file),
	});

	/** @type {{ name: string, text: string }[]} */
	const latchWrites = [];
	const rule = (/** @type {string} */ id, /** @type {() => string} */ read) => {
		if (ctx.told(id)) return "";
		try {
			const text = read();
			latchWrites.push({ name: `warn.${id}`, text: "" });
			return text;
		} catch {
			ctx.log(`rule fragment unreadable — rule:${id} went unsaid`);
			return "";
		}
	};
	const msg = [
		notice,
		notice
			? rule("write-reformatted", () => ctx.ruleText("write-reformatted"))
			: "",
		kind === "shell"
			? rule("shell-lint-blind", () => ctx.ruleText("shell-lint-blind"))
			: "",
		fault,
	]
		.filter(Boolean)
		.join("\n\n");
	return msg ? { context: ctx.corePaths(msg), latchWrites } : null;
}

module.exports = {
	field: ["file_path", "notebook_path"],
	noun: "tool write",
	decide,
};
