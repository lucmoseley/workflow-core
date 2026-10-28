/*
 * context-budget-pathspecs.js — which paths check-context-budget.js's
 * `--against` must materialise from a revision, and the injector and settings
 * paths the checker reads at that revision and at the working tree alike.
 *
 * Its own module because the list is what the pre-commit gate's coverage and
 * the materialised trees' completeness are tested through; the checker is its
 * caller, handing materialisePathspecs to lib/check.js as `against.pathspecs`,
 * so no test reads a checker export (#1411).
 */

const fs = require("node:fs");
const path = require("node:path");
const { brokenError } = require("./check");
const { readObjectBatch } = require("./git-objects");
const { requiredGroup } = require("./regex-group");
const { CONFIG_PATH } = require("./workflow-core-config");
const { getPoolFiles } = require("./always-loaded-pool");
const { SELF_PLUGIN_HOOKS, readOwnHooks } = require("./core-hooks.js");
const { AFTER_EVENTS } = require("./hook-events.js");
const { hostRoot } = require("./host-root.js");
const { MANIFEST_REL } = require("./guard-cores.js");
const {
	CAP_SOURCE,
	WIRED_SCRIPT_RE,
	EVENT,
	registrationsOn,
	readSourcedClosure,
} = require("./rule-emission");

/** @typedef {import("./check").Ctx} Ctx */
/** @typedef {import("./core-hooks.js").Hooks} Hooks */

/** The tracked settings file: its `skillOverrides` and `enabledPlugins`, and an adopter's hook wiring. */
const SETTINGS_FILE = ".claude/settings.json";

/** The per-plugin token table, keyed by `enabledPlugins` name (mantahostels#3132). Host data, so under the host's .claude/ (#37). */
const PLUGIN_COST_TABLE = ".claude/plugin-context-cost.json";

/* The repo-relative pathspec — CAPPED_PATHSPECS' member and the name every
 * message quotes. Never joined onto `root`: the injector ships WITH the core,
 * so in a plugin install the host has no scripts/ of its own to hold it (#36).
 */
const INJECTOR = "scripts/inject-tracker-docs.sh";

/* Where the injector is actually READ from: the core's own copy, in the
 * scripts/ directory above this one, found the same way in a checkout or a
 * plugin cache. `WFC_INJECTOR_FILE` is the test-injection seam
 * (`lib/host-root.js`'s header convention) — the suite points this at a
 * fixture script instead of writing one under --root. */
const INJECTOR_FILE =
	process.env.WFC_INJECTOR_FILE ||
	path.join(__dirname, "..", "inject-tracker-docs.sh");

/**
 * The paths in the injector's `DOCS=(...)` array, given the script's text.
 *
 * @param {Ctx} ctx
 * @param {string} script
 * @returns {string[]}
 */
function docsArray(ctx, script) {
	return (
		bashArray(script, "DOCS") ??
		ctx.broken(`no DOCS=(...) array in ${INJECTOR}`)
	);
}

/**
 * The elements of a single-line, unquoted `<name>=(...)` array at column zero
 * of `script`, or null where it assigns none.
 *
 * @param {string} script
 * @param {string} name
 * @returns {string[] | null}
 */
