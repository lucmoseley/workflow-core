#!/usr/bin/env node
/*
 * mutation-hold-gate.js — the pre-commit hold on a line a commit changes on a
 * declared sensitive path, while a planted bug on it survives every test
 * (#1906, spec #1871).
 *
 * IMPLICIT:  with the `mutation` module on, refuses a commit whose staged code paths match a glob `sensitivePaths` declares in `.claude/workflow-core.json` while any mutant StrykerJS plants on a line the commit adds or changes survives, or has no covering test, or while the suite is red on HEAD plus the commit's changes; the refusal names the areas, one line per mutant and rule:mutation-hold. It refuses too, running nothing, a `Stryker disable` comment stating no reason that the commit adds, arms, or widens over a line it adds.
 * JUSTIFIED: fail-safe — branch coverage reads high where planted bugs survive every test (#1851), so a test gap on money or personal-data code is seen at commit or not at all.
 * DEFEAT:    a reasoned `// Stryker disable` comment over the mutant; `HUSKY=0` and `core.hooksPath` off .husky/_ skip it with the rest of the stack; WFC_STRYKER names the Stryker binary, so a value writing an all-killed report defeats it; WFC_MUTATION_COMMENTS_TIMEOUT_MS set too short leaves the disable comments unread, so Stryker honours an unreasoned one.
 *
 *   node scripts/mutation-hold-gate.js             from .husky/pre-commit
 *   node scripts/mutation-hold-gate.js --due       from commit-paths
 *   node scripts/mutation-hold-gate.js --pre-lock  from commit-paths
 *   node scripts/mutation-hold-gate.js --seed      by hand, once, to seed the cache
 *
 * BEFORE THE LOCK (#1910): commit-paths asks `--due` whether the hold would
 * run Stryker on the index $GIT_INDEX_FILE names, runs its early gates where
 * it would, and then the hold itself, `--pre-lock`, whose green it stamps
 * (lib/commit-key.js, gate `mutation`). The hook stands down on that stamp.
 *
 * WHICH PATHS: the staged paths the declaration matches, read at HEAD and as
 * staged as the review hold reads it, so a commit cannot drop its own area to
 * escape; and of those only code Stryker can mutate whose name is no test by
 * the patterns Stryker's default `mutate` excludes. The rest are named in one
 * stderr line. The module switch is read at both revisions the same way,
 * first: off at both, the hold reads and reports nothing more (#2077). The
 * switch is read through git, so a git refusing that read still fails open.
 *
 * WHICH LINES: the new side of each zero-context hunk that adds a line, as one
 * `path:start-end` range. A commit adding no line on a mutable path runs
 * nothing. The run is HEAD plus exactly the commit's changes, in a throwaway
 * worktree (lib/isolated-worktree.js), so a neighbour's unsaved file reaches
 * neither the verdict nor the mutants.
 *
 * STRYKER'S OPTIONS: the host's own config, the first the commit's tree holds
 * at its root in Stryker's discovery order, or the core default; over either,
 * the hold sets `mutate`, incremental mode and file, the JSON reporter and its
 * path, concurrency and no thresholds, through a generated wrapper, since
 * the report path and thresholds have no CLI form and passing a config turns
 * discovery off (#1901). The host's file is never written (#1907).
 *
 * THE CACHE is Stryker's incremental file, at CACHE_NAME in the git common
 * directory, shared by every worktree. A run seeds its own copy and, whatever
 * the verdict, renames it back, so concurrent runs leave a whole file and the
 * last writer wins. No cache costs one cold run (#1907).
 *
 * SEEDING (#1912): `--seed` pays that cold run with no commit, over every
 * file HEAD holds that the declaration at HEAD matches and the hold would
 * mutate. It judges nothing: survivors already in the tree are no commit's
 * to answer for.
 *
 * THE VERDICT is the JSON report's, never Stryker's exit code, which is 0 with
 * survivors (#1901): Survived and NoCoverage refuse; Killed, Timeout and
 * Ignored pass; CompileError and RuntimeError are left out, as is a static
 * mutant no test ran, which the vitest runner reports Survived falsely (#1901),
 * named in one stderr line. Only mutants inside the run's own ranges count: a
 * report carries cached results from other ranges (#1901). A failed initial
 * test run refuses as red tests.
 *
 * DISABLE COMMENTS are read after the missing-tool check (#2366): the read
 * goes through the instrumenter's `@babel/core` under the host's Babel config
 * and `mutator.plugins`, asynchronously as Stryker parses (#2573, #2624), so a
 * missing Stryker refuses first, and an unreasoned comment refuses before
 * Stryker runs. Residual: a Babel that will not load, a file it or git will
 * not read, or a config that throws, ignores the file or runs past
 * COMMENTS_TIMEOUT_MS leaves that file's comments unread, named on stderr and
 * logged, and Stryker still judges every file (#2727).
 *
 * MISSING TOOLS refuse, never pass (#1911): either Stryker package, or vitest,
 * absent from the checkout's own `node_modules`, the one the run's worktree
 * links. The refusal prints the install line at STRYKER_VERSION. Residual: a
 * Stryker at another version passes the check, and refuses only where it will
 * not run.
 *
 * SKIPPED, silently: during a rebase, a cherry-pick or `git am`, and on a merge
 * commit, as scripts/lib/commit-route.sh reads the route — replayed and merged
 * lines were held when first committed. NOT skipped in the founder's terminal
 * or a linked worktree (#1851).
 *
 * LIMITS
 *  - A mutant spanning lines beyond a range (a whole-block removal around a
 *    changed line) is never generated, so never enforced (#1901).
 *  - Code exercised only out of process, a test spawning it in a child, has
 *    no per-test coverage Stryker can see, and reads NoCoverage.
 *  - The run is invisible to the guard-suite-concurrency core's suite count, as the
 *    pre-lock test run is: a commit launches it, not a Bash command the guard
 *    judges, and Stryker drives vitest through its API, never `.bin/vitest`
 *    (#1912).
 *  - Stryker that will not run — exiting without its initial-run line or a
 *    report — refuses, printing its output.
 *
 * FAILS OPEN on its own faults — git that will not answer, a config that will
 * not read, no throwaway worktree, a report missing, unparseable or holding a
 * status it cannot classify — with one stderr line, logged for
 * check-guard-errors.js, as the review hold does (#1871 §Faults).
 *
 * In no family: a `check-*` exits 2 on its own fault, and this gate passes
 * there, as a pre-commit hold failing open must.
 *
 * EXIT: 0 pass, skip or fail-open · 1 refuse · 2 usage. `--due`: 0 due · 1
 * not, or a fault. `--pre-lock`: 0 green · 1 refuse · 3 left to the hook.
 * `--seed`: 0 seeded · 1 nothing seeded, a fault included.
 */

