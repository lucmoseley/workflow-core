const { readFdAll } = require("./read-fd.js");
const { CONFIG_PATH, readConfig } = require("./workflow-core-config.js");
const { globMatches } = require("./pathspec-glob.js");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

/** @typedef {import("./workflow-core-config.js").SensitivePath} SensitivePath */

/**
 * @typedef {Omit<SensitivePath, "globs"> & {paths: string[]}} TouchedSensitivePath
 * @typedef {object} Match
 * @property {"absent" | "none" | "declared"} state
 * @property {"standard" | "escalated"} tier
 * @property {TouchedSensitivePath[]} matched
 * @property {Omit<SensitivePath, "globs">[]} globless
 */

/** @param {SensitivePath[] | undefined} declared @returns {Match["state"]} */
function stateOf(declared) {
	if (declared === undefined) return "absent";
	return declared.length === 0 ? "none" : "declared";
}

/**
 * @param {SensitivePath[] | undefined} declared
 * @param {string[]} paths
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
 * @param {SensitivePath[] | undefined} before
 * @param {SensitivePath[] | undefined} after
 * @returns {string[]}
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
 * @param {() => SensitivePath[] | undefined} readBefore
 * @param {() => SensitivePath[] | undefined} readAfter
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
