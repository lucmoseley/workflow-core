#!/usr/bin/env node
/*
 * check-guard-registry.js — every parallel-safety rule must say what backs it.
 *
 * FOUR ASSERTIONS, over four different sets.
 *
 *   1. GUARDS — a refusal. Every parallel-safety rule between the
 *      guard-registry delimiters carries a backing marker, and the marker is
 *      true. That is everything down to the reprint pass.
 *   2. IMPLICIT BEHAVIOURS (mantahostels#1261) — an action taken for a session without it
 *      asking. Every script the ACTING wiring reaches annotates itself with what
 *      it does, why, and what escape exists. See §the implicit-behaviour surface
 *      below for the derivation and why it is derived rather than listed.
 *   3. THE RULE-TEXT STORE (mantahostels#1644) — a rule whose text left this file for the
 *      guard that prints it. Every `rule:<id>` trigger in a scanned document,
 *      and every one a script's comment or string cites (mantahostels#3135), resolves to a
 *      fragment; every fragment is readable and printed by a wired emitter, and
 *      every emitter names a fragment that exists. See §the rule-text store
 *      below.
 *   4. THE `if` NARROWING (mantahostels#2212) — the settings field deciding whether a hook's
 *      script is exec'd at all. Every `if` a hook entry carries is stated in
 *      that script's own header, and every narrowing a header states is one the
 *      wiring actually carries. See §the `if` narrowing surface below.
 *
 * Usage:
 *   node scripts/check-guard-registry.js --touched-by <rev> [--root <dir>]
 *     the post-commit form: name only the anchors <rev> itself expired, and the
 *     --review line that clears each (#2375).
 *   node scripts/check-guard-registry.js [--warn] [--json] [--roster] [--root <dir>]
 *     every run names each wired implicit behaviour; --roster adds what each
 *     one does to a session and what escape it has.
 *   node scripts/check-guard-registry.js --against HEAD
 *     the pre-commit form: refuse only the faults the INDEX has that HEAD does
 *     not — a stale row among them (#2617). The convention: scripts/lib/check.js
 *     (mantahostels#1833).
 *   node scripts/check-guard-registry.js --against <tip> --head <sha>
 *     the pre-push form: refuse only the faults <sha>'s tree has that <tip>'s
 *     does not (scripts/landing-registry-gate.js, #3074).
 *   node scripts/check-guard-registry.js --review [<path>…]
 *     re-anchor the named paths after re-reading what this file records about
 *     each — the rules describing a guard, a wired script's own annotation, or
 *     both — dropping a named path neither reaches. With no path, re-anchors
 *     everything either assertion reaches and drops entries for paths neither
 *     does. Reports in prose, never JSON, and
 *     checks nothing. A target a live neighbour holds dirty is skipped, never
 *     anchored (mantahostels#2636).
 *
 * THE PROBLEM (mantahostels#112, ruled by mantahostels#102).
 * CLAUDE.md rules read with uniform authority while having wildly different
 * backing: some a hook denies, some nothing enforces, and some no mechanism
 * can check.
 *
 * THE FIX. Each rule in a delimited region carries exactly one status marker,
 * and this script fails any rule carrying none. The load-bearing half is that it
 * also fails a marker that LIES (mantahostels#102): a stale "enforced by
 * scripts/guard-x.sh" claims protection that is not there.
 *
 * THE REGION. Rules are annotated where they are read, not in a separate table.
 * A table elsewhere leaves the page a session actually meets just as
 * undifferentiated, and adds a second surface to drift. Scope is therefore
 * whatever sits between:
 *
 *     <!-- guard-registry:begin -->
 *     <!-- guard-registry:end -->
 *
 * anywhere in CLAUDE.md, AGENTS.md, or a Markdown file under docs/ or .claude/.
 * Widening scope to another document means dropping the delimiters in; no
 * change here.
 *
 * A RULE is a top-level list item inside a region. Indented sub-bullets are
 * continuation of their parent and take its marker: the pathspec rule's four
 * sub-cases share one enforcement story, and marking each separately would be
 * four places to go stale instead of one.
 *
 * WHAT EACH MARKER MUST CARRY:
 *
 *   **Enforced**       names at least one guard path, in backticks. Every such
 *                      path must (a) exist and (b) be WIRED — reachable from
 *                      the repo's hook registration (lib/core-hooks.js), a
 *                      .husky hook, a workflow, or a package.json script.
 *   **Advisory**       names at least one guard path, in backticks, under the
 *                      same exist-and-wired test — a guard that observes the
 *                      rule and SPEAKS, and never refuses (#173). It may also
 *                      name the issue owning a deterministic replacement, and
 *                      is never faulted for naming none: the replacement may
 *                      be inconceivable.
 *   **Unenforced**     names the issue that owns building the guard: nothing
 *                      wired makes the rule hold, and nothing wired warns on
 *                      its breach — that is the distance from **Advisory**.
 *                      A rule no mechanism could make hold keeps this tag
 *                      even where a hook speaks (the session ceiling,
 *                      mantahostels#2601).
 *   **Unenforceable**  nothing further.
 *
 * The exist-and-wired test is the MARKER-INDEPENDENT half (mantahostels#2347). Only
 * **Enforced** and **Advisory** must name a path — but wherever a path IS
 * named, under any marker, it is tested. An **Unenforceable** rule names one
 * where a guard hands the rule over without observing a breach of it: the push
 * cadence, printed on the first push.
 *
 * STALE PROSE (mantahostels#130). The checks above ask whether the named guard exists and is
 * wired. They never ask whether the sentence describing its BEHAVIOUR is still
 * true (mantahostels#127).
 *
 * Whether a sentence correctly describes a shell script is semantic and needs a
 * reader. What is mechanical is: HAS THE GUARD MOVED SINCE ANYONE LAST CONFIRMED
 * THE SENTENCE? So every guard path named in a region — under ANY marker, since
 * an **Unenforced** rule describes `session-arbiter.js` behaviour just as an
 * **Enforced** one describes a hook's — carries a content digest in
 *
 *     .claude/guard-registry-anchors.json
 *
 * and a differing digest WARNs, naming every rule that mentions that guard.
 *
 * Content digest, not `git log -1` on the path: CI clones shallow, so history is
 * not reliably there to read. The digest stops firing by itself when a change
 * is reverted.
 *
 * The anchors live in that sidecar, not beside each rule. A per-rule anchor
 * inside CLAUDE.md would make every guard edit an edit to the most contended
 * file in the repo — manufacturing the collision this registry sits next to.
 * Clearing a warning is one line in the sidecar: `node
 * scripts/check-guard-registry.js --review <guard-path>`, run after re-reading
 * the rules it prints.
 *
 * The full run WARNs and never touches the exit code: a row a neighbour's
 * commit left stale is no reason to fail this session's run, nor CI's. The
 * commit that ADDS a stale row is refused at pre-commit (#2617) — §the
 * pre-commit gate. No test
 * asserts the live tree has zero warnings: that would fail the suite on a row
 * the gate let through as held by a neighbour.
 *
 * SCOPE IS THE REGISTRY REGION ONLY, not every doc naming a guard
 * (mantahostels#119). Prose describing a guard it never names needs a reader, not
 * a digest; that is mantahostels#26 (does doc-map §B grow to hold claims?).
 *
 * WHY IT FAILS RATHER THAN REPORTS. The other check-*.js on this repo are
 * deliberately report-only, because each needs a human judgement to act on
 * (which card state is real, how to gloss a citation). This one does not: "you
 * claimed scripts/guard-x.sh enforces this and no such file exists" is a fact
 * about the commit, offline and deterministic.
 *
 * Outcomes follow the family alphabet in scripts/lib/check.js: a rule whose
 * stated backing is missing or false is a FAIL finding, and the three staleness
 * warnings and the REPRINTED warning are intrinsic WARN findings. Only the
 * staleness ones gate, and only under --against.
 *
 * --review is a WRITE command, not a check: it re-anchors the guards named and
 * exits before any of the reporting below.
 *
 * The scan runs INSIDE run(), not at module scope, so that an unexpected throw
 * anywhere in it lands in runCheck's catch and reports as BROKEN at exit 2. At
 * module scope the same throw escaped as a bare stack trace at exit 1 — the code
 * that means "this rule's backing is false", which is exactly the wrong answer.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const {
	readRunningHooks,
	readOwnHooks,
	ownHooksFile,
} = require("./lib/core-hooks.js");
const {
	MAX_BUFFER,
	againstRevs,
	brokenError,
	runCheck,
} = require("./lib/check");
const { CeilingPassed } = require("./lib/git-ceiling.js");
const {
	TOUCHED_BY_CEILING_MS,
	readTouchedBy,
	touchedByCeiling,
} = require("./lib/touched-by.js");
const { requiredGroup } = require("./lib/regex-group");
const { caught } = require("./lib/caught.js");
const { byCodeUnit } = require("./lib/by-code-unit.js");
const { REFUSES_COMMIT } = require("./lib/refuses-commit.js");
const {
	LANDER_REVERT_ENV,
	readLanderRevert,
	whyNotCleanRevert,
	whyNotLanderRevert,
} = require("./lib/clean-revert.js");

/*
 * The tree this check reads. `--root <dir>` points it at a materialised copy of
 * a rev rather than the worktree — `--against` re-execs this file with one on
 * each side of the comparison (scripts/lib/check.js, mantahostels#1833).
 *
 * Module-level and mutable, because every scan below is written against it and
 * they are too many to thread a root through. setRoot() is the ONE writer, and
 * runs at the top of run() before any scan reads it (mantahostels#1833, which took the flag
 * off ctx; it was read straight off process.argv until then).
 */
let root = hostRoot();

/** Whether `--root` named `root`, which is how a materialised tree arrives. */
let rootGiven = false;

/** The core's own tree — the plugin root in an adopter, this repo in the core. */
const CORE_ROOT = path.join(__dirname, "..");

/**
 * Whether the root being judged is a tree of the core's own, which is what
 * makes the CORE_ROOT fallbacks below safe to take.
 *
 * NOT "the same tree". Under `--against` `root` is a materialised index and
 * CORE_ROOT the live worktree, so falling back unconditionally would answer a
 * question about the index out of the working tree — a guard deleted from the
 * index but left on disk would stop gating.
 */
function rootIsCore() {
	return fs.existsSync(path.join(root, "scripts", "check-guard-registry.js"));
}

/** Whether the rule store in force belongs to some tree other than `root`'s. */
function foreignStore() {
	return !fs.existsSync(path.join(root, RULES_DIR));
}

/**
 * Whether fragment `id` resolves out of a store other than `root`'s own — the
 * whole store foreign, or the id only in the core's layer beneath it (#97).
 * @param {string} id
 */
function isForeignRule(id) {
	return foreignStore() || path.dirname(fragmentPath(id)) !== rulesDir();
}

/** @param {string | null} dir */
function setRoot(dir) {
	if (!dir) return;
	root = path.resolve(dir);
	rootGiven = true;
	/* lib/rule-text.js resolves the fragment store off its own __dirname, so
	 * without this --root reads the WORKTREE's fragments while everything else
	 * reads the copy — and a newly-staged unwired fragment appears in both
	 * readings, which the direction gate then calls inherited (mantahostels#1753).
	 *
	 * A CORE root without a store is left unset, so rule-text falls back to
	 * the core's own.
	 *
	 * AN ADOPTER ROOT IS ALWAYS PINNED, store or none, with the core's store
	 * layered beneath (#97). Unpinned, rule-text would read the adopter's
	 * WORKTREE store — so on the commit that first adds one, the HEAD side of
	 * --against sees the new fragments too and calls their faults inherited;
	 * and without the core layer every `rule:<id>` its rules file names reads
	 * as ORPHAN-TRIGGER. */
	const store = path.join(root, "docs", "agents", "rules");
	if (rootIsCore()) {
		delete process.env.WFC_RULES_FALLBACK_DIR;
		if (fs.existsSync(store)) process.env.WFC_RULES_DIR = store;
		return;
	}
	process.env.WFC_RULES_DIR = store;
	process.env.WFC_RULES_FALLBACK_DIR = path.join(CORE_ROOT, RULES_DIR);
}

const BEGIN = "<!-- guard-registry:begin -->";
const END = "<!-- guard-registry:end -->";

/*
 * Scanned scope: the documents that carry instructions to a session. Not the
 * same scope as scripts/check-doc-map.js, which reads `git ls-files` — this is
 * an fs walk minus the gitignored (dropIgnored below).
 */
const SCAN_ROOTS = ["CLAUDE.md", "AGENTS.md", "docs", ".claude"];

/* Directories that never hold hand-written rules and are expensive to walk. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "__pycache__"]);

/**
 * One rule bullet, or one unruled line, with the file line it sits on.
 *
 * @typedef {{ line: number, text: string }} Rule
 *
 * @typedef {{ file: string, line: number, gist: string }} RuleRef
 *
 * A gating finding. `surface` is set by the two passes that judge a script's
 * own header rather than a rule — the implicit-wiring pass and the `if`
 * narrowing pass.
 *
 * @typedef {{
 *   kind: string,
 *   file: string,
 *   line: number,
 *   rule: string,
 *   detail: string,
 *   surface?: string,
 * }} Finding
 *
 * @typedef {{
 *   kind: "UNANCHORED" | "STALE-PROSE" | "ORPHAN-ANCHOR" | "GUARD-GONE",
 *   guard: string,
 *   rules: RuleRef[],
 *   detail: string,
 *   refusesCommit?: boolean,
 * }} StaleWarning
 * @typedef {{
 *   kind: "REPRINTED",
 *   guard: string,
 *   rules: RuleRef[],
 *   detail: string,
 *   spans: { span: string, coverage: number }[],
 * }} ReprintWarning
 * @typedef {StaleWarning | ReprintWarning} Warning
 *
 * @typedef {{ triggers: string[], annotation: Record<string, string> | null }} WiredScript
 *
 * @typedef {{ holder: string, dead: boolean }} HeldEntry
 * @typedef {HeldEntry & { path: string }} HeldInput
 */

// --- collecting the documents -----------------------------------------------

/**
 * @param {string} rel
 * @param {string[]} out accumulator: each .md file under `rel` is pushed here
 */
function walk(rel, out) {
	const abs = path.join(root, rel);
	let st;
	try {
		st = fs.statSync(abs);
	} catch {
		return; // A scan root that does not exist yet is not a finding.
	}
	if (st.isFile()) {
		if (rel.endsWith(".md")) out.push(rel);
		return;
	}
	/* Deliberately unguarded. An unreadable docs/ or .claude/ is a tracked
	 * directory this check cannot read, so it must surface as BROKEN via
	 * runCheck's catch — swallowing it reports OK over scope never scanned. */
	for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) continue; // vendored skills; see doc-map §A
		if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
		walk(path.join(rel, entry.name), out);
	}
}

/**
 * What dropIgnored() did across this run, for the summary line — a fail-open,
 * a skip, an over-drop and a clean run are otherwise identical in the output. Both
 * corpora are filtered, so these accumulate, and a failure is sticky.
 */
let ignoreDropped = 0;
let ignoreFailure = "";
let ignoreSkipped = false;

/* What the declared-side loop in scanIfNarrowing() (mantahostels#2234) did with a read it
 * could not complete — same purpose as ignoreDropped above. */
let declaredIfUnreadable = 0;

/**
 * `files` minus the gitignored, or `files` unchanged where git cannot answer.
 *
 * Scratch is why. `.claude/tmp/` sits under a scan root, and CLAUDE.md
 * §Subagent dispatch sends every review and concision artefact there, so a note
 * quoting a `rule:<id>` while DISCUSSING it read as ORPHAN-TRIGGER (mantahostels#2243).
 * `.claude/worktrees/` is the same shape and worse: a full second copy of
 * CLAUDE.md, AGENTS.md and every docs/*.md.
 *
 * IGNORED, not untracked. An uncommitted new file is real scope — it
 * is one `git add` from a commit, and `--against` reads the INDEX, so a
 * `git ls-files` filter would drop it while it is still the only copy anyone
 * reads (mantahostels#2243, which measured how many).
 *
 * A TRACKED FILE CAN NEVER BE DROPPED, and that is the whole safety net: without
 * `--no-index`, `check-ignore` consults the index and refuses to call a tracked
 * path ignored, so a broad pattern someone adds to .gitignore cannot quietly
 * take a committed document out of the gate.
 *
 * NOT RUN on a materialised `--root` tree, which is in no git repo at all:
 * `git archive` wrote only tracked files into it, so there is nothing to drop
 * (#710).
 *
 * FAILS OPEN anywhere else git cannot answer, unlike walk()'s readdirSync
 * above: refusing would break the whole gate over scope that at worst adds
 * scratch to it (mantahostels#2243).
 *
 * RESIDUAL: scan scope is now machine-local. `check-ignore` reads
 * `.git/info/exclude` and `core.excludesFile` exactly as it reads .gitignore,
 * and neither is in any commit. A total drop is loud (NO-REGION), a partial one
 * is only visible in the line the caller prints.
 *
 * @param {string[]} files
 * @returns {string[]}
 */
function dropIgnored(files) {
	if (files.length === 0) return files;
	if (rootGiven && isOutsideAnyRepo(root)) {
		ignoreSkipped = true;
		return files;
	}
	const r = spawnGitSync(["-C", root, "check-ignore", "--stdin", "-z"], {
		input: `${files.join("\0")}\0`,
		encoding: "utf8",
	});
	/* `r.status` is 0 where some path was ignored and 1 where none was; both are
	 * answers. 128 is git's fatal, and a signal kill leaves it null. No git on
	 * PATH arrives as an ENOENT in `r.error` instead, status and all. */
	if (r.error || (r.status !== 0 && r.status !== 1)) {
		ignoreFailure = r.error?.message ?? `git exited ${r.status}`;
		return files;
	}
	const ignored = new Set(r.stdout.split("\0").filter(Boolean));
	ignoreDropped += ignored.size;
	return files.filter((f) => !ignored.has(f));
}

/**
 * Whether `dir` sits in no git repository, found as git's own discovery finds
 * one but on disk — so a machine with no git at all still reaches the FAILED
 * OPEN line rather than passing for a materialised tree.
 *
 * RESIDUAL: `GIT_DIR` and `GIT_CEILING_DIRECTORIES` are not read, and a
 * TMPDIR inside a checkout puts the materialised tree under a `.git`, so git
 * is asked there and answers from the enclosing repo's rules.
 * @param {string} dir
 */
function isOutsideAnyRepo(dir) {
	for (let d = dir; ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, ".git"))) return false;
		if (path.dirname(d) === d) return true;
	}
}

function scannedFiles() {
	/** @type {string[]} */
	const out = [];
	for (const r of SCAN_ROOTS) walk(r, out);
	return dropIgnored(out).sort();
}

// --- the wiring corpus ------------------------------------------------------

/*
 * Everything that can actually TRIGGER a guard. A guard is "wired" if one of
 * these invokes its path.
 *
 * Deliberately not a substring search over whole files. Two false positives a
 * raw search admits, both verified: a workflow line reading
 * "# TODO: one day wire scripts/guard-x.sh here" wires nothing, and neither
 * does a commented-out hook.
 *
 *   registered hooks       parsed, not grepped, through lib/core-hooks.js's
 *                          `readRunningHooks` (#2442). Only the `command` strings of
 *                          hook entries count — a path in any other key is
 *                          configuration about the guard, not an invocation.
 *   .husky/*               comment lines stripped, then matched.
 *   .github/workflows/*    comment lines stripped, so a guard named only in a
 *                          `paths:` filter or a YAML comment does not count.
 *
 * .husky/<hook> is wired by its own existence rather than by mention: git runs
 * every file in core.hooksPath by name, so pre-commit needs no reference.
 * KNOWN LIMIT: that is existence only, not content — gutting the branch
 * assertion out of .husky/pre-commit while leaving the file (it also runs Biome
 * and gitleaks, so it will never be deleted) keeps an Enforced claim green.
 * Checking a hook's body would mean mapping a rule to the lines implementing
 * it, which is the declaration this design ruled against.
 */
/** The file `root` registers its own hooks in, for a finding to name. */
function hooksFile() {
	return ownHooksFile(root, { core: CORE_ROOT });
}

/* Every hook entry carrying a `command` string, at any nesting depth. */
/**
 * `any` because the argument is whatever `JSON.parse` returned from a hook
 * registration — a shape this repo does not own and cannot declare.
 * The body tests for array and object before it reads anything.
 *
 * @param {any} node
 * @returns {{ command: string, args?: unknown, if?: string }[]}
 */
