const path = require("node:path");
const {
	BASH_SPACE,
	asWritten,
	parseCommand,
	unmask,
	walkCommands,
} = require("./shell-parse.js");
const { escapeRe } = require("./regex-group.js");
const { findStarts, literal, runText, scanFlags } = require("./shell-words.js");
const { trimEndRun, trimRun } = require("./trim-run.js");
const { treeOr } = require("./tree-or.js");
const { relativeUnder } = require("./is-under.js");

/**
 * @typedef {object} DotReadPorts
 * @property {(p: string) => string} realpath
 * @typedef {import("./core-contract.js").CoreContext & DotReadPorts} DotReadContext
 */

const GREP_VALUE_FLAGS =
	"-e --regexp -f --file -m --max-count -A --after-context -B --before-context -C --context -d --directories -D --devices --include --exclude --exclude-dir --exclude-from --binary-files --label --group-separator";
const GREP_INERT_FLAGS = ["--help", "-V", "--version"];
const RG_INERT_FLAGS = ["-h", "--help", "-V", "--version", "--type-list"];
const RG_VALUE_FLAGS =
	"-e --regexp -f --file -m --max-count -A --after-context -B --before-context -C --context -g --glob --iglob -t --type -T --type-not --type-add -M --max-columns -r --replace -d --max-depth --max-filesize --sort --sortr --pre --colors";

const RECURSIVE_FLAGS = ["-r", "-R", "--recursive", "--dereference-recursive"];
const PATTERN_FLAGS = ["-e", "--regexp", "-f", "--file"];

/**
 * @typedef {object} Judgement
 * @property {"" | "root" | "bare"} fires
 * @property {string} tool
 * @property {string} typed
 * @property {string} base
 * @property {boolean} moved
 * @property {boolean} heavyTree
 * @property {boolean} inWatch
 * @typedef {object} Scene
 * @property {string} raw
 * @property {string} root
 * @property {import("./guard-host-ports.js").TreePorts | null} tree
 * @property {string} rootReal
 * @property {boolean} atRoot
 * @property {boolean} showsPrompt
 * @property {string[]} spans
 * @property {DotReadContext} ctx
 * @property {Judgement} judgement
 */

/**
 * @param {string} raw
 * @param {DotReadContext} ctx
 * @returns {import("./core-contract.js").CoreDecision}
 */
function decide(raw, ctx) {
	if (!/grep|rg|find/.test(raw)) return null;
	const mode = ctx.permissionMode ?? "";
	if (!ctx.cwd) {
		ctx.log(
			"the payload carried no .cwd — every recursive dot search is allowed unjudged",
		);
		return null;
	}
	const tree = treeOr(ctx, null);
	const root = tree?.root ?? "";
	const rootReal = tree ? ctx.realpath(root) : "";
	const parsed = parseCommand(raw);
	/** @type {Scene} */
	const scene = {
		raw,
		root,
		tree,
		rootReal,
		atRoot: tree !== null && ctx.realpath(ctx.cwd) === rootReal,
		showsPrompt: mode !== "auto" && mode !== "bypassPermissions",
		spans: parsed.spans,
		ctx,
		judgement: {
			fires: "",
			tool: "",
			typed: "",
			base: raw,
			moved: false,
			heavyTree: false,
			inWatch: false,
		},
	};
	walkCommands(parsed, (cmd) => judge(scene, cmd), ctx);
	const { judgement } = scene;
	if (!judgement.fires)
		return judgement.heavyTree ? { injectRules: ["heavy-tree-search"] } : null;
	return rewrite(scene, mode);
}

/**
 * @param {Scene} scene
 * @param {string} mode
 * @returns {import("./core-contract.js").CoreDecision}
 */
