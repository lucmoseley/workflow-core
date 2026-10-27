/*
 * recursive-dot-read.js — the dispatcher core that warns on a recursive
 * `grep`/`rg` rooted at the project directory — named as `.` or its path, or
 * named not at all (`rg PAT`) — leading with the same command with that root
 * expanded to the top-level entries that actually exist, minus the ones no
 * search wants and the ones a `Read()` deny rule covers (mantahostels#2717).
 * Its production port beyond the dispatcher's, the physical path, is
 * lib/recursive-dot-read-host.js.
 *
 * A SECOND LIMB, ON THE HEAVY TREES (#2060): a recursive `grep` or `rg`, a
 * `find`, or either under `watch`, whose root is `node_modules`, `.next`, `.git`
 * or ignored build output, or a `find` or `grep` from the repo root, hands over
 * `rule:heavy-tree-search` once a session, beside any warning below. It never
 * refuses.
 *
 * WHY IT IS EXPENSIVE, TWICE. A recursive `grep` reads every tree git ignores
 * or keeps to itself — `node_modules`, `.git`, build output — in any permission
 * mode; `rg` skips those by default, so this cost is grep's alone. And Claude
 * Code escalates a Bash command to a permission prompt whenever it cannot
 * prove the command avoids a path covered by a `Read()` deny rule. A recursive
 * search rooted at `.` traverses the whole tree, `.env` among it, so
 * `Read(./.env)` in .claude/settings.json fires — even though no `.env` exists
 * on this machine. That is shape 2 of mantahostels#2682.
 *
 * THE SESSION CANNOT SEE THE PROMPT IT CAUSED (mantahostels#2717). An escalated
 * command returns normally and exits 0 whether it was allowed outright or
 * approved at a prompt, so no session can measure this for itself, and the
 * guard cannot be tuned by trying shapes and watching. The readings behind it
 * were taken by the founder on Claude Code 2.1.259 and are recorded on
 * mantahostels#2717.
 *
 * The discriminator they establish: whether the check can resolve the read set
 * as excluding the denied path, not which tool does the reading.
 *
 * WHY THIS REWRITE AND NOT A SHORTER ONE. Both shorter rewrites lose files
 * silently (mantahostels#2717):
 *   - `*` alone drops every dot-directory, so `.claude/`, `.github/` and
 *     `.husky/` — real search targets in this repo — vanish from the results
 *     with no signal.
 *   - `git grep` drops untracked files, so a hit in a file not yet committed
 *     goes missing, which is the worst shape a search can fail in.
 *
 * WARN, NOT DENY (#482): every measured session was in auto mode, where no
 * prompt is shown, so the refusal spared none. The `Read(./.env)` rule that
 * causes the prompt stays.
 *
 * THE PROMPT IS NAMED ONLY WHERE THE PAYLOAD'S `permission_mode` CAN SHOW ONE
 * (#1731): never in `auto` or `bypassPermissions`, so there an `rg` search,
 * whose only cost is the prompt, passes unwarned. A payload with no mode is
 * read as `default`.
 *
 * LIMITS
 *  - It never stops the command, so in default permission mode the prompt it
 *    names can happen; the warning spares only a search the session re-spells.
 *  - It judges a root spelled `.`, `./`, or the project directory's absolute
 *    path, and a recursive search naming no path (mantahostels#2723, #1731),
 *    whose rewrite appends the expansion to that search's own text in the
 *    command. A path-less `rg` fed by a pipe, a `<` or a heredoc reads that
 *    instead, and passes; so does any search behind `xargs`, and one whose
 *    text, quotes and all, is not found exactly once in the command. grep's
 *    `-r` ignores stdin. Where the Bash tool's stdin is a socket, as in a
 *    subagent, a path-less `rg` reads it too; the rewrite, naming paths, still
 *    runs right.
 *  - A root QUOTED — `grep -rn PAT "."` — is allowed. The count and the
 *    substitution both read the raw string, where `"."` is not a standalone
 *    `.`.
 *  - Any other spelling of the same directory is unjudged: `$PWD` and
 *    `$CLAUDE_PROJECT_DIR`, which only the shell can expand and which this
 *    guard must not evaluate, and a path reaching the root by `..` or through
 *    a symlink, which matches no literal it compares against.
 *  - The dot limb fires only where the shell already stands in the project
 *    directory, read from the payload's `cwd` as mantahostels#2682 established.
 *    A `.` somewhere else is a different tree, which this guard knows nothing
 *    about.
 *  - A command carrying MORE THAN ONE standalone root spelling is allowed. The
 *    substitution is textual, and a second one — inside a quoted pattern, say —
 *    gives it no way to tell which is the search root. A root WELDED to what
 *    follows it is not standalone and is allowed too: `grep -rn PAT .|head`
 *    reaches the count as the single word `.|head`.
 *  - A `cd`, `pushd` or `popd` ANYWHERE in the command stands the guard down
 *    for every segment after it. The `cwd` gate above reads where the shell
 *    stood BEFORE the command ran, so after a `cd` the expansion would name a
 *    tree the search is no longer in — a rewrite that fails outright rather
 *    than reading widely, which is the one failure worth refusing to hand over.
 *  - Recursion is read from `-r`, `-R` and `--recursive` only. `grep -d
 *    recurse` is the same search and is not seen.
 *  - The command word must be `grep`, `egrep`, `fgrep` or `rg` exactly. A path
 *    spelling — `/usr/bin/grep` — is unjudged.
 *  - A top-level name outside `[A-Za-z0-9._-]` stands the guard down rather
 *    than building a rewrite: the name reaches a shell command line unescaped.
 *  - The expansion is computed from the tree at call time, so a top-level file
 *    added since is included, and one `git ls-files` still lists but the
 *    working tree no longer holds is dropped. It is NOT re-derived from the
 *    deny rules in .claude/settings.json: the exclusion list below is a
 *    literal that must be updated by hand if a `Read()` rule ever names
 *    something else at the top level.
 *  - `--exclude-dir=node_modules` is not added for the caller. `node_modules`
 *    is simply absent from the expansion, which is stronger: grep never
 *    descends into a directory it was not given.
 *  - It reads `grep`, `egrep`, `fgrep` and `rg`. `ag`, `ack` and a recursive
 *    `find … -exec grep` are unjudged.
 *  - For `rg` the rewrite WIDENS the search. `rg PAT .` skips hidden
 *    directories by default, so naming `.claude` and `.github` explicitly makes
 *    rg read them. That is the same set grep already had.
 *  - The heavy-tree limb reads a root's last component, so a search inside one
 *    — `grep -rn PAT node_modules/vitest` — passes, as does a `find` from the
 *    repo root bounded by `-prune` or `-maxdepth`. `dist`, `build`, `out` and
 *    `coverage` count only where git ignores them. A watcher other than `watch`
 *    — `inotifywait`, a bundler's `--watch` — is unjudged, and a single-word
 *    `watch` command is split on blanks, its own quoting unread.
 *  - It FAILS OPEN throughout, house style (mantahostels#103 §6), recording
 *    through the dispatcher's log (mantahostels#147).
 */

