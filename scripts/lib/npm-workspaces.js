/*
 * npm-workspaces.js — which directories npm's workspace selectors run a script
 * in (#4041), as npm 11.16.0's `get-workspaces.js` and `@npmcli/map-workspaces`
 * find them. A selector replaces the directory a script runs in, so a check_staged
 * reached through one is judged on the wrong `package.json` unless they are read
 * the same way.
 */

const fs = require("node:fs");
const path = require("node:path");
const { findPackageDir, hasPackage } = require("./package-reader.js");

/** @typedef {import("./package-reader.js").PackageReader} PackageReader */
/** @typedef {{filters: string[], withRoot: boolean, ownRoot: boolean}} Selection
 *  `filters` each `-w`'s value, which outranks `-ws`, no filters; `withRoot`
 *  `-iwr`, which only adds to a selection; `ownRoot` where `--prefix` or
 *  `--no-workspaces` stops npm looking above for a root. */
/** @typedef {{dir: string, name: string}} Member */

/* `--no-workspace web` selects web and a bare one selects nothing, as a bare
 * `--workspace` does. */
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
	const prefix = parsed.findLast(({ flag }) => flag === "--prefix")?.value;
	return filters.length > 0 || all
		? {
				filters,
				withRoot: lastOn(ROOT_FLAGS) === true,
				ownRoot: Boolean(prefix) || all === false,
			}
		: undefined;
}

/* @types/node 20 predates it. Needs Node 22, and `path.matchesGlob` 22.5: on an
 * older one a selector throws, which the hook's check reads as a refusal. */
/** @type {(patterns: string[], options: {cwd: string, exclude: (name: string) => boolean}) => string[]} */
const globSync = /** @type {any} */ (fs).globSync;

const NODE_MODULES = "node_modules";

/**
 * The directories `patterns` match under `cwd`, none in `node_modules`, which
 * npm ignores: `exclude` only stops the walk descending, as `*` still returns it.
 * @param {string[]} patterns
 * @param {string} cwd
 */
const globDirs = (patterns, cwd) =>
	globSync(patterns, { cwd, exclude: (n) => n === NODE_MODULES })
		.filter((m) => !m.split(path.sep).includes(NODE_MODULES))
		.map((m) => path.resolve(cwd, m));

/**
 * The members `patterns` declare in `dir`. A negated pattern is dropped by a
 * later one it matches, so that later one is kept.
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
		const bangs = written.match(/^!+/)?.[0].length ?? 0;
		const pattern = written.slice(bangs).replace(/^\.?\/+/, "");
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
 * or as the parent of its directory.
 * @param {string} filter
 * @param {Member} member
 * @param {string} from
 */
function isSelected(filter, member, from) {
	const parent = path.posix.normalize(filter).replace(/\/$/, "");
	return (
		filter === member.name ||
		path.resolve(from, filter) === member.dir ||
		path.matchesGlob(path.relative(from, member.dir), `${parent}/*`)
	);
}

/**
 * The directories `selection` runs a script in from `from`, and whether a filter
 * selects nothing or `-ws` finds no member. Inside a member, `-ws` is that member
 * alone.
 * @param {Selection} selection
 * @param {string} from the directory the run starts in
 * @param {string} root
 * @param {PackageReader} read
 * @returns {{dirs: string[], unresolved: boolean}}
 */
function resolveSelection({ filters, withRoot, ownRoot }, from, root, read) {
	const own = findPackageDir(from, root);
	const found = findWorkspaceRoot(own, root, ownRoot, read);
	const members = found?.members ?? [];
	const hits = (/** @type {string} */ filter) =>
		members.filter((m) => isSelected(filter, m, from));
	const all = found?.dir === own ? members.map((m) => m.dir) : [own];
	const chosen =
		filters.length > 0 ? filters.flatMap(hits).map((m) => m.dir) : all;
	return {
		dirs:
			found || withRoot
				? [...new Set([...(withRoot ? [found?.dir ?? own] : []), ...chosen])]
				: [],
		unresolved:
			filters.length > 0
				? filters.some((f) => hits(f).length === 0)
				: found === undefined,
	};
}

module.exports = { parseSelection, resolveSelection };
