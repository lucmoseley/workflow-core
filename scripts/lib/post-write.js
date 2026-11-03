/*
 * post-write.js — the PostToolUse dispatcher core for the three things that
 * must happen after a tool write, IN ORDER (workflow-core#2787):
 *
 *   1. Format the file: Biome for JS and TS, shfmt and `ruff format` for shell
 *      and Python (lib/formatters.js's formatWritten, workflow-core#1332).
 *   2. Record the write — the ledger entry (mantahostels#114) and the content
 *      identity the clobber detector compares against (mantahostels#295),
 *      lib/arbiter-tool-record.js.
 *   3. Scan it for a host-root or bare-citation fault (lib/write-scan.js,
 *      workflow-core#1151).
 *
 * Then it says what step 1 did, in one context with the scan's fault (workflow-core#2019):
 * that it reformatted the file, or that a JS, TS or JSON write went
 * unformatted for want of Biome (a worktree), with `rule:write-reformatted`;
 * and on a shell file `rule:shell-lint-blind`. Each fragment is said once a
 * session; the notice on every such write, as each reformat strands an
 * `old_string` quoting the tool's bytes.
 *
 * A recorder, a formatter and an advisory scan, never a guard: it fails open.
 *
 * IMPLICIT:  after every Write/Edit/NotebookEdit, rewrites the file with Biome, shfmt or `ruff format` and then records its bytes as the session's write-ledger entry and clobber baseline; a reformat, a shell file's lint blind spot and a host-root or bare-citation fault in it are handed to the session as context.
 * JUSTIFIED: fail-safe — the record is the clobber detector's only baseline; the formatter half is convenience, and rides here because it must run BEFORE the record, a separate registration having raced it and stored pre-format bytes (mantahostels#295).
 * DEFEAT:    none — the formatters' own ignore rules (ruff's `ruffExclude` among them) and a file outside the repo root (workflow-core#96) are the only exclusions.
 */

/* What Biome formats, and so what a checkout without it leaves unformatted. */
const BIOME_KIND = /\.(c|m)?[jt]sx?$|\.jsonc?$/;

/**
 * @typedef {{
 *   inRoot: (file: string) => boolean,
 *   digest: (file: string) => string | null,
 *   hasBiome: () => boolean,
 *   runBiome: (file: string) => void,
 *   formatOther: (file: string) => "shell" | "",
 *   recordWrite: (file: string, session: string) => void,
 *   scanFaults: (file: string) => string,
 * }} WritePorts the host's, each failing open on its own: whether a path lies
 *   inside the root, as Biome would write it; a file's content digest, null
 *   where unreadable; Biome present and run; shfmt or ruff run; the arbiter's
 *   record; and the scan's fault text, "" where there is none
 */

/**
 * What the session must know about its file: that it was reformatted, or that
 * no Biome ran on a file Biome would have formatted.
 * @param {string} file
 * @param {{ root: string }} ctx
 * @param {{ changed: boolean, unformatted: boolean }} what
 */
function noticeOf(file, { root }, { changed, unformatted }) {
	const rel = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
	if (changed)
		return `post-write reformatted ${rel}: re-read it before your next Edit to it.`;
	if (unformatted)
		return `post-write ran no Biome on ${rel}: this checkout has no node_modules, so the file stays as you wrote it.`;
	return "";
}

/**
 * @param {string} written file_path, else notebook_path
 * @param {import("./guard-dispatch.js").CoreContext & WritePorts} ctx
 */
function decide(written, ctx) {
	/* file_path only, never notebook_path: no formatter has anything to say
	 * about a notebook. */
	const file =
		typeof ctx.input.file_path === "string" ? ctx.input.file_path : "";
	/* Only a file inside the root: one in another repo belongs to that repo's
	 * formatter or none (workflow-core#96). */
	const inside = file !== "" && ctx.inRoot(file);
	const before = inside ? ctx.digest(file) : null;
	const biome = inside && ctx.hasBiome();
	if (biome) ctx.runBiome(file);
	const kind = inside ? ctx.formatOther(file) : "";
	const session = ctx.session || ctx.env.CLAUDE_CODE_SESSION_ID;
	if (session) ctx.recordWrite(written, session);
	/* After the record, so a slow scan can never cost it. */
	const fault = inside ? ctx.scanFaults(file) : "";

	const notice = noticeOf(file, ctx, {
		changed: before !== null && ctx.digest(file) !== before,
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
