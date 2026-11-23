#!/usr/bin/env node
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
const { commitRoute, isReplayRoute } = require("./lib/commit-route.js");
const { readText } = require("./lib/file-read.js");
const { compareVersions } = require("./lib/compare-versions.js");
const { shellQuote } = require("./lib/sh-quote.js");
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
const { CONFIG_PATH, readConfig } = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE =
	"usage: node mutation-hold-gate.js [--due | --pre-lock | --seed]   (from .husky/pre-commit, commit-paths with a flag, or --seed by hand)\n";

/** @typedef {"hook"|"due"|"pre-lock"} Mode */

const IDLE = { hook: 0, due: 1, "pre-lock": 3 };

const MUTABLE = /\.(c?js|mjs|[cm]?ts|jsx|tsx|html|vue|svelte)$/;
const TEST_NAME = /(^|\/)__tests__\/|\.([sS]pec|[tT]est)\.[^/]+$/;
/** @param {string} p */
const isMutable = (p) => MUTABLE.test(p) && !TEST_NAME.test(p);

/* #1901 */
const RED_INITIAL = "There were failed tests in the initial test run";

/** @typedef {{start: number, end: number}} LineRange */
/** @typedef {{at: string, text: string}} Disable */
/** @typedef {import("./lib/hunk-header.js").HunkHeader} HunkHeader */
/** @typedef {import("./lib/stryker-comments.js").BabelComment} BabelComment */
/** @typedef {import("./lib/stryker-comments.js").ParseEntry} ParseEntry */
/** @typedef {import("./lib/stryker-comments.js").ParseKind} ParseKind */
/** @typedef {import("./lib/stryker-comments.js").ReadComments} ReadComments */

const REFUSING = new Set(["Survived", "NoCoverage"]);
const PASSING = new Set(["Killed", "Timeout", "Ignored"]);
const LEFT_OUT = new Set(["CompileError", "RuntimeError"]);

/* #1871 guess: vitest's failure summary over Stryker's last log lines */
const OUTPUT_TAIL_LINES = 40;
/* #1871 guess: one mutant stays one terminal line */
const ORIGINAL_MAX = 60;
// #1851 guess: the one setting a single cold run tried
const CONCURRENCY = 2;

const UNPARSEABLE = "could not parse Stryker's JSON report";

/** @typedef {{prefix: string, tree: string, unjudged: string, refused: string, again: string}} Voice */
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

/* https://github.com/stryker-mutator/stryker-js/blob/v10.1.1/packages/core/src/config/config-file-formats.ts */
const CONFIG_NAMES = ["", "."].flatMap((dot) =>
	[".conf", ".config"].flatMap((kind) =>
		["json", "js", "mjs", "cjs"].map((ext) => `${dot}stryker${kind}.${ext}`),
	),
);
const TEST_RUNNER = "vitest";
const CORE_DEFAULT = { testRunner: TEST_RUNNER, coverageAnalysis: "perTest" };
/* `vitest`'s threads pool fails a test calling `process.chdir()` and dies under an `execArgv` heap flag;
 * Stryker's `disableTypeChecks` drops file modes: https://github.com/stryker-mutator/stryker-js/blob/v10.1.1/packages/instrumenter/src/disable-type-checks.ts */
const POOL = "forks";
const DISABLE_TYPE_CHECKS = false;

/* https://github.com/stryker-mutator/stryker-js/blob/v10.1.1/packages/instrumenter/src/transformers/directive-bookkeeper.ts */
const DIRECTIVE =
	/^\s?Stryker (disable|restore)(?: (next-line))? ([a-zA-Z, ]+)(?::(.+)?)?/;
const DISABLE_TEXT = "Stryker disable";
const COMPONENT = /\.(html|vue|svelte)$/;
const SCRIPT = /(<script\b([^>]*)>)([\s\S]*?)<\/script\s*>/gi;
const ATTRIBUTE = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?/g;
/* https://github.com/stryker-mutator/stryker-js/blob/v10.1.1/packages/instrumenter/src/parsers/html-parser.ts */
const TSX_SCRIPT_TYPES = ["tsx", "text/tsx"];
const TS_SCRIPT_TYPES = ["ts", "text/typescript", "typescript"];
const JS_SCRIPT_TYPES = ["js", "text/javascript", "javascript", "module"];
const DISABLES_UNREAD = "could not read the added disable comments";
const STRYKER_COMMENTS = path.join(__dirname, "lib", "stryker-comments.js");
/* #2624 guess: far past Babel's parse, short of a hang */
const COMMENTS_TIMEOUT_MS = 30_000;

