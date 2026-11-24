const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { manifestAt, readManifest } = require("./guard-cores.js");
const { COMMENT_LEAD, parseHeaderLines } = require("./guard-header.js");
const { parseEdges } = require("./guard-reach.js");
const {
	IMPLICIT_MANIFEST,
	implicitRowIn,
} = require("./registry-anchors-file.js");
const { isTreeMember } = require("./tree-members.js");

// guess, workflow-core#4901
const DIGEST_CHARS = 16;

/**
 * @param {string} base
 * @param {string} rel
 * @param {string} text
 * @param {boolean} withRuns
 */
function sourcedBy(base, rel, text, withRuns) {
	const { deps, runs } = parsedSources(base, rel, text);
	return withRuns ? [...deps] : deps.filter((p) => !runs.has(p));
}

/**
 * @param {string} base
 * @param {string} rel
 * @param {string} text
 */
function parsedSources(base, rel, text) {
	const key = `${base}\0${rel}`;
	const known = sourcedCache.get(key);
	if (known?.text === text) return known;
	const header = parseHeaderLines(text);
	const parsed = {
		text,
		...parseSourcedBy(base, rel, text),
		named: isGateStack(header)
			? headerNamed(header).filter((p) => isTreeMember(base, p))
			: null,
	};
	sourcedCache.set(key, parsed);
	return parsed;
}

/** @type {Map<string, { text: string, deps: string[], runs: Set<string>, named: string[] | null }>} */
const sourcedCache = new Map();

/**
 * @param {string} base
 * @param {string} rel
 * @param {string} text
 */
function parseSourcedBy(base, rel, text) {
	const kept = parseEdges(rel, text, {
		...readOptsIn(base),
		kinds: DEP_KINDS,
	}).filter(isDep);
	const deps = [...new Set(kept.map((e) => e.to))];
	const linked = new Set(kept.filter((e) => e.kind !== "run").map((e) => e.to));
	return {
		deps,
		runs: new Set(
			kept
				.filter((e) => e.kind === "run" && !linked.has(e.to))
				.map((e) => e.to),
		),
	};
}

const DEP_KINDS = /** @type {import("./guard-reach.js").EdgeKind[]} */ ([
	"source",
	"require",
	"run",
	"manifest-core",
]);

/**
 * @param {string} base
 */
function readOptsIn(base) {
	return {
		isFile: (/** @type {string} */ p) => isTreeMember(base, p),
		manifest: () => readManifest(manifestAt(base)),
	};
}

/**
 * @param {import("./guard-reach.js").Edge} edge
 */
function isDep(edge) {
	if (edge.kind === "require")
		return edge.to.startsWith("scripts/lib/") && edge.to.endsWith(".js");
	if (edge.kind === "source") return edge.to.split("/").includes("lib");
	return edge.kind !== "run" || edge.to.startsWith("scripts/");
}

const RUNS_GATES_RE = new RegExp(
	`${COMMENT_LEAD}RUNS:[ \\t]*gates\\s*[—:-]\\s*\\S`,
);
const NAMED_SCRIPT_RE = /\bscripts\/[\w./-]+\.(?:js|sh)\b/g;

/** @param {string[]} header */
function isGateStack(header) {
	return header.some((line) => RUNS_GATES_RE.test(line));
}

/** @param {string[]} header */
function headerNamed(header) {
	return header.flatMap((line) =>
		[...line.matchAll(NAMED_SCRIPT_RE)].map((m) => m[0]),
	);
}

/**
 * @typedef {object} Digest
 * @property {string | null} digest
 * @property {Set<string>} hashed
 * @property {Set<string>} absent
 */

/**
 * @param {string} base
 * @param {string} rel
 * @returns {Digest}
 */
function digestOf(base, rel) {
	const out = { hashed: new Set(), absent: new Set() };
	const closure = hashClosure(base, rel, out, false);
	const digest =
		closure === null ? null : withImplicitRow(base, rel, closure, out);
	return { digest, ...out };
}

/**
 * @param {string} base
 * @param {string} rel
 * @param {string} closure
 * @param {{ hashed: Set<string> }} acc
 */
function withImplicitRow(base, rel, closure, acc) {
	const row = isTreeMember(base, IMPLICIT_MANIFEST)
		? implicitRowIn(base, rel)
		: null;
	if (row === null) return closure;
	acc.hashed.add(IMPLICIT_MANIFEST);
	const sorted = Object.keys(row)
		.sort()
		.map((k) => [k, row[k]]);
	return crypto
		.createHash("sha256")
		.update(closure)
		.update(`\0${JSON.stringify(sorted)}`)
		.digest("hex")
		.slice(0, DIGEST_CHARS);
}

/**
 * @param {string} base
 * @param {string} rel
 * @param {{ hashed: Set<string>, absent: Set<string> }} acc
 * @param {boolean} inStack
 * @returns {string | null}
 */
function hashClosure(base, rel, acc, inStack) {
	if (acc.hashed.has(rel)) return null;
	acc.hashed.add(rel);
	// workflow-core#4517
	if (!isTreeMember(base, rel)) return null;
	try {
		const bytes = fs.readFileSync(path.join(base, rel));
		const text = bytes.toString("utf8");
		const hash = crypto.createHash("sha256").update(bytes);
		const parsed = parsedSources(base, rel, text);
		const named = inStack ? null : parsed.named;
		const stack = inStack || named !== null;
		for (const lib of sourcedBy(base, rel, text, !stack).sort()) {
			const input = depInput(base, lib, acc, {
				stack,
				onlyRun: parsed.runs.has(lib),
			});
			if (input !== null) hash.update(input);
		}
		for (const p of named ?? []) {
			acc.hashed.add(p);
			hash.update(`\0${p}\0`);
			if (fs.existsSync(path.join(base, p)))
				hash.update(fs.readFileSync(path.join(base, p)));
		}
		return hash.digest("hex").slice(0, DIGEST_CHARS);
	} catch {
		return null;
	}
}

/**
 * @param {string} base
 * @param {string} lib
 * @param {{ hashed: Set<string>, absent: Set<string> }} acc
 * @param {{ stack: boolean, onlyRun: boolean }} how
 * @returns {string | null}
 */
function depInput(base, lib, acc, { stack, onlyRun }) {
	if (isTreeMember(base, lib))
		return `\0${lib}\0${hashClosure(base, lib, acc, stack) || ""}`;
	acc.hashed.add(lib);
	acc.absent.add(lib);
	return onlyRun ? null : `\0${lib}\0`;
}

module.exports = { DEP_KINDS, digestOf, isDep, readOptsIn };
