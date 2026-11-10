/*
 * guard-digest.js — a guard's anchor digest and the closure it is read over,
 * in the tree at a base the caller hands it (workflow-core#4901). Membership is
 * lib/tree-members.js's — the index in a checkout, the disk in a materialised
 * `--root` copy — and the bytes hashed are the disk's: what a pathspec commit
 * commits (workflow-core#4508).
 *
 * A shell guard can reach its logic by RUNNING a program rather than
 * sourcing it (mantahostels#358), by `node`, `bash` or `sh` (workflow-core#4730).
 * lib/guard-reach.js follows only a self-relative run, `node "$here/x.js"`
 * or through a variable (workflow-core#2487): a hook
 * runs from an arbitrary cwd, so a guard that genuinely delegates must locate
 * its sibling from its own path, and following a bare `node scripts/x.js`
 * would tie a helper's internals to rules about something else.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { manifestAt, readManifest } = require("./guard-cores.js");
const { COMMENT_LEAD, parseHeaderLines } = require("./guard-header.js");
const { parseEdges } = require("./guard-reach.js");
const { isTreeMember } = require("./tree-members.js");

/**
 * A guard's dependencies, as paths relative to `base`: a shell guard's `source`
 * lines, a JS guard's relative `require`s, the programs it runs and the
 * dispatch kit's cores, as lib/guard-reach.js reads them.
 *
 * Only a lib/ is followed of what is sourced or required. A guard pulls in its shared library
 * and nothing else here, and widening this to arbitrary paths would start
 * resolving `$PATH` lookups and command substitutions that no regex can settle.
 * @param {string} base the tree run targets and the dispatch manifest resolve in
 * @param {string} rel
 * @param {string} text
 * @param {boolean} withRuns false leaves out what it only runs, as a gate stack's digest does
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

/**
 * sourcedBy's answers, by tree and path, each with the text it was read from.
 * Every guard's digest re-reads its whole library closure (workflow-core#4170). Keyed on
 * the text too, so a file that changes mid-run is parsed afresh.
 *
 * @type {Map<string, { text: string, deps: string[], runs: Set<string>, named: string[] | null }>}
 */
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

/** The edge kinds a digest follows. */
const DEP_KINDS = /** @type {import("./guard-reach.js").EdgeKind[]} */ ([
	"source",
	"require",
	"run",
	"manifest-core",
]);

/**
 * How a guard's edges resolve in the tree at `base`. The manifest is the
 * judged tree's and is hashed itself, so a commit that changes only a
 * manifest row moves the digest (workflow-core#3124).
 * @param {string} base
 */
function readOptsIn(base) {
	return {
		isFile: (/** @type {string} */ p) => isTreeMember(base, p),
		manifest: () => readManifest(manifestAt(base)),
	};
}

/**
 * Whether a digest follows `edge`. Only a lib/ is followed of what is sourced
 * or required, resolved first: `session-arbiter.js` reaches its store as
 * `./lib/arbiter-store.js` but the store reaches the proc leaf as
 * `./arbiter-proc.js`, already inside lib/, so the specifier alone cannot
 * say. A delegated program is a sibling under scripts/.
 * @param {import("./guard-reach.js").Edge} edge
 */
function isDep(edge) {
	if (edge.kind === "require")
		return edge.to.startsWith("scripts/lib/") && edge.to.endsWith(".js");
	if (edge.kind === "source") return edge.to.split("/").includes("lib");
	return edge.kind !== "run" || edge.to.startsWith("scripts/");
}

/*
 * A gate stack's header line `RUNS: gates — <why>` (workflow-core#4456). The programs such a
 * file runs are independent gates, each judged by its own row where a rule
 * describes it. So its digest follows what it and its libraries source and
 * require, plus the bytes alone of each scripts/ file its header names, where
 * its annotation's claims rest, and no program they only run. Undeclared files
 * still follow their run targets, as a thin wrapper's rules need
 * (mantahostels#358).
 */