function hookEntries(node) {
	if (Array.isArray(node)) return node.flatMap((n) => hookEntries(n));
	if (!node || typeof node !== "object") return [];
	const own =
		typeof node.command === "string"
			? [
					{
						command: node.command,
						/* The exec form (mantahostels#2059) holds the script path in `args` where
						 * `command` is a bare interpreter, so a reader taking `command`
						 * alone calls a wired script unwired (mantahostels#2266). Carried raw;
						 * buildHookCommandLine() is what validates it. */
						...(node.args === undefined ? {} : { args: node.args }),
						...(typeof node.if === "string" ? { if: node.if } : {}),
					},
				]
			: [];
	return [...own, ...Object.values(node).flatMap((v) => hookEntries(v))];
}

/** @param {any} node */
function hookCommands(node) {
	return hookEntries(node).map(buildHookCommandLine);
}

const COMMENT_LINE = /^\s*#/;

/** @param {string} text */
function stripComments(text) {
	return text
		.split("\n")
		.filter((l) => !COMMENT_LINE.test(l))
		.join("\n");
}

function readWiringCorpus() {
	const parts = [];
	/* At the core the self-plugin's file; at an adopter its settings and the
	 * core plugin's hooks/hooks.json, which is how an adopter's guards are
	 * wired at all (#5). */
	try {
		parts.push(...hookCommands(readRunningHooks(root, { core: CORE_ROOT })));
	} catch {
		/* absent or malformed wires nothing; an Enforced claim then reports UNWIRED */
	}
	/*
	 * package.json's `scripts` VALUES, and only those (mantahostels#2347). A script an npm
	 * script runs is triggered as surely as a hook entry's is. The `comments`
	 * block beside them describes those same scripts in prose, so reading the
	 * whole file would wire a path by anecdote.
	 *
	 * TWO RESIDUALS. The wiring test is `includes`, a substring match over the
	 * whole corpus, so a path named as an ARGUMENT inside a script value — a lint
	 * target, a file passed to a runner — wires as falsely as the comments block
	 * would. And this corpus has a second consumer, scanRuleStore's live-emitter
	 * set, so an npm-script-only emitter now counts as live there too (mantahostels#2347).
	 */
	parts.push(...readPackageScriptValues());
	for (const dir of [".husky", ".github/workflows"])
		parts.push(...readDirFiles(dir));
	return parts.join("\n");
}

/** package.json's string `scripts` values — none where it is absent or malformed. */
function readPackageScriptValues() {
	try {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(root, "package.json"), "utf8"),
		);
		if (pkg.scripts && typeof pkg.scripts === "object")
			return Object.values(pkg.scripts).filter((v) => typeof v === "string");
	} catch {
		/* absent or malformed wires nothing */
	}
	return [];
}

/** Every readable file directly under `dir`, comment lines stripped. */
function readDirFiles(/** @type {string} */ dir) {
	const out = /** @type {string[]} */ ([]);
	const abs = path.join(root, dir);
	if (!fs.existsSync(abs)) return out;
	for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		try {
			out.push(
				stripComments(fs.readFileSync(path.join(abs, entry.name), "utf8")),
			);
		} catch {
			/* unreadable file cannot wire anything */
		}
	}
	return out;
}

// --- the `if` narrowing surface (mantahostels#2212) -------------------------------------

/*
 * THE PROBLEM (mantahostels#2212, split from mantahostels#2126). A hook entry's `if` field decides
 * whether the script is exec'd at all — `Bash(*git*)`, `Bash(*gh*)` — so every
 * blind spot the script's own header enumerates is computed against it, and
 * neither says anything about the other.
 *
 * SYMMETRIC, because the drift runs both ways. An `if` ADDED to the wiring
 * leaves a header silent about a narrowing that now binds (the mantahostels#2061 shape); an
 * `if` REMOVED from the wiring leaves a header claiming a narrowing that is
 * gone, which is the stale label mantahostels#102 ruled out.
 *
 * WHAT COUNTS AS STATING IT. The header must contain the matcher verbatim —
 * `if: Bash(*git*)` — which is what surface 4 of docs/agents/guard-authoring.md
 * asks a new guard to write. Deliberately literal rather than a prose test:
 * this pass asserts that the narrowing is on the page, never that the sentence
 * around it is true. Whether the blind-spot enumeration beside it was
 * recomputed is a reader's call — the staleness warning is the surface for
 * that.
 *
 * HEADER_IF_RE SERVES THE STALE LIMB ALONE. The UNDECLARED limb tests the
 * wiring's own string against the header text, so a matcher shape the regex
 * cannot parse still clears by being written down; a regex-only test would
 * wedge it behind a header edit that can never satisfy it.
 *
 * HEADER ONLY, via parseHeaderLines — the WHOLE header, not the LIMITS section
 * mantahostels#2212 named. A guard with no LIMITS section states its narrowing wherever its
 * header already runs, and demanding a section would fail it for the heading.
 * A matcher spelled inside the BODY is code, not a declaration: a guard's own
 * argv parsing may well hold the same string.
 *
 * BOTH SIDES ARE WALKED (mantahostels#2234). The wiring's side gives the two limbs
 * above; the DECLARED side — every emitter-shaped file under EMITTER_ROOTS,
 * via emitterFiles() — gives UNWIRED-IF, for a script stating a narrowing that
 * the repo's hook registration never names at all. A walk from the wiring alone
 * would leave a script dropped from the registration ENTIRELY with its stale
 * narrowing unreported: the symmetry above covers a removed `if`
 * FIELD, not a removed entry, and assertion 1 catches the rest only where an
 * **Enforced** rule names the guard, which leaves a warn-only hook silent.
 *
 * A NARROWING IN AN UNWIRED SCRIPT IS A FAULT, not prose (mantahostels#2234 settled it).
 * The retired-guard reading — a header kept for reference — would need an
 * opt-out nothing uses: every script carrying a narrowing today is wired. The
 * escape is to delete the line or wire the script, never a marker.
 *
 * KNOWN LIMIT: the declared walk takes emitterFiles()' scope, so a narrowing
 * stated where that walk does not reach is still unseen — a .husky/ hook,
 * which is deliberately not an emitter root; a symlinked vendored skill,
 * which the walk steps over; a gitignored path, which dropIgnored() removes
 * from the same corpus the rule-text store reads; anything outside
 * EMITTER_EXTS (a Python or extensionless hook command carrying a narrowing);
 * and anything EMITTER_SKIP or NOT_EMITTERS excludes as never emitter-shaped.
 *
 * KNOWN LIMIT: a script reached only INDIRECTLY — one a wired dispatcher execs,
 * rather than one the hook registration names itself — is invisible to `wired`
 * and reads as unwired. Its own truthful header then raises
 * UNWIRED-IF with no escape that fits: it is not unwired, and "wire the
 * script" describes a hook entry that would duplicate the dispatch it already
 * gets. Tracing delegation would reopen the call-graph question
 * implicitWiring() above declines for the same reason. The exec form's `args`
 * is not a second way in: `wired` runs WIRED_SCRIPT_RE over
 * buildHookCommandLine()'s join (mantahostels#2266), so `"command": "node", "args":
 * ["…/scripts/x.js"]` wires its script rather than raising UNWIRED-IF.
 *
 * KNOWN LIMIT: HEADER_IF_RE cannot tell a script's own declaration from prose
 * describing another guard's narrowing — a checker or a doc-heavy script
 * whose header happens to quote one. The wired loop bounds this to scripts
 * the wiring already names, where the ambiguity is rare; the declared loop
 * applies it to every emitter-shaped file, widening the chance of a false
 * UNWIRED-IF on prose that was never a declaration.
 *
 * KNOWN LIMIT: `if` is read where the settings file carries it today — beside
 * the `command` in a hook entry. One written on the enclosing matcher group
 * instead would be read by neither this pass nor, on the current
 * documentation, Claude Code, so it would narrow nothing and be reported as
 * nothing. Inheriting it down would invent a narrowing that does not bind.
 *
 * KNOWN LIMIT: values are aggregated per script, not per entry, so a script
 * wired twice — once with an `if` and once without — satisfies both limbs on
 * the one declaration. Splitting it means a header stating which event each
 * narrowing belongs to, which nothing writes today.
 */
const HEADER_IF_RE = /\bif:\s*`?([A-Za-z][\w-]*\([^)`\n]*\))/g;

/**
 * The header's narrowings, keyed to the file line each is stated on.
 *
 * @param {string} rel
 * @returns {{ declared: Map<string, number>, header: string }}
 */
function readDeclaredNarrowings(rel) {
	/** @type {Map<string, number>} */
	const declared = new Map();
	let text;
	try {
		text = fs.readFileSync(path.join(root, rel), "utf8");
	} catch (e) {
		/* The path exists — scanIfNarrowing tested that — so this is the reader
		 * failing, not the script, and reporting UNDECLARED-IF would blame the
		 * script for it. Defence in depth and UNREACHABLE today, so untested:
		 * readAnnotation and digestOf both read the same file earlier in the run
		 * and raise the identical BROKEN first (measured against an EACCES
		 * fixture). It stays because whichever reader arrives first must not
		 * turn a read failure into a finding. */
		throw brokenError(`cannot read ${rel}: ${caught(e).message}`);
	}
	const head = parseHeaderLines(text);
	/* parseHeaderLines drops a shebang, so head[0] is file line 2 where one is
	 * present — without this every citation on a shebang'd guard is off by one. */
	const offset = text.startsWith("#!") ? 2 : 1;
	for (const [i, line] of head.entries())
		for (const m of line.matchAll(HEADER_IF_RE)) {
			const narrowing = requiredGroup(m, 1, HEADER_IF_RE);
			if (!declared.has(narrowing)) declared.set(narrowing, i + offset);
		}
	return { declared, header: head.join("\n") };
}

/**
 * @returns {{ findings: Finding[], narrowed: Map<string, string[]> }}
 */
function scanIfNarrowing() {
	/** @type {Finding[]} */
	const findings = [];

	/** @type {{ command: string, args?: unknown, if?: string }[]} */
	let entries = [];
	try {
		entries = hookEntries(readOwnHooks(root, { core: CORE_ROOT }) ?? {});
	} catch {
		/* a malformed registration narrows nothing; readImplicitHooks reports it
		 * BROKEN off the same read */
		return { findings, narrowed: new Map() };
	}

	const wired = wiredNarrowings(entries);

	for (const [rel, actual] of [...wired].sort()) {
		if (!fs.existsSync(path.join(root, rel))) continue; // assertion 1's fault, not this one's
		judgeWiredNarrowing(rel, actual, findings);
	}

	findings.push(...unwiredNarrowingFindings(wired));

	return {
		findings,
		narrowed: new Map(
			[...wired].filter(([, v]) => v.size).map(([k, v]) => [k, [...v].sort()]),
		),
	};
}

/**
 * Every script a hook entry runs, keyed to the `if` values its entries carry.
 *
 * @param {{ command: string, args?: unknown, if?: string }[]} entries
 * @returns {Map<string, Set<string>>}
 */
function wiredNarrowings(entries) {
	/** @type {Map<string, Set<string>>} */
	const wired = new Map();
	for (const entry of entries)
		for (const rel of scriptsInCommand(buildHookCommandLine(entry))) {
			const seen = wired.get(rel) ?? new Set();
			if (entry.if) seen.add(entry.if);
			wired.set(rel, seen);
		}
	return wired;
}

/**
 * The UNDECLARED-IF and STALE-IF limbs for one wired script, onto `findings`.
 *
 * @param {string} rel
 * @param {Set<string>} actual
 * @param {Finding[]} findings accumulator: each limb's finding is pushed here
 */
function judgeWiredNarrowing(rel, actual, findings) {
	const { declared, header } = readDeclaredNarrowings(rel);
	const report = (
		/** @type {string} */ kind,
		/** @type {number} */ line,
		/** @type {string} */ detail,
	) =>
		findings.push({
			kind,
			surface: "if-narrowing",
			file: rel,
			line,
			rule: `wired in ${hooksFile()}`,
			detail,
		});

	/* Substring, not `declared.has(value)`: HEADER_IF_RE reads only the two
	 * matcher shapes in use, so a value it cannot parse would raise an
	 * UNDECLARED-IF no header edit could ever clear. The header stating the
	 * value is what this limb asks for, however it is spelled. */
	for (const value of [...actual].sort())
		if (!header.includes(value))
			report(
				"UNDECLARED-IF",
				1,
				`${hooksFile()} narrows this hook with \`if: ${value}\`, so it is not exec'd on every ` +
					"matched call — but its own header never says so, leaving any blind spot the " +
					"header enumerates computed against a wiring that no longer holds (mantahostels#2126)",
			);

	/* A value HEADER_IF_RE truncated is a PREFIX of the wiring's, never equal
	 * to it, so prefix rather than membership — otherwise a matcher shape the
	 * regex reads only part of raises a STALE-IF against a header that is
	 * right. */
	for (const [value, line] of declared)
		if (![...actual].some((a) => a.startsWith(value)))
			report(
				"STALE-IF",
				line,
				`its header states a narrowing of \`if: ${value}\`, and no hook entry in ${hooksFile()} ` +
					`naming this script carries it${staleIfTail(actual)}`,
			);
}

/** The STALE-IF detail's tail: what the wiring narrows with instead, if anything. */
function staleIfTail(/** @type {Set<string>} */ actual) {
	if (actual.size > 0)
		return ` — the wiring narrows with ${[...actual]
			.map((v) => `\`${v}\``)
			.join(", ")} instead`;
	return ", the wiring carrying no `if` field at all";
}

/**
 * UNWIRED-IF findings: an emitter file, wired by no hook entry, whose header
 * states a narrowing.
 *
 * @param {Map<string, Set<string>>} wired
 * @returns {Finding[]}
 */
function unwiredNarrowingFindings(wired) {
	/** @type {Finding[]} */
	const findings = [];
	/* THE DECLARED SIDE (mantahostels#2234). emitterFiles() already walks EMITTER_ROOTS for
	 * the rule-text store, drops the ignored paths and steps over the vendored
	 * symlinks, so it is the seam; its NOT_EMITTERS exclusion is carried along
	 * and costs nothing here, neither accessor's header stating a narrowing. */
	for (const rel of emitterFiles()) {
		if (wired.has(rel)) continue; // the two limbs above already judged it
		/** @type {Map<string, number>} */
		let declared;
		try {
			({ declared } = readDeclaredNarrowings(rel));
		} catch {
			/* Unlike the wired loop, this one reads files no earlier pass has
			 * opened — a transient under .claude/ that dropIgnored did not catch
			 * among them — so a read failure here is not the BROKEN signal the
			 * comment in readDeclaredNarrowings describes. A file that cannot be read
			 * states no narrowing — but that is a fail-open, and it is counted and
			 * printed rather than left indistinguishable from a clean run. */
			declaredIfUnreadable++;
			continue;
		}
		for (const [value, line] of declared)
			findings.push({
				kind: "UNWIRED-IF",
				surface: "if-narrowing",
				file: rel,
				line,
				rule: `absent from ${hooksFile()}`,
				detail:
					`its header states a narrowing of \`if: ${value}\`, and no hook entry in ${hooksFile()} ` +
					"names this script at all — so the narrowing binds nothing, and every blind spot the " +
					"header enumerates against it is computed from a wiring that is gone (mantahostels#102). Delete " +
					"the line or wire the script",
			});
	}
	return findings;
}

// --- the implicit-behaviour surface (mantahostels#1261) ---------------------------------

/*
 * THE SECOND ASSERTION. A guard is a REFUSAL; an implicit behaviour is an
 * ACTION taken for a session without it asking. They are different sets (mantahostels#1180,
 * which counted them), and the registry region above covers only the first.
 *
 * THE ENUMERATION IS DERIVED, NEVER HAND-WRITTEN. That is the whole load-bearing
 * property: a hand-kept register goes stale silently, which is what mantahostels#169 (no aid
 * that reads doc-map §B can fix §B being wrong) says no aid can repair by hand.
 * So the set is whatever the WIRING reaches:
 *
 *   registered hooks        every PostToolUse, PostToolUseFailure,
 *                           PostToolBatch, UserPromptSubmit, SessionStart,
 *                           Stop, PreCompact and SessionEnd registration.
 *                           PreToolUse is the REFUSING event and is the
 *                           assertion above's business.
 *   .husky/*                every file there, each run by git under its own
 *                           name and referenced by nothing.
 *   vitest.config.ts        `globalSetup` and the custom `reporters` entry, both
 *                           of which run code nobody asked for on every suite.
 *
 * A PreToolUse ENTRY THAT ALSO ACTS DECLARES ITSELF, exactly as a delayed deny
 * does above: a guard that refuses a write AND takes a claim the session never
 * asked for is in this set because it carries the annotation, not because this
 * file names it. Inferring "also acts" from a
 * guard's body would be reading intent, which this script refuses everywhere.
 * KNOWN RESIDUAL: a PreToolUse guard that acts and stays silent is not caught.
 *
 * ENTRY POINTS ONLY, NOT THE CALL GRAPH. scripts/guard-dispatch.js runs the
 * post-write core, which runs Biome and then records the write; the annotation
 * goes on guard-dispatch.js, the file a reader following the wiring arrives at. Chasing delegations would make the set
 * unbounded and would put annotations on files no wiring names. This is also why
 * the walk reaches 26 where mantahostels#1180 counted 30: that audit counted mechanisms down
 * the call graph, and included the scheduled workflows, which are no part of a
 * session's wiring.
 *
 * WHAT IS REQUIRED — annotation-in-place, per mantahostels#102's ruling that "rules are
 * annotated where they are read, not in a separate table. A table elsewhere
 * leaves the page a session actually meets just as undifferentiated, and adds a
 * second surface to drift." So each wired script carries, in its own header
 * comment:
 *
 *     IMPLICIT:  <one line — what this does to a session without being asked>
 *     JUSTIFIED: fail-safe | convenience — <why>
 *     DEFEAT:    none | <the env var or flag>
 *
 * DEFEAT RECORDS, IT NEVER DEMANDS, and `convenience` is as legal an answer as
 * `fail-safe`. mantahostels#1181 ruled Archon's "individually defeatable" clause does not
 * transfer: their worktree-per-run isolation means a behaviour protects only its
 * own run, while this repo's shared tree means almost every implicit behaviour
 * protects NEIGHBOURS, where a per-session off switch is a hole by construction.
 * The assertion is that the script SAYS what it does and which kind it is;
 * whether convenience is good enough is a reader's call.
 *
 * OUTCOMES, following this file's existing discipline. A missing or malformed
 * annotation is a FAIL — offline, deterministic, no judgement: "you wired this
 * and it says nothing about what it does to a session". Staleness against the
 * content digest is the same WARN the guards get, sharing
 * guard-registry-anchors.json and --review rather than a second sidecar.
 */

const ACTING_EVENTS = [
	"PostToolUse",
	// #1575. A Bash call exiting non-zero reaches this event instead.
	"PostToolUseFailure",
	// #2026. Fires once per batch with every call's result, a refused Skill's
	// included, which no per-call event sees.
	"PostToolBatch",
	"UserPromptSubmit",
	"SessionStart",
	"Stop",
	// mantahostels#1804. PreCompact deletes a session's rule latches unasked, which is an
	// action on the same footing as anything on the four events above.
	"PreCompact",
	// #247. SessionEnd rotates this machine's shared marketplace clone and
	// reinstalls the plugin, after the founder has stopped watching.
	"SessionEnd",
];
const REFUSING_EVENT = "PreToolUse";
const HUSKY_DIR = ".husky";
const VITEST_CONFIG = "vitest.config.ts";

/*
 * A repo-relative script path inside a hook command string — defined in
 * scripts/lib/rule-emission.js and imported here (mantahostels#2003), because that module
 * reads the same settings file to decide which guards a matcher fires, and two
 * spellings would let the two disagree about which scripts exist.
 */
const {
	WIRED_SCRIPT_RE,
	buildHookCommandLine,
} = require("./lib/rule-emission");
const {
	DISPATCH_ENTRY,
	MANIFEST_REL,
	manifestAt,
	modulePath,
	readDispatchedCores,
	readManifest,
} = require("./lib/guard-cores.js");
const { coreDenyTexts, decideModule } = require("./lib/core-deny-text.js");

const DISPATCH_KIT = path.join("scripts", "lib", "guard-dispatch.js");

