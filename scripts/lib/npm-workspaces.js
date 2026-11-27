const fs = require("node:fs");
const path = require("node:path");
const { NEEDS_NODE } = require("./biome-allowlist.js");
const { findPackageDir, hasPackage } = require("./package-reader.js");
const { trimEndRun } = require("./trim-run.js");

/** @typedef {import("./package-reader.js").PackageReader} PackageReader */
/** @typedef {import("./package-reader.js").PackageTree} PackageTree */
/**
 * @typedef {{filters: string[], all: boolean, withRoot: boolean,
 *  noAncestors: boolean}} Selection
 */
/** @typedef {{dir: string, name: string}} Member */

const FILTER_FLAGS = new Set(["--workspace", "--no-workspace"]);
const ALL_FLAGS = new Set(["--workspaces", "--no-workspaces"]);
const ROOT_FLAGS = new Set([
	"--include-workspace-root",
	"--no-include-workspace-root",
]);

/**
 * @param {string} flag
 * @param {string|undefined} value
 */
const isOn = (flag, value) =>
	flag.startsWith("--no-")
		? value === "false"
		: value !== "false" && value !== "null";

/**
 * @param {string[]} options
 * @param {string} prefix
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

/**
 * @param {string} pattern
 */
const isOwnDir = (pattern) =>
	/^[./]*$/.test(pattern) && !pattern.includes("..");

const PLAIN_FILTER = /^(?:@[\w.-]+\/)?[\w-][\w.-]*$/;
const MAY_UNDERCOUNT = /\{|\*\*|[*?[][^*?[/\n\r\u2028\u2029]*\//;

/**
 * @param {string[]} patterns
 * @param {string} cwd
 */
function globDirs(patterns, cwd) {
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
 * @param {string} own
 * @param {boolean} noAncestors
 * @param {PackageTree} tree
 */
function findWorkspaceRoot(
	own,
	noAncestors,
	{ root, readCachedPackage: read },
) {
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
 * @param {Selection} selection
 * @param {string} from
 * @param {PackageTree} tree
 * @returns {{dirs: string[], members: string[], unresolved: boolean}}
 */
function resolveSelection({ filters, all, withRoot, noAncestors }, from, tree) {
	if (!path.matchesGlob) throw new Error(NEEDS_NODE);
	const own = findPackageDir(from, tree.root);
	const found = findWorkspaceRoot(own, noAncestors, tree);
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
		tree
			.readCachedPackage(found.dir)
			.workspaces.some((p) => MAY_UNDERCOUNT.test(p));
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