const RUNS_GATES_RE = new RegExp(
	`${COMMENT_LEAD}RUNS:[ \\t]*gates\\s*[—:-]\\s*\\S`,
);
const NAMED_SCRIPT_RE = /\bscripts\/[\w./-]+\.(?:js|sh)\b/g;

/** @param {string[]} header a file's header lines */
function isGateStack(header) {
	return header.some((line) => RUNS_GATES_RE.test(line));
}

/** @param {string[]} header a file's header lines: the scripts/ paths it names */
function headerNamed(header) {
	return header.flatMap((line) =>
		[...line.matchAll(NAMED_SCRIPT_RE)].map((m) => m[0]),
	);
}

/**
 * @typedef {object} Digest
 * @property {string | null} digest null where the guard is outside the tree or a read failed
 * @property {Set<string>} hashed every path the digest read, absent ones included
 * @property {Set<string>} absent the dependencies hashed as absent from the tree:
 *   an untracked file at one moves no digest, so --review never calls it dirty
 */

/**
 * Short hex of the guard's bytes AND of every library it sources, in the tree
 * at `base`. Truncated to 16 chars: this identifies a revision to a human
 * reading a diff, it is not a security boundary.
 *
 * A shared library named in no rule itself could never be anchored
 * directly — the checker fails an anchor no rule mentions. Folding it into its
 * dependants' digests warns on every rule they enforce at once
 * (mantahostels#140).
 *
 * @param {string} base
 * @param {string} rel
 * @returns {Digest}
 */
function digestOf(base, rel) {
	const out = { hashed: new Set(), absent: new Set() };
	return { digest: hashClosure(base, rel, out, false), ...out };
}

/**
 * @param {string} base
 * @param {string} rel
 * @param {{ hashed: Set<string>, absent: Set<string> }} acc accumulator: each file hashed is added to
 *   `hashed`, so a cycle hashes once, and each dependency absent from the tree to `absent`
 * @param {boolean} inStack reached from a gate stack, so what it runs is left out
 * @returns {string | null}
 */
function hashClosure(base, rel, acc, inStack) {
	if (acc.hashed.has(rel)) return null;
	acc.hashed.add(rel);
	/* A guard outside the tree has no digest, whatever lies on disk at its
	 * path, so one commit gives one verdict in every worktree (workflow-core#4517). */
	if (!isTreeMember(base, rel)) return null;
	try {
		const bytes = fs.readFileSync(path.join(base, rel));
		const text = bytes.toString("utf8");
		const hash = crypto.createHash("sha256").update(bytes);
		const named = inStack ? null : parsedSources(base, rel, text).named;
		const stack = inStack || named !== null;
		// Sorted, so the digest does not move when the source lines are reordered.
		/* A dependency outside the tree hashes as absent, whatever lies on disk
		 * at its path (workflow-core#4508). It stays an input, so a staged removal of it reads
		 * as dirty. */
		for (const lib of sourcedBy(base, rel, text, !stack).sort()) {
			const there = isTreeMember(base, lib);
			if (!there) {
				acc.hashed.add(lib);
				acc.absent.add(lib);
			}
			hash.update(
				`\0${lib}\0${(there && hashClosure(base, lib, acc, stack)) || ""}`,
			);
		}
		/* A named file in the index but gone from disk hashes as absent,
		 * rather than nulling the stack's whole digest. */
		for (const p of named ?? []) {
			acc.hashed.add(p);
			hash.update(`\0${p}\0`);
			if (fs.existsSync(path.join(base, p)))
				hash.update(fs.readFileSync(path.join(base, p)));
		}
		return hash.digest("hex").slice(0, 16);
	} catch {
		return null; // absence is the existing BROKEN-CLAIM's business, not this one's
	}
}

module.exports = { DEP_KINDS, digestOf, isDep, readOptsIn };