/*
 * The hooks git will run, read from the directory rather than listed.
 *
 * A list here would be the one place a new hook escapes silently — `post-merge`
 * added tomorrow is wired by its own existence and named by nothing, which is
 * exactly the hole the derivation exists to close. husky's own `_/` is a
 * directory and drops out; dotfiles are not hooks.
 *
 * KNOWN RESIDUAL: git runs a file only if it is named after a hook, so a stray
 * regular file dropped in here is asked to annotate itself too. Filtering to
 * git's hook vocabulary would reintroduce the hand list.
 */
function readHuskyHooks() {
	const abs = path.join(root, HUSKY_DIR);
	if (!fs.existsSync(abs)) return [];
	let entries;
	try {
		entries = fs.readdirSync(abs, { withFileTypes: true });
	} catch (e) {
		throw brokenError(`cannot read ${HUSKY_DIR}/: ${caught(e).message}`);
	}
	return entries
		.filter((e) => e.isFile() && !e.name.startsWith("."))
		.map((e) => `${HUSKY_DIR}/${e.name}`)
		.sort();
}

/** @param {string} cmd */
function scriptsInCommand(cmd) {
	return [...cmd.matchAll(WIRED_SCRIPT_RE)].map((m) =>
		requiredGroup(m, 1, WIRED_SCRIPT_RE),
	);
}

/* `globalSetup: [...]` and `reporters: [...]`, with `//` comment lines dropped
 * first so a commented-out entry wires nothing — the same rule stripComments
 * applies to `#` in the shell wiring above. Only `./scripts/…` entries count;
 * `"default"` is a built-in reporter and no file of ours. */
/* KNOWN MISS: the bracket run stops at the first `]`, so vitest's tuple
 * reporter form — `reporters: [["./x.ts", {}]]` — would drop everything after
 * the first entry. The config is flat today; a nested one narrows the set
 * rather than widening it, so the failure is quiet, not false. */
const VITEST_KEY_RE = /\b(?:globalSetup|reporters)\s*:\s*\[([^\]]*)\]/g;
const VITEST_ENTRY_RE = /["']\.\/((?:scripts|\.claude)\/[\w./-]+)["']/g;

/*
 * ABSENT vs UNREADABLE, on scripts/lib/check.js's SUBJECT/APPARATUS split. A
 * repo with no vitest config genuinely wires no suite hooks — that is a true
 * answer, not a failure. A config that is there and cannot be read is apparatus,
 * and swallowing it empties the acting set and reports OK over scope never
 * scanned, which is the FAIL gate passing vacuously.
 */
function readVitestScripts() {
	const abs = path.join(root, VITEST_CONFIG);
	if (!fs.existsSync(abs)) return [];
	let text;
	try {
		text = fs.readFileSync(abs, "utf8");
	} catch (e) {
		throw brokenError(`cannot read ${VITEST_CONFIG}: ${caught(e).message}`);
	}
	const live = text
		.split("\n")
		.filter((l) => !/^\s*\/\//.test(l))
		.join("\n");
	/** @type {string[]} */
	const out = [];
	for (const block of live.matchAll(VITEST_KEY_RE))
		for (const m of requiredGroup(block, 1, VITEST_KEY_RE).matchAll(
			VITEST_ENTRY_RE,
		))
			out.push(requiredGroup(m, 1, VITEST_ENTRY_RE));
	return out;
}

/**
 * Every script the acting wiring reaches, as `path → the triggers that run it`.
 *
 * A path the wiring names but that does not exist is skipped rather than
 * reported: there is no header to annotate, and a hook command pointing at a
 * missing file is the hook registration's problem, not this assertion's.
 */
function implicitWiring() {
	/** @type {Map<string, Set<string>>} */
	const triggers = new Map();
	const add = (/** @type {string} */ rel, /** @type {string} */ trigger) => {
		if (!fs.existsSync(path.join(root, rel))) return;
		const set = triggers.get(rel) ?? new Set();
		triggers.set(rel, set);
		set.add(trigger);
	};

	const hooks = readImplicitHooks();
	if (hooks) addHookTriggers(hooks, add);

	for (const h of readHuskyHooks()) add(h, "git");
	for (const rel of readVitestScripts()) add(rel, "vitest");

	return new Map(
		[...triggers]
			.sort(([a], [b]) => byCodeUnit(a, b))
			.map(([rel, set]) => [rel, [...set].sort()]),
	);
}

/**
 * The hooks `root` registers itself, or null where an adopter carries no
 * settings file. At the core that is the self-plugin's file and the canary
 * its settings keep (#2473).
 *
 * @returns {Record<string, unknown> | null}
 */
function readImplicitHooks() {
	/* Same split as readVitestScripts above: an adopter's absent settings are an
	 * answer, the core's absent self-plugin file and anything unreadable or
	 * unparseable are apparatus. readWiringCorpus's swallow is not a precedent — there
	 * the failure is CLOSED, an Enforced claim then reporting UNWIRED. */
	try {
		return readOwnHooks(root, { core: CORE_ROOT });
	} catch (e) {
		throw brokenError(caught(e).message);
	}
}

/**
 * Each script a registered hook runs, added under its event — an acting event's
 * name, or the refusing event's where the script declares itself.
 *
 * @param {object} hooks
 * @param {(rel: string, trigger: string) => void} add
 */
function addHookTriggers(hooks, add) {
	for (const [event, entries] of Object.entries(hooks))
		for (const cmd of hookCommands(entries))
			for (const rel of scriptsInCommand(cmd)) {
				if (ACTING_EVENTS.includes(event)) add(rel, event);
				else if (event === REFUSING_EVENT && readAnnotation(rel))
					add(rel, `${REFUSING_EVENT} (declared)`);
			}
}

/*
 * The header comment: everything above the first line of executable code, after
 * an optional shebang. Both comment spellings and a `/* … *\/` block are read,
 * so one parser covers the shell hooks, the JS notifiers and the two TypeScript
 * vitest entries.
 *
 * Deliberately not "the first N lines". A fixed window either cuts a long header
 * in half or lets an annotation buried in the body count as a header
 * annotation — and the whole point of annotation-in-place is that a reader
 * arriving at the file meets it without scrolling.
 */
/** @param {string} text */
function parseHeaderLines(text) {
	const lines = text.split("\n");
	/** @type {string[]} */
	const out = [];
	const start = lines[0]?.startsWith("#!") ? 1 : 0;
	let inBlock = false;
	for (const line of lines.slice(start)) {
		const t = line.trim();
		if (!(inBlock || isHeaderLine(t))) break;
		out.push(line);
		inBlock = isBlockOpenAfter(t, inBlock);
	}
	return out;
}

/** Whether a trimmed line outside a block comment still belongs to the header. */
function isHeaderLine(/** @type {string} */ t) {
	return (
		t === "" || t.startsWith("/*") || t.startsWith("#") || t.startsWith("//")
	);
}

/** Whether a block comment is open after trimmed line `t`. */
function isBlockOpenAfter(
	/** @type {string} */ t,
	/** @type {boolean} */ inBlock,
) {
	if (inBlock) return !t.includes("*/");
	return t.startsWith("/*") && !t.includes("*/");
}

/* Both regexes are BUILT from their vocabulary rather than restating it: an
 * alternation written out beside the array is a second place to add a key to,
 * and the one that gets missed fails silently — the parser simply never sees
 * the line. */
const ANNOTATION_KEYS = ["IMPLICIT", "JUSTIFIED", "DEFEAT"];
const JUSTIFICATIONS = ["fail-safe", "convenience"];

const ANNOTATION_RE = new RegExp(
	`^\\s*(?:#+|\\*|//)\\s*(${ANNOTATION_KEYS.join("|")}):[ \\t]*(.*)$`,
);
/* The reason is required, not decoration: "fail-safe" alone asserts a verdict
 * and shows no working, which is the stale label mantahostels#102 ruled out. */
const JUSTIFIED_RE = new RegExp(
	`^(?:${JUSTIFICATIONS.join("|")})\\s*[—:-]\\s*\\S`,
);

/**
 * path → parsed annotation (or null), memoised: implicitWiring asks too.
 *
 * @type {Map<string, Record<string, string> | null>}
 */
const annotationCache = new Map();

/**
 * @param {string} rel
 * @returns {Record<string, string> | null}
 */
function readAnnotation(rel) {
	if (annotationCache.has(rel)) return annotationCache.get(rel) ?? null;
	/** @type {Record<string, string>} */
	const keys = {};
	/* Callers only ever reach a path the wiring named AND that exists, so a read
	 * that fails here is apparatus, not a script with nothing to say — reporting
	 * it as UNANNOTATED would blame the script for the reader's failure. */
	try {
		const text = fs.readFileSync(path.join(root, rel), "utf8");
		for (const line of parseHeaderLines(text)) {
			const m = ANNOTATION_RE.exec(line);
			if (!m) continue;
			/* First wins: a later restatement in the same header is prose about the
			 * annotation, not a second annotation. */
			const key = requiredGroup(m, 1, ANNOTATION_RE);
			if (!(key in keys)) keys[key] = requiredGroup(m, 2, ANNOTATION_RE).trim();
		}
	} catch (e) {
		if (fs.existsSync(path.join(root, rel)))
			throw brokenError(`cannot read ${rel}: ${caught(e).message}`);
	}
	/* null, not {}: no annotation at all is UNANNOTATED — one finding naming the
	 * whole omission — where a partial one is reported line by line. */
	const found = Object.keys(keys).length > 0 ? keys : null;
	annotationCache.set(rel, found);
	return found;
}

/* Matched against the vocabulary, never split on the dash: `fail-safe` carries
 * one, and splitting there reported every fail-safe as `fail`. */
/** @param {Record<string, string> | null} ann */
function justificationTag(ann) {
	if (!ann) return "unannotated";
	return (
		JUSTIFICATIONS.find((j) => (ann.JUSTIFIED ?? "").startsWith(j)) ??
		"malformed"
	);
}

/**
 * One wired behaviour as report lines — the roster's entry and --review's, which
 * differ only in what precedes the trigger list and whether the detail follows.
 */
/**
 * @param {WiredScript} info
 * @param {string} head
 * @param {{ detail: boolean }} opts
 */
function buildImplicitLines(info, head, { detail }) {
	const ann = info.annotation;
	const lines = [
		`${head}[${info.triggers.join(", ")}]  ${justificationTag(ann)}`,
	];
	if (!detail) return lines;
	if (ann)
		lines.push(
			`    ${ann.IMPLICIT || "?"}`,
			`    defeat: ${ann.DEFEAT || "?"}`,
		);
	else lines.push("    (no IMPLICIT / JUSTIFIED / DEFEAT annotation)");
	return lines;
}

/** `12 fail-safe`, `6 convenience`, `2 unannotated` — the summary breakdown. */
/** @param {Map<string, WiredScript>} scripts */
function implicitJustifications(scripts) {
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const { annotation } of scripts.values()) {
		counts.set(
			justificationTag(annotation),
			(counts.get(justificationTag(annotation)) ?? 0) + 1,
		);
	}
	return [...counts]
		.sort((a, b) => b[1] - a[1])
		.map(([tag, n]) => `${n} ${tag}`);
}

/**
 * Walk the acting wiring and judge each script's annotation.
 *
 * Returns the FAIL findings and the roster — `path → { triggers, annotation }` —
 * which the anchor pass treats exactly as it treats a guard a rule names.
 */
function scanImplicit() {
	/** @type {Finding[]} */
	const findings = [];
	/** @type {Map<string, WiredScript>} */
	const scripts = new Map();

	for (const [rel, triggers] of implicitWiring()) {
		const ann = readAnnotation(rel);
		scripts.set(rel, { triggers, annotation: ann });
		const where = `wired at ${triggers.join(", ")}`;
		const report = (/** @type {string} */ kind, /** @type {string} */ detail) =>
			findings.push({
				kind,
				surface: "implicit",
				file: rel,
				line: 1,
				rule: where,
				detail,
			});

		if (!ann) {
			report(
				"UNANNOTATED",
				`${where}, so it acts on a session that never asked — but its header carries no ` +
					"`IMPLICIT:` / `JUSTIFIED:` / `DEFEAT:` lines saying what it does, why, or what escape exists",
			);
			continue;
		}

		for (const key of ANNOTATION_KEYS) {
			if (!(key in ann)) {
				report(
					"INCOMPLETE-ANNOTATION",
					`${where}, and its header annotation has no \`${key}:\` line`,
				);
				continue;
			}
			if (ann[key] === "")
				report(
					"EMPTY-ANNOTATION",
					`${where}, and its \`${key}:\` line says nothing`,
				);
		}

		if (
			typeof ann.JUSTIFIED === "string" &&
			ann.JUSTIFIED !== "" &&
			!JUSTIFIED_RE.test(ann.JUSTIFIED)
		)
			report(
				"BAD-JUSTIFICATION",
				`\`JUSTIFIED: ${ann.JUSTIFIED}\` — it must open with one of ${JUSTIFICATIONS.join(
					" | ",
				)} and then give the reason, as \`JUSTIFIED: fail-safe — <why>\``,
			);
	}

	return { findings, scripts };
}

// --- parsing ----------------------------------------------------------------

const MARKERS = ["Enforced", "Advisory", "Unenforced", "Unenforceable"];

/*
 * Marker form is the bolded word the house prose already uses — mantahostels#110 wrote
 * "**Enforced** (mantahostels#110): `scripts/guard-branch.sh` denies…" before this script
 * existed, and matching it means the annotation costs no new notation.
 *
 * The closing `\*\*` is what disambiguates `Unenforced` from `Unenforceable`,
 * not the order of the alternation: on "**Unenforceable**" the shorter branch
 * matches its letters, then fails to find `**` at "able**" and backtracks. The
 * longest-first order below is therefore belt-and-braces, not load-bearing.
 */
const MARKER_RE = new RegExp(
	`\\*\\*(${[...MARKERS].sort((a, b) => b.length - a.length).join("|")})\\*\\*`,
	"g",
);

/** The vocabulary as the messages print it: `**Enforced** / **Advisory** / …`. */
const MARKER_LIST = MARKERS.map((m) => `**${m}**`).join(" / ");

/*
 * A backticked token naming a file in this repo. Anchored on the four
 * directories a guard can live in, so ordinary backticked prose in the same
 * rule — `git worktree add …`, `WFC_ALLOW_BRANCH=1`, `--no-verify` — is not
 * mistaken for a guard claim.
 */
const GUARD_PATH_RE = /`((?:scripts|\.husky|\.claude|\.github)\/[\w./-]+)`/g;

const ISSUE_RE = /#\d+/;

/* A top-level list item: a bullet at column 0. Indented items continue it. */
const TOP_BULLET = /^[-*]\s+\S/;
const INDENTED = /^\s+\S/;

/*
 * Content a region may hold that is NOT a rule: the region's own explanatory
 * HTML comment, and a Markdown heading. Anything else at column 0 is a rule
 * written in a shape the marker parser cannot read — see UNRULED below.
 */
const HTML_COMMENT = /^\s*<!--/;
const MD_HEADING = /^\s{0,3}#{1,6}\s/;
const FENCE = /^\s*(```|~~~)/;

/** @param {string} text */
function regionsIn(text) {
	/** @type {{ unterminated: boolean, body: string, startLine: number, from?: number, to?: number }[]} */
	const out = [];
	let from = 0;
	for (;;) {
		const b = text.indexOf(BEGIN, from);
		if (b === -1) break;
		const e = text.indexOf(END, b);
		if (e === -1) {
			out.push({ unterminated: true, body: "", startLine: lineOf(text, b) });
			break;
		}
		out.push({
			unterminated: false,
			body: text.slice(b + BEGIN.length, e),
			startLine: lineOf(text, b),
			/* Byte bounds of the body, for the trigger collector's membership
			 * test (mantahostels#1961). Only the body counts: the delimiters themselves are
			 * markup, not a place a rule can be written. */
			from: b + BEGIN.length,
			to: e,
		});
		from = e + END.length;
	}
	return out;
}

/**
 * @param {string} text
 * @param {number} index
 */
function lineOf(text, index) {
	return text.slice(0, index).split("\n").length;
}

/*
 * Split a region into rules: each top-level bullet plus its continuation.
 *
 * Also returns UNRULED lines — content at column 0 that is neither a bullet nor
 * allowed furniture. Silently skipping them is a gate that PASSES when it should
 * fail: a region holding "1. Never checkout the shared tree." beside one valid
 * bullet reported one rule, no findings, exit 0.
 *
 * `region.body` begins immediately after BEGIN on BEGIN's own line, so body
 * line i sits on file line startLine + i — no +1.
 */
/** @param {{ body: string, startLine: number }} region */
function rulesIn(region) {
	/** @type {Rule[]} */
	const rules = [];
	/** @type {Rule[]} */
	const unruled = [];
	/** @type {Rule | null} */
	let current = null;
	let inFence = false;
	const lines = region.body.split("\n");
	for (const [i, line] of lines.entries()) {
		const at = region.startLine + i;
		if (FENCE.test(line)) {
			inFence = !inFence;
			current = null;
			continue;
		}
		if (inFence) continue; // a `- ` inside a code fence is an example, not a rule
		const kind = lineKind(line, current !== null);
		if (kind === "rule") {
			current = { line: at, text: line };
			rules.push(current);
		} else if (kind === "continuation" && current) {
			current.text += `\n${line}`;
		} else if (kind !== "blank") {
			// prose between rules ends the previous rule
			if (kind === "prose") unruled.push({ line: at, text: line.trim() });
			current = null;
		}
	}
	return { rules, unruled };
}

/**
 * What one unfenced region line is.
 *
 * @param {string} line
 * @param {boolean} inRule
 * @returns {"rule" | "continuation" | "blank" | "furniture" | "prose"}
 */
function lineKind(line, inRule) {
	if (TOP_BULLET.test(line)) return "rule";
	if (inRule && (INDENTED.test(line) || line.trim() === ""))
		return "continuation";
	if (line.trim() === "") return "blank";
	return isFurniture(line) ? "furniture" : "prose";
}

/** Whether a non-blank line outside any rule is allowed region furniture. */
function isFurniture(/** @type {string} */ line) {
	return (
		HTML_COMMENT.test(line) || MD_HEADING.test(line) || INDENTED.test(line)
	);
}

/** @param {string} text */
function markersOf(text) {
	const seen = new Set();
	for (const m of text.matchAll(MARKER_RE))
		seen.add(requiredGroup(m, 1, MARKER_RE));
	return [...seen].sort((a, b) => MARKERS.indexOf(a) - MARKERS.indexOf(b));
}

/** @param {string} text */
function guardPathsOf(text) {
	return [
		...new Set(
			[...text.matchAll(GUARD_PATH_RE)].map((m) =>
				requiredGroup(m, 1, GUARD_PATH_RE),
			),
		),
	];
}

/* Host data, so under the host's .claude/ (#37) — which also keeps the sidecar
 * out of RUNNABLE_PATH_RE below, so it is never anchored on itself. */
const ANCHORS = ".claude/guard-registry-anchors.json";

/*
 * The anchor question is a different one from the Enforced-claim question above,
 * so it gets its own extractor rather than a widened GUARD_PATH_RE.
 *
 * - It looks INSIDE a backtick span, not just at spans that are a bare path.
 *   `node scripts/session-arbiter.js release <path>` is a rule describing that
 *   command's behaviour — and it is the release rule (mantahostels#121/mantahostels#126) whose sentence
 *   is the pending staleness instance, so missing it would miss the case.
 * - It takes only scripts/ and .husky/ — things that RUN. `.claude/settings.json`
 *   and `.github/workflows/*` are wiring, and a rule mentioning settings.json in
 *   passing (rule 47 does, as an anecdote) would otherwise warn on every
 *   unrelated settings edit: the unclearable wallpaper mantahostels#109 ruled against. An
 *   unwired guard is already caught, by UNWIRED.
 */
const BACKTICK_SPAN_RE = /`([^`]+)`/g;
const RUNNABLE_PATH_RE =
	/(?:^|[\s(])((?:scripts|\.husky)\/[\w.-]+(?:\/[\w.-]+)*)/g;

/** @param {string} text */
function anchorPathsOf(text) {
	/** @type {Set<string>} */
	const out = new Set();
	for (const span of text.matchAll(BACKTICK_SPAN_RE))
		for (const m of requiredGroup(span, 1, BACKTICK_SPAN_RE).matchAll(
			RUNNABLE_PATH_RE,
		))
			out.add(requiredGroup(m, 1, RUNNABLE_PATH_RE));
	return [...out];
}

/* First line of a rule, trimmed of its bullet, for a legible report. */
/** @param {string} text */
function gist(text) {
	const [line] = text.split("\n");
	// split always yields at least one element, even for "".
	if (line === undefined) throw new Error("rule text split into no lines");
	const first = line.replace(/^[-*]\s+/, "");
	return first.length > 100 ? `${first.slice(0, 97)}…` : first;
}

// --- staleness anchors ------------------------------------------------------

/*
 * A guard's dependencies, as paths relative to `root`: a shell guard's `source`
 * lines and a JS guard's relative `require`s.
 *
 * Only lib/ is followed, in both languages. A guard pulls in its shared library
 * and nothing else here, and widening this to arbitrary paths would start
 * resolving `$PATH` lookups and command substitutions that no regex can settle.
 */
const SOURCE_RE =
	/^[^#\n]*?(?:^|\s)(?:source|\.)\s+[^\n]*?(lib\/[\w.-]+\.sh)/gm;
/*
 * The third spelling (mantahostels#358): a shell guard that reaches its logic by RUNNING a
 * node program rather than sourcing it, shelling out for every decision the
 * rule describes.
 *
 * Only a SELF-RELATIVE spelling counts: the script path must be prefixed by a
 * `$`-expansion, as in `"$here/session-arbiter.js"`. A hook runs from an
 * arbitrary cwd, so a guard that genuinely delegates must locate its sibling
 * from its own path; a bare `node scripts/issue-body.js` only works from the
 * repo root, and following it would tie a helper's internals to rules about
 * something else. The known miss is a guard that hardcodes a root-relative path
 * and really does delegate; there is none today.
 *
 * The captured tail is resolved against the guard's own directory first and, if
 * nothing is there and the tail is under scripts/, against the repo root
 * — `node "$root/scripts/x.js"` names
 * the same file either way, and only the second reading finds it.
 *
 * FAN-OUT: one edit to a shared lib warns on every registry entry reaching it,
 * by require or by running the CLI (mantahostels#358, which measured it).
 */
const NODE_RUN_RE =
	/^([^#\n]*?)(?:^|[\s(|;&])node\s+"?\$[^\n]*?\/([\w-][\w./-]*\.js)/gm;
/*
 * The fourth spelling (#2487): the program's path assigned to a variable the
 * guard then runs, `lib="$here/lib/x.js"` and then `node "$lib"`. The
 * assignment must be self-relative as NODE_RUN_RE's path is, and only a
 * variable that `node` actually runs is followed, so a path assigned for some
 * other use stays out of the digest. A name assigned twice follows both paths,
 * as .husky/post-commit's `script` names two programs.
 */
const VAR_PATH_RE =
	/^[ \t]*(?:local\s+|readonly\s+)?(\w+)="?\$[^\n]*?\/([\w-][\w./-]*\.js)"?[ \t]*(?:#[^\n]*)?$/gm;
const NODE_VAR_RE =
	/^([^#\n]*?)(?:^|[\s(|;&])node\s+"?\$\{?(\w+)\}?(?=["\s;|)]|$)/gm;

/**
 * @param {string} rel
 * @param {string} text
 * @param {string} [base] the tree run targets and the dispatch manifest resolve in
 */
function sourcedBy(rel, text, base = root) {
	const dir = path.dirname(rel);
	const shell = [...text.matchAll(SOURCE_RE)].map((m) =>
		path.join(dir, requiredGroup(m, 1, SOURCE_RE)),
	);
	// Resolve first, then keep only lib/: `session-arbiter.js` reaches its store
	// as `./lib/arbiter-store.js` but the store reaches the proc leaf as
	// `./arbiter-proc.js`, already inside lib/, so the specifier alone cannot say.
	const js = [...text.matchAll(REQUIRE_RE)]
		// A commented-out require is not a dependency. Only `//` is honoured, as
		// SOURCE_RE honours only `#`: a require inside a block comment still counts.
		// The prefix is sliced back to the line start rather than captured by the
		// pattern, because anchoring at `^` let only the first require on a line
		// match — a second one on the same line dropped out of the digest silently.
		.filter(
			(m) =>
				!text
					.slice(text.lastIndexOf("\n", m.index) + 1, m.index)
					.includes("//"),
		)
		.map((m) => path.join(dir, requiredGroup(m, 1, REQUIRE_RE)))
		.filter((p) => p.startsWith(`scripts${path.sep}lib${path.sep}`));
	// A delegated program is a sibling under scripts/, not under lib/.
	// `//` is honoured here as well as `#`, because sourcedBy runs over JS
	// guards too. The prefix is captured rather than sliced off m.index as
	// REQUIRE_RE's is: these patterns are anchored at `^`, so the text before the
	// match is always empty and the test would pass on everything.
	/** @param {RegExp} re */
	const live = (re) =>
		[...text.matchAll(re)].filter(
			(m) => !requiredGroup(m, 1, re).includes("//"),
		);
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
		...live(NODE_RUN_RE).map((m) => requiredGroup(m, 2, NODE_RUN_RE)),
		...live(NODE_VAR_RE).flatMap(
			(m) => assigned.get(requiredGroup(m, 2, NODE_VAR_RE)) ?? [],
		),
	];
	const run = tails.map((tail) => resolveRun(base, dir, tail)).filter(keptRun);
	/* The dispatcher's kit loads its cores by manifest path, which no require
	 * names (#2786). The manifest is the judged tree's and is hashed itself,
	 * so a commit that changes only a manifest row moves the digest (#3124). */
	const cores =
		rel === DISPATCH_KIT
			? [MANIFEST_REL, ...readDispatchedCores(manifestAt(base))]
			: [];
	return [...shell, ...js, ...run, ...cores];
}

