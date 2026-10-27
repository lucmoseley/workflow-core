/*
 * test-read-edges.js — the read-graph vitest cannot see.
 *
 * Vitest selects `--changed` on the IMPORT graph. A test that reaches a file
 * through `readFileSync` at runtime has no edge there, so a commit changing a
 * tracked document selects zero tests while the tests asserting over that
 * document sit unrun (mantahostels#2031).
 *
 * This library derives the missing edges. It is deliberately LEXICAL and
 * deliberately over-inclusive: a false edge costs one extra test file in a
 * filtered run, a missed edge costs an unrun assertion, and only the second is
 * a correctness loss.
 *
 * TWO ANCHORS, EACH GOVERNING ITS OWN PASS, and a source may carry both.
 * `ANCHOR` — a ROOT spelling — licenses reading a literal at the repo root.
 * `DIRNAME` — a bare `__dirname` — licenses reading it against the test's own
 * directory instead, the only way a guard test's `path.resolve(__dirname,
 * "guard-x.sh")` reaches `scripts/guard-x.sh` (mantahostels#2433). Keeping them apart is
 * what makes the second pass cheap: letting a bare `__dirname` license the
 * ROOT pass too turns every tempdir fixture beside one into a false root edge.
 *
 * A test's own comments are scanned too: a quoted path in one reads as an
 * edge, over-inclusion of the cheap kind. A helper's and a script's are not:
 * citing a document in a shared helper's comment is the house idiom, and
 * scanning them measured costly, not cheap (workflow-core#2074, workflow-core#2093). The root anchor
 * is what keeps tempdir fixtures out: a test writing its own `doc-map.md`
 * into os.tmpdir() names the literal but no anchor.
 *
 * ONE HOP: a test naming no literal of its own can still read a document
 * through an imported helper (the gate-harness module under scripts/lib is
 * the dominant shape — the gate tests read the staged-gate module only
 * through it). Each test's relative imports are resolved one level and the
 * resolved helper's OWN read literals in code — under the helper's own
 * anchoring, via the same edgesFor — are attributed to the importing test.
 * Never recursed: a helper importing a second helper is a chain this pass
 * does not walk.
 *
 * A COMPOSED CALL — `path.resolve`/`path.join` given an anchor and several
 * FURTHER literal arguments, climbing out of the anchor and back down into a
 * nested target instead of naming it in one string — spreads one path across
 * arguments each resolved alone by the passes above. `COMPOSED_CALL` joins
 * the further arguments with "/" into one candidate and routes it to the
 * pass its own anchor owns (mantahostels#2441, which measures its over-inclusion
 * cost).
 *
 * A DIRECTORY-CLASS CALL — the same anchor-plus-literals shape as
 * `COMPOSED_CALL`, but the FINAL argument is a template literal interpolating
 * a variable rather than a further literal — composes no single file, since
 * the variable is only known at test runtime. `DIR_CLASS` treats the literal
 * segments as naming a DIRECTORY instead, and attributes every tracked file
 * under it to the reading test (workflow-core#157). A directory that resolves outside
 * the tree, or that names no tracked file, mints nothing — the same contract
 * `COMPOSED_CALL` holds for a single file.
 *
 * A DIRECTORY LISTING — `fs.readdirSync(<dir>)` with `<dir>` traced through
 * `const` declarations and `path.join` to an anchor, or a `git ls-files`
 * argument list's literal pathspecs, a helper parameter's call-site literals
 * included — attributes what the listing returns (workflow-core#1770). A readdir is one
 * level, narrowed by a `.filter` regex or string test chained onto it — the
 * rule workflow-core#1770 measured and chose. A pathspec is matched as git matches it, `:!` excludes
 * applied.
 *
 * A RULE ID — `readRuleText(id)` builds `docs/agents/rules/<id>.txt` itself, so no
 * literal names the fragment. `ruleEdgesFor` licenses a test that loads
 * `rule-text.js` by any relative specifier to read every quoted literal
 * matching a tracked fragment's id, the lexical choice over tracing which
 * call forwards to `readRuleText`, so an id quoted for another reason is a false
 * edge (workflow-core#1296).
 *
 * THE OWN-MODULE EDGE — `x.test.ts` selects its sibling `x.js` however it
 * loads it: a `require` or `createRequire` load is no edge in vitest's import
 * graph, and no literal for the passes above (workflow-core#1123, workflow-core#1126).
 *
 * A SPAWNED SCRIPT'S DEPENDENCIES — what a read script `require`s or
 * `source`s, transitively — are NOT attributed to the test as a rule
 * (workflow-core#1113, workflow-core#1118). A file that nothing else selects — no direct read, no
 * own-module test, no test reaching it through static ESM imports — keeps the
 * closure's NEAREST readers only, the tests at its shallowest depth (workflow-core#1126).
 * Changing the closure's seed or this test of "nothing else" moves the
 * fallback set. A `source` line written through a directory variable
 * resolves against the sourcing file's own directory, then the repo root; one
 * resolving to no tracked file is returned as a warning, never dropped
 * silently.
 *
 * A SPAWNED SCRIPT'S OWN READS — what `fileReadsOf` finds in its code — join
 * the closure at the script's depth under the same nearest-reader fallback
 * (workflow-core#2093). Giving them to the tests that run the script measured a cost and
 * no gain: every such test workflow-core#2093 checked ran the script in a fixture, so the
 * script read the fixture's copy, never the tracked file.
 *
 * Narrowed, not closed — these shapes still get no edge: a spawned script's
 * dependency that something else selects, which no longer selects a test
 * driving that script end to end (the sweep catches its break), a spawned
 * script's read that something else selects, a two-hop
 * import chain, a
 * directory named through a bare variable rather than an interpolated
 * template literal, a literal run spread across some other call or array
 * rather than `path.resolve`/`path.join`, a `path` call opening on a name
 * declared as a path rather than on an anchor, a template literal carrying
 * more than one interpolation, a rule id read through a helper that loads
 * `rule-text.js` for the test, a file inside a subdirectory a plain readdir
 * returns, a listing's directory reached any way but a `const` or a `path`
 * call, a pathspec reached any way but a literal in the list or at a
 * helper's call site, and a `git ls-files` naming no pathspec — the whole
 * tree, left unattributed.
 *
 * UNSEEN READ SITES — the second output, asked for with `sites` (workflow-core#1881).
 * Every read call, listing and in-repo `git ls-files` in a test whose
 * argument traces to an anchor yet mints no edge is reported by line and
 * shape, so its author can name the path literally or mark the test
 * `full-sweep-only:` in its header, which silences it. A spawned script's dependency and a two-hop chain
 * leave no site in the test and stay review's. Like the edges, a site is an
 * inference: an anchor also roots a fixture the test wrote itself.
 * A name walking a literal array or a listing — a `for … of`, an array
 * callback, an `it.each` table, or a helper parameter its callers pass such a
 * name — stands for what the array holds, a spread, a `new Set` or
 * `Array.from` copy and an object literal's `Object.values` included, its
 * array values only through a `.flat()` (workflow-core#2595),
 * or is judged at the listing when read one level under the directory listed
 * (workflow-core#1886) — never a name assigned or grown after its declaration.
 * Residual (workflow-core#1881): a read inside a template literal's `${}` is never
 * judged, the whole literal reading as text, and an argument standing for
 * more than `MAX_ALTERNATIVES` paths is judged on the first of them only.
 *
 * THE TREE IT SCANS: `readWorkingTree` reads the tracked paths the disk still
 * holds, for this render and for touched-tests.js's lexical edges alike.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execGit, GIT_TIMEOUT_MS } = require("./git.js");
const {
	blankComments,
	closeOf,
	inertSpans,
	topLevelArgs,
} = require("./js-lex.js");
const { requiredGroup } = require("./regex-group.js");
const { byCodeUnit } = require("./by-code-unit.js");
const { JS_TEST_FILE } = require("./test-kind.js");

/** The names a root anchor is spelled with, `hostRoot()` aside. */
const ROOT_NAMES =
	"ROOT|REPO|repoRoot|projectRoot|REPO_ROOT|PROJECT_ROOT|HOST_ROOT";

/** What a `path.resolve`/`path.join` call may open on: either kind of anchor. */
const CALL_ANCHOR = `__dirname|CORE_SCRIPTS|${ROOT_NAMES}|hostRoot\\(\\)`;

/**
 * Tokens a test uses to build a path from the repo ROOT rather than a tempdir.
 *
 * Without `hostRoot()` and `HOST_ROOT` (workflow-core#1), a read built on them — every
 * `path.join(hostRoot(), ".claude", "settings.json")` — is invisible here, and
 * `test:changed` silently stops selecting the tests that read that document.
 */
const ANCHOR = new RegExp(
	`\\b(${ROOT_NAMES})\\b|\\bhostRoot\\(\\)|process\\.cwd\\(\\)|__dirname\\s*,\\s*["']\\.\\.`,
);

/** The anchor whose literals are relative to the test's OWN directory. */
const DIRNAME = /\b__dirname\b|\bCORE_SCRIPTS\b/;

/**
 * Anchors whose literals hang off the FILE's own directory rather than the repo
 * root. `CORE_SCRIPTS` is `__dirname` under another name (workflow-core#1), so it routes
 * the same way.
 */
const DIRNAME_ANCHORS = new Set(["__dirname", "CORE_SCRIPTS"]);