function rewrite({ root, tree, showsPrompt, ctx, judgement }, mode) {
	const { base } = judgement;
	if (tree === null) return null;
	const expansion = expand(tree, ctx);
	if (expansion === null) return null;
	const rewritten =
		judgement.fires === "bare"
			? base.replace(judgement.typed, () => `${judgement.typed} ${expansion}`)
			: base.replace(
					new RegExp(
						`(^|[ \\t\\n\\v\\f\\r])(\\.|${escapeRe(root)})\\/?([ \\t\\n\\v\\f\\r]|$)`,
						"m",
					),
					(_m, before, _r, after) => `${before}${expansion}${after}`,
				);
	if (rewritten === base) {
		ctx.log(
			"the standalone root did not substitute — a recursive dot search was allowed unrewritten",
		);
		return null;
	}
	let heavy = judgement.heavyTree;
	let why = "";
	if (judgement.tool !== "rg") {
		heavy = true;
		why =
			"\nYours also reads what git ignores: node_modules, .git, build output.";
	}
	if (showsPrompt)
		why += `
It covers ${root}/.env, named by the \`Read(./.env)\` deny rule in
.claude/settings.json, so this session's \`${mode || "default"}\` permission mode
shows a permission prompt whether or not a .env exists (mantahostels#2717).
Auto mode shows none (#482).`;
	const warning = ctx.corePaths(`${trimEndRun(unmask(rewritten), "\n")}

That is your search with its root expanded; yours runs as written.${why}

The expansion is git's view of the top level: it keeps .claude/, .github/
and untracked directories, and misses gitignored paths and untracked root
files. For \`rg\` it WIDENS the search to the hidden directories \`rg PAT .\` skips.`);
	return heavy
		? { injectRules: ["heavy-tree-search"], prelude: warning }
		: { context: warning };
}

/**
 * @param {import("./guard-host-ports.js").TreePorts} tree
 * @param {DotReadContext} ctx
 * @returns {string | null}
 */
function expand(tree, ctx) {
	const { root } = tree;
	const lines = (/** @type {string[]} */ args) => {
		const r = tree.git(args, []);
		return r.ok ? r.out.split("\n") : [];
	};
	const paths = [
		...lines(["ls-files"]),
		...lines([
			"ls-files",
			"--others",
			"--exclude-standard",
			"--directory",
		]).filter((p) => /^[^.].*\/$/.test(p)),
	];
	/** @type {string[]} */
	const names = [];
	for (const p of paths) {
		const name = p.split("/")[0] ?? "";
		if (name === "" || name === ".env" || name.startsWith(".env.")) continue;
		if (name.endsWith(".pem")) continue;
		if (/[^A-Za-z0-9._-]/.test(name) || name.startsWith("-")) {
			ctx.log(
				"a top-level name outside [A-Za-z0-9._-] — a recursive dot search was allowed unrewritten",
			);
			return null;
		}
		if (!ctx.exists(`${root}/${name}`) || names.includes(name)) continue;
		names.push(name);
	}
	if (names.length === 0) {
		ctx.log(
			"the project directory listed no usable entry — a recursive dot search was allowed unrewritten",
		);
		return null;
	}
	return names.join(" ");
}

/** @param {string} w */
const afterSlash = (w) => w.slice(w.lastIndexOf("/") + 1);

const HEAVY_TREES = ["node_modules", ".next", ".git"];
const BUILD_OUTPUT = ["dist", "build", "out", "coverage"];

/**
 * @param {string} dir
 * @param {string} root
 */
function isInHeavyTree(dir, root) {
	const below = (root === "" ? null : relativeUnder(root, dir)) ?? dir;
	return below.split("/").some((c) => HEAVY_TREES.includes(c));
}

/**
 * @param {Scene} scene
 * @param {string} word
 * @param {string} cwd
 */
function namesTree({ spans, ctx, tree, root }, word, cwd) {
	const { text, known } = literal(word, spans);
	if (!known) return false;
	let lit = text;
	while (lit.endsWith("/") && lit !== "/") lit = lit.slice(0, -1);
	const resolved =
		cwd && !lit.startsWith("/") ? path.posix.join(cwd, lit) : lit;
	const base = afterSlash(resolved);
	if (HEAVY_TREES.includes(base)) return true;
	const isDot = path.posix.normalize(lit) === ".";
	if (isDot && isInHeavyTree(resolved, root)) return true;
	if (!BUILD_OUTPUT.includes(base) || (isDot && tree === null)) return false;
	const r = (tree ?? ctx).git(
		[...(cwd ? ["-C", cwd] : []), "check-ignore", "--", `${resolved}/`],
		[1],
	);
	if (!r.ok) {
		ctx.log(
			`git check-ignore failed — a recursive search of ${resolved} was judged not build output`,
			r.why,
		);
		return false;
	}
	return r.out !== "";
}