/** @param {string} p a run target, as a path from the tree's root */
function keptRun(p) {
	return p.startsWith(`scripts${path.sep}`);
}

/* Neither reading is checked for existence beyond this: a path at neither place
 * is not a dependency, and digestOf tolerates one that vanishes later. The
 * root reading is probed only where keptRun would keep it: elsewhere the
 * probe could only drop the sibling, and in the core walk it lands in the plugin cache's root, outside what ships (#3144). */
/**
 * @param {string} base the tree the two readings are checked in
 * @param {string} dir
 * @param {string} tail
 */
function resolveRun(base, dir, tail) {
	const sibling = path.join(dir, tail);
	if (fs.existsSync(path.join(base, sibling))) return sibling;
	if (!keptRun(path.normalize(tail))) return sibling;
	return fs.existsSync(path.join(base, tail)) ? tail : sibling;
}

/*
 * Short hex of the guard's bytes AND of every library it sources. Truncated to
 * 16 chars: this identifies a revision to a human reading a diff, it is not a
 * security boundary.
 *
 * The libraries are in here because a guard's behaviour is not confined to its
 * own file. A shared library named in no rule itself could never be anchored
 * directly — the checker fails an anchor no rule mentions. Folding it into its
 * dependants' digests warns on every rule they enforce at once, which is the
 * right set: a change to a shared emitter can falsify any of them
 * (mantahostels#140).
 */
/**
 * @param {string} rel
 * @param {Set<string>} [seen] accumulator: each file hashed is added, so a cycle hashes once
 * @returns {string | null}
 */
function digestOf(rel, seen = new Set()) {
	if (seen.has(rel)) return null; // a source cycle: hash each file once
	seen.add(rel);
	try {
		const bytes = fs.readFileSync(path.join(root, rel));
		const hash = crypto.createHash("sha256").update(bytes);
		// Sorted, so the digest does not move when the source lines are reordered.
		for (const lib of sourcedBy(rel, bytes.toString("utf8")).sort())
			hash.update(`\0${lib}\0${digestOf(lib, seen) ?? ""}`);
		return hash.digest("hex").slice(0, 16);
	} catch {
		return null; // absence is the existing BROKEN-CLAIM's business, not this one's
	}
}

function loadAnchors() {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(root, ANCHORS), "utf8"));
		/* Tolerate anything non-object rather than crashing the whole check. */
		return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	} catch {
		return {};
	}
}

/** @param {Record<string, string>} anchors */
function saveAnchors(anchors) {
	/* A host with no .claude/ yet has nowhere to write the first anchor. */
	fs.mkdirSync(path.dirname(path.join(root, ANCHORS)), { recursive: true });
	const sorted = Object.fromEntries(
		Object.keys(anchors)
			.sort()
			.map((k) => [k, anchors[k]]),
	);
	fs.writeFileSync(
		path.join(root, ANCHORS),
		`${JSON.stringify(sorted, null, "\t")}\n`,
	);
}

// --- checking ---------------------------------------------------------------

/**
 * scanRegistry's accumulators, threaded through the steps that fill them.
 *
 * @typedef {{
 *   findings: Finding[],
 *   describedBy: Map<string, RuleRef[]>,
 *   enforcedRules: (RuleRef & { text: string, guards: string[] })[],
 *   triggerRefs: (RuleRef & { id: string })[],
 *   wiring: string,
 *   regionCount: number,
 *   ruleCount: number,
 *   regionsByFile: Map<string, number>,
 *   byMarker: Record<string, number>,
 * }} RegistryScan
 */

/**
 * Read every in-scope document and judge each rule in its registry region.
 *
 * Returns the raw material the reporting needs: the FAIL findings, the guard →
 * describing-rules map the staleness pass and --review both walk, and the counts
 * the summary line quotes.
 */
function scanRegistry() {
	const files = scannedFiles();
	/** @type {RegistryScan} */
	const st = {
		findings: [],
		/* guard path → the rules describing it, so a warning names all of them. */
		describedBy: new Map(),
		/* Enforced rules with the guards they name, for the reprint pass (mantahostels#1032). */
		enforcedRules: [],
		/* Every `rule:<id>` trigger the scanned documents carry, with where it sits.
		 * ORPHAN-TRIGGER reads all of it: a pointer that resolves to nothing is
		 * broken wherever it points from. */
		triggerRefs: [],
		wiring: readWiringCorpus(),
		regionCount: 0,
		ruleCount: 0,
		/* file → count of well-formed regions found in it. */
		regionsByFile: new Map(),
		byMarker: Object.fromEntries(MARKERS.map((m) => [m, 0])),
	};

	for (const file of files) {
		let text;
		try {
			text = fs.readFileSync(path.join(root, file), "utf8");
		} catch {
			continue;
		}
		const regions = regionsIn(text);
		collectTriggers(st, file, text);
		if (!text.includes(BEGIN)) continue;
		for (const region of regions) scanRegion(st, file, region);
	}

	noRegionFindings(st);

	const {
		findings,
		describedBy,
		enforcedRules,
		triggerRefs,
		regionCount,
		ruleCount,
		byMarker,
	} = st;
	return {
		findings,
		describedBy,
		enforcedRules,
		triggerRefs,
		files,
		regionCount,
		ruleCount,
		byMarker,
	};
}

/**
 * @param {RegistryScan} st accumulator: the finding is pushed onto findings
 * @param {string} kind
 * @param {{ file: string, rule: Rule }} at
 * @param {string} detail
 */
function reportRule(st, kind, { file, rule }, detail) {
	st.findings.push({
		kind,
		file,
		line: rule.line,
		rule: gist(rule.text),
		detail,
	});
}

/**
 * @param {RegistryScan} st accumulator: each trigger is pushed onto triggerRefs
 * @param {string} file
 * @param {string} text
 */
function collectTriggers(st, file, text) {
	/* Triggers are read from the WHOLE document, not just its regions. A
	 * relocated rule's trigger line is expected inside one, where the marker
	 * parser can see it — but mantahostels#1641's relocation pool includes CLAUDE.md
	 * §Gotchas, which carries no region, and a trigger left there pointing at
	 * nothing is the exact failure this assertion exists to catch. */
	for (const m of text.matchAll(TRIGGER_RE)) {
		const at = m.index ?? 0;
		const line = lineOf(text, at);
		st.triggerRefs.push({
			id: requiredGroup(m, 1, TRIGGER_RE),
			file,
			line,
			gist: gist(text.split("\n")[line - 1] ?? ""),
		});
	}
}

/**
 * @param {RegistryScan} st accumulator: the region's counts, findings and rules are filed here
 * @param {string} file
 * @param {ReturnType<typeof regionsIn>[number]} region
 */
function scanRegion(st, file, region) {
	if (region.unterminated) {
		st.findings.push({
			kind: "UNTERMINATED",
			file,
			line: region.startLine,
			rule: BEGIN,
			detail: `region opened here is never closed with ${END}`,
		});
		return;
	}
	st.regionCount++;
	st.regionsByFile.set(file, (st.regionsByFile.get(file) ?? 0) + 1);
	const { rules, unruled } = rulesIn(region);

	for (const line of unruled)
		st.findings.push({
			kind: "UNRULED",
			file,
			line: line.line,
			rule: gist(line.text),
			detail:
				"content in the region that is not a top-level `- ` bullet, so the marker " +
				"parser cannot see it. Rewrite it as a bullet, or move it out of the region.",
		});

	for (const rule of rules) {
		st.ruleCount++;
		judgeRule(st, file, rule);
	}
}

/**
 * @param {RegistryScan} st accumulator: describedBy, byMarker and the rule's findings are filled
 * @param {string} file
 * @param {Rule} rule
 */
function judgeRule(st, file, rule) {
	for (const g of anchorPathsOf(rule.text)) {
		const rules = st.describedBy.get(g) ?? [];
		st.describedBy.set(g, rules);
		rules.push({ file, line: rule.line, gist: gist(rule.text) });
	}

	const marker = soleMarker(st, file, rule);
	if (marker === undefined) return;

	const tally = st.byMarker[marker];
	// markersOf returns only MARKERS, and byMarker holds every one of them.
	if (tally === undefined)
		throw new Error(`marker ${marker} has no tally in byMarker`);
	st.byMarker[marker] = tally + 1;

	/* ABOVE the marker branches, so no branch can return before it:
	 * **Unenforceable** names a path too (CLAUDE.md's push rule names
	 * scripts/guard-push-rules.js, which hands the rule over). Reported
	 * alongside UNOWNED and NO-GUARD-NAMED rather than instead of either. */
	checkNamedPaths(st, file, rule, guardPathsOf(rule.text));

	if (marker === "Unenforceable") return;

	if (marker === "Unenforced") {
		if (!ISSUE_RE.test(rule.text))
			reportRule(
				st,
				"UNOWNED",
				{ file, rule },
				"marked **Unenforced** but names no issue that owns building the guard",
			);
		return;
	}

	judgeGuardedRule(st, file, rule, marker);
}

/**
 * The rule's one marker — undefined, reported, where it carries none or several.
 *
 * @param {RegistryScan} st
 * @param {string} file
 * @param {Rule} rule
 * @returns {string | undefined}
 */
function soleMarker(st, file, rule) {
	const marks = markersOf(rule.text);
	const marker = marks[0];

	if (marker === undefined) {
		reportRule(st, "UNMARKED", { file, rule }, `no ${MARKER_LIST} marker`);
		return;
	}
	if (marks.length > 1) {
		reportRule(
			st,
			"AMBIGUOUS",
			{ file, rule },
			`carries ${marks.length} conflicting markers: ${marks.join(", ")}`,
		);
		return;
	}
	return marker;
}

/**
 * **Enforced** and **Advisory** — the claims that can be false.
 *
 * @param {RegistryScan} st accumulator: findings and enforcedRules are filled; wiring is read
 * @param {string} file
 * @param {Rule} rule
 * @param {string} marker
 */
function judgeGuardedRule(st, file, rule, marker) {
	const guards = guardPathsOf(rule.text);
	if (guards.length === 0) {
		reportRule(
			st,
			"NO-GUARD-NAMED",
			{ file, rule },
			`marked **${marker}** but names no guard path in backticks`,
		);
		return;
	}
	/* An Advisory guard speaks and never denies, so it has no deny
	 * message for the reprint pass to read: only Enforced rules go on.
	 * Residual: an Advisory guard that later grows a deny is never
	 * reprint-checked until its rule is re-marked Enforced. */
	if (marker === "Advisory") return;
	st.enforcedRules.push({
		file,
		line: rule.line,
		gist: gist(rule.text),
		text: rule.text,
		guards,
	});
}

/**
 * Every guard path a rule NAMES, whatever its marker (mantahostels#2347).
 *
 * @param {RegistryScan} st
 * @param {string} file
 * @param {Rule} rule
 * @param {string[]} guards
 */
function checkNamedPaths(st, file, rule, guards) {
	for (const g of guards) {
		/* Under the host root, else — where the root is no core tree at all —
		 * under the CORE's: an adopter's rules name the core's guards, which
		 * live in the plugin and are never copied into the repo (#5). */
		if (
			!fs.existsSync(path.join(root, g)) &&
			(rootIsCore() || !fs.existsSync(path.join(CORE_ROOT, g)))
		) {
			reportRule(
				st,
				"BROKEN-CLAIM",
				{ file, rule },
				`names \`${g}\`, which does not exist`,
			);
			continue;
		}
		// A hook file in .husky is run by git under its own name, so it
		// needs no reference anywhere to be live.
		if (g.startsWith(".husky/")) continue;
		if (!st.wiring.includes(g))
			reportRule(
				st,
				"UNWIRED",
				{ file, rule },
				`\`${g}\` exists but nothing triggers it — absent from ${hooksFile()}, package.json's scripts, .husky/* and .github/workflows/*`,
			);
	}
}

/** @param {RegistryScan} st accumulator: a NO-REGION finding is pushed where a region is missing */
function noRegionFindings(st) {
	/*
	 * No region is a finding, not a pass: delete the delimiters and every rule
	 * silently leaves scope.
	 *
	 * Named per file rather than counted repo-wide. A global count is satisfied by
	 * ANY region anywhere, so deleting CLAUDE.md's — the one document loaded into
	 * every session — would still pass on the strength of some region in docs/.
	 */
	const requiredRegionFiles = ["CLAUDE.md"];

	for (const required of requiredRegionFiles) {
		if (st.regionsByFile.get(required)) continue;
		// Conditional on existing: a repo without CLAUDE.md is not one missing a region.
		if (!fs.existsSync(path.join(root, required))) continue;
		st.findings.push({
			kind: "NO-REGION",
			file: required,
			line: 0,
			rule: "—",
			detail: `no ${BEGIN} region in this file, which is required to carry one`,
		});
	}

	if (st.regionCount === 0 && st.findings.every((f) => f.kind !== "NO-REGION"))
		st.findings.push({
			kind: "NO-REGION",
			file: "(repository)",
			line: 0,
			rule: "—",
			detail: `no ${BEGIN} region found in CLAUDE.md, AGENTS.md, docs/ or .claude/`,
		});
}

// --- staleness ---------------------------------------------------------------

/**
 * The three staleness warnings. The full run warns on each, marking it
 * `refusesCommit` so `--against` refuses a commit that adds one (#2617).
 *
 * Both surfaces anchor in one sidecar (mantahostels#1261). What a re-anchor ASSERTS differs
 * by surface and so the prose does: for a guard a rule names, that the rule was
 * re-read against the guard; for a wired implicit behaviour, that its own
 * IMPLICIT / JUSTIFIED / DEFEAT lines were re-read against what the script now
 * does. A path can be both, and then the warning says both.
 */
/**
 * @param {Map<string, RuleRef[]>} describedBy
 * @param {Map<string, WiredScript>} implicitScripts
 * @param {Record<string, string>} anchors
 * @returns {Warning[]}
 */
function stalenessWarnings(describedBy, implicitScripts, anchors) {
	/** @type {Warning[]} */
	const warnings = [];
	const targets = [
		...new Set([...describedBy.keys(), ...implicitScripts.keys()]),
	].sort();

	for (const g of targets) {
		const warning = targetWarning(g, describedBy, implicitScripts, anchors);
		if (warning) warnings.push(warning);
	}

	for (const g of Object.keys(anchors).sort())
		if (!describedBy.has(g) && !implicitScripts.has(g))
			warnings.push({
				kind: "ORPHAN-ANCHOR",
				guard: g,
				rules: [],
				detail: `anchored in ${ANCHORS} but no guard-registry rule names it, and the acting wiring does not reach it`,
			});

	return warnings;
}

/**
 * One target's UNANCHORED or STALE-PROSE warning, or null where its anchor
 * holds or it has no digest.
 *
 * @param {string} g
 * @param {Map<string, RuleRef[]>} describedBy
 * @param {Map<string, WiredScript>} implicitScripts
 * @param {Record<string, string>} anchors
 * @returns {Warning | null}
 */
