#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { readTrackedScripts } = require("./lib/tracked-scripts.js");
const { isJsTestFile } = require("./lib/test-kind.js");
const { inertSpans } = require("./lib/js-lex.js");

const { runCheck, errMessage } = require("./lib/check.js");
const { exemptMarker } = require("./lib/exempt-markers.js");
const { escapeRe, requiredGroup } = require("./lib/regex-group.js");
const { parseEdges } = require("./lib/guard-reach.js");
const { segmentTailMatches } = require("./lib/line-scan.js");

/** @typedef {import("./lib/check.js").Ctx} Ctx */

const EXEMPT = exemptMarker("isolation");

const INTERPRETER =
	/^(process\.execPath|"node"|"bash"|"sh"|"git"|"gh"|"npm"|"npx")$/;

const NODE_INTERPRETER = /^(process\.execPath|"node")$/;

const GUARD_LITERAL = /"([\w./-]+\.(?:sh|js))"/;

const isTestOrTsHelper = (/** @type {string} */ rel) =>
	rel.endsWith(".ts") || isJsTestFile(rel);

/**
 * @param {string} root
 * @param {string} rel
 * @param {Map<string, boolean>} cache
 * @param {Set<string>} [seen]
 * @returns {boolean}
 */
function hasFailOpenLogging(root, rel, cache, seen = new Set()) {
	const hit = cache.get(rel);
	if (hit !== undefined) return hit;
	if (seen.has(rel)) return false;
	seen.add(rel);

	let text = "";
	try {
		text = fs.readFileSync(path.join(root, rel), "utf8");
	} catch {
		cache.set(rel, false);
		return false;
	}
	const scan = { root, cache, seen };
	const answer = rel.endsWith(".js")
		? ENTRY_LOGGERS.includes(rel) ||
			(path.posix.dirname(rel) === "scripts" && hasLogErrorCall(rel, text)) ||
			hasLoggingDependency(rel, text, "require", scan)
		: parseEdges(rel, text, { kinds: ["source"] }).some((e) =>
				e.to.endsWith("/guard-log.sh"),
			) || hasLoggingDependency(rel, text, "source", scan);
	cache.set(rel, answer);
	return answer;
}

const ENTRY_LOGGERS = [
	"scripts/lib/entry-input.js",
	"scripts/lib/fail-open-logger.js",
];

const LOG_ERROR_HOSTS = new Set([
	"scripts/lib/arbiter-core.js",
	"scripts/lib/arbiter-store.js",
]);