/**
 * @param {Scene} scene
 * @param {string} word
 * @param {string} cwd
 */
function isProjectRoot({ spans, ctx, rootReal }, word, cwd) {
	const { text, known } = literal(word, spans);
	if (!known) return false;
	const lit = text.startsWith("/") ? text : `${cwd}/${text}`;
	return rootReal !== "" && ctx.realpath(lit) === rootReal;
}

/**
 * @param {Scene} scene
 * @param {string[]} words
 * @param {string} cwd
 */
function judgeFind(scene, words, cwd) {
	const bounded = words.some((w) =>
		["-prune", "-maxdepth"].includes(literal(w, scene.spans).text),
	);
	const starts = findStarts(words, scene.spans);
	for (const start of starts.length > 0 ? starts : ["."]) {
		if (namesTree(scene, start, cwd)) scene.judgement.heavyTree = true;
		if (!bounded && isProjectRoot(scene, start, cwd))
			scene.judgement.heavyTree = true;
	}
}

/**
 * @typedef {{ grepLike: boolean, recursive: boolean, spec: string,
 *   inert: string[] }} SearchKind
 */

/** @type {SearchKind} */
const GREP_KIND = {
	grepLike: true,
	recursive: false,
	spec: GREP_VALUE_FLAGS,
	inert: GREP_INERT_FLAGS,
};
/** @type {SearchKind} */
const RG_KIND = {
	grepLike: false,
	recursive: true,
	spec: RG_VALUE_FLAGS,
	inert: RG_INERT_FLAGS,
};
/** @type {Map<string, SearchKind>} */
const SEARCHES = new Map([
	["grep", GREP_KIND],
	["egrep", GREP_KIND],
	["fgrep", GREP_KIND],
	["rg", RG_KIND],
]);

/**
 * @param {string} w
 * @param {string} root
 */
const isRootSpelling = (w, root) =>
	w === "." || w === "./" || w === root || w === `${root}/`;

/**
 * @param {Scene} scene
 * @param {import("./shell-parse.js").Command} cmd
 */
function judge(scene, { segment, words, runs }) {
	for (const run of runs()) {
		const { words: w, watched, scripted } = run;
		const [head, ...args] = w;
		if (head === undefined) continue;
		const [cwd] = run.dirs();
		scene.judgement.inWatch = watched;
		const kind = SEARCHES.get(head);
		const own = { segment: runText(run, segment), words: scripted ? w : words };
		const base = scripted
			? trimRun(asWritten(own.segment, scene.spans), BASH_SPACE)
			: scene.raw;
		const launched = run.chdirs.length > 0;
		if (kind)
			judgeSearch(scene, { ...own, base, cwd, launched, head, kind, args });
		else if (head === "cd" || head === "pushd" || head === "popd")
			scene.judgement.moved = true;
		else if (head === "find") judgeFind(scene, args, cwd);
	}
}

/**
 * @typedef {object} Search
 * @property {string} segment
 * @property {string[]} words
 * @property {string} base
 * @property {string} cwd
 * @property {boolean} launched
 * @property {string} head
 * @property {SearchKind} kind
 * @property {string[]} args
 */

/**
 * @param {Scene} scene
 * @param {Search} search
 */
const dotAllowed = ({ judgement, atRoot, showsPrompt }, { head, launched }) =>
	(head !== "rg" || showsPrompt) &&
	!launched &&
	!judgement.fires &&
	!judgement.moved &&
	atRoot &&
	!judgement.inWatch;

/**
 * @param {Scene} scene
 * @param {Search} search
 */
