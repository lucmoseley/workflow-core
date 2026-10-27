/*
 * plugin-tree.js — renders the plugin as an adopter installs it: a trimmed
 * tree holding only what runs, which a release commit carries (#4).
 *
 * WHAT SHIPS: the plugin manifest, the marketplace manifest (#117),
 * hooks/hooks.json rendered fresh from the self-plugin's hooks file (#2441),
 * the entry module it names (#946), the output styles, scripts/, .claude/skills/, .claude/agents/ (#741),
 * docs/agents (#5), ruff.toml (#106) and migrations/ (#6), with symlinks
 * dereferenced and every test, fixture and TypeScript file left out — but
 * VITEST_LOADED, the TypeScript an adopter's vitest config attaches, which only
 * vitest ever loads (#552), and a mod's TypeScript under its hooks/ and types/,
 * which the engine loads from the install cache uncompiled (#933) — its state
 * owner renamed and its `claude-code` imports type-only, both below. A mod is
 * a skill carrying its own .claude-plugin/plugin.json; its copy of the
 * engine's types stays behind, the engine supplying them to an installed
 * plugin, and so do its tsconfig.json and own hooks/hooks.json (#1050).
 * No package.json, so an install runs no `npm ci`.
 * WHAT SHIPS IS JUDGED BY WHETHER IT HOLDS AN ADOPTER TO BEST PRACTICE (#1380).
 * That the adopter does not follow the practice yet, or lacks the setup it
 * needs, is never a reason to leave a file behind, however much bringing the
 * adopter up costs; each entry below gives a merit reason instead.
 * Left out of scripts/ is the core-only class (#440): tools that maintain the
 * core itself and run from no hook, skill or command in an adopter — the
 * measure-, bench_, probe- and sample_ instruments and the release build
 * among them. A class member a shipped code line, skill, command or
 * docs/agents file names ships after all (KEPT); a script comment citing one
 * as a figure's source keeps nothing.
 * The layout under the root mirrors the repo's, which keeps a skill script's
 * `../../../../scripts/` require resolving.
 *
 * NO SHIPPED SCRIPT MAY REQUIRE AN npm PACKAGE — there is no node_modules in
 * the plugin cache. One exception (#933): a shipped file may import
 * `claude-code` where every import of it in the file is `import type`, which
 * the engine erases. `import { type A }` and `export type … from` are refused
 * all the same.
 * A shipped script needing a package loads it from the adopter's own install
 * through lib/host-package.js, and is BROKEN where it is absent (#1380). The
 * scan is lexical and skips comment lines; a specifier built at runtime is
 * unseen.
 *
 * SKILL, COMMAND AND OUTPUT-STYLE BODIES KEEP REPO-RELATIVE PATHS IN THE
 * REPO, where `${CLAUDE_PLUGIN_ROOT}` stays literal (#4). The
 * shipped skill/command copy spells them through the variables the harness
 * substitutes in a plugin: `scripts/x` becomes `${CLAUDE_PLUGIN_ROOT}/scripts/x`,
 * `.claude/skills/x` becomes `${CLAUDE_PLUGIN_ROOT}/.claude/skills/x`, and a
 * `scripts/x` that exists only inside the skill's own directory becomes
 * `${CLAUDE_SKILL_DIR}/scripts/x`. An illustrative `scripts/` example is
 * rewritten too, so a prose example names a path outside it.
 *
 * AN OUTPUT STYLE'S BODY IS NEVER REWRITTEN, kept plain-`scripts/x` (#50's
 * rewrite reversed). The harness substitutes the variable in skill and
 * command bodies (#4) but not inside an output-style body (#64). The shipped
 * style still names `scripts/x`, which resolves nowhere in a plugin.
 *
 * THE HELPER SURFACE SHIPS WHOLE (#464): every entry point
 * scripts/lib/helper-surface.json lists, and every file it reaches, or the
 * render refuses — lib/surface-closure.js. Judging a Python import needs
 * python3 3.10 or later on the releasing machine (sys.stdlib_module_names).
 *
 * A MOD'S STATE BELONGS TO THE HOST PLUGIN (#903 F8): in the shipped copy of
 * its TypeScript, a `plugin: "<mod>"` state ref and the mod's `PluginState`
 * key name the host plugin instead. The source keeps the mod's own name, so it
 * still loads stand-alone in the core. A mod file calling `$.state` with no
 * literal ref to rename, or a contract left with no host key, is a fault.
 *
 * THE STANDARDS BASE PINS ONLY SHIPPED LINES (#961): an adopter reads the
 * base at the plugin root, so a line pin into a file this render leaves behind
 * is a fault. isShipped() is the one answer to "does the release ship this path?".
 *
 * A DOC A SHIPPED FILE NAMES RESOLVES IN AN ADOPTER (#1452): a skill or
 * command body spells a shipped top-level doc through the plugin root, and a top-level
 * `docs/x.md` the core holds, named on a line a session reads or is shown,
 * fails the render unless the release ships it or the host holds its own
 * (HOST_OWNED_DOCS). Comment lines, docstrings and data files are not read.
 *
 * A BARE `#N` SHIPS AS `workflow-core#N` (#396): qualify-citations.js holds
 * what is rewritten and what is left bare. A code line's `#N` outside a
 * same-line `( … )` would print as the adopter's own issue, so it is a fault
 * (#435).
 */

