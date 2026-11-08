/*
 * post-write.js — the PostToolUse dispatcher core for the three things that
 * must happen after a tool write, IN ORDER (#2787):
 *
 *   1. Format the file: Biome for JS and TS, shfmt and `ruff format` for shell
 *      and Python (lib/formatters.js's formatWritten, #1332).
 *   2. Record the write — the ledger entry (mantahostels#114) and the content
 *      identity the clobber detector compares against (mantahostels#295),
 *      lib/arbiter-tool-record.js.
 *   3. Scan it for a host-root or bare-citation fault (lib/write-scan.js,
 *      #1151).
 *
 * Then it says what step 1 did, in one context with the scan's fault (#2019):
 * that it reformatted the file, or that a JS, TS or JSON write went
 * unformatted for want of Biome (a checkout with no `node_modules` of its
 * own), with `rule:write-reformatted`;
 * and on a shell file `rule:shell-lint-blind`. Each fragment is said once a
 * session; the notice on every such write, as each reformat strands an
 * `old_string` quoting the tool's bytes.
 *
 * A recorder, a formatter and an advisory scan, never a guard: it fails open.
 *
 * IMPLICIT:  after every Write/Edit/NotebookEdit, rewrites the file with Biome, shfmt or `ruff format` and then records its bytes as the session's write-ledger entry and clobber baseline; a reformat, a shell file's lint blind spot and a host-root or bare-citation fault in it are handed to the session as context.
 * JUSTIFIED: fail-safe — the record is the clobber detector's only baseline; the formatter half is convenience, and rides here because it must run BEFORE the record, a separate registration having raced it and stored pre-format bytes (mantahostels#295).
 * DEFEAT:    none — the formatters' own ignore rules (ruff's `ruffExclude` among them) and a file outside the repo root (#96) are the only exclusions.
 */

const { treeOrHost } = require("./tree-or.js");
const { relativeUnder } = require("./is-under.js");

/* What Biome formats, and so what a checkout without it leaves unformatted. */
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
 * }} WritePorts the host's, each failing open on its own, each but the
 *   record acting in the tree rooted at `root`: whether a path lies inside
 *   it, as Biome would write it; a file's content digest, null where
 *   unreadable; that tree's Biome present and run; shfmt or ruff run; the
 *   arbiter's record; and the scan's fault text, "" where there is none
 */

/**
 * What the session must know about its file: that it was reformatted, or that
 * no Biome ran on a file Biome would have formatted.
 * @param {string} file
 * @param {string} root the tree it was formatted in
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
 * @param {string} written file_path, else notebook_path
 * @param {import("./core-contract.js").CoreContext & WritePorts} ctx
 */
function decide(written, ctx) {
	/* file_path only, never notebook_path: no formatter has anything to say
	 * about a notebook. */
	const file =
		typeof ctx.input.file_path === "string" ? ctx.input.file_path : "";
	/* Formatted in the session's tree, by its own Biome and config: in a
	 * linked worktree, the worktree's (#4242). Only a file inside it: one in
	 * another repo belongs to that repo's formatter or none (#96). */
	const root = file === "" ? ctx.root : treeOrHost(ctx).root;
	const inside = file !== "" && ctx.inRoot(root, file);
	const before = inside ? ctx.digest(root, file) : null;
	const biome = inside && ctx.hasBiome(root);
	if (biome) ctx.runBiome(root, file);
	const kind = inside ? ctx.formatOther(root, file) : "";
	const session = ctx.session || ctx.env.CLAUDE_CODE_SESSION_ID;
	if (session) ctx.recordWrite(written, session);
	/* After the record, so a slow scan can never cost it. */
	const fault = inside ? ctx.scanFaults(root, file) : "";

	const notice = noticeOf(file, root, {
		changed: before !== null && ctx.digest(root, file) !== before,
		unformatted: inside && !biome && BIOME_KIND.test(file),
	});

	/** @type {{ name: string, text: string }[]} */
	const latchWrites = [];
	/* A fragment the store cannot answer for is left out and left unlatched,
	 * so a later trigger still tells it. The read is passed in, its id spelt
	 * out, so check-guard-registry.js sees this core print the fragment. */
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
