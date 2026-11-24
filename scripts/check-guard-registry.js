#!/usr/bin/env node

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { hostRoot, worktreeRoot } = require("./lib/host-root.js");
const { deref } = require("./lib/deref.js");
const { HOOK_EVENTS } = require("./lib/hook-events.js");
const {
	isCoreRoot,
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
const { caught, ignoreFailure, orFallback } = require("./lib/caught.js");
const { readText } = require("./lib/file-read.js");
const { buildArbiterCommand } = require("./lib/build-arbiter-command.js");
const { byCodeUnit } = require("./lib/by-code-unit.js");
const { REFUSES_COMMIT } = require("./lib/refuses-commit.js");
const {
	hasOwnGit,
	isTreeMember,
	isTreeFileOrDir,
	treeOf,
} = require("./lib/tree-members.js");
const { shellQuote } = require("./lib/sh-quote.js");
const {
	judgeCarry,
	readMerge,
	writeCarried,
} = require("./lib/registry-carry.js");
const { readStaleAtHead } = require("./lib/stale-at-head.js");

let root = worktreeRoot();

let rootGiven = false;

const CORE_ROOT = path.join(__dirname, "..");

function rootIsCore() {
	return fs.existsSync(path.join(root, "scripts", "check-guard-registry.js"));
}

function foreignStore() {
	return !fs.existsSync(path.join(root, RULES_DIR));
}

/**
 * @param {string} id
 */
function isForeignRule(id) {
	return foreignStore() || path.dirname(fragmentPath(id)) !== rulesDir();
}

/** @param {string | null} dir */
function setRoot(dir) {
	if (!dir) {
		const refusal = nestedCopyRefusal();
		if (refusal) throw brokenError(refusal);
		if (root !== hostRoot()) pinStore();
		return;
	}
	root = path.resolve(dir);
	rootGiven = true;
	pinStore();
}

/**
 * @param {string} core
 */
function isNestedCopy(core) {
	const rel = relativeUnder(root, core);
	if (!rel) return false;
	let d = core;
	for (const _ of rel.split(path.sep)) {
		if (fs.existsSync(path.join(d, ".git"))) return false;
		d = path.dirname(d);
	}
	return true;
}

function nestedCopyRefusal() {
	const core = deref(CORE_ROOT);
	if (!isNestedCopy(core)) return null;
	return (
		`this checker runs from ${core}, a copy nested in ${root} with no repository of its own, ` +
		`so it would judge ${root}'s tree, not the copy's. Pass --root ${core}, or run it from a ` +
		"clean worktree of HEAD outside this checkout (git worktree add --detach <dir> HEAD)."
	);
}

function pinStore() {
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

const SCAN_ROOTS = ["CLAUDE.md", "AGENTS.md", "docs", ".claude"];

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "__pycache__"]);

/**
 * @typedef {{ line: number, text: string }} Rule
 * @typedef {{ file: string, line: number, gist: string }} RuleRef
 * @typedef {{
 *   kind: string,
 *   file: string,
 *   line: number,
 *   rule: string,
 *   detail: string,
 *   surface?: string,
 * }} Finding
 * @typedef {{
 *   kind: "UNANCHORED" | "STALE-PROSE" | "ORPHAN-ANCHOR" | "GUARD-GONE",
 *   guard: string,
 *   rules: RuleRef[],
 *   detail: string,
 *   refusesCommit?: boolean,
 *   digest?: string,
 *   hashes?: string[],
 * }} StaleWarning
 * @typedef {{
 *   kind: "REPRINTED",
 *   guard: string,
 *   rules: RuleRef[],
 *   detail: string,
 *   spans: { span: string, coverage: number }[],
 * }} ReprintWarning
 * @typedef {StaleWarning | ReprintWarning} Warning
 * @typedef {{ triggers: string[], annotation: Record<string, string> | null }} WiredScript
 * @typedef {{ holder: string, dead: boolean }} HeldEntry
 * @typedef {HeldEntry & { path: string }} HeldInput
 */

/**
 * @template T
 * @param {string} rel
 * @param {() => T} read
 * @returns {T | null}
 */
function readUnlessScratch(rel, read) {
	try {
		return read();
	} catch (e) {
		if (dropIgnored([rel]).length === 0) return null;
		throw e;
	}
}

/**
 * @param {string} rel
 * @param {string[]} out
 */
function walk(rel, out) {
	const abs = path.join(root, rel);
	const st = readUnlessScratch(rel, () =>
		fs.statSync(abs, { throwIfNoEntry: false }),
	);
	if (!st) return;
	if (st.isFile()) {
		if (rel.endsWith(".md")) out.push(rel);
		return;
	}
	if (!st.isDirectory()) return;
	const entries = readUnlessScratch(rel, () =>
		fs.readdirSync(abs, { withFileTypes: true }),
	);
	if (!entries) return;
	for (const entry of entries) {
		if (!entry.isFile() && !entry.isDirectory()) continue;
		if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
		walk(path.join(rel, entry.name), out);
	}
}

let ignoreDropped = 0;
let gitignoreFailure = "";
let ignoreSkipped = false;
let listedByGit = false;

const UNOPENED_DIR_RE = /^warning: could not open directory '([^'\n]+)'/gm;

/**
 * @param {string[]} files
 * @returns {string[]}
 */
function dropIgnored(files) {
	if (files.length === 0) return files;
	if (rootGiven && isMaterialised(root)) {
		ignoreSkipped = true;
		return files;
	}
	const r = spawnGitSync(["-C", root, "check-ignore", "--stdin", "-z"], {
		input: `${files.join("\0")}\0`,
		encoding: "utf8",
	});
	if (r.error || (r.status !== 0 && r.status !== 1)) {
		gitignoreFailure = r.error?.message ?? `git exited ${r.status}`;
		return files;
	}
	const ignored = new Set(r.stdout.split("\0").filter(Boolean));
	ignoreDropped += ignored.size;
	return files.filter((f) => !ignored.has(f));
}

/**
 * @param {string} dir
 */
function isMaterialised(dir) {
	return !hasOwnGit(dir);
}

/**
 * @param {string[]} roots
 */
function findLinkedRoots(roots) {
	return roots.filter((r) =>
		fs
			.lstatSync(path.join(root, r), { throwIfNoEntry: false })
			?.isSymbolicLink(),
	);
}

/** @param {string[]} roots */
function walkDocs(roots) {
	/** @type {string[]} */
	const out = [];
	for (const r of roots) walk(r, out);
	return out;
}

function scannedFiles() {
	const listed = listScope(
		SCAN_ROOTS,
		(rel) => rel.endsWith(".md"),
		SKIP_DIRS,
		walkDocs,
	);
	if (!listed) return dropIgnored(walkDocs(SCAN_ROOTS)).sort();
	listedByGit = true;
	return listed;
}

/**
 * @param {string[]} roots
 * @param {(rel: string) => boolean} accept
 * @param {Set<string>} skip
 * @param {(roots: string[]) => string[]} walkInto
 * @returns {string[] | null}
 */
function listScope(roots, accept, skip, walkInto) {
	const listing = readGitListing();
	if (!listing) return null;
	const linked = findLinkedRoots(roots);
	const isSkipped = (/** @type {string} */ rel) =>
		rel.split("/").some((part) => skip.has(part));
	/** @type {string[]} */
	const files = [];
	/** @type {string[]} */
	const nested = [];
	for (const entry of listing) {
		const rel = entry.replace(/\/$/, "");
		if (!isUnder(rel, roots) || isUnder(rel, linked) || isSkipped(rel))
			continue;
		if (entry.endsWith("/")) nested.push(rel);
		else if (
			accept(rel) &&
			fs.lstatSync(path.join(root, rel), { throwIfNoEntry: false })?.isFile()
		)
			files.push(rel);
	}
	const walked = dropIgnored(walkInto([...linked, ...nested]));
	return [...new Set([...files, ...walked])].sort();
}

/** @type {string[] | null | undefined} */
let gitListing;

/** @returns {string[] | null} */
function readGitListing() {
	if (gitListing === undefined) gitListing = listGit();
	return gitListing;
}

/**
 * @returns {string[] | null}
 */
function listGit() {
	if (rootGiven && isMaterialised(root)) return null;
	const roots = [...new Set([...SCAN_ROOTS, ...EMITTER_ROOTS])];
	const linked = findLinkedRoots(roots);
	const r = spawnGitSync(
		[
			"-C",
			root,
			"ls-files",
			"-z",
			"--cached",
			"--others",
			"--exclude-standard",
			"--",
			...roots.filter((x) => !linked.includes(x)),
		],
		{
			encoding: "utf8",
			maxBuffer: MAX_BUFFER,
			env: { ...process.env, LC_ALL: "C" },
		},
	);
	if (r.error || r.status !== 0) return null;
	for (const m of r.stderr.matchAll(UNOPENED_DIR_RE))
		fs.readdirSync(path.join(root, m[1] ?? ""));
	return r.stdout.split("\0").filter(Boolean);
}

function hooksFile() {
	return ownHooksFile(root, { core: CORE_ROOT });
}

/**
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
	ignoreFailure(() =>
		parts.push(...hookCommands(readRunningHooks(root, { core: CORE_ROOT }))),
	);
	parts.push(...readPackageScriptValues());
	for (const dir of [".husky", ".github/workflows"])
		parts.push(...readDirFiles(dir));
	parts.push(...dispatcherRowScripts(parts.join("\n")));
	return parts.join("\n");
}

const DISPATCHERS = [
	{
		entry: "scripts/precommit-dispatch.js",
		registry: "precommit-gates.js",
		rows: "GATES",
	},
	{
		entry: "scripts/commit-msg-dispatch.js",
		registry: "commit-msg-rows.js",
		rows: "ROWS",
	},
	{
		entry: "scripts/prepare-commit-msg-dispatch.js",
		registry: "prepare-commit-msg-rows.js",
		rows: "ROWS",
	},
	{
		entry: "scripts/post-commit-dispatch.js",
		registry: "post-commit-rows.js",
		rows: "ROWS",
	},
];

/**
 * @param {Record<string, { script: string }[]>} registry
 * @param {string} rows
 * @returns {string[]}
 */
const rowScripts = (registry, rows) =>
	(registry[rows] ?? []).map((r) => r.script);