const fs = require("node:fs");
const path = require("node:path");
const { builtinModules } = require("node:module");
const { ENTRY, renderAt } = require("./plugin-hooks-render.js");
const {
	BARE_CITATION_OK,
	buildCitableLineTest,
	JS_COMMENT_LINE,
	JS_TS_FILE,
	qualifyCitations,
	parseTripleQuotedLines,
	unbracketedCodeCitations,
} = require("./qualify-citations.js");
const {
	BASE_LINE_PIN_REMEDY,
	baseLinePinFault,
	parseLinePins,
} = require("./standards-pins.js");
const {
	JS_SPEC,
	jsSpecifier,
	surfaceClosureFaults,
} = require("./surface-closure.js");
const { requiredGroup } = require("./regex-group.js");
const { isUnder } = require("./is-under.js");
const { MIGRATIONS_DIR } = require("./workflow-core-config.js");
const { isCollectedTestOrConftest } = require("./test-kind.js");
const { noticeFaults } = require("./vendored-notices.js");

const STANDARDS_BASE = "docs/code-standards-base.md";
const COPIED = [
	".claude-plugin/plugin.json",
	/* `claude plugin marketplace add <url>#<tag>` fetches THAT tag's tree
	 * looking for this file, refusing "Marketplace file not found" without it —
	 * even though `main`'s own copy names the tag as the ref (#117). */
	".claude-plugin/marketplace.json",
	".claude/output-styles",
	/* The review axes' agent type (#741). plugin.json's `agents` must list each
	 * file: a directory string fails the manifest's validation. */
	".claude/agents",
	".claude/skills",
	"scripts",
	/* The core-owned prose a guard or skill reads AT RUNTIME. An adopter has no
	 * copy of any of it, so without these a deny hands over a rule id and no
	 * text, and the tracker rules reach nobody (#5). */
	"docs/agents",
	"docs/effort-guide.md",
	/* The machine's measured limits: the figures the shipped suite, admission
	 * and scratch guards enforce, which their text sends a session to (#1452). */
	"docs/environment.md",
	/* The standards base, read at runtime: every review route hands it over
	 * from here, beside the host's own local file, which never ships (#967). */
	STANDARDS_BASE,
	".husky",
	/* The Python gate's rule set, which .husky/pre-commit hands ruff by
	 * --config in an adopter carrying none of its own (#106). */
	"ruff.toml",
	/* Migration notes an adopter's own `upgrade` walks against its pinned ref —
	 * without these an adopter never sees a bump past v1, only the mechanism (#6). */
	MIGRATIONS_DIR,
	ENTRY,
];
/* The core-only class: header, WHAT SHIPS. Its instruments re-derive figures
 * the core's own documents and configs hold, which an adopter has no copy of. */