const {
	asWritten,
	parseCommand,
	unmask,
	walkCommands,
} = require("./shell-parse.js");
const {
	escapeRe,
	findStarts,
	literal,
	scanFlags,
	unwrap,
} = require("./shell-words.js");

/**
 * @typedef {object} DotReadPorts
 * @property {(p: string) => string} realpath `p` resolved physical, no
 *   component required to exist, as `realpath -m`
 * @typedef {import("./guard-dispatch.js").CoreContext & DotReadPorts}
 *   DotReadContext
 */

/*
 * Flags taking a value, short and long together. Leave one out and its value
 * is read as a bare word — which for `-e PAT .` would make the pattern a path.
 *
 * ONE SPEC PER COMMAND, because the two grammars disagree and a shared list
 * gets both wrong. `-T` is grep's no-value --initial-tab and rg's --type-not
 * VALUE; `-r` is grep's --recursive and rg's --replace VALUE. Listing either
 * wrongly makes the scan eat the pattern, read `.` as the pattern, and ALLOW in
 * silence.
 *
 * An OPTIONAL-value flag is absent from both: `--color` takes its value joined
 * or not at all, so listing it would eat the next word. The `--flag=value`
 * spelling is read as name and value whatever the spec says.
 */
const GREP_VALUE_FLAGS =
	"-e --regexp -f --file -m --max-count -A --after-context -B --before-context -C --context -d --directories -D --devices --include --exclude --exclude-dir --exclude-from --binary-files --label --group-separator";