function targetWarning(g, describedBy, implicitScripts, anchors) {
	const current = digestOf(g);
	if (current === null) return null;
	const rules = describedBy.get(g) ?? [];
	const recorded = anchors[g];
	/** @type {string[]} */
	const claims = [];
	if (rules.length > 0)
		claims.push(
			`the rule(s) at ${rules.map((r) => `${r.file}:${r.line}`).join(", ")}`,
		);
	if (implicitScripts.has(g))
		claims.push("its own IMPLICIT / JUSTIFIED / DEFEAT annotation");
	const what = claims.join(" and ");
	if (!recorded)
		return {
			kind: "UNANCHORED",
			guard: g,
			rules,
			detail: `no entry in ${ANCHORS}, so nothing records that ${what} was ever read against it`,
		};
	if (recorded !== current)
		return {
			kind: "STALE-PROSE",
			guard: g,
			rules,
			detail:
				`the guard or a library its digest hashes changed since the last review (anchored ${recorded}, now ${current}) — ` +
				`re-read ${what} against it`,
		};
	return null;
}

// --- reprinted rules (mantahostels#1032) -------------------------------------------------

/*
 * A rule whose text the guard REPRINTS when it denies is carrying bytes twice.
 *
 * mantahostels#886 ruled a payment route into the always-loaded pool: where a PreToolUse
 * hook denies, the bad command never runs, and the denial hands the session the
 * whole instruction — so the document's copy buys nothing a session could have
 * acted on earlier.
 *
 * THE QUALIFYING TEST (mantahostels#964). Duplication pays only where the guard DENIES ON
 * THE FIRST TRIGGER. Two shapes do not qualify, and a WARN firing on them would
 * push a session into cutting text that is load-bearing:
 *
 *   warn-only     the action completes, so the session had to know the rule
 *                 beforehand. Falls out of the readers: a warn message never
 *                 reaches gp_deny or a Node core's deny site, so such a guard
 *                 contributes no text here.
 *   delayed       the guard denies, but only after an allowance is spent.
 *                 lib/agent-poll.js is the measured counter-example:
 *                 its rule is "end the turn", and the denial arrives on the
 *                 THIRD poll, so a session that never read it has already done
 *                 the thing twice.
 *
 * DELAYED IS DECLARED, NOT INFERRED — a guard whose deny is delayed says so,
 * in a Node guard on the core, so every route that runs it is silenced:
 *
 *     # deny-timing: delayed — a session hits its allowance before it sees this
 *
 * Whether a deny fires on the first trigger or the fourth is a fact about state
 * accumulated across invocations, and reading `((seen >= allowance))` as
 * "delayed" is reading intent — which this script refuses everywhere else. A
 * declaration that goes stale is already caught: editing the guard moves its
 * digest, and STALE-PROSE then names every rule that guard describes.
 *
 * NEAR-VERBATIM, not identical. mantahostels#964's eight spans were reworded in the deny
 * text — "every dirty *tracked* file" against "every dirty TRACKED file" — so
 * exact matching would have found none of them. A rule sentence is a hit when at
 * least REPRINT_COVERAGE of its 5-word shingles appear in the guard's deny text,
 * both sides stripped of Markdown and punctuation. Sentences under
 * REPRINT_MIN_WORDS words are skipped: a short one both matches by accident and
 * is not worth cutting.
 *
 * SCOPE IS THE GUARD'S OWN FILE AND ITS CORE (#3001). A Node entry is read with
 * the core it takes `decide` from; scripts/guard-dispatch.js with each core its
 * manifest runs, narrowed to those the rule names in backticks; a core through
 * lib/core-deny-text.js. A guard that delegates its wording to a program
 * it runs — lib/file-claim.js, whose refusals session-arbiter.js prints — is a
 * known miss. Following the delegation would mean judging which of that
 * program's many messages this hook can reach, which is a reader's job.
 *
 * MEASURED RECALL: 2 of mantahostels#964's 8 spans, no false positive, measured against the
 * tree before that sweep (the pairs are on mantahostels#1032). The six misses are
 * PARAPHRASES, and nothing lexical separates a paraphrase from a rule merely
 * sharing its guard's topic — an unordered content-word measure was tried and
 * scored six plainly non-duplicated sentences above 0.6 on that same tree. So
 * silence here is not a finding that a rule is unduplicated; only a hand sweep
 * settles that.
 */

const REPRINT_SHINGLE = 5;
const REPRINT_MIN_WORDS = 12;
const REPRINT_COVERAGE = 0.6;

/* `# deny-timing: delayed — <why>`, in either comment spelling. Only the
 * delayed verdict is spellable: first-trigger is the default, so a guard
 * declaring it would be declaring the absence of a declaration. */