const LEFT_BEHIND_CLASS = /^scripts\/(measure[-_]|bench_|probe-|sample_)/;
const LEFT_BEHIND = new Set([
	// the release build, of this plugin, which no adopter releases
	"scripts/check-surface-contract.js",
	"scripts/generate-plugin-tree.js",
	"scripts/lib/plugin-tree.js",
	"scripts/lib/release-tags.js",
	"scripts/lib/surface-closure.js",
	"scripts/release-contains.js",
	"scripts/release-plugin.js",
	// times the core's own suite for its own maxWorkers figure (mantahostels#1906)
	"scripts/idle-maxworkers-bench.sh",
	// the core's one-off memory-store backup, retired at mantahostels#642
	"scripts/snapshot-memory.sh",
	// cuts mantahostels over, once, from this checkout (#423)
	"scripts/cut-mantahostels.js",
	// type-checks the core's own mods and entry module, from its `npm run typecheck` alone (#2048)
	"scripts/typecheck-mods.js",
	// creates repos under the founder's own account; skill and script go together (#691)
	".claude/skills/new-repo",
]);
/* Class members a shipped file tells its reader to run, so they ship. */
const KEPT = new Set([
	// guard-session-ceiling.js's `remeasure`
	"scripts/measure-turn-band.js",
	// check-suite-size-drift.js's re-measure line
	"scripts/bench_suite_concurrency.py",
	// pick-next's measured-figures.md re-derivation
	"scripts/measure-bundle-cost.js",
	// allowance.js's missing-table refusal, and the table core-owned-files.js builds (#1734)
	"scripts/measure-session-cost.js",
]);
/**
 * @param {string} rel repo-relative path
 * @returns {boolean} whether the release leaves it behind
 */
const isLeftBehind = (rel) =>
	LEFT_BEHIND.has(rel) || (LEFT_BEHIND_CLASS.test(rel) && !KEPT.has(rel));
/* Core docs a host holds its own copy of — init or a module writes it, or a
 * path key in the host's config falls back to it — so a shipped pointer to
 * one resolves in the host's tree (#1452). */
const HOST_OWNED_DOCS = new Set([
	// init writes it
	"docs/doc-map.md",
	// the roadmap module writes both
	"docs/roadmap-digest.md",
	"docs/called-cards.md",
	// the host's own standards, beside the shipped base (#967)
	"docs/code-standards.md",
	// userSettingsSnapshotPath's fallback, read where the host keeps one
	"docs/claude-user-settings.md",
]);
/* Shipped files that name a core-only doc as data, never as one to read. */
const DOC_NAMES_AS_DATA = new Set([
	// its carve-out list matches the paths a session edits
	"scripts/lib/implement-carveout.js",
	// SHED_REGISTERS, which a cap refusal names only where the host keeps them
	"scripts/lib/context-budget-pathspecs.js",
]);
/* `<shipped file> <doc>` pairs where the file names an unshipped research
 * artefact or ADR that no adopter session must open: cited as evidence, the
 * claim or rule stated where it stands, unless a comment says otherwise
 * (#1673). Keyed by pair, so a new pointer to a new doc, or from a new file,
 * fails the release until judged; one added beside a registered pair passes
 * unseen. */
const CITED_NOT_READ = new Set([
	// the ruling's routes stated where it is cited
	".claude/skills/roadmap-edit/SKILL.md docs/adr/0006-disposal-writes-back-to-source.md",
	".claude/skills/card-close/SKILL.md docs/adr/0006-disposal-writes-back-to-source.md",
	// provenance of a figure or list the tool prints from its own data
	"scripts/count-guard-fires.js docs/research/always-loaded-shed-candidates.md",
	// step 4 binds only where the host keeps the register
	"docs/agents/rules/README.md docs/research/always-loaded-shed-candidates.md",
]);
/* A file read whole as prose, every line of it a pointer a session may follow. */
const PROSE_FILE = /\.(md|txt)$/;
/* The reporters and globalSetup that record a certificate; the adopter guide,
 * docs/agents/helper-surface.md, says how an adopter attaches them. */