function judgeSearch(scene, search) {
	const { judgement } = scene;
	const { kind, head, cwd } = search;
	const dotOk = dotAllowed(scene, search);
	const found = scan(scene, search, dotOk);
	if (!found.recursive || found.inert) return;
	const bareCount = found.patternByFlag ? 0 : 1;
	if (found.bareWords === bareCount) {
		found.heavy ||= namesTree(scene, ".", cwd);
		if (kind.grepLike) found.heavy ||= isProjectRoot(scene, ".", cwd);
	}
	if (found.heavy) judgement.heavyTree = true;
	if (!dotOk) return;
	if (found.dotRoot) {
		judgement.fires = "root";
		judgement.tool = head;
		judgement.base = search.base;
		return;
	}
	if (found.bareWords !== bareCount - (found.files ? 1 : 0)) return;
	const typed = bareSearch(scene, search, head);
	if (typed === null) return;
	judgement.fires = "bare";
	judgement.tool = head;
	judgement.typed = typed;
	judgement.base = search.base;
}

/**
 * @typedef {object} Scanned
 * @property {boolean} recursive
 * @property {boolean} inert
 * @property {number} bareWords
 * @property {boolean} patternByFlag
 * @property {boolean} files
 * @property {boolean} heavy
 * @property {boolean} dotRoot
 */

/**
 * @param {Scene} scene
 * @param {Search} search
 * @param {boolean} dotOk
 * @returns {Scanned}
 */
function scan(scene, search, dotOk) {
	const { kind } = search;
	/** @type {Scanned} */
	const out = {
		recursive: kind.recursive,
		inert: false,
		bareWords: 0,
		patternByFlag: false,
		files: false,
		heavy: false,
		dotRoot: false,
	};
	scanFlags(kind.spec, search.args, (k, name, value) => {
		if (k === "flag") readFlag(out, kind, name);
		else if (k === "opt" && PATTERN_FLAGS.includes(name))
			out.patternByFlag = true;
		else if (k === "arg") readArg(scene, out, { search, dotOk }, value);
	});
	return out;
}

/**
 * @param {Scanned} out
 * @param {SearchKind} kind
 * @param {string} name
 */
function readFlag(out, kind, name) {
	if (RECURSIVE_FLAGS.includes(name)) out.recursive = true;
	if (name === "--files") out.files = true;
	if (kind.inert.includes(name)) out.inert = true;
}

/**
 * @param {Scene} scene
 * @param {Scanned} out
 * @param {{ search: Search, dotOk: boolean }} at
 * @param {string} value
 */
function readArg(scene, out, { search, dotOk }, value) {
	out.bareWords++;
	if (out.bareWords <= 1 && !out.patternByFlag) return;
	if (namesTree(scene, value, search.cwd)) out.heavy = true;
	if (search.kind.grepLike && isProjectRoot(scene, value, search.cwd))
		out.heavy = true;
	if (
		dotOk &&
		rootCount(search.base, scene.root) === 1 &&
		isRootSpelling(value, scene.root)
	)
		out.dotRoot = true;
}

/**
 * @param {string} text
 * @param {string} root
 */
const rootCount = (text, root) =>
	root
		? text.split(/[ \t\n]/).filter((w) => isRootSpelling(w, root)).length
		: 0;

/**
 * @param {Scene} scene
 * @param {Search} search
 * @param {string} head
 */
function bareSearch({ spans }, { segment, words, base }, head) {
	for (const x of words) {
		if (x === head) break;
		if (afterSlash(x) === "xargs") return null;
	}
	if (head === "rg" && segment.includes("<")) return null;
	const text = trimRun(asWritten(segment, spans), BASH_SPACE);
	const at = base.indexOf(text);
	if (!text || at < 0) return null;
	if (base.indexOf(text, at + text.length) >= 0) return null;
	const before = trimEndRun(base.slice(0, at), BASH_SPACE);
	if (head === "rg" && before.endsWith("|") && !before.endsWith("||"))
		return null;
	return text;
}

module.exports = {
	field: "command",
	noun: "command",
	decide,
};
