const { parseCommand, walkCommands } = require("./shell-parse.js");
const { absolute, literal } = require("./shell-words.js");
const { remedyKind } = require("./scratch-remedy.js");
const { SCRATCH_DIR } = require("./scratch-dir.js");
const { shellQuote } = require("./sh-quote.js");
const { ruleOrFallback } = require("./guard-verdict.js");
const { isUnder, relativeUnder } = require("./is-under.js");

/**
 * @typedef {import("./core-contract.js").CoreContext} CoreContext
 * @typedef {import("./guard-entry.js").Decision} Decision
 * @typedef {{ shown: string, name: string }} Stray
 */

class GitUnanswered extends Error {}

const RE_SPAN = new RegExp(
	[
		"\\$\\{[^{}]*\\}",
		"\\$\\([^()]*\\)",
		"`[^`]*`",
		"\\$[A-Za-z_][A-Za-z0-9_]*",
		"\\$[-0-9*@#?$!]",
		"(?<![0-9])[0-9]*\x01",
	].join("|"),
);

/**
 * @param {string} s
 * @param {string} ph
 */
function synthesise(s, ph) {
	let out = s;
	for (let m = RE_SPAN.exec(out); m; m = RE_SPAN.exec(out))
		out = out.replace(m[0], ph);
	return /[$`]/.test(out) || out.includes("\x01") ? null : out;
}

/**
 * @param {string} root
 * @param {CoreContext} ctx
 */
function isThisRepo(root, ctx) {
	if (root === ctx.root) return true;
	const cls = ctx.treeClass(root);
	if (cls === "unknown")
		ctx.log(
			`git could not say whether ${root} is this repo's tree — write allowed unchecked`,
		);
	return cls === "linked" || cls === "shared";
}

/**
 * @param {string} given
 * @param {CoreContext} ctx
 * @param {{ orig: string, glob: string }} [syn]
 * @returns {string | null}
 */
function readStrayName(given, ctx, syn) {
	/** @param {string} s */
	const abs = (s) => absolute(s, ctx.fallbackCwd);
	const p = abs(given).replace("/./", "/");
	if (!/^\./.test(p.slice(p.lastIndexOf("/") + 1))) return null;
	const tree = ctx.tree();
	const orig = syn ? abs(syn.orig) : p;
	const name = relativeUnder(tree.root, p);
	if (!name || name.includes("/") || !/^\..+$/s.test(name)) return null;
	if (!isThisRepo(tree.root, ctx)) return null;
	const ignored = tree.git(["check-ignore", "--", name], [1]);
	if (!ignored.ok)
		throw new GitUnanswered(
			`git check-ignore could not answer for ${name} — write allowed unchecked`,
		);
	if (ignored.out) return null;
	const cut = tree.root.length + 1;
	const spec = syn ? abs(syn.glob).slice(cut) : name;
	const tracked = tree.git(
		syn
			? ["ls-files", "--", spec]
			: ["ls-files", "--error-unmatch", "--", spec],
		syn ? [] : [1],
	);
	if (!tracked.ok)
		throw new GitUnanswered(
			`git ls-files could not answer for ${spec} — write allowed unchecked`,
		);
	if (tracked.out) return null;
	return isUnder(orig, [tree.root]) ? orig.slice(cut) : orig;
}

/**
 * @param {string} word
 * @param {string[]} spans
 * @param {CoreContext} ctx
 * @returns {Stray | null}
 */
function considerTarget(word, spans, ctx) {
	const lit = literal(word, spans);
	if (!lit.text) return null;
	if (lit.known) {
		const name = readStrayName(lit.text, ctx);
		return name === null ? null : { shown: lit.text, name };
	}
	const x = synthesise(lit.text, "X");
	const glob = synthesise(lit.text, "*");
	if (x === null || glob === null) return null;
	const name = readStrayName(x, ctx, { orig: lit.text, glob });
	return name === null ? null : { shown: lit.text, name };
}

/**
 * @param {string} subject
 * @param {CoreContext} ctx
 * @returns {Decision}
 */
function decide(subject, ctx) {
	try {
		const stray = findStray(subject, ctx);
		return stray ? { deny: ctx.corePaths(refusal(stray, ctx)) } : null;
	} catch (e) {
		if (!(e instanceof GitUnanswered)) throw e;
		ctx.log(e.message);
		return null;
	}
}

/**
 * @param {string} subject
 * @param {CoreContext} ctx
 * @returns {Stray | null}
 */
function findStray(subject, ctx) {
	if (ctx.tool !== "Bash") {
		const name = readStrayName(subject, ctx);
		return name === null ? null : { shown: subject, name };
	}
	const parsed = parseCommand(subject);
	/** @type {Stray | null} */
	let stray = null;
	walkCommands(
		parsed,
		(cmd) => {
			for (const t of cmd.writeTargets())
				if (!stray && t.mode === "write")
					stray = considerTarget(t.target, parsed.spans, ctx);
		},
		{ ...ctx, bareRedirects: true },
	);
	return stray;
}

/** @param {string} s */
function mdSpan(s) {
	const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
	const fence = "`".repeat(longest + 1);
	const pad = longest > 0 ? " " : "";
	return `${fence}${pad}${s}${pad}${fence}`;
}

/**
 * @param {string | undefined} tool
 * @param {string} bare
 * @param {string} escaped
 * @param {string} root
 * @returns {[string, string]}
 */
function remedy(tool, bare, escaped, root) {
	switch (remedyKind(tool)) {
		case "write":
			return ["Same write, sanctioned path", `${root}/${SCRATCH_DIR}${bare}`];
		case "move":
			return [
				"Move it into the sanctioned directory, then edit it there",
				`mv ${escaped} ${SCRATCH_DIR}${shellQuote(bare)}`,
			];
		case "command":
			return ["Same command, sanctioned spelling", `${SCRATCH_DIR}${bare}`];
	}
}

/**
 * @param {Stray} stray
 * @param {CoreContext} ctx
 */
function refusal({ shown, name }, ctx) {
	const bare = name.replace(/^\./, "");
	const escaped = shellQuote(name);
	const [same, sanctioned] = remedy(ctx.tool, bare, escaped, ctx.tree().root);
	const scratchLine = ruleOrFallback(
		ctx,
		"scratch-dir-sanctioned",
		"`.claude/tmp/` is gitignored and swept",
	);
	const selfSpelt = ruleOrFallback(
		ctx,
		"self-spelt-escape",
		"an escape a session can spell for itself is not a deny",
	);
	return `Refused: ${mdSpan(shown)} is a dot-prefixed file directly at the repo root, which git neither ignores nor tracks. \`docs/environment.md\` §12 puts in-repo scratch in \`.claude/tmp/\` and nowhere else — ${scratchLine} ${same}:

    ${sanctioned}

IF THIS REALLY IS A ROOT CONFIG FILE RATHER THAN SCRATCH — a mutation arm breaking \`scripts/markdown-tooling-declined.test.ts\`, or a temp \`tsconfig\` whose \`extends\` globs resolve relative to itself — this reads no \`dd\`, so write it through one and it is not seen:

    printf '%s' '{}' | dd of=${escaped}

There is no flag, and none is wanted: ${selfSpelt}`;
}

module.exports = {
	field: ["command", "file_path", "notebook_path"],
	noun: "write",
	decide,
};
