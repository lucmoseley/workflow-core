const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");

class PackageReadError extends Error {
	/**
	 * @param {string} failure
	 * @param {{cause: unknown}} options
	 */
	constructor(failure, options) {
		const detail = caught(options.cause).message;
		super(
			`${failure}, so no command can be inferred from it — fix it: ${detail}`,
			options,
		);
		this.fault = `${failure} (${detail})`;
	}
}

/** @typedef {ReturnType<typeof buildPackageReader>} PackageReader */

function buildPackageReader() {
	/** @type {Map<string, ReturnType<typeof readPackage>>} */
	const read = new Map();
	return (/** @type {string} */ dir) => {
		const pkg = read.get(dir) ?? readPackage(dir);
		read.set(dir, pkg);
		return pkg;
	};
}

// #3851
const ABSENT_FILE_CODES = new Set(["ENOENT", "ENOTDIR", "ENAMETOOLONG"]);

/** @param {unknown} err */
const isAbsentFile = (err) =>
	err instanceof Error &&
	"code" in err &&
	ABSENT_FILE_CODES.has(String(err.code));

/**
 * @param {string} file
 * @param {unknown} err
 */
function throwUnlessAbsent(file, err) {
	if (!isAbsentFile(err))
		throw new PackageReadError(`${file} cannot be read`, { cause: err });
}

const MAPPED_SECTIONS = ["dependencies", "devDependencies"];
const EVIDENT_SECTIONS = [
	...MAPPED_SECTIONS,
	"peerDependencies",
	"optionalDependencies",
];

/** @param {string} dir */
function nameFromFolder(dir) {
	const parent = path.basename(path.dirname(dir));
	const base = path.basename(dir);
	return parent.startsWith("@") ? `${parent}/${base}` : base;
}

/** @param {string} root */
function readPackage(root) {
	const file = path.join(root, "package.json");
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		throwUnlessAbsent(file, err);
		return {
			name: nameFromFolder(root),
			scripts: {},
			workspaces: [],
			biome: false,
			biomeEvident: false,
		};
	}
	let pkg;
	try {
		// #4042
		pkg = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch (err) {
		throw new PackageReadError(`${file} does not parse`, { cause: err });
	}
	const scripts =
		pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
	/** @param {string[]} sections */
	const hasBiomeIn = (sections) =>
		sections.some((k) => typeof pkg?.[k]?.["@biomejs/biome"] === "string");
	const workspaces = Array.isArray(pkg?.workspaces?.packages)
		? pkg.workspaces.packages
		: pkg?.workspaces;
	return {
		name:
			typeof pkg?.name === "string" && pkg.name
				? pkg.name
				: nameFromFolder(root),
		scripts,
		/** @type {string[]} */
		workspaces: Array.isArray(workspaces)
			? workspaces.filter((p) => typeof p === "string")
			: [],
		biome: hasBiomeIn(MAPPED_SECTIONS),
		biomeEvident:
			hasBiomeIn(EVIDENT_SECTIONS) ||
			Object.values(scripts).some(
				(s) => typeof s === "string" && s.includes("biome"),
			),
	};
}

/** @param {string} dir */
function hasPackage(dir) {
	const file = path.join(dir, "package.json");
	try {
		fs.statSync(file);
		return true;
	} catch (err) {
		throwUnlessAbsent(file, err);
		return false;
	}
}

/**
 * @param {string} dir
 * @param {string} root
 */
function findPackageDir(dir, root) {
	for (let d = dir; ; d = path.dirname(d)) {
		if (hasPackage(d)) return d;
		if (d === root || d === path.dirname(d)) return dir;
	}
}

/** @typedef {{ root: string, readCachedPackage: PackageReader }} PackageTree */

/**
 * @param {string} root
 * @returns {PackageTree}
 */
const buildPackageTree = (root) => ({
	root: path.resolve(root),
	readCachedPackage: buildPackageReader(),
});

module.exports = {
	PackageReadError,
	buildPackageTree,
	readPackage,
	findPackageDir,
	hasPackage,
};