const VITEST_LOADED = new Set([
	"scripts/vitest-pass-reporter.ts",
	"scripts/vitest-inflight-reporter.ts",
	"scripts/vitest-tree-watch.ts",
]);
/* A mod's TypeScript, which ships given the mod carries its own manifest and
 * isSkipped finds it no test. */
const MOD_TS =
	/^\.claude\/skills\/([^/]+)\/(?:hooks|types)\/(?:[^/]+\/)*[^/]+\.tsx?$/;
/* A mod's files no adopter runs: its tsconfig names the engine types left
 * behind, and its own hooks.json loads it stand-alone, where an adopter loads
 * it through the entry (#1050). */
const MOD_STANDALONE_CONFIG =
	/^\.claude\/skills\/([^/]+)\/(?:tsconfig\.json|hooks\/hooks\.json)$/;
/* The specifier the engine's own declarations answer to: `declare module
 * "claude-code"`. */
const ENGINE = "claude-code";
const TYPE_ONLY_ENGINE = new RegExp(
	`\\bimport\\s+type\\s+(?:\\{[^}]*\\}|[\\w$]+|\\*\\s+as\\s+[\\w$]+)\\s+from\\s+["']${ENGINE}["']`,
	"g",
);
const SKIPPED_DIRS = new Set(["__pycache__", "fixtures", "node_modules"]);
const REWRITTEN = /^\.claude\/skills\/.*\.md$/;
const SKIPPED_FILE =
	// The last alternative's name must track precommit-gate-harness.test.ts's
	// own `fixtureName` literal exactly, or a rename there reopens #65.
	/\.[cm]?tsx?$|^__precommit-gate-harness-test-fixture-\d+\.js$/;

// biome-ignore lint/suspicious/noTemplateCurlyInString: the variable Claude Code substitutes, not a JS template
const PLUGIN_ROOT = "${CLAUDE_PLUGIN_ROOT}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: the variable Claude Code substitutes, not a JS template
const SKILL_DIR = "${CLAUDE_SKILL_DIR}";
/** A path segment's left edge: nothing that could make it the tail of a longer path. */
const EDGE = "(?<![\\w./$}-])";
const SKILLS_PATH = new RegExp(`${EDGE}\\.claude/skills/`, "g");
const SCRIPTS_PATH = new RegExp(
	`${EDGE}(?:\\./)?scripts/([\\w*.-][\\w*./-]*)`,
	"g",
);
/** A top-level `docs/x.md`, or one under `docs/research/` or `docs/adr/`, the
 * shapes a pointer to a core doc takes (#1673). Never a `docs/agents/` path: a
 * vendored skill names the host's own copy there, to write
 * (setup-matt-pocock-skills). */
const DOC_POINTER = new RegExp(
	`${EDGE}docs/((?:research/|adr/)?[\\w-]+\\.md)(?![\\w/-])`,
	"g",
);

/**
 * @param {string} body a skill or command markdown file
 * @param {{root: string, skillDir: string | null}} at the source root, and the
 *   skill directory the file sits in (null outside a skill)
 * @returns {string}
 */
function rewriteBody(body, { root, skillDir }) {
	return body
		.replace(DOC_POINTER, (whole, name) => {
			const rel = `docs/${name}`;
			return isShipped(root, rel) && fs.existsSync(path.join(root, rel))
				? `${PLUGIN_ROOT}/${rel}`
				: whole;
		})
		.replace(SKILLS_PATH, `${PLUGIN_ROOT}/.claude/skills/`)
		.replace(SCRIPTS_PATH, (_whole, rest) => {
			const local =
				skillDir &&
				fs.existsSync(path.join(skillDir, "scripts", rest)) &&
				!fs.existsSync(path.join(root, "scripts", rest));
			return `${local ? SKILL_DIR : PLUGIN_ROOT}/scripts/${rest}`;
		});
}

/**
 * Package names a JS source requires or imports, builtins, relative paths and
 * comment lines excluded.
 * @param {string} source
 * @returns {string[]}
 */
