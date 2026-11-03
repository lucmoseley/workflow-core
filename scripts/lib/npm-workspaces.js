/*
 * npm-workspaces.js — which directories npm's workspace selectors run a script
 * in (#4041), as npm 11.16.0's `get-workspaces.js` and `@npmcli/map-workspaces`
 * find them. A selector replaces the directory a script runs in, so a check_staged
 * reached through one is judged on the wrong `package.json` unless they are read
 * the same way.
 */

const fs = require("node:fs");
const path = require("node:path");
const { BIOME_STAGED_COMMAND } = require("./biome-allowlist.js");
const { findPackageDir, hasPackage } = require("./package-reader.js");

/** @typedef {import("./package-reader.js").PackageReader} PackageReader */
/** @typedef {{filters: string[], all: boolean, withRoot: boolean, ownRoot:
 *  boolean}} Selection `filters` each `-w`'s value, which outranks `all`, `-ws`;
 *  `withRoot` `-iwr`, which adds the root; `ownRoot` where `--prefix` or
 *  `--no-workspaces` stops npm looking above for a root. */
/** @typedef {{dir: string, name: string}} Member */

/* `--no-workspace web` selects web and a bare one selects nothing, as a bare
 * `--workspace` does, inside a member too. */
const FILTER_FLAGS = new Set(["--workspace", "--no-workspace"]);
const ALL_FLAGS = new Set(["--workspaces", "--no-workspaces"]);
const ROOT_FLAGS = new Set([
	"--include-workspace-root",
	"--no-include-workspace-root",
]);

/**
 * Whether a Boolean option is on: `--no-x=false` is, and a null is off.
 * @param {string} flag
 * @param {string|undefined} value
 */
const isOn = (flag, value) =>
	flag.startsWith("--no-")
		? value === "false"
		: value !== "false" && value !== "null";

/**
 * The selection npm's options make, a Boolean's last spelling winning, or
 * undefined for none.
 * @param {string[]} options npm's, as `npmCanon` writes them
 * @returns {Selection|undefined}
 */
function parseSelection(options) {
	const parsed = options.map((option) => {
		const eq = option.indexOf("=");
		return eq < 0
			? { flag: option, value: undefined }
			: { flag: option.slice(0, eq), value: option.slice(eq + 1) };
	});
	const lastOn = (/** @type {Set<string>} */ flags) => {
		const last = parsed.findLast(({ flag }) => flags.has(flag));
		return last && isOn(last.flag, last.value);
	};
	const filters = parsed
		.filter(({ flag }) => FILTER_FLAGS.has(flag))
		.map(({ value }) => value ?? "");
	const all = lastOn(ALL_FLAGS);
	const withRoot = lastOn(ROOT_FLAGS) === true;
	const prefix = parsed.findLast(({ flag }) => flag === "--prefix")?.value;
	return filters.length > 0 || all || (withRoot && all !== false)
		? {
				filters,
				all: all === true,
				withRoot,
				ownRoot: Boolean(prefix) || all === false,
			}
		: undefined;
}

/* @types/node 20 predates it. Read at each call, as a Node without it refuses
 * only a selector. */
/** @typedef {(patterns: string[], options: {cwd: string, exclude: (name: string) => boolean}) => string[]} GlobSync */
const readGlobSync = () =>
	/** @type {GlobSync|undefined} */ (/** @type {any} */ (fs).globSync);

/* What Node 22.5 first has both of. The hook's check reads this throw as a
 * refusal, printing the message. */
const NEEDS_NODE = `Reading an npm workspace selector needs Node 22.5, and this is ${process.version}. Upgrade Node, declare check_staged as an explicit '${BIOME_STAGED_COMMAND} <flags>' whose flags you own, or, where it never runs Biome, as a shell file (sh ./your-gate.sh) holding the command`;

const NODE_MODULES = "node_modules";

/** Whether a workspaces pattern is the directory it is written in, which
 * Node's glob never returns and npm's does.
 * @param {string} pattern */
const isOwnDir = (pattern) => path.posix.normalize(pattern) === ".";

/**
 * The directories `patterns` match under `cwd`, none in `node_modules`, which
 * npm ignores: `exclude` only stops the walk descending, as `*` still returns it.
 * @param {string[]} patterns
 * @param {string} cwd
 */