/**
 * @param {string} corpus
 * @returns {string[]}
 */
function dispatcherRowScripts(corpus) {
	return DISPATCHERS.flatMap(({ entry, registry, rows }) => {
		if (!corpus.includes(entry)) return [];
		try {
			return rowScripts(
				require(
					path.join(
						rootIsCore() ? root : CORE_ROOT,
						"scripts",
						"lib",
						registry,
					),
				),
				rows,
			);
		} catch {
			return [];
		}
	});
}

function readPackageScriptValues() {
	const pkg = orFallback(
		() => JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")),
		null,
	);
	if (pkg?.scripts && typeof pkg.scripts === "object")
		return Object.values(pkg.scripts).filter((v) => typeof v === "string");
	return [];
}

function readDirFiles(/** @type {string} */ dir) {
	const out = /** @type {string[]} */ ([]);
	const abs = path.join(root, dir);
	if (!fs.existsSync(abs)) return out;
	for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		ignoreFailure(() =>
			out.push(
				stripComments(fs.readFileSync(path.join(abs, entry.name), "utf8")),
			),
		);
	}
	return out;
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
		return { findings, narrowed: new Map() };
	}

	const wired = wiredNarrowings(entries);
	const reached = new Map(wired);
	const sourceOf = new Map([...wired.keys()].map((k) => [k, hooksFile()]));
	for (const [rel, clauses] of coreNarrowings(wired)) {
		reached.set(rel, new Set([...(reached.get(rel) ?? []), ...clauses]));
		sourceOf.set(
			rel,
			sourceOf.has(rel) ? `${hooksFile()} and ${MANIFEST_REL}` : MANIFEST_REL,
		);
	}

	findings.push(...rowNarrowingFindings(reached, sourceOf));

	return {
		findings,
		narrowed: new Map(
			[...reached]
				.filter(([, v]) => v.size)
				.map(([k, v]) => [k, [...v].sort()]),
		),
	};
}

/**
 * @param {Map<string, Set<string>>} wired
 * @returns {Map<string, Set<string>>}
 */
function coreNarrowings(wired) {
	/** @type {Map<string, Set<string>>} */
	const cores = new Map();
	if (!wired.has(DISPATCH_ENTRY)) return cores;
	for (const row of readManifestRows(manifestAt(root))) {
		const clauses = row.if ?? [];
		if (!Array.isArray(clauses))
			throw brokenError(
				`${MANIFEST_REL}: row ${row.name}'s \`if\` is not an array of clauses`,
			);
		if (row.denyTiming !== undefined && row.denyTiming !== "delayed")
			throw brokenError(
				`${MANIFEST_REL}: row ${row.name}'s \`denyTiming\` is not "delayed"`,
			);
		const rel = modulePath(row.core);
		cores.set(rel, new Set([...(cores.get(rel) ?? []), ...clauses]));
	}
	return cores;
}

/**
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
 * @param {Map<string, Set<string>>} reached
 * @param {Map<string, string>} sourceOf
 * @returns {Finding[]}
 */
function rowNarrowingFindings(reached, sourceOf) {
	/** @type {Finding[]} */
	const findings = [];
	const { rows, narrowings } = readImplicitManifest();
	for (const [rel, actual] of [...reached].sort())
		if (Object.hasOwn(rows, rel) && fs.existsSync(path.join(root, rel)))
			findings.push(
				...judgeRowNarrowing(rel, actual, narrowings.get(rel) ?? [], {
					source: sourceOf.get(rel) ?? hooksFile(),
				}),
			);

	for (const [rel, declared] of [...narrowings].sort())
		if (declared.length > 0 && !reached.has(rel))
			findings.push({
				kind: "UNWIRED-IF",
				surface: "if-narrowing",
				file: IMPLICIT_MANIFEST,
				line: 1,
				rule: rel,
				detail:
					`its row for ${rel} states a narrowing of ${clauseList(declared)}, and no hook entry in ` +
					`${hooksFile()} names that script at all — so the narrowing binds nothing, and the row's ` +
					"DEFEAT is computed from a wiring that is gone (mantahostels#102). Drop the row's `IF`, or wire the script",
			});
	return findings;
}

/**
 * @param {string} rel
 * @param {Set<string>} actual
 * @param {string[]} declared
 * @param {{ source: string }} wiring
 * @returns {Finding[]}
 */
function judgeRowNarrowing(rel, actual, declared, { source }) {
	/** @type {Finding[]} */
	const findings = [];
	const report = (/** @type {string} */ kind, /** @type {string} */ detail) =>
		findings.push({
			kind,
			surface: "if-narrowing",
			file: IMPLICIT_MANIFEST,
			line: 1,
			rule: `${rel}, wired in ${source}`,
			detail,
		});

	for (const value of [...actual].sort())
		if (!declared.includes(value))
			report(
				"UNDECLARED-IF",
				`${source} narrows ${rel} with \`if: ${value}\`, so it is not run on every matched call — ` +
					"but its row's `IF` never says so, leaving the row's DEFEAT computed against a wiring " +
					"that no longer holds (mantahostels#2126)",
			);

	for (const value of declared)
		if (!actual.has(value))
			report(
				"STALE-IF",
				`its row for ${rel} states a narrowing of \`if: ${value}\`, and no entry in ${source} ` +
					`naming that script carries it${staleIfTail(actual)}`,
			);
	return findings;
}

function staleIfTail(/** @type {Set<string>} */ actual) {
	if (actual.size > 0)
		return ` — the wiring narrows with ${clauseList([...actual])} instead`;
	return ", the wiring carrying no `if` field at all";
}

const clauseList = (/** @type {string[]} */ clauses) =>
	clauses.map((v) => `\`${v}\``).join(", ");

const REFUSING_EVENT = "PreToolUse";
/** @type {readonly string[]} */
const ACTING_EVENTS = HOOK_EVENTS.filter((e) => e !== REFUSING_EVENT);
const HUSKY_DIR = ".husky";
const VITEST_CONFIG = "vitest.config.ts";

const {
	WIRED_SCRIPT_RE,
	buildHookCommandLine,
} = require("./lib/rule-emission");
const {
	DISPATCH_ENTRY,
	MANIFEST_REL,
	manifestAt,
	readManifestRows,
	modulePath,
} = require("./lib/guard-cores.js");
const { walkReach } = require("./lib/guard-reach.js");
const {
	DEP_KINDS,
	digestOf,
	isDep,
	readOptsIn,
} = require("./lib/guard-digest.js");
const { isHookShim, shimAnnotation } = require("./lib/hook-shim.js");
const { coreDenyTexts, decideModule } = require("./lib/core-deny-text.js");
const { isUnder, relativeUnder } = require("./lib/is-under.js");

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

const VITEST_KEY_RE = /\b(?:globalSetup|reporters)\s*:\s*\[([^\]]*)\]/g;
const VITEST_ENTRY_RE = /["']\.\/((?:scripts|\.claude)\/[\w./-]+)["']/g;

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
 * @returns {Record<string, unknown> | null}
 */
function readImplicitHooks() {
	try {
		return readOwnHooks(root, { core: CORE_ROOT });
	} catch (e) {
		throw brokenError(caught(e).message);
	}
}

/**
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

const ANNOTATION_KEYS = ["IMPLICIT", "JUSTIFIED", "DEFEAT"];
const JUSTIFICATIONS = ["fail-safe", "convenience"];
const TREE_KEY = "TREE";
const IF_KEY = "IF";
const TREES = ["session", "host", "both", "none"];
const TREE_EXEMPT = "scripts/guard-dispatch.js";

const JUSTIFIED_RE = new RegExp(
	`^(?:${JUSTIFICATIONS.join("|")})\\s*[—:-]\\s*\\S`,
);
const TREE_RE = new RegExp(`^(?:${TREES.join("|")})\\s*[—:-]\\s*\\S`);

/**
 * @typedef {{ rows: Record<string, Record<string, string>>,
 *   narrowings: Map<string, string[]> }} ImplicitManifest
 */

/** @type {ImplicitManifest | undefined} */
let implicitManifest;

/**
 * @returns {Record<string, Record<string, string>>}
 */
function readImplicitRows() {
	return readImplicitManifest().rows;
}

/**
 * @returns {ImplicitManifest}
 */
function readImplicitManifest() {
	if (implicitManifest) return implicitManifest;
	const read = readText(path.join(root, IMPLICIT_MANIFEST));
	if (read.state === "unreadable")
		throw brokenError(`cannot read ${IMPLICIT_MANIFEST}: ${read.message}`);
	/** @type {unknown} */
	let parsed = {};
	if (read.state !== "absent")
		try {
			parsed = JSON.parse(read.data);
		} catch (e) {
			throw brokenError(
				`${IMPLICIT_MANIFEST} is not JSON: ${caught(e).message}`,
			);
		}
	if (!isRowTable(parsed))
		throw brokenError(
			`${IMPLICIT_MANIFEST} is not a JSON object of rows, each an object of strings keyed ${[...ANNOTATION_KEYS, TREE_KEY].join(" / ")}, and an \`${IF_KEY}\` array of strings`,
		);
	/** @type {ImplicitManifest} */
	const manifest = { rows: {}, narrowings: new Map() };
	for (const [rel, { [IF_KEY]: clauses, ...row }] of Object.entries(parsed)) {
		manifest.rows[rel] = /** @type {Record<string, string>} */ (row);
		if (clauses) manifest.narrowings.set(rel, clauses);
	}
	implicitManifest = manifest;
	return manifest;
}

/**
 * @typedef {Record<string, string | string[]> & { IF?: string[] }} ImplicitRow
 */

/**
 * @param {unknown} v
 * @returns {v is Record<string, ImplicitRow>}
 */
function isRowTable(v) {
	const isPlain = (/** @type {unknown} */ o) =>
		typeof o === "object" && o !== null && !Array.isArray(o);
	const isField = (/** @type {string} */ k, /** @type {unknown} */ f) =>
		k === IF_KEY
			? Array.isArray(f) && f.every((c) => typeof c === "string")
			: typeof f === "string";
	return (
		isPlain(v) &&
		Object.values(/** @type {object} */ (v)).every(
			(row) =>
				isPlain(row) && Object.entries(row).every(([k, f]) => isField(k, f)),
		)
	);
}

/**
 * @param {string} rel
 * @returns {Record<string, string> | null}
 */
function readAnnotation(rel) {
	const row = readImplicitRows()[rel];
	if (row) return Object.keys(row).length > 0 ? row : null;
	if (!rel.startsWith(`${HUSKY_DIR}/`)) return null;
	let text;
	try {
		text = fs.readFileSync(path.join(root, rel), "utf8");
	} catch (e) {
		throw brokenError(`cannot read ${rel}: ${caught(e).message}`);
	}
	return isHookShim(text) ? shimAnnotation(path.basename(rel)) : null;
}

/** @param {Record<string, string> | null} ann */
function justificationTag(ann) {
	if (!ann) return "unannotated";
	return (
		JUSTIFICATIONS.find((j) => (ann.JUSTIFIED ?? "").startsWith(j)) ??
		"malformed"
	);
}

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
	else
		lines.push(
			`    (no IMPLICIT / JUSTIFIED / DEFEAT row in ${IMPLICIT_MANIFEST})`,
		);
	return lines;
}

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
 * @param {string} trigger
 */