const DENY_TIMING_RE =
	/^[^\S\n]*(?:#|\/\/)[^\S\n]*deny-timing:[^\S\n]*delayed\b/m;

/* The house spelling for a deny message: a quoted heredoc read into a variable,
 * handed to gp_deny. The `$(cat <<…)` form is accepted too; a warn message is
 * built by plain assignment here and so never reaches this. An UNQUOTED heredoc
 * is read in its source form, `$var` and all — the expansion is a runtime fact,
 * and an unexpanded name simply fails to match, costing coverage, never adding
 * it. */
const HEREDOC_READ_RE =
	/\bread\b[^\n]*?\s([A-Za-z_]\w*)\s*<<-?\s*(['"]?)([A-Za-z_]\w*)\2(?:\s|$)/;
const HEREDOC_CAT_RE =
	/^\s*([A-Za-z_]\w*)=\$\(\s*cat\s*<<-?\s*(['"]?)([A-Za-z_]\w*)\2(?:\s|$)/;
/* `x+="$y"` (#1865): y's bodies MOVE to x, so a heredoc read into a second
 * variable and appended reaches x's deny, and y re-read in a later branch adds
 * its new body alone. Only that bare line matches: `x="$x$y"`, an unquoted
 * `x+=$y` or `x+="$y tail"` go unread, costing coverage, never adding it. */
const APPEND_VAR_RE = /^\s*([A-Za-z_]\w*)\+="\$\{?([A-Za-z_]\w*)\}?"\s*$/;
const DENY_VAR_RE = /gp_deny\s+"\$\{?([A-Za-z_]\w*)\}?"/;
const DENY_LITERAL_RE = /gp_deny\s+"([^"$]{20,})"/;

/**
 * Every deny message the guard can print, as raw text.
 *
 * A variable collects a LIST of bodies, not the latest one: a guard that picks
 * its wording in a `case` writes the same variable in every branch and denies
 * once after the `esac`, each branch reaching `reason` only through
 * `reason+="$rest"`.
 */
/** @param {string} source */
function denyTextsOf(source) {
	/* One iterator for both loops, so the lines a body consumes are not walked
	 * again as code. An array iterator survives the inner `break`; a generator
	 * would close there and end the outer walk. */
	const lines = source.split("\n")[Symbol.iterator]();
	/** variable name → every body assigned to it since it was last denied on. */
	/** @type {Map<string, string[]>} */
	const pending = new Map();
	/** @param {string} name */
	const bodiesOf = (name) => {
		const bodies = pending.get(name) ?? [];
		pending.set(name, bodies);
		return bodies;
	};
	/** @param {string} name */
	const takeBodies = (name) => {
		const bodies = pending.get(name) ?? [];
		pending.set(name, []);
		return bodies;
	};
	/** @type {string[]} */
	const texts = [];
	for (const line of lines) {
		const startRe = HEREDOC_CAT_RE.test(line)
			? HEREDOC_CAT_RE
			: HEREDOC_READ_RE;
		const start = startRe.exec(line);
		if (start) {
			const name = requiredGroup(start, 1, startRe);
			const delim = requiredGroup(start, 3, startRe);
			bodiesOf(name).push(parseHeredocBody(lines, delim));
			continue;
		}
		const append = APPEND_VAR_RE.exec(line);
		if (append) {
			const into = requiredGroup(append, 1, APPEND_VAR_RE);
			const from = requiredGroup(append, 2, APPEND_VAR_RE);
			bodiesOf(into).push(...takeBodies(from));
			continue;
		}
		const viaVar = DENY_VAR_RE.exec(line);
		if (viaVar) {
			texts.push(...takeBodies(requiredGroup(viaVar, 1, DENY_VAR_RE)));
			continue;
		}
		const literal = DENY_LITERAL_RE.exec(line);
		if (literal) texts.push(requiredGroup(literal, 1, DENY_LITERAL_RE));
	}
	return texts;
}

/**
 * The lines up to `delim`, consumed off the shared iterator so the caller's
 * walk resumes after them.
 *
 * @param {IterableIterator<string>} lines
 * @param {string} delim
 */
function parseHeredocBody(lines, delim) {
	/** @type {string[]} */
	const body = [];
	for (const next of lines) {
		if (next.trim() === delim) break;
		body.push(next);
	}
	return body.join("\n");
}

/*
 * Both sides reduced to bare lowercase words — Markdown emphasis and link syntax
 * carry none, and the deny text has neither.
 *
 * A BACKTICKED SPAN IS DROPPED, on both sides. A path or a command is shared
 * vocabulary rather than shared prose: the rule naming `scripts/guard-issue-body.js`
 * and that guard's own deny both point at `docs/agents/issue-tracker.md`, which
 * tokenises into eight words and carried the pair to 70% coverage on nothing but
 * the pointer — a rule mantahostels#964 read and ruled did not qualify. Comparing the words
 * AROUND the code spans is what asks whether the instruction is duplicated.
 */
/** @param {string} text */
function normaliseProse(text) {
	return text
		.replace(/`[^`]*`/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/* One rule is many candidate spans: its own sentence, and each sub-bullet's.
 * mantahostels#964 cut at sentence granularity, and so does this. */
/** @param {string} text */
function sentencesOf(text) {
	return (
		text
			.split("\n")
			.map((l) => l.replace(/^\s*[-*]\s+/, ""))
			.join("\n")
			/* The terminator may be followed by the emphasis or code markers closing
			 * around it — "…file open.**" ends a sentence exactly as "…file open." does,
			 * and not splitting there glues two sentences into one span that then
			 * matches neither. */
			.split(/(?<=[.!?][`*_)\]"']{0,4})\s+|\n+/)
	);
}

/**
 * @param {string[]} words
 * @param {number} k
 */
function shinglesOf(words, k) {
	/** @type {Set<string>} */
	const out = new Set();
	for (let i = 0; i + k <= words.length; i++)
		out.add(words.slice(i, i + k).join(" "));
	return out;
}

/** The rule's sentences that the deny corpus reprints, longest first. */
/**
 * @param {string} ruleText
 * @param {Set<string>} denyShingles
 */
function reprintedSpans(ruleText, denyShingles) {
	/** @type {{ span: string, coverage: number }[]} */
	const hits = [];
	for (const sentence of sentencesOf(ruleText)) {
		const words = normaliseProse(sentence).split(" ").filter(Boolean);
		if (words.length < REPRINT_MIN_WORDS) continue;
		const mine = [...shinglesOf(words, REPRINT_SHINGLE)];
		if (mine.length === 0) continue;
		const covered = mine.filter((s) => denyShingles.has(s)).length;
		if (covered / mine.length >= REPRINT_COVERAGE)
			hits.push({
				span: gist(sentence.trim()),
				coverage: Math.round((covered / mine.length) * 100),
			});
	}
	return hits.sort((a, b) => b.coverage - a.coverage);
}

/**
 * @typedef {{ delayed: boolean, texts: string[], core: string | null }} DenyFile
 *   `core` the module a Node entry takes `decide` from, beside it
 */

/**
 * One file's deny texts, or null where it is absent — BROKEN-CLAIM's business,
 * not this one's. A `.js` file is read as a Node core (#3001); any other as a
 * bash guard.
 * @param {string} rel
 * @returns {DenyFile | null}
 */
function readDenyFile(rel) {
	let source;
	try {
		source = fs.readFileSync(path.join(root, rel), "utf8");
	} catch {
		return null;
	}
	const node = rel.endsWith(".js");
	return {
		delayed: DENY_TIMING_RE.test(source),
		texts: node ? coreDenyTexts(source) : denyTextsOf(source),
		core: node ? decideModule(source) : null,
	};
}

/**
 * The files whose refusals a named guard prints, as groups that deny as one,
 * or null where the guard is absent.
 *
 * A Node entry is grouped with the core it takes `decide` from. The dispatcher
 * is one group per core its manifest runs — only the cores the rule names in
 * backticks, where it names any — so one delayed core silences itself alone.
 * @param {string} rel
 * @param {string} ruleText
 * @param {(rel: string) => DenyFile | null} read readDenyFile behind the memo
 *   reprintWarnings shares across rules, so a core many rules name is read once
 * @returns {DenyFile[][] | null}
 */
function denyGroupsOf(rel, ruleText, read) {
	if (rel === DISPATCH_ENTRY) {
		const rows = Object.values(readManifest(manifestAt(root))).flat();
		const named = rows.filter((r) => ruleText.includes(`\`${r.name}\``));
		return (named.length > 0 ? named : rows).map((r) => {
			const core = read(modulePath(r.core));
			return core === null ? [] : [core];
		});
	}
	const entry = read(rel);
	if (entry === null) return null;
	const core =
		entry.core === null ? null : read(path.join(path.dirname(rel), entry.core));
	return [core === null ? [entry] : [entry, core]];
}

/**
 * The guard's deny vocabulary for this rule, or null where it cannot pay for a
 * rule at all. A group declaring a delayed deny adds nothing: its deny lands
 * too late to pay.
 * @param {string} rel
 * @param {string} ruleText
 * @param {(rel: string) => DenyFile | null} read
 * @returns {Set<string> | null}
 */
function denyShinglesOf(rel, ruleText, read) {
	const groups = denyGroupsOf(rel, ruleText, read);
	if (groups === null) return null;
	const texts = groups
		.filter((g) => !g.some((f) => f.delayed))
		.flatMap((g) => g.flatMap((f) => f.texts));
	return shinglesOf(
		normaliseProse(texts.join("\n")).split(" ").filter(Boolean),
		REPRINT_SHINGLE,
	);
}

/**
 * One warn-only finding per rule/guard pair whose deny message reprints the rule.
 *
 * Never an exit-code-bearing finding: what to cut, and what residual to keep, is
 * a judgement the reader makes against mantahostels#964's test.
 */
/**
 * @param {(RuleRef & { text: string, guards: string[] })[]} candidates
 * @returns {Warning[]}
 */
function reprintWarnings(candidates) {
	/** @type {Warning[]} */
	const warnings = [];
	/** @type {Map<string, DenyFile | null>} */
	const fileCache = new Map();
	/** @param {string} rel */
	const read = (rel) => {
		if (!fileCache.has(rel)) fileCache.set(rel, readDenyFile(rel));
		return fileCache.get(rel) ?? null;
	};

	for (const rule of candidates) {
		for (const g of rule.guards) {
			const denyShingles = denyShinglesOf(g, rule.text, read);
			if (!denyShingles || denyShingles.size === 0) continue;

			const hits = reprintedSpans(rule.text, denyShingles);
			if (hits.length === 0) continue;
			warnings.push({
				kind: "REPRINTED",
				guard: g,
				rules: [{ file: rule.file, line: rule.line, gist: rule.gist }],
				spans: hits,
				detail:
					`denies on the first trigger and reprints ${hits.length} span(s) of this rule ` +
					"in its deny message, so a session that never read the rule is told it by the " +
					"refusal — the span(s) below may be cuttable (mantahostels#886's payment route, swept at mantahostels#964)",
			});
		}
	}
	return warnings;
}

// --- the rule-text store (mantahostels#1644) ---------------------------------------------

/*
 * THE THIRD ASSERTION. Spec mantahostels#1641 relocates the guard-backed §Conventions rules
 * out of the always-loaded CLAUDE.md and into the guards that refuse the
 * mistake: the rule's operative text moves to a fragment under docs/agents/rules/,
 * the guard prints it at the moment a session is about to break it, and
 * CLAUDE.md keeps one trigger line naming the trap and the fragment's id.
 *
 * THAT LEAVES FOUR WAYS FOR THE PAIR TO COME APART, and this pass fails on each:
 *
 *   ORPHAN-TRIGGER   a `rule:<id>` trigger names an id no fragment answers to.
 *                    Read from the whole document, not only its regions, and
 *                    from a script's comments and strings too (mantahostels#3135, below).
 *                    The session is told a rule exists and given no way to read
 *                    it.
 *   UNPRINTED-RULE   a fragment no WIRED emitter prints AND the manifest does not
 *                    list. The bytes left CLAUDE.md and arrived nowhere: a guard
 *                    rewrite dropped the call, or the emitter was never wired
 *                    (mantahostels#1641, user story 11).
 *   UNREADABLE-FRAGMENT  a fragment the accessor refuses — an empty one above
 *                    all, which a guard would splice into its refusal as "",
 *                    denying a session while stating no rule.
 *   EMITTED-MISSING  an emitter names a fragment that does not exist. Both
 *                    accessors refuse loudly on an unknown id, so this is a
 *                    guard that will throw or return 1 mid-hook — caught here
 *                    rather than on the session that trips it.
 *
 * THREE MORE, ON THE SECOND FRAGMENT CLASS (mantahostels#2496). A rule with no observable
 * Bash trigger is not printed by a guard at all: it is named in a command's
 * injected index and the session fetches it before acting (spec mantahostels#2457, T4). An
 * index naming an id in prose is not an emitter, so those fragments would every
 * one report UNPRINTED-RULE. The manifest mantahostels#2493 generates — docs/agents/rules/
 * manifest.json, id → { source, trigger } — is what tells the two classes apart:
 *
 *   MANIFEST-ORPHAN     the manifest names an id no fragment answers to, so a
 *                       session told to fetch it gets the accessor's refusal.
 *   MANIFEST-NO-TRIGGER a manifest entry names no trigger, leaving "when does
 *                       this bind" to the reader.
 *   UNINDEXED-RULE      a manifest id that no wired emitter prints and no
 *                       command's index names.
 *
 * NOTHING ASSERTS THAT A FRAGMENT ALSO KEEPS A TRIGGER LINE. ORPHAN-FRAGMENT
 * warned on that until mantahostels#2006 retired it; why, on mantahostels#2006.
 *
 * WIRED, not merely present. "Printed by a live emitter" has to mean reachable
 * from self-plugin/hooks/hooks.json, a .husky hook, a workflow or a package.json
 * script, or a fragment printed only by a script nothing runs would pass while
 * reaching no session. Liveness
 * propagates along the same dependency edges the staleness anchors use
 * (sourcedBy): a guard sources lib/rule-text.sh and its own logic may sit in a
 * lib, so a lib a wired guard reaches is live too.
 *
 * THE EMITTER IS STILL READ FROM THE ACCESSOR CALL, never from the manifest. A
 * register of "which guard prints which rule" is exactly the hand-kept surface
 * mantahostels#169 and mantahostels#1180 both found goes stale silently.
 *
 * A THIRD CALL SHAPE (mantahostels#1804): the pre-emptive emitter, which takes its ids
 * literally and resolves them through the same accessors at run time.
 *
 * KNOWN LIMITS, and they are the price of reading source rather than running it:
 *  - An id built at runtime — `rule_text "$id"` — is invisible. Both accessors
 *    demand a literal kebab-case id at the call site to be seen here.
 *  - A commented-out call still counts as an emitter. The reprint pass above has
 *    the same property, and stripping comments would drop a call inside a
 *    heredoc that genuinely does print.
 *  - .husky/ is not an emitter root. Its hooks carry no extension, so a rule
 *    printed inline by .husky/pre-commit would report UNPRINTED-RULE. A husky
 *    hook that must print one calls a scripts/ helper, as every gate there
 *    already does.
 *  - It never asserts the printed text REACHES stdout on a triggering payload.
 *    That is each guard's own test's business (spec mantahostels#1641's testing decisions),
 *    and asserting it here would mean running every guard on every check.
 */

const {
	readRuleIds: storedRuleIds,
	readRuleText: ruleTextOf,
	manifestPath,
	rulesDir,
	fragmentPath,
	RULES_DIR,
} = require("./lib/rule-text");

/*
 * Where a command's index is rendered. `scripts/inject-tracker-docs.sh` builds
 * each command's injected context, so a rule id it names is a rule some session
 * is told to fetch. Read as prose — an id in a comment there counts.
 */
const INDEX_SOURCES = ["scripts/inject-tracker-docs.sh"];

/** A trigger line's pointer at a fragment: a backticked `rule:` and the id. */
const TRIGGER_RE = /`rule:([a-z0-9-]+)`/g;

/*
 * A CITATION IN SOURCE (mantahostels#3135). The same backticked shape is read from every
 * script this check already opens as an emitter, comments and strings alike —
 * the backslash-escaped backtick a bash double-quoted string needs included.
 *
 * MENTION, NOT CITATION: the store's own seam discusses the id grammar with
 * `rule:x` and `rule:-x`, so a one-character id, or one the grammar refuses,
 * names nothing and is skipped.
 *
 * EVERY EMITTER FILE IS READ, wired or not: the walk that decides liveness
 * cannot see an extension-less `require("./lib/x")`, the majority spelling, so
 * narrowing to what it reaches would drop most of scripts/lib/.
 *
 * NOT READ: an id spelled without backticks, which is how a guard's log line
 * names a rule in passing; and the two accessors, whose headers spell the call
 * out for a reader (NOT_EMITTERS).
 */
const SOURCE_CITATION_RE = /\\?`rule:([a-z0-9-]+)\\?`/g;
/** The id grammar the emitter patterns accept, at a length a placeholder is not. */
const CITED_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** @param {string} id */
const isCitedId = (id) => id.length > 1 && CITED_ID_RE.test(id);

/*
 * The pre-emptive emitter (mantahostels#1804). An `injectRules` decision's ids resolve
 * through lib/guard-entry.js at run time, so the accessor call there carries a
 * variable and is invisible to DIRECT_RULE_RE.
 *
 * EVERY ACCESSOR PATTERN LIVES IN scripts/lib/rule-emission.js (mantahostels#2003, #2905),
 * bash and Node spellings alike, which reads the same calls to price a
 * PreToolUse event. Two copies would let this gate and that one disagree about
 * which guard prints which fragment.
 */
const {
	directAccessorCalls,
	emissionMatches,
	REQUIRE_RE,
	RULE_ARG_RE,
} = require("./lib/rule-emission");
const { spawnGitSync } = require("./lib/git.js");

/* Where an emitter can live. Guards and their libs sit under scripts/; a hook
 * command under .claude/ is wired the same way and may print a rule too. */
const EMITTER_ROOTS = ["scripts", ".claude"];
const EMITTER_EXTS = [".js", ".cjs", ".mjs", ".sh"];

/* Whole second copies of the tree, untracked and invisible in `git status`.
 * .gitignore, vitest.config.ts and biome.json all exclude it already; a stale
 * worktree carrying an old rule id would otherwise fail the gate on a file
 * nobody can see. */
const EMITTER_SKIP = new Set([...SKIP_DIRS, "worktrees"]);

/* The store's own accessors define the seam and never print a rule, so their
 * headers may spell a call out for a reader without becoming an emitter. */
const NOT_EMITTERS = new Set([
	path.join("scripts", "lib", "rule-text.js"),
	path.join("scripts", "lib", "rule-text.sh"),
]);

/**
 * Push every emitter-shaped file under `rel` of `base` onto `out`, recursing.
 *
 * @param {string} base
 * @param {string} rel
 * @param {string[]} out accumulator: each emitter-shaped file is pushed here
 */
function walkEmitterDir(base, rel, out) {
	const abs = path.join(base, rel);
	let entries;
	try {
		entries = fs.readdirSync(abs, { withFileTypes: true });
	} catch {
		return; // a root that does not exist holds no emitters
	}
	for (const e of entries) {
		if (e.isSymbolicLink()) continue; // vendored skills; see doc-map §A
		const file = path.join(rel, e.name);
		if (!e.isDirectory()) {
			if (isEmitterFile(e.name, file)) out.push(file);
		} else if (!EMITTER_SKIP.has(e.name)) walkEmitterDir(base, file, out);
	}
}

function isEmitterFile(/** @type {string} */ name, /** @type {string} */ file) {
	return EMITTER_EXTS.some((x) => name.endsWith(x)) && !NOT_EMITTERS.has(file);
}

/**
 * Every emitter-shaped file under `roots` of `base`, as paths relative to it.
 *
 * @param {string} [base] `root`, or CORE_ROOT for an adopter's plugin-hosted guards
 * @param {string[]} [roots]
 * @returns {string[]}
 */
function emitterFiles(base = root, roots = EMITTER_ROOTS) {
	/** @type {string[]} */
	const out = [];
	for (const r of roots) walkEmitterDir(base, r, out);
	/* check-ignore answers for `root`'s repo alone, and the core's scripts/ holds
	 * nothing ignored that EMITTER_SKIP does not already name. */
	if (base !== root) return out.sort();
	/* The same filter scannedFiles() takes, and for a sharper reason: the read
	 * below is deliberately unguarded, so an ENOENT surfaces as BROKEN — and
	 * .claude/tmp/ is the one directory where a neighbouring session creates and
	 * deletes files while this runs, between the readdir and the read (mantahostels#2243).
	 * EMITTER_SKIP names `worktrees` and cannot name every ignored path. */
	return dropIgnored(out.sort());
}

/**
 * The manifest's entries, with the text it was parsed from so a finding can
 * point at the line the id sits on.
 *
 * A missing manifest is an empty one, matching readRuleIds()'s treatment of a
 * missing store: a checkout before the generator's first run must not fail the
 * gate. Anything else — a read error, malformed JSON — escapes as BROKEN, since
 * it is a file this check reads the repo with.
 *
 * @returns {{ entries: Map<string, { trigger?: unknown }>, file: string, text: string }}
 */
function loadManifest() {
	const file = path.relative(root, manifestPath());
	let text;
	try {
		text = fs.readFileSync(path.join(root, file), "utf8");
	} catch (e) {
		if (caught(e).code !== "ENOENT") throw e;
		return { entries: new Map(), file, text: "" };
	}
	const rules = JSON.parse(text)?.rules ?? {};
	return { entries: new Map(Object.entries(rules)), file, text };
}

/**
 * Every rule id named in a WIRED command's index.
 *
 * Wired, on the same terms an emitter is: an injector nothing runs renders its
 * index for nobody.
 *
 * An index source that does not exist holds no ids — a throwaway root builds
 * none, and the index itself arrives one ticket after this gate (spec mantahostels#2457, T4).
 *
 * @param {string} wiring
 * @returns {Set<string>}
 */
function readIndexedRuleIds(wiring) {
	/** @type {Set<string>} */
	const ids = new Set();
	for (const rel of INDEX_SOURCES) {
		if (!wiring.includes(rel)) continue;
		const text = readIndexSource(rel);
		if (text === null) continue;
		for (const m of text.matchAll(TRIGGER_RE)) if (m[1]) ids.add(m[1]);
	}
	return ids;
}

/**
 * One index source's text, or null where it does not exist yet.
 *
 * @param {string} rel
 * @returns {string | null}
 */
function readIndexSource(rel) {
	/* An adopter's commands are the core's, rendered by the plugin's own
	 * injector (#97) — the root's copy where it has one, as ever. */
	const base =
		rootIsCore() || fs.existsSync(path.join(root, rel)) ? root : CORE_ROOT;
	try {
		return fs.readFileSync(path.join(base, rel), "utf8");
	} catch (e) {
		/* ENOENT alone is "no index yet"; anything else is unreadable, and
		 * reading it as empty FAILs every manifest id on the wrong cause. */
		if (caught(e).code !== "ENOENT") throw e;
		return null;
	}
}

/**
 * Every accessor call in one emitter's text, each with the line it sits on.
 *
 * @param {string} text
 * @returns {{ id: string, line: number }[]}
 */
function accessorCalls(text) {
	/** @type {{ id: string, line: number }[]} */
	const calls = directAccessorCalls(text).map(({ id, index }) => ({
		id,
		line: lineOf(text, index),
	}));
	calls.push(...emitRuleCalls(text));
	return calls;
}

/**
 * The ids an `injectRules` decision names, each with the decision's line.
 *
 * @param {string} text
 * @returns {{ id: string, line: number }[]}
 */
function emitRuleCalls(text) {
	/** @type {{ id: string, line: number }[]} */
	const calls = [];
	for (const m of emissionMatches(text)) {
		const line = lineOf(text, m.index ?? 0);
		for (const a of (m[1] ?? "").matchAll(RULE_ARG_RE))
			if (a[1]) calls.push({ id: a[1], line });
	}
	return calls;
}

/**
 * The files wiring reaches, directly or along `deps`.
 *
 * @param {Map<string, string[]>} deps
 * @param {string} wiring
 * @returns {Set<string>}
 */
function liveFiles(deps, wiring) {
	const live = new Set([...deps.keys()].filter((rel) => wiring.includes(rel)));
	const queue = [...live];
	while (queue.length > 0) {
		const rel = queue.shift();
		if (!rel) continue;
		for (const dep of deps.get(rel) ?? [])
			if (!live.has(dep)) {
				live.add(dep);
				queue.push(dep);
			}
	}
	return live;
}

/**
 * id → the CORE's live emitters printing it, judged from an adopter (#97).
 *
 * An adopter's guards run out of the plugin root, wired by the core's own
 * hooks/hooks.json (readWiringCorpus), so a fragment the adopter generates for one
 * of them is
 * printed from there. Read for liveness ONLY: a fault in the core's own files is
 * the core's gate to report, never an adopter's commit to carry. Empty in a
 * core tree, whose emitters the main walk already reads.
 *
 * @param {string} wiring
 * @returns {Map<string, string[]>}
 */
function corePrintedBy(wiring) {
	/** @type {Map<string, string[]>} */
	const printed = new Map();
	if (rootIsCore()) return printed;
	/** @type {Map<string, string[]>} */
	const deps = new Map();
	/** @type {Map<string, { id: string }[]>} */
	const callsBy = new Map();
	for (const rel of emitterFiles(CORE_ROOT, ["scripts"])) {
		const text = fs.readFileSync(path.join(CORE_ROOT, rel), "utf8");
		deps.set(rel, sourcedBy(rel, text, CORE_ROOT));
		callsBy.set(rel, accessorCalls(text));
	}
	const live = liveFiles(deps, wiring);
	for (const [rel, calls] of callsBy)
		if (live.has(rel))
			for (const { id } of calls)
				printed.set(id, [...(printed.get(id) ?? []), rel]);
	return printed;
}

/**
 * Judge the store: the seven findings above.
 *
 * @param {(RuleRef & { id: string })[]} triggerRefs
 * @param {string} wiring
 * @returns {{ findings: Finding[], fragments: string[], printedBy: Map<string, string[]> }}
 */
function scanRuleStore(triggerRefs, wiring) {
	const fragments = storedRuleIds();
	const manifest = loadManifest();
	const indexed = readIndexedRuleIds(wiring);
	const { callsBy, deps, citationsBy } = readEmitters();

	const live = liveFiles(deps, wiring);

	const { printedBy, findings } = emittedCalls(callsBy, live, fragments);
	for (const [id, rels] of corePrintedBy(wiring))
		printedBy.set(id, [...(printedBy.get(id) ?? []), ...rels]);

	findings.push(
		...orphanTriggerFindings(triggerRefs, citationsBy, fragments),
		...fragmentFindings(fragments, printedBy, manifest),
		...manifestFindings({ manifest, fragments, printedBy, indexed }),
	);

	return { findings, fragments, printedBy };
}

/**
 * Every emitter's accessor calls, source deps and `rule:<id>` citations.
 *
 * @returns {{
 *   callsBy: Map<string, { id: string, line: number }[]>,
 *   deps: Map<string, string[]>,
 *   citationsBy: Map<string, { id: string, line: number }[]>,
 * }}
 */
function readEmitters() {
	/** file → the ids it names, with the line each call sits on. */
	/** @type {Map<string, { id: string, line: number }[]>} */
	const callsBy = new Map();
	/** file → the libs and delegates it reaches, for the liveness walk. */
	/** @type {Map<string, string[]>} */
	const deps = new Map();
	/** file → the `rule:<id>` citations its comments and strings carry. */
	/** @type {Map<string, { id: string, line: number }[]>} */
	const citationsBy = new Map();

	for (const rel of emitterFiles()) {
		/* Deliberately unguarded, like walk()'s readdirSync above: an emitter this
		 * check cannot read is a file it reads the repo WITH, so it must surface as
		 * BROKEN via runCheck's catch. Swallowing it drops that file's calls, and a
		 * fragment it really does print then reports UNPRINTED-RULE — a FAIL naming
		 * the wrong thing. */
		const text = fs.readFileSync(path.join(root, rel), "utf8");
		deps.set(rel, sourcedBy(rel, text));
		const cited = citationsIn(text);
		if (cited.length > 0) citationsBy.set(rel, cited);
		const calls = accessorCalls(text);
		if (calls.length > 0) callsBy.set(rel, calls);
	}
	return { callsBy, deps, citationsBy };
}

/**
 * The `rule:<id>` citations one emitter's text carries.
 *
 * @param {string} text
 * @returns {{ id: string, line: number }[]}
 */
function citationsIn(text) {
	/** @type {{ id: string, line: number }[]} */
	const cited = [];
	for (const m of text.matchAll(SOURCE_CITATION_RE))
		if (m[1] && isCitedId(m[1]))
			cited.push({ id: m[1], line: lineOf(text, m.index ?? 0) });
	return cited;
}

/**
 * id → the live emitters printing it, and an EMITTED-MISSING finding for each
 * call naming no fragment.
 *
 * @param {Map<string, { id: string, line: number }[]>} callsBy
 * @param {Set<string>} live
 * @param {string[]} fragments
 * @returns {{ printedBy: Map<string, string[]>, findings: Finding[] }}
 */
function emittedCalls(callsBy, live, fragments) {
	/** @type {Finding[]} */
	const findings = [];
	/** id → the live emitters printing it. */
	/** @type {Map<string, string[]>} */
	const printedBy = new Map();
	for (const [rel, calls] of callsBy)
		for (const { id, line } of calls) {
			if (live.has(rel)) printedBy.set(id, [...(printedBy.get(id) ?? []), rel]);
			if (!fragments.includes(id))
				findings.push({
					kind: "EMITTED-MISSING",
					file: rel,
					line,
					rule: `rule id "${id}"`,
					detail:
						`prints rule id "${id}", but ${RULES_DIR}/${id}.txt does not exist — ` +
						"both accessors refuse loudly on an unknown id, so this call fails at " +
						"hook time. Write the fragment or fix the id.",
				});
		}
	return { printedBy, findings };
}

/**
 * ORPHAN-TRIGGER: a document trigger, then a script citation, naming no fragment.
 *
 * @param {(RuleRef & { id: string })[]} triggerRefs
 * @param {Map<string, { id: string, line: number }[]>} citationsBy
 * @param {string[]} fragments
 * @returns {Finding[]}
 */
function orphanTriggerFindings(triggerRefs, citationsBy, fragments) {
	/** @type {Finding[]} */
	const findings = [];
	for (const t of triggerRefs)
		if (!fragments.includes(t.id))
			findings.push({
				kind: "ORPHAN-TRIGGER",
				file: t.file,
				line: t.line,
				rule: t.gist,
				detail:
					`names rule id "${t.id}", which resolves to no fragment in ${RULES_DIR}/. ` +
					"The session is told a rule exists and given no way to read it.",
			});

	for (const [rel, cited] of citationsBy)
		for (const { id, line } of cited)
			if (!fragments.includes(id))
				findings.push({
					kind: "ORPHAN-TRIGGER",
					file: rel,
					line,
					rule: `rule id "${id}"`,
					detail:
						`cites rule id "${id}", which resolves to no fragment in ${RULES_DIR}/: ` +
						"write the fragment, or reword the line to stop citing an id.",
				});
	return findings;
}

/**
 * UNREADABLE-FRAGMENT and UNPRINTED-RULE, fragment by fragment.
 *
 * @param {string[]} fragments
 * @param {Map<string, string[]>} printedBy
 * @param {ReturnType<typeof loadManifest>} manifest
 * @returns {Finding[]}
 */
function fragmentFindings(fragments, printedBy, manifest) {
	/** @type {Finding[]} */
	const findings = [];
	for (const id of fragments) {
		/* Read through the accessor rather than fs, so the gate refuses exactly
		 * what a guard would refuse at hook time — an empty fragment among it. */
		try {
			ruleTextOf(id);
		} catch (e) {
			findings.push({
				kind: "UNREADABLE-FRAGMENT",
				file: `${RULES_DIR}/${id}.txt`,
				line: 1,
				rule: `rule id "${id}"`,
				detail: `${caught(e).message} A guard printing it would refuse the same way.`,
			});
		}
		/* Where the fragment is the CORE's — the host has no store, or has one
		 * without this id, so the plugin layer supplies it — whether some
		 * emitter of the CORE's prints it is a question about the core's tree,
		 * not this one (#5, #97). */
		if (!printedBy.has(id) && !manifest.entries.has(id) && !isForeignRule(id))
			findings.push({
				kind: "UNPRINTED-RULE",
				file: `${RULES_DIR}/${id}.txt`,
				line: 1,
				rule: `rule id "${id}"`,
				detail:
					"no wired emitter prints this fragment, so the rule reaches no session. " +
					unprintedRemedy(id),
			});
	}
	return findings;
}

/** UNPRINTED-RULE's remedy, which differs between the core and an adopter. */
function unprintedRemedy(/** @type {string} */ id) {
	if (rootIsCore())
		return (
			"Call it from the guard that refuses the mistake — `rule_text " +
			`${id}\` from bash, \`readRuleText("${id}")\` from Node — or delete the fragment.`
		);
	/* An adopter's own wiring counts (#925). The README is the
	 * plugin's: an adopter's store carries none. */
	return (
		`Call \`rule_text ${id}\` (bash) or \`readRuleText("${id}")\` (Node) ` +
		"from a guard of your own under scripts/ or .claude/, " +
		`and wire that guard from this repo's ${hooksFile()}, a package.json script, ` +
		"a .husky hook or a workflow — or delete the fragment. A rule a session " +
		"fetches from a command's index has no adopter route: workflow-core's " +
		`${RULES_DIR}/README.md §Adding one.`
	);
}

/**
 * MANIFEST-ORPHAN, MANIFEST-NO-TRIGGER and UNINDEXED-RULE, entry by entry.
 *
 * @param {{
 *   manifest: ReturnType<typeof loadManifest>,
 *   fragments: string[],
 *   printedBy: Map<string, string[]>,
 *   indexed: Set<string>,
 * }} store
 * @returns {Finding[]}
 */
function manifestFindings({ manifest, fragments, printedBy, indexed }) {
	/** @type {Finding[]} */
	const findings = [];
	for (const [id, entry] of manifest.entries) {
		/* Math.max: an id whose JSON spelling is escaped is not found literally,
		 * and lineOf(-1) would silently drop the last character. */
		const line = lineOf(
			manifest.text,
			Math.max(0, manifest.text.indexOf(`"${id}"`)),
		);
		const at = { file: manifest.file, line, rule: `rule id "${id}"` };
		if (!fragments.includes(id))
			findings.push({
				...at,
				kind: "MANIFEST-ORPHAN",
				detail:
					`the manifest names rule id "${id}", which resolves to no fragment in ` +
					`${RULES_DIR}/. A session told to fetch it gets the accessor's refusal. ` +
					"Re-render with `node scripts/generate-rule-fragments.js`.",
			});
		if (typeof entry?.trigger !== "string" || !entry.trigger.trim())
			findings.push({
				...at,
				kind: "MANIFEST-NO-TRIGGER",
				detail:
					`the manifest entry for rule id "${id}" names no trigger, so when the ` +
					"rule binds is left to the reader. Give it a TRIGGERS row in " +
					"scripts/generate-rule-fragments.js and re-render.",
			});
		/* A manifest id is always the host's own. Where the host has no store
		 * the manifest is the core's, judged in the core's tree (#5); an
		 * adopter's own is judged here against the core's emitters and index
		 * too (corePrintedBy, readIndexedRuleIds). */
		if (!printedBy.has(id) && !indexed.has(id) && !foreignStore())
			findings.push({
				...at,
				kind: "UNINDEXED-RULE",
				detail:
					`rule id "${id}" is printed by no wired emitter and named in no ` +
					`command's index (${INDEX_SOURCES.join(", ")}), so it reaches no ` +
					"session by either route. Render it into the index of every command " +
					"that can trigger it, or wire an emitter.",
			});
	}
	return findings;
}

// --- --review ----------------------------------------------------------------

/**
 * One line of --review's report. writeFd, never console: a session runs
 * --review through Bash, so stdout is a pipe, and node drops what is still
 * buffered on one at the `process.exit` that ends the run (#1444).
 *
 * @param {string} line
 */
const printLine = (line) => writeFd(1, `${line}\n`);

/**
 * The targets a live neighbour holds and has left dirty, bar those `ours`
 * names as this commit's; the ones it set aside, as `taken`; and — where the
 * question could not be asked at all — why not.
 *
 * Re-anchoring asserts a human read that guard. A file another session is
 * mid-edit on is one nobody has read in the state about to be hashed, so
 * anchoring it certifies a neighbour's uncommitted work under this session's
 * name (mantahostels#2636).
 *
 * Fails open, and says so: `unavailable` carries the reason the caller prints,
 * because a run with no `not anchored` line otherwise reads as "nobody holds
 * anything" when it may mean the claim store never answered.
 *
 * `WFC_ANCHOR_LOCKS` replaces the claim store with a JSON array of lock
 * records. Unguarded, and deliberately at the store boundary rather than at
 * this function's result: `neighbourDirty`'s own filtering, the dirty read and
 * the session-name lookup all still run against it (mantahostels#2636).
 *
 * @param {string[]} targets
 * @param {Set<string>} ours
 * @returns {{held: Map<string, HeldEntry>, taken: Map<string, HeldEntry>, unavailable: string|null}}
 */
function readHeldElsewhere(targets, ours) {
	const wanted = new Set(targets);
	/** @type {Map<string, HeldEntry>} */
	const held = new Map();
	/** @type {Map<string, HeldEntry>} */
	const taken = new Map();
	try {
		const { readTreeSnapshot, neighbourDirty } = require("./lib/tree-drift.js");
		const { registryNames } = require("./lib/arbiter-core.js");
		const self = process.env.CLAUDE_CODE_SESSION_ID || "";
		if (!self)
			return { held, taken, unavailable: "this session is unidentified" };
		const snap = readTreeSnapshot(root);
		if (!snap)
			return { held, taken, unavailable: "git would not read this tree" };
		const injected = process.env.WFC_ANCHOR_LOCKS;
		const locks = injected
			? JSON.parse(injected)
			: require("./lib/arbiter-store.js").listLocks();
		if (locks === null)
			return { held, taken, unavailable: "the claim store would not be read" };
		const nameFor = registryNames();
		for (const e of neighbourDirty(snap, locks, self) ?? [])
			if (wanted.has(e.path))
				(ours.has(e.path) ? taken : held).set(e.path, {
					holder: nameFor(e.sessionId),
					dead: e.dead,
				});
		return { held, taken, unavailable: null };
	} catch (e) {
		return {
			held,
			taken,
			unavailable: `the claim read failed: ${caught(e).message}`,
		};
	}
}

/**
 * The paths this commit stages whole: changed in its index against HEAD, with
 * no working-tree bytes beyond the index's (#3255). A pathspec commit's index
 * is private to its hook, so only the gate can read this; --review is told the
 * same paths by `--taking`.
 *
 * @returns {{ paths: Set<string>, error: string | null }}
 */
function readStagedWhole() {
	const staged = gitPaths([
		"diff",
		"--cached",
		"--no-renames",
		"--name-only",
		"-z",
		"HEAD",
	]);
	const unstaged = gitPaths(["diff", "--no-renames", "--name-only", "-z"]);
	const error = staged.error ?? unstaged.error;
	if (error) return { paths: new Set(), error };
	const rest = new Set(unstaged.paths);
	return { paths: new Set(staged.paths.filter((p) => !rest.has(p))), error };
}

/**
 * Each path's digest inputs, itself included, and every path's together.
 *
 * @param {string[]} paths
 * @returns {{ hashedBy: Map<string, Set<string>>, inputs: string[] }}
 */
function readDigestInputs(paths) {
	const hashedBy = new Map(
		paths.map((g) => {
			/** @type {Set<string>} */
			const hashed = new Set();
			digestOf(g, hashed);
			return [g, hashed];
		}),
	);
	const inputs = [...new Set([...hashedBy.values()].flatMap((h) => [...h]))];
	return { hashedBy, inputs };
}

/**
 * @param {Set<string> | undefined} inputs
 * @param {Map<string, HeldEntry>} held
 * @returns {HeldInput[]}
 */
function heldInputs(inputs, held) {
	return [...(inputs ?? [])].flatMap((p) => {
		const h = held.get(p);
		return h ? [{ path: p, ...h }] : [];
	});
}

/** @param {HeldInput} h */
const buildHeldLine = (h) =>
	`${h.path} is dirty and claimed by ${h.holder}${h.dead ? " (GONE)" : ""}`;

/**
 * Re-anchor the guards named and end the process. A write command: it reports no
 * findings, so it has no outcome and never reaches the reporting below.
 */
/**
 * @param {{ paths: string[], taking: string[] }} request the paths to anchor, and those this commit carries though a claim holds them
 * @param {Map<string, RuleRef[]>} describedBy
 * @param {Map<string, WiredScript>} implicitScripts
 * @param {Record<string, string>} anchors
 * @returns {never}
 */
function reanchor(request, describedBy, implicitScripts, anchors) {
	const { paths: reviewPaths, taking } = request;
	/*
	 * Re-anchoring asserts a human re-read the rules describing that guard, so
	 * the command prints them: a reviewer who sees no rule has anchored nothing
	 * meaningful.
	 */
	const targets =
		reviewPaths.length > 0
			? reviewPaths
			: [...new Set([...describedBy.keys(), ...implicitScripts.keys()])].sort();
	const { hashedBy, inputs } = readDigestInputs(targets);
	const { held, taken, unavailable } = readHeldElsewhere(
		inputs,
		new Set(taking),
	);
	for (const [p, h] of taken)
		printLine(
			`taking ${p} from ${h.holder}${h.dead ? " (GONE)" : ""}'s claim — put it in this commit's pathspec`,
		);
	if (unavailable)
		printLine(
			`claim check skipped — ${unavailable}, so a path a neighbour holds ` +
				"dirty would be anchored here unnoticed",
		);
	/** @type {ReviewRun} */
	const run = {
		describedBy,
		implicitScripts,
		anchors,
		hashedBy,
		held,
		next: reviewPaths.length > 0 ? { ...anchors } : {},
		missing: [],
		skipped: [],
		anyGone: false,
		written: 0,
	};

	for (const g of targets) reanchorTarget(run, g);

	const { next, missing, written } = run;
	const dropped =
		reviewPaths.length > 0
			? []
			: Object.keys(anchors).filter((g) => !(g in next));
	for (const g of dropped)
		printLine(`dropped ${g} — no rule names it and no wiring reaches it`);

	saveAnchors(next);
	for (const g of missing)
		printLine(
			g in anchors
				? `dropped ${g} — file does not exist`
				: `skipped ${g} — file does not exist`,
		);
	// The count is what this run WROTE, not the file's size (mantahostels#2636).
	const carried = Object.keys(next).length - written;
	printLine(buildReviewSummary(run, carried).join("\n"));
	process.exit(0);
}

/**
 * One --review run's inputs and tallies, threaded through each target.
 *
 * @typedef {{
 *   describedBy: Map<string, RuleRef[]>,
 *   implicitScripts: Map<string, WiredScript>,
 *   anchors: Record<string, string>,
 *   hashedBy: Map<string, Set<string>>,
 *   held: Map<string, HeldEntry>,
 *   next: Record<string, string>,
 *   missing: string[],
 *   skipped: string[],
 *   anyGone: boolean,
 *   written: number,
 * }} ReviewRun
 */

/**
 * Anchor one target, or skip it as held or missing. Held means the target or
 * any file its digest hashes, as the pre-commit gate's stand-down reads it
 * (#2853), so a held shared library leaves every guard sourcing it unanchored.
 *
 * @param {ReviewRun} run accumulator: next, missing, skipped, anyGone and written are filled; the rest is read
 * @param {string} g
 */
function reanchorTarget(run, g) {
	const holders = heldInputs(run.hashedBy.get(g), run.held);
	if (holders.length > 0) {
		run.skipped.push(g);
		run.anyGone ||= holders.some((h) => h.dead);
		/* Carried over rather than dropped: a bare --review starts from an
		 * empty map, so losing the entry would turn a skip into UNANCHORED. */
		const anchor = run.anchors[g];
		if (anchor !== undefined) run.next[g] = anchor;
		printLine(
			`not anchored ${g} — ${holders.map(buildHeldLine).join("; ")}, so nothing here read the bytes it would hash`,
		);
		return;
	}
	const d = digestOf(g);
	if (d === null) {
		run.missing.push(g);
		delete run.next[g];
		return;
	}
	if (!run.describedBy.has(g) && !run.implicitScripts.has(g)) {
		const had = g in run.next;
		delete run.next[g];
		printLine(
			`${had ? "dropped" : "skipped"} ${g} — no rule names it and no wiring reaches it`,
		);
		return;
	}
	run.next[g] = d;
	run.written++;
	printLine(`anchored ${g} @ ${d}`);
	printDescriptions(run, g);
}

/**
 * What an anchored target asserts was re-read: its rules, its annotation, or
 * both.
 *
 * @param {ReviewRun} run
 * @param {string} g
 */
function printDescriptions({ describedBy, implicitScripts }, g) {
	for (const r of describedBy.get(g) ?? [])
		printLine(`  describes: ${r.file}:${r.line}  ${r.gist}`);
	const wired = implicitScripts.get(g);
	if (wired)
		for (const l of buildImplicitLines(wired, "  implicit: ", { detail: true }))
			printLine(l);
}

/**
 * @param {ReviewRun} run
 * @param {number} carried
 * @returns {string[]}
 */
function buildReviewSummary({ written, skipped, anyGone }, carried) {
	const lines = [
		`\n${written} path(s) re-anchored in ${ANCHORS}. ` +
			"Re-anchoring asserts everything printed as anchored above was re-read against the file.",
	];
	if (carried)
		lines.push(
			`${carried} existing entr${carried === 1 ? "y was" : "ies were"} left byte-identical — this run asserts nothing about ${carried === 1 ? "it" : "them"}.`,
		);
	if (skipped.length > 0)
		lines.push(
			`${skipped.length} named path(s) not anchored: dirty under another session's claim. ` +
				(anyGone
					? "A holder marked GONE will never release: commit or revert the file."
					: "Re-run once the holder releases."),
		);
	return lines;
}

// --- the pre-commit gate ------------------------------------------------------

/*
 * A COMMIT THAT EXPIRES AN ANCHOR IS REFUSED (#2617). These warnings carry
 * `refusesCommit`, which lib/fault-profiles.js's profile gates on, so
 * `--against HEAD` refuses a stale row the index has and HEAD does not. The child read the
 * materialised index, so the digests and anchors judged are the commit's bytes
 * and a neighbour's dirty edit neither causes nor clears a refusal. GUARD-GONE
 * never reaches it: a deleted guard a rule still names is a FAIL, and one no
 * rule names is ORPHAN-ANCHOR.
 *
 * settleAdded runs in the parent, over the live tree. It stands down a row
 * whose guard, or a file its digest hashes, a neighbour holds dirty — a GONE
 * holder's included, since --review skips that too and the refusal could not
 * be cleared — and prints the way out: re-read, re-anchor, stage the anchors file in the same
 * commit. No reason footer stands a refusal down: it would leave the anchor
 * stale and the full run's count above zero.
 */
const STALE_KINDS = new Set(["UNANCHORED", "STALE-PROSE", "ORPHAN-ANCHOR"]);

/** @typedef {import("./lib/check.js").FaultItem} FaultItem */

/** @param {FaultItem} f */
const staleOf = (f) => {
	const item = /** @type {StaleWarning} */ (f.item);
	return item?.[REFUSES_COMMIT] ? item : null;
};

/** @param {string} guard */
const buildReviewLine = (guard) =>
	`node scripts/check-guard-registry.js --review ${guard}`;

/**
 * A refused or exempted fault as the lander names it in a hold or a fix
 * ticket: the row, and the fix-forward it waits on.
 * @param {FaultItem} f
 * @returns {{ row: string, forward: string }}
 */
function buildRowForward(f) {
	const w = staleOf(f);
	return w
		? { row: `${w.kind} ${w.guard}`, forward: buildReviewLine(w.guard) }
		: { row: f.line, forward: "fix the rule or the guard the row names" };
}

/*
 * A LANDER REVERT LANDS WITH ITS STALE ROWS (#3127). The revert re-opens a
 * held queue, and a stale row is prose owed a re-read, not a broken build, so
 * where WFC_LANDER_REVERT names a culprit and lib/clean-revert.js confirms the
 * judged bytes are its clean revert, the staleness findings stand down and the
 * lander's fix ticket owes the re-read. Every other fault still refuses.
 * Re-anchoring in the revert instead would assert a read nobody made. At
 * commit the message is not yet written, so only the tree is confirmed; the
 * push confirms the revert line too.
 */

/**
 * The culprit this commit or push is a confirmed clean revert of, or null.
 * @param {Ctx} ctx
 * @returns {string|null}
 */
function readExemptRevert(ctx) {
	const culprit = readLanderRevert();
	if (culprit === null) return null;
	const { rev: tip, head: pushed } = againstRevs(ctx);
	/* The committing tree's git, as --against materialises it: under a
	 * worktree, CLAUDE_PROJECT_DIR can name another tree's index. */
	const cwd = process.cwd();
	const why = pushed
		? whyNotLanderRevert(cwd, { culprit, sha: pushed, tip })
		: whyNotCleanIndex(cwd, culprit, tip);
	if (why === null) return culprit;
	ctx.say(
		`${LANDER_REVERT_ENV} names ${culprit}, but no staleness exemption: ${why}.`,
	);
	return null;
}

/**
 * Why the index is not the clean revert of `culprit` on `onto`, or null.
 * @param {string} cwd
 * @param {string} culprit
 * @param {string} onto
 * @returns {string|null}
 */
function whyNotCleanIndex(cwd, culprit, onto) {
	const tree = spawnGitSync(["-C", cwd, "write-tree"], { encoding: "utf8" });
	if (tree.status !== 0) return "the index cannot be written as a tree";
	return whyNotCleanRevert(cwd, {
		culprit,
		onto,
		tree: String(tree.stdout).trim(),
	});
}

/**
 * The faults this commit adds that refuse it, the way out of the stale ones,
 * and each refused or exempted row with its fix-forward.
 *
 * @param {Ctx} ctx
 * @param {FaultItem[]} added
 * @returns {{ refuse: FaultItem[], remedy: string[], data: object }}
 */
function settleAdded(ctx, added) {
	const stale = added.filter((f) => staleOf(f) !== null);
	const culprit = stale.length > 0 ? readExemptRevert(ctx) : null;
	const { refuse, remedy } =
		culprit === null
			? settleStale(ctx, added)
			: { refuse: added.filter((f) => staleOf(f) === null), remedy: [] };
	const exempted = culprit === null ? [] : stale.map(buildRowForward);
	if (exempted.length > 0)
		for (const line of [
			`not refusing ${exempted.length} stale row(s): this is the lander's clean revert of ${culprit} (#3127), and its fix ticket owes each re-read:`,
			...exempted.map((r) => `  ${r.row}: ${r.forward}`),
		])
			ctx.say(line);
	return {
		refuse,
		remedy,
		data: { refused: refuse.map(buildRowForward), exempted },
	};
}

/**
 * The faults this commit adds that refuse it, and the way out of the stale
 * ones.
 *
 * @param {Ctx} ctx
 * @param {FaultItem[]} added
 * @returns {{ refuse: FaultItem[], remedy: string[] }}
 */
function settleStale(ctx, added) {
	const stale = added.map(staleOf).filter((w) => w !== null);
	if (stale.length === 0) return { refuse: added, remedy: [] };

	const { rev: tip, head: pushed } = againstRevs(ctx);
	const { hashedBy, inputs } = readDigestInputs(stale.map((w) => w.guard));
	const { held, taken, unavailable } = readHeldAtGate(ctx, inputs, pushed);
	/* A neighbour's dirty input stands the row down: its unstaged bytes are in any digest --review would write, and staging or
	 * setting them aside is the neighbour's call. One this commit stages whole is this commit's own (#3255). */
	const heldIn = (/** @type {string} */ g) => heldInputs(hashedBy.get(g), held);
	for (const w of stale) {
		const by = heldIn(w.guard);
		if (by.length > 0)
			ctx.say(
				`not refusing ${w.guard} — ${by.map(buildHeldLine).join("; ")}, so no re-anchor here could hash ` +
					"this commit's bytes; the post-commit notice names it.",
			);
	}
	const refuse = added.filter((f) => {
		const w = staleOf(f);
		return w === null || heldIn(w.guard).length === 0;
	});
	const owed = stale.filter((w) => heldIn(w.guard).length === 0);
	if (owed.length === 0) return { refuse, remedy: [] };

	const owedInputs = owed.flatMap((w) => [...(hashedBy.get(w.guard) ?? [])]);
	const changed = gitPaths([
		"diff",
		...(pushed
			? ["--name-only", "-z", tip, pushed]
			: ["--cached", "--name-only", "-z", "HEAD"]),
		"--",
		...new Set(owedInputs),
	]);
	const { scripts: implicitScripts } = scanImplicit();
	const remedy = [
		"",
		pushed
			? `${pushed} leaves the guard-registry anchor(s) above expired on ${tip}'s tree (#3074). Re-read what each records against the path as pushed:`
			: "This commit leaves the guard-registry anchor(s) above expired (#2617). Re-read what each records against the path as staged:",
	];
	/* The read only adds the "(through …)" notes (#2853). */
	if (changed.error)
		remedy.push(
			`  the paths each row went stale through not named — git diff${pushed ? "" : " --cached"} failed (${changed.error}).`,
		);
	for (const w of owed) {
		const via = [...(hashedBy.get(w.guard) ?? [])].filter(
			(p) => p !== w.guard && changed.paths.includes(p),
		);
		remedy.push(...buildExpiredRow(w, via, implicitScripts.has(w.guard)));
	}
	const takes = [...new Set(owedInputs)]
		.filter((p) => taken.has(p))
		.map((p) => ` --taking ${p}`);
	const review = buildReviewLine(
		owed.map((w) => w.guard).join(" ") + takes.join(""),
	);
	remedy.push(
		...(pushed
			? [
					/* --review hashes the tree it runs in, and the committing tree
					 * may not be this sha's. */
					`  correct any sentence no longer true, then re-anchor on ${pushed}'s own tree, not the one you committed in:`,
					`    git worktree add --detach <dir> ${pushed} && cd <dir> && ${review}`,
					`  commit ${ANCHORS} there, and push that commit to ${tip}'s branch.`,
				]
			: [
					"  correct any sentence no longer true, re-anchor those paths alone (an orphaned one is dropped) with",
					`    ${review}`,
					`  and put ${ANCHORS} in this commit's pathspec.`,
					...diverged(owedInputs),
				]),
	);
	if (unavailable)
		remedy.push(
			`  claim check skipped — ${unavailable}, so a path a neighbour holds dirty refuses here too.`,
		);
	return { refuse, remedy };
}

/**
 * The claims standing a stale row down at the gate. At push the judged bytes
 * are a commit's, which no neighbour's dirty input can reach and no
 * post-commit notice follows, so nothing stands down.
 *
 * @param {Ctx} ctx
 * @param {string[]} inputs
 * @param {string | undefined} pushed
 */
function readHeldAtGate(ctx, inputs, pushed) {
	if (pushed) return { held: new Map(), taken: new Map(), unavailable: null };
	const ours = readStagedWhole();
	/* Fails open (#3255): an unread index exempts nothing, so a claimed file
	 * this commit stages whole still stands its row down. */
	if (ours.error)
		ctx.say(
			`staged read failed (${ours.error}), so a claimed file this commit stages whole still stands its row down.`,
		);
	return readHeldElsewhere(inputs, ours.paths);
}

/**
 * The paths a `git -z --name-only` read lists, or why it could not answer.
 *
 * @param {string[]} args
 * @returns {{ paths: string[], error: string | null }}
 */
function gitPaths(args) {
	const r = spawnGitSync(["-C", root, ...args], {
		encoding: "utf8",
	});
	if (r.error || r.status !== 0)
		return { paths: [], error: r.error?.message ?? `exit ${r.status}` };
	return { paths: r.stdout.split("\0").filter(Boolean), error: null };
}

/**
 * A line for each digest input, or the anchors file, whose working-tree bytes
 * differ from the index's: --review hashes the working tree, so its anchor
 * would not match this commit and the refusal would recur.
 *
 * @param {string[]} inputs
 * @returns {string[]}
 */
function diverged(inputs) {
	const { paths, error } = gitPaths([
		"diff",
		"--name-only",
		"-z",
		"--",
		ANCHORS,
		...new Set(inputs),
	]);
	/* A hint, not the verdict, so a failed read costs only the hint (#2617). */
	if (error)
		return [
			`  index and working tree not compared — git diff failed (${error}).`,
		];
	return paths.map((p) =>
		p === ANCHORS
			? `  ${ANCHORS} in the working tree differs from the staged copy: a re-anchor already run is not in this commit until the file is in its pathspec.`
			: `  ${p} in the working tree differs from the staged copy, and --review hashes the working tree: put it in this commit's pathspec, or set the unstaged part aside, before re-anchoring.`,
	);
}

// --- --touched-by ------------------------------------------------------------

/*
 * --touched-by NAMES THE ANCHORS ONE COMMIT EXPIRED (#2375), for
 * .husky/post-commit: an anchored path whose digest no longer matches, where the
 * commit changed a file that digest hashes. The pre-commit gate refuses such a
 * commit, so what reaches this notice is a row that gate stood down as held by
 * a neighbour, a row already stale at HEAD that the commit touched again, or a
 * commit the gate never ran on (`HUSKY=0`). A path a neighbour's commit left
 * stale stays the full run's.
 *
 * The digests read the working tree, as --review's anchoring does, so the
 * notice and the re-anchor it asks for hash the same bytes. Residual: a
 * neighbour's dirty edit to a file the commit also touched is folded into the
 * digest, and --review then skips that path as held.
 *
 * Only anchored paths are walked, so a commit pays three git reads and their
 * digests; the registry scan runs only to name the rules of a path it
 * reports, and its gitignore read runs outside the ceiling. A path a commit
 * newly names in a rule is the full run's UNANCHORED, and a merge commit
 * lists nothing in diff-tree's form.
 */

/**
 * The anchors as `rev` committed them, so a re-anchor left out of the commit
 * still reads as expired; none where `rev` carries no anchors file.
 *
 * @param {Ctx} ctx
 * @param {import("./lib/git-ceiling.js").GitCeiling} ceiling
 * @param {string} rev
 * @returns {Record<string, string>}
 */
function readAnchorsAt(ctx, ceiling, rev) {
	const listed = String(
		gitUnder(ctx, ceiling, `list ${ANCHORS} at ${rev}`, [
			"ls-tree",
			"--name-only",
			rev,
			"--",
			ANCHORS,
		]),
	).trim();
	if (!listed) return {};
	const text = String(
		gitUnder(ctx, ceiling, `read ${ANCHORS} at ${rev}`, [
			"show",
			`${rev}:${ANCHORS}`,
		]),
	);
	const wayOut = `restore it, re-anchor with  node scripts/check-guard-registry.js --review  and commit ${ANCHORS}.`;
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return ctx.broken(
			`${ANCHORS} at ${rev} is not JSON: ${caught(e).message}; ${wayOut}`,
		);
	}
	if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
	return ctx.broken(`${ANCHORS} at ${rev} is not a JSON object; ${wayOut}`);
}