function packageRequires(source) {
	const found = [];
	const code = source
		.split("\n")
		.filter((line) => !JS_COMMENT_LINE.test(line))
		.join("\n");
	for (const m of code.matchAll(JS_SPEC)) {
		const name = jsSpecifier(m);
		if (!/^(@[\w.-]+\/)?[\w-][\w.-]*(\/[\w.-]+)*$/.test(name)) continue;
		if (name.startsWith("node:") || builtinModules.includes(name)) continue;
		found.push(name);
	}
	const engine = found.filter((name) => name === ENGINE).length;
	return engine > 0 && engine === [...code.matchAll(TYPE_ONLY_ENGINE)].length
		? found.filter((name) => name !== ENGINE)
		: found;
}

/**
 * @param {string} manifest a plugin.json path
 * @returns {string} the plugin name it gives
 * @throws {Error} where it gives none
 */
function readPluginName(manifest) {
	const { name } = JSON.parse(fs.readFileSync(manifest, "utf8"));
	if (!name) throw new Error(`${manifest} names no plugin`);
	return name;
}

/**
 * The mod a file of `shape` belongs to — by default a mod's TypeScript file
 * — or null where it is none. Reads the mod's manifest, never the file itself.
 * @param {string} root
 * @param {string} rel
 * @param {RegExp} [shape] capturing the skill's folder name
 * @returns {string | null} the mod's own name
 */
function readModOf(root, rel, shape = MOD_TS) {
	const m = rel.match(shape);
	if (!m) return null;
	const manifest = path.join(
		root,
		".claude/skills",
		requiredGroup(m, 1, shape),
		".claude-plugin/plugin.json",
	);
	return fs.existsSync(manifest) ? readPluginName(manifest) : null;
}

/**
 * @param {string} text a mod's TypeScript
 * @param {string} rel its repo-relative path
 * @param {{ mod: string, host: string }} names the mod's own name, and the
 *   plugin shipping it
 * @returns {{ text: string, faults: string[] }} the text with the host named
 *   as its state owner, and where the rename found nothing to rename
 */