function isHookTrigger(trigger) {
	return HOOK_EVENTS.some((e) => trigger === e || trigger.startsWith(`${e} `));
}

/**
 * @param {{atCore: boolean, rel: string, triggers: string[],
 *   ann: Record<string, string>}} script
 * @param {(kind: string, detail: string) => void} report
 */
function reportTree({ atCore, rel, triggers, ann }, report) {
	if (!atCore || rel === TREE_EXEMPT || !triggers.some(isHookTrigger)) return;
	const tree = ann[TREE_KEY];
	if (tree === undefined)
		report(
			"NO-TREE",
			`wired at ${triggers.join(", ")}, and its row in ${IMPLICIT_MANIFEST} has no \`TREE\` saying whether it reads the session's worktree, the main checkout's shared stores, both or neither`,
		);
	else if (!TREE_RE.test(tree))
		report(
			"BAD-TREE",
			`\`TREE\` is "${tree}" — it must open with one of ${TREES.join(" | ")} and then give the reason, as "session — <why>"`,
		);
}

/**
 * @param {Map<string, WiredScript>} scripts
 * @returns {Finding[]}
 */
function unwiredRowFindings(scripts) {
	return Object.keys(readImplicitRows())
		.filter((rel) => !scripts.has(rel))
		.sort()
		.map((rel) => ({
			kind: "UNWIRED-ROW",
			surface: "implicit",
			file: IMPLICIT_MANIFEST,
			line: 1,
			rule: rel,
			detail: fs.existsSync(path.join(root, rel))
				? `holds a row for ${rel}, which no hook, husky file or vitest entry runs — delete the row, or wire the script`
				: `holds a row for ${rel}, which is not on disk — delete the row, or restore the script`,
		}));
}

function scanImplicit() {
	/** @type {Finding[]} */
	const findings = [];
	/** @type {Map<string, WiredScript>} */
	const scripts = new Map();
	const atCore = isCoreRoot(root, { core: CORE_ROOT });

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
				`${where}, so it acts on a session that never asked — but ${IMPLICIT_MANIFEST} holds no row for it ` +
					"whose `IMPLICIT` / `JUSTIFIED` / `DEFEAT` say what it does, why, or what escape exists",
			);
			continue;
		}

		for (const key of ANNOTATION_KEYS) {
			if (!(key in ann)) {
				report(
					"INCOMPLETE-ANNOTATION",
					`${where}, and its row in ${IMPLICIT_MANIFEST} has no \`${key}\``,
				);
				continue;
			}
			if (ann[key] === "")
				report("EMPTY-ANNOTATION", `${where}, and its \`${key}\` says nothing`);
		}

		if (
			typeof ann.JUSTIFIED === "string" &&
			ann.JUSTIFIED !== "" &&
			!JUSTIFIED_RE.test(ann.JUSTIFIED)
		)
			report(
				"BAD-JUSTIFICATION",
				`\`JUSTIFIED\` is "${ann.JUSTIFIED}" — it must open with one of ${JUSTIFICATIONS.join(
					" | ",
				)} and then give the reason, as "fail-safe — <why>"`,
			);

		reportTree({ atCore, rel, triggers, ann }, report);
	}

	findings.push(...unwiredRowFindings(scripts));
	return { findings, scripts };
}

const MARKERS = ["Enforced", "Advisory", "Unenforced", "Unenforceable"];

const MARKER_RE = new RegExp(
	`\\*\\*(${[...MARKERS].sort((a, b) => b.length - a.length).join("|")})\\*\\*`,
	"g",
);

const MARKER_LIST = MARKERS.map((m) => `**${m}**`).join(" / ");

const GUARD_PATH_RE = /`((?:scripts|\.husky|\.claude|\.github)\/[\w./-]+)`/g;

const ISSUE_RE = /#\d+/;

const TOP_BULLET = /^[-*]\s+\S/;
const INDENTED = /^\s+\S/;

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
		if (inFence) continue;
		const kind = lineKind(line, current !== null);
		if (kind === "rule") {
			current = { line: at, text: line };
			rules.push(current);
		} else if (kind === "continuation" && current) {
			current.text += `\n${line}`;
		} else if (kind !== "blank") {
			if (kind === "prose") unruled.push({ line: at, text: line.trim() });
			current = null;
		}
	}
	return { rules, unruled };
}

/**
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

const {
	ANCHORS,
	IMPLICIT_MANIFEST,
	buildAnchorsText,
	parseRows,
} = require("./lib/registry-anchors-file.js");

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

/** @param {string} text */
function gist(text) {
	const [line] = text.split("\n");
	if (line === undefined) throw new Error("rule text split into no lines");
	const first = line.replace(/^[-*]\s+/, "");
	return first.length > 100 ? `${first.slice(0, 97)}…` : first;
}

function loadAnchors() {
	const read = readText(path.join(root, ANCHORS));
	if (read.state === "absent") return {};
	if (read.state === "unreadable")
		throw brokenError(`cannot read ${ANCHORS}: ${read.message}`);
	const rows = parseRows(read.data);
	if (rows) return rows;
	throw brokenError(
		`${ANCHORS} is not a JSON object of digests; restore it from git, or delete it and re-anchor every guard with a bare  ${reviewCommand()}.`,
	);
}

/** @param {Record<string, string>} anchors */
function saveAnchors(anchors) {
	fs.mkdirSync(path.dirname(path.join(root, ANCHORS)), { recursive: true });
	fs.writeFileSync(path.join(root, ANCHORS), buildAnchorsText(anchors));
}

