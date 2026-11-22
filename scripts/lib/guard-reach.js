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

const DISPATCH_KIT = "scripts/lib/guard-dispatch.js";

/**
 * @typedef {"source" | "require" | "run" | "launch" | "manifest-core" | "host" | "rule-file"} EdgeKind
 * @typedef {{ kind: EdgeKind, to: string, bindings?: string[] }} Edge
 * @typedef {object} ReadOpts
 * @property {(rel: string) => boolean} [isFile]
 * @property {() => import("./guard-cores.js").Manifest | null} [manifest]
 * @property {Iterable<EdgeKind>} [kinds]
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

const SOURCE_RE = /(?:^|[\s;&|(])(?:source|\.)[ \t]+([^;&|\n]+)/gm;

const SOURCE_PREFIX_RE = /^.*[$})]\w*\//;

const SOURCED_TAIL_RE = /^[\w.-]+(?:\/[\w.-]+)*\.sh$/;

const REQUIRE_RE = /\brequire\(\s*["'](\.\.?\/[\w./-]+)["']\s*\)/g;

/**
 * @param {string} pathRe
 */
const buildVarAssignRe = (pathRe) =>
	new RegExp(
		`^[ \\t]*(?:local\\s+|readonly\\s+)?(\\w+)="?\\$([^\\n]*?)\\/(${pathRe})"?[ \\t]*(?:#[^\\n]*)?$`,
		"gm",
	);

const VAR_PATH_RE = buildVarAssignRe(
	`(?:\\.\\.\\/)*[\\w-][\\w./-]*(?:${PROGRAM_SUFFIXES.map(escapeRe).join("|")})`,
);

const VAR_DIR_RE = buildVarAssignRe(
	"(?:\\.\\.|[\\w-][\\w.-]*)(?:\\/(?:\\.\\.|[\\w-][\\w.-]*))*",
);

const LEAD_VAR_RE = /^\{?(\w+)\}?"?$/;

const LEAD_PARENT_RE = /^\{(?!BASH_SOURCE%)([A-Za-z_]\w*)%\/\*\}"?$/;

const LAUNCH_RE =
	/(?:(?:^|[\s;|&(`])(?:node|bash|sh|exec)[ \t]+|(?:^|[;|&(`]|\$\()[ \t]*)["']?(?<dirVar>(?:\$\{[A-Za-z_][A-Za-z0-9_]*(?:[:%#][^}"'\s]*)?\}|\$[A-Za-z_][A-Za-z0-9_]*|\$\(dirname\s+"?\$(?:0|\{?BASH_SOURCE(?:\[0\])?\}?)"?\))\/)?(?<tail>(?:\.\/)?[A-Za-z0-9_./-]+\.(?:[mc]?js|sh))["']?(?=[\s;|&)`]|$)/gm;

/**
 * @param {string} rel
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
			if (!isUnder(to, [".."]) && !out.includes(to)) out.push(to);
		}
	return out;
}

/**
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
	/** @template {{prefix: string}} M @param {M[]} matches */
	const live = (matches) => matches.filter((m) => !m.prefix.includes("//"));
	const dirs = parseAssignments(
		text,
		VAR_DIR_RE,
		null,
		(p) => !PROGRAM_SUFFIXES.some((s) => p.endsWith(s)),
	);
	const assigned = parseAssignments(text, VAR_PATH_RE, dirs);
	const tails = [
		...live(parseProgramRuns(text)).flatMap((m) =>
			underLead(m.lead, m.value, dirs),
		),
		...live(parseProgramVars(text)).flatMap((m) => assigned.get(m.value) ?? []),
	];
	// #3144
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
 * @param {string} lead
 * @param {string} value
 * @param {Map<string, string[]>} dirs
 * @returns {string[]}
 */
function underLead(lead, value, dirs) {
	const strippedVar = LEAD_PARENT_RE.exec(lead)?.[1];
	const name = strippedVar ?? LEAD_VAR_RE.exec(lead)?.[1];
	const up = strippedVar === undefined ? "." : "..";
	return ((name === undefined ? undefined : dirs.get(name)) ?? ["."]).map((d) =>
		path.posix.join(d, up, value),
	);
}

/**
 * @param {string} text
 * @param {RegExp} re
 * @param {Map<string, string[]> | null} dirs
 * @param {(path: string) => boolean} [keep]
 * @returns {Map<string, string[]>}
 */
function parseAssignments(text, re, dirs, keep = () => true) {
	/** @type {Map<string, string[]>} */
	const out = new Map();
	const under = dirs ?? out;
	for (const m of text.matchAll(re)) {
		const value = requiredGroup(m, 3, re);
		if (!keep(value)) continue;
		const name = requiredGroup(m, 1, re);
		const lead = requiredGroup(m, 2, re);
		out.set(name, [...(out.get(name) ?? []), ...underLead(lead, value, under)]);
	}
	return out;
}

/**
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
 * @property {readonly EdgeKind[]} follow
 * @property {(edge: Edge, from: string) => boolean} [keep]
 * @property {Omit<ReadOpts, "kinds">} [read]
 */

/**
 * @param {string[][]} walks
 * @param {(levels: string[][]) => (string | null)[][]} read
 * @param {WalkPolicy} policy
 * @returns {Map<string, string | null>[]}
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
 * @param {string[]} level
 * @param {Map<string, string | null>} seen
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