function renameStateOwner(text, rel, { mod, host }) {
	/** @type {string[]} */
	const faults = [];
	/** @param {string} name */
	const quoted = (name) =>
		`(["'])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`;
	const renamed = text.replace(
		new RegExp(`(?<=\\bplugin\\s*:\\s*)${quoted(mod)}`, "g"),
		(_whole, q) => `${q}${host}${q}`,
	);
	const block = renamed.search(/\binterface\s+PluginState\s*\{/);
	const out =
		block < 0
			? renamed
			: renamed.slice(0, block) +
				renamed
					.slice(block)
					.replace(
						new RegExp(`${quoted(mod)}(?=\\s*:)`),
						(_whole, q) => `${q}${host}${q}`,
					);
	if (
		/\$\.state\./.test(out) &&
		!new RegExp(`\\bplugin\\s*:\\s*${quoted(host)}`).test(out)
	) {
		faults.push(
			`${rel} calls $.state with no \`plugin: "${mod}"\` ref to rename to ${host}, so it would ship owning no state the engine accepts (#903 F8)`,
		);
	}
	if (
		block >= 0 &&
		!new RegExp(`${quoted(host)}\\s*:`).test(out.slice(block))
	) {
		faults.push(
			`${rel} declares PluginState with no "${mod}" key to rename to ${host} (#903 F8)`,
		);
	}
	return { text: out, faults };
}

/**
 * Whether the walk drops this entry. Judged by path alone, before any stat of
 * the entry itself: a transient fixture (e.g. the pre-commit gate harness's,
 * written and removed by a parallel test run) must never be touched on disk,
 * or its removal mid-walk throws (#65).
 * @param {string} root
 * @param {string} rel repo-relative path of a file or directory
 * @returns {boolean}
 */
function isSkipped(root, rel) {
	const name = path.basename(rel);
	return (
		SKIPPED_DIRS.has(name) ||
		isCollectedTestOrConftest(name) ||
		(SKIPPED_FILE.test(name) &&
			!VITEST_LOADED.has(rel) &&
			rel !== ENTRY &&
			!readModOf(root, rel)) ||
		readModOf(root, rel, MOD_STANDALONE_CONFIG) !== null ||
		isLeftBehind(rel)
	);
}

/**
 * Whether the release ships `rel`: under a COPIED entry, with no step of the
 * walk down to it dropped. Judges the path, never whether the file exists.
 * @param {string} root
 * @param {string} rel repo-relative path
 * @returns {boolean}
 */
function isShipped(root, rel) {
	const at = path.posix.normalize(rel);
	const top = COPIED.find((c) => isUnder(at, [c]));
	if (!top) return false;
	let step = top;
	if (isSkipped(root, step)) return false;
	for (const segment of at.slice(top.length).split("/").filter(Boolean)) {
		step = `${step}/${segment}`;
		if (isSkipped(root, step)) return false;
	}
	return true;
}

/**
 * The base's line pins into a file the release leaves behind, or into none it
 * can name (#961).
 * @param {string} root
 * @returns {string[]} one fault naming every such pin, or none
 */
function baseLinePinFaults(root) {
	const doc = path.join(root, STANDARDS_BASE);
	if (!fs.existsSync(doc)) return [];
	const stranded = parseLinePins(fs.readFileSync(doc, "utf8")).flatMap((p) => {
		const why = baseLinePinFault(root, p, (rel) => isShipped(root, rel));
		return why
			? [
					`\`${p.rawPath}${p.raw.slice(p.raw.lastIndexOf(":"))}\` (line ${p.line}), as ${why}`,
				]
			: [];
	});
	return stranded.length === 0
		? []
		: [
				`${STANDARDS_BASE} carries line pins the release refuses, so an adopter reading it finds no evidence: ${stranded.join("; ")} — ${BASE_LINE_PIN_REMEDY} (#961)`,
			];
}

/**
 * A citable file's text as the release writes it, before its citations are
 * qualified.
 * @param {string} root
 * @param {string} rel
 * @param {string} body
 * @returns {{ text: string, faults: string[] }}
 */
function buildShippedText(root, rel, body) {
	if (REWRITTEN.test(rel)) {
		const skill = rel.match(/^\.claude\/skills\/[^/]+/);
		const text = rewriteBody(body, {
			root,
			skillDir: skill ? fs.realpathSync(path.join(root, skill[0])) : null,
		});
		return { text, faults: [] };
	}
	const mod = readModOf(root, rel);
	return mod
		? renameStateOwner(body, rel, {
				mod,
				host: readPluginName(path.join(root, ".claude-plugin/plugin.json")),
			})
		: { text: body, faults: [] };
}

/**
 * @param {string} text
 * @param {string} rel
 * @returns {string[]}
 */
const citationFaults = (text, rel) =>
	unbracketedCodeCitations(text, rel).map(
		(c) =>
			`${rel}:${c.line} prints #${c.n} outside a ( … ) on its line, so it ships bare and names the adopter's own issue — bracket it, or put a comment naming ${BARE_CITATION_OK} and why on the line above`,
	);

/**
 * Which lines of a shipped file a session reads or is shown.
 * @param {string} rel
 * @param {string[]} lines
 * @returns {(line: string, i: number) => boolean}
 */
function buildIsReadableLine(rel, lines) {
	if (PROSE_FILE.test(rel)) return () => true;
	const comment = buildCitableLineTest(rel);
	if (!comment) return () => false;
	const quoted = /\.py$/.test(rel) ? parseTripleQuotedLines(lines) : new Set();
	return (line, i) => !comment(line) && !quoted.has(i);
}

/**
 * Pointers a shipped file prints or tells a session to read that name a core
 * doc the release leaves behind and no host holds, so in an adopter they
 * resolve nowhere (#1452).
 * @param {string} root
 * @param {string} rel
 * @param {string} text the file as the release writes it
 * @returns {string[]}
 */
function coreDocPointerFaults(root, rel, text) {
	if (DOC_NAMES_AS_DATA.has(rel)) return [];
	const lines = text.split("\n");
	const readable = buildIsReadableLine(rel, lines);
	return lines.flatMap((line, i) =>
		readable(line, i)
			? [...line.matchAll(DOC_POINTER)]
					.map((m) => `docs/${requiredGroup(m, 1, DOC_POINTER)}`)
					.filter(
						(doc) =>
							fs.existsSync(path.join(root, doc)) &&
							!isShipped(root, doc) &&
							!HOST_OWNED_DOCS.has(doc) &&
							!CITED_NOT_READ.has(`${rel} ${doc}`),
					)
					.map(
						(doc) =>
							`${rel}:${i + 1} names ${doc}, which the release does not ship and no adopter holds, so the pointer resolves nowhere — ship it (COPIED), state what it says in place, or name it in HOST_OWNED_DOCS, DOC_NAMES_AS_DATA or CITED_NOT_READ with the reason (#1452, #1673)`,
					)
			: [],
	);
}

/**
 * The bare-citation faults one file would fail the release on (#1151). None
 * where the release leaves it behind. A mod's state-rename fault is dropped
 * here and left to the release.
 * @param {string} root
 * @param {string} rel repo-relative
 * @returns {string[]}
 */
function bareCitationFaults(root, rel) {
	if (!buildCitableLineTest(rel) || !isShipped(root, rel)) return [];
	const body = fs.readFileSync(path.join(root, rel), "utf8");
	return citationFaults(buildShippedText(root, rel, body).text, rel);
}

/**
 * @param {string} root
 * @param {string} rel repo-relative path of a file or directory
 * @param {string} out
 * @param {string[]} faults accumulator: each fault the release would fail on is pushed here
 */
function copyEntry(root, rel, out, faults) {
	const src = path.join(root, rel);
	const name = path.basename(rel);
	if (isSkipped(root, rel)) return;
	const stat = fs.statSync(src);
	if (stat.isDirectory()) {
		for (const child of fs.readdirSync(src).sort()) {
			copyEntry(root, path.join(rel, child), out, faults);
		}
		return;
	}
	const dest = path.join(out, rel);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	const body = fs.readFileSync(src);
	if (JS_TS_FILE.test(name)) {
		for (const pkg of packageRequires(body.toString("utf8"))) {
			faults.push(`${rel} requires the npm package ${pkg}`);
		}
	}
	if (buildCitableLineTest(rel)) {
		const shipped = buildShippedText(root, rel, body.toString("utf8"));
		const text = shipped.text;
		faults.push(
			...shipped.faults,
			...citationFaults(text, rel),
			...coreDocPointerFaults(root, rel, text),
		);
		fs.writeFileSync(dest, qualifyCitations(text, rel));
	} else {
		if (PROSE_FILE.test(rel))
			faults.push(...coreDocPointerFaults(root, rel, body.toString("utf8")));
		fs.writeFileSync(dest, body);
	}
	fs.chmodSync(dest, stat.mode & 0o777);
}

/**
 * Renders the plugin tree from `root` into `out`, which must not exist. On any
 * failure no tree is left behind.
 * @param {string} root
 * @param {string} out
 * @throws {Error} naming every fault found
 */
function buildTree(root, out) {
	if (fs.existsSync(out)) throw new Error(`${out} already exists`);
	const hooks = renderAt(root);
	fs.mkdirSync(out, { recursive: true });
	try {
		/** @type {string[]} */
		const faults = [];
		for (const rel of COPIED) {
			if (fs.existsSync(path.join(root, rel))) {
				copyEntry(root, rel, out, faults);
			}
		}
		faults.push(...baseLinePinFaults(root));
		faults.push(...surfaceClosureFaults(root, out));
		faults.push(...noticeFaults(root));
		if (faults.length > 0) throw new Error(faults.join("\n"));
		fs.mkdirSync(path.join(out, "hooks"), { recursive: true });
		fs.writeFileSync(path.join(out, "hooks/hooks.json"), hooks);
	} catch (err) {
		fs.rmSync(out, { recursive: true, force: true });
		throw err;
	}
}

module.exports = {
	bareCitationFaults,
	buildTree,
	REWRITTEN,
	// for check-code-standards.js's UNSHIPPED warning (#963)
	isShipped,
};