function globDirs(patterns, cwd) {
	const globSync = readGlobSync();
	if (!globSync) throw new Error(NEEDS_NODE);
	const found = globSync(
		patterns.filter((p) => !isOwnDir(p)),
		{ cwd, exclude: (n) => n === NODE_MODULES },
	)
		.filter((m) => !m.split(path.sep).includes(NODE_MODULES))
		.map((m) => path.resolve(cwd, m));
	return patterns.some(isOwnDir) ? [cwd, ...found] : found;
}

/** The count of `!`s `word` opens with, an odd one negating it.
 * @param {string} word */
const countBangs = (word) => word.match(/^!+/)?.[0].length ?? 0;

/**
 * The members `patterns` declare in `dir`. A negated pattern is dropped by a
 * later one it matches, so that later one is kept. npm's glob ends each pattern
 * in a `/`, which takes a symlink to a directory; Node's takes one only without.
 * @param {string} dir
 * @param {string[]} patterns
 * @param {PackageReader} read
 * @returns {Member[]}
 */
function listMembers(dir, patterns, read) {
	/** @type {string[]} */
	const included = [];
	/** @type {string[]} */
	let negated = [];
	for (const written of patterns) {
		const bangs = countBangs(written);
		const pattern = written
			.slice(bangs)
			.replace(/^\.?\/+/, "")
			.replace(/\/+$/, "");
		if (bangs % 2 === 1) negated.push(pattern);
		else {
			negated = negated.filter((n) => !path.matchesGlob(pattern, n));
			included.push(pattern);
		}
	}
	const cut = new Set(globDirs(negated, dir));
	const dirs = new Set(globDirs(included, dir).filter((d) => !cut.has(d)));
	return [...dirs]
		.filter(hasPackage)
		.map((d) => ({ dir: d, name: read(d).name }));
}

/**
 * The workspace root npm works from at `own`, as its `loadLocalPrefix` finds it:
 * the nearest ancestor up to `root` with `own` a member, else `own` where it
 * declares workspaces.
 * @param {string} own
 * @param {string} root
 * @param {boolean} ownRoot looks at no ancestor
 * @param {PackageReader} read
 */
function findWorkspaceRoot(own, root, ownRoot, read) {
	const list = (/** @type {string} */ d) =>
		listMembers(d, read(d).workspaces, read);
	for (let d = own; !ownRoot && d !== root && d !== path.dirname(d); ) {
		d = path.dirname(d);
		const members = list(d);
		if (members.some((m) => m.dir === own)) return { dir: d, members };
	}
	const members = list(own);
	return members.length > 0 ? { dir: own, members } : undefined;
}

/**
 * Whether `filter`, written in `from`, selects `member`: by name, by directory,
 * or as the parent of its directory, a negated one as what is not. Node's glob
 * is npm's minimatch with negation off.
 * @param {string} filter
 * @param {Member} member
 * @param {string} from
 */
function isSelected(filter, member, from) {
	if (!filter) return false;
	const bangs = countBangs(filter);
	const parent = path.posix.normalize(filter.slice(bangs)).replace(/\/$/, "");
	const under = path.matchesGlob(
		path.relative(from, member.dir),
		`${parent}/*`,
	);
	return (
		filter === member.name ||
		path.resolve(from, filter) === member.dir ||
		(bangs % 2 === 1 ? !under : under)
	);
}

/**
 * The directories `selection` runs a script in from `from`, where none makes npm
 * fail, and the members it chose among. Inside a member, no filter is that member
 * alone; `-iwr` alone at the root runs the root.
 * @param {Selection} selection
 * @param {string} from the directory the run starts in
 * @param {string} root
 * @param {PackageReader} read
 * @returns {{dirs: string[], members: string[]}}
 */
function resolveSelection(
	{ filters, all, withRoot, ownRoot },
	from,
	root,
	read,
) {
	if (!path.matchesGlob) throw new Error(NEEDS_NODE);
	const own = findPackageDir(from, root);
	const found = findWorkspaceRoot(own, root, ownRoot, read);
	const members = (found?.members ?? []).map((m) => m.dir);
	const hits = (/** @type {string} */ filter) =>
		(found?.members ?? []).filter((m) => isSelected(filter, m, from));
	const unfiltered = () => {
		if (found && found.dir !== own) return [own];
		return all ? members : [];
	};
	const chosen =
		filters.length > 0 ? filters.flatMap(hits).map((m) => m.dir) : unfiltered();
	return {
		dirs: [...new Set([...(withRoot ? [found?.dir ?? own] : []), ...chosen])],
		members,
	};
}

module.exports = { parseSelection, resolveSelection };