const { spawnSync } = require("node:child_process");
const {
	execGit,
	gitCommonDirOrThrow,
	GIT_TIMEOUT_MS,
} = require("./lib/git.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { writeFileAtomic } = require("./lib/atomic-write.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { caught } = require("./lib/caught.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { shellWord } = require("./lib/dirty-tree.js");
const { failOpenLogger } = require("./lib/fail-open-logger.js");
const { parseErrorFirstLine, parseFirstLine } = require("./lib/first-line.js");
const { hostRoot } = require("./lib/host-root.js");
const { readFileAt } = require("./lib/git-objects.js");
const { parseHeader } = require("./lib/hunk-header.js");
const { runInTree } = require("./lib/isolated-worktree.js");
const { readRuleTextOr } = require("./lib/rule-text.js");
const { matchSensitivePaths } = require("./lib/sensitive-paths.js");
const { requiredGroup } = require("./lib/regex-group.js");
const { HOST_CONFIG_FAULT, RESULT_FD } = require("./lib/stryker-comments.js");
const { readConfig } = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE =
	"usage: node mutation-hold-gate.js [--due | --pre-lock | --seed]   (from .husky/pre-commit, commit-paths with a flag, or --seed by hand)\n";

/** @typedef {"hook"|"due"|"pre-lock"} Mode */

/** The exit where a mode finds nothing to judge. */
const IDLE = { hook: 0, due: 1, "pre-lock": 3 };

/* What Stryker can instrument, and the test names its default `mutate`
 * leaves out. */
const MUTABLE = /\.(c?js|mjs|[cm]?ts|jsx|tsx|html|vue|svelte)$/;
const TEST_NAME = /(^|\/)__tests__\/|\.([sS]pec|[tT]est)\.[^/]+$/;
/** @param {string} p */
const isMutable = (p) => MUTABLE.test(p) && !TEST_NAME.test(p);

/* Stryker's own line on a red initial run, the one exit 1 it shares with a
 * usage error (#1901). */
const RED_INITIAL = "There were failed tests in the initial test run";

/** @typedef {{start: number, end: number}} LineRange 1-based, inclusive */
/** @typedef {{at: string, text: string}} Disable `path:line` and the comment */
/** @typedef {import("./lib/hunk-header.js").HunkHeader} HunkHeader */
/** @typedef {import("./lib/stryker-comments.js").BabelComment} BabelComment */
/** @typedef {import("./lib/stryker-comments.js").ParseEntry} ParseEntry */
/** @typedef {import("./lib/stryker-comments.js").ParseKind} ParseKind */
/** @typedef {import("./lib/stryker-comments.js").ReadComments} ReadComments */

const REFUSING = new Set(["Survived", "NoCoverage"]);
const PASSING = new Set(["Killed", "Timeout", "Ignored"]);
const LEFT_OUT = new Set(["CompileError", "RuntimeError"]);

/* How much of a red run's or a failed run's output the refusal replays: a
 * guess, enough for vitest's failure summary over Stryker's last log lines. */
const OUTPUT_TAIL_LINES = 40;
/* A mutated span longer than this is cut, so one line per mutant stays one
 * terminal line beside its path and mutator: a guess. */
const ORIGINAL_MAX = 60;
/* The setting #1851 measured, its figures in docs/environment.md §6's
 * mutation-hold paragraph. Untraced: no other setting was measured against it. */
const CONCURRENCY = 2;

const UNPARSEABLE = "could not parse Stryker's JSON report";

/**
 * How a message names its run, so the hook and --seed share one text.
 * @typedef {{prefix: string, tree: string, unjudged: string, refused: string, again: string}} Voice
 */
/** @type {Voice} */
const HOOK_VOICE = {
	prefix: "pre-commit",
	tree: "on HEAD plus this commit's changes",
	unjudged: "no mutant was judged",
	refused: "this commit is refused",
	again: "commit again",
};
/** @type {Voice} */
const SEED_VOICE = {
	prefix: "seed",
	tree: "at HEAD",
	unjudged: "nothing was seeded",
	refused: "nothing was seeded",
	again: "seed again",
};

/* Stryker 10's own discovery order, `{,.}stryker{.conf,.config}.{json,js,mjs,cjs}`
 * (`config-file-formats.js`, #1901). */
const CONFIG_NAMES = ["", "."].flatMap((dot) =>
	[".conf", ".config"].flatMap((kind) =>
		["json", "js", "mjs", "cjs"].map((ext) => `${dot}stryker${kind}.${ext}`),
	),
);
/* The one runner the hold supports (#1871 §Missing tool). */
const TEST_RUNNER = "vitest";
const CORE_DEFAULT = { testRunner: TEST_RUNNER, coverageAnalysis: "perTest" };

/* Stryker 10's own directive parser, matched against a comment's text
 * (instrumenter `directive-bookkeeper.js`): group 4 is the reason. */
const DIRECTIVE =
	/^\s?Stryker (disable|restore)(?: (next-line))? ([a-zA-Z, ]+)(?::(.+)?)?/;
const COMPONENT = /\.(html|vue|svelte)$/;
const SCRIPT = /(<script\b([^>]*)>)([\s\S]*?)<\/script\s*>/gi;
const ATTRIBUTE = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?/g;
/* Stryker 10's script types (`parsers/html-parser.js`). */
const TSX_SCRIPT_TYPES = ["tsx", "text/tsx"];
const TS_SCRIPT_TYPES = ["ts", "text/typescript", "typescript"];
const JS_SCRIPT_TYPES = ["js", "text/javascript", "javascript", "module"];
const DISABLES_UNREAD = "could not read the added disable comments";
const STRYKER_COMMENTS = path.join(__dirname, "lib", "stryker-comments.js");
/* How long the comment read may run: a guess, far past Babel's load and parse
 * of a commit's files, short of a hang anyone waits out. */
const COMMENTS_TIMEOUT_MS = 30_000;

const CACHE_NAME = "wfc-mutation-incremental.json";

/* The version #1901 verified the hold's command-line contract against. */
const STRYKER_VERSION = "10.0.0";
const STRYKER_PACKAGES = [
	"@stryker-mutator/core",
	`@stryker-mutator/${TEST_RUNNER}-runner`,
];

/* The gate's own fault, which fails it open. */
class HoldFaultError extends Error {
	/**
	 * @param {string} fault constant per fault: check-guard-errors.js groups on it
	 * @param {{detail?: string, cause?: unknown}} [opts]
	 */
	constructor(fault, { detail, cause } = {}) {
		super(fault, { cause });
		this.detail = detail;
	}
}

/** @param {string[]} args */
const git = (args) =>
	execGit(["-c", "core.quotePath=false", ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: GIT_TIMEOUT_MS,
	});

/**
 * `read()`, or a HoldFaultError naming `fault` where it throws.
 * @template T
 * @param {string} fault
 * @param {() => T} read
 * @returns {T}
 */
function orFault(fault, read) {
	try {
		return read();
	} catch (e) {
		throw new HoldFaultError(fault, {
			detail: parseErrorFirstLine(e),
			cause: e,
		});
	}
}

/** @param {string[]} args @param {string} fault */
const gitOr = (args, fault) => orFault(fault, () => git(args));

/**
 * Whether the commit route commit-route.sh reads is a replay or a merge, read
 * through the library itself so a new replay route reaches this gate with no
 * edit here.
 * @param {string} gitDir
 */
function isSkippedRoute(gitDir) {
	const r = spawnSync(
		"sh",
		[
			"-c",
			'. "$1" && route="$(wfc_commit_route pre-commit "$2")" || exit 2\nif wfc_commit_route_replays "$route" || [ "$route" = merge ]; then echo skip; else echo hold; fi',
			"sh",
			path.join(__dirname, "lib", "commit-route.sh"),
			gitDir,
		],
		{ encoding: "utf8" },
	);
	const verdict = (r.stdout ?? "").trim();
	if (r.status !== 0 || !["skip", "hold"].includes(verdict))
		throw new HoldFaultError("could not read the commit route", {
			detail: (r.stderr ?? "").trim(),
		});
	return verdict === "skip";
}

/**
 * The text of `file` at `rev`, an empty `rev` the index, or null where its
 * path is absent or its revision an unborn HEAD.
 * @param {string} rev
 * @param {string} file
 * @param {string} fault
 */
const readFileOrFault = (rev, file, fault) =>
	orFault(fault, () => readFileAt(rev, file, { timeout: GIT_TIMEOUT_MS })) ??
	null;

/**
 * `file`'s staged text; a HoldFaultError where the index holds none.
 * @param {string} file
 */
function readStagedFile(file) {
	const fault = "could not read a staged file";
	const text = readFileOrFault("", file, fault);
	if (text === null)
		throw new HoldFaultError(fault, { detail: `${file} is not in the index` });
	return text;
}

/** @typedef {{root: string, text: string|null}} ConfigCopy */

/**
 * The config `.claude/workflow-core.json` holds at `rev` — `HEAD`, or empty
 * for the index — copied into a scratch root. An absent copy reads as the
 * default.
 * @param {string} work
 * @param {string} rev
 * @returns {ConfigCopy}
 */
function configCopyAt(work, rev) {
	const root = path.join(work, `root${rev}`);
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	const text = readFileOrFault(
		rev,
		".claude/workflow-core.json",
		"could not read .claude/workflow-core.json",
	);
	if (text !== null)
		fs.writeFileSync(path.join(root, ".claude", "workflow-core.json"), text);
	return { root, text };
}

/**
 * Whether a copy turns `mutation` on. A copy that will not read turns it on only where its text
 * lists the module, so a commit switching it on in a broken file still fails
 * open loudly (#2077). Residual: WFC_MODULES is not read for a broken copy.
 * @param {ConfigCopy} copy
 */
function isSwitchedOn({ root, text }) {
	try {
		return readConfig({ root, quiet: true }).modules.includes("mutation");
	} catch {
		return /"modules"\s*:\s*\[[^\]]*"mutation"/.test(text ?? "");
	}
}

/** @param {ConfigCopy} copy */
function readConfigOf({ root }) {
	try {
		return readConfig({ root, quiet: true });
	} catch (e) {
		throw new HoldFaultError("could not read .claude/workflow-core.json", {
			detail: caught(e).message,
			cause: e,
		});
	}
}

/**
 * Every hunk of the staged zero-context diff of `file`.
 * @param {string} file
 * @returns {HunkHeader[]}
 */
function readStagedHunks(file) {
	const diff = gitOr(
		[
			"diff",
			"--cached",
			"--no-renames",
			"--no-ext-diff",
			"--no-color",
			"-U0",
			"--",
			file,
		],
		"could not read the staged diff",
	);
	return diff.split("\n").flatMap((l) => {
		const h = parseHeader(l);
		return h === null ? [] : [h];
	});
}

/**
 * The new-side ranges of the hunks adding a line, as Stryker's `mutate`
 * line-range entries.
 * @param {HunkHeader[]} hunks
 * @returns {LineRange[]}
 */
const addedRanges = (hunks) =>
	hunks
		.filter((h) => h.newCount > 0)
		.map((h) => ({ start: h.newStart, end: h.newStart + h.newCount - 1 }));

/**
 * The line HEAD holds where the staged file holds `line`, or null where the
 * commit adds it.
 * @param {HunkHeader[]} hunks the file's, from a zero-context diff
 * @param {number} line
 */
function findHeadLine(hunks, line) {
	let shift = 0;
	for (const h of hunks) {
		const last = h.newStart + h.newCount - 1;
		if (h.newCount > 0 && h.newStart <= line && line <= last) return null;
		// A pure deletion's new start is the line it follows.
		if ((h.newCount > 0 ? last : h.newStart) < line)
			shift += h.oldCount - h.newCount;
	}
	return line + shift;
}

/**
 * Says a fail-open on stderr and writes it to the fail-open log.
 * @param {string} stderrLine after its `pre-commit: ` prefix
 * @param {string} logLine
 */
function reportFailOpen(stderrLine, logLine) {
	writeFd(2, `pre-commit: ${stderrLine}\n`);
	failOpenLogger("mutation-hold-gate.js")?.(logLine);
}

/**
 * Says on stderr and in the fail-open log that the disable comments `where`
 * names went unread, and `why`.
 * @param {string} where
 * @param {string} why
 */
function reportUnread(where, why) {
	const detail = `${where}: ${why}`;
	reportFailOpen(
		`the mutation hold ${DISABLES_UNREAD} in ${detail}, so Stryker alone judges them.`,
		`${DISABLES_UNREAD} — a commit's disable comments went unchecked\t${detail}`,
	);
}

/**
 * How Stryker parses a `<script>` block, from its attributes, or null where it
 * parses none: Svelte's `parsers/svelte-parser.js` reads `lang`
 * alone; `parsers/html-parser.js`'s `getScriptType` skips a `src` script and
 * reads `type`, else `lang`, skipping a type it does not know.
 * @param {string} file
 * @param {string} attributes
 * @returns {ParseKind | null}
 */
function scriptKind(file, attributes) {
	/** @type {Map<string, string>} */
	const attrs = new Map(
		[...attributes.matchAll(ATTRIBUTE)].map((a) => [
			requiredGroup(a, 1, ATTRIBUTE).toLowerCase(),
			// An attribute with no value (`<script setup>`) reads as "", as the DOM reads it.
			a[2] ?? a[3] ?? a[4] ?? "",
		]),
	);
	if (file.endsWith(".svelte")) return attrs.get("lang") === "ts" ? "ts" : "js";
	if (attrs.has("src")) return null;
	const type = (attrs.get("type") ?? attrs.get("lang"))?.toLowerCase();
	if (type === undefined || JS_SCRIPT_TYPES.includes(type)) return "js";
	if (TSX_SCRIPT_TYPES.includes(type)) return "tsx";
	return TS_SCRIPT_TYPES.includes(type) ? "ts" : null;
}

/**
 * How Stryker parses a file that is not a component format.
 * @param {string} file
 * @returns {ParseKind}
 */
function fileKind(file) {
	if (file.endsWith(".tsx")) return "tsx";
	return /\.[cm]?ts$/.test(file) ? "ts" : "js";
}

/**
 * The code Stryker parses in `file`, each piece with how it parses it: the whole
 * file, or each `<script>` block of a component format it parses, padded so
 * its lines keep the file's numbers.
 * Residual: a comment inside a Svelte template expression, which Stryker also
 * mutates, is never read.
 * @param {string} file
 * @param {string} source
 */
function scriptsOf(file, source) {
	if (!COMPONENT.test(file))
		return [
			{
				code: source,
				kind: fileKind(file),
			},
		];
	return [...source.matchAll(SCRIPT)].flatMap((m) => {
		const kind = scriptKind(file, requiredGroup(m, 2, SCRIPT));
		if (kind === null) return [];
		const opened = m.index + requiredGroup(m, 1, SCRIPT).length;
		return [
			{
				code: `${source.slice(0, opened).replace(/[^\n]/g, " ")}${requiredGroup(m, 3, SCRIPT)}`,
				kind,
			},
		];
	});
}

/**
 * Every comment in each entry, or the first line of why none was (#2624).
 * @param {string} root
 * @param {string|null} strykerConfig the host's Stryker config, named under `root`
 * @param {ParseEntry[]} entries
 * @returns {{files: ReadComments} | {error: string}}
 */
function readCommentsInChild(root, strykerConfig, entries) {
	const timeout =
		Number(process.env.WFC_MUTATION_COMMENTS_TIMEOUT_MS) || COMMENTS_TIMEOUT_MS;
	const r = spawnSync(process.execPath, [STRYKER_COMMENTS], {
		input: JSON.stringify({ root, strykerConfig, entries }),
		encoding: "utf8",
		// The result's own fd: a host config may print on stdout (#2727).
		stdio: ["pipe", "ignore", "pipe", "pipe"],
		maxBuffer: CHILD_MAX_BUFFER,
		timeout,
	});
	if (caught(r.error).code === "ETIMEDOUT")
		return { error: `timed out after ${timeout} ms` };
	try {
		return JSON.parse(r.output[RESULT_FD] ?? "");
	} catch {
		return {
			error: r.error
				? parseErrorFirstLine(r.error)
				: parseFirstLine(r.stderr ?? "") || `exit ${r.status}`,
		};
	}
}

/**
 * The line a comment's directive sits on: its first, or the next where its
 * text opens on the line break DIRECTIVE's `^\s?` lets through.
 * @param {BabelComment} c
 */
const findDirectiveLine = (c) =>
	c.loc.start.line + (c.value.startsWith("\n") ? 1 : 0);

/** @typedef {{verb: string, scope: string | undefined, mutators: string[], reason: string | undefined}} ParsedDirective a DIRECTIVE match by part */
/** @typedef {{comment: BabelComment, directive: ParsedDirective}} Directive a comment and its directive */

/**
 * A comment's Stryker directive by part, its mutators lower-cased, or null
 * where its text holds none.
 * @param {string} text the comment's value
 * @returns {ParsedDirective | null}
 */
function parseDirective(text) {
	const d = DIRECTIVE.exec(text);
	if (d === null) return null;
	return {
		verb: requiredGroup(d, 1, DIRECTIVE),
		scope: d[2],
		mutators: requiredGroup(d, 3, DIRECTIVE)
			.split(",")
			.map((m) => m.trim().toLowerCase()),
		reason: d[4],
	};
}

/**
 * The comments holding a `Stryker disable` directive stating no reason after
 * its colon, each with its directive.
 * @param {BabelComment[]} comments
 * @returns {Directive[]}
 */
const unreasonedIn = (comments) =>
	comments.flatMap((comment) => {
		const directive = parseDirective(comment.value);
		return directive?.verb === "disable" &&
			(directive.reason === undefined || directive.reason.trim() === "")
			? [{ comment, directive }]
			: [];
	});

/**
 * Whether the commit adds a line from `from` to `to`, inclusive.
 * @param {LineRange[]} added
 * @param {number} from
 * @param {number} to
 */
const hasAddedBetween = (added, from, to) =>
	added.some((r) => r.start <= to && from <= r.end);

/**
 * Whether Stryker reads a comment's directive: one leading a node no ancestor
 * of which it skips for overlapping no line the commit adds.
 * @param {BabelComment} c
 * @param {LineRange[]} added
 * @returns {c is BabelComment & {leads: number}}
 */
const isRead = (c, added) =>
	c.leads !== undefined &&
	(c.within ?? []).every(([s, e]) => hasAddedBetween(added, s, e));

/**
 * The line a region directive's reach ends before: the line the first later
 * `restore` comment Stryker reads in its block leads that lifts every mutator
 * it names, as Stryker's bookkeeper lifts them, or the line past its block.
 * @param {Directive} disable
 * @param {BabelComment[]} comments the file's, in source order
 * @param {LineRange[]} added
 */
function regionEnd({ comment: c, directive }, comments, added) {
	let open = directive.mutators;
	for (const r of comments) {
		if (r.start <= c.start || r.block !== c.block || !isRead(r, added))
			continue;
		const d = parseDirective(r.value);
		if (d?.verb !== "restore" || d.scope === "next-line") continue;
		const lifted = d.mutators;
		if (!lifted.includes("all") && open.includes("all")) continue;
		open = lifted.includes("all")
			? []
			: open.filter((m) => !lifted.includes(m));
		if (open.length === 0) return r.leads;
	}
	return c.blockEnd + 1;
}

/**
 * Whether a disable directive Stryker reads reaches a line the commit adds: a
 * `next-line` one the line of the node its comment leads, a region from there
 * to its regionEnd.
 * @param {Directive} disable
 * @param {BabelComment[]} comments the file's, in source order
 * @param {LineRange[]} added
 */
function hasAddedInReach(disable, comments, added) {
	if (!isRead(disable.comment, added)) return false;
	const from = disable.comment.leads;
	const until =
		disable.directive.scope === "next-line"
			? from + 1
			: regionEnd(disable, comments, added);
	return hasAddedBetween(added, from, until - 1);
}

/**
 * The unreasoned `Stryker disable` directives in a staged file the commit
 * answers for (#1909): each whose line the commit adds, or maps to a line
 * where HEAD holds no such directive, since editing an enclosing comment's
 * text or delimiters can turn old text into a directive (#2573, #2624); and
 * each whose reach the commit widens over a line it adds, by adding a line
 * under it or deleting its `restore` (#2727). Where HEAD's copy went unread
 * (`held` null), one whose comment's opening line the commit adds stands in
 * for the HEAD comparison.
 * @param {BabelComment[]} comments the staged file's
 * @param {HunkHeader[]} fileHunks
 * @param {Set<number> | null} held HEAD's unreasoned directive lines
 */
function chargedIn(comments, fileHunks, held) {
	const added = addedRanges(fileHunks);
	return unreasonedIn(comments)
		.filter((disable) => {
			const line = findDirectiveLine(disable.comment);
			const was = findHeadLine(fileHunks, line);
			if (was === null) return true;
			const armed =
				held === null
					? hasAddedBetween(added, disable.comment.loc.start.line, line)
					: !held.has(was);
			return armed || hasAddedInReach(disable, comments, added);
		})
		.map((disable) => disable.comment);
}

/**
 * Says on stderr and in the fail-open log that `file`'s copy at HEAD went
 * unread, and `why`.
 * @param {string} file
 * @param {string} why
 */
function reportDegraded(file, why) {
	reportFailOpen(
		`the mutation hold could not read ${file} at HEAD (${why}), so it charges only the directives on lines this commit adds, in comments whose opening line it adds, or whose reach it widens.`,
		`could not read a file at HEAD — an old disable comment the commit arms went unchecked\t${file}: ${why}`,
	);
}

/**
 * The unreasoned `Stryker disable` comments the commit answers for, by
 * chargedIn. Every comment is read through Babel's parser as Stryker reads
 * it, so a `//` inside a string is no comment and a directive on its own line
 * inside a block comment is one (#2366). A git fault reading one file's copy
 * costs that file alone: its staged copy unread, or its HEAD copy read as
 * unparseable (#2727).
 * Residual: any text after the colon passes, `: x` included; one armed in a
 * file the commit adds no line to passes, since that file is not read (and a
 * deletion-only commit runs nothing, #1871 story 30); where HEAD's copy went
 * unread, one armed by any edit but to its comment's opening line passes; a
 * region a later reasoned directive overrides is charged as its own; and the
 * configs are read from the working tree, Stryker's from the staged one, so
 * an unstaged edit to either parts the two reads.
 * @param {string} root
 * @param {string|null} strykerConfig the host's Stryker config the staged tree holds
 * @param {Map<string, HunkHeader[]>} hunks each read file's
 * @returns {Disable[]}
 */
function unreasonedDisables(root, strykerConfig, hunks) {
	/** @type {string[]} */
	const files = [];
	/** @type {Map<string, string>} why a file's HEAD copy went unread */
	const headUnread = new Map();
	/** @type {ParseEntry[]} */
	const entries = [];
	/** @param {unknown} e */
	const buildFaultText = (e) => {
		if (!(e instanceof HoldFaultError)) throw e;
		return `${e.message}: ${e.detail}`;
	};
	for (const file of hunks.keys()) {
		let staged;
		try {
			staged = readStagedFile(file);
		} catch (e) {
			// Fails open for this file alone; Stryker still judges every file (#2727).
			reportUnread(file, buildFaultText(e));
			continue;
		}
		files.push(file);
		entries.push({
			id: `:${file}`,
			filename: file,
			pieces: scriptsOf(file, staged),
		});
		try {
			const head = readFileOrFault(
				"HEAD",
				file,
				"could not read a file at HEAD",
			);
			if (head !== null)
				entries.push({
					id: `HEAD:${file}`,
					filename: file,
					pieces: scriptsOf(file, head),
				});
		} catch (e) {
			// Fails open to the degraded charge, reported per file below (#2727).
			headUnread.set(file, buildFaultText(e));
		}
	}
	if (files.length === 0) return [];
	const read = readCommentsInChild(root, strykerConfig, entries);
	if ("error" in read) {
		// Fails open, logged: the tools the missing-tool check reads are
		// installed, so only a Stryker laid out unlike 10.0.0's, a host config
		// that hangs, or a child that will not run, gets here (#2366, #2727).
		reportUnread(files.join(", "), read.error);
		return [];
	}
	const byId = read.files;
	return files.flatMap((file) => {
		const staged = byId[`:${file}`];
		if (staged === undefined || "error" in staged) {
			// Fails open to Stryker's own parse. On a file Stryker cannot parse
			// either, no mutant is judged green unread (#2366); on one the
			// working-tree configs alone break, Stryker honours what went unread.
			reportUnread(file, staged?.error ?? "no result");
			return [];
		}
		const head = byId[`HEAD:${file}`];
		const headError =
			headUnread.get(file) ??
			(head !== undefined && "error" in head ? head.error : undefined);
		/** @type {Set<number> | null} */
		let held = new Set();
		if (headError !== undefined) {
			reportDegraded(file, headError);
			held = null;
		} else if (head !== undefined && "comments" in head)
			held = new Set(
				unreasonedIn(head.comments).map((d) => findDirectiveLine(d.comment)),
			);
		return chargedIn(staged.comments, hunks.get(file) ?? [], held).map((c) => ({
			at: `${file}:${findDirectiveLine(c)}`,
			text: (c.type === "CommentLine"
				? `//${c.value}`
				: `/*${c.value}*/`
			).replace(/\s+/g, " "),
		}));
	});
}

/**
 * The mutated span's source text. A location outside the source is a report
 * that will not read, so the hold fails open on it (#2078, #1871 §Faults).
 * @param {string[]} lines
 * @param {{start: {line: number, column: number}, end: {line: number, column: number}}} loc 1-based, end exclusive
 * @param {string} at the mutant's `path:line:column`, the fault's detail
 */
function originalOf(lines, loc, at) {
	const first = lines[loc.start.line - 1];
	const last = lines[loc.end.line - 1];
	if (
		first === undefined ||
		last === undefined ||
		loc.start.column - 1 > first.length ||
		loc.end.column - 1 > last.length
	)
		throw new HoldFaultError(UNPARSEABLE, { detail: at });
	const span =
		loc.start.line === loc.end.line
			? first.slice(loc.start.column - 1, loc.end.column - 1)
			: [
					first.slice(loc.start.column - 1),
					...lines.slice(loc.start.line, loc.end.line - 1),
					last.slice(0, loc.end.column - 1),
				].join(" ");
	const flat = span.replace(/\s+/g, " ").trim();
	return flat.length > ORIGINAL_MAX
		? `${flat.slice(0, ORIGINAL_MAX - 1)}…`
		: flat;
}

/** @param {string} output */
const tail = (output) =>
	output.trimEnd().split("\n").slice(-OUTPUT_TAIL_LINES).join("\n");

/**
 * The first of Stryker's own config names `tree` holds at its root, or null:
 * the run's worktree is that tree, so an untracked config is no more seen
 * there than a neighbour's unsaved edit to a tracked one.
 * @param {string} tree
 */
function readHostConfig(tree) {
	const held = new Set(
		gitOr(
			[
				"ls-tree",
				"-z",
				"--name-only",
				"--full-tree",
				tree,
				"--",
				...CONFIG_NAMES,
			],
			"could not list the run's Stryker config",
		).split("\0"),
	);
	return CONFIG_NAMES.find((n) => held.has(n)) ?? null;
}

/**
 * The wrapper Stryker is given: the host's config, or the core default, under
 * the options the hold controls. A host config that will not read stops
 * Stryker with HOST_CONFIG_FAULT in its output (#1871 §Faults).
 * @param {string|null} strykerConfig the host's Stryker config, or null for the core default
 * @param {object} controlled
 */
function buildWrapperConfig(strykerConfig, controlled) {
	const base =
		strykerConfig === null
			? `const base = ${JSON.stringify(CORE_DEFAULT)};`
			: `import { loadStrykerConfig } from ${JSON.stringify(pathToFileURL(STRYKER_COMMENTS).href)};
const base = await loadStrykerConfig(${JSON.stringify(strykerConfig)});`;
	return `${base}
export default { ...base, ...${JSON.stringify(controlled, null, 2)} };
`;
}

/**
 * Seed the run's own copy of the shared incremental file, returning the bytes
 * seeded, or null where there is no cache yet.
 * @param {string} cache
 * @param {string} copy
 * @param {Voice} voice
 */
function seedCache(cache, copy, voice) {
	try {
		const bytes = fs.readFileSync(cache);
		fs.writeFileSync(copy, bytes);
		return bytes;
	} catch (e) {
		// Fails open to a cold run: a cache is speed, never the verdict (#1907).
		if (caught(e).code !== "ENOENT")
			writeFd(
				2,
				`${voice.prefix}: the mutation hold could not read its cache at ${cache} (${caught(e).message}), so Stryker runs cold.\n`,
			);
		return null;
	}
}

/**
 * Write the run's incremental file back over the shared one by rename. A file
 * the run left unchanged, absent or unparseable is not written back.
 * @param {string} copy
 * @param {string} cache
 * @param {Buffer|null} seeded
 * @param {Voice} voice
 */
function writeBackCache(copy, cache, seeded, voice) {
	let bytes;
	try {
		bytes = fs.readFileSync(copy);
	} catch (e) {
		// Fails open, keeping the shared cache: no copy is a run that wrote none,
		// as a red initial run does (#1907).
		if (caught(e).code !== "ENOENT")
			writeFd(
				2,
				`${voice.prefix}: the mutation hold kept its cache at ${cache} unchanged, as this run's would not read (${caught(e).message}).\n`,
			);
		return;
	}
	if (seeded?.equals(bytes)) return;
	try {
		JSON.parse(bytes.toString("utf8"));
		writeFileAtomic(cache, bytes);
	} catch (e) {
		// Fails open, keeping the shared cache whole for the next run (#1907).
		writeFd(
			2,
			`${voice.prefix}: the mutation hold kept its cache at ${cache} unchanged, as this run's would not ${e instanceof SyntaxError ? "parse" : "write"} (${caught(e).message}).\n`,
		);
	}
}

const cachePath = () =>
	path.join(
		orFault("could not read the git common directory", () =>
			gitCommonDirOrThrow(process.cwd(), { timeout: GIT_TIMEOUT_MS }),
		),
		CACHE_NAME,
	);

/**
 * Stryker over `mutate`, in a throwaway worktree holding `tree`.
 * @param {object} run
 * @param {string} run.root the checkout's top
 * @param {string} run.work
 * @param {string[]} run.mutate Stryker `mutate` entries
 * @param {string} run.tree
 * @param {Voice} run.voice
 * @returns {{red: string}|{failed: string}|{report: any}} any: Stryker's JSON, read field by field
 */
function runStryker({ root, work, mutate, tree, voice }) {
	const reportPath = path.join(work, "mutation-report.json");
	const configPath = path.join(work, "stryker.wfc-hold.mjs");
	const incremental = path.join(work, "incremental.json");
	const cache = cachePath();
	const controlled = {
		mutate,
		incremental: true,
		incrementalFile: incremental,
		reporters: ["json"],
		jsonReporter: { fileName: reportPath },
		concurrency: CONCURRENCY,
		thresholds: { high: 0, low: 0, break: null },
	};
	fs.writeFileSync(
		configPath,
		buildWrapperConfig(readHostConfig(tree), controlled),
	);
	const stryker = process.env.WFC_STRYKER || "node_modules/.bin/stryker";
	const seeded = seedCache(cache, incremental, voice);
	const r = runInTree(
		root,
		tree,
		`${shellWord(stryker)} run ${shellWord(configPath)}`,
	);
	// Its results hold whatever the verdict, a refusing one included.
	writeBackCache(incremental, cache, seeded, voice);
	if (r.error !== null)
		throw new HoldFaultError("could not make a throwaway worktree", {
			detail: r.error.trim(),
		});
	const output = `${r.output}${r.spawnError ? `${r.spawnError.message}\n` : ""}`;
	const hostFault = output
		.split("\n")
		// The last: node replays the throwing source line above the message.
		.findLast((l) => l.includes(HOST_CONFIG_FAULT));
	if (r.status !== 0 && hostFault !== undefined)
		throw new HoldFaultError(HOST_CONFIG_FAULT, {
			detail: hostFault.slice(
				hostFault.indexOf(HOST_CONFIG_FAULT) + HOST_CONFIG_FAULT.length + 1,
			),
		});
	if (r.status !== 0)
		return output.includes(RED_INITIAL) ? { red: output } : { failed: output };
	let text;
	try {
		text = fs.readFileSync(reportPath, "utf8");
	} catch (e) {
		throw new HoldFaultError("found no Stryker JSON report", {
			detail: caught(e).message,
			cause: e,
		});
	}
	try {
		return { report: JSON.parse(text) };
	} catch (e) {
		throw new HoldFaultError(UNPARSEABLE, {
			detail: caught(e).message,
			cause: e,
		});
	}
}

/**
 * @param {any} m a report mutant: Stryker's JSON, each field checked here
 * @param {string} at
 * @returns {"pass"|"refuse"|"unjudged"}
 */
function classify(m, at) {
	if (PASSING.has(m.status) || LEFT_OUT.has(m.status)) return "pass";
	if (!REFUSING.has(m.status))
		throw new HoldFaultError("could not classify a mutant's status", {
			detail: `${at} ${String(m.status)}`,
		});
	return m.status === "Survived" && m.static === true && !m.testsCompleted
		? "unjudged"
		: "refuse";
}

/**
 * @param {unknown} c a report column, 1-based
 * @returns {c is number}
 */
const isColumn = (c) => Number.isInteger(c) && /** @type {number} */ (c) >= 1;

/**
 * A column under 1 or none, or an end before its start, slices an empty or
 * wrong span from the source (#2250, #2318).
 * @param {{start: {line: number, column?: unknown}, end: {line: number, column?: unknown}}} loc
 */
const isSpan = ({ start, end }) =>
	isColumn(start.column) &&
	isColumn(end.column) &&
	(end.line > start.line ||
		(end.line === start.line && end.column > start.column));

/**
 * @param {string} file
 * @param {any} entry the report's `files[file]`: Stryker's JSON, each field checked here
 * @param {LineRange[]} rs
 * @returns {{refused: string[], unjudged: string[]}}
 */
function judgeFile(file, entry, rs) {
	const out = {
		refused: /** @type {string[]} */ ([]),
		unjudged: /** @type {string[]} */ ([]),
	};
	const buildUnparseable = () =>
		new HoldFaultError(UNPARSEABLE, { detail: file });
	if (!Array.isArray(entry.mutants)) throw buildUnparseable();
	/** @type {string[]|undefined} */
	let lines;
	const readSourceLines = () => {
		const got =
			lines ??
			(typeof entry.source === "string"
				? entry.source
				: readStagedFile(file)
			).split("\n");
		lines = got;
		return got;
	};
	for (const m of entry.mutants) {
		const loc = m?.location;
		if (
			typeof loc?.start?.line !== "number" ||
			typeof loc?.end?.line !== "number"
		)
			throw buildUnparseable();
		if (!rs.some((r) => loc.start.line >= r.start && loc.end.line <= r.end))
			continue;
		// Only an in-range mutant's columns are read, so only its are judged (#2318).
		if (!isSpan(loc)) throw buildUnparseable();
		const at = `${file}:${loc.start.line}:${loc.start.column}`;
		const verdict = classify(m, at);
		if (verdict === "unjudged") out.unjudged.push(at);
		if (verdict === "refuse")
			out.refused.push(
				`${at}  ${m.mutatorName}  ${originalOf(readSourceLines(), loc, at)} → ${m.replacement ?? "?"}  ${m.status}`,
			);
	}
	return out;
}

/**
 * @param {any} report Stryker's JSON, each field checked where read
 * @param {Map<string, LineRange[]>} ranges
 */
function judge(report, ranges) {
	const out = {
		refused: /** @type {string[]} */ ([]),
		unjudged: /** @type {string[]} */ ([]),
	};
	for (const [file, rs] of ranges) {
		const entry = report?.files?.[file];
		if (entry === undefined) continue;
		const got = judgeFile(file, entry, rs);
		out.refused.push(...got.refused);
		out.unjudged.push(...got.unjudged);
	}
	return out;
}

/**
 * The areas the staged paths touch, under the declaration at HEAD or as
 * staged, and the ranges of the lines they add on paths Stryker can mutate,
 * with each such path's hunks.
 * @param {ConfigCopy[]} copies
 * @param {string[]} staged
 */
function readHeldRanges(copies, staged) {
	const configs = copies.map(readConfigOf);
	/** @type {Set<string>} */
	const areas = new Set();
	/** @type {Set<string>} */
	const matched = new Set();
	for (const c of configs)
		for (const a of matchSensitivePaths(c.sensitivePaths, staged).matched) {
			areas.add(a.name);
			for (const p of a.paths) matched.add(p);
		}
	/** @type {Map<string, LineRange[]>} */
	const ranges = new Map();
	/** @type {Map<string, HunkHeader[]>} */
	const hunks = new Map();
	for (const p of mutableReportingSkips([...matched].sort(), HOOK_VOICE)) {
		const hs = readStagedHunks(p);
		const rs = addedRanges(hs);
		if (rs.length === 0) continue;
		ranges.set(p, rs);
		hunks.set(p, hs);
	}
	return { areas: [...areas].sort(), ranges, hunks };
}

/**
 * The paths Stryker can mutate, saying which it skipped.
 * @param {string[]} paths
 * @param {Voice} voice
 */
function mutableReportingSkips(paths, voice) {
	const skipped = paths.filter((p) => !isMutable(p));
	if (skipped.length > 0)
		writeFd(
			2,
			`${voice.prefix}: the mutation hold judges no test file and no path Stryker cannot mutate, so it skipped: ${skipped.join(", ")}.\n`,
		);
	return paths.filter(isMutable);
}

/**
 * The text for a run that judged no mutant: a red initial run, or a Stryker
 * that did not finish.
 * @param {{red: string}|{failed: string}} run
 * @param {Voice} voice
 */
function buildUnjudgedRunText(run, voice) {
	return "red" in run
		? `${tail(run.red)}\n${voice.prefix}: the mutation hold's initial test run is RED ${voice.tree}, so ${voice.unjudged}.\n  Fix the failing tests and ${voice.again}.\n`
		: `${tail(run.failed)}\n${voice.prefix}: Stryker did not finish, so ${voice.unjudged}.\n  Fix what its output above names — a Stryker that will not start, or a config it refuses — and ${voice.again}.\n`;
}

/**
 * The refusal for the tools the run needs and `root`'s `node_modules` lacks,
 * every one in one refusal, or null. Read off each package.json, so no
 * `exports` map hides an install.
 * @param {string} root
 * @param {Voice} voice
 */
function missingToolRefusal(root, voice) {
	const modules = path.join(root, "node_modules");
	const isMissing = (/** @type {string} */ name) =>
		!fs.existsSync(path.join(modules, name, "package.json"));
	const absent = STRYKER_PACKAGES.filter(isMissing);
	const lines = [];
	if (absent.length > 0)
		lines.push(
			`${voice.prefix}: the mutation hold runs StrykerJS, and ${absent.join(" and ")} ${absent.length > 1 ? "are" : "is"} not installed in ${modules}, so ${voice.refused}.`,
			`  Install both at the version the hold is verified against, and ${voice.again}:`,
			`    npm install --save-dev ${STRYKER_PACKAGES.map((p) => `${p}@${STRYKER_VERSION}`).join(" ")}`,
		);
	if (isMissing(TEST_RUNNER))
		lines.push(
			`${voice.prefix}: the mutation hold supports only the ${TEST_RUNNER} test runner, and ${TEST_RUNNER} is not installed in ${modules}, so ${voice.refused}.`,
			`  Test the declared paths with ${TEST_RUNNER}, or switch "mutation" off in .claude/workflow-core.json.`,
		);
	return lines.length > 0 ? `${lines.join("\n")}\n` : null;
}

/** @param {string} body ending in a newline */
function refuse(body) {
	writeFd(
		2,
		`${body}\n${readRuleOrPointer()}\n\npre-commit: the mutation hold refused this commit (rule:mutation-hold). Nothing was committed.\n`,
	);
	return 1;
}

// Fails open to a pointer: an unreadable rule file must not cost the
// refusal itself, which is printed whole above it (#1906).
function readRuleOrPointer() {
	return readRuleTextOr(
		"mutation-hold",
		"  A commit changing a line on a declared sensitive path is held while a planted bug on that line survives every test",
		"mutation-hold-gate",
	);
}

/** @param {Disable[]} unreasoned */
function unreasonedRefusal(unreasoned) {
	return [
		"pre-commit: this commit adds, arms or widens over its own lines a `Stryker disable` comment stating no reason on a declared sensitive path, so no mutant was judged (#1909, #2727).",
		...unreasoned.map(({ at, text }) => `  ${at}  ${text.trim()}`),
		"  Say after a colon why the mutants it clears cannot change behaviour — `// Stryker disable next-line <mutator>: <reason>` — and commit again.",
		"",
	].join("\n");
}

/**
 * The refusal for a run's outcome, or null where it passes.
 * @param {ReturnType<typeof runStryker>} run
 * @param {string[]} areas
 * @param {Map<string, LineRange[]>} ranges
 */
function refusal(run, areas, ranges) {
	if (!("report" in run)) return buildUnjudgedRunText(run, HOOK_VOICE);
	const { refused, unjudged } = judge(run.report, ranges);
	if (unjudged.length > 0)
		writeFd(
			2,
			`pre-commit: the mutation hold leaves unjudged ${unjudged.length} static mutant(s) no test ran, which Stryker reports Survived without testing (#1901): ${unjudged.join(", ")}.\n`,
		);
	if (refused.length === 0) return null;
	return [
		"pre-commit: this commit changes a line on a declared sensitive path where a planted bug survives every test (#1906).",
		`  Areas touched: ${areas.join(", ")}.`,
		...refused.map((l) => `  ${l}`),
		"  Two ways past, for each: a test that kills it, or a `// Stryker disable next-line <mutator>: <reason>` comment above its line stating why it cannot change behaviour.",
		"",
	].join("\n");
}

/** @param {Mode} mode @returns {number} */
function hold(mode) {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-mutation-hold-"));
	try {
		const copies = [configCopyAt(work, "HEAD"), configCopyAt(work, "")];
		if (!copies.some(isSwitchedOn)) return IDLE[mode];

		const gitDir = gitOr(
			["rev-parse", "--absolute-git-dir"],
			"could not read the git directory",
		).trim();
		if (isSkippedRoute(gitDir)) return IDLE[mode];

		// --no-renames: a rename onto a sensitive path is a change to it too.
		const staged = gitOr(
			["diff", "--cached", "--name-only", "--no-renames", "-z"],
			"could not list the staged paths",
		)
			.split("\0")
			.filter((p) => p !== "");
		if (staged.length === 0) return IDLE[mode];

		const held = readHeldRanges(copies, staged);
		if (held.ranges.size === 0) return IDLE[mode];
		if (mode === "due") return 0;
		const root = hostRoot();
		const missing = missingToolRefusal(root, HOOK_VOICE);
		if (missing !== null) return refuse(missing);
		const tree = gitOr(["write-tree"], "could not read the staged tree").trim();
		const unreasoned = unreasonedDisables(
			root,
			readHostConfig(tree),
			held.hunks,
		);
		if (unreasoned.length > 0) return refuse(unreasonedRefusal(unreasoned));
		writeFd(
			2,
			`pre-commit: the mutation hold is running Stryker over ${[...held.ranges.values()].flat().length} changed range(s) on ${held.areas.join(", ")}.\n`,
		);
		const mutate = [...held.ranges].flatMap(([file, rs]) =>
			rs.map((x) => `${file}:${x.start}-${x.end}`),
		);
		const text = refusal(
			runStryker({ root, work, mutate, tree, voice: HOOK_VOICE }),
			held.areas,
			held.ranges,
		);
		return text === null ? 0 : refuse(text);
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

/** @returns {number} */
function seed() {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-mutation-seed-"));
	try {
		const config = readConfigOf(configCopyAt(work, "HEAD"));
		const tracked = gitOr(
			["ls-tree", "-r", "-z", "--name-only", "--full-tree", "HEAD"],
			"could not list HEAD's files",
		)
			.split("\0")
			.filter((p) => p !== "");
		const matched = [
			...new Set(
				matchSensitivePaths(config.sensitivePaths, tracked).matched.flatMap(
					(a) => a.paths,
				),
			),
		].sort();
		const files = mutableReportingSkips(matched, SEED_VOICE);
		if (files.length === 0) {
			writeFd(
				2,
				`${SEED_VOICE.prefix}: no file HEAD holds on a declared sensitive path is code the hold would mutate, so ${SEED_VOICE.unjudged}.\n`,
			);
			return 1;
		}
		const root = hostRoot();
		const missing = missingToolRefusal(root, SEED_VOICE);
		if (missing !== null) {
			writeFd(2, missing);
			return 1;
		}
		writeFd(
			2,
			`${SEED_VOICE.prefix}: running Stryker over ${files.length} file(s) at HEAD, cold; this takes minutes.\n`,
		);
		const tree = gitOr(
			["rev-parse", "HEAD^{tree}"],
			"could not read HEAD's tree",
		).trim();
		const run = runStryker({
			root,
			work,
			mutate: files,
			tree,
			voice: SEED_VOICE,
		});
		if (!("report" in run)) {
			writeFd(2, buildUnjudgedRunText(run, SEED_VOICE));
			return 1;
		}
		const results = Object.values(run.report?.files ?? {}).reduce(
			(n, f) => n + (Array.isArray(f?.mutants) ? f.mutants.length : 0),
			0,
		);
		writeFd(
			2,
			`${SEED_VOICE.prefix}: cached ${results} mutant result(s) at ${cachePath()}.\n`,
		);
		return 0;
	} catch (e) {
		// Not the hook's fail-open: no commit waits on a seed, so its fault is
		// the run's outcome, printed (#1912).
		writeFd(
			2,
			`${SEED_VOICE.prefix}: ${faultOf(e).what}, so ${SEED_VOICE.unjudged}.\n`,
		);
		return 1;
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

/**
 * `e` as the gate's fault, any other error read as "failed", and the text
 * naming it.
 * @param {unknown} e
 */
function faultOf(e) {
	const fault =
		e instanceof HoldFaultError
			? e
			: new HoldFaultError("failed", {
					detail: parseErrorFirstLine(e),
				});
	return {
		fault,
		what: `the mutation hold ${fault.message}${fault.detail ? ` (${fault.detail})` : ""}`,
	};
}

/**
 * In the hook, every fault of the gate's own fails open, loudly and logged
 * (#1871 §Faults). Before the lock it is left to the hook's run, which fails
 * open on it there, so it is logged once (#1910).
 * @param {Mode} mode
 * @param {unknown} e
 */
function faultExit(mode, e) {
	const { fault, what } = faultOf(e);
	if (mode !== "hook") {
		writeFd(
			2,
			`pre-commit: ${what} before the lock, so the commit's hook judges it in the lock.\n`,
		);
		return IDLE[mode];
	}
	reportFailOpen(
		`${what} — this commit is NOT checked. See: node ${process.env.WFC_PLUGIN_ROOT ? `${process.env.WFC_PLUGIN_ROOT}/` : ""}scripts/check-guard-errors.js`,
		`${fault.message} — a commit went unchecked for a surviving mutant${fault.detail ? `\t${fault.detail}` : ""}`,
	);
	return 0;
}

/** @param {string[]} argv @returns {number} */
function main(argv) {
	const parsed = parseOrCode(argv, {
		usage: USAGE,
		flags: { "--due": "boolean", "--pre-lock": "boolean", "--seed": "boolean" },
	});
	if (typeof parsed === "number") return parsed;
	const modes = ["--due", "--pre-lock", "--seed"].filter(
		(f) => parsed.flags[f],
	);
	if (modes.length > 1) {
		writeFd(2, `${modes.join(" and ")} are one or the other\n\n${USAGE}`);
		return 2;
	}
	if (parsed.flags["--seed"]) return seed();
	/** @type {Mode} */
	let mode = "hook";
	if (parsed.flags["--due"]) mode = "due";
	if (parsed.flags["--pre-lock"]) mode = "pre-lock";
	try {
		return hold(mode);
	} catch (e) {
		return faultExit(mode, e);
	}
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
