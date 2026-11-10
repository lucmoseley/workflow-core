/*
 * guard-reach.js — which files a guard or script reaches, read once for every
 * reader (#4233): the registry digest (check-guard-registry.js), rule pricing
 * (lib/rule-emission.js), the census digest (lib/census-digest.js), the
 * test-isolation check (check-guard-test-isolation.js) and test selection's
 * launch hop (lib/test-read-edges.js, #4567).
 *
 * A REGEX READER, NOT TYPESCRIPT'S: the registry check runs on every commit
 * and loading TypeScript would slow each one (#4233).
 *
 * Residuals: a `require(` whose call is split across lines is no edge, as
 * requires are read a line at a time; a require inside a
 * template literal is one.
 */

const path = require("node:path");
const { MANIFEST_REL, coresOf, hostOf } = require("./guard-cores.js");
const {
	PROGRAM_SUFFIXES,
	parseProgramRuns,
	parseProgramVars,
} = require("./line-scan.js");
const { escapeRe, requiredGroup } = require("./regex-group.js");
const { shellOperands } = require("./shell-operands.js");
const {
	directRuleCounts,
	emissionMatches,
	RULE_ARG_RE,
} = require("./rule-emission-calls.js");
const { RULES_DIR } = require("./rule-text.js");
const { isUnder } = require("./is-under.js");

/** The dispatcher's kit, which loads its cores by manifest path (#2786). */
const DISPATCH_KIT = "scripts/lib/guard-dispatch.js";

/**
 * @typedef {"source" | "require" | "run" | "launch" | "manifest-core" | "host" | "rule-file"} EdgeKind
 * @typedef {{ kind: EdgeKind, to: string, bindings?: string[] }} Edge `to` is
 *   a path from the repo root; `bindings` are the names a destructuring
 *   require binds
 * @typedef {object} ReadOpts
 * @property {(rel: string) => boolean} [isFile] whether a path is in the tree
 *   read; where a spelling has two readings it picks the first there, and
 *   without it the first
 * @property {() => import("./guard-cores.js").Manifest | null} [manifest] the
 *   dispatch manifest, which `manifest-core` and `host` edges read, asked
 *   for only where one is wanted
 * @property {Iterable<EdgeKind>} [kinds] the kinds wanted, all by default
 */

const ALL_KINDS = /** @type {EdgeKind[]} */ ([
	"source",
	"require",
	"run",
	"launch",
	"manifest-core",
	"host",
	"rule-file",
]);

/**
 * A `source` or `.` command's argument, to the end of its command: at a line
 * start or after a blank or `;&|(`.
 */
const SOURCE_RE = /(?:^|[\s;&|(])(?:source|\.)[ \t]+([^;&|\n]+)/gm;

/**
 * The shell expansion in front of a sourced path, to the LAST of them —
 * `$here/`, `${BASH_SOURCE[0]%/*}/` and `$(dirname "${BASH_SOURCE[0]}")/`.
 */
const SOURCE_PREFIX_RE = /^.*[$})]\w*\//;

const SOURCED_TAIL_RE = /^[\w.-]+(?:\/[\w.-]+)*\.sh$/;

