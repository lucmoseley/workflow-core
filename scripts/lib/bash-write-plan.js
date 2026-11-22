const { normAbs, parseCommand, walkCommands } = require("./shell-parse.js");
const { literal, programSource } = require("./shell-words.js");
const { treeOrHost } = require("./tree-or.js");
const { isScratch } = require("./scratch-dir.js");
const { relativeUnder } = require("./is-under.js");

const CODE_EXT = ["js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "sh"];
const CODE_DIR = ".husky/";

const CODE_RE = new RegExp(`\\.(${CODE_EXT.join("|")})$`);

const TIER1 = /^(docs\/|\.claude\/|CLAUDE\.md$|AGENTS\.md$)/;

const CD_PREFIX = new Set([
	"{",
	"(",
	"do",
	"then",
	"else",
	"elif",
	"builtin",
	"command",
	"eval",
	"time",
	"!",
]);

const INTERPRETER = /^(python|python[0-9].*|node|nodejs)$/;

const RESTORE_ROUTES = ["cp", "mv", "git restore", "git checkout"];

/**
 * @typedef {import("./core-contract.js").CoreContext} Ctx
 * @typedef {import("./guard-host-ports.js").TreePorts} Tree
 * @typedef {{ targets: string[], credit: string[], select: string[],
 *   deleted: string[], restored: string[] }} Writes
 */

/**
 * @param {string} abs
 * @param {string} root
 */
function relPath(abs, root) {
	if (/(^|\/)\.\.(\/|$)/.test(abs)) return null;
	return relativeUnder(root, abs) || null;
}

/** @param {string} text */
function quotedTokens(text) {
	/** @type {Set<string>} */
	const seen = new Set();
	for (const q of ["'", '"', "`"])
		for (const m of text.matchAll(new RegExp(`${q}[^${q}\\s]+${q}`, "g")))
			seen.add(m[0].slice(1, -1));
	return [...seen];
}

/**
 * @param {string} prog
 * @param {string[]} args
 * @param {() => { kind: string }[]} redirects
 */
function inlineInterp(prog, args, redirects) {
	const source = programSource(prog, args)?.source;
	return (
		source === "inline" ||
		(source === "stdin" &&
			redirects().some((r) => r.kind === "heredoc" || r.kind === "here-string"))
	);
}

/**
 * @typedef {{ abs: string, rel: string }} Place
 * @typedef {{ spans: string[], seed: string, cwd: string, tree: () => Tree,
 *   out: Writes }} Reading
 */

/**
 * @param {string} word
 * @param {Reading} rd
 * @param {boolean} away
 * @returns {Place | null}
 */
function place(word, rd, away) {
	const lit = literal(word, rd.spans);
	if (!lit.known || !lit.text || lit.text.startsWith("-")) return null;
	const text = lit.text.replace(/^\.\//, "");
	if (!text.startsWith("/") && away) return null;
	const abs = text.startsWith("/") ? text : `${rd.seed}/${text}`;
	const rel = relPath(abs, rd.tree().root);
	return rel === null ? null : { abs, rel };
}

/**
 * @param {Place | null} at
 * @param {"write" | "candidate" | "delete"} mode
 * @param {Writes} out
 */
function addTarget(at, mode, out) {
	if (!at) return;
	if (mode === "delete") {
		out.deleted.push(at.rel);
		return;
	}
	if (TIER1.test(at.rel) && !isScratch(at.rel)) out.targets.push(at.abs);
	if (mode === "candidate") {
		if (/^[A-Za-z0-9._@+/-]+$/.test(at.rel) && /[./]/.test(at.rel))
			out.select.push(at.rel);
		return;
	}
	if (CODE_RE.test(at.rel) || at.rel.startsWith(CODE_DIR))
		out.credit.push(at.rel);
}

/**
 * @param {string} word
 * @param {string[]} spans
 */
function commandName(word, spans) {
	const text = literal(word, spans).text;
	return text.slice(text.lastIndexOf("/") + 1);
}

/**
 * @param {string[]} words
 * @param {Reading} rd
 */
function cdStep(words, rd) {
	const lits = words.map((w) => literal(w, rd.spans));
	const at = lits.findIndex((l) => !CD_PREFIX.has(l.text));
	const head = lits[at]?.text ?? "";
	if (head === "pushd" || head === "popd") {
		rd.cwd = "";
		return true;
	}
	if (head !== "cd" && head !== "\\cd") return false;
	const dest = lits[at + 1];
	if (!dest?.known || !dest.text) rd.cwd = "";
	else if (dest.text.startsWith("/")) rd.cwd = normAbs(dest.text);
	else if (rd.cwd) rd.cwd = normAbs(`${rd.cwd}/${dest.text}`);
	return true;
}

/**
 * @param {import("./shell-parse.js").Command} cmd
 * @param {Reading} rd
 * @returns {boolean}
 */
function readCommand(cmd, rd) {
	if (cdStep(cmd.words, rd)) return false;
	const away = rd.cwd !== rd.seed;
	const rows = cmd.writeTargets();
	for (const t of rows)
		addTarget(
			place(t.target, rd, away),
			t.mode === "delete" ? "delete" : "write",
			rd.out,
		);
	noteRestores(cmd.words, rows, rd, away);
	const prog = commandName(cmd.words[0] ?? "", rd.spans);
	return (
		INTERPRETER.test(prog) &&
		inlineInterp(
			prog,
			cmd.words.slice(1).map((w) => literal(w, rd.spans).text),
			cmd.redirects,
		)
	);
}

/**
 * @param {string} subject
 * @param {Ctx} ctx
 * @param {() => Tree} tree
 * @returns {Writes}
 */
function writes(subject, ctx, tree) {
	const parsed = parseCommand(subject);
	const seed = normAbs(
		typeof ctx.cwd === "string" && ctx.cwd.startsWith("/")
			? ctx.cwd
			: ctx.fallbackCwd,
	);
	/** @type {Reading} */
	const rd = {
		spans: parsed.spans,
		seed,
		cwd: seed,
		tree,
		out: { targets: [], credit: [], select: [], deleted: [], restored: [] },
	};
	let inline = false;
	walkCommands(
		parsed,
		(cmd) => {
			if (readCommand(cmd, rd)) inline = true;
		},
		{ ...ctx, bareRedirects: true },
	);
	if (inline) {
		const raw = { ...rd, spans: [] };
		for (const tok of quotedTokens(subject))
			addTarget(place(tok, raw, rd.cwd !== seed), "candidate", rd.out);
	}
	return rd.out;
}

/**
 * @param {string[]} words
 * @param {import("./shell-parse.js").WriteTarget[]} rows
 * @param {Reading} rd
 * @param {boolean} away
 */
function noteRestores(words, rows, rd, away) {
	/** @param {string} word */
	const note = (word) => {
		const at = place(word, rd, away);
		if (at) rd.out.restored.push(at.rel);
	};
	for (const t of rows)
		if (t.mode === "write" && RESTORE_ROUTES.includes(t.route)) note(t.target);
	const [git = "", sub = "", ...rest] = words;
	if (commandName(git, rd.spans) !== "git") return;
	if (literal(sub, rd.spans).text !== "checkout" || rest.includes("--")) return;
	let value = false;
	for (const word of rest) {
		if (value) value = false;
		else if (["-b", "-B", "--orphan"].includes(word)) value = true;
		else if (!word.startsWith("-")) note(word);
	}
}

/**
 * @param {string[]} deleted
 * @param {Ctx} ctx
 * @param {() => Tree} tree
 * @returns {string[]}
 */
function readTrackedDeletions(deleted, ctx, tree) {
	if (deleted.length === 0) return [];
	const r = tree().git(
		["--literal-pathspecs", "ls-files", "-z", "--", ...deleted],
		[],
	);
	if (!r.ok) {
		ctx.log(
			`git ls-files failed (${r.why}) — a deletion's tracked files went unnoted in the selection ledger`,
		);
		return [];
	}
	return r.out.split("\0").filter(Boolean);
}

/** @param {() => Tree} tree */
function isSelectionReader(tree) {
	const got = tree().read("package.json");
	return got.state === "read" && /"test": *"[^"]*run-vitest\.js/.test(got.data);
}

/**
 * @param {string[]} restored
 * @param {Ctx} ctx
 * @param {() => Tree} tree
 */
function restoreOwed(restored, ctx, tree) {
	if (restored.length === 0) return false;
	const { git } = tree();
	const head = git(["rev-parse", "--verify", "--quiet", "HEAD"], [1]);
	if (!head.ok || !head.out.trim()) {
		ctx.log("HEAD did not resolve — a whole-file restore went unjudged");
		return false;
	}
	const diff = git(
		["--literal-pathspecs", "diff", "--name-only", "HEAD", "--", ...restored],
		[],
	);
	if (!diff.ok) {
		ctx.log(
			`git diff failed (${diff.why}) — a whole-file restore went unjudged`,
		);
		return false;
	}
	return diff.out.trim() !== "";
}

/**
 * @param {string} subject
 * @param {Ctx} ctx
 * @returns {Writes & { owed: boolean }}
 */
function plan(subject, ctx) {
	const tree = lazyTreeOrHost(ctx);
	const w = writes(subject, ctx, tree);
	w.select.push(...readTrackedDeletions(w.deleted, ctx, tree));
	if (w.select.length > 0 && !isSelectionReader(tree)) w.select = [];
	return { ...w, owed: restoreOwed(w.restored, ctx, tree) };
}

/**
 * @param {Ctx} ctx
 * @returns {() => Tree}
 */
function lazyTreeOrHost(ctx) {
	/** @type {Tree | undefined} */
	let tree;
	return () => {
		tree ??= treeOrHost(ctx);
		return tree;
	};
}

module.exports = { plan };