function bashArray(script, name) {
	const re = new RegExp(`^${name}=\\(([^)]*)\\)`, "m");
	const m = script.match(re);
	if (!m) return null;
	return requiredGroup(m, 1, re).trim().split(/\s+/).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * --against: which paths a revision must be materialised from.
 * ------------------------------------------------------------------ */

/*
 * Everything the two caps can contain, bar the injected docs — those are
 * whatever the injector's DOCS array names, so they are added in a second pass
 * once that array has been read at the revision rather than assumed to live
 * anywhere in particular (mantahostels#1224). `docs/agents` stays here anyway so the common
 * case needs no second listing.
 *
 * CAPPED in the sense that an edit here can move a capped total, so this is a
 * second spelling of .husky/pre-commit's grep —
 * precommit-context-budget-gate.test.ts asserts the two agree.
 */
const CAPPED_PATHSPECS = [
	".claude/skills",
	".claude/commands",
	".claude/agents",
	/* Not itself capped — read for its `skillOverrides`, which decides whether a
	 * skill or command description is delivered at all (mantahostels#1786), and
	 * at the core for the canary its `hooks` keep (#2572). */
	SETTINGS_FILE,
	/* Not itself capped either — its `modules` decide which `ruleModule`
	 * ids a guard reaches. Absent, every module reads as off and both sides
	 * under-count alike (#1014). */
	CONFIG_PATH,
	/* The core's hook wiring, which decides which guards the event cap holds. */
	SELF_PLUGIN_HOOKS,
	INJECTOR,
	"docs/agents",
];

/*
 * Materialised but never capped: a vendored skill is a SYMLINK into here, so a
 * materialisation that left the target behind would read every vendored
 * description as 0 B and understate what the next vendor pull costs. A change
 * inside it moves no capped total, which is why the pre-commit grep does not
 * fire on it.
 */
const VENDORED_SOURCE = ".agents/skills";

/*
 * Materialised and never capped, like VENDORED_SOURCE: read at the revision so
 * `--against` prices the same plugins the working-tree run does, rather than
 * WARNing every enabled plugin unpriced for want of the table (mantahostels#3132). Under
 * `.claude/`, so .husky/pre-commit's grep fires on an edit to it, which the
 * plugin block then reports and never refuses.
 */
const MEASURED_ONLY = [VENDORED_SOURCE, PLUGIN_COST_TABLE];

/* Read at the revision so the index side judges a pool rule against the
 * entries its own commit stages (#2033). Never byte-counted. */
const { LEDGER_PATH } = require("./pool-admission.js");
const { execGit } = require("./git.js");

/**
 * The shed registers a cap refusal names, materialised only so the refusal can
 * tell whether the revision keeps them — an adopter's never does (#1673).
 * Never byte-counted.
 */
const SHED_REGISTERS = {
	pool: "docs/research/always-loaded-shed-candidates.md",
	injection: "docs/research/injected-tracker-docs-shed-candidates.md",
};

/**
 * The scripts a PreToolUse or AFTER_EVENTS hook can fire at `rev` and the libs
 * they source, plus the file RULE_CAP is assigned in.
 *
 * DERIVED AT THE REVISION rather than listed, the wiring being
 * lib/core-hooks.js's `ownHooks` to state (mantahostels#2004).
 *
 * The paths are CAPPED — the session cap contains them — so .husky/pre-commit's
 * grep must fire on them, which it does through a bare `scripts/`;
 * precommit-context-budget-gate.test.ts asserts that against this same wiring.
 *
 * FAILS CLOSED like materialisePathspecs' injector limb below: a hooks file
 * git will not show yields the cap source alone, and check-context-budget.js's
 * `sessionFigures()` then BROKENs on the guards
 * it cannot read rather than measuring a narrowed wiring as compliant.
 *
 * @param {string} rev
 * @returns {string[]}
 */
function readRuleSourcePathspecs(rev) {
	const specs = new Set([CAP_SOURCE]);
	/** @type {RegExpMatchArray[]} */
	const matches = [];
	try {
		const settings = { hooks: readOwnHooks(hostRoot(), { rev }) ?? {} };
		const manifest = readManifestAtRev(rev);
		if (manifest) specs.add(MANIFEST_REL);
		/* The module's own walk, so this list and the figure computed from it
		 * cannot disagree about which command wires which script. */
		for (const event of [EVENT, ...AFTER_EVENTS])
			for (const { commandLine } of registrationsOn(settings, event, manifest))
				matches.push(...commandLine.matchAll(WIRED_SCRIPT_RE));
	} catch {
		/* Absent, unshowable, unparseable or malformed at the revision — one case
		 * here, every one of them failing closed downstream. */
	}
	const guards = [
		...new Set(matches.map((m) => requiredGroup(m, 1, WIRED_SCRIPT_RE))),
	];
	for (const rel of guards) specs.add(rel);
	/* And the libs they source: rule-emission.js reads those into each guard's
	 * source and skips an absent one in silence, so a fetch without them drops
	 * their ids from both sides (#1120). Outside the catch above, which would
	 * turn a failed read into exactly that silence: readObjectBatch throws BROKEN. */
	/** @type {Map<string, string | null>} */
	const libs = new Map();
	const readLib = (/** @type {string} */ lib) => {
		if (!libs.has(lib)) {
			const [text] = readBlobsAt(rev, [lib]);
			if (text === undefined)
				throw brokenError(`no blob came back for ${rev}:${lib}`);
			libs.set(lib, text);
		}
		return libs.get(lib) ?? null;
	};
	for (const [i, text] of readBlobsAt(rev, guards).entries()) {
		const rel = guards[i];
		if (rel === undefined)
			throw brokenError(`a blob came back for no guard asked of ${rev}`);
		if (text !== null)
			for (const lib of readSourcedClosure(rel, text, readLib).keys())
				specs.add(lib);
	}
	return [...specs];
}

/**
 * The revision's own dispatcher rows, fetched with its guards so the figure
 * reads the cores it commits rather than the live tree's (#2924); undefined
 * where it ships no manifest.
 * @param {string} rev
 * @returns {import("./guard-cores.js").Manifest | undefined}
 */
function readManifestAtRev(rev) {
	const [rows] = readBlobsAt(rev, [MANIFEST_REL]);
	return rows ? JSON.parse(rows) : undefined;
}

/**
 * Each path's text at `rev`, null where the revision lacks it.
 *
 * @param {string} rev
 * @param {string[]} rels
 * @returns {(string | null)[]}
 */
const readBlobsAt = (rev, rels) =>
	readObjectBatch(
		rels.map((rel) => `${rev}:${rel}`),
		`${rev}'s guard sources`,
	).map((r) => (r === null ? null : r.body.toString("utf8")));

/**
 * Every pathspec but the injected docs, which only the injector's revision
 * can name.
 * @param {string} rev
 * @returns {string[]}
 */
const fixedPathspecs = (rev) => [
	...getPoolFiles(),
	...CAPPED_PATHSPECS,
	...MEASURED_ONLY,
	LEDGER_PATH,
	...Object.values(SHED_REGISTERS),
	...readRuleSourcePathspecs(rev),
];

/**
 * The pathspec `--against` fetches blobs from, resolved AT the revision.
 *
 * THE INJECTOR IS CORE, NOT HOST (#36), but `--against` in THIS repo is
 * self-hosted: the core's own history IS the host's, so `git show
 * <rev>:...` answers and is tried first — that is what lets a staged growth
 * of the injector's own bytes be materialised and caught. Only a plugin
 * install's host git, which never tracked this core file, fails there and
 * falls back to the live core copy (`INJECTOR_FILE`).
 *
 * @param {Ctx} ctx
 * @param {string} rev
 * @returns {string[]}
 */
function materialisePathspecs(ctx, rev) {
	/** @type {string} */
	let script;
	try {
		script = execGit(["show", `${rev}:${INJECTOR}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		try {
			script = fs.readFileSync(INJECTOR_FILE, "utf8");
		} catch {
			/* Every failure class lands here — a permission error, a corrupt
			 * install. The narrowed pathspec is survivable because it fails CLOSED
			 * downstream: the checker's readInjectedDocs() BROKENs on the injector it then cannot
			 * read, so a narrowed list cannot pass a commit it never measured
			 * (mantahostels#1834). */
			return fixedPathspecs(rev);
		}
	}
	return [...new Set([...fixedPathspecs(rev), ...docsArray(ctx, script)])];
}

module.exports = {
	SETTINGS_FILE,
	PLUGIN_COST_TABLE,
	SHED_REGISTERS,
	INJECTOR,
	INJECTOR_FILE,
	bashArray,
	docsArray,
	materialisePathspecs,
};