/** Single, double and backtick literals holding something path-shaped. */
const LITERAL = /["'`]([A-Za-z0-9_./-]+)["'`]/g;

/** A `path.resolve`/`path.join` call whose first argument is an anchor and
 * whose remaining arguments compose the rest of the path, e.g. climbing out
 * of `__dirname` with ".." and back down through two more literals. Tied to
 * the call itself, not to any comma-separated literals: an unrelated array
 * joined with "/" outside such a call must not be read as a path (mantahostels#2441). */
const COMPOSED_CALL = new RegExp(
	`\\bpath\\.(?:resolve|join)\\(\\s*(${CALL_ANCHOR})\\s*,\\s*((?:["'\`][A-Za-z0-9_./-]+["'\`]\\s*,\\s*)*["'\`][A-Za-z0-9_./-]+["'\`])\\s*,?\\s*\\)`,
	"g",
);

/** A `path.resolve`/`path.join` call whose anchor is followed by one or more
 * literal segments and then a FINAL argument that is a template literal
 * interpolating a variable, e.g. `` `${id}.txt` ``. The literal segments name
 * a DIRECTORY, not a file. Deliberately NOT extended to a bare identifier
 * final argument (`path.join(ROOT, "scripts", name)`): a bare variable is too
 * often a single chosen file rather than a directory walk for a lexical pass
 * to tell the two apart (workflow-core#157).
 * The literal-segment class excludes the backtick quote that `COMPOSED_CALL`
 * accepts: it is reserved for the final interpolated argument, so a segment
 * written in backticks never gets read twice under two different rules. */
const DIR_CLASS = new RegExp(
	`\\bpath\\.(?:resolve|join)\\(\\s*(${CALL_ANCHOR})\\s*,\\s*((?:["'][A-Za-z0-9_./-]+["']\\s*,\\s*)+)\`[A-Za-z0-9_./-]*\\$\\{[^}\`]+\\}[A-Za-z0-9_./-]*\`\\s*,?\\s*\\)`,
	"g",
);

/** A relative `from`/`require(`/`import(` specifier, one hop's worth. */
const IMPORT = /\b(?:from|require\(|import\()\s*["'`](\.\.?\/[^"'`]+)["'`]/g;

/** The subset vitest's own import graph is certain to follow: static ESM,
 * the bare side-effect `import "./x"` included. */
const ESM_IMPORT =
	/(?:\b(?:from|import\()|^[ \t]*import)\s*["'`](\.\.?\/[^"'`]+)["'`]/gm;

/** A type-only import or re-export, erased before vitest loads the file. */
const TYPE_ONLY = /^[ \t]*(?:import|export)[ \t]+type\b[^;]*;?/gm;

/** Extensions tried, in order, when a specifier names no file suffix. */
const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

/** @param {string} p */
const isTestFile = (p) => JS_TEST_FILE.test(p);

/** The suffixes an own-module edge pairs with `x.test.ts` or `x.spec.ts`. `.ts` is for a
 * module no test imports, the vitest setup file being one. */
const OWN_MODULE_EXTENSIONS = [".js", ".sh", ".cjs", ".mjs", ".ts"];

/**
 * One test's edge scan: what it may read against, and the edges found so far.
 * @typedef {{ tracked: Set<string>, self: string, root: boolean,
 *   sibling: boolean, imported: Set<string>, found: Set<string> }} EdgeScan
 *   `root` and `sibling` are whether the test carries a root anchor and a
 *   directory anchor; `imported` is its static imports, which the sibling and
 *   directory-class passes never take as an edge.
 */

/**
 * Whether `p` may be an edge of the scanned test: never the test itself, and
 * never a module vitest's own graph already reaches from it.
 * @param {EdgeScan} scan
 * @param {string} p
 */
const isCandidate = (scan, p) => p !== scan.self && !scan.imported.has(p);

/**
 * The tracked modules a test is named for: its same-named siblings.
 *
 * @param {string} test
 * @param {Set<string>} tracked
 * @returns {string[]}
 */
function ownModules(test, tracked) {
	const stem = test.replace(JS_TEST_FILE, "");
	return OWN_MODULE_EXTENSIONS.map((e) => stem + e).filter((p) =>
		tracked.has(p),
	);
}

/**
 * Resolves a relative specifier against the importing file's own directory —
 * no `node:path`, so this stays a pure string transform over repo-style `/`.
 *
 * @param {string} fromFile
 * @param {string} spec
 * @returns {string}
 */
function resolveRelative(fromFile, spec) {
	const stack = fromFile.split("/").slice(0, -1);
	for (const part of spec.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") stack.pop();
		else stack.push(part);
	}
	return stack.join("/");
}

/**
 * Resolves a directory-class call's literal segments against a base stack,
 * refusing to climb past it — unlike `resolveRelative`, which a `..` past the
 * top just leaves at the top.
 *
 * @param {string[]} base
 * @param {string} spec
 * @returns {string | null} null when the spec climbs past the base
 */
function resolveDirPath(base, spec) {
	const stack = [...base];
	for (const part of spec.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (stack.length === 0) return null;
			stack.pop();
		} else stack.push(part);
	}
	return stack.join("/");
}

/**
 * @param {string} fromFile
 * @param {string} spec
 * @param {Set<string>} tracked
 * @returns {string | null}
 */
function resolveImport(fromFile, spec, tracked) {
	const base = resolveRelative(fromFile, spec);
	/* A TS-ESM specifier names its own ".js" for a ".ts" source file, so the
	 * bare base is tried again with any extension it already carries stripped
	 * — otherwise "./x.js" over a tracked "x.ts" resolves to nothing. */
	const stripped = base.replace(/\.(?:ts|tsx|js|mjs|cjs)$/, "");
	const candidates = [
		base,
		...EXTENSIONS.map((e) => base + e),
		...EXTENSIONS.map((e) => `${base}/index${e}`),
		...EXTENSIONS.map((e) => stripped + e),
	];
	for (const c of candidates) if (tracked.has(c)) return c;
	return null;
}

/**
 * The tracked helper files a test imports by relative specifier, one hop.
 *
 * @param {string} source
 * @param {string} self
 * @param {Set<string>} tracked
 * @param {RegExp} [re]  ESM_IMPORT only via `vitestImports`, which also drops type-only imports
 * @returns {Set<string>}
 */
function importedHelpers(source, self, tracked, re = IMPORT) {
	const out = new Set();
	for (const m of source.matchAll(re)) {
		const resolved = resolveImport(self, requiredGroup(m, 1, re), tracked);
		if (resolved && resolved !== self) out.add(resolved);
	}
	return out;
}

/**
 * The helpers vitest's own graph follows from a file: static ESM, less the
 * type-only imports it erases before load (workflow-core#1223).
 *
 * @param {string} source
 * @param {string} self
 * @param {Set<string>} tracked
 * @returns {Set<string>}
 */
const vitestImports = (source, self, tracked) =>
	importedHelpers(source.replace(TYPE_ONLY, ""), self, tracked, ESM_IMPORT);

/**
 * @param {string} args  a run of quoted literals
 * @returns {string[]}  each literal's text
 */
const literalsIn = (args) =>
	[...args.matchAll(LITERAL)].map((x) => requiredGroup(x, 1, LITERAL));

/**
 * @param {EdgeScan} scan accumulator: each edge found is added to it
 * @param {string} raw
 * @returns {void}
 */
function addSiblingEdge(scan, raw) {
	const q = resolveRelative(scan.self, raw);
	if (isCandidate(scan, q) && scan.tracked.has(q)) scan.found.add(q);
}

/**
 * One path-shaped literal, read root-relative and sibling-relative as the
 * test's anchors allow.
 * @param {EdgeScan} scan accumulator: each edge found is added to it
 * @param {string} raw
 * @returns {void}
 */
function addLiteralEdges(scan, raw) {
	const p = raw.replace(/^\.\//, "");
	if (scan.root && p !== scan.self && scan.tracked.has(p)) scan.found.add(p);
	if (scan.sibling) addSiblingEdge(scan, p);
}

/**
 * @param {EdgeScan} scan accumulator: each edge found is added to it
 * @param {string} source
 * @returns {void}
 */
function addComposedEdges(scan, source) {
	for (const m of source.matchAll(COMPOSED_CALL)) {
		const pieces = literalsIn(requiredGroup(m, 2, COMPOSED_CALL));
		const joined = pieces.join("/").replace(/^\.\//, "");
		/* Routed by the matched anchor, not tried under both passes: a
		 * dirname-relative candidate like "../docs/x.md" never collides with a
		 * root-relative one, so this cannot mint an edge the wrong pass owns. */
		if (DIRNAME_ANCHORS.has(requiredGroup(m, 1, COMPOSED_CALL))) {
			if (scan.sibling) addSiblingEdge(scan, joined);
		} else if (scan.root && joined !== scan.self && scan.tracked.has(joined)) {
			scan.found.add(joined);
		}
	}
}

/**
 * The directory a `DIR_CLASS` match names, or null where the test lacks its
 * anchor or the path climbs past it.
 * @param {EdgeScan} scan
 * @param {RegExpMatchArray} m
 * @returns {string | null}
 */
function dirClassPath(scan, m) {
	const dirAnchor = DIRNAME_ANCHORS.has(requiredGroup(m, 1, DIR_CLASS));
	if (dirAnchor && !scan.sibling) return null;
	if (!dirAnchor && !scan.root) return null;
	const pieces = literalsIn(requiredGroup(m, 2, DIR_CLASS));
	const joined = pieces.join("/").replace(/^\.\//, "");
	const base = dirAnchor ? scan.self.split("/").slice(0, -1) : [];
	return resolveDirPath(base, joined);
}

/**
 * Every tracked file under each directory a `DIR_CLASS` match in `source`
 * names.
 * @param {EdgeScan} scan accumulator: each edge found is added to it
 * @param {string} source
 * @returns {void}
 */
function addDirClassEdges(scan, source) {
	for (const m of source.matchAll(DIR_CLASS)) {
		const dirPath = dirClassPath(scan, m);
		/* Falsy covers two outcomes on purpose: `null` is an escape past the
		 * tree, `""` is every literal segment cancelling out to the anchor's
		 * own root (e.g. a lone "."). */
		if (!dirPath) continue;
		const prefix = `${dirPath}/`;
		for (const p of scan.tracked)
			if (isCandidate(scan, p) && p.startsWith(prefix)) scan.found.add(p);
	}
}

/** Any plain quoted string, a scoped package's `@` included. */
const QUOTED = /^(["'])([^"'`\n\\]+)\1$/;

/** A JS identifier, unanchored. */
const IDENT_SRC = "[A-Za-z_$][\\w$]*";
const IDENT = new RegExp(`^${IDENT_SRC}$`);
const IDENT_HEAD = new RegExp(`^${IDENT_SRC}`);

/** How many declarations a trace follows before giving up, so a cycle
 * ends — `dirsOf`'s to an anchor, or a collection's to its literals or
 * listing. A guess: the deepest `dirsOf` chain the tests held on
 * 16 Oct 2026 was two; a collection's is unmeasured. */
const TRACE_HOPS = 4;

/** A root-anchor spelling standing alone as an expression. */
const ROOT_NAME = new RegExp(
	`^(?:${ROOT_NAMES}|hostRoot\\(\\)|process\\.cwd\\(\\))$`,
);

/** The quoted literal an argument is, or null where it is anything else. */
const literalArg = (/** @type {string} */ arg) =>
	/^["'`]([A-Za-z0-9_./-]+)["'`]$/.exec(arg)?.[1] ?? null;

/**
 * The repo directories an expression names, traced through `const`
 * declarations in the same source to `__dirname` or a root anchor (workflow-core#1770).
 * @param {EdgeScan} scan
 * @param {string} source
 * @param {string} expr
 * @param {number} [hops]  declarations still to follow
 * @returns {string[]}
 */
function dirsOf(scan, source, expr, hops = TRACE_HOPS) {
	const e = expr.trim();
	if (/^path\.(?:resolve|join)\(/.test(e))
		return joinedDirs(scan, source, e, hops);
	if (DIRNAME_ANCHORS.has(e))
		return scan.sibling ? [scan.self.split("/").slice(0, -1).join("/")] : [];
	if (!IDENT.test(e) && !ROOT_NAME.test(e)) return [];
	const found = hops > 0 ? declaredDirs(scan, source, e, hops - 1) : [];
	if (found.length > 0) return found;
	return ROOT_NAME.test(e) && scan.root ? [""] : [];
}

/**
 * A whole `path.join`/`path.resolve` call's directory: its base traced, then
 * every further argument, each a literal, climbed or descended.
 * @param {EdgeScan} scan
 * @param {string} source
 * @param {string} call
 * @param {number} hops
 * @returns {string[]}
 */
function joinedDirs(scan, source, call, hops) {
	const open = call.indexOf("(");
	if (closeOf(call, open) !== call.length) return [];
	const [base, ...rest] = topLevelArgs(call.slice(open + 1, -1));
	const pieces = rest.map(literalArg);
	if (base === undefined || pieces.includes(null)) return [];
	return dirsOf(scan, source, base, hops).flatMap((d) => {
		const r = resolveDirPath(d ? d.split("/") : [], pieces.join("/"));
		return r === null ? [] : [r];
	});
}

/** A declaration's initialiser this traces: a `path` call or a bare name. */
const INITIALISER = new RegExp(
	`^path\\.(?:resolve|join)\\(|^${IDENT_SRC}(?=\\s*[;,)\\n])`,
);

/**
 * The directories every declaration of `name` in `source` initialises it to,
 * where the initialiser is a whole `path` call or a bare name. Every one
 * counts, so a name shadowed in two scopes reads as both.
 * @param {EdgeScan} scan
 * @param {string} source
 * @param {string} name
 * @param {number} hops
 * @returns {string[]}
 */
function declaredDirs(scan, source, name, hops) {
	const decl = new RegExp(
		`\\b(?:const|let|var)\\s+${escapeRe(name)}\\s*(?::[^=]+)?=\\s*`,
		"g",
	);
	const found = [];
	for (const m of source.matchAll(decl)) {
		const at = (m.index ?? 0) + m[0].length;
		const head = INITIALISER.exec(source.slice(at));
		if (!head) continue;
		const end = head[0].endsWith("(")
			? closeOf(source, at + head[0].length - 1)
			: at + head[0].length;
		if (end > at)
			found.push(...dirsOf(scan, source, source.slice(at, end), hops));
	}
	return found;
}

/** A regex literal tested against a name, optionally negated: its source,
 * flags, and the name it tests. */
const FILTER_RE =
	/(!?)\s*\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])+)\/([dgimsuy]*)\.test\(\s*([\w$.]+)\s*\)/g;

/** A string method tested against a name, optionally negated: the name, the
 * method and its literal. */
const FILTER_STR =
	/(!?)\s*([\w$.]+)\.(endsWith|startsWith|includes)\(\s*["']([^"'\n]*)["']\s*\)/g;

/** A filter body this cannot read as a conjunction of tests: an `||`, a
 * ternary, a negated group, a comparison against a boolean, or a block. */
const UNREAD_FILTER =
	/\|\||\?(?![.?])|!\s*\(|[!=]==?\s*(?:true|false)\b|\b(?:true|false)\s*[!=]==?|\breturn\b|\{/;

/** @type {Record<string, (n: string, lit: string) => boolean>} */
const STRING_TESTS = {
	endsWith: (n, lit) => n.endsWith(lit),
	startsWith: (n, lit) => n.startsWith(lit),
	includes: (n, lit) => n.includes(lit),
};

/**
 * The un-negated tests a filter body holds on the listed name `v` — `v`
 * itself, or a Dirent's `v.name` — or null where a regex does not compile.
 * @param {string} body
 * @param {string} v
 * @returns {((name: string) => boolean)[] | null}
 */
function nameChecks(body, v) {
	const onName = (/** @type {string} */ r) => r === v || r === `${v}.name`;
	const checks = [];
	for (const m of body.matchAll(FILTER_RE)) {
		if (m[1] || !onName(requiredGroup(m, 4, FILTER_RE))) continue;
		try {
			const flags = requiredGroup(m, 3, FILTER_RE).replace(/[gy]/g, "");
			const re = new RegExp(requiredGroup(m, 2, FILTER_RE), flags);
			checks.push((/** @type {string} */ n) => re.test(n));
		} catch {
			return null;
		}
	}
	for (const m of body.matchAll(FILTER_STR)) {
		const test = STRING_TESTS[requiredGroup(m, 3, FILTER_STR)];
		const lit = requiredGroup(m, 4, FILTER_STR);
		if (!m[1] && test && onName(requiredGroup(m, 2, FILTER_STR)))
			checks.push((/** @type {string} */ n) => test(n, lit));
	}
	return checks;
}

/**
 * What a filter body keeps of the names bound to `v`, read lexically: every
 * un-negated regex `.test` and `endsWith`/`startsWith`/`includes` on that
 * name must pass. A negated or unread conjunct is dropped, which only ever
 * widens; a body `UNREAD_FILTER` matches, or one holding no test this reads,
 * narrows nothing.
 * @param {string} body
 * @param {string} v
 * @returns {((name: string) => boolean) | null}  null where nothing narrows
 */
function filterPredicate(body, v) {
	if (UNREAD_FILTER.test(body)) return null;
	const checks = nameChecks(body, v);
	if (!checks || checks.length === 0) return null;
	return (n) => checks.every((c) => c(n));
}

/** An arrow function's single parameter, typed or not, and its body. */
const ARROW = new RegExp(
	`^(?:\\(\\s*(${IDENT_SRC})\\s*(?::[^)]*)?\\)|(${IDENT_SRC}))\\s*=>([\\s\\S]*)$`,
);

/**
 * What the listing ending at `end` keeps: an arrow `.filter(…)` chained
 * straight onto it, past a `.sort()`, or — where the listing is the iterable
 * of a `for (const <loopVar> of …)` — a loop body opening on
 * `if (!<test>) continue;`.
 * @param {string} source
 * @param {number} end
 * @param {string | undefined} loopVar
 * @returns {((name: string) => boolean) | null}
 */
function listingFilter(source, end, loopVar) {
	const chain = /^(?:\s*\.sort\(\))?\s*\.filter\(|^\s*\)\s*\{\s*if\s*\(/.exec(
		source.slice(end),
	);
	if (!chain) return null;
	const open = end + chain[0].length - 1;
	const close = closeOf(source, open);
	if (close === -1) return null;
	const body = source.slice(open + 1, close - 1).trim();
	if (chain[0].endsWith(".filter(")) {
		const arrow = ARROW.exec(body);
		const v = arrow?.[1] ?? arrow?.[2];
		return v ? filterPredicate(arrow?.[3] ?? "", v) : null;
	}
	const skips = /^\s*continue\b/.test(source.slice(close));
	return loopVar && skips && /^!(?!.*(?:&&|\|\||!))/.test(body)
		? filterPredicate(body.slice(1), loopVar)
		: null;
}

/**
 * @param {EdgeScan} scan accumulator: each edge found is added to it
 * @param {string} dir  "" for the root
 * @param {boolean} recursive
 * @param {((name: string) => boolean) | null} keep
 * @returns {void}
 */
function addListedEdges(scan, dir, recursive, keep) {
	const prefix = dir ? `${dir}/` : "";
	for (const p of scan.tracked) {
		if (!p.startsWith(prefix) || !isCandidate(scan, p)) continue;
		const rel = p.slice(prefix.length);
		if (!recursive && rel.includes("/")) continue;
		if (!keep || keep(rel)) scan.found.add(p);
	}
}

/** A `for (const v of ` head running up to a listing call's own name. */
const LOOP_HEAD = new RegExp(
	`for\\s*\\(\\s*(?:const|let|var)\\s+(${IDENT_SRC})\\s+of\\s+[\\w$.]*$`,
);

/**
 * Every tracked file an `fs.readdirSync(<dir>)` lists, where `<dir>` traces to
 * `__dirname` or a root anchor — narrowed by a `.filter` chained onto the
 * call. A plain listing is one level: files in a subdirectory it names are
 * left for whatever reads them (workflow-core#1770).
 * @param {EdgeScan} scan accumulator: each edge found is added to it
 * @param {string} source
 * @returns {void}
 */
function addReaddirEdges(scan, source) {
	for (const m of source.matchAll(/\breaddirSync\(/g)) {
		const open = (m.index ?? 0) + m[0].length - 1;
		const close = closeOf(source, open);
		if (close === -1) continue;
		const [dirArg, opts = ""] = topLevelArgs(source.slice(open + 1, close - 1));
		if (!dirArg) continue;
		const recursive = /\brecursive\s*:\s*true\b/.test(opts);
		const loopVar = LOOP_HEAD.exec(source.slice(0, m.index))?.[1];
		const keep = listingFilter(source, close, loopVar);
		for (const dir of new Set(dirsOf(scan, source, dirArg)))
			addListedEdges(scan, dir, recursive, keep);
	}
}

/** @type {Record<string, string>} */
const GLOB_CHARS = { "*": ".*", "?": "." };

/**
 * Git's own pathspec match, without magic: a glob's `*` crosses `/`, and a
 * plain spec matches itself or anything under it. An exclude's magic prefix
 * is stripped by the caller.
 * @param {string} spec
 * @returns {(p: string) => boolean}
 */
function pathspecMatcher(spec) {
	const s = spec.replace(/^\.\//, "").replace(/\/$/, "");
	if (!/[*?]/.test(s)) return (p) => p === s || p.startsWith(`${s}/`);
	const glob = s
		.split("")
		.map((c) => GLOB_CHARS[c] ?? escapeRe(c))
		.join("");
	const re = new RegExp(`^${glob}(?:/|$)`);
	return (p) => re.test(p);
}

/**
 * The literal pathspecs reaching a `["ls-files", …]` argument list: a quoted
 * element itself, or — where an element is a parameter of the function the
 * list sits in — the literal each call of that function passes in its place,
 * the shape of a `tracked(glob)` helper (workflow-core#1770).
 * @param {string} source
 * @param {string[]} elements
 * @returns {string[]}
 */
function pathspecsOf(source, elements) {
	const specs = [];
	for (const el of elements) {
		const lit = PATHSPEC.exec(el)?.[1];
		if (lit !== undefined) {
			if (!lit.startsWith("-") && lit !== "ls-files") specs.push(lit);
		} else if (IDENT.test(el)) specs.push(...argsFor(source, el));
	}
	return specs;
}

/** A quoted pathspec, an exclude's `:!`, `:^` or `:(exclude)` included. */
const PATHSPEC = /^["'`]((?::!|:\^|:\(exclude\))?[A-Za-z0-9_./*?-]+)["'`]$/;

/** The magic prefix marking a pathspec as an exclude. */
const EXCLUDE = /^:(?:!|\^|\(exclude\))/;

/** A function header: `function f(` or `const f = (`, async or not. */
const FUNCTION_HEAD = new RegExp(
	`\\b(?:function\\s+(${IDENT_SRC})\\s*|(?:const|let)\\s+(${IDENT_SRC})\\s*=\\s*(?:async\\s*)?)\\(`,
	"g",
);

/**
 * Where parameter `param` sits in a function header's list opening at
 * `open`, or -1.
 * @param {string} source
 * @param {number} open
 * @param {string} param
 * @returns {number}
 */
function paramIndex(source, open, param) {
	return paramsOf(source, open).findIndex(
		(p) => IDENT_HEAD.exec(p.replace(/^\.\.\.\s*/, ""))?.[0] === param,
	);
}

/**
 * A function header's parameters, as written, from the list opening at
 * `open`.
 * @param {string} source
 * @param {number} open
 * @returns {string[]}
 */
function paramsOf(source, open) {
	const close = closeOf(source, open);
	return close === -1 ? [] : topLevelArgs(source.slice(open + 1, close - 1));
}

/**
 * Every call of `name` — where its argument list opens, and the list — the
 * declaration's own at `declared` aside.
 * @param {string} source
 * @param {string} name
 * @param {number} declared
 * @returns {{ at: number, args: string[] }[]}
 */
function callArgs(source, name, declared) {
	const out = [];
	const call = new RegExp(`(?<![\\w$.])${escapeRe(name)}\\(`, "g");
	for (const c of source.matchAll(call)) {
		const open = (c.index ?? 0) + c[0].length - 1;
		const close = open === declared ? -1 : closeOf(source, open);
		if (close !== -1)
			out.push({
				at: open,
				args: topLevelArgs(source.slice(open + 1, close - 1)),
			});
	}
	return out;
}

/**
 * The pathspec literal each call of `name` passes as its `at`-th argument.
 * @param {string} source
 * @param {string} name
 * @param {number} at
 * @param {number} declared
 * @returns {string[]}
 */
const callLiterals = (source, name, at, declared) =>
	callArgs(source, name, declared).flatMap(({ args }) => {
		const lit = PATHSPEC.exec(args[at] ?? "")?.[1];
		return lit === undefined ? [] : [lit];
	});

/**
 * The literal each call passes for parameter `param` of any function in
 * `source` that declares it.
 * @param {string} source
 * @param {string} param
 * @returns {string[]}
 */
function argsFor(source, param) {
	const out = [];
	for (const h of source.matchAll(FUNCTION_HEAD)) {
		const name = h[1] ?? h[2];
		const open = (h.index ?? 0) + h[0].length - 1;
		const at = name ? paramIndex(source, open, param) : -1;
		if (name && at !== -1) out.push(...callLiterals(source, name, at, open));
	}
	return out;
}

/**
 * Every tracked file a `git ls-files <pathspec>` lists, the pathspec read as
 * root-relative — the `cwd` such a call runs in is never read, so the root
 * anchor licenses it (workflow-core#1770).
 * @param {EdgeScan} scan accumulator: each edge found is added to it
 * @param {string} source
 * @returns {void}
 */
function addLsFilesEdges(scan, source) {
	if (!scan.root) return;
	for (const m of source.matchAll(/\[\s*["']ls-files["']/g)) {
		const open = m.index ?? 0;
		const close = closeOf(source, open);
		if (close === -1) continue;
		const specs = pathspecsOf(
			source,
			topLevelArgs(source.slice(open + 1, close - 1)),
		);
		const matchers = (/** @type {boolean} */ exclude) =>
			specs
				.filter((s) => EXCLUDE.test(s) === exclude)
				.map((s) => pathspecMatcher(s.replace(EXCLUDE, "")));
		const included = matchers(false);
		const excluded = matchers(true);
		for (const p of scan.tracked)
			if (
				isCandidate(scan, p) &&
				included.some((t) => t(p)) &&
				!excluded.some((t) => t(p))
			)
				scan.found.add(p);
	}
}

/**
 * @param {string} source        the test file's text
 * @param {Set<string>} tracked  every path `git ls-files` reports
 * @param {string} self          the test file's own repo path, never its own edge
 * @returns {string[]} tracked paths this test reads from the repo tree
 */
function edgesFor(source, tracked, self) {
	const root = ANCHOR.test(source);
	const sibling = DIRNAME.test(source);
	if (!root && !sibling) return [];
	/* An import specifier is a path-shaped literal too, so the sibling pass
	 * would mint an edge for every relative import — the one edge vitest
	 * already has, at the cost of a much wider filtered run (mantahostels#2433). STATIC ESM
	 * ONLY: a runtime `require()` is a call vitest's graph need not follow, so
	 * excluding on one would drop an edge nothing else supplies. */
	const imported = sibling ? vitestImports(source, self, tracked) : new Set();
	/** @type {EdgeScan} */
	const scan = { tracked, self, root, sibling, imported, found: new Set() };
	for (const p of literalsIn(source)) addLiteralEdges(scan, p);
	addComposedEdges(scan, source);
	addDirClassEdges(scan, source);
	addReaddirEdges(scan, source);
	addLsFilesEdges(scan, source);
	return [...scan.found].sort();
}

const RULE_TEXT_MODULE = "scripts/lib/rule-text.js";

const RULES_DIR = "docs/agents/rules/";

/** Any relative specifier, `createRequire(__filename)("./lib/rule-text")`
 * included, which `IMPORT` does not see. */
const SPECIFIER = /["'`](\.\.?\/[^"'`]+)["'`]/g;

/** A quoted rule id, with or without the `rule:` prefix `readRuleText` strips. */
const RULE_ID = /["'`](?:rule:)?([a-z0-9][a-z0-9-]*)["'`]/g;

/**
 * The rule fragments a test reads through `readRuleText(id)`, which builds the
 * path itself, so no literal names it (workflow-core#1296).
 *
 * @param {string} source
 * @param {Set<string>} tracked
 * @param {string} self
 * @returns {string[]}
 */
function ruleEdgesFor(source, tracked, self) {
	const loads = [...source.matchAll(SPECIFIER)].some(
		(m) =>
			resolveImport(self, requiredGroup(m, 1, SPECIFIER), tracked) ===
			RULE_TEXT_MODULE,
	);
	if (!loads) return [];
	const found = new Set();
	for (const m of source.matchAll(RULE_ID)) {
		const p = `${RULES_DIR}${m[1]}.txt`;
		if (tracked.has(p)) found.add(p);
	}
	return [...found].sort();
}

const NODE_SCRIPT = /\.[mc]?js$/;

/** A script whose runtime dependencies the closure follows: node or shell. */
const isScript = (/** @type {string} */ p) =>
	NODE_SCRIPT.test(p) || /\.sh$/.test(p) || /^\.husky\/[^/.]+$/.test(p);

/** A `source`/`.` line, argument captured to the end of the line. */
const SOURCE_LINE = /^[ \t]*(?:source|\.)[ \t]+(\S.*)$/gm;

/**
 * A source argument's path: an optional directory-variable prefix, then a
 * literal tail. The `BASH_SOURCE`/`$0` spellings are the file's own directory;
 * any other variable is tried against that directory, then the root.
 */
const SOURCE_ARG =
	/^["']?(?<dirVar>\$\(dirname\s+"?\$(?:\{BASH_SOURCE\[0\]\}|BASH_SOURCE|0)"?\)|\$\{BASH_SOURCE\[0\]%\/\*\}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)?(?<tail>\/?[A-Za-z0-9_./-]+)["']?(?:\s|;|$)/;

/**
 * Where a `source`/`.` argument may point: the file's own directory first,
 * then the root where the prefix is a variable that need not be the file's
 * directory.
 * @param {string} sourced  the argument, to the end of the line
 * @param {string[]} dir  the sourcing file's directory
 * @returns {{ tail: string, candidates: (string | null)[] }}  `tail` is the
 *   argument's literal path, "" where it has none
 */
function sourceCandidates(sourced, dir) {
	const arg = SOURCE_ARG.exec(sourced);
	const argTail = arg?.groups?.tail;
	if (arg && argTail === undefined)
		throw new Error(`SOURCE_ARG matched ${sourced} with no tail group`);
	const tail = argTail === undefined ? "" : argTail.replace(/^\//, "");
	/** @type {(string | null)[]} */
	const candidates = [];
	if (arg) {
		candidates.push(resolveDirPath(dir, tail));
		if (!/^\$(?:\(|\{BASH_SOURCE)/.test(arg.groups?.dirVar ?? ""))
			candidates.push(resolveDirPath([], tail));
	}
	return { tail, candidates };
}

/**
 * Whether a source line that resolves to no tracked file owes no warning.
 * @param {string} source  the script's text
 * @param {number | undefined} at  where the line's match starts
 * @param {string} tail  the argument's literal path
 * @returns {boolean}
 */
function isExcusedSource(source, at, tail) {
	/* A "." opening a continuation line or an array element is an argument. */
	if (/[\\(]$/.test(source.slice(0, at).trimEnd())) return true;
	/* An optional source — guarded by a `-f` test of its path — may be
	 * absent (workflow-core#657). Lexical: a `[ -f` of that path anywhere in the file
	 * silences it, whether or not it guards this line. */
	const bare = escapeRe(tail.replace(/^\.\//, ""));
	const guard = `(?:\\[|\\btest)\\s+-f\\s+["']?(?:\\./)?${bare}["']?\\s`;
	return !!tail && new RegExp(guard).test(source);
}

/**
 * The tracked files a script loads at runtime, one level: relative
 * `require`/`import` for node, `source`/`.` for shell.
 *
 * @param {string} file
 * @param {string} source
 * @param {Set<string>} tracked
 * @returns {{ deps: string[], warnings: string[] }}
 */
function scriptDeps(file, source, tracked) {
	if (NODE_SCRIPT.test(file))
		return { deps: [...importedHelpers(source, file, tracked)], warnings: [] };
	const deps = [];
	const warnings = [];
	const dir = file.split("/").slice(0, -1);
	for (const m of source.matchAll(SOURCE_LINE)) {
		const sourced = requiredGroup(m, 1, SOURCE_LINE);
		const { tail, candidates } = sourceCandidates(sourced, dir);
		const hit = candidates.find((c) => c && tracked.has(c));
		if (hit) {
			deps.push(hit);
			continue;
		}
		if (isExcusedSource(source, m.index, tail)) continue;
		warnings.push(
			`${file}: source ${sourced.trim()} resolves to no tracked file`,
		);
	}
	return { deps, warnings };
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SHAPE = {
	variable: (/** @type {string} */ name) =>
		`a path segment held in \`${name}\``,
	template: "a template literal with an interpolation it cannot resolve",
	spread: "a spread argument",
	computed: "a computed path argument",
	otherCall: "a path run spread across an array `join` or `+`",
	composed: "a path composed through a declared name",
	listing: "a listing whose directory it cannot trace",
	pathspec: "a `git ls-files` pathspec that is not a literal",
	wholeTree: "a `git ls-files` naming no pathspec, the whole tree",
};

/**
 * One read the selector cannot attribute: its 1-based line, and its shape.
 * @typedef {{ line: number, shape: string }} Site
 */

/**
 * What an argument resolves to: a repo path ("" the root), or an anchored
 * argument whose shape gets no edge.
 * @typedef {{ path: string } | { unseen: string }} Resolution
 */

/**
 * One test's site scan.
 * @typedef {{ source: string, spans: [number, number][], dir: string,
 *   tracked: Set<string>, seen: (p: string) => boolean, site: number,
 *   decls: Map<string, string[]> }} SiteScan
 *   `spans` are its strings and comments, `dir` its own directory, `seen`
 *   what the selector reaches from it already, `site` where the read being
 *   judged sits, and `decls` an accumulator: each name's initialisers, once
 *   found, shared by every read in the test.
 */

/** An expression opening as a `path.resolve`/`path.join` call. */
const PATH_CALL = /^path\.(?:resolve|join)\(/;

const READ_CALL = /\b(readFileSync|readFile|readdirSync|readdir)\(/g;

const READ_OR_LIST = new RegExp(`${READ_CALL.source}|["']ls-files["']`);

const FULL_SWEEP_ONLY = /^[\s/*]*full-sweep-only:/m;

/** How many paths one argument may stand for before the rest are dropped.
 * A guess: the most any test held on 17 Oct 2026 was a handful. */
const MAX_ALTERNATIVES = 256;

/** `DIR_CLASS` over a whole call, which the extractor attributes. */
const DIR_CLASS_CALL = new RegExp(`^${DIR_CLASS.source}$`);

/** @param {[number, number][]} spans @param {number} i */
function isCode(spans, i) {
	let lo = 0;
	let hi = spans.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const [first, last] = /** @type {[number, number]} */ (spans[mid]);
		if (i < first) hi = mid - 1;
		else if (i > last) lo = mid + 1;
		else return false;
	}
	return true;
}

/**
 * @param {string} source
 * @param {[number, number][]} spans
 */
function headerOf(source, spans) {
	let i = 0;
	for (const [first, last] of spans) {
		while (/\s/.test(source.charAt(i))) i++;
		if (first !== i || source.charAt(i) !== "/") break;
		i = last + 1;
	}
	return source.slice(0, i);
}

/**
 * The initialiser of every declaration of `name` in code: the text of a
 * whole `path` call or array, a quoted literal, or a bare name — and "" for
 * anything else, so an untraceable declaration still counts as one.
 * @param {SiteScan} scan
 * @param {string} name
 * @returns {string[]}
 */
function declInits(scan, name) {
	const known = scan.decls.get(name);
	if (known) return known;
	const decl = new RegExp(
		`\\b(?:const|let|var)\\s+${escapeRe(name)}\\s*(?::[^=;\\n]+)?=\\s*`,
		"g",
	);
	const out = [];
	for (const m of scan.source.matchAll(decl)) {
		if (!isCode(scan.spans, m.index ?? 0)) continue;
		const at = (m.index ?? 0) + m[0].length;
		const rest = scan.source.slice(at);
		const head = PATH_CALL.exec(rest) ?? /^\[/.exec(rest);
		const quoted = /^(["'`])[^"'`\n]*\1/.exec(rest);
		const bare = new RegExp(
			`^(?:${IDENT_SRC}|hostRoot\\(\\)|process\\.cwd\\(\\))(?=\\s*[;,)\\n])`,
		).exec(rest);
		if (head) {
			const end = closeOf(scan.source, at + head[0].length - 1);
			out.push(end === -1 ? "" : scan.source.slice(at, end));
		} else out.push(quoted?.[0] ?? bare?.[0] ?? "");
	}
	scan.decls.set(name, out);
	return out;
}

/**
 * What a name walking a collection takes: the literals of a literal array,
 * or the files a listing returns, as the directories it lists (workflow-core#1886).
 * @typedef {{ lits: string[] } | { listed: string[] }} Elements
 */

/** Calls that keep a collection's elements, each a subset of the last. */
const KEEPS_ELEMENTS = /^\.\s*(?:filter|sort|toSorted|slice|reverse)\(/;

/** A `withFileTypes` listing's entries mapped back to their names. */
const DIRENT_NAMES = /^\.\s*map\(\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*\1\.name\s*\)/;

/** A git call returning `ls-files` output, the list opening its arguments. */
const LS_FILES_CALL =
	/^(?:execFileSync|spawnSync)\(\s*["']git["']\s*,\s*\[\s*["']ls-files["']/;

/** A call whose callback's first parameter walks the receiver's elements. */
const WALKS = "filter|map|flatMap|find|findIndex|some|every|forEach";

/**
 * Where the bracket closing at `close` opens, walking back over code.
 * @param {SiteScan} scan
 * @param {number} close
 */
function openOf(scan, close) {
	let depth = 0;
	for (let i = close; i >= 0; i--) {
		if (!isCode(scan.spans, i)) continue;
		const c = scan.source.charAt(i);
		if (")]}".includes(c)) depth++;
		else if ("([{".includes(c) && --depth === 0) return i;
	}
	return -1;
}

/**
 * The method chain a call at `dot` is made on — `fs.readdirSync(D).filter(…)`
 * for the `.map` after it — or null where a link is not a name, a call or a
 * literal array.
 * @param {SiteScan} scan
 * @param {number} dot
 */
function receiverOf(scan, dot) {
	const src = scan.source;
	let at = dot;
	for (;;) {
		const head = linkStart(scan, lastNonSpace(src, at - 1));
		if (head === -1) return null;
		const k = lastNonSpace(src, head - 1);
		if (src.charAt(k) !== "." || src.slice(k - 2, k + 1) === "...")
			return src.slice(head, dot).trim();
		at = k;
	}
}

/**
 * @param {string} src
 * @param {number} i
 */
function lastNonSpace(src, i) {
	let j = i;
	while (j >= 0 && /\s/.test(src.charAt(j))) j--;
	return j;
}

/**
 * Where the chain link ending at `end` starts — a name, a call or a literal
 * array — or -1 for anything else.
 * @param {SiteScan} scan
 * @param {number} end
 */
function linkStart(scan, end) {
	let j = end;
	let head = -1;
	if (")]".includes(scan.source.charAt(j))) {
		head = openOf(scan, j);
		if (head === -1) return -1;
		j = head - 1;
	}
	const ident = /[\w$]+$/.exec(scan.source.slice(0, j + 1));
	return ident ? ident.index : head;
}

/**
 * Each initialiser of `name` in code, whole, up to its statement's `;`.
 * @param {SiteScan} scan
 * @param {string} name
 * @returns {string[]}
 */
function declExprs(scan, name) {
	const decl = new RegExp(
		`\\b(?:const|let|var)\\s+${escapeRe(name)}\\s*(?::[^=;\\n]+)?=\\s*`,
		"g",
	);
	const out = [];
	for (const m of scan.source.matchAll(decl)) {
		if (!isCode(scan.spans, m.index ?? 0)) continue;
		const at = (m.index ?? 0) + m[0].length;
		out.push(scan.source.slice(at, statementEnd(scan, at)).trim());
	}
	return out;
}

/**
 * Whether `name`, or a member of it, is assigned or grown anywhere but its
 * declaration, so its initialiser no longer says what it holds.
 * @param {SiteScan} scan
 * @param {string} name
 */
function isChangedAfter(scan, name) {
	const n = escapeRe(name);
	const member = "(?:\\s*(?:\\.\\s*[\\w$]+|\\[[^\\]]*\\]))*";
	const change = new RegExp(
		`(?<![\\w$.]|(?:const|let|var)\\s+)${n}${member}\\s*(?:[-+*/|&?]{0,3}=(?![=>])|\\.\\s*(?:push|unshift|splice|fill|copyWithin|add)\\()|Object\\s*\\.\\s*assign\\(\\s*${n}\\b`,
		"g",
	);
	for (const m of scan.source.matchAll(change))
		if (isCode(scan.spans, m.index ?? 0)) return true;
	return false;
}

/**
 * Where the statement running from `at` ends: its `;`, brackets skipped.
 * @param {SiteScan} scan
 * @param {number} at
 */
function statementEnd(scan, at) {
	let end = at;
	while (end < scan.source.length) {
		const c = scan.source.charAt(end);
		if (!isCode(scan.spans, end)) end++;
		else if ("([{".includes(c)) {
			const close = closeOf(scan.source, end);
			if (close === -1) break;
			end = close;
		} else if (c === ";") break;
		else end++;
	}
	return end;
}

/**
 * The elements a collection expression holds: a literal array, a listing, or
 * a name declared as either, through calls that keep its elements; null for
 * anything else.
 * @param {SiteScan} scan
 * @param {string} expr
 * @param {number} hops
 * @returns {Elements | null}
 */
function elementsOfExpr(scan, expr, hops) {
	const e = expr.trim();
	const head = /^(?:fs\s*\.\s*)?readdirSync\(/.exec(e) ?? LS_FILES_CALL.exec(e);
	let found = null;
	const wrap = WRAPS_ELEMENTS.exec(e);
	if (head) found = listingHead(scan, e, head[0].includes("ls-files"));
	else if (e.startsWith("[")) found = arrayHead(scan, e, hops);
	else if (wrap) found = wrappedHead(scan, e, wrap, hops);
	else found = declaredHead(scan, e, hops);
	if (!found) return null;
	return isElementKeeping(found.rest, found.held) ? found.held : null;
}

/**
 * A listing call opening `e`: the directories it lists, and what follows it.
 * @param {SiteScan} scan
 * @param {string} e
 * @param {boolean} listsFiles  a `git ls-files` call, not a readdir
 * @returns {{ held: Elements, rest: string } | null}
 */
function listingHead(scan, e, listsFiles) {
	const open = e.indexOf("(");
	const close = closeOf(e, open);
	if (close === -1) return null;
	const args = topLevelArgs(e.slice(open + 1, close - 1));
	/* `ls-files` names root-relative paths wherever it runs in the repo. */
	const cwd = listsFiles ? optionCwd(args[2] ?? "") : (args[0] ?? "");
	const reached = cwd === null ? [{ path: "" }] : resolveExpr(scan, cwd);
	const dirs = reached.flatMap((r) => ("path" in r ? [r.path] : []));
	if (dirs.length === 0) return null;
	if (!listsFiles) return { held: { listed: dirs }, rest: e.slice(close) };
	const out = e
		.slice(close)
		.replace(/^\s*\.\s*stdout\b/, "")
		.replace(/^\s*\.\s*trim\(\)/, "");
	const split = /^\s*\.\s*split\(/.exec(out);
	if (!split) return null;
	const end = closeOf(out, split[0].length - 1);
	return end === -1 ? null : { held: { listed: [""] }, rest: out.slice(end) };
}

/**
 * A literal array opening `e`: its literals, and what follows it.
 * @param {SiteScan} scan
 * @param {string} e
 * @param {number} hops
 * @returns {{ held: Elements, rest: string } | null}
 */
function arrayHead(scan, e, hops) {
	const close = closeOf(e, 0);
	const lits =
		close === -1 ? null : arrayElements(scan, e.slice(0, close), hops);
	return lits && { held: { lits }, rest: e.slice(close) };
}

/**
 * The literals a literal array `text` holds, a spread of a collection of
 * literals included; null where any element is anything else.
 * @param {SiteScan} scan
 * @param {string} text
 * @param {number} hops
 * @returns {string[] | null}
 */
function arrayElements(scan, text, hops) {
	if (!text.startsWith("[") || closeOf(text, 0) !== text.length) return null;
	const lits = [];
	for (const el of topLevelArgs(text.slice(1, -1))) {
		const lit = literalArg(el);
		const spread = el.startsWith("...")
			? elementsOfExpr(scan, el.slice(3), hops)
			: null;
		if (lit !== null) lits.push(lit);
		else if (spread && "lits" in spread) lits.push(...spread.lits);
		else return null;
	}
	return lits;
}

const WRAPS_ELEMENTS =
	/^(?:(?<copy>new\s+Set|Array\s*\.\s*from)|Object\s*\.\s*values)\(/;

/**
 * A call `WRAPS_ELEMENTS` names opening `e`: what its argument holds — for
 * `Object.values`, an object literal's literal values, flattened by a
 * `.flat()` where any is a literal array — and what follows it.
 * @param {SiteScan} scan
 * @param {string} e
 * @param {RegExpExecArray} call  the `WRAPS_ELEMENTS` match
 * @param {number} hops
 * @returns {{ held: Elements, rest: string } | null}
 */
function wrappedHead(scan, e, call, hops) {
	const close = closeOf(e, call[0].length - 1);
	if (close === -1) return null;
	const arg = e.slice(call[0].length, close - 1).trim();
	const rest = e.slice(close);
	if (call.groups?.copy) {
		const held = elementsOfExpr(scan, arg, hops);
		return held && { held, rest };
	}
	const vals = objectValues(scan, arg, hops);
	if (!vals) return null;
	if (!vals.nested) return { held: { lits: vals.lits }, rest };
	const flat = /^\s*\.\s*flat\(\s*\)/.exec(rest);
	return (
		flat && { held: { lits: vals.lits }, rest: rest.slice(flat[0].length) }
	);
}

/**
 * @typedef {{ lits: string[], nested: boolean }} ObjectValues
 *   `nested` where any value is a literal array
 */

/**
 * The values of an object literal, or of a name every declaration of which
 * is one, where each is a literal or a literal array; null otherwise.
 * @param {SiteScan} scan
 * @param {string} expr
 * @param {number} hops
 * @returns {ObjectValues | null}
 */
function objectValues(scan, expr, hops) {
	if (!IDENT.test(expr)) return objectLiteralValues(scan, expr, hops);
	const inits = declaredAs(scan, expr, hops, objectValues);
	if (!inits || inits.length === 0 || inits.includes(null)) return null;
	const all = /** @type {ObjectValues[]} */ (inits);
	return {
		lits: all.flatMap((v) => v.lits),
		nested: all.some((v) => v.nested),
	};
}

/**
 * @param {SiteScan} scan
 * @param {string} expr
 * @param {number} hops
 * @returns {ObjectValues | null}
 */
function objectLiteralValues(scan, expr, hops) {
	if (!expr.startsWith("{") || closeOf(expr, 0) !== expr.length) return null;
	const out = { lits: /** @type {string[]} */ ([]), nested: false };
	for (const entry of topLevelArgs(expr.slice(1, -1))) {
		const key = /^(?:"[^"]*"|'[^']*'|[\w$]+)\s*:\s*/.exec(entry);
		if (!key) return null;
		const value = entry.slice(key[0].length);
		const lit = literalArg(value);
		const arr = lit === null ? arrayElements(scan, value, hops) : null;
		if (lit !== null) out.lits.push(lit);
		else if (arr) {
			out.lits.push(...arr);
			out.nested = true;
		} else return null;
	}
	return out;
}

/**
 * Each declaration of `name` read by `read`, or null where `name` is changed
 * after its declaration or no hops remain.
 * @template T
 * @param {SiteScan} scan
 * @param {string} name
 * @param {number} hops
 * @param {(scan: SiteScan, init: string, hops: number) => T} read
 * @returns {T[] | null}
 */
function declaredAs(scan, name, hops, read) {
	if (hops <= 0 || isChangedAfter(scan, name)) return null;
	return declExprs(scan, name).map((i) => read(scan, i, hops - 1));
}

/**
 * A name opening `e`, declared as a collection: what every declaration
 * holds, all of one kind, and what follows the name.
 * @param {SiteScan} scan
 * @param {string} e
 * @param {number} hops
 * @returns {{ held: Elements, rest: string } | null}
 */
function declaredHead(scan, e, hops) {
	const ident = IDENT_HEAD.exec(e)?.[0];
	if (!ident) return null;
	const inits = declaredAs(scan, ident, hops, elementsOfExpr);
	const held = inits && mergeElements(inits);
	return held && { held, rest: e.slice(ident.length) };
}

/**
 * Several collections as one, where every one is there and all are of one
 * kind; null otherwise.
 * @param {(Elements | null)[]} parts
 * @returns {Elements | null}
 */
function mergeElements(parts) {
	if (parts.length === 0 || parts.includes(null)) return null;
	const all = /** @type {Elements[]} */ (parts);
	if (all.every((p) => "lits" in p))
		return { lits: all.flatMap((p) => ("lits" in p ? p.lits : [])) };
	if (all.every((p) => "listed" in p))
		return { listed: all.flatMap((p) => ("listed" in p ? p.listed : [])) };
	return null;
}

/**
 * Whether every call in `rest` keeps the collection's elements.
 * @param {string} rest
 * @param {Elements} held
 */
function isElementKeeping(rest, held) {
	let t = rest.trimStart();
	while (t) {
		const names = "listed" in held ? DIRENT_NAMES.exec(t) : null;
		const keep = names ? null : KEEPS_ELEMENTS.exec(t);
		if (!names && !keep) return false;
		const end = names
			? names[0].length
			: closeOf(t, /** @type {RegExpExecArray} */ (keep)[0].length - 1);
		if (end === -1) return false;
		t = t.slice(end).trimStart();
	}
	return true;
}

/**
 * The bindings of `name` to a collection's elements: a `for … of` walking it,
 * a callback a walking call passes it to as its first parameter, or an
 * `it.each`/`describe.each` table — each as the collection's text and the
 * span the binding holds over.
 * @param {SiteScan} scan
 * @param {string} name
 * @returns {Binding[]}
 */
function elementBindings(scan, name) {
	const n = escapeRe(name);
	const param = `(?:async\\s+)?(?:\\(\\s*${n}\\s*(?::[^,)=]+)?(?:,[^)]*)?\\)(?:\\s*:[^=()]*?)?|${n})\\s*=>`;
	return [
		...loopBindings(scan, n),
		...callbackBindings(scan, param),
		...eachBindings(scan, param),
	];
}

/**
 * @typedef {{ collection: string, from: number, to: number }} Binding
 */

/**
 * Each `for … of` binding the escaped name `n`, over the loop's body.
 * @param {SiteScan} scan
 * @param {string} n
 * @returns {Binding[]}
 */
function loopBindings(scan, n) {
	const src = scan.source;
	const out = [];
	const loop = new RegExp(
		`\\bfor\\s*\\(\\s*(?:const|let|var)\\s+${n}\\s+of\\s+`,
		"g",
	);
	for (const m of src.matchAll(loop)) {
		const from = m.index ?? 0;
		const close = closeOf(src, src.indexOf("(", from));
		if (close === -1 || !isCode(scan.spans, from)) continue;
		const body = close + (/^\s*/.exec(src.slice(close))?.[0].length ?? 0);
		const to =
			src.charAt(body) === "{" ? closeOf(src, body) : statementEnd(scan, body);
		out.push({
			collection: src.slice(from + m[0].length, close - 1),
			from,
			to,
		});
	}
	return out;
}

/**
 * Each walking call passing the name to its callback, over the call.
 * @param {SiteScan} scan
 * @param {string} param  the callback's head, binding the name first
 * @returns {Binding[]}
 */
function callbackBindings(scan, param) {
	const src = scan.source;
	const out = [];
	for (const m of src.matchAll(
		new RegExp(`\\.\\s*(?:${WALKS})\\(\\s*${param}`, "g"),
	)) {
		const dot = m.index ?? 0;
		const open = src.indexOf("(", dot);
		const collection = isCode(scan.spans, dot) ? receiverOf(scan, dot) : null;
		if (collection)
			out.push({ collection, from: open, to: closeOf(src, open) });
	}
	return out;
}

/**
 * Each `it.each`/`test.each`/`describe.each` table whose callback binds the
 * name first, over the callback's call.
 * @param {SiteScan} scan
 * @param {string} param
 * @returns {Binding[]}
 */
function eachBindings(scan, param) {
	const src = scan.source;
	const out = [];
	for (const m of src.matchAll(/\b(?:it|test|describe)\.each\(/g)) {
		const open = (m.index ?? 0) + m[0].length - 1;
		const close = closeOf(src, open);
		const call = close === -1 ? null : /^\s*\(/.exec(src.slice(close));
		if (!call || !isCode(scan.spans, open)) continue;
		const from = close + call[0].length - 1;
		const to = closeOf(src, from);
		const [, cb] = topLevelArgs(src.slice(from + 1, to - 1));
		if (cb && new RegExp(`^${param}`).test(cb))
			out.push({ collection: src.slice(open + 1, close - 1), from, to });
	}
	return out;
}

/**
 * What a name walking a collection takes at the site: the binding nearest
 * above it, of those holding over it; null where none traces.
 * @param {SiteScan} scan
 * @param {string} name
 * @returns {Elements | null}
 */
function boundElements(scan, name) {
	const near = elementBindings(scan, name)
		.filter((b) => b.from < scan.site && scan.site < b.to)
		.sort((a, b) => b.from - a.from)[0];
	return near ? elementsOfExpr(scan, near.collection, TRACE_HOPS) : null;
}

/**
 * What a parameter of the nearest function above the site takes, where
 * every call passes literals — a rest parameter's run of them joined with
 * "/" — or a name walking a collection; null otherwise.
 * @param {SiteScan} scan
 * @param {string} name
 * @returns {Elements | null}
 */
function paramValues(scan, name) {
	const nearest = nearestDeclaring(scan, name);
	if (!nearest) return null;
	const { fn, open, at } = nearest;
	const rest = paramsOf(scan.source, open)[at]?.startsWith("...") ?? false;
	const passed = callArgs(scan.source, fn, open).map((call) =>
		passedValue(scan, call, at, rest),
	);
	return mergeElements(passed);
}

/**
 * What one call passes for the parameter at `at`: its literals — a rest
 * parameter's run joined with "/" — or what a name it passes walks.
 * @param {SiteScan} scan
 * @param {{ at: number, args: string[] }} call
 * @param {number} at
 * @param {boolean} rest
 * @returns {Elements | null}
 */
function passedValue(scan, call, at, rest) {
	const passed = call.args.slice(at, rest ? undefined : at + 1);
	const run = passed.map(literalArg);
	if (run.length > 0 && !run.includes(null)) return { lits: [run.join("/")] };
	const [only] = passed;
	if (passed.length !== 1 || !only || !IDENT.test(only)) return null;
	return boundElements({ ...scan, site: call.at }, only);
}

/**
 * The last named function above the site whose parameters include `name`:
 * its name, where its list opens, and the parameter's position.
 * @param {SiteScan} scan
 * @param {string} name
 * @returns {{ fn: string, open: number, at: number } | undefined}
 */
function nearestDeclaring(scan, name) {
	let nearest;
	for (const h of scan.source.matchAll(FUNCTION_HEAD)) {
		const fn = h[1] ?? h[2];
		const open = (h.index ?? 0) + h[0].length - 1;
		if (open > scan.site) break;
		const at = fn ? paramIndex(scan.source, open, name) : -1;
		if (fn && at !== -1) nearest = { fn, open, at };
	}
	return nearest;
}

/**
 * What a name stands for at the site: the elements it walks, or the literals
 * every call passes for it as a parameter.
 * @param {SiteScan} scan
 * @param {string} name
 * @returns {Elements | null}
 */
function boundValues(scan, name) {
	const walked = boundElements(scan, name);
	if (walked) return walked;
	return paramValues(scan, name);
}

/**
 * The segment a name's initialiser spells: a literal, or a `path` call over
 * literals alone; null for anything else.
 * @param {string} init
 * @returns {string | null}
 */
function initSegment(init) {
	const lit = literalArg(init);
	if (lit !== null || !PATH_CALL.test(init)) return lit;
	const open = init.indexOf("(");
	if (closeOf(init, open) !== init.length) return null;
	const lits = topLevelArgs(init.slice(open + 1, -1)).map(literalArg);
	return lits.length === 0 || lits.includes(null) ? null : lits.join("/");
}

/**
 * The segments a `path` call's further argument stands for, or the shape
 * that stops it resolving.
 * @param {SiteScan} scan
 * @param {string} arg
 * @param {number} hops
 * @returns {string[] | { unseen: string } | { listed: string[], name: string }}
 *   `listed` where it walks a listing of those directories
 */
function segmentsOf(scan, arg, hops) {
	const lit = literalArg(arg) ?? QUOTED.exec(arg)?.[2] ?? null;
	if (lit !== null) return [lit];
	const spread = /^\.\.\.\s*(\S+)$/.exec(arg)?.[1];
	if (spread !== undefined) {
		const bound = IDENT.test(spread) ? boundValues(scan, spread) : null;
		return bound && "lits" in bound ? bound.lits : { unseen: SHAPE.spread };
	}
	if (arg.startsWith("`")) return { unseen: SHAPE.template };
	if (!IDENT.test(arg)) return { unseen: SHAPE.computed };
	const inits = hops > 0 ? declInits(scan, arg).map(initSegment) : [];
	if (inits.length > 0 && !inits.includes(null))
		return /** @type {string[]} */ (inits);
	const bound = boundValues(scan, arg);
	if (!bound) return { unseen: SHAPE.variable(arg) };
	return "lits" in bound ? bound.lits : { listed: bound.listed, name: arg };
}

/**
 * Bases joined with further segments, each kept unseen or resolved.
 * @param {Resolution[]} bases
 * @param {string[]} tails
 * @returns {Resolution[]}
 */
function joinAll(bases, tails) {
	return bases.flatMap((b) => {
		if ("unseen" in b) return [b];
		return tails.flatMap((t) => {
			const r = resolveDirPath(b.path ? b.path.split("/") : [], t);
			return r === null ? [] : [/** @type {Resolution} */ ({ path: r })];
		});
	});
}

/**
 * A whole `path.join`/`path.resolve` call.
 * @param {SiteScan} scan
 * @param {string} call
 * @param {number} hops
 * @returns {Resolution[]}
 */
function resolveJoin(scan, call, hops) {
	const open = call.indexOf("(");
	if (closeOf(call, open) !== call.length) return [];
	const [base, ...rest] = topLevelArgs(call.slice(open + 1, -1));
	const bases = base === undefined ? [] : resolveExpr(scan, base, hops);
	if (bases.length === 0 || DIR_CLASS_CALL.test(call)) return [];
	let tails = [""];
	for (const [i, arg] of rest.entries()) {
		const segs = segmentsOf(scan, arg, hops);
		/* A file a listing returned is judged at the listing, one level deep. */
		if ("listed" in segs) {
			const unseen = { unseen: SHAPE.variable(segs.name) };
			if (i < rest.length - 1)
				return bases.map((b) => ("unseen" in b ? b : unseen));
			return joinAll(bases, tails).flatMap((p) => {
				if ("unseen" in p) return [p];
				return segs.listed.includes(p.path) ? [] : [unseen];
			});
		}
		if (!Array.isArray(segs))
			return bases.map((b) => ("unseen" in b ? b : segs));
		tails = tails
			.flatMap((t) => segs.map((s) => (t ? `${t}/${s}` : s)))
			.slice(0, MAX_ALTERNATIVES);
	}
	return joinAll(bases, tails);
}

/** A template literal opening on an interpolation: it, and the rest. */
const TEMPLATE_HEAD = /^`\$\{([^}`]+)\}([^`]*)`$/;

/**
 * A template literal opening on an anchored interpolation.
 * @param {SiteScan} scan
 * @param {string} tpl
 * @param {number} hops
 * @returns {Resolution[]}
 */
function resolveTemplate(scan, tpl, hops) {
	const m = TEMPLATE_HEAD.exec(tpl);
	if (!m) return [];
	const bases = resolveExpr(scan, requiredGroup(m, 1, TEMPLATE_HEAD), hops);
	const tail = requiredGroup(m, 2, TEMPLATE_HEAD);
	if (/^[A-Za-z0-9_./-]*$/.test(tail)) return joinAll(bases, [tail]);
	return bases.length > 0 ? [{ unseen: SHAPE.template }] : [];
}

/**
 * The first piece of a path spread across `[…].join(…)` or a `+` chain,
 * neither of which the extractor joins; null for any other expression.
 * @param {string} e
 * @returns {string | null}
 */
function spreadRunHead(e) {
	if (e.startsWith("[") && /^\]\s*\.join\(/.test(e.slice(closeOf(e, 0) - 1)))
		return topLevelArgs(e.slice(1, closeOf(e, 0) - 1))[0] ?? null;
	return (
		new RegExp(
			`^(${IDENT_SRC}|hostRoot\\(\\)|process\\.cwd\\(\\))\\s*\\+`,
		).exec(e)?.[1] ?? null
	);
}

/**
 * What a path expression resolves to, traced through declarations to an
 * anchor; [] where it reaches none — a tempdir, a parameter, a call.
 * @param {SiteScan} scan
 * @param {string} expr
 * @param {number} [hops]  declarations still to follow
 * @returns {Resolution[]}
 */
function resolveExpr(scan, expr, hops = TRACE_HOPS) {
	const e = expr.trim();
	if (PATH_CALL.test(e)) return resolveJoin(scan, e, hops);
	if (e.startsWith("`")) return resolveTemplate(scan, e, hops);
	if (DIRNAME_ANCHORS.has(e)) return [{ path: scan.dir }];
	if (/^(?:hostRoot\(\)|process\.cwd\(\))$/.test(e)) return [{ path: "" }];
	const run = spreadRunHead(e);
	if (run !== null)
		return resolveExpr(scan, run, hops).length > 0
			? [{ unseen: SHAPE.otherCall }]
			: [];
	if (!IDENT.test(e)) return [];
	const inits = declInits(scan, e);
	if (inits.length === 0) return ROOT_NAME.test(e) ? [{ path: "" }] : [];
	return hops > 0 ? inits.flatMap((i) => resolveExpr(scan, i, hops - 1)) : [];
}

/**
 * The shape of a read call's argument the selector leaves unattributed, or
 * null. A resolved file counts as seen when it is one of the test's edges or
 * untracked; a resolved directory when any file under it is an edge.
 * @param {SiteScan} scan
 * @param {string} arg
 * @param {boolean} listing
 * @returns {string | null}
 */
function readShape(scan, arg, listing) {
	for (const r of resolveExpr(scan, arg)) {
		if ("unseen" in r) return r.unseen;
		if (!listing) {
			if (scan.tracked.has(r.path) && !scan.seen(r.path)) return SHAPE.composed;
			continue;
		}
		const prefix = r.path ? `${r.path}/` : "";
		const under = [...scan.tracked].filter((p) => p.startsWith(prefix));
		if (under.length > 0 && !under.some(scan.seen)) return SHAPE.listing;
	}
	return null;
}

/** A git call whose argument list follows: the shape `addLsFilesEdges` reads. */
const GIT_CALL =
	/\b(?:execFileSync|execFile|spawnSync|spawn)\(\s*["']git["']\s*,\s*$/;

/**
 * Whether the options after a git call's argument list leave it in the repo:
 * no `cwd`, or one resolving to an anchor.
 * @param {SiteScan} scan
 * @param {number} after  just past the argument list
 */
function isRunInRepo(scan, after) {
	const opts = /^\s*,\s*\{/.exec(scan.source.slice(after));
	if (!opts) return true;
	const open = after + opts[0].length - 1;
	const close = closeOf(scan.source, open);
	if (close === -1) return false;
	const cwd = optionCwd(scan.source.slice(open, close));
	return cwd === null || resolveExpr(scan, cwd).length > 0;
}

/**
 * The `cwd` an options object literal names, `cwd: X` or a bare `cwd`; null
 * where it names none.
 * @param {string} opts
 */
function optionCwd(opts) {
	if (!opts.startsWith("{")) return null;
	for (const entry of topLevelArgs(opts.slice(1, -1))) {
		const cwd = /^cwd\b\s*(?::\s*([\s\S]+))?$/.exec(entry);
		if (cwd) return cwd[1] ?? "cwd";
	}
	return null;
}

/**
 * The shape of a `git ls-files` argument list run in the repo whose
 * pathspecs the selector cannot read, or null.
 * @param {SiteScan} scan
 * @param {string[]} elements
 * @returns {string | null}
 */
function lsFilesShape(scan, elements) {
	let specs = 0;
	for (const el of elements) {
		const lit = PATHSPEC.exec(el)?.[1];
		if (lit !== undefined) {
			if (!lit.startsWith("-") && lit !== "ls-files") specs++;
		} else if (IDENT.test(el) && argsFor(scan.source, el).length > 0) specs++;
		else return SHAPE.pathspec;
	}
	return specs === 0 ? SHAPE.wholeTree : null;
}

/** A `git ls-files` argument list's opening. */
const LS_FILES = /\[\s*["']ls-files["']/g;

/**
 * Where an unattributed site sits, and its shape.
 * @typedef {{ at: number, shape: string } | null} Found
 */

/**
 * A read call's unseen shape, where it is code and has one.
 * @param {SiteScan} test
 * @param {RegExpExecArray} m  a `READ_CALL` match
 * @returns {Found}
 */
function readCallShape(test, m) {
	const call = readCallArg(test, m);
	if (!call) return null;
	const scan = { ...test, site: call.site };
	const listing = requiredGroup(m, 1, READ_CALL).startsWith("readdir");
	const shape = readShape(scan, call.arg, listing);
	return shape ? { at: call.site, shape } : null;
}

/**
 * A read call's first argument and where the call sits, where it is code and
 * has one.
 * @param {SiteScan} scan
 * @param {RegExpExecArray} m  a `READ_CALL` match
 * @returns {{ site: number, arg: string } | null}
 */
function readCallArg(scan, m) {
	const site = m.index ?? 0;
	if (!isCode(scan.spans, site)) return null;
	const open = site + m[0].length - 1;
	const close = closeOf(scan.source, open);
	if (close === -1) return null;
	const [arg] = topLevelArgs(scan.source.slice(open + 1, close - 1));
	return arg === undefined ? null : { site, arg };
}

/**
 * A `git ls-files` list's unseen shape, where git runs it in the repo.
 * @param {SiteScan} test
 * @param {RegExpExecArray} m  an `LS_FILES` match
 * @returns {Found}
 */
function lsFilesCallShape(test, m) {
	const scan = { ...test, site: m.index ?? 0 };
	const close = closeOf(scan.source, scan.site);
	if (!isCode(scan.spans, scan.site) || close === -1) return null;
	if (!GIT_CALL.test(scan.source.slice(0, scan.site))) return null;
	if (!isRunInRepo(scan, close)) return null;
	const elements = topLevelArgs(scan.source.slice(scan.site + 1, close - 1));
	const shape = lsFilesShape(scan, elements);
	return shape ? { at: scan.site, shape } : null;
}

/**
 * Every read in a test the selector cannot attribute (workflow-core#1881): a read or a
 * listing whose argument traces to an anchor yet resolves to no edge, and a
 * `git ls-files` run in the repo on a pathspec no literal names. A
 * `full-sweep-only:` line in the test's header reports nothing.
 * @param {string} source
 * @param {Set<string>} tracked
 * @param {string} self
 * @param {(p: string) => boolean} seen  whether the selector already reaches
 *   `p` from the test
 * @returns {Site[]}
 */
function unseenSitesFor(source, tracked, self, seen) {
	if (!READ_OR_LIST.test(source)) return [];
	if (!ANCHOR.test(source) && !DIRNAME.test(source)) return [];
	const spans = inertSpans(source);
	if (FULL_SWEEP_ONLY.test(headerOf(source, spans))) return [];
	const dir = self.split("/").slice(0, -1).join("/");
	/** @type {SiteScan} */
	const scan = { source, spans, dir, tracked, seen, site: 0, decls: new Map() };
	const found = [
		...[...source.matchAll(READ_CALL)].map((m) => readCallShape(scan, m)),
		...[...source.matchAll(LS_FILES)].map((m) => lsFilesCallShape(scan, m)),
	];
	return found
		.filter((f) => f !== null)
		.map(({ at, shape }) => ({
			line: source.slice(0, at).split("\n").length,
			shape,
		}))
		.sort((a, b) => a.line - b.line);
}

/**
 * @param {Map<string, Set<string>>} byDoc accumulator: file -> the tests reading it; `t` is added under `p`
 * @param {string} p
 * @param {string} t
 * @returns {void}
 */
function addReader(byDoc, p, t) {
	const readers = byDoc.get(p) ?? new Set();
	readers.add(t);
	byDoc.set(p, readers);
}

/**
 * What one test reads from the tree: its own literals and rule fragments,
 * and the literals of each helper it imports.
 * @param {string} t  the test's path
 * @param {string} source  its text
 * @param {Set<string>} tracked
 * @param {(p: string) => string} read
 * @returns {Set<string>}
 */
function testReads(t, source, tracked, read) {
	const found = new Set(edgesFor(source, tracked, t));
	for (const p of ruleEdgesFor(source, tracked, t)) found.add(p);
	for (const helper of importedHelpers(source, t, tracked))
		for (const p of edgesFor(blankComments(read(helper)), tracked, helper))
			if (p !== t) found.add(p);
	return found;
}

/** A word a shell line may name a root-relative path with, after any
 * `$var/` prefix that roots it. */
const SHELL_PATH =
	/(?:^|[\s="'(:<>|;])(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/)?(?:\.\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*[A-Za-z0-9_-]|[A-Za-z0-9_-]+\.[A-Za-z0-9]+)/g;

/** A heredoc's opening, its delimiter captured. */
const HEREDOC = /<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/;

/** @param {string} t */
const blank = (t) => t.replace(/[^\n]/g, " ");

/**
 * Where `shellOperands` stands between characters: inside a heredoc whose
 * delimiter it holds, or inside a quoted string, the text so far held back.
 * @typedef {{ heredoc: string | null, quote: string | null, quoted: string }} ShellState
 */

/**
 * One line's operands outside a heredoc, the state carried to the next line
 * updated.
 * @param {string} line
 * @param {ShellState} st
 * @returns {string}
 */
function shellLineOperands(line, st) {
	let out = "";
	let i = 0;
	while (i < line.length) {
		const c = line.charAt(i);
		if (st.quote) {
			const run = quotedRun(line, i, st);
			out += run.text;
			i = run.end;
		} else if (c === "#" && /^$|[\s;|&(]$/.test(line.charAt(i - 1))) {
			return out + blank(line.slice(i));
		} else {
			if (c === "'" || c === '"') {
				st.quote = c;
				st.quoted = c;
			} else out += c;
			i++;
		}
	}
	st.heredoc = st.quote ? null : (HEREDOC.exec(line)?.[1] ?? null);
	return out;
}

/**
 * Reads on through an open quoted string from `i`, to its close or the end
 * of the line, holding it back in `st.quoted`.
 * @param {string} line
 * @param {number} i
 * @param {ShellState} st
 * @returns {{ text: string, end: number }}  the closed string's operand
 *   text, "" while it is still open, and where reading stopped
 */
function quotedRun(line, i, st) {
	for (let j = i; j < line.length; j++) {
		const c = line.charAt(j);
		const escaped = c === "\\" && st.quote === '"';
		st.quoted += escaped ? c + line.charAt(j + 1) : c;
		if (escaped) j++;
		else if (c === st.quote) return { text: closeQuote(st), end: j + 1 };
	}
	return { text: "", end: line.length };
}

/**
 * A closed quoted string as an operand: kept whole, or blanked where it
 * holds a space and so is prose.
 * @param {ShellState} st
 * @returns {string}
 */
function closeQuote(st) {
	st.quote = null;
	return /\s/.test(st.quoted) ? blank(st.quoted) : st.quoted;
}

/**
 * A shell script's text with what is not a path operand blanked, line breaks
 * kept: `#` comments, heredoc bodies, and any quoted string holding a space,
 * which is a message's prose — `"$root/docs/x.md"` holds none. A `#` opens a
 * comment only at a word's start outside quotes, so `$#` and `${#x}` stay.
 * @param {string} source
 * @returns {string}
 */
function shellOperands(source) {
	/** @type {ShellState} */
	const st = { heredoc: null, quote: null, quoted: "" };
	let out = "";
	for (const [n, line] of source.split("\n").entries()) {
		if (n > 0) {
			if (st.quote) st.quoted += "\n";
			else out += "\n";
		}
		if (st.heredoc === null) out += shellLineOperands(line, st);
		else {
			if (line.trim() === st.heredoc) st.heredoc = null;
			out += blank(line);
		}
	}
	return out + (st.quote ? blank(st.quoted) : "");
}

/**
 * Every tracked path a shell script names as an operand (`shellOperands`).
 * Lexical: a shell script naming a path almost always runs `cat`, `grep` or a
 * redirect on it, and no call shape tells a read from the rest (workflow-core#2093).
 * @param {string} source
 * @param {Set<string>} tracked
 * @returns {string[]}
 */
function shellReadsOf(source, tracked) {
	const out = new Set();
	for (const m of shellOperands(source).matchAll(SHELL_PATH)) {
		const p = requiredGroup(m, 1, SHELL_PATH);
		if (tracked.has(p)) out.add(p);
	}
	return [...out].sort();
}

/**
 * The tracked files a script reads (workflow-core#2093). A node script's are its
 * `readFileSync`/`readFile` calls in code whose argument is a bare literal or
 * traces to an anchor — the site scan's own resolution — so a path it names
 * for any other reason, a comment's citation included, is no read. A shell
 * script's are every path its code names.
 * @param {string} file
 * @param {string} source
 * @param {Set<string>} tracked
 * @returns {string[]}
 */
function fileReadsOf(file, source, tracked) {
	if (!NODE_SCRIPT.test(file)) return shellReadsOf(source, tracked);
	if (!/\breadFile(?:Sync)?\(/.test(source)) return [];
	return nodeReadsOf(file, source, tracked);
}

/**
 * @param {string} file
 * @param {string} source
 * @param {Set<string>} tracked
 * @returns {string[]}
 */
function nodeReadsOf(file, source, tracked) {
	const spans = inertSpans(source);
	const dir = file.split("/").slice(0, -1).join("/");
	/** @type {SiteScan} */
	const scan = {
		source,
		spans,
		dir,
		tracked,
		seen: () => true,
		site: 0,
		decls: new Map(),
	};
	const out = new Set();
	for (const m of source.matchAll(READ_CALL)) {
		if (requiredGroup(m, 1, READ_CALL).startsWith("readdir")) continue;
		const call = readCallArg(scan, m);
		if (!call) continue;
		/* A bare literal is read against the working directory, the root a
		 * test spawns a script from. Residual (workflow-core#2093): a script spawned with
		 * another `cwd`, or one that changes directory, gets a false edge. */
		const bare = literalArg(call.arg)?.replace(/^\.\//, "");
		if (bare !== undefined && tracked.has(bare)) out.add(bare);
		for (const r of resolveExpr({ ...scan, site: call.site }, call.arg))
			if ("path" in r && r.path !== file && tracked.has(r.path))
				out.add(r.path);
	}
	return [...out].sort();
}

/**
 * @param {Map<string, Map<string, number>>} byClosure accumulator: file ->
 *   reading test -> depth; `t` is added under each file at its depth
 * @param {string} t
 * @param {Map<string, number>} depths
 * @returns {void}
 */
function addClosure(byClosure, t, depths) {
	for (const [d, depth] of depths) {
		const readers = byClosure.get(d) ?? new Map();
		readers.set(t, depth);
		byClosure.set(d, readers);
	}
}

/**
 * `fn` with each path's answer kept, so a file shared by many tests is read
 * once.
 * @param {(p: string) => string[]} fn
 * @returns {(p: string) => string[]}
 */
function once(fn) {
	/** @type {Map<string, string[]>} */
	const kept = new Map();
	return (p) => {
		let answer = kept.get(p);
		if (!answer) {
			answer = fn(p);
			kept.set(p, answer);
		}
		return answer;
	};
}

/**
 * Gives each file a test's scripts load, and no test reads directly, to the
 * tests that reach it at the shallowest depth — vitest's own graph and the
 * test files themselves excepted.
 * @param {Map<string, Set<string>>} byDoc  edited in place
 * @param {Map<string, Map<string, number>>} byClosure  file -> reading test -> depth
 * @param {Set<string>} esm  what vitest's import graph already reaches
 * @returns {void}
 */
function addNearestReaders(byDoc, byClosure, esm) {
	for (const [p, readers] of byClosure) {
		if (byDoc.has(p) || esm.has(p) || isTestFile(p)) continue;
		const nearest = Math.min(...readers.values());
		for (const [t, depth] of readers)
			if (depth === nearest) addReader(byDoc, p, t);
	}
}

/**
 * @param {Set<string>} tracked
 * @param {(p: string) => string} read
 * @param {{ sites?: boolean }} [opts]  also find each test's unseen reads,
 *   a fifth of the render's cost, so only the callers reporting them ask
 * @returns {{ edges: Record<string, string[]>, anchored: number, tests: number, warnings: string[], unseen: Record<string, Site[]> }}
 *   `unseen` is empty unless `sites` asked for it
 */
function buildManifest(tracked, read, { sites: findSites = false } = {}) {
	const tests = [...tracked].filter(isTestFile).sort();
	/** @type {Map<string, Set<string>>} */
	const byDoc = new Map();
	/** @type {Map<string, Map<string, number>>} file -> reading test -> depth */
	const byClosure = new Map();
	/** @type {string[]} */
	const warnings = [];
	const loadsOnce = once((p) => {
		const found = scriptDeps(p, read(p), tracked);
		warnings.push(...found.warnings);
		return found.deps;
	});
	const readsOnce = once((p) => {
		const loaded = new Set(loadsOnce(p));
		return fileReadsOf(p, read(p), tracked).filter((r) => !loaded.has(r));
	});
	/** @type {Record<string, Site[]>} */
	const unseen = {};
	for (const t of tests) {
		const source = read(t);
		const found = testReads(t, source, tracked, read);
		addClosure(byClosure, t, closureDepths(t, found, loadsOnce, readsOnce));
		for (const p of ownModules(t, tracked)) found.add(p);
		for (const p of found) addReader(byDoc, p, t);
		if (!findSites) continue;
		/** @type {Set<string> | undefined} */
		let imports;
		const sites = unseenSitesFor(source, tracked, t, (p) => {
			if (found.has(p)) return true;
			imports ??= vitestImports(source, t, tracked);
			return imports.has(p);
		});
		if (sites.length > 0) unseen[t] = sites;
	}
	addNearestReaders(byDoc, byClosure, esmReach(tests, tracked, read));
	/** @type {Record<string, string[]>} */
	const edges = {};
	for (const [p, readers] of [...byDoc].sort(([a], [b]) => byCodeUnit(a, b)))
		edges[p] = [...readers].sort();
	const anchored = new Set([...byDoc.values()].flatMap((r) => [...r])).size;
	return { edges, anchored, tests: tests.length, warnings, unseen };
}

/**
 * What the scripts a test reads load and read at runtime, transitively, each
 * at its shallowest depth: 1 for a read script's own dependency or read.
 * A read is never followed: a script reading another as text runs none of it.
 *
 * @param {string} test
 * @param {Set<string>} reads  the test's direct reads, never re-entered
 * @param {(p: string) => string[]} loads
 * @param {(p: string) => string[]} scriptReads  what a script reads in its code
 * @returns {Map<string, number>}
 */
function closureDepths(test, reads, loads, scriptReads) {
	/** @type {Map<string, number>} */
	const depths = new Map();
	/** Records `d` at `depth` unless it is reached already. @param {string} d @param {number} depth */
	const record = (d, depth) => {
		if (d === test || reads.has(d) || depths.has(d)) return false;
		depths.set(d, depth);
		return true;
	};
	let frontier = [...reads].filter(isScript);
	for (let depth = 1; frontier.length > 0; depth++) {
		/** @type {string[]} */
		const next = [];
		for (const s of frontier) {
			for (const d of loads(s))
				if (record(d, depth) && isScript(d)) next.push(d);
			for (const d of scriptReads(s)) record(d, depth);
		}
		frontier = next;
	}
	return depths;
}

/**
 * Every tracked file some test reaches through static ESM imports, at any
 * depth: what vitest's own graph selects without a manifest edge.
 *
 * @param {string[]} tests
 * @param {Set<string>} tracked
 * @param {(p: string) => string} read
 * @returns {Set<string>}
 */
function esmReach(tests, tracked, read) {
	const reached = new Set();
	const queue = [...tests];
	while (queue.length > 0) {
		const p = /** @type {string} */ (queue.pop());
		if (!/\.(?:tsx?|[mc]?js)$/.test(p)) continue;
		for (const d of vitestImports(read(p), p, tracked))
			if (!reached.has(d)) {
				reached.add(d);
				queue.push(d);
			}
	}
	return reached;
}

/**
 * The selection a set of changed paths adds on top of vitest's own.
 *
 * @param {string[]} changed
 * @param {Record<string, string[]>} edges
 * @returns {string[]}
 */
function testsReading(changed, edges) {
	const out = new Set();
	for (const p of changed) for (const t of edges[p] ?? []) out.add(t);
	return [...out].sort();
}

/**
 * The tracked files `source` imports or requires by relative specifier, one
 * hop, the bare side-effect `import "./x"` included: the import edge the
 * manifest leaves to vitest's own graph, read lexically for a touched-test
 * selection (workflow-core#2930).
 *
 * @param {string} source
 * @param {string} self
 * @param {Set<string>} tracked
 * @returns {Set<string>}
 */
const directImports = (source, self, tracked) =>
	new Set([
		...importedHelpers(source, self, tracked),
		...importedHelpers(source, self, tracked, ESM_IMPORT),
	]);

/**
 * @param {string} root
 * @param {string[]} args
 */
const gitOut = (root, args) =>
	execGit(args, {
		cwd: root,
		/* A wedged git must not hang a suite launch: the render and the touched
		 * selection both run on scripts/run-vitest.js's launch path. */
		timeout: GIT_TIMEOUT_MS,
	});

/**
 * @param {string} root
 * @param {string[]} args  a git command printing NUL-separated entries
 */
const gitList = (root, args) =>
	gitOut(root, args).toString("utf8").split("\0").filter(Boolean);

/**
 * Tracked paths the working tree still holds, and a reader over them. A path
 * the index lists but the disk has lost — a neighbour's deletion in flight, a
 * cut's deletions before its commit — reads nothing and bounds no edge (workflow-core#557).
 *
 * @param {string} root
 */
function readWorkingTree(root) {
	const gone = new Set(gitList(root, ["ls-files", "-z", "--deleted"]));
	return {
		tracked: new Set(
			gitList(root, ["ls-files", "-z"]).filter((p) => !gone.has(p)),
		),
		read: (/** @type {string} */ p) =>
			fs.readFileSync(path.join(root, p), "utf8"),
	};
}

module.exports = {
	ANCHOR,
	LITERAL,
	buildManifest,
	directImports,
	gitList,
	gitOut,
	testsReading,
	readWorkingTree,
};