const hasLogErrorCall = (
	/** @type {string} */ rel,
	/** @type {string} */ text,
) => {
	const inert = inertSpans(text);
	const calls = [...text.matchAll(/\blogError\s*\(/g)];
	return (
		parseEdges(rel, text, { kinds: ["require"] }).some((e) =>
			LOG_ERROR_HOSTS.has(e.to),
		) && calls.some((m) => !isInert(inert, m.index))
	);
};

/**
 * @param {string} rel
 * @param {string} text
 * @param {"require" | "source"} kind
 * @param {{ root: string, cache: Map<string, boolean>, seen: Set<string> }} scan
 */
function hasLoggingDependency(rel, text, kind, { root, cache, seen }) {
	for (const { to } of parseEdges(rel, text, { kinds: [kind] }))
		if (hasFailOpenLogging(root, to, cache, seen)) return true;
	return false;
}

function resolveGuard(/** @type {string} */ root, /** @type {string} */ name) {
	const base = path.basename(name);
	const dir = path.posix.dirname(name);
	let candidates = [`scripts/${base}`, `scripts/lib/${base}`];
	if (name.endsWith(".js"))
		candidates =
			["", ".", "..", "scripts"].includes(dir) || dir.endsWith("/scripts")
				? [`scripts/${base}`]
				: [];
	return candidates.find((rel) => fs.existsSync(path.join(root, rel))) ?? null;
}

function spawnedGuards(
	/** @type {string} */ root,
	/** @type {string} */ source,
	/** @type {Map<string, boolean>} */ cache,
) {
	const bound = boundGuards(root, source, cache);
	const inert = inertSpans(source);

	const named = new Set();
	const indirect = new Set();
	let opaque = false;
	let opaqueDirect = false;
	for (const m of source.matchAll(CALL)) {
		if (isInert(inert, m.index)) continue;
		const { node, read } = readSpawn(m, { root, bound, cache });
		for (const rel of read.named) named.add(rel);
		for (const rel of read.indirect) indirect.add(rel);
		opaque ||= read.opaque;
		opaqueDirect ||= read.opaque && !node;
	}

	const guards = [...(named.size > 0 ? named : indirect)].sort();
	return { guards, opaque, opaqueNode: opaque && !opaqueDirect };
}

const isInert = (
	/** @type {[number, number][]} */ spans,
	/** @type {number} */ index,
) => spans.some(([first, last]) => first <= index && index <= last);

const CALL =
	/\b(spawnSync|spawn|execFileSync|execFile|runInProcess|runInProcessAsync)\(\s*((?:[^,()]|\([^()]*\))*)(?:,\s*\[\s*(?:"-(?!e"|p"|-eval"|-print")[^"]*"\s*,\s*)*((?:[^,()\]]|\([^()]*\))*))?/g;

const UNREAD_SCRIPT = "args";

function readSpawn(
	/** @type {RegExpMatchArray} */ m,
	/** @type {{root: string, bound: Map<string, string>, cache: Map<string, boolean>}} */ scan,
) {
	const argv0 = requiredGroup(m, 2, CALL).trim();
	const script = m[3]?.trim();
	const nodeSpawn = NODE_INTERPRETER.test(argv0);
	const node = nodeSpawn || requiredGroup(m, 1, CALL).startsWith("run");
	const read = readCall(nodeSpawn ? script || UNREAD_SCRIPT : argv0, {
		...scan,
		bound: node ? onlyEntries(scan.bound) : scan.bound,
	});
	return { node, read };
}

const onlyEntries = (/** @type {Map<string, string>} */ bound) =>
	new Map([...bound].filter(([, rel]) => rel.endsWith(".js")));

function readCall(
	/** @type {string} */ arg,
	/** @type {{root: string, bound: Map<string, string>, cache: Map<string, boolean>}} */ scan,
) {
	const literal = literalGuards(scan.root, arg, scan.cache);
	if (literal) return { named: literal, opaque: false, indirect: [] };
	const fixed = INTERPRETER.test(arg) || /^"[^"]*"$/.test(arg);
	const hits = boundHits(arg, scan.bound);
	return {
		named: hits,
		opaque: !fixed,
		indirect: hits.length === 0 && !fixed ? [...scan.bound.values()] : [],
	};
}

function boundGuards(
	/** @type {string} */ root,
	/** @type {string} */ source,
	/** @type {Map<string, boolean>} */ cache,
) {
	const bound = new Map();
	const binding = /\b(?:const|let)\s+(\w+)\s*=\s*(?!\s)/g;
	const guardLiteral = /[^;\n]*(?<!\[)"([\w./-]+\.(?:sh|js))"/y;
	const inert = inertSpans(source);
	for (const m of segmentTailMatches(source, binding, guardLiteral, ";\n")) {
		if (isInert(inert, m.index)) continue;
		const rel = resolveGuard(root, requiredGroup(m.tail, 1, guardLiteral));
		if (rel && hasFailOpenLogging(root, rel, cache))
			bound.set(requiredGroup(m.head, 1, binding), rel);
	}
	return bound;
}

function literalGuards(
	/** @type {string} */ root,
	/** @type {string} */ arg,
	/** @type {Map<string, boolean>} */ cache,
) {
	const literal = arg.match(GUARD_LITERAL);
	if (!literal) return null;
	const rel = resolveGuard(root, requiredGroup(literal, 1, GUARD_LITERAL));
	return rel && hasFailOpenLogging(root, rel, cache) ? [rel] : [];
}

function boundHits(
	/** @type {string} */ arg,
	/** @type {Map<string, string>} */ bound,
) {
	const hits = /** @type {string[]} */ ([]);
	for (const [id, rel] of bound) {
		if (new RegExp(`\\b${id}\\b`).test(arg)) hits.push(rel);
	}
	return hits;
}

function namedGuards(
	/** @type {string} */ root,
	/** @type {string} */ source,
	/** @type {Map<string, boolean>} */ cache,
) {
	const out = new Set();
	const literals = new RegExp(GUARD_LITERAL.source, "g");
	for (const m of source.matchAll(literals)) {
		const rel = resolveGuard(root, requiredGroup(m, 1, literals));
		if (rel?.startsWith("scripts/lib/")) continue;
		if (rel && hasFailOpenLogging(root, rel, cache)) out.add(rel);
	}
	return out;
}

function importsOf(
	/** @type {string} */ rel,
	/** @type {string} */ source,
	/** @type {Set<string>} */ known,
) {
	const out = /** @type {string[]} */ ([]);
	const specifier =
		/(?:\bfrom\s*|\b(?:require|import)\(\s*)"(\.{1,2}\/[^"]+)"/g;
	for (const m of source.matchAll(specifier)) {
		const base = path.posix.join(
			path.posix.dirname(rel),
			requiredGroup(m, 1, specifier),
		);
		const hit = [base, `${base}.ts`].find((c) => known.has(c));
		if (hit) out.push(hit);
	}
	return out;
}

const LINE_COMMENT = /(^|[^:"'`])\/\//;

const stripLineComment = (/** @type {string} */ line) => {
	const m = LINE_COMMENT.exec(line);
	return m
		? line.slice(0, m.index + requiredGroup(m, 1, LINE_COMMENT).length)
		: line;
};

const stripComments = (/** @type {string} */ s) =>
	s
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map(stripLineComment)
		.join("\n");

const CONFIG_DIR_KEY = String.raw`(?:\bCLAUDE_CONFIG_DIR|["']CLAUDE_CONFIG_DIR["'])\s*`;
const KEYS_CONFIG_DIR = new RegExp(
	`${CONFIG_DIR_KEY}:(?!\\s*(?:string|undefined)\\b)`,
	"g",
);
const SETS_CONFIG_DIR = new RegExp(
	`${CONFIG_DIR_KEY}(?::(?!\\s*(?:string|undefined)\\b)|=(?!=))|\\[\\s*["']CLAUDE_CONFIG_DIR["']\\s*\\]\\s*=(?!=)|\\bstubEnv\\(\\s*["']CLAUDE_CONFIG_DIR["']\\s*,`,
);

const SETS_PROCESS_CONFIG_DIR = /\bstubEnv\(\s*["']CLAUDE_CONFIG_DIR["']\s*,/g;

const DEFINED = /\bfunction\s+(\w+)|\bconst\s+(\w+)\s*=\s*(?:async\s*)?\(/g;

function definersOf(/** @type {string} */ source, /** @type {RegExp} */ re) {
	const code = stripComments(source);
	const defs = [...code.matchAll(DEFINED)];
	const out = new Set();
	for (const m of code.matchAll(re)) {
		const def = defs.filter((d) => d.index < m.index).at(-1);
		const name = def?.[1] ?? def?.[2];
		if (name) out.add(name);
	}
	return out;
}

function redirectsThroughHelper(
	/** @type {string} */ rel,
	/** @type {string} */ source,
	/** @type {{helpers: Set<string>, sources: Map<string, string>}} */ scan,
) {
	const code = stripComments(source);
	const spreads = /\.\.\.process\.env\b|\benv:\s*process\.env\b/.test(source);
	const calls = (
		/** @type {Set<string>} */ names,
		/** @type {(name: string) => string} */ shape,
	) => [...names].some((name) => new RegExp(shape(name)).test(code));
	return importsOf(rel, source, scan.helpers).some((h) => {
		const helper = scan.sources.get(h);
		if (helper === undefined) return false;
		return (
			(spreads &&
				calls(
					definersOf(helper, SETS_PROCESS_CONFIG_DIR),
					(name) => `\\b${escapeRe(name)}\\s*\\(`,
				)) ||
			calls(
				definersOf(helper, KEYS_CONFIG_DIR),
				(name) => `\\benv:\\s*${escapeRe(name)}\\s*\\(`,
			)
		);
	});
}

function readSources(
	/** @type {Ctx} */ ctx,
	/** @type {string} */ root,
	/** @type {string[]} */ files,
) {
	const sources = /** @type {Map<string, string>} */ (new Map());
	for (const rel of files) {
		try {
			sources.set(rel, fs.readFileSync(path.join(root, rel), "utf8"));
		} catch (e) {
			return ctx.broken(
				`could not read the tracked file ${rel}: ${errMessage(e)}.`,
			);
		}
	}
	return sources;
}

function handedGuards(
	/** @type {{root: string, sources: Map<string, string>, helpers: Set<string>, cache: Map<string, boolean>}} */ scan,
) {
	const { root, sources, helpers, cache } = scan;
	const handed = new Map();
	for (const [rel, source] of sources) {
		if (helpers.has(rel)) continue;
		const imported = importsOf(rel, source, helpers);
		if (imported.length === 0) continue;
		const guards = namedGuards(root, source, cache);
		if (guards.size === 0) continue;
		for (const h of imported) {
			const set = handed.get(h) ?? new Set();
			for (const g of guards) set.add(g);
			handed.set(h, set);
		}
	}
	return handed;
}

function guardsOf(
	/** @type {string} */ rel,
	/** @type {string} */ source,
	/** @type {{root: string, helpers: Set<string>, handed: Map<string, Set<string>>, cache: Map<string, boolean>}} */ scan,
) {
	const spawned = spawnedGuards(scan.root, source, scan.cache);
	const isHelper = scan.helpers.has(rel);
	const guards = new Set(
		isHelper
			? spawned.guards.filter(
					(/** @type {string} */ g) => !g.startsWith("scripts/lib/"),
				)
			: spawned.guards,
	);
	if (isHelper && spawned.opaque) {
		for (const g of scan.handed.get(rel) ?? [])
			if (!spawned.opaqueNode || g.endsWith(".js")) guards.add(g);
	}
	return guards;
}

function shapeOf(
	/** @type {string} */ rel,
	/** @type {string} */ source,
	/** @type {{helpers: Set<string>, sources: Map<string, string>}} */ scan,
	/** @type {string[]} */ names,
) {
	return scan.helpers.has(rel)
		? {
				redirects: SETS_CONFIG_DIR.test(stripComments(source)),
				what: `${rel}, a shared test helper, spawns ${names.join(", ")}`,
				hint: "  The guards are the ones its importing tests hand it (#837); a helper must set CLAUDE_CONFIG_DIR in its own spawn env, since a value read from a caller's override is never set by a caller that passes none (#832).",
			}
		: {
				redirects:
					/CLAUDE_CONFIG_DIR/.test(source) ||
					redirectsThroughHelper(rel, source, scan),
				what: `${rel} spawns ${names.join(", ")}`,
				hint: null,
			};
}

function reportUnisolated(
	/** @type {Ctx} */ ctx,
	/** @type {string} */ rel,
	/** @type {{what: string, hint: string | null}} */ shape,
	/** @type {string[]} */ names,
) {
	ctx.fail(
		"GUARD-TEST-ISOLATION",
		`${shape.what} without setting CLAUDE_CONFIG_DIR, so a fail-open it provokes is written to the developer's live guard-errors.log (mantahostels#1452).`,
		{ file: rel, guards: names },
	);
	ctx.say(`${shape.what}.`);
	if (shape.hint) ctx.say(shape.hint);
	ctx.say(
		"  Those guards record every fail-open under CLAUDE_CONFIG_DIR (mantahostels#147), so the case's records land in the real log and read there as a guard failing in production.",
	);
	ctx.say(
		"  Fix: give the spawn env a CLAUDE_CONFIG_DIR under the case's temp directory. lib/pretool-guard-testkit.ts's `guardDirs` is the worked shape.",
	);
	ctx.say(
		"  Genuinely unable to log? Record why on an issue and put `isolation-exempt: #N` in a comment naming it; this check drops the file.",
	);
}

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "guard-test-isolation",
	usage:
		"node check-guard-test-isolation.js [--json] [--warn] [--root <dir>] [--against <rev>]",
	valueFlags: ["--root"],
	against: { profile: "guard-test-isolation", materialise: "tree" },
	run(/** @type {any} */ ctx) {
		const { root, files } = readTrackedScripts(ctx, isTestOrTsHelper);
		const cache = /** @type {Map<string, boolean>} */ (new Map());
		const checked = /** @type {string[]} */ ([]);
		const exempt = /** @type {string[]} */ ([]);

		const sources = readSources(ctx, root, files);
		const helpers = new Set(
			files.filter((/** @type {string} */ rel) => !isJsTestFile(rel)),
		);

		const handed = handedGuards({ root, sources, helpers, cache });

		for (const [rel, source] of sources) {
			const guards = guardsOf(rel, source, { root, helpers, handed, cache });
			if (guards.size === 0) continue;
			checked.push(rel);
			if (EXEMPT.test(source)) {
				exempt.push(rel);
				continue;
			}
			const names = [...guards].sort();
			const shape = shapeOf(rel, source, { helpers, sources }, names);
			if (shape.redirects) continue;
			reportUnisolated(ctx, rel, shape, names);
		}

		const data = {
			spawningTests: checked.length,
			exempt: exempt.length,
			scanned: files.length,
		};
		const tail =
			exempt.length > 0
				? `${exempt.length} exempt, the rest redirecting CLAUDE_CONFIG_DIR.`
				: "all redirecting CLAUDE_CONFIG_DIR.";
		return {
			okLine: `${checked.length} of ${files.length} scripts/ test files and helpers spawn a fail-open-logging guard — ${tail}`,
			noun: "unisolated guard test",
			data,
		};
	},
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
