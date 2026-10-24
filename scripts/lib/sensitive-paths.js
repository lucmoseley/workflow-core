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
 * reaches stderr and never changes the exit. Exit 2 is a
 * config that will not read, or bad usage.
 */

const fs = require("node:fs");
const { readConfig } = require("./workflow-core-config.js");
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

const USAGE =
	"usage: node sensitive-paths.js [--stdin] [--names] [<path>...]\n" +
	"  The declared sensitive paths the given repo-relative paths touch, as JSON.\n" +
	"  --stdin  read further paths from stdin, one per line or NUL-separated;\n" +
	"           git quotes an unusual name, so pipe `git diff --name-only -z`\n" +
	"  --names  print only the names of the areas whose globs matched, one per line\n";

if (require.main === module) {
	const { parseOrExit } = require("./cli-args.js");
	const { flags, positionals } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: { "--stdin": "boolean", "--names": "boolean" },
		max: Number.POSITIVE_INFINITY,
	});
	const paths = [...positionals];
	if (flags["--stdin"])
		paths.push(
			...fs
				.readFileSync(0, "utf8")
				.split(/[\n\0]/)
				.filter((l) => l !== ""),
		);
	let config;
	try {
		config = readConfig();
	} catch (e) {
		writeFd(2, `BROKEN: ${caught(e).message}\n`);
		process.exit(2);
	}
	const match = matchSensitivePaths(config.sensitivePaths, paths);
	writeFd(
		1,
		flags["--names"]
			? match.matched.map((a) => `${a.name}\n`).join("")
			: `${JSON.stringify(match, null, 2)}\n`,
	);
}

module.exports = { matchSensitivePaths };
