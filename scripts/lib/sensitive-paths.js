/*
 * sensitive-paths.js — which declared sensitive paths a set of changed paths
 * touches (#1617, spec #1612 §The declaration). The one matcher the review
 * escalation's later tickets are to read: the pre-commit hold, the skill-load
 * tier block, the Stop nag and the push warning.
 *
 * GLOBS MATCH AS `git diff -- ':(glob)<glob>'` DOES, through
 * lib/pathspec-glob.js, whose semantics this file's suite checks against git.
 *
 * RUN AS A SCRIPT it prints the match as JSON for the config in the working
 * directory's own tree (`ownTree()`), or with
 * `--names` the matched areas' names one per line, exit 0; a config warning
 * reaches stderr and never changes the exit. `--narrowed-from <rev>`, which
 * repeats, adds each area the declaration narrows from its copy at <rev>;
 * exit 3 is any copy not reading, the match printed as far as it could be
 * read and the fault on stderr. Exit 2 is a config that will not read, or bad
 * usage. heldAreas is the pre-commit hold's read of the areas it holds.
 */

const { readFdAll } = require("./read-fd.js");
const { CONFIG_PATH, readConfig } = require("./workflow-core-config.js");
const { globMatches } = require("./pathspec-glob.js");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

/** @typedef {import("./workflow-core-config.js").SensitivePath} SensitivePath */

/**
 * @typedef {Omit<SensitivePath, "globs"> & {paths: string[]}} TouchedSensitivePath
 *   `paths` are those its globs matched
 *
 * @typedef {object} Match
 * @property {"absent" | "none" | "declared"} state
 * @property {"standard" | "escalated"} tier `escalated` where any glob matched
 * @property {TouchedSensitivePath[]} matched
 * @property {Omit<SensitivePath, "globs">[]} globless every entry with no glob, whatever the paths, for a session to judge
 */

/** @param {SensitivePath[] | undefined} declared @returns {Match["state"]} */
function stateOf(declared) {
	if (declared === undefined) return "absent";
	return declared.length === 0 ? "none" : "declared";
}

/**
 * Which declared areas `paths` touch.
 * @param {SensitivePath[] | undefined} declared the config's `sensitivePaths`
 * @param {string[]} paths repo-relative; a path given twice is matched once
 * @returns {Match}
 */
function matchSensitivePaths(declared, paths) {
	/** @type {Match["matched"]} */
	const matched = [];
	/** @type {Match["globless"]} */
	const globless = [];
	const distinct = [...new Set(paths)];
	for (const { globs, ...entry } of declared ?? []) {
		if (globs.length === 0) {
			globless.push(entry);
			continue;
		}
		const hit = distinct.filter((p) => globs.some((g) => globMatches(g, p)));
		if (hit.length > 0) matched.push({ ...entry, paths: hit });
	}
	return {
		state: stateOf(declared),
		tier: matched.length > 0 ? "escalated" : "standard",
		matched,
		globless,
	};
}

/**
 * The areas `before` declares that `after` removes or takes a glob from. A
 * reworded glob reads as one taken, as nothing here can compare what two globs
 * match.
 * @param {SensitivePath[] | undefined} before
 * @param {SensitivePath[] | undefined} after
 * @returns {string[]} names
 */
function narrowedAreas(before, after) {
	const globsAfter = new Map((after ?? []).map((a) => [a.name, a.globs]));
	return (before ?? [])
		.filter(({ name, globs }) => {
			const kept = globsAfter.get(name);
			return kept === undefined || globs.some((g) => !kept.includes(g));
		})
		.map((a) => a.name);
}

/**
 * `match` plus each area `before` declares that `after` narrows, at the
 * escalated tier, where `paths` carry the declaration (#3905).
 * @param {Match} match
 * @param {SensitivePath[] | undefined} before
 * @param {SensitivePath[] | undefined} after
 * @param {string[]} paths
 * @returns {Match}
 */
function withNarrowing(match, before, after, paths) {
	if (!paths.includes(CONFIG_PATH)) return match;
	const narrowed = narrowedAreas(before, after);
	const added = (before ?? [])
		.filter(
			(a) =>
				narrowed.includes(a.name) &&
				!match.matched.some((m) => m.name === a.name),
		)
		.map(({ globs: _globs, ...area }) => ({ ...area, paths: [CONFIG_PATH] }));
	return added.length === 0
		? match
		: { ...match, tier: "escalated", matched: [...match.matched, ...added] };
}

/**
 * The areas the pre-commit hold holds `paths` under (#3905, #4512): those
 * either copy of the declaration matches, plus, where `paths` carry the
 * declaration itself, those `after` narrows from `before`, sorted and once
 * each. An `after` that will not read declares nothing, so a broken copy
 * reads as dropping every area; `fault` is then its read fault, for the
 * refusal to name. Not `judged` where `before` will not read, or `after`
 * will not and narrows nothing from `before`, `fault` saying why.
 * @param {() => SensitivePath[] | undefined} readBefore HEAD's declaration
 * @param {() => SensitivePath[] | undefined} readAfter the staged one
 * @param {string[]} paths
 * @returns {{ judged: boolean, areas: string[], fault: string }}
 */
