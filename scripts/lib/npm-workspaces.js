/*
 * npm-workspaces.js — which directories npm's workspace selectors run a script
 * in (workflow-core#4041), as npm 11.16.0's `get-workspaces.js` and `@npmcli/map-workspaces`
 * find them. A selector replaces the directory a script runs in, so a check_staged
 * reached through one is judged on the wrong `package.json` unless they are read
 * the same way.
 */

const fs = require("node:fs");
const path = require("node:path");
const { NEEDS_NODE } = require("./biome-allowlist.js");
const { findPackageDir, hasPackage } = require("./package-reader.js");
const { trimEndRun } = require("./trim-run.js");

/** @typedef {import("./package-reader.js").PackageReader} PackageReader */
/** @typedef {{filters: string[], all: boolean, withRoot: boolean,
 *  noAncestors: boolean}} Selection `filters` each `-w`'s value, which outrank
 *  `all`; `all` `-ws`; `withRoot` `-iwr`, which adds the root; `noAncestors`
 *  where `--prefix` or `--no-workspaces` stops npm looking above for a root. */
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
 * @param {string} prefix the directory `--prefix` names, or ""
 * @returns {Selection|undefined}
 */
function parseSelection(options, prefix) {
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
	return filters.length > 0 || all || (withRoot && all !== false)
		? {
				filters,
				all: all === true,
				withRoot,
				noAncestors: prefix !== "" || all === false,
			}
		: undefined;
}

const NODE_MODULES = "node_modules";

/** Whether a workspaces pattern is the directory it is written in, which
 * Node's glob never returns and npm's does.
 * @param {string} pattern */
const isOwnDir = (pattern) =>
	/^[./]*$/.test(pattern) && !pattern.includes("..");

/* A filter npm answers nothing for, where others answer, selects nothing only if
 * it can be read as no member: a plain name or scoped name, as `./` or `a/..` may
 * reach any, and in a list this read cannot undercount. Node's glob, unlike npm's,
 * takes no symlink past a glob's segment and no `.` in a brace (workflow-core#4069). */
const PLAIN_FILTER = /^(?:@[\w.-]+\/)?[\w-][\w.-]*$/;
/* The run after a wildcard stops at the next one, as a match from there
 * reaches the same `/`: each character is read once (workflow-core#4109). */
const MAY_UNDERCOUNT = /\{|\*\*|[*?[][^*?[/\n\r\u2028\u2029]*\//;

/**
 * The directories `patterns` match under `cwd`, none in `node_modules`, which
 * npm ignores: `exclude` only stops the walk descending, as `*` still returns it.
 * @param {string[]} patterns
 * @param {string} cwd
 */
function globDirs(patterns, cwd) {
	/* @types/node 20 predates it. Read here, not at load, so a row can stand in a
	 * Node without it. */
	const globSync =
		/** @type {((patterns: string[], options: {cwd: string, exclude: (name: string) => boolean}) => string[])|undefined} */ (
			/** @type {any} */ (fs).globSync
		);
	if (!globSync) throw new Error(NEEDS_NODE);
	const found = globSync(
		patterns.filter((p) => !isOwnDir(p)),
		{ cwd, exclude: (n) => n === NODE_MODULES },
	)
		.filter((m) => !m.split(path.sep).includes(NODE_MODULES))
		.map((m) => path.resolve(cwd, m));
	return patterns.some(isOwnDir) ? [cwd, ...found] : found;
}

/** @param {string} word */
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
		const pattern = trimEndRun(
			written.slice(bangs).replace(/^\.?\/+/, ""),
			"/",
		);
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
 * @param {boolean} noAncestors
 * @param {PackageReader} read
 */
function findWorkspaceRoot(own, root, noAncestors, read) {
	const list = (/** @type {string} */ d) =>
		listMembers(d, read(d).workspaces, read);
	for (let d = own; !noAncestors && d !== root && d !== path.dirname(d); ) {
		d = path.dirname(d);
		const members = list(d);
		if (members.some((m) => m.dir === own)) return { dir: d, members };
	}
	const members = list(own);
	return members.length > 0 ? { dir: own, members } : undefined;
}

/**
 * Whether `filter`, written in `from`, selects `member`: by name, by directory,
 * or as the parent of its directory. Node's glob is npm's minimatch with negation
 * off.
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
 * The directories `selection` runs a script in from `from`, the members it chose
 * among, and whether it may reach more, or none, which makes npm fail. Inside a
 * member, no filter is that member alone; `-iwr` alone at the root runs the root.
 * @param {Selection} selection
 * @param {string} from the directory the run starts in
 * @param {string} root
 * @param {PackageReader} read
 * @returns {{dirs: string[], members: string[], unresolved: boolean}}
 */
function resolveSelection(
	{ filters, all, withRoot, noAncestors },
	from,
	root,
	read,
) {
	if (!path.matchesGlob) throw new Error(NEEDS_NODE);
	const own = findPackageDir(from, root);
	const found = findWorkspaceRoot(own, root, noAncestors, read);
	const listed = found?.members ?? [];
	const members = listed.map((m) => m.dir);
	const hits = (/** @type {string} */ filter) =>
		listed.filter((m) => isSelected(filter, m, from));
	const unfiltered = () => {
		if (found && found.dir !== own) return [own];
		return all ? members : [];
	};
	const chosen =
		filters.length > 0 ? filters.flatMap(hits).map((m) => m.dir) : unfiltered();
	const dirs = [
		...new Set([...(withRoot ? [found?.dir ?? own] : []), ...chosen]),
	];
	const undercounts =
		found !== undefined &&
		read(found.dir).workspaces.some((p) => MAY_UNDERCOUNT.test(p));
	const mayReachMore = (/** @type {string} */ filter) =>
		filter !== "" &&
		hits(filter).length === 0 &&
		(undercounts || !PLAIN_FILTER.test(filter));
	return {
		dirs,
		members,
		unresolved: dirs.length === 0 || filters.some(mayReachMore),
	};
}

module.exports = { parseSelection, resolveSelection };