/**
 * One git read under the ceiling, BROKEN on a hang or a git fault.
 *
 * @param {Ctx} ctx
 * @param {import("./lib/git-ceiling.js").GitCeiling} ceiling
 * @param {string} what
 * @param {string[]} args
 */
function gitUnder(ctx, ceiling, what, args) {
	return brokenOnFault(ctx, what, () =>
		ceiling.git(
			["-C", root, ...args],
			{
				encoding: "utf8",
				maxBuffer: MAX_BUFFER,
				stdio: ["ignore", "pipe", "pipe"],
			},
			`git ${args[0]}`,
		),
	);
}

/**
 * `read`'s answer, BROKEN where it passes the ceiling or git faults.
 *
 * @template T
 * @param {Ctx} ctx
 * @param {string} what
 * @param {() => T} read
 * @returns {T}
 */
function brokenOnFault(ctx, what, read) {
	try {
		return read();
	} catch (e) {
		if (e instanceof CeilingPassed) return ctx.broken(e.message);
		return ctx.broken(
			`git cannot ${what}: ${caught(e).message.split("\n")[0]}`,
		);
	}
}

/**
 * The anchored paths `touched` expired: each changed one, with the touched
 * files its digest hashes, and each one `touched` deleted.
 *
 * @param {Map<string, string>} touched
 * @param {Record<string, string>} anchors
 */