function heldAreas(readBefore, readAfter, paths) {
	let declaredBefore;
	try {
		declaredBefore = readBefore();
	} catch (e) {
		return { judged: false, areas: [], fault: `BROKEN: ${caught(e).message}` };
	}
	/** @type {SensitivePath[] | undefined} */
	let declaredAfter;
	let fault = "";
	try {
		declaredAfter = readAfter();
	} catch (e) {
		fault = `BROKEN: ${caught(e).message}`;
	}
	const narrowed = paths.includes(CONFIG_PATH)
		? narrowedAreas(declaredBefore, declaredAfter)
		: [];
	if (fault && narrowed.length === 0)
		return { judged: false, areas: [], fault };
	const names = new Set([
		...matchSensitivePaths(declaredBefore, paths).matched.map((a) => a.name),
		...matchSensitivePaths(declaredAfter, paths).matched.map((a) => a.name),
		...narrowed,
	]);
	return { judged: true, areas: [...names].sort(), fault };
}

/**
 * `--narrowed-from`'s copies in `root`: `befores`, one per revision in
 * `since` that reads; `after` at `to`, else the working copy, read as
 * declaring nothing where it will not parse, as the hold reads it (#3905).
 * @param {string} root
 * @param {string[]} since
 * @param {string | true | undefined} to
 */
function readNarrowingCopies(root, since, to) {
	let fault = "";
	/** @type {(SensitivePath[] | undefined)[]} */
	const befores = [];
	for (const rev of since) {
		try {
			befores.push(readConfig({ root, rev, quiet: true }).sensitivePaths);
		} catch (e) {
			fault += `BROKEN: ${caught(e).message}\n`;
		}
	}
	/** @type {SensitivePath[] | undefined} */
	let after;
	try {
		after = readConfig({
			root,
			...(typeof to === "string" ? { rev: to } : {}),
			quiet: true,
		}).sensitivePaths;
	} catch (e) {
		fault += `BROKEN: ${caught(e).message}\n`;
	}
	return { befores, after, fault };
}

/**
 * The working directory's git top level, else the directory itself, as its
 * callers cd into the tree they diff: not `worktreeRoot()`, whose host answer
 * for a repository unrelated to the host would read the declaration at
 * revisions the caller took from its own tree (#4615).
 */
function ownTree() {
	const { gitTopLevel } = require("./host-root.js");
	try {
		return gitTopLevel(process.cwd());
	} catch {
		return process.cwd();
	}
}

/** @param {number} fd */
const readPaths = (fd) =>
	readFdAll(fd)
		.toString("utf8")
		.split(/[\n\0]/)
		.filter((l) => l !== "");

const USAGE =
	"usage: node sensitive-paths.js [--stdin] [--names] [--narrowed-from <rev>... [--narrowed-to <rev>]] [<path>...]\n" +
	"  The declared sensitive paths the given repo-relative paths touch, as JSON.\n" +
	"  --stdin  read further paths from stdin, one per line or NUL-separated;\n" +
	"           git quotes an unusual name, so pipe `git diff --name-only -z`\n" +
	"  --names  print only the names of the areas whose globs matched, one per line\n" +
	"  --narrowed-from <rev>  add each area the declaration narrows from its copy at <rev>,\n" +
	"           to the working copy in this directory's tree, or to its copy at --narrowed-to\n";

if (require.main === module) {
	const { parseOrExit } = require("./cli-args.js");
	const { flags, lists, positionals } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: {
			"--stdin": "boolean",
			"--names": "boolean",
			"--narrowed-from": "list",
			"--narrowed-to": "value",
		},
		max: Number.POSITIVE_INFINITY,
	});
	const paths = [...positionals];
	if (flags["--stdin"]) paths.push(...readPaths(0));
	const root = ownTree();
	let config;
	try {
		config = readConfig({ root });
	} catch (e) {
		writeFd(2, `BROKEN: ${caught(e).message}\n`);
		process.exit(2);
	}
	let match = matchSensitivePaths(config.sensitivePaths, paths);
	const since = lists["--narrowed-from"] ?? [];
	let fault = "";
	if (since.length > 0 && paths.includes(CONFIG_PATH)) {
		const copies = readNarrowingCopies(root, since, flags["--narrowed-to"]);
		fault = copies.fault;
		for (const before of copies.befores)
			match = withNarrowing(match, before, copies.after, paths);
	}
	writeFd(
		1,
		flags["--names"]
			? match.matched.map((a) => `${a.name}\n`).join("")
			: `${JSON.stringify(match, null, 2)}\n`,
	);
	if (fault) {
		writeFd(2, fault);
		process.exit(3);
	}
}

module.exports = { matchSensitivePaths, withNarrowing, heldAreas };