const CACHE_NAME = "wfc-mutation-incremental.json";

/* #1901, #5180 */
const STRYKER_VERSION = "10.1.1";
const STRYKER_PACKAGES = [
	"@stryker-mutator/core",
	`@stryker-mutator/${TEST_RUNNER}-runner`,
];

class HoldFaultError extends Error {
	/**
	 * @param {string} fault
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
 * #5201
 * @param {string} gitDir
 */
const isSkippedRoute = (gitDir) => {
	const route = commitRoute("pre-commit", gitDir);
	return isReplayRoute(route) || route === "merge";
};

/**
 * @param {string} rev
 * @param {string} file
 * @param {string} fault
 */
const readFileOrFault = (rev, file, fault) =>
	orFault(fault, () => readFileAt(rev, file, { timeout: GIT_TIMEOUT_MS })) ??
	null;

/** @param {string} file */
function readStagedFile(file) {
	const fault = "could not read a staged file";
	const text = readFileOrFault("", file, fault);
	if (text === null)
		throw new HoldFaultError(fault, { detail: `${file} is not in the index` });
	return text;
}

/** @typedef {{root: string, text: string|null}} ConfigCopy */

/**
 * @param {string} work
 * @param {string} rev
 * @returns {ConfigCopy}
 */
function configCopyAt(work, rev) {
	const root = path.join(work, `root${rev}`);
	fs.mkdirSync(path.join(root, path.dirname(CONFIG_PATH)), { recursive: true });
	const text = readFileOrFault(
		rev,
		CONFIG_PATH,
		`could not read ${CONFIG_PATH}`,
	);
	if (text !== null) fs.writeFileSync(path.join(root, CONFIG_PATH), text);
	return { root, text };
}

/**
 * #2077
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
		throw new HoldFaultError(`could not read ${CONFIG_PATH}`, {
			detail: caught(e).message,
			cause: e,
		});
	}
}

/**
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
 * @param {HunkHeader[]} hunks
 * @returns {LineRange[]}
 */
const addedRanges = (hunks) =>
	hunks
		.filter((h) => h.newCount > 0)
		.map((h) => ({ start: h.newStart, end: h.newStart + h.newCount - 1 }));

/**
 * @param {HunkHeader[]} hunks
 * @param {number} line
 */
function findHeadLine(hunks, line) {
	let shift = 0;
	for (const h of hunks) {
		const last = h.newStart + h.newCount - 1;
		if (h.newCount > 0 && h.newStart <= line && line <= last) return null;
		if ((h.newCount > 0 ? last : h.newStart) < line)
			shift += h.oldCount - h.newCount;
	}
	return line + shift;
}

/**
 * @param {string} stderrLine
 * @param {string} logLine
 */
function reportFailOpen(stderrLine, logLine) {
	writeFd(2, `pre-commit: ${stderrLine}\n`);
	failOpenLogger("mutation-hold-gate.js")?.(logLine);
}

/**
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
 * https://github.com/stryker-mutator/stryker-js/blob/v10.1.1/packages/instrumenter/src/parsers/svelte-parser.ts
 * https://github.com/stryker-mutator/stryker-js/blob/v10.1.1/packages/instrumenter/src/parsers/html-parser.ts
 * @param {string} file
 * @param {string} attributes
 * @returns {ParseKind | null}
 */
function scriptKind(file, attributes) {
	/** @type {Map<string, string>} */
	const attrs = new Map(
		[...attributes.matchAll(ATTRIBUTE)].map((a) => [
			requiredGroup(a, 1, ATTRIBUTE).toLowerCase(),
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
 * @param {string} file
 * @returns {ParseKind}
 */
function fileKind(file) {
	if (file.endsWith(".tsx")) return "tsx";
	return /\.[cm]?ts$/.test(file) ? "ts" : "js";
}

/**
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
 * @param {string} root
 * @param {string|null} strykerConfig
 * @param {ParseEntry[]} entries
 * @returns {{files: ReadComments} | {error: string}}
 */
function readCommentsInChild(root, strykerConfig, entries) {
	const timeout =
		Number(process.env.WFC_MUTATION_COMMENTS_TIMEOUT_MS) || COMMENTS_TIMEOUT_MS;
	const r = spawnSync(process.execPath, [STRYKER_COMMENTS], {
		input: JSON.stringify({ root, strykerConfig, entries }),
		encoding: "utf8",
		// #2727
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

/** @param {BabelComment} c */
const findDirectiveLine = (c) =>
	c.loc.start.line + (c.value.startsWith("\n") ? 1 : 0);

/** @typedef {{verb: string, scope: string | undefined, mutators: string[], reason: string | undefined}} ParsedDirective */
/** @typedef {{comment: BabelComment, directive: ParsedDirective}} Directive */

/**
 * @param {string} text
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
 * @param {LineRange[]} added
 * @param {number} from
 * @param {number} to
 */
const hasAddedBetween = (added, from, to) =>
	added.some((r) => r.start <= to && from <= r.end);

/**
 * @param {BabelComment} c
 * @param {LineRange[]} added
 * @returns {c is BabelComment & {leads: number}}
 */
const isRead = (c, added) =>
	c.leads !== undefined &&
	(c.within ?? []).every(([s, e]) => hasAddedBetween(added, s, e));

/**
 * @param {Directive} disable
 * @param {BabelComment[]} comments
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
 * @param {Directive} disable
 * @param {BabelComment[]} comments
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
 * #1909, #2573, #2624, #2727
 * @param {BabelComment[]} comments
 * @param {HunkHeader[]} fileHunks
 * @param {Set<number> | null} held
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
 * #2366, #2727
 * @param {string} root
 * @param {string|null} strykerConfig
 * @param {Map<string, HunkHeader[]>} hunks
 * @returns {Disable[]}
 */
function unreasonedDisables(root, strykerConfig, hunks) {
	/** @type {string[]} */
	const files = [];
	/** @type {Map<string, string>} */
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
			// #2727
			reportUnread(file, buildFaultText(e));
			continue;
		}
		if (!staged.includes(DISABLE_TEXT)) continue;
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
			// #2727
			headUnread.set(file, buildFaultText(e));
		}
	}
	if (files.length === 0) return [];
	const read = readCommentsInChild(root, strykerConfig, entries);
	if ("error" in read) {
		// #2366, #2727
		reportUnread(files.join(", "), read.error);
		return [];
	}
	const byId = read.files;
	return files.flatMap((file) => {
		const staged = byId[`:${file}`];
		if (staged === undefined || "error" in staged) {
			// #2366
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
 * @param {string[]} lines
 * @param {{start: {line: number, column: number}, end: {line: number, column: number}}} loc
 * @param {string} at
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

/** @param {string} tree */
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
 * @param {string|null} strykerConfig
 * @param {object} controlled
 */
function buildWrapperConfig(strykerConfig, controlled) {
	const base =
		strykerConfig === null
			? `const base = ${JSON.stringify(CORE_DEFAULT)};`
			: `import { loadStrykerConfig } from ${JSON.stringify(pathToFileURL(STRYKER_COMMENTS).href)};
const base = await loadStrykerConfig(${JSON.stringify(strykerConfig)});`;
	return `${base}
export default {
  disableTypeChecks: ${JSON.stringify(DISABLE_TYPE_CHECKS)},
  ...base,
  vitest: { pool: ${JSON.stringify(POOL)}, ...base.vitest },
  ...${JSON.stringify(controlled, null, 2)}
};
`;
}

/**
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
		// #1907
		if (caught(e).code !== "ENOENT")
			writeFd(
				2,
				`${voice.prefix}: the mutation hold could not read its cache at ${cache} (${caught(e).message}), so Stryker runs cold.\n`,
			);
		return null;
	}
}

/**
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
		// #1907
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
		// #1907
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
 * @param {object} run
 * @param {string} run.root
 * @param {string} run.work
 * @param {string[]} run.mutate
 * @param {string} run.tree
 * @param {Voice} run.voice
 * @returns {{red: string}|{failed: string}|{report: any}}
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
		`${shellQuote(stryker)} run ${shellQuote(configPath)}`,
	);
	writeBackCache(incremental, cache, seeded, voice);
	if (r.error !== null)
		throw new HoldFaultError("could not make a throwaway worktree", {
			detail: r.error.trim(),
		});
	const output = `${r.output}${r.spawnError ? `${r.spawnError.message}\n` : ""}`;
	const hostFault = output
		.split("\n")
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
 * @param {any} m
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
 * @param {unknown} c
 * @returns {c is number}
 */
const isColumn = (c) => Number.isInteger(c) && /** @type {number} */ (c) >= 1;

/**
 * #2250, #2318
 * @param {{start: {line: number, column?: unknown}, end: {line: number, column?: unknown}}} loc
 */
const isSpan = ({ start, end }) =>
	isColumn(start.column) &&
	isColumn(end.column) &&
	(end.line > start.line ||
		(end.line === start.line && end.column > start.column));

/**
 * @param {string} file
 * @param {any} entry
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
		// #2318
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
 * @param {any} report
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
 * @param {{red: string}|{failed: string}} run
 * @param {Voice} voice
 */
function buildUnjudgedRunText(run, voice) {
	return "red" in run
		? `${tail(run.red)}\n${voice.prefix}: the mutation hold's initial test run is RED ${voice.tree}, so ${voice.unjudged}.\n  Fix the failing tests and ${voice.again}.\n`
		: `${tail(run.failed)}\n${voice.prefix}: Stryker did not finish, so ${voice.unjudged}.\n  Fix what its output above names — a Stryker that will not start, or a config it refuses — and ${voice.again}.\n`;
}

const VERSION_PARTS = /^(\d+)\.(\d+)\.(\d+)/;
const VERIFIED_PARTS = STRYKER_VERSION.split(".").map(Number);

/** @param {string} text */
function parseOlderVersion(text) {
	let version;
	try {
		({ version } = JSON.parse(text));
	} catch {
		return null;
	}
	if (typeof version !== "string") return null;
	const got = VERSION_PARTS.exec(version)?.slice(1).map(Number);
	return got !== undefined && compareVersions(got, VERIFIED_PARTS) < 0
		? version
		: null;
}

/** @param {(name: string) => import("./lib/file-read.js").FileRead<string>} manifest */
function readStrykerInstalls(manifest) {
	/** @type {string[]} */
	const absent = [];
	/** @type {string[]} */
	const old = [];
	for (const name of STRYKER_PACKAGES) {
		const read = manifest(name);
		if (read.state === "absent") absent.push(name);
		else if (read.state === "read") {
			const version = parseOlderVersion(read.data);
			if (version !== null) old.push(`${name} ${version}`);
		}
	}
	return { absent, old };
}

/**
 * @param {string} root
 * @param {Voice} voice
 */
function missingToolRefusal(root, voice) {
	const modules = path.join(root, "node_modules");
	const manifest = (/** @type {string} */ name) =>
		readText(path.join(modules, name, "package.json"));
	const isMissing = (/** @type {string} */ name) =>
		manifest(name).state === "absent";
	const { absent, old } = readStrykerInstalls(manifest);
	const lines = [];
	if (absent.length > 0)
		lines.push(
			`${voice.prefix}: the mutation hold runs StrykerJS, and ${absent.join(" and ")} ${absent.length > 1 ? "are" : "is"} not installed in ${modules}, so ${voice.refused}.`,
		);
	if (old.length > 0)
		lines.push(
			`${voice.prefix}: the mutation hold needs StrykerJS ${STRYKER_VERSION} or later, and ${modules} holds ${old.join(" and ")}, so ${voice.refused}.`,
		);
	if (absent.length > 0 || old.length > 0)
		lines.push(
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

/** @param {string} body */
function refuse(body) {
	writeFd(
		2,
		`${body}\n${readRuleOrPointer()}\n\npre-commit: the mutation hold refused this commit (rule:mutation-hold). Nothing was committed.\n`,
	);
	return 1;
}

// #1906
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
		// #1912
		writeFd(
			2,
			`${SEED_VOICE.prefix}: ${faultOf(e).what}, so ${SEED_VOICE.unjudged}.\n`,
		);
		return 1;
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

/** @param {unknown} e */
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
 * #1871, #1910
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
