/*
 * package-reader.js — a directory's `package.json` (#3947): its scripts and
 * whether it declares Biome, and which directory a runner finds it in. A file
 * that cannot be read or does not parse throws, as it shows no absence of a
 * script or of Biome.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");

/** `package.json` cannot be read or does not parse. The message is init's way
 * out; `fault` names the file and the failure, for a caller whose way out
 * differs (#3192). */
class PackageReadError extends Error {
	/**
	 * @param {string} failure the file, then "does not parse" or "cannot be read"
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

/** A `readPackage` that reads each directory at its first call and keeps it. */
function buildPackageReader() {
	/** @type {Map<string, ReturnType<typeof readPackage>>} */
	const read = new Map();
	return (/** @type {string} */ dir) => {
		const pkg = read.get(dir) ?? readPackage(dir);
		read.set(dir, pkg);
		return pkg;
	};
}

/* A word read as a directory may be no path at all. */
const ABSENT_FILE_CODES = new Set(["ENOENT", "ENOTDIR", "ENAMETOOLONG"]);

/** @param {unknown} err */
const isAbsentFile = (err) =>
	err instanceof Error &&
	"code" in err &&
	ABSENT_FILE_CODES.has(String(err.code));

/**
 * @param {string} file
 * @param {unknown} err from reading `file`
 */
function throwUnlessAbsent(file, err) {
	if (!isAbsentFile(err))
		throw new PackageReadError(`${file} cannot be read`, { cause: err });
}

/* The sections a mapped command may rest on, as biome-staged.js needs the
 * binary installed (#2731), which a peer or optional dependency may not be. */
const MAPPED_SECTIONS = ["dependencies", "devDependencies"];
/* Any section shows the repo uses Biome, enough to refuse what cannot be read
 * but not to map (#3851). */
const EVIDENT_SECTIONS = [
	...MAPPED_SECTIONS,
	"peerDependencies",
	"optionalDependencies",
];

/**
 * Throws a PackageReadError on a `package.json` that cannot be read or does
 * not parse, which would otherwise read as one naming no script.
 * @param {string} root
 */
function readPackage(root) {
	const file = path.join(root, "package.json");
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		throwUnlessAbsent(file, err);
		return { scripts: {}, biome: false, biomeEvident: false };
	}
	let pkg;
	try {
		pkg = JSON.parse(text);
	} catch (err) {
		throw new PackageReadError(`${file} does not parse`, { cause: err });
	}
	const scripts =
		pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
	/** @param {string[]} sections */
	const hasBiomeIn = (sections) =>
		sections.some((k) => typeof pkg?.[k]?.["@biomejs/biome"] === "string");
	return {
		scripts,
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
 * `dir`, or its nearest ancestor up to `root` holding a `package.json`, where a
 * runner finds it.
 * @param {string} dir
 * @param {string} root
 */
function findPackageDir(dir, root) {
	for (let d = dir; ; d = path.dirname(d)) {
		if (hasPackage(d)) return d;
		if (d === root || d === path.dirname(d)) return dir;
	}
}

module.exports = {
	PackageReadError,
	buildPackageReader,
	readPackage,
	findPackageDir,
};