const REQUIRE_RE = /\brequire\(\s*["'](\.\.?\/[\w./-]+)["']\s*\)/g;

/*
 * A program's path assigned to a variable the guard then runs (#2487),
 * `lib="$here/lib/x.js"` and then `node "$lib"`, or a `.sh` run by `bash`
 * or `sh` (#4730). Self-relative, as parseProgramRuns' path is.
 */
const VAR_PATH_RE = new RegExp(
	`^[ \\t]*(?:local\\s+|readonly\\s+)?(\\w+)="?\\$[^\\n]*?\\/([\\w-][\\w./-]*(?:${PROGRAM_SUFFIXES.map(escapeRe).join("|")}))"?[ \\t]*(?:#[^\\n]*)?$`,
	"gm",
);

/**
 * A script a shell line launches: after `node`, `bash`, `sh` or `exec`, or in
 * command position, a path to a `.js` or `.sh` file, through an optional
 * `$var/`, `${var:-x}/` or `$(dirname "$0")/` prefix (captured) or a
 * root-relative literal.
 */
const LAUNCH_RE =
	/(?:(?:^|[\s;|&(`])(?:node|bash|sh|exec)[ \t]+|(?:^|[;|&(`]|\$\()[ \t]*)["']?(?<dirVar>(?:\$\{[A-Za-z_][A-Za-z0-9_]*(?:[:%#][^}"'\s]*)?\}|\$[A-Za-z_][A-Za-z0-9_]*|\$\(dirname\s+"?\$(?:0|\{?BASH_SOURCE(?:\[0\])?\}?)"?\))\/)?(?<tail>(?:\.\/)?[A-Za-z0-9_./-]+\.(?:[mc]?js|sh))["']?(?=[\s;|&)`]|$)/gm;

/**
 * The edges of the file at `rel` whose text is `text`, in the order read.
 *
 * - `source`: each shell `source` or `.` of a `.sh` path, resolved against
 *   the file's own directory, then, for a `scripts/…` or `lib/…` spelling,
 *   against the root or scripts/ (`. "$root/scripts/lib/x.sh"` from .husky/).
 *   An absolute path, one escaping the root and one still holding a variable
 *   yield nothing. A `#` comment is skipped.
 * - `require`: each relative require, `.js` added where no extension is
 *   spelt (#3795). One on a `//` line or a `*` comment line is skipped.
 * - `run`: each program a shell guard runs self-relatively by `node`,
 *   `bash` or `sh` (#4730), `node "$here/x.js"` or through a variable
 *   (#2487), resolved against its own directory, then the root.
 * - `launch`: each `.js` or `.sh` a shell file runs by `node`, `bash`, `sh`,
 *   `exec` or in command position, self-relatively or from the root, sorted
 *   (#4567). Wider than `run`, which the registry digest keeps to the
 *   self-relative runs, as a bare `node scripts/x.js` is how guards
 *   quote advice back (mantahostels#358). Only a path `isFile` holds, other
 *   than `rel` itself, is an edge.
 * - `manifest-core`: the dispatch kit's manifest and every core and host it
 *   binds.
 * - `host`: the host lib the manifest binds the core at `rel` to.
 * - `rule-file`: each rule file the text's emission calls name, readRuleParagraph's
 *   included (#4033). Read over `text` as given: a caller wanting comments
 *   ignored passes a comment-free reprint.
 *
 * @param {string} rel the file's path from the repo root
 * @param {string} text
 * @param {ReadOpts} [opts]
 * @returns {Edge[]}
 */
function parseEdges(rel, text, opts = {}) {
	const ctx = {
		rel,
		dir: path.posix.dirname(rel),
		text,
		isFile: opts.isFile ?? (() => false),
		manifest: opts.manifest ?? (() => null),
	};
	return [...new Set(opts.kinds ?? ALL_KINDS)].flatMap((kind) =>
		READERS[kind](ctx).map((to) =>
			typeof to === "string" ? { kind, to } : { kind, ...to },
		),
	);
}

/**
 * @typedef {{ rel: string, dir: string, text: string,
 *   isFile: (rel: string) => boolean,
 *   manifest: () => import("./guard-cores.js").Manifest | null }} ReadCtx
 * @type {Record<EdgeKind, (ctx: ReadCtx) => (string | { to: string, bindings?: string[] })[]>}
 */
const READERS = {
	source: ({ dir, text, isFile }) => parseSourced(dir, text, isFile),
	require: ({ dir, text }) => parseRequires(dir, text),
	run: ({ dir, text, isFile }) => parseRuns(dir, text, isFile),
	launch: ({ rel, dir, text, isFile }) => parseLaunches(rel, dir, text, isFile),
	"manifest-core": ({ rel, manifest }) => {
		const read = rel === DISPATCH_KIT ? manifest() : null;
		return read ? [MANIFEST_REL, ...coresOf(read)] : [];
	},
	host: ({ rel, manifest }) => {
		const read = rel.endsWith(".js") ? manifest() : null;
		const host = read && hostOf(read, rel);
		return host ? [host] : [];
	},
	"rule-file": ({ text }) => parseRuleFiles(text),
};

/**
 * @param {string} dir
 * @param {string} text
 * @param {(rel: string) => boolean} isFile
 * @returns {string[]}
 */
function parseSourced(dir, text, isFile) {
	/** @type {string[]} */
	const out = [];
	for (const line of shellCodeLines(text))
		for (const m of line.matchAll(SOURCE_RE)) {
			const tail = sourcedTail(requiredGroup(m, 1, SOURCE_RE));
			if (tail === null) continue;
			const to = pick(sourceCandidates(dir, tail), isFile);
			// Normalised, so a path escaping the tree is `..` or beneath it.
			if (!isUnder(to, [".."]) && !out.includes(to)) out.push(to);
		}
	return out;
}

/**
 * The path a `source` argument names once its expansion is off, or null
 * where it names no `.sh` file. Quotes come off first:
 * `"${ROOT:-.}"/scripts/lib/x.sh` puts one between the expansion and its
 * slash.
 * @param {string} arg
 * @returns {string | null}
 */
function sourcedTail(arg) {
	const [tail = ""] = arg
		.replace(/["']/g, "")
		.replace(SOURCE_PREFIX_RE, "")
		.split(/\s/, 1);
	return SOURCED_TAIL_RE.test(tail) ? tail : null;
}

/**
 * Where a sourced `tail` can be, in the order tried: the sourcing file's own
 * directory, then the root for a `scripts/…` tail or scripts/ for a `lib/…`
 * one (#4456).
 * @param {string} dir
 * @param {string} tail
 */
function sourceCandidates(dir, tail) {
	const candidates = [path.posix.join(dir, tail)];
	if (tail.startsWith("scripts/")) candidates.push(tail);
	if (tail.startsWith("lib/"))
		candidates.push(path.posix.join("scripts", tail));
	return candidates;
}

/**
 * Each line of `text` cut at a `#` comment, one opening the line or after a
 * blank: `${x#y}` is no comment.
 * @param {string} text
 */
function shellCodeLines(text) {
	return text.split("\n").map((line) => {
		const at = line.search(/(?:^|\s)#/);
		return at < 0 ? line : line.slice(0, at);
	});
}

/**
 * @param {string} dir
 * @param {string} text
 * @returns {{ to: string, bindings?: string[] }[]}
 */
function parseRequires(dir, text) {
	return liveRequires(text).map(({ spec, at }) => {
		const joined = path.posix.join(dir, spec);
		const to = path.posix.extname(joined) ? joined : `${joined}.js`;
		const bindings = destructuredBefore(text, at);
		return bindings ? { to, bindings } : { to };
	});
}

/**
 * Each relative require's specifier and where it opens. Line by line, so a require reads only its
 * own line's lead: a lead sliced per match is quadratic on one long line.
 * @param {string} text
 * @returns {{ spec: string, at: number }[]}
 */
function liveRequires(text) {
	const out = [];
	let offset = 0;
	for (const line of text.split("\n")) {
		const comment = /^\s*(?:\/\*|\*)/.test(line) ? 0 : line.indexOf("//");
		for (const m of line.matchAll(REQUIRE_RE)) {
			const at = m.index ?? 0;
			if (comment < 0 || comment > at)
				out.push({ spec: requiredGroup(m, 1, REQUIRE_RE), at: offset + at });
		}
		offset += line.length + 1;
	}
	return out;
}

/**
 * The names a `{ … } = ` just before `at` binds, or null where the require
 * is not destructured. Read backwards by hand, so each require reads only
 * its own declaration.
 * @param {string} text
 * @param {number} at
 * @returns {string[] | null}
 */
function destructuredBefore(text, at) {
	let i = at - 1;
	while (i >= 0 && /\s/.test(text[i] ?? "")) i--;
	if (text[i] !== "=") return null;
	i--;
	while (i >= 0 && /\s/.test(text[i] ?? "")) i--;
	if (text[i] !== "}") return null;
	/* Back to the nearest brace either way, so no stretch is read twice. */
	let open = i - 1;
	while (open >= 0 && text[open] !== "{" && text[open] !== "}") open--;
	if (text[open] !== "{") return null;
	return text.slice(open + 1, i).match(/[A-Za-z_$][\w$]*/g) ?? [];
}

/**
 * @param {string} dir
 * @param {string} text
 * @param {(rel: string) => boolean} isFile
 * @returns {string[]}
 */
function parseRuns(dir, text, isFile) {
	/** A `//` before `node` makes a JS line dead. */
	/** @param {{prefix: string, value: string}[]} matches */
	const live = (matches) => matches.filter((m) => !m.prefix.includes("//"));
	/** @type {Map<string, string[]>} */
	const assigned = new Map();
	for (const m of text.matchAll(VAR_PATH_RE)) {
		const name = requiredGroup(m, 1, VAR_PATH_RE);
		assigned.set(name, [
			...(assigned.get(name) ?? []),
			requiredGroup(m, 2, VAR_PATH_RE),
		]);
	}
	const tails = [
		...live(parseProgramRuns(text)).map((m) => m.value),
		...live(parseProgramVars(text)).flatMap((m) => assigned.get(m.value) ?? []),
	];
	/* The root reading is offered only for a scripts/ tail, the one a run
	 * from the root can name: elsewhere it could only displace the sibling,
	 * and in the core walk it would probe the plugin cache's root (#3144). */
	return [
		...new Set(
			tails.map((tail) => {
				const root = path.posix.normalize(tail);
				const sibling = path.posix.join(dir, tail);
				return pick(
					root.startsWith("scripts/") ? [sibling, root] : [sibling],
					isFile,
				);
			}),
		),
	];
}

/**
 * Read over `shellOperands` with every quoted string kept: the lexer does not
 * nest quotes, so `"$(x | node "$here/y.js")"` reads `" | node "` as one
 * string. A `$var/`-prefixed path resolves against the file's own directory,
 * then the root; a bare one against the root.
 * @param {string} rel
 * @param {string} dir
 * @param {string} text
 * @param {(rel: string) => boolean} isFile
 * @returns {string[]}
 */
function parseLaunches(rel, dir, text, isFile) {
	/** @type {Set<string>} */
	const out = new Set();
	for (const m of shellOperands(text, { keepQuoted: true }).matchAll(
		LAUNCH_RE,
	)) {
		const tail = requiredGroup(m, 2, LAUNCH_RE);
		const root = path.posix.join(".", tail);
		const candidates = m.groups?.dirVar
			? [path.posix.join(dir, tail), root]
			: [root];
		const hit = candidates.find(
			(c) => !isUnder(c, [".."]) && c !== rel && isFile(c),
		);
		if (hit) out.add(hit);
	}
	return [...out].sort();
}

/**
 * The rule files `text`'s emission calls and injectRules ids name, sorted.
 * @param {string} text
 * @returns {string[]}
 */
function parseRuleFiles(text) {
	const ids = new Set(directRuleCounts(text).keys());
	for (const m of emissionMatches(text))
		for (const a of (m[1] ?? "").matchAll(RULE_ARG_RE)) if (a[1]) ids.add(a[1]);
	return [...ids].sort().map((id) => `${RULES_DIR}/${id}.txt`);
}

/**
 * @param {string[]} candidates
 * @param {(rel: string) => boolean} isFile
 * @returns {string}
 */
function pick(candidates, isFile) {
	return candidates.find(isFile) ?? /** @type {string} */ (candidates[0]);
}

/**
 * @typedef {object} WalkPolicy
 * @property {readonly EdgeKind[]} follow the kinds walked through
 * @property {(edge: Edge, from: string) => boolean} [keep] which edges to
 *   walk, all by default
 * @property {Omit<ReadOpts, "kinds">} [read] the tree and manifest each
 *   file's edges resolve against
 */

/**
 * Several closures walked in lockstep, so each level of every walk reads in
 * one batch (#3411). `read` takes each walk's unread paths of a level and
 * answers each path's text, or null where it cannot be read; an unread file
 * is reached, but nothing past it.
 *
 * @param {string[][]} walks each walk's starting files
 * @param {(levels: string[][]) => (string | null)[][]} read
 * @param {WalkPolicy} policy
 * @returns {Map<string, string | null>[]} each walk's reached files, starts
 *   first, in the order reached, with their texts
 */
function walkReachAll(walks, read, policy) {
	const reached = walks.map(
		() => /** @type {Map<string, string | null>} */ (new Map()),
	);
	let levels = walks.map((starts) => [...new Set(starts)]);
	while (levels.some((l) => l.length > 0)) {
		const texts = read(levels);
		levels = levels.map((level, w) => {
			const seen = /** @type {Map<string, string | null>} */ (reached[w]);
			for (const [i, rel] of level.entries())
				seen.set(rel, texts[w]?.[i] ?? null);
			return nextLevel(level, seen, policy);
		});
	}
	return reached;
}

/**
 * The files `level`'s edges reach that `seen` lacks, each once.
 * @param {string[]} level
 * @param {Map<string, string | null>} seen every file reached, with its text
 * @param {WalkPolicy} policy
 * @returns {string[]}
 */
function nextLevel(level, seen, policy) {
	const keep = policy.keep ?? (() => true);
	/** @type {Set<string>} */
	const next = new Set();
	for (const rel of level) {
		const text = seen.get(rel);
		if (text == null) continue;
		const edges = parseEdges(rel, text, {
			...policy.read,
			kinds: policy.follow,
		});
		for (const edge of edges)
			if (!seen.has(edge.to) && keep(edge, rel)) next.add(edge.to);
	}
	return [...next];
}

/**
 * One closure, walkReachAll's single walk.
 *
 * @param {string[]} starts
 * @param {(paths: string[]) => (string | null)[]} read
 * @param {WalkPolicy} policy
 * @returns {Map<string, string | null>}
 */
function walkReach(starts, read, policy) {
	const [only] = walkReachAll(
		[starts],
		(levels) => levels.map((paths) => read(paths)),
		policy,
	);
	return /** @type {Map<string, string | null>} */ (only);
}

module.exports = {
	parseEdges,
	walkReach,
	walkReachAll,
};