function expiredBy(touched, anchors) {
	/** @type {{ guard: string, via: string[] }[]} */
	const expired = [];
	/** @type {string[]} */
	const gone = [];
	for (const g of Object.keys(anchors).sort()) {
		if (touched.get(g) === "D") {
			gone.push(g);
			continue;
		}
		/** @type {Set<string>} */
		const hashed = new Set();
		const d = digestOf(g, hashed);
		const via = [...hashed].filter((p) => touched.has(p));
		if (d !== null && d !== anchors[g] && via.length > 0)
			expired.push({ guard: g, via: via.filter((p) => p !== g) });
	}
	return { expired, gone };
}

/**
 * Warn on, and print, each expired or gone anchor with the rules to re-read.
 *
 * @param {Ctx} ctx
 * @param {ReturnType<typeof expiredBy>} found
 * @param {Record<string, string>} anchors
 * @returns {Warning[]}
 */
function sayExpired(ctx, { expired, gone }, anchors) {
	const { describedBy } = scanRegistry();
	const { scripts: implicitScripts } = scanImplicit();
	/** @type {Warning[]} */
	const warnings = [];
	const say = (
		/** @type {Warning} */ w,
		/** @type {string[]} */ via,
		/** @type {boolean} */ annotated,
	) => {
		warnings.push(w);
		ctx.warn(w.kind, `${w.guard} — ${w.detail}`, w);
		for (const l of buildExpiredRow(w, via, annotated)) ctx.say(l);
	};
	for (const { guard, via } of expired) {
		const w = targetWarning(guard, describedBy, implicitScripts, anchors);
		if (w) say(w, via, implicitScripts.has(guard));
	}
	for (const g of gone)
		say(
			{
				kind: "GUARD-GONE",
				guard: g,
				rules: describedBy.get(g) ?? [],
				detail: "this commit deleted it, and its anchor stands",
			},
			[],
			false,
		);
	return warnings;
}

/**
 * @param {Pick<Warning, "kind" | "guard" | "rules">} w
 * @param {string[]} via
 * @param {boolean} annotated the path carries its own IMPLICIT annotation
 * @returns {string[]}
 */
function buildExpiredRow(w, via, annotated) {
	return [
		`  ${w.kind}  ${w.guard}${via.length > 0 ? ` (through ${via.join(", ")})` : ""}`,
		...w.rules.map((r) => `    rule:  ${r.file}:${r.line}  ${r.gist}`),
		...(annotated
			? ["    and its own IMPLICIT / JUSTIFIED / DEFEAT annotation"]
			: []),
	];
}

/**
 * @param {Ctx} ctx
 */
function runTouched(ctx) {
	if (ctx.has("--review"))
		ctx.usageError("--touched-by reports; it does not combine with --review.");
	const rev = ctx.value("--touched-by", "HEAD");
	const ceiling = touchedByCeiling();
	const anchors = readAnchorsAt(ctx, ceiling, rev);
	const touched = brokenOnFault(ctx, `list what ${rev} changed`, () =>
		readTouchedBy(root, rev, ceiling),
	);
	const found = expiredBy(touched, anchors);
	if (found.expired.length === 0 && found.gone.length === 0)
		return {
			okLine: `${rev} left every anchored guard's registry prose as anchored.`,
			data: { rev, warnings: [] },
		};

	ctx.say(
		"This commit changed a guard the guard registry describes, or a file its digest hashes (#2375):",
	);
	const warnings = sayExpired(ctx, found, anchors);
	ctx.say(
		"  Once your changes are done, re-read each rule above against the guard as it now is, " +
			"correct any sentence that is no longer true — and for a guard gone, the rules naming it, " +
			"anchoring its new path where it moved — re-anchor that guard alone with  " +
			"node scripts/check-guard-registry.js --review <guard-path>  (a gone path's anchor is dropped) " +
			`and commit ${ANCHORS}.`,
	);
	return {
		noun: "guard(s) whose registry prose this commit expired",
		data: { rev, warnings },
	};
}

// --- report -----------------------------------------------------------------

/** @typedef {import("./lib/check").CheckContext} Ctx */

/**
 * Where `--review` sits in argv, -1 where absent — refusing the flags it
 * cannot run beside.
 *
 * @param {Ctx} ctx
 * @returns {number}
 */
function reviewIndex(ctx) {
	const reviewAt = ctx.argv.indexOf("--review");
	if (reviewAt === -1) return reviewAt;
	/* --review writes anchors and reports no findings, so it has no outcome to
	 * serialise — refuse the pair rather than emit an envelope describing a run
	 * that never happened. */
	if (ctx.asJson)
		ctx.usageError(
			"--review writes anchors and reports no findings, so it has no --json form.",
		);
	/* --review writes ANCHORS back, so under --root it would write them into
	 * the throwaway copy and read as a re-anchoring that never happened. */
	if (ctx.has("--root"))
		ctx.usageError(
			"--review writes anchors into the tree it read, so it cannot run under --root.",
		);
	return reviewAt;
}

/** The summary's last line: what the gitignore filter did to the walk. */
function buildIgnoreLine() {
	if (ignoreFailure)
		return `Gitignore filter FAILED OPEN — ${ignoreFailure}. Scope is the whole walk, scratch included.`;
	if (ignoreSkipped)
		return "Gitignore filter: not run — a materialised tree holds tracked files only.";
	return `Gitignore filter: ${ignoreDropped} path(s) dropped as ignored.`;
}

/**
 * Each warning in full, then the footer for each kind present.
 *
 * @param {Ctx} ctx
 * @param {Warning[]} warnings
 */
function sayWarnings(ctx, warnings) {
	for (const w of warnings) {
		ctx.say(`${w.kind}  ${w.guard}`);
		for (const r of w.rules) ctx.say(`  rule:  ${r.file}:${r.line}  ${r.gist}`);
		for (const h of w.kind === "REPRINTED" ? w.spans : [])
			ctx.say(`  span:  ${h.coverage}% — ${h.span}`);
		ctx.say(`  note:  ${w.detail}\n`);
	}

	const staleCount = warnings.filter((w) => STALE_KINDS.has(w.kind)).length;
	const reprintCount = warnings.filter((w) => w.kind === "REPRINTED").length;

	if (staleCount > 0)
		ctx.say(
			`${staleCount} guard(s) whose registry prose may have gone stale.\n` +
				"  Re-read each rule above against its guard, then clear it with\n" +
				"  node scripts/check-guard-registry.js --review <guard-path>.\n" +
				"  Warnings here; .husky/pre-commit refuses the commit that adds one.\n",
		);

	if (reprintCount > 0)
		ctx.say(
			`${reprintCount} rule(s) whose text its guard reprints when it denies.\n` +
				"  The denial hands the session the whole instruction after refusing the\n" +
				"  command, so the document copy may be cuttable — read the deny text, then\n" +
				"  cut only what it carries, keeping any residual it does not (mantahostels#964).\n" +
				"  Where the deny is NOT reached on the first trigger, the rule must stay:\n" +
				"  declare that in the guard with a `# deny-timing: delayed` comment.\n" +
				"  Warnings only — this never fails the build.\n",
		);
}

/**
 * Each finding in full, then the remedy for each surface that has one.
 *
 * @param {Ctx} ctx
 * @param {{
 *   findings: Finding[],
 *   registryFindings: Finding[],
 *   implicitFindings: Finding[],
 *   storeFindings: Finding[],
 *   ifFindings: Finding[],
 * }} found
 */
function sayFindings(
	ctx,
	{ findings, registryFindings, implicitFindings, storeFindings, ifFindings },
) {
	if (findings.length === 0) return;
	for (const f of findings) {
		ctx.say(`${f.kind}  ${f.file}:${f.line}`);
		ctx.say(`  ${f.surface ? "wiring" : "rule"}:  ${f.rule}`);
		ctx.say(`  fault: ${f.detail}\n`);
	}
	if (registryFindings.length > 0)
		ctx.say(
			"  A rule between the guard-registry delimiters must carry exactly one of\n" +
				"  **Enforced** (naming a wired guard path that refuses), **Advisory** (naming a\n" +
				"  wired guard path that only speaks), **Unenforced** (naming the issue that owns\n" +
				"  building it), or **Unenforceable**. Fix the rule or fix the claim —\n" +
				"  never the marker alone, which is the stale label mantahostels#102 ruled out.\n",
		);
	if (implicitFindings.length > 0)
		ctx.say(
			"  A script the acting wiring reaches does something to a session that never\n" +
				"  asked for it, so its own header must say what — three lines, anywhere in the\n" +
				"  header comment:\n\n" +
				"    IMPLICIT:  <one line — what this does to a session without being asked>\n" +
				"    JUSTIFIED: fail-safe | convenience — <why>\n" +
				"    DEFEAT:    none | <the env var or flag>\n\n" +
				"  `none` and `convenience` are both legal answers: DEFEAT records what escape\n" +
				"  exists and never demands one (mantahostels#1181), and whether convenience is good enough\n" +
				"  is a reader's call. Unwire the script instead if it should not act at all.\n",
		);
	if (storeFindings.length > 0)
		ctx.say(
			"  A rule relocated into its guard has two parts that must agree: the\n" +
				`  fragment in ${RULES_DIR}/, and the accessor call in a WIRED guard that\n` +
				"  prints it. Missing either means a session never meets the rule at all,\n" +
				"  and a `rule:<id>` trigger naming no fragment means it meets a pointer to\n" +
				`  nothing. Convention: ${RULES_DIR}/README.md.\n`,
		);
	if (ifFindings.length > 0)
		ctx.say(
			`  An \`if\` field in ${hooksFile()} decides whether a hook's script is\n` +
				"  exec'd at all, so every blind spot the script's header enumerates is\n" +
				"  computed against it. State the narrowing verbatim in that header —\n\n" +
				"    #  - Wired with `if: Bash(*git*)` since mantahostels#2061 (best-effort: <what it costs>)\n\n" +
				"  — one line where its LIMITS section already runs long, its own paragraph\n" +
				"  where it does not (docs/agents/guard-authoring.md, surface 4). A header\n" +
				"  stating a narrowing the wiring no longer carries fails the same way: that\n" +
				"  is the stale label mantahostels#102 ruled out, pointed at the wiring instead of a rule.\n" +
				"  UNWIRED-IF is the same fault with no hook entry left to point at: delete\n" +
				"  the header line, or wire the script (mantahostels#2234).\n",
		);
}

runCheck({
	name: "guard-registry",
	usage: `node check-guard-registry.js [--warn] [--json] [--roster] [--root <dir>] [--against <rev>] [--head <rev>] | --touched-by <rev> [--root <dir>] (BROKEN past ${TOUCHED_BY_CEILING_MS / 1000}s) | --review [<path>…] [--taking <path>]…`,
	valueFlags: ["--root", "--touched-by", "--taking"],
	/* Whole-tree, not a pathspec: scanRegistry walks CLAUDE.md, AGENTS.md, docs/
	 * and .claude/ AND every guard path a rule names, which is a scope no list
	 * here could be kept in step with (mantahostels#1753). */
	against: {
		profile: "guard-registry",
		materialise: "tree",
		refuse(ctx) {
			/* --review writes ANCHORS back, and --against re-execs this file over
			 * throwaway copies — the same fault as --review --root below. */
			if (ctx.has("--review"))
				ctx.usageError(
					"--review writes anchors into the tree it read, so it cannot run under --against.",
				);
		},
		settle: settleAdded,
	},
	flags: ["--review", "--roster"],
	run(ctx) {
		setRoot(ctx.value("--root"));
		if (ctx.has("--touched-by")) return runTouched(ctx);
		const reviewAt = reviewIndex(ctx);
		const reviewing = reviewAt !== -1;

		const {
			findings: registryFindings,
			describedBy,
			enforcedRules,
			triggerRefs,
			files,
			regionCount,
			ruleCount,
			byMarker,
		} = scanRegistry();
		const { findings: implicitFindings, scripts: implicitScripts } =
			scanImplicit();
		const { findings: storeFindings, fragments } = scanRuleStore(
			triggerRefs,
			readWiringCorpus(),
		);
		const { findings: ifFindings, narrowed } = scanIfNarrowing();
		const findings = [
			...registryFindings,
			...implicitFindings,
			...storeFindings,
			...ifFindings,
		];
		const anchors = loadAnchors();

		if (reviewing) {
			/* Bare arguments after --review; empty means "every guard the registry
			 * names". */
			const after = ctx.argv.slice(reviewAt + 1);
			const reviewPaths = after.filter(
				(a, i) => !a.startsWith("--") && after[i - 1] !== "--taking",
			);
			const taking = ctx.argv.filter((_, i) => ctx.argv[i - 1] === "--taking");
			reanchor(
				{ paths: reviewPaths, taking },
				describedBy,
				implicitScripts,
				anchors,
			);
		}

		const warnings = [
			...stalenessWarnings(describedBy, implicitScripts, anchors),
			...reprintWarnings(enforcedRules),
		];

		for (const f of findings)
			ctx.fail(f.kind, `${f.file}:${f.line} — ${f.detail}`, f);
		/* Warn-only in this run: staleness is a prompt to re-read prose against
		 * its guard, never a claim that the prose is wrong. The mark is what
		 * --against refuses a commit that adds one on (§the pre-commit gate). */
		for (const w of warnings)
			ctx.warn(
				w.kind,
				`${w.guard} — ${w.detail}`,
				STALE_KINDS.has(w.kind) ? { ...w, [REFUSES_COMMIT]: true } : w,
			);

		ctx.say(
			`Scanned ${files.length} document(s): ${regionCount} guard-registry region(s), ` +
				`${ruleCount} rule(s) — ${byMarker.Enforced} enforced, ${byMarker.Advisory} advisory, ` +
				`${byMarker.Unenforced} unenforced, ${byMarker.Unenforceable} unenforceable.\n` +
				`Walked the acting wiring: ${implicitScripts.size} implicit behaviour(s) — ` +
				`${implicitJustifications(implicitScripts).join(", ")}:\n` +
				`Rule-text store: ${fragments.length} fragment(s) in ${RULES_DIR}/, ` +
				`${triggerRefs.length} trigger(s) naming one.\n` +
				`Hook \`if\` narrowings: ${narrowed.size} wired script(s) exec'd on a narrowed set, ` +
				`${declaredIfUnreadable} unreadable emitter(s) skipped on the declared side (mantahostels#2234).\n` +
				buildIgnoreLine(),
		);

		/*
		 * EVERY RUN NAMES THEM, one line each. mantahostels#1261 asked for exactly that — "the
		 * run names every wired script it reached — so the 7 behaviours mantahostels#1180 found
		 * documented nowhere outside their own script become visible by running it"
		 * — and a flag would have made the seven visible only to someone who
		 * already knew to ask. What is behind --roster is the DETAIL: each entry's
		 * IMPLICIT line and its escape, which is the part that would be wallpaper
		 * on a pre-commit run (mantahostels#109).
		 */
		for (const [rel, info] of implicitScripts)
			for (const l of buildImplicitLines(info, `  ${rel}  `, {
				detail: ctx.has("--roster") || implicitFindings.length > 0,
			}))
				ctx.say(l);
		ctx.say("");

		sayWarnings(ctx, warnings);

		sayFindings(ctx, {
			findings,
			registryFindings,
			implicitFindings,
			storeFindings,
			ifFindings,
		});

		return {
			okLine:
				"every rule in scope states its backing, every claim holds, every wired " +
				"implicit behaviour says what it does to a session, every relocated " +
				"rule's fragment and emitter agree, and every hook `if` narrowing is " +
				"stated in the script it narrows.",
			noun:
				findings.length > 0
					? "rule(s) or wired script(s) whose stated backing or behaviour is missing or false"
					: "advisory finding(s): registry prose that may have gone stale, or a rule " +
						"its guard reprints",
			data: {
				regionCount,
				ruleCount,
				byMarker,
				ifNarrowings: [...narrowed].map(([file, values]) => ({ file, values })),
				findings,
				total: findings.length,
				warnings,
				ruleStore: {
					fragments,
					triggers: triggerRefs.map((t) => ({
						id: t.id,
						file: t.file,
						line: t.line,
					})),
				},
				implicit: [...implicitScripts].map(([file, info]) => ({
					file,
					triggers: info.triggers,
					annotation: info.annotation,
				})),
			},
		};
	},
});