/* Flags that print and search nothing. grep's `-h` is --no-filename, not help. */
const GREP_INERT_FLAGS = ["--help", "-V", "--version"];
const RG_INERT_FLAGS = ["-h", "--help", "-V", "--version", "--type-list"];
const RG_VALUE_FLAGS =
	"-e --regexp -f --file -m --max-count -A --after-context -B --before-context -C --context -g --glob --iglob -t --type -T --type-not --type-add -M --max-columns -r --replace -d --max-depth --max-filesize --sort --sortr --pre --colors";

const RECURSIVE_FLAGS = ["-r", "-R", "--recursive", "--dereference-recursive"];
const PATTERN_FLAGS = ["-e", "--regexp", "-f", "--file"];
const WATCH_VALUE_FLAGS = ["-n", "--interval", "-q", "--equexit"];

/** bash's [[:space:]], each end. */
const TRIM = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;

/**
 * @typedef {object} Judgement one command's running state
 * @property {"" | "root" | "bare"} fires what fired: a named root, or no path
 * @property {string} tool the searching command that fired
 * @property {string} typed for `bare`, the search as typed
 * @property {boolean} moved a `cd`, `pushd` or `popd` ran — see LIMITS
 * @property {boolean} heavyTree any search's root names a heavy tree (#2060)
 * @property {boolean} inWatch the search being judged runs under `watch`,
 *   where no rewrite is offered
 *
 * @typedef {object} Scene what every judge of one call reads
 * @property {string} raw the command as typed
 * @property {string} root the repo root
 * @property {string} rootReal the repo root resolved physical
 * @property {number} roots how many standalone root spellings it carries
 * @property {boolean} atRoot the shell stands at the repo root
 * @property {boolean} showsPrompt the permission mode can show a prompt
 * @property {string[]} spans
 * @property {DotReadContext} ctx
 * @property {Judgement} judgement
 */

/**
 * @param {string} raw
 * @param {DotReadContext} ctx
 * @returns {import("./guard-dispatch.js").CoreDecision}
 */
function decide(raw, ctx) {
	const { root } = ctx;
	if (!root) {
		ctx.log(
			"the repo root did not resolve — a recursive dot search was allowed unjudged",
		);
		return null;
	}
	/* Cheap pre-test before any of the machinery below: a command naming no
	 * search cannot be one. */
	if (!/grep|rg|find/.test(raw)) return null;
	const mode = ctx.permissionMode ?? "";
	if (!ctx.cwd) {
		ctx.log(
			"the payload carried no .cwd — every recursive dot search is allowed unjudged",
		);
		return null;
	}
	/* The heavy-tree limb judges wherever the shell stands. */
	const rootReal = ctx.realpath(root);
	const parsed = parseCommand(raw);
	/** @type {Scene} */
	const scene = {
		raw,
		root,
		rootReal,
		roots: raw.split(/[ \t\n]/).filter((w) => isRootSpelling(w, root)).length,
		atRoot: ctx.realpath(ctx.cwd) === rootReal,
		showsPrompt: mode !== "auto" && mode !== "bypassPermissions",
		spans: parsed.spans,
		ctx,
		judgement: {
			fires: "",
			tool: "",
			typed: "",
			moved: false,
			heavyTree: false,
			inWatch: false,
		},
	};
	/* Through the shared parser rather than the raw string: a `grep` mentioned
	 * in an echo or a heredoc body is not a search. */
	walkCommands(
		parsed,
		({ segment, words, cwd }) => judge(scene, segment, words, cwd),
		ctx,
	);
	const { judgement } = scene;
	/* A heavy-tree root with nothing to rewrite gets the rule alone. */
	if (!judgement.fires)
		return judgement.heavyTree ? { injectRules: ["heavy-tree-search"] } : null;
	return rewrite(scene, mode);
}