/**
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

function scanRegistry() {
	const files = scannedFiles();
	/** @type {RegistryScan} */
	const st = {
		findings: [],
		describedBy: new Map(),
		enforcedRules: [],
		triggerRefs: [],
		wiring: readWiringCorpus(),
		regionCount: 0,
		ruleCount: 0,
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
 * @param {RegistryScan} st
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
 * @param {RegistryScan} st
 * @param {string} file
 * @param {string} text
 */
function collectTriggers(st, file, text) {
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
 * @param {RegistryScan} st
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
 * @param {RegistryScan} st
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
	if (tally === undefined)
		throw new Error(`marker ${marker} has no tally in byMarker`);
	st.byMarker[marker] = tally + 1;

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
 * @param {RegistryScan} st
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
 * @param {RegistryScan} st
 * @param {string} file
 * @param {Rule} rule
 * @param {string[]} guards
 */
function checkNamedPaths(st, file, rule, guards) {
	for (const g of guards) {
		const onDisk = (/** @type {string} */ base) =>
			fs.existsSync(path.join(base, g));
		const inTreeAndOnDisk = (/** @type {string} */ base) =>
			isTreeFileOrDir(base, g) && onDisk(base);
		if (
			!inTreeAndOnDisk(root) &&
			(rootIsCore() || !inTreeAndOnDisk(CORE_ROOT))
		) {
			const untracked = !isTreeFileOrDir(root, g) && onDisk(root);
			reportRule(
				st,
				"BROKEN-CLAIM",
				{ file, rule },
				untracked
					? `names \`${g}\`, which is on disk but not in git's index — \`git add ${shellQuote(g)}\``
					: `names \`${g}\`, which does not exist`,
			);
			continue;
		}
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

/** @param {RegistryScan} st */
function noRegionFindings(st) {
	const requiredRegionFiles = ["CLAUDE.md", "docs/agents/guard-registry.md"];

	for (const required of requiredRegionFiles) {
		if (st.regionsByFile.get(required)) continue;
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

/**
 * @param {Map<string, RuleRef[]>} describedBy
 * @param {Map<string, WiredScript>} implicitScripts
 * @param {Record<string, string>} anchors
 * @param {Set<string>} [fresh]
 * @returns {Warning[]}
 */
function stalenessWarnings(describedBy, implicitScripts, anchors, fresh) {
	/** @type {Warning[]} */
	const warnings = [];
	const targets = [
		...new Set([...describedBy.keys(), ...implicitScripts.keys()]),
	].sort();

	for (const g of targets) {
		const warning = targetWarning(g, describedBy, implicitScripts, {
			anchors,
			fresh,
		});
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
 * @param {Map<string, RuleRef[]>} describedBy
 * @param {Map<string, WiredScript>} implicitScripts
 * @param {Record<string, string>} anchors
 * @returns {string[]}
 */
function staleGuards(describedBy, implicitScripts, anchors) {
	const stale = stalenessWarnings(describedBy, implicitScripts, anchors)
		.filter((w) => STALE_KINDS.has(w.kind))
		.map((w) => w.guard);
	if (stale.length > 0) return [...new Set(stale)];
	printLine(`No stale row: ${ANCHORS} left untouched.`);
	process.exit(0);
}

/** @param {string} g */
function whyNoDigest(g) {
	return !isTreeMember(root, g) && fs.existsSync(path.join(root, g))
		? `on disk but not in git's index — \`git add ${shellQuote(g)}\``
		: "file does not exist";
}

/**
 * @param {string} g
 * @param {Map<string, RuleRef[]>} describedBy
 * @param {Map<string, WiredScript>} implicitScripts
 * @param {{ anchors: Record<string, string>, fresh?: Set<string> }} held
 * @returns {Warning | null}
 */
function targetWarning(g, describedBy, implicitScripts, { anchors, fresh }) {
	const { digest: current, hashed } = digestOf(root, g);
	if (current === null) return null;
	const hashes = [...hashed].sort();
	const rules = describedBy.get(g) ?? [];
	const recorded = anchors[g];
	/** @type {string[]} */
	const claims = [];
	if (rules.length > 0)
		claims.push(
			`the rule(s) at ${rules.map((r) => `${r.file}:${r.line}`).join(", ")}`,
		);
	if (implicitScripts.has(g))
		claims.push(
			`its IMPLICIT / JUSTIFIED / DEFEAT row in ${IMPLICIT_MANIFEST}`,
		);
	const what = claims.join(" and ");
	if (!recorded)
		return {
			kind: "UNANCHORED",
			guard: g,
			rules,
			detail: `no entry in ${ANCHORS}, so nothing records that ${what} was ever read against it`,
			digest: current,
			hashes,
		};
	if (recorded !== current)
		return {
			kind: "STALE-PROSE",
			guard: g,
			rules,
			detail:
				`the guard or a library its digest hashes changed since the last review (anchored ${recorded}, now ${current}) — ` +
				`re-read ${what} against it`,
			digest: current,
			hashes,
		};
	fresh?.add(g);
	return null;
}

// measured with REPRINT_COVERAGE: 2 of 8 known reprints, lucmoseley/mantahostels#1032
const REPRINT_SHINGLE = 5;
// measured with REPRINT_COVERAGE: 2 of 8 known reprints, lucmoseley/mantahostels#1032
const REPRINT_MIN_WORDS = 12;
// measured: 2 of 8 known reprints, no false positive, lucmoseley/mantahostels#1032
const REPRINT_COVERAGE = 0.6;

const HEREDOC_READ_RE =
	/\bread\b[^\n]*?\s([A-Za-z_]\w*)\s*<<-?\s*(['"]?)([A-Za-z_]\w*)\2(?:\s|$)/;
const HEREDOC_CAT_RE =
	/^\s*([A-Za-z_]\w*)=\$\(\s*cat\s*<<-?\s*(['"]?)([A-Za-z_]\w*)\2(?:\s|$)/;
const APPEND_VAR_RE = /^\s*([A-Za-z_]\w*)\+="\$\{?([A-Za-z_]\w*)\}?"\s*$/;
const DENY_VAR_RE = /gp_deny\s+"\$\{?([A-Za-z_]\w*)\}?"/;
const DENY_LITERAL_RE = /gp_deny\s+"([^"$]{20,})"/;

/** @param {string} source */
function denyTextsOf(source) {
	const lines = source.split("\n")[Symbol.iterator]();
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

/** @param {string} text */
function normaliseProse(text) {
	return linkLabels(text.replace(/`[^`]*`/g, " "))
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/**
 * @param {string} text
 */
function linkLabels(text) {
	let out = "";
	let from = 0;
	let open = text.indexOf("[");
	while (open >= 0) {
		const close = text.indexOf("]", open + 1);
		if (close < 0) break;
		if (text[close + 1] !== "(") {
			open = text.indexOf("[", close + 1);
			continue;
		}
		const end = text.indexOf(")", close + 2);
		if (end < 0) break;
		out += text.slice(from, open) + text.slice(open + 1, close);
		from = end + 1;
		open = text.indexOf("[", from);
	}
	return out + text.slice(from);
}

/** @param {string} text */
function sentencesOf(text) {
	return text
		.split("\n")
		.map((l) => l.replace(/^\s*[-*]\s+/, ""))
		.join("\n")
		.split(/(?<=[.!?][`*_)\]"']{0,4})\s+|\n+/);
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
 * @typedef {{ texts: string[], core: string | null }} DenyFile
 */

/**
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
		texts: node ? coreDenyTexts(source) : denyTextsOf(source),
		core: node ? decideModule(source) : null,
	};
}

/**
 * @param {string} rel
 * @param {string} ruleText
 * @param {(rel: string) => DenyFile | null} read
 * @returns {DenyFile[][] | null}
 */
function denyGroupsOf(rel, ruleText, read) {
	if (rel === DISPATCH_ENTRY) {
		const rows = readManifestRows(manifestAt(root));
		const named = rows.filter((r) => ruleText.includes(`\`${r.name}\``));
		return (named.length > 0 ? named : rows)
			.filter((r) => r.denyTiming !== "delayed")
			.map((r) => {
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
 * @param {string} rel
 * @param {string} ruleText
 * @param {(rel: string) => DenyFile | null} read
 * @returns {Set<string> | null}
 */
function denyShinglesOf(rel, ruleText, read) {
	const groups = denyGroupsOf(rel, ruleText, read);
	if (groups === null) return null;
	const texts = groups.flatMap((g) => g.flatMap((f) => f.texts));
	return shinglesOf(
		normaliseProse(texts.join("\n")).split(" ").filter(Boolean),
		REPRINT_SHINGLE,
	);
}

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

const {
	readRuleIds: storedRuleIds,
	readRuleText: ruleTextOf,
	manifestPath,
	rulesDir,
	fragmentPath,
	RULES_DIR,
} = require("./lib/rule-text");

const INDEX_SOURCES = [
	{
		wired: "scripts/inject-tracker-docs.js",
		text: "scripts/lib/tracker-inject-text.js",
	},
];

const TRIGGER_RE = /`rule:([a-z0-9-]+)`/g;

const SOURCE_CITATION_RE = /\\?`rule:([a-z0-9-]+)\\?`/g;
const CITED_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** @param {string} id */
const isCitedId = (id) => id.length > 1 && CITED_ID_RE.test(id);

const {
	directAccessorCalls,
	emissionMatches,
	RULE_ARG_RE,
} = require("./lib/rule-emission-calls.js");
const { readCommit } = require("./lib/commit-sha.js");
const { gitReader, SHORT_SHA, spawnGitSync } = require("./lib/git.js");
const { isInsideAnyRepo } = require("./lib/git-tree.js");
const { readMergeHeadLines } = require("./lib/merge-heads.js");
const { scriptPath } = require("./lib/script-path.js");

const EMITTER_ROOTS = ["scripts", ".claude"];
const EMITTER_EXTS = [".js", ".cjs", ".mjs", ".sh"];

const EMITTER_SKIP = new Set([...SKIP_DIRS, "worktrees"]);

const NOT_EMITTERS = new Set([
	path.join("scripts", "lib", "rule-text.js"),
	path.join("scripts", "lib", "rule-text.sh"),
]);

/**
 * @param {string} base
 * @param {string} rel
 * @param {string[]} out
 */
function walkEmitterDir(base, rel, out) {
	const abs = path.join(base, rel);
	let entries;
	try {
		entries = fs.readdirSync(abs, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const file = path.join(rel, e.name);
		if (e.isFile()) {
			if (isEmitterFile(e.name, file)) out.push(file);
		} else if (e.isDirectory() && !EMITTER_SKIP.has(e.name))
			walkEmitterDir(base, file, out);
	}
}

function isEmitterFile(/** @type {string} */ name, /** @type {string} */ file) {
	return EMITTER_EXTS.some((x) => name.endsWith(x)) && !NOT_EMITTERS.has(file);
}

/**
 * @param {string} [base]
 * @param {string[]} [roots]
 * @returns {string[]}
 */
function emitterFiles(base = root, roots = EMITTER_ROOTS) {
	if (base !== root) return walkEmitters(base, roots);
	rootEmitters ??= readRootEmitters();
	return rootEmitters.filter((rel) => isUnder(rel, roots));
}

/** @type {string[] | undefined} */
let rootEmitters;

/**
 * @param {string} base
 * @param {string[]} roots
 */
function walkEmitters(base, roots) {
	/** @type {string[]} */
	const out = [];
	for (const r of roots) walkEmitterDir(base, r, out);
	return out.sort();
}

function readRootEmitters() {
	const walkInto = (/** @type {string[]} */ roots) => walkEmitters(root, roots);
	return (
		listScope(
			EMITTER_ROOTS,
			(rel) => isEmitterFile(path.basename(rel), rel),
			EMITTER_SKIP,
			walkInto,
		) ?? dropIgnored(walkInto(EMITTER_ROOTS))
	);
}

/**
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
 * @param {string} wiring
 * @returns {Set<string>}
 */
function readIndexedRuleIds(wiring) {
	/** @type {Set<string>} */
	const ids = new Set();
	for (const { wired, text: rel } of INDEX_SOURCES) {
		if (!wiring.includes(wired)) continue;
		const text = readIndexSource(rel);
		if (text === null) continue;
		for (const m of text.matchAll(TRIGGER_RE)) if (m[1]) ids.add(m[1]);
	}
	return ids;
}

/**
 * @param {string} rel
 * @returns {string | null}
 */
function readIndexSource(rel) {
	const base =
		rootIsCore() || fs.existsSync(path.join(root, rel)) ? root : CORE_ROOT;
	try {
		return fs.readFileSync(path.join(base, rel), "utf8");
	} catch (e) {
		if (caught(e).code !== "ENOENT") throw e;
		return null;
	}
}

/**
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
 * @param {Map<string, string>} texts
 * @param {string} wiring
 * @param {string} [base]
 * @returns {Set<string>}
 */
function liveFiles(texts, wiring, base = root) {
	const wired = [...texts.keys()].filter((rel) => wiring.includes(rel));
	const reached = walkReach(
		wired,
		(paths) => paths.map((p) => texts.get(p) ?? null),
		{ follow: DEP_KINDS, keep: isDep, read: readOptsIn(base) },
	);
	return new Set(reached.keys());
}

/**
 * @param {string} wiring
 * @returns {Map<string, string[]>}
 */
function corePrintedBy(wiring) {
	/** @type {Map<string, string[]>} */
	const printed = new Map();
	if (rootIsCore() || foreignStore()) return printed;
	/** @type {Map<string, string>} */
	const texts = new Map();
	/** @type {Map<string, { id: string }[]>} */
	const callsBy = new Map();
	for (const rel of emitterFiles(CORE_ROOT, ["scripts"])) {
		const text = fs.readFileSync(path.join(CORE_ROOT, rel), "utf8");
		texts.set(rel, text);
		callsBy.set(rel, accessorCalls(text));
	}
	const live = liveFiles(texts, wiring, CORE_ROOT);
	for (const [rel, calls] of callsBy)
		if (live.has(rel))
			for (const { id } of calls)
				printed.set(id, [...(printed.get(id) ?? []), rel]);
	return printed;
}

/**
 * @param {(RuleRef & { id: string })[]} triggerRefs
 * @param {string} wiring
 * @returns {{ findings: Finding[], fragments: string[], printedBy: Map<string, string[]> }}
 */
function scanRuleStore(triggerRefs, wiring) {
	const fragments = storedRuleIds();
	const manifest = loadManifest();
	const indexed = readIndexedRuleIds(wiring);
	const { callsBy, texts, citationsBy } = readEmitters();

	const live = liveFiles(texts, wiring);

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
 * @returns {{
 *   callsBy: Map<string, { id: string, line: number }[]>,
 *   texts: Map<string, string>,
 *   citationsBy: Map<string, { id: string, line: number }[]>,
 * }}
 */
function readEmitters() {
	/** @type {Map<string, { id: string, line: number }[]>} */
	const callsBy = new Map();
	/** @type {Map<string, string>} */
	const texts = new Map();
	/** @type {Map<string, { id: string, line: number }[]>} */
	const citationsBy = new Map();

	for (const rel of emitterFiles()) {
		const text = fs.readFileSync(path.join(root, rel), "utf8");
		texts.set(rel, text);
		const cited = citationsIn(text);
		if (cited.length > 0) citationsBy.set(rel, cited);
		const calls = accessorCalls(text);
		if (calls.length > 0) callsBy.set(rel, calls);
	}
	return { callsBy, texts, citationsBy };
}

/**
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
 * @param {Map<string, { id: string, line: number }[]>} callsBy
 * @param {Set<string>} live
 * @param {string[]} fragments
 * @returns {{ printedBy: Map<string, string[]>, findings: Finding[] }}
 */
function emittedCalls(callsBy, live, fragments) {
	/** @type {Finding[]} */
	const findings = [];
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
 * @param {string[]} fragments
 * @param {Map<string, string[]>} printedBy
 * @param {ReturnType<typeof loadManifest>} manifest
 * @returns {Finding[]}
 */
function fragmentFindings(fragments, printedBy, manifest) {
	/** @type {Finding[]} */
	const findings = [];
	for (const id of fragments) {
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

function unprintedRemedy(/** @type {string} */ id) {
	if (rootIsCore())
		return (
			"Call it from the guard that refuses the mistake — `rule_text " +
			`${id}\` from bash, \`readRuleText("${id}")\` from Node — or delete the fragment.`
		);
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
					`Re-render with \`node ${scriptPath("generate-rule-fragments.js")}\`.`,
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
		if (!printedBy.has(id) && !indexed.has(id) && !foreignStore())
			findings.push({
				...at,
				kind: "UNINDEXED-RULE",
				detail:
					`rule id "${id}" is printed by no wired emitter and named in no ` +
					`command's index (${INDEX_SOURCES.map((s) => s.text).join(", ")}), so it reaches no ` +
					"session by either route. Render it into the index of every command " +
					"that can trigger it, or wire an emitter.",
			});
	}
	return findings;
}

/**
 * @param {string} line
 */
const printLine = (line) => writeFd(1, `${line}\n`);

/**
 * @param {string[]} targets
 * @param {Map<string, string>} ours
 * @returns {HeldRead & { unavailable: string | null }}
 */
function readHeldElsewhere(targets, ours) {
	/** @type {HeldRead} */
	const found = {
		held: new Map(),
		taken: new Map(),
		mine: null,
		othersLive: null,
		heldRead: false,
	};
	try {
		const { readTreeSnapshot } = require("./lib/tree-drift.js");
		const snap = readTreeSnapshot(root);
		const unavailable = sortClaims(found, snap, new Set(targets), ours);
		return {
			...found,
			unavailable:
				unavailable ?? (snap ? null : "git would not read this tree"),
		};
	} catch (e) {
		return {
			...found,
			unavailable: `the claim read failed: ${caught(e).message}`,
		};
	}
}

/**
 * @typedef {{
 *   held: Map<string, HeldEntry>,
 *   taken: Map<string, HeldEntry>,
 *   mine: Set<string> | null,
 *   othersLive: boolean | null,
 *   heldRead: boolean,
 * }} HeldRead
 */

/**
 * @param {HeldRead} found
 * @param {import("./lib/tree-drift.js").Snapshot | null} snap
 * @param {Set<string>} wanted
 * @param {Map<string, string>} ours
 * @returns {string | null}
 */
function sortClaims(found, snap, wanted, ours) {
	const self = process.env.CLAUDE_CODE_SESSION_ID || "";
	const injected = process.env.WFC_ANCHOR_LOCKS;
	/** @type {import("./lib/tree-drift.js").Lock[] | null} */
	const locks = injected
		? JSON.parse(injected)
		: require("./lib/arbiter-store.js").listLocks();
	if (locks === null) return "the claim store would not be read";
	found.othersLive = locks.some(
		(l) => l && l.sessionId !== self && (l.unreadable || l.alive),
	);
	const { neighbourDirty } = require("./lib/tree-drift.js");
	const core = require("./lib/arbiter-core.js");
	const nameFor = core.registryNames();
	const here = core.treeRoot();
	const inHere = locks.filter(
		(l) => !l || l.unreadable || core.recordTree(l) === here,
	);
	for (const e of (snap && neighbourDirty(snap, inHere, self)) ?? []) {
		if (!wanted.has(e.path)) continue;
		const entry = { holder: nameFor(e.sessionId), dead: e.dead };
		(ours.has(e.path) ? found.taken : found.held).set(e.path, entry);
	}
	found.heldRead = snap !== null;
	if (!self) return "this session is unidentified";
	const mine = locks.filter((l) => l?.sessionId === self && !l.unreadable);
	found.mine = new Set(mine.flatMap((l) => (l.path ? [l.path] : [])));
	return null;
}

/**
 * @param {{ inputs: string[], absent: Set<string> }} digests
 * @returns {{ paths: string[], error: string | null }}
 */
function readDirtyInputs({ inputs, absent }) {
	if (inputs.length === 0) return { paths: [], error: null };
	const head = readCommit(gitReader(root), "HEAD");
	if (!head.ok)
		return { paths: [], error: isInsideAnyRepo(root) ? head.why : null };
	if (head.sha === null) return { paths: [], error: null };
	const scope = ["--", ...inputs];
	const tracked = gitPaths([
		"--literal-pathspecs",
		"diff",
		"--no-renames",
		"--name-only",
		"-z",
		"HEAD",
		...scope,
	]);
	const untracked = gitPaths([
		"--literal-pathspecs",
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
		...scope,
	]);
	const error = tracked.error ?? untracked.error;
	return error
		? { paths: [], error }
		: {
				paths: [
					...tracked.paths,
					...untracked.paths.filter((p) => !absent.has(p)),
				],
				error: null,
			};
}

/**
 * @param {string[]} dirty
 * @param {HeldRead} read
 * @param {Map<string, string>} ours
 * @returns {Set<string>}
 */
function unclaimedOf(dirty, read, ours) {
	const covered = (/** @type {string} */ p) =>
		ours.has(p) ||
		read.held.has(p) ||
		read.taken.has(p) ||
		(read.mine?.has(p) ?? false);
	return new Set(dirty.filter((p) => !covered(p)));
}

/** @param {string} oid */
const isNullOid = (oid) => /^0+$/.test(oid);

/**
 * @returns {{ blobs: Map<string, string>, error: string | null }}
 */
function readStagedWhole() {
	const staged = gitPaths([
		"diff",
		"--cached",
		"--no-renames",
		"--raw",
		"--no-abbrev",
		"-z",
		"HEAD",
	]);
	const unstaged = gitPaths(["diff", "--no-renames", "--name-only", "-z"]);
	const error = staged.error ?? unstaged.error;
	if (error) return { blobs: new Map(), error };
	const rest = new Set(unstaged.paths);
	/** @type {Map<string, string>} */
	const blobs = new Map();
	for (const [i, status] of staged.paths.entries()) {
		if (i % 2 === 1) continue;
		const [, , , blob] = status.split(" ");
		const p = staged.paths[i + 1];
		if (blob === undefined || p === undefined)
			return { blobs: new Map(), error: `unparsed raw line ${status}` };
		if (!rest.has(p)) blobs.set(p, blob);
	}
	return { blobs, error };
}

const COMMIT_THEN_REVIEW =
	"commit it by pathspec and re-run the --review line that commit's refusal prints";

/**
 * @returns {string | null}
 */
function takingRecordPath() {
	const self = process.env.CLAUDE_CODE_SESSION_ID;
	if (!self) return null;
	const r = spawnGitSync(
		[
			"-C",
			root,
			"rev-parse",
			"--path-format=absolute",
			"--git-path",
			`wfc-review-taking/${self}.json`,
		],
		{ encoding: "utf8" },
	);
	return r.error || r.status !== 0 ? null : r.stdout.trim();
}

/**
 * @param {Map<string, string>} taking
 * @returns {string | null}
 */
function saveTaking(taking) {
	const file = takingRecordPath();
	if (!file) return "this session or its git directory is unknown";
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(Object.fromEntries(taking)));
		return null;
	} catch (e) {
		return caught(e).message;
	}
}

/**
 * @param {string[]} taking
 * @returns {{ ours: Map<string, string>, refused: string[] }}
 */
function checkTaking(taking) {
	/** @type {Map<string, string>} */
	const ours = new Map();
	/** @type {string[]} */
	const refused = [];
	if (taking.length === 0) return { ours, refused };
	/** @type {Record<string, string>} */
	let recorded = {};
	const file = takingRecordPath();
	try {
		if (file && fs.existsSync(file))
			recorded = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		refused.push(`taking record ${file} unread (${caught(e).message})`);
	}
	for (const rel of taking) {
		const blob = recorded[rel];
		const why =
			blob === undefined
				? "no refusal of this session's commit names it staged"
				: blobMismatch(rel, blob);
		if (blob !== undefined && why === null) ours.set(rel, blob);
		else
			refused.push(
				`not taking ${rel} — ${why}, so any claim on it stands; ${COMMIT_THEN_REVIEW}`,
			);
	}
	return { ours, refused };
}

/**
 * @param {string} rel
 * @param {string} blob
 * @returns {string | null}
 */
function blobMismatch(rel, blob) {
	if (!fs.existsSync(path.join(root, rel)))
		return isNullOid(blob)
			? null
			: "it is gone from the working tree, and the commit staged it";
	const r = spawnGitSync(["-C", root, "hash-object", "--", rel], {
		encoding: "utf8",
	});
	const failed = gitFailure(r);
	if (failed) return `git hash-object failed (${failed})`;
	return r.stdout.trim() === blob
		? null
		: "its working tree is not the copy the commit staged";
}

/**
 * @param {string[]} paths
 * @returns {{ hashedBy: Map<string, Set<string>>, inputs: string[], absent: Set<string> }}
 */
function readDigestInputs(paths) {
	const digests = paths.map((g) => ({ g, ...digestOf(root, g) }));
	const hashedBy = new Map(digests.map((d) => [d.g, d.hashed]));
	const inputs = [...new Set(digests.flatMap((d) => [...d.hashed]))];
	const absent = new Set(digests.flatMap((d) => [...d.absent]));
	return { hashedBy, inputs, absent };
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
 * @param {{ paths: string[], taking: string[], own: string[], soleWriter: boolean }} request
 * @param {Map<string, RuleRef[]>} describedBy
 * @param {Map<string, WiredScript>} implicitScripts
 * @param {Record<string, string>} anchors
 * @returns {never}
 */
function reanchor(request, describedBy, implicitScripts, anchors) {
	refuseFailedTreeRead();
	const { paths: reviewPaths, taking, own, soleWriter } = request;
	const targets =
		reviewPaths.length > 0
			? reviewPaths
			: [...new Set([...describedBy.keys(), ...implicitScripts.keys()])].sort();
	const digests = readDigestInputs(targets);
	const { hashedBy, inputs } = digests;
	const { ours, refused } = checkTaking(taking);
	for (const line of refused) printLine(line);
	const read = readHeldElsewhere(inputs, ours);
	const { held, taken, unavailable } = read;
	const unclaimed = readCallerUnclaimed(digests, read, ours, {
		own,
		soleWriter,
	});
	for (const [p, h] of taken)
		printLine(
			`taking ${p} from ${h.holder}${h.dead ? " (GONE)" : ""}'s claim — put it in this commit's pathspec`,
		);
	if (unavailable && !soleWriter)
		printLine(
			`claim check skipped — ${unavailable}, so no dirty input is known to be this session's and none is anchored`,
		);
	/** @type {ReviewRun} */
	const run = {
		describedBy,
		implicitScripts,
		anchors,
		hashedBy,
		held,
		unclaimed,
		next: reviewPaths.length > 0 ? { ...anchors } : {},
		missing: [],
		skipped: [],
		anyHeld: false,
		anyGone: false,
		unclaimedSeen: new Set(),
		written: 0,
		anchored: [],
	};

	for (const g of targets) reanchorTarget(run, g);
	for (const l of buildStaleAtHeadLines(readStaleAtHead(root, run.anchored)))
		printLine(l);

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
			`${g in anchors ? "dropped" : "skipped"} ${g} — ${whyNoDigest(g)}`,
		);
	const carried = Object.keys(next).length - written;
	printLine(buildReviewSummary(run, carried).join("\n"));
	process.exit(0);
}

/**
 * @param {{ inputs: string[], absent: Set<string> }} digests
 * @param {HeldRead & { unavailable: string | null }} read
 * @param {Map<string, string>} ours
 * @param {{ own: string[], soleWriter: boolean }} caller
 * @returns {Set<string>}
 */
function readCallerUnclaimed(digests, read, ours, { own, soleWriter }) {
	if (own.length > 0) refuseUnreadOwn(read);
	const unclaimed = soleWriter
		? refuseSoleWriter(read)
		: readUnclaimed(digests, read, ours);
	for (const p of own) unclaimed.delete(p);
	return unclaimed;
}

/**
 * @param {HeldRead & { unavailable: string | null }} read
 */
function refuseUnreadOwn(read) {
	if (read.heldRead) return;
	printLine(
		`--own refused — ${read.unavailable}, so no neighbour's claim on an --own path is known to be absent.`,
	);
	process.exit(2);
}

function refuseFailedTreeRead() {
	const { failure } = treeOf(root);
	if (failure)
		throw brokenError(
			`--review re-anchors nothing: ${failure}, so each digest would resolve its dependencies on disk rather than in the index (workflow-core#4508).`,
		);
}

/**
 * @param {HeldRead & { unavailable: string | null }} read
 * @returns {Set<string>}
 */
function refuseSoleWriter(read) {
	if (read.othersLive === false) return new Set();
	printLine(
		`--sole-writer refused — ${read.othersLive ? "another session holds a claim in this tree" : read.unavailable}, and the flag is for a tree no session works yet.`,
	);
	process.exit(2);
}

/**
 * @param {{ inputs: string[], absent: Set<string> }} digests
 * @param {HeldRead} read
 * @param {Map<string, string>} ours
 * @returns {Set<string>}
 */
function readUnclaimed(digests, read, ours) {
	const dirty = readDirtyInputs(digests);
	const merged =
		dirty.error === null
			? readParentStaged(dirty.paths)
			: { paths: new Set(), error: null };
	const error = dirty.error ?? merged.error;
	if (error === null)
		return unclaimedOf(
			dirty.paths.filter((p) => !merged.paths.has(p)),
			read,
			ours,
		);
	printLine(
		`not anchored — git would not say which digest inputs are dirty (${error}), so any anchor here could hash uncommitted bytes.`,
	);
	process.exit(1);
}

/**
 * @param {string[]} dirty
 * @returns {{ paths: Set<string>, error: string | null }}
 */
function readParentStaged(dirty) {
	/** @type {Set<string>} */
	const paths = new Set();
	if (dirty.length === 0) return { paths, error: null };
	const parents = readMergeHeadLines(root);
	if (parents.length === 0) return { paths, error: null };
	const staged = readStagedBlobs(dirty);
	if (staged.error) return { paths, error: staged.error };
	const { index, whole } = staged;
	if (whole.length === 0) return { paths, error: null };
	for (const sha of parents) {
		const tree = readTreeBlobs(sha, whole);
		if (tree.error) return { paths, error: tree.error };
		for (const p of whole) if (index.get(p) === tree.blobs.get(p)) paths.add(p);
	}
	return { paths, error: null };
}

/**
 * @param {string[]} dirty
 * @returns {{ index: Map<string, string>, whole: string[], error: string | null }}
 */
function readStagedBlobs(dirty) {
	/** @type {Map<string, string>} */
	const index = new Map();
	const literal = ["--literal-pathspecs"];
	const scope = ["--", ...dirty];
	const staged = gitPaths([...literal, "ls-files", "--stage", "-z", ...scope]);
	const unstaged = gitPaths([
		...literal,
		"diff",
		"--name-only",
		"-z",
		...scope,
	]);
	const error = staged.error ?? unstaged.error;
	if (error) return { index, whole: [], error };
	const rest = new Set(unstaged.paths);
	for (const line of staged.paths) {
		const m = /^\d+ ([0-9a-f]+) (\d)\t(.*)$/s.exec(line);
		if (!m?.[1] || !m[3])
			return { index, whole: [], error: `unparsed index line ${line}` };
		if (m[2] === "0") index.set(m[3], m[1]);
		else rest.add(m[3]);
	}
	const whole = dirty.filter(
		(p) => !rest.has(p) && (index.has(p) || !fs.existsSync(path.join(root, p))),
	);
	return { index, whole, error: null };
}

/**
 * @param {string} sha
 * @param {string[]} paths
 * @returns {{ blobs: Map<string, string>, error: string | null }}
 */
function readTreeBlobs(sha, paths) {
	/** @type {Map<string, string>} */
	const blobs = new Map();
	const tree = gitPaths([
		"--literal-pathspecs",
		"ls-tree",
		"-z",
		sha,
		"--",
		...paths,
	]);
	for (const line of tree.paths) {
		const tab = line.indexOf("\t");
		const blob = line.slice(0, tab).split(" ")[2];
		if (tab < 0 || !blob) return { blobs, error: `unparsed tree line ${line}` };
		blobs.set(line.slice(tab + 1), blob);
	}
	return { blobs, error: tree.error };
}

/**
 * @typedef {{
 *   describedBy: Map<string, RuleRef[]>,
 *   implicitScripts: Map<string, WiredScript>,
 *   anchors: Record<string, string>,
 *   hashedBy: Map<string, Set<string>>,
 *   held: Map<string, HeldEntry>,
 *   unclaimed: Set<string>,
 *   next: Record<string, string>,
 *   missing: string[],
 *   skipped: string[],
 *   anyHeld: boolean,
 *   anyGone: boolean,
 *   unclaimedSeen: Set<string>,
 *   written: number,
 *   anchored: import("./lib/stale-at-head.js").Anchored[],
 * }} ReviewRun
 */

/**
 * @param {ReviewRun} run
 * @param {string} g
 */
function reanchorTarget(run, g) {
	const inputs = run.hashedBy.get(g);
	const holders = heldInputs(inputs, run.held);
	const unclaimed = [...(inputs ?? [])].filter((p) => run.unclaimed.has(p));
	if (holders.length > 0 || unclaimed.length > 0) {
		run.skipped.push(g);
		run.anyHeld ||= holders.length > 0;
		run.anyGone ||= holders.some((h) => h.dead);
		for (const p of unclaimed) run.unclaimedSeen.add(p);
		const anchor = run.anchors[g];
		if (anchor !== undefined) run.next[g] = anchor;
		printLine(
			`not anchored ${g} — ${[
				...holders.map(buildHeldLine),
				...unclaimed.map(
					(p) => `${p} is dirty and not claimed by this session`,
				),
			].join("; ")}, so nothing here read the bytes it would hash`,
		);
		return;
	}
	const d = digestOf(root, g).digest;
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
	run.anchored.push({ guard: g, digest: d, inputs: [...(inputs ?? [])] });
	printLine(`anchored ${g} @ ${d}`);
	printDescriptions(run, g);
}

/**
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
 * @param {import("./lib/stale-at-head.js").StaleRead} read
 * @returns {string[]}
 */
function buildStaleAtHeadLines({ stale, error }) {
	if (error)
		return [
			"",
			`Rows already stale at HEAD not named — git failed (${error}), so a row re-anchored here may carry changes made before this commit unread (workflow-core#4756).`,
		];
	if (stale.length === 0) return [];
	const one = stale.length === 1;
	const lines = [
		"",
		`Already stale at HEAD — re-anchoring ${one ? "this row" : "these rows"} also asserts a re-read of what changed under ${one ? "it" : "them"} before this commit (workflow-core#4756):`,
	];
	for (const s of stale) lines.push(...buildStaleAtHeadRow(s));
	lines.push(
		`Read each against the rules printed for its row, or leave the row stale: restore its HEAD anchor in ${ANCHORS} before committing.`,
	);
	return lines;
}

/** @param {import("./lib/stale-at-head.js").StaleAtHead} s */
function buildStaleAtHeadRow(s) {
	const lead = `  ${s.guard} — HEAD's anchor ${s.anchor}`;
	if (s.error)
		return [
			`${lead}: what changed since it was written not named — git failed (${s.error}).`,
		];
	if (s.writer === null)
		return [
			`${lead} was written by no commit in the history this clone holds, so what changed since is not named.`,
		];
	const at = s.writer.slice(0, SHORT_SHA);
	if (s.changed.length === 0)
		return [
			`${lead}, written at ${at}, was already stale there: no input changed since, so what made it stale is not named.`,
		];
	return [
		`  ${s.guard} — anchored at ${at}; changed since: ${s.changed.join(", ")}`,
		`    git diff ${at} HEAD -- ${s.changed.map(shellQuote).join(" ")}`,
	];
}

/**
 * @param {ReviewRun} run
 * @param {number} carried
 * @returns {string[]}
 */
function buildReviewSummary(
	{ written, skipped, anyHeld, anyGone, unclaimedSeen },
	carried,
) {
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
			`${skipped.length} named path(s) not anchored: an input is dirty and not this session's.`,
		);
	if (anyHeld)
		lines.push(
			anyGone
				? "A holder marked GONE will never release: commit or revert the file."
				: "Re-run once the holder releases.",
		);
	if (unclaimedSeen.size > 0) lines.push(buildUnclaimedLine(unclaimedSeen));
	return lines;
}

/**
 * @param {Set<string>} unclaimed
 * @returns {string}
 */
function buildUnclaimedLine(unclaimed) {
	const { isWatched } = require("./lib/arbiter-core.js");
	const paths = [...unclaimed].sort(byCodeUnit);
	const watched = paths.filter(isWatched);
	const unwatched = paths.filter((p) => !isWatched(p));
	const routes = [];
	if (watched.length > 0)
		routes.push(
			`claim ${watched.join(", ")} if yours (${buildArbiterCommand`claim <path>`})`,
		);
	if (unwatched.length > 0)
		routes.push(
			`no claim can name ${unwatched.join(", ")}, which the arbiter does not watch, so if yours ${COMMIT_THEN_REVIEW}`,
		);
	return (
		`A dirty input no claim of this session's covers matches no committed tree: ${routes.join("; ")}. ` +
		"Else re-anchor in a clean worktree of HEAD outside this checkout " +
		"(git worktree add --detach <dir> HEAD) and carry its anchors file back."
	);
}

const STALE_KINDS = new Set(["UNANCHORED", "STALE-PROSE", "ORPHAN-ANCHOR"]);

/** @typedef {import("./lib/check.js").FaultItem} FaultItem */

/** @param {FaultItem} f */
const staleOf = (f) => {
	const item = /** @type {StaleWarning} */ (f.item);
	return item?.[REFUSES_COMMIT] ? item : null;
};

const reviewCommand = () =>
	`node ${scriptPath("check-guard-registry.js")} --review`;

/** @param {string} guard */
const buildReviewLine = (guard) => `${reviewCommand()} ${guard}`;

/**
 * @param {Ctx} ctx
 * @param {FaultItem[]} added
 * @param {import("./lib/check.js").Sides} sides
 * @returns {{ refuse: FaultItem[], remedy: string[], data: { carried: string[] } }}
 */
function settleStale(ctx, added, sides) {
	const stale = added.map(staleOf).filter((w) => w !== null);
	const { rev: tip, head: pushed } = againstRevs(ctx);
	const carry =
		stale.length > 0 && !pushed ? carryMerge(ctx, stale, sides) : null;
	const carried = new Set(carry?.carried ?? []);
	const isCarried = (/** @type {FaultItem} */ f) =>
		carried.has(staleOf(f)?.guard ?? "");
	const { refuse, remedy } = settleOwed(
		ctx,
		added.filter((f) => !isCarried(f)),
		stale.filter((w) => !carried.has(w.guard)),
		{ tip, pushed },
	);
	const data = { carried: [...carried] };
	if (carried.size === 0 || carry?.lands) return { refuse, remedy, data };
	return {
		refuse: [...added.filter(isCarried), ...refuse],
		remedy: [
			...remedy,
			"",
			`${carried.size} row(s) above carry across this merge, each side having changed different files of its closure (workflow-core#4514),`,
			"  but git wrote this merge's tree before this hook ran. Finish the merge with them carried:",
			"    git commit --no-edit",
		],
		data,
	};
}

/**
 * @param {Ctx} ctx
 * @param {StaleWarning[]} stale
 * @param {import("./lib/check.js").Sides} sides
 * @returns {{ carried: string[], lands: boolean } | null}
 */
function carryMerge(ctx, stale, sides) {
	const merge = readMerge(root);
	if (merge === null) return null;
	/** @param {Record<string, unknown> | undefined} envelope */
	const freshOf = (envelope) =>
		Array.isArray(envelope?.fresh)
			? new Set(/** @type {string[]} */ (envelope.fresh))
			: null;
	/** @param {Record<string, unknown> | undefined} envelope */
	const staleOn = (envelope) =>
		Array.isArray(envelope?.warnings)
			? new Set(
					/** @type {Warning[]} */ (envelope.warnings)
						.filter((w) => STALE_KINDS.has(w.kind))
						.map((w) => w.guard),
				)
			: null;
	const { carried, kept, none } = judgeCarry(root, merge, stale, {
		oursStale: staleOn(sides.baseline),
		readTheirsFresh: (rev) => {
			const r = sides.read(rev);
			return r.outcome === "BROKEN" || r.outcome === "SKIP"
				? null
				: freshOf(r.envelope);
		},
	});
	if (none) ctx.say(`no row carried across this merge: ${none}.`);
	for (const k of kept) ctx.say(`not carried ${k.guard} — ${k.why}.`);
	if (carried.length === 0) return { carried: [], lands: merge.lands };
	if (merge.lands) {
		const failed = writeCarried(root, ANCHORS, carried);
		if (failed) {
			ctx.say(`no row carried across this merge: ${failed}.`);
			return { carried: [], lands: true };
		}
	}
	for (const c of carried)
		ctx.say(
			`${merge.lands ? "carried" : "carries"} ${c.guard} across the merge, anchored ${c.digest}: each side changed different files of its closure (workflow-core#4514).`,
		);
	return { carried: carried.map((c) => c.guard), lands: merge.lands };
}

/**
 * @param {Ctx} ctx
 * @param {FaultItem[]} added
 * @param {StaleWarning[]} stale
 * @param {{ tip: string, pushed: string | undefined }} revs
 * @returns {{ refuse: FaultItem[], remedy: string[] }}
 */
function settleOwed(ctx, added, stale, { tip, pushed }) {
	if (stale.length === 0) return { refuse: added, remedy: [] };

	const { hashedBy, inputs } = readDigestInputs(stale.map((w) => w.guard));
	const read = readHeldAtGate(ctx, inputs, pushed);
	const { held, unavailable } = read;
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
			? `${pushed} leaves the guard-registry anchor(s) above expired on ${tip}'s tree (workflow-core#3074). Re-read what each records against the path as pushed:`
			: "This commit leaves the guard-registry anchor(s) above expired (workflow-core#2617). Re-read what each records against the path as staged:",
	];
	if (changed.error)
		remedy.push(
			`  the paths each row went stale through not named — git diff${pushed ? "" : " --cached"} failed (${changed.error}).`,
		);
	for (const w of owed)
		remedy.push(
			...buildOwedRow(w, {
				hashed: [...(hashedBy.get(w.guard) ?? [])],
				changed,
				annotated: implicitScripts.has(w.guard),
			}),
		);
	const takes = takeOwed(owedInputs, read, pushed, remedy);
	const review = buildReviewLine(owed.map((w) => w.guard).join(" ") + takes);
	remedy.push(
		...(pushed
			? [
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
 * @param {StaleWarning} w
 * @param {{ hashed: string[], changed: { paths: string[], error: string | null },
 *   annotated: boolean }} at
 * @returns {string[]}
 */
function buildOwedRow(w, { hashed, changed, annotated }) {
	const touched = hashed.filter((p) => changed.paths.includes(p));
	return buildExpiredRow(
		w,
		touched.filter((p) => p !== w.guard),
		{ annotated, untouched: !changed.error && touched.length === 0 },
	);
}

/**
 * @param {string[]} owedInputs
 * @param {Pick<HeldRead, "taken" | "mine"> & { ours: Map<string, string> }} read
 * @param {string | undefined} pushed
 * @param {string[]} remedy
 */
function takeOwed(owedInputs, { taken, mine, ours }, pushed, remedy) {
	const owedTaking = new Map(
		[...new Set(owedInputs)].flatMap((p) => {
			const blob = ours.get(p);
			const owed =
				blob !== undefined && (taken.has(p) || (mine !== null && !mine.has(p)));
			return owed ? [/** @type {[string, string]} */ ([p, blob])] : [];
		}),
	);
	const unsaved = pushed ? null : saveTaking(owedTaking);
	if (unsaved && owedTaking.size > 0)
		remedy.push(
			`  taking record not written (${unsaved}), so --review keeps each --taking path's claim.`,
		);
	return [...owedTaking.keys()].map((p) => ` --taking ${p}`).join("");
}

/**
 * @param {Ctx} ctx
 * @param {string[]} inputs
 * @param {string | undefined} pushed
 */
function readHeldAtGate(ctx, inputs, pushed) {
	if (pushed)
		return {
			held: new Map(),
			taken: new Map(),
			mine: null,
			ours: new Map(),
			unavailable: null,
		};
	const ours = readStagedWhole();
	if (ours.error)
		ctx.say(
			`staged read failed (${ours.error}), so a claimed file this commit stages whole still stands its row down.`,
		);
	return { ...readHeldElsewhere(inputs, ours.blobs), ours: ours.blobs };
}

/**
 * @param {string[]} args
 * @returns {{ paths: string[], error: string | null }}
 */
function gitPaths(args) {
	const r = spawnGitSync(["-C", root, ...args], {
		encoding: "utf8",
	});
	const error = gitFailure(r);
	if (error) return { paths: [], error };
	return { paths: r.stdout.split("\0").filter(Boolean), error: null };
}

/**
 * @param {{ error?: Error, status: number | null }} r
 */
const gitFailure = (r) =>
	r.error || r.status !== 0 ? (r.error?.message ?? `exit ${r.status}`) : null;

/**
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

/**
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
	const wayOut = `restore it, re-anchor with  ${reviewCommand()}  and commit ${ANCHORS}.`;
	return (
		parseRows(text) ??
		ctx.broken(
			`${ANCHORS} at ${rev} is not a JSON object of digests; ${wayOut}`,
		)
	);
}

/**
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
		const { digest: d, hashed } = digestOf(root, g);
		const via = [...hashed].filter((p) => touched.has(p));
		if (d !== null && d !== anchors[g] && via.length > 0)
			expired.push({ guard: g, via: via.filter((p) => p !== g) });
	}
	return { expired, gone };
}

/**
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
		for (const l of buildExpiredRow(w, via, { annotated, untouched: false }))
			ctx.say(l);
	};
	for (const { guard, via } of expired) {
		const w = targetWarning(guard, describedBy, implicitScripts, { anchors });
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
 * @param {{ annotated: boolean, untouched: boolean }} how
 * @returns {string[]}
 */
function buildExpiredRow(w, via, { annotated, untouched }) {
	return [
		`  ${w.kind}  ${w.guard}${via.length > 0 ? ` (through ${via.join(", ")})` : ""}`,
		...w.rules.map((r) => `    rule:  ${r.file}:${r.line}  ${r.gist}`),
		...(annotated
			? [
					`    and its IMPLICIT / JUSTIFIED / DEFEAT row in ${IMPLICIT_MANIFEST}`,
				]
			: []),
		...(untouched
			? [
					"    none of its files changed: this commit changed how its digest is computed, so it may be re-anchored without a re-read (workflow-core#4807)",
				]
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
		"This commit changed a guard the guard registry describes, or a file its digest hashes (workflow-core#2375):",
	);
	const warnings = sayExpired(ctx, found, anchors);
	ctx.say(
		"  Once your changes are done, re-read each rule above against the guard as it now is, " +
			"correct any sentence that is no longer true — and for a guard gone, the rules naming it, " +
			"anchoring its new path where it moved — re-anchor that guard alone with  " +
			`${buildReviewLine("<guard-path>")}  (a gone path's anchor is dropped) ` +
			`and commit ${ANCHORS}.`,
	);
	return {
		noun: "guard(s) whose registry prose this commit expired",
		data: { rev, warnings },
	};
}

/** @typedef {import("./lib/check").Ctx} Ctx */

/**
 * @param {Ctx} ctx
 * @returns {number}
 */
function reviewIndex(ctx) {
	const reviewAt = ctx.argv.indexOf("--review");
	if (reviewAt === -1) return reviewAt;
	if (ctx.asJson)
		ctx.usageError(
			"--review writes anchors and reports no findings, so it has no --json form.",
		);
	if (ctx.has("--root"))
		ctx.usageError(
			"--review writes anchors into the tree it read, so it cannot run under --root.",
		);
	return reviewAt;
}

/**
 * @param {Ctx} ctx
 * @param {number} reviewAt
 * @returns {{ named: string[], stale: boolean, taking: string[], own: string[], soleWriter: boolean } | null}
 */
function parseReviewRequest(ctx, reviewAt) {
	if (reviewAt === -1) {
		for (const flag of ["--sole-writer", "--stale", "--own"])
			if (ctx.has(flag)) ctx.usageError(`${flag} only qualifies --review.`);
		return null;
	}
	const after = ctx.argv.slice(reviewAt + 1);
	const named = after.filter(
		(a, i) =>
			!a.startsWith("--") && !REVIEW_VALUE_FLAGS.includes(after[i - 1] ?? ""),
	);
	const stale = ctx.has("--stale");
	if (stale && named.length > 0)
		ctx.usageError(
			"--stale re-anchors the rows the scan finds stale, so it takes no path.",
		);
	return {
		named,
		stale,
		taking: valuesOf(ctx, "--taking"),
		own: valuesOf(ctx, "--own"),
		soleWriter: ctx.has("--sole-writer"),
	};
}

const REVIEW_VALUE_FLAGS = ["--taking", "--own"];

/**
 * @param {Ctx} ctx
 * @param {string} flag
 * @returns {string[]}
 */
const valuesOf = (ctx, flag) =>
	ctx.argv.filter((_, i) => ctx.argv[i - 1] === flag);

function buildTreeFailureLines() {
	const { failure } = treeOf(root);
	return failure
		? [
				`Tree read FAILED OPEN — ${failure}. Digests resolve each guard's dependencies on disk, untracked and ignored files included (workflow-core#4508).`,
			]
		: [];
}

function buildIgnoreLine() {
	if (gitignoreFailure)
		return `Gitignore filter FAILED OPEN — ${gitignoreFailure}. Scope is the whole walk, scratch included.`;
	if (ignoreSkipped)
		return "Gitignore filter: not run — a materialised tree holds tracked files only.";
	const docs = listedByGit
		? "documents and emitters listed by git, ignored ones left out; "
		: "";
	return `Gitignore filter: ${docs}${ignoreDropped} path(s) dropped as ignored.`;
}

/**
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
				`  ${buildReviewLine("<guard-path>")},\n` +
				"  or every one at once with --review --stale.\n" +
				"  Warnings here; .husky/pre-commit refuses the commit that adds one.\n",
		);

	if (reprintCount > 0)
		ctx.say(
			`${reprintCount} rule(s) whose text its guard reprints when it denies.\n` +
				"  The denial hands the session the whole instruction after refusing the\n" +
				"  command, so the document copy may be cuttable — read the deny text, then\n" +
				"  cut only what it carries, keeping any residual it does not (mantahostels#964).\n" +
				"  Where the deny is NOT reached on the first trigger, the rule must stay:\n" +
				`  declare that on the core's row in ${MANIFEST_REL} as \`"denyTiming": "delayed"\`.\n` +
				"  Warnings only — this never fails the build.\n",
		);
}

/**
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
				`  asked for it, so its row in ${IMPLICIT_MANIFEST}, keyed by its path, must say what:\n\n` +
				'    "IMPLICIT":  "<one line — what this does to a session without being asked>"\n' +
				'    "JUSTIFIED": "fail-safe | convenience — <why>"\n' +
				'    "DEFEAT":    "none | <the env var or flag>"\n\n' +
				"  `none` and `convenience` are both legal answers: DEFEAT records what escape\n" +
				"  exists and never demands one (mantahostels#1181), and whether convenience is good enough\n" +
				"  is a reader's call. Unwire the script instead if it should not act at all, and\n" +
				"  delete the row of a script nothing wires.\n",
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
			`  An \`if\` field in ${hooksFile()}\n` +
				"  decides whether the script runs at all, so the DEFEAT its row in\n" +
				`  ${IMPLICIT_MANIFEST} gives is computed against it. That row's \`${IF_KEY}\`\n` +
				"  array names every clause the wiring narrows the script with, verbatim, and\n" +
				"  no other (docs/agents/guard-authoring.md, surface 4). UNWIRED-IF is a row\n" +
				"  whose `IF` names a script no hook entry runs: drop the `IF`, or wire the\n" +
				"  script (mantahostels#2234).\n",
		);
}

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "guard-registry",
	usage: `node check-guard-registry.js [--warn] [--json] [--roster] [--root <dir>] [--against <rev>] [--head <rev>] | --touched-by <rev> [--root <dir>] (BROKEN past ${TOUCHED_BY_CEILING_MS / 1000}s) | --review [--sole-writer] [<path>…] [--taking <path>]… [--own <path>]… | --review --stale`,
	valueFlags: ["--root", "--touched-by", "--taking", "--own"],
	against: {
		profile: "guard-registry",
		materialise: "tree",
		baselineCode: "rev",
		refuse(ctx) {
			if (ctx.has("--review"))
				ctx.usageError(
					"--review writes anchors into the tree it read, so it cannot run under --against.",
				);
			const refusal = nestedCopyRefusal();
			if (refusal) throw brokenError(refusal);
		},
		settle: settleStale,
	},
	flags: ["--review", "--roster", "--sole-writer", "--stale"],
	run(ctx) {
		setRoot(ctx.value("--root"));
		if (ctx.has("--touched-by")) return runTouched(ctx);
		const request = parseReviewRequest(ctx, reviewIndex(ctx));

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

		if (request)
			reanchor(
				{
					paths: request.stale
						? staleGuards(describedBy, implicitScripts, anchors)
						: request.named,
					taking: request.taking,
					own: request.own,
					soleWriter: request.soleWriter,
				},
				describedBy,
				implicitScripts,
				anchors,
			);

		/** @type {Set<string>} */
		const fresh = new Set();
		const warnings = [
			...stalenessWarnings(describedBy, implicitScripts, anchors, fresh),
			...reprintWarnings(enforcedRules),
		];

		for (const f of findings)
			ctx.fail(f.kind, `${f.file}:${f.line} — ${f.detail}`, f);
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
				`Hook \`if\` narrowings: ${narrowed.size} wired script(s) or dispatcher core(s) run on a narrowed set.\n` +
				[buildIgnoreLine(), ...buildTreeFailureLines()].join("\n"),
		);

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
				"rule's fragment and emitter agree, and every implicit row's `IF` " +
				"matches the `if` narrowing its script is wired with.",
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
				fresh: [...fresh].sort(byCodeUnit),
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
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
