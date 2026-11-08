/*
 * sensitive-paths.js — which declared sensitive paths a set of changed paths
 * touches (#1617, spec #1612 §The declaration). The one matcher the review
 * escalation's later tickets are to read: the pre-commit hold, the skill-load
 * tier block, the Stop nag and the push warning.
 *
 * GLOBS MATCH AS `git diff -- ':(glob)<glob>'` DOES, through
 * lib/pathspec-glob.js, whose semantics this file's suite checks against git.
 *
 * RUN AS A SCRIPT it prints the match as JSON for the host's config, or with
 * `--names` the matched areas' names one per line, exit 0; a config warning
 * reaches stderr and never changes the exit. `--narrowed-from <rev>` adds each
 * area the declaration narrows from its copy at <rev>; exit 3 is that copy
 * not reading, the match printed without it and the fault on stderr. Exit 2
 * is a config that will not read, or bad usage. `--held <before> <after>` prints
 * every area the pre-commit hold reads off two roots' configs at once, so the
 * hold starts node once a commit (#4512): exit 0, or 3 with the after copy's
 * fault on stderr; exit 2 where it cannot judge.
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
	const now = new Map((after ?? []).map((a) => [a.name, a.globs]));
	return (before ?? [])
		.filter(({ name, globs }) => {
			const kept = now.get(name);
			return kept === undefined || globs.some((g) => !kept.includes(g));
		})
		.map((a) => a.name);
}

/**
 * `match` plus each area `before` declares that `after` narrows, where `paths`
 * carry the declaration: the review hold refuses a narrowing under the area's
 * name whatever else the change touches (#3905), so it owes the escalated tier.
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
 * `--held`: the areas the pre-commit hold holds `paths` under — those
 * `before`'s declaration matches, those `after`'s does, and, where `paths`
 * carry the declaration itself, those `after` narrows from `before`, sorted
 * and once each. An `after` that will not parse declares nothing, so a broken
 * copy reads as dropping every area (#3905); where the paths do not carry it,
 * or `before` declares nothing to drop, the hold cannot judge it: exit 2.
 * Exit 3: the areas printed, and the `after` copy's fault on stderr for the
 * refusal to name.
 * @param {string} before
 * @param {string} after
 * @param {string[]} paths
 */
function printHeld(before, after, paths) {
	let was;
	try {
		was = readConfig({ root: before, quiet: true }).sensitivePaths;
	} catch (e) {
		writeFd(2, `BROKEN: ${caught(e).message}\n`);
		process.exit(2);
	}
	/** @type {SensitivePath[] | undefined} */
	let now;
	let fault = "";
	try {
		now = readConfig({ root: after, quiet: true }).sensitivePaths;
	} catch (e) {
		fault = `BROKEN: ${caught(e).message}\n`;
	}
	const narrowed = paths.includes(CONFIG_PATH) ? narrowedAreas(was, now) : [];
	if (fault && narrowed.length === 0) {
		writeFd(2, fault);
		process.exit(2);
	}
	const names = new Set([
		...matchSensitivePaths(was, paths).matched.map((a) => a.name),
		...matchSensitivePaths(now, paths).matched.map((a) => a.name),
		...narrowed,
	]);
	writeFd(
		1,
		[...names]
			.sort()
			.map((n) => `${n}\n`)
			.join(""),
	);
	if (fault) {
		writeFd(2, fault);
		process.exit(3);
	}
}

/** @param {number} fd */
const readPaths = (fd) =>
	readFdAll(fd)
		.toString("utf8")
		.split(/[\n\0]/)
		.filter((l) => l !== "");

const USAGE =
	"usage: node sensitive-paths.js [--stdin] [--names] [--narrowed-from <rev>] [<path>...]\n" +
	"       node sensitive-paths.js --held <before root> <after root>\n" +
	"  The declared sensitive paths the given repo-relative paths touch, as JSON.\n" +
	"  --stdin  read further paths from stdin, one per line or NUL-separated;\n" +
	"           git quotes an unusual name, so pipe `git diff --name-only -z`\n" +
	"  --names  print only the names of the areas whose globs matched, one per line\n" +
	"  --narrowed-from <rev>  add each area the declaration narrows from its copy at <rev>\n" +
	"  --held   the areas the pre-commit hold holds stdin's paths under, one per line\n";

if (require.main === module) {
	const { parseOrExit } = require("./cli-args.js");
	const { flags, positionals } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: {
			"--stdin": "boolean",
			"--names": "boolean",
			"--held": "boolean",
			"--narrowed-from": "value",
		},
		max: Number.POSITIVE_INFINITY,
	});
	if (flags["--held"]) {
		const [before, after] = positionals;
		if (before === undefined || after === undefined) {
			writeFd(2, USAGE);
			process.exit(2);
		}
		printHeld(before, after, readPaths(0));
		process.exit(0);
	}
	const paths = [...positionals];
	if (flags["--stdin"]) paths.push(...readPaths(0));
	let config;
	try {
		config = readConfig();
	} catch (e) {
		writeFd(2, `BROKEN: ${caught(e).message}\n`);
		process.exit(2);
	}
	let match = matchSensitivePaths(config.sensitivePaths, paths);
	const since = flags["--narrowed-from"];
	let fault = "";
	if (typeof since === "string" && paths.includes(CONFIG_PATH)) {
		try {
			const was = readConfig({ rev: since, quiet: true }).sensitivePaths;
			match = withNarrowing(match, was, config.sensitivePaths, paths);
		} catch (e) {
			fault = `BROKEN: ${caught(e).message}\n`;
		}
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

module.exports = { matchSensitivePaths, narrowedAreas, withNarrowing };