/**
 * The warning a fired search earns, led by its rewrite; null, logged, where
 * no rewrite can be built.
 * @param {Scene} scene
 * @param {string} mode
 * @returns {import("./guard-dispatch.js").CoreDecision}
 */
function rewrite({ raw, root, showsPrompt, ctx, judgement }, mode) {
	const expansion = expand(root, ctx);
	if (expansion === null) return null;
	/* Textual substitution on the raw string, so quoting everywhere else
	 * survives untouched. For a named root, exactly one standalone root is
	 * present — the count required it — so the first match is the search root.
	 * For no path, the search's own text gains the expansion after it; a
	 * redirection it carries may stand before a path, as shell reads it. */
	const rewritten =
		judgement.fires === "bare"
			? raw.replace(judgement.typed, () => `${judgement.typed} ${expansion}`)
			: raw.replace(
					new RegExp(
						`(^|[ \\t\\n\\v\\f\\r])(\\.|${escapeRe(root)})\\/?([ \\t\\n\\v\\f\\r]|$)`,
						"m",
					),
					(_m, before, _r, after) => `${before}${expansion}${after}`,
				);
	if (rewritten === raw) {
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
	const warning = ctx.corePaths(`${unmask(rewritten).replace(/\n+$/, "")}

That is your search with its root expanded; yours runs as written.${why}

The expansion is git's view of the top level: it keeps .claude/, .github/
and untracked directories, and misses gitignored paths and untracked root
files. For \`rg\` it WIDENS the search to the hidden directories \`rg PAT .\` skips.`);
	return heavy
		? { injectRules: ["heavy-tree-search"], prelude: warning }
		: { context: warning };
}

/**
 * The replacement, built out of GIT'S OWN VIEW of the top level, which needs no
 * maintained exclusion list: .git, node_modules, .next and every cache
 * directory are gitignored already, and stay out for that reason rather than
 * by name. Null, logged, where it cannot be built.
 *
 * Two lists, unioned:
 *   ls-files                              tracked content — its first path
 *                                         component is a directory worth
 *                                         searching, or a root file
 *   ls-files --others --exclude-standard  a directory that exists but holds
 *             --directory                 nothing tracked yet, so a new one is
 *                                         not silently dropped
 *
 * The second is filtered to DIRECTORIES, and to NON-DOT ones. Taking untracked
 * root files too would re-admit the hundreds of `.<name>.out` scratch files
 * this repo's root carries. And an untracked DOT-directory at this root is
 * tooling state that nobody ignored — searching a cache on every rewritten
 * command is a cost with no return. The price of that line is a new source
 * directory named with a leading dot, which would be dropped silently; no such
 * directory exists here, and a tracked one — `.claude`, `.github` — comes
 * through the first list.
 * @param {string} root
 * @param {DotReadContext} ctx
 * @returns {string | null}
 */
function expand(root, ctx) {
	const lines = (/** @type {string[]} */ args) => {
		const r = ctx.git(args, []);
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
		/* The first path component: the directory to search, or the file itself. */
		const name = p.split("/")[0] ?? "";
		if (name === "" || name === ".env" || name.startsWith(".env.")) continue;
		if (name.endsWith(".pem")) continue;
		/* The name reaches a shell command line unescaped. Every top-level name
		 * in this repo is in the class below; one outside it — a space, a `&`, a
		 * glob character, a leading dash — would be misread, so stand down. */
		if (/[^A-Za-z0-9._-]/.test(name) || name.startsWith("-")) {
			ctx.log(
				"a top-level name outside [A-Za-z0-9._-] — a recursive dot search was allowed unrewritten",
			);
			return null;
		}
		/* Tracked but not on disk: `ls-files` still lists a file deleted from the
		 * working tree, and naming it would make the corrected grep warn `No such
		 * file` and exit 2 even where it matched. Existence follows a symlink, so
		 * a broken one is dropped for the same reason. */
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

/**
 * Whether a search root is node_modules, .next or .git by its last component,
 * or dist, build, out or coverage where git ignores it.
 * @param {Scene} scene
 * @param {string} word
 * @param {string} cwd
 */
function namesTree({ spans, ctx }, word, cwd) {
	const { text, known } = literal(word, spans);
	if (!known) return false;
	let lit = text;
	while (lit.endsWith("/") && lit !== "/") lit = lit.slice(0, -1);
	const base = afterSlash(lit);
	if (base === "node_modules" || base === ".next" || base === ".git")
		return true;
	if (!["dist", "build", "out", "coverage"].includes(base)) return false;
	const r = ctx.git(
		[...(cwd ? ["-C", cwd] : []), "check-ignore", "--", `${lit}/`],
		[1],
	);
	if (!r.ok) {
		ctx.log(
			`git check-ignore failed — a recursive search of ${lit} was judged not build output`,
			r.why,
		);
		return false;
	}
	return r.out !== "";
}

/**
 * Whether a start point, resolved against the walker's cwd, is the repo root,
 * which holds every heavy tree.
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
 * A `find` reads every tree it is given, ignored or not. From the repo root it
 * is let off only by a `-prune` or a `-maxdepth`.
 * @param {Scene} scene accumulator: its `judgement` is advanced here
 * @param {string[]} words the words after `find`
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
 * `watch` runs its command through `sh -c`, so a single word is split back
 * into the command it holds: its first line, on blanks.
 * @param {Scene} scene accumulator: its `judgement` is advanced here
 * @param {string} segment
 * @param {string[]} words the words after `watch`
 * @param {string} cwd
 */
function judgeWatch(scene, segment, words, cwd) {
	let i = 0;
	for (; i < words.length; i++) {
		const lit = literal(words[i] ?? "", scene.spans).text;
		if (WATCH_VALUE_FLAGS.includes(lit)) i++;
		else if (lit === "--") {
			i++;
			break;
		} else if (!lit.startsWith("-")) break;
	}
	const rest = words.slice(i);
	if (rest.length === 0) return;
	scene.judgement.inWatch = true;
	const inner =
		rest.length === 1
			? (literal(rest[0] ?? "", scene.spans).text.split("\n")[0] ?? "")
					.split(/[ \t]+/)
					.filter(Boolean)
			: rest;
	judge(scene, segment, inner, cwd);
	scene.judgement.inWatch = false;
}

/**
 * @typedef {{ grepLike: boolean, recursive: boolean, spec: string,
 *   inert: string[] }} SearchKind a searching command's grammar
 */

/* `rg` is recursive with no flag at all; the greps need one. */
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
 * One command the string runs.
 * @param {Scene} scene accumulator: its `judgement` is advanced here
 * @param {string} segment the flattened segment, masked
 * @param {string[]} words its own words
 * @param {string} cwd where it runs
 */
function judge(scene, segment, words, cwd) {
	const w = unwrap(words, scene.spans).words;
	const [head, ...args] = w;
	if (head === undefined) return;
	const kind = SEARCHES.get(head);
	if (kind) judgeSearch(scene, { segment, words, cwd, head, kind, args });
	else if (head === "cd" || head === "pushd" || head === "popd")
		scene.judgement.moved = true;
	else if (head === "find") judgeFind(scene, args, cwd);
	else if (head === "watch" && !scene.judgement.inWatch)
		judgeWatch(scene, segment, args, cwd);
}

/**
 * @typedef {object} Search one searching command
 * @property {string} segment the flattened segment, masked
 * @property {string[]} words the command's words, wrappers and all
 * @property {string} cwd where it runs
 * @property {string} head its command word
 * @property {SearchKind} kind
 * @property {string[]} args its own arguments
 */

/**
 * Whether this search may earn the dot rewrite: nothing fired yet, no `cd`
 * before it, the shell at the root and no `watch` around it — and for `rg`,
 * whose only cost at the root is the prompt, a mode that can show one.
 * @param {Scene} scene
 * @param {string} head
 */
const dotAllowed = ({ judgement, atRoot, showsPrompt }, head) =>
	(head !== "rg" || showsPrompt) &&
	!judgement.fires &&
	!judgement.moved &&
	atRoot &&
	!judgement.inWatch;

/**
 * @param {Scene} scene accumulator: its `judgement` is advanced here
 * @param {Search} search
 */
function judgeSearch(scene, search) {
	const { judgement } = scene;
	const { kind, head, cwd } = search;
	const dotOk = dotAllowed(scene, head);
	const found = scan(scene, search, dotOk);
	if (!found.recursive || found.inert) return;
	const bareCount = found.patternByFlag ? 0 : 1;
	/* A grep naming no path searches where it stands, the repo root included. */
	if (kind.grepLike && found.bareWords === bareCount)
		found.heavy ||= isProjectRoot(scene, ".", cwd);
	if (found.heavy) judgement.heavyTree = true;
	if (!dotOk) return;
	if (found.dotRoot) {
		judgement.fires = "root";
		judgement.tool = head;
		return;
	}
	/* No path: the bare words are the pattern alone, if any. */
	if (found.bareWords !== bareCount - (found.files ? 1 : 0)) return;
	const typed = bareSearch(scene, search.segment, search.words, head);
	if (typed === null) return;
	judgement.fires = "bare";
	judgement.tool = head;
	judgement.typed = typed;
}

/**
 * @typedef {object} Scanned what one search's own arguments say
 * @property {boolean} recursive
 * @property {boolean} inert a flag that prints and searches nothing
 * @property {number} bareWords how many bare words it carries
 * @property {boolean} patternByFlag a pattern given by flag means every bare
 *   word is a path
 * @property {boolean} files `--files`, which takes no pattern
 * @property {boolean} heavy a root names a heavy tree
 * @property {boolean} dotRoot a root is the project directory, standalone
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
 * One value-less flag of a search.
 * @param {Scanned} out accumulator: the flag's facts are set here
 * @param {SearchKind} kind
 * @param {string} name
 */
function readFlag(out, kind, name) {
	if (RECURSIVE_FLAGS.includes(name)) out.recursive = true;
	if (name === "--files") out.files = true;
	if (kind.inert.includes(name)) out.inert = true;
}

/**
 * One bare word of a search. The first is the pattern, unless a flag already
 * supplied one; every other is a root.
 * @param {Scene} scene
 * @param {Scanned} out accumulator: the word is counted and its facts set
 *   here
 * @param {{ search: Search, dotOk: boolean }} at
 * @param {string} value
 */
function readArg(scene, out, { search, dotOk }, value) {
	out.bareWords++;
	if (out.bareWords <= 1 && !out.patternByFlag) return;
	if (namesTree(scene, value, search.cwd)) out.heavy = true;
	if (search.kind.grepLike && isProjectRoot(scene, value, search.cwd))
		out.heavy = true;
	if (dotOk && scene.roots === 1 && isRootSpelling(value, scene.root))
		out.dotRoot = true;
}

/**
 * A path-less search's text as typed, found exactly once in the command;
 * null where it reads something other than the tree or cannot be placed.
 * @param {Scene} scene
 * @param {string} segment
 * @param {string[]} words the command's words, wrappers and all
 * @param {string} head the search's command word
 */
function bareSearch({ raw, spans }, segment, words, head) {
	for (const x of words) {
		if (x === head) break;
		if (afterSlash(x) === "xargs") return null;
	}
	if (head === "rg" && segment.includes("<")) return null;
	const text = asWritten(segment, spans).replace(TRIM, "");
	const at = raw.indexOf(text);
	if (!text || at < 0) return null;
	/* Twice in the command, and which one is this search is unreadable. */
	if (raw.indexOf(text, at + text.length) >= 0) return null;
	const before = raw.slice(0, at).replace(/[ \t\n\v\f\r]+$/, "");
	if (head === "rg" && before.endsWith("|") && !before.endsWith("||"))
		return null;
	return text;
}

module.exports = {
	field: "command",
	noun: "command",
	decide,
};
