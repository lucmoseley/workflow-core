const fs = require("node:fs");
const path = require("node:path");
const { builtinModules } = require("node:module");
const { ENTRY, renderAt } = require("./plugin-hooks-render.js");
const {
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
const { JS_SPEC, jsSpecifier } = require("./file-reach.js");
const { surfaceClosureFaults } = require("./surface-closure.js");
const { escapeRe, requiredGroup } = require("./regex-group.js");
const { isUnder } = require("./is-under.js");
const { STANDARDS_DOCS, parseBasePaths } = require("./primitives-table.js");
const { readText } = require("./file-read.js");
const { MIGRATIONS_DIR } = require("./workflow-core-config.js");
const { isCollectedTestOrConftest } = require("./test-kind.js");
const { noticeFaults } = require("./vendored-notices.js");
const { trimStartRun } = require("./trim-run.js");
const { CORE_DOCS } = require("./core-docs.js");

const PRACTICE_DIR = "docs/practice";
const CORE_ONLY_PRACTICE = "\n## In workflow-core\n";

const COPIED = [
	".claude-plugin/plugin.json",
	".claude-plugin/marketplace.json",
	".claude/output-styles",
	...CORE_DOCS,
	".claude/agents",
	".claude/skills",
	"scripts",
	"docs/agents",
	"docs/effort-guide.md",
	PRACTICE_DIR,
	"docs/practice-crafts.md",
	"docs/environment.md",
	/* #5499 */
	"docs/environment-incidents.md",
	STANDARDS_DOCS.base,
	"docs/comment-kinds.md",
	".husky",
	"ruff.toml",
	MIGRATIONS_DIR,
	ENTRY,
];
const LEFT_BEHIND_CLASS = /^scripts\/(measure[-_]|bench_|probe-|sample_)/;
const LEFT_BEHIND = new Set([
	"scripts/check-surface-contract.js",
	"scripts/generate-plugin-tree.js",
	"scripts/lib/plugin-tree.js",
	"scripts/lib/release-tags.js",
	"scripts/lib/surface-closure.js",
	"scripts/release-contains.js",
	"scripts/release-plugin.js",
	"scripts/idle-maxworkers-bench.sh",
	"scripts/snapshot-memory.sh",
	"scripts/typecheck-mods.js",
	".claude/skills/new-repo",
]);
const KEPT = new Set([
	"scripts/measure-turn-band.js",
	"scripts/bench_suite_concurrency.py",
	"scripts/measure-bundle-cost.js",
	"scripts/measure-session-cost.js",
	"scripts/measure-outcome-review.js",
	"scripts/measure-ticket-mix.js",
]);
/**
 * @param {string} rel
 * @returns {boolean}
 */
const isLeftBehind = (rel) =>
	LEFT_BEHIND.has(rel) || (LEFT_BEHIND_CLASS.test(rel) && !KEPT.has(rel));
const HOST_OWNED_DOCS = new Set([
	"docs/doc-map.md",
	"docs/roadmap-digest.md",
	"docs/called-cards.md",
	"docs/code-standards.md",
	"docs/claude-user-settings.md",
]);
const DOC_NAMES_AS_DATA = new Set([
	"scripts/lib/implement-carveout.js",
	"scripts/lib/context-budget-pathspecs.js",
	"scripts/check-adopter-boundary.js",
]);
const CITED_NOT_READ = new Set([
	"scripts/count-guard-fires.js docs/research/always-loaded-shed-candidates.md",
	".claude/workflow-core.doc-map.md docs/working-contract.md",
	".claude/workflow-core.doc-map.md docs/research/always-loaded-shed-candidates.md",
	".claude/workflow-core.doc-map.md docs/research/injected-tracker-docs-shed-candidates.md",
	"docs/agents/rules/README.md docs/research/always-loaded-shed-candidates.md",
	"docs/practice/code-refactoring-and-architecture.md docs/research/hexagonal-testing.md",
]);
const PROSE_FILE = /\.(md|txt)$/;
const VITEST_LOADED = new Set([
	"scripts/vitest-pass-reporter.ts",
	"scripts/vitest-inflight-reporter.ts",
	"scripts/vitest-tree-watch.ts",
]);
const MOD_TS =
	/^\.claude\/skills\/([^/]+)\/(?:hooks|types)\/(?:[^/]+\/)*[^/]+\.tsx?$/;
const MOD_STANDALONE_CONFIG =
	/^\.claude\/skills\/([^/]+)\/(?:tsconfig\.json|hooks\/hooks\.json)$/;
const MOD_CONTRACT = /^\.claude\/skills\/([^/]+)\/types\/index\.d\.ts$/;
const HOST_CONTRACT = "types/index.d.ts";
const ENGINE = "claude-code";
const TYPE_ONLY_ENGINE = new RegExp(
	`\\bimport\\s+type\\s+(?:\\{[^}]*\\}|[\\w$]+|\\*\\s+as\\s+[\\w$]+)\\s+from\\s+["']${ENGINE}["']`,
	"g",
);
const SKIPPED_DIRS = new Set(["__pycache__", "fixtures", "node_modules"]);
const REWRITTEN = /^\.claude\/skills\/.*\.md$/;
const SKIPPED_FILE =
	/\.[cm]?tsx?$|^__precommit-gate-harness-test-fixture-\d+\.js$/;

const shellVar = (/** @type {string} */ name) => `\${${name}}`;
const PLUGIN_ROOT = shellVar("CLAUDE_PLUGIN_ROOT");
const SKILL_DIR = shellVar("CLAUDE_SKILL_DIR");
const EDGE = "(?<![\\w./$}-])";
const SKILLS_PATH = new RegExp(`${EDGE}\\.claude/skills/`, "g");
const SCRIPTS_PATH = new RegExp(
	`${EDGE}(?:\\./)?scripts/([\\w*.-][\\w*./-]*)`,
	"g",
);
const DOC_POINTER = new RegExp(
	`${EDGE}docs/((?:research/|adr/)?[\\w-]+\\.md)(?![\\w/-])`,
	"g",
);

/**
 * @param {string} body
 * @param {{root: string, skillDir: string | null}} at
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
 * @param {string} manifest
 * @returns {string}
 */
function readPluginName(manifest) {
	const { name } = JSON.parse(fs.readFileSync(manifest, "utf8"));
	if (!name) throw new Error(`${manifest} names no plugin`);
	return name;
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {RegExp} [shape]
 * @returns {string | null}
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
 * @param {string} name
 * @returns {string}
 */
const quotedName = (name) => `(["'])${escapeRe(name)}\\1`;

/**
 * @param {string} text
 * @param {number} i
 * @returns {number}
 */
function skippedTo(text, i) {
	const two = text.slice(i, i + 2);
	if (two === "//") return text.indexOf("\n", i);
	if (two === "/*") {
		const end = text.indexOf("*/", i + 2);
		return end < 0 ? -1 : end + 1;
	}
	const q = text[i];
	if (q !== '"' && q !== "'" && q !== "`") return i;
	let j = i + 1;
	while (j < text.length && text[j] !== q) j += text[j] === "\\" ? 2 : 1;
	return j < text.length ? j : -1;
}

/**
 * @param {string} text
 * @param {number} open
 * @returns {number}
 */
function closingBrace(text, open) {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const end = skippedTo(text, i);
		if (end < 0) return -1;
		if (end !== i) i = end;
		else if (text[i] === "{") depth++;
		else if (text[i] === "}" && --depth === 0) return i;
	}
	return -1;
}

/**
 * @param {string} text
 * @param {string} mod
 * @returns {{ exports: string, isState: boolean, members: string | null, isUnterminated?: boolean }}
 */
function splitContract(text, mod) {
	const declare = new RegExp(
		`\\bdeclare\\s+module\\s+${quotedName(ENGINE)}\\s*\\{`,
	).exec(text);
	if (!declare) return { exports: text, isState: false, members: null };
	const exports = text.slice(0, declare.index);
	const unterminated = {
		exports,
		isState: true,
		members: null,
		isUnterminated: true,
	};
	const end = closingBrace(text, declare.index + declare[0].length - 1);
	if (end < 0) return unterminated;
	const block = text.slice(declare.index, end + 1);
	const key = new RegExp(`${quotedName(mod)}\\s*:\\s*\\{`).exec(block);
	if (!key) return { exports, isState: true, members: null };
	const open = key.index + key[0].length - 1;
	const close = closingBrace(block, open);
	if (close < 0) return unterminated;
	return { exports, isState: true, members: block.slice(open + 1, close) };
}

/**
 * @param {string} members
 * @returns {string}
 */
function topLevelOf(members) {
	let flat = "";
	let depth = 0;
	for (let i = 0; i < members.length; i++) {
		const end = skippedTo(members, i);
		if (end < 0) break;
		const piece = pieceAt(members, i, end);
		if (piece === "{") depth++;
		else if (piece === "}") depth--;
		else if (depth === 0 || piece === "\n") flat += piece;
		i = end;
	}
	return flat;
}

/**
 * @param {string} text
 * @param {number} i
 * @param {number} end
 * @returns {string}
 */
const pieceAt = (text, i, end) => {
	if (end === i) return text.charAt(i);
	return text[i] === "/" ? "\n" : text.slice(i, end + 1);
};

/**
 * @param {string} members
 * @returns {string[]}
 */
function parseMemberKeys(members) {
	return topLevelOf(members)
		.split(/[;\n]/)
		.flatMap((line) => line.match(/^\s*["']?([\w$]+)["']?\??\s*:/)?.[1] ?? []);
}

/**
 * @param {string} text
 * @param {string} rel
 * @param {{ mod: string, host: string }} names
 * @returns {{ text: string, faults: string[] }}
 */
function renameStateOwner(text, rel, { mod, host }) {
	if (MOD_CONTRACT.test(rel)) {
		return { text: splitContract(text, mod).exports, faults: [] };
	}
	if (/\binterface\s+PluginState\b/.test(text)) {
		return {
			text,
			faults: [
				`${rel} declares PluginState outside types/index.d.ts, the one contract the release composes under ${host}, so it would ship under ${mod}'s own name (#3251)`,
			],
		};
	}
	const out = text.replace(
		new RegExp(`(?<=\\bplugin\\s*:\\s*)${quotedName(mod)}`, "g"),
		(_whole, q) => `${q}${host}${q}`,
	);
	if (
		/\$\.state\./.test(out) &&
		!new RegExp(`\\bplugin\\s*:\\s*${quotedName(host)}`).test(out)
	) {
		return {
			text: out,
			faults: [
				`${rel} calls $.state with no \`plugin: "${mod}"\` ref to rename to ${host}, so it would ship owning no state the engine accepts (#903 F8)`,
			],
		};
	}
	return { text: out, faults: [] };
}

/**
 * @param {string} root
 * @param {string} dir
 * @returns {{ rel: string, mod: string, exports: string, members: string | null, isUnterminated?: boolean } | null}
 */
function readStateContract(root, dir) {
	const rel = `.claude/skills/${dir}/types/index.d.ts`;
	const mod = readModOf(root, rel, MOD_CONTRACT);
	if (!mod || !fs.existsSync(path.join(root, rel))) return null;
	const split = splitContract(
		fs.readFileSync(path.join(root, rel), "utf8"),
		mod,
	);
	return split.isState ? { rel, mod, ...split } : null;
}

/**
 * @param {Map<string, string>} ownerOf
 * @param {string} members
 * @param {string} rel
 * @param {string | undefined} host
 * @returns {string[]}
 */
function claimKeys(ownerOf, members, rel, host) {
	return parseMemberKeys(members).flatMap((key) => {
		const other = ownerOf.get(key);
		ownerOf.set(key, rel);
		return other
			? [
					`${rel} and ${other} both declare the state key ${key}, which the release composes under ${host} as one (#3251)`,
				]
			: [];
	});
}

/**
 * @param {string} root
 * @returns {{ text: string | null, faults: string[] }}
 */
function composeHostContract(root) {
	const manifest = path.join(root, ".claude-plugin/plugin.json");
	const skills = path.join(root, ".claude/skills");
	/** @type {string[]} */
	const faults = [];
	/** @type {string[]} */
	const exports = [];
	/** @type {string[]} */
	const members = [];
	/** @type {Map<string, string>} */
	const ownerOf = new Map();
	const dirs = fs.existsSync(skills) ? fs.readdirSync(skills).sort() : [];
	/** @type {string | undefined} */
	let host;
	for (const dir of dirs) {
		const split = readStateContract(root, dir);
		if (!split) continue;
		const { rel, mod } = split;
		host ??= readPluginName(manifest);
		if (split.members === null) {
			faults.push(
				split.isUnterminated
					? `${rel} opens a brace in its \`declare module\` block that never closes (#3251)`
					: `${rel} declares no PluginState key "${mod}" to compose under ${host} (#903 F8)`,
			);
		} else {
			faults.push(...claimKeys(ownerOf, split.members, rel, host));
			exports.push(split.exports.trim());
			members.push(trimStartRun(split.members, "\n").trimEnd());
		}
	}
	if (members.length === 0) return { text: null, faults };
	const { types } = JSON.parse(fs.readFileSync(manifest, "utf8"));
	if (types !== `./${HOST_CONTRACT}`)
		faults.push(
			`.claude-plugin/plugin.json names "types": ${JSON.stringify(types)}, not the composed ./${HOST_CONTRACT}, so the engine reads no mod's state (#3251)`,
		);
	const text = `${exports.filter(Boolean).join("\n\n")}

declare module "${ENGINE}" {
	interface PluginState {
		"${host}": {
${members.join("\n")}
		};
	}
}
`;
	return { text, faults };
}

/**
 * @param {string} root
 * @param {string} rel
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
 * @param {string} root
 * @param {string} rel
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
 * @param {string} root
 * @param {string} text
 * @returns {string[]}
 */
function baseLinePinFaults(root, text) {
	const stranded = parseLinePins(text).flatMap((p) => {
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
				`${STANDARDS_DOCS.base} carries line pins the release refuses, so an adopter reading it finds no evidence: ${stranded.join("; ")} — ${BASE_LINE_PIN_REMEDY} (#961)`,
			];
}

/**
 * @param {string} root
 * @param {string} text
 * @returns {string[]}
 */
function basePrimitivesFaults(root, text) {
	const parsed = parseBasePaths(text);
	if ("unreadable" in parsed)
		return [
			`${STANDARDS_DOCS.base}'s primitives table cannot be read, so no row's paths were judged: ${parsed.unreadable} (#4189)`,
		];
	const unshipped = parsed.paths
		.filter(({ rel }) => !isShipped(root, rel))
		.map(({ line, rel }) => `\`${rel}\` (line ${line})`);
	return unshipped.length === 0
		? []
		: [
				`${STANDARDS_DOCS.base}'s primitives table names paths the release does not carry: ${unshipped.join("; ")} — name a file the release ships (#4156)`,
			];
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function baseFaults(root) {
	const read = readText(path.join(root, STANDARDS_DOCS.base));
	if (read.state === "absent") return [];
	if (read.state === "unreadable") throw read.error;
	const text = read.data;
	return [
		...baseLinePinFaults(root, text),
		...basePrimitivesFaults(root, text),
	];
}

/** @param {string} body */
function dropCoreOnlyPractice(body) {
	const at = body.indexOf(CORE_ONLY_PRACTICE);
	return at === -1 ? body : `${body.slice(0, at).trimEnd()}\n`;
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {string} body
 * @returns {{ text: string, faults: string[] }}
 */
function buildShippedText(root, rel, body) {
	if (rel.startsWith(`${PRACTICE_DIR}/`))
		return { text: dropCoreOnlyPractice(body), faults: [] };
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
			`${rel}:${c.line} prints #${c.n} outside a ( … ) on its line, so it ships bare and names the adopter's own issue — bracket it, or put a \`bare-citation-exempt: #N\` comment, an issue saying why, on the line above`,
	);

/**
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
 * @param {string} root
 * @param {string} rel
 * @param {string} text
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
 * @param {string} root
 * @param {string} rel
 * @returns {string[]}
 */
function bareCitationFaults(root, rel) {
	if (!buildCitableLineTest(rel) || !isShipped(root, rel)) return [];
	const body = fs.readFileSync(path.join(root, rel), "utf8");
	return citationFaults(buildShippedText(root, rel, body).text, rel);
}

/**
 * @typedef {object} Walk
 * @property {string} out
 * @property {string[]} faults
 * @property {Set<string>} walking
 */

/**
 * @param {string} root
 * @param {string} rel
 * @param {Walk} walk
 */
function copyEntry(root, rel, walk) {
	if (isSkipped(root, rel)) return;
	const src = path.join(root, rel);
	let stat;
	try {
		stat = fs.statSync(src);
	} catch (err) {
		if (!fs.lstatSync(src).isSymbolicLink()) throw err;
		walk.faults.push(`${rel} is a symlink that resolves to no file`);
		return;
	}
	if (stat.isDirectory()) copyDir(root, rel, walk);
	else copyFile(root, rel, walk, stat.mode);
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {Walk} walk
 */
function copyDir(root, rel, walk) {
	const src = path.join(root, rel);
	const real = fs.realpathSync(src);
	if (walk.walking.has(real)) return;
	const inner = { ...walk, walking: new Set(walk.walking).add(real) };
	for (const child of fs.readdirSync(src).sort()) {
		copyEntry(root, path.join(rel, child), inner);
	}
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {Walk} walk
 * @param {number} mode
 */
function copyFile(root, rel, { out, faults }, mode) {
	const dest = path.join(out, rel);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	const body = fs.readFileSync(path.join(root, rel));
	if (JS_TS_FILE.test(path.basename(rel))) {
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
	fs.chmodSync(dest, mode & 0o777);
}

/**
 * @param {string} root
 * @param {string} out
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
				copyEntry(root, rel, { out, faults, walking: new Set() });
			}
		}
		const contract = composeHostContract(root);
		faults.push(...contract.faults);
		if (contract.text !== null)
			faults.push(...citationFaults(contract.text, HOST_CONTRACT));
		faults.push(...baseFaults(root));
		faults.push(...surfaceClosureFaults(root, out));
		faults.push(...noticeFaults(root));
		if (faults.length > 0) throw new Error(faults.join("\n"));
		fs.mkdirSync(path.join(out, "hooks"), { recursive: true });
		fs.writeFileSync(path.join(out, "hooks/hooks.json"), hooks);
		if (contract.text !== null) {
			fs.mkdirSync(path.join(out, path.dirname(HOST_CONTRACT)), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(out, HOST_CONTRACT),
				qualifyCitations(contract.text, HOST_CONTRACT),
			);
		}
	} catch (err) {
		fs.rmSync(out, { recursive: true, force: true });
		throw err;
	}
}

module.exports = {
	bareCitationFaults,
	buildTree,
	REWRITTEN,
	isShipped,
	COPIED,
	HOST_OWNED_DOCS,
	KEPT,
	LEFT_BEHIND,
};
