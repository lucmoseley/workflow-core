const fs = require("node:fs");
const path = require("node:path");

const { configDirs } = require("./arbiter-store");
const { projectSlug } = require("./project-slug");
const { hostRoot } = require("./host-root.js");
const { configDir } = require("./config-dir.js");
const { caught } = require("./caught.js");
const { realKey } = require("./deref.js");
const { WORKTREES } = require("./worktree-dirs.js");

/**
 * @param {string} root
 * @returns {(name: string) => boolean}
 */
function repoSlugMatcher(root) {
	const main = projectSlug(root);
	const worktree = `${projectSlug(path.join(root, WORKTREES))}-`;
	return (name) => name === main || name.startsWith(worktree);
}

/**
 * @param {string[]} [seats]
 * @returns {string[]}
 */
function projectDirs(seats = configDirs()) {
	const root = hostRoot();
	const main = projectSlug(root);
	const isRepo = repoSlugMatcher(root);
	/** @type {string[]} */
	const out = [];
	const seen = new Set();
	/** @param {string} dir */
	const add = (dir) => {
		const key = realKey(dir);
		if (seen.has(key)) return;
		seen.add(key);
		out.push(dir);
	};
	for (const seat of seats) add(path.join(seat, "projects", main));
	for (const seat of seats) {
		let names;
		try {
			names = fs.readdirSync(path.join(seat, "projects"));
		} catch {
			continue;
		}
		for (const name of names.sort())
			if (name !== main && isRepo(name)) add(path.join(seat, "projects", name));
	}
	return out;
}

/**
 * @param {string | undefined} [override]
 * @param {string} [seat]
 * @returns {string[]}
 */
function corpusDirs(override, seat = configDir()) {
	if (override) return [override];
	const dirs = projectDirs([seat]);
	const present = dirs.filter((d) => fs.existsSync(d));
	return present.length > 0 ? present : dirs.slice(0, 1);
}

/** @param {string} file */
function sizeOf(file) {
	try {
		return fs.statSync(file).size;
	} catch {
		return -1;
	}
}

/**
 * @param {string[]} files
 * @returns {string[]}
 */
function oneCopyEach(files) {
	/** @type {Map<string, { file: string, size: number }>} */
	const best = new Map();
	for (const file of files) {
		const size = sizeOf(file);
		const held = best.get(path.basename(file));
		if (!held || size > held.size)
			best.set(path.basename(file), { file, size });
	}
	return [...best.values()].map((b) => b.file);
}

/** @param {unknown} e */
const errorTag = (e) => {
	const { code, message } = caught(e);
	return code || message;
};

/**
 * @param {string[]} dirs
 * @returns {{ found: string[], absent: string[], unreadable: string[] }}
 */
function listTranscripts(dirs) {
	/** @type {string[]} */
	const found = [];
	/** @type {string[]} */
	const absent = [];
	/** @type {string[]} */
	const unreadable = [];
	for (const dir of dirs) {
		let names;
		try {
			names = fs.readdirSync(dir);
		} catch (e) {
			if (caught(e).code === "ENOENT") absent.push(dir);
			else unreadable.push(`${dir} (${errorTag(e)})`);
			continue;
		}
		for (const name of names)
			if (name.endsWith(".jsonl")) found.push(path.join(dir, name));
	}
	return { found, absent, unreadable };
}

/** @typedef {{ listed: number, absent: string[], unreadable: string[] }} SeatListing */

/**
 * @param {string[]} seats
 * @returns {SeatListing & { dirs: string[] }}
 */
function readSeatProjectDirs(seats) {
	/** @type {string[]} */
	const dirs = [];
	/** @type {SeatListing} */
	const listing = { listed: 0, absent: [], unreadable: [] };
	const seen = new Set();
	for (const seat of seats) {
		const projects = path.join(seat, "projects");
		let slugs;
		try {
			slugs = fs.readdirSync(projects, { withFileTypes: true });
		} catch (e) {
			if (caught(e).code === "ENOENT") listing.absent.push(projects);
			else listing.unreadable.push(`${projects} (${errorTag(e)})`);
			continue;
		}
		listing.listed++;
		for (const slug of slugs) {
			if (!slug.isDirectory() && !slug.isSymbolicLink()) continue;
			const dir = path.join(projects, slug.name);
			const key = realKey(dir);
			if (seen.has(key)) continue;
			seen.add(key);
			dirs.push(dir);
		}
	}
	return { dirs, ...listing };
}

/**
 * @param {string[]} seats
 * @returns {SeatListing & { files: string[] }}
 */
function readSeatTranscripts(seats) {
	const { dirs, ...listing } = readSeatProjectDirs(seats);
	/** @type {string[]} */
	const files = [];
	for (const dir of dirs) {
		let names;
		try {
			names = fs.readdirSync(dir);
		} catch (e) {
			const { code } = caught(e);
			if (code !== "ENOENT" && code !== "ENOTDIR")
				listing.unreadable.push(`${dir} (${errorTag(e)})`);
			continue;
		}
		for (const name of names)
			if (name.endsWith(".jsonl")) files.push(path.join(dir, name));
	}
	return { files: oneCopyEach(files), ...listing };
}

/**
 * @param {string} seat
 * @param {number} sinceMs
 * @param {string} ignoredSlug
 */
function hasSeatRunSince(seat, sinceMs, ignoredSlug) {
	const projects = path.join(seat, "projects");
	let slugs;
	try {
		slugs = fs.readdirSync(projects, { withFileTypes: true });
	} catch {
		return false;
	}
	return slugs.some((slug) => {
		if (!slug.isDirectory() || slug.name === ignoredSlug) return false;
		const dir = path.join(projects, slug.name);
		let names;
		try {
			names = fs.readdirSync(dir);
		} catch {
			return false;
		}
		return names.some((name) => {
			if (!name.endsWith(".jsonl")) return false;
			const stat = fs.statSync(path.join(dir, name), { throwIfNoEntry: false });
			return stat !== undefined && stat.mtimeMs > sinceMs;
		});
	});
}

module.exports = {
	hasSeatRunSince,
	corpusDirs,
	listTranscripts,
	oneCopyEach,
	projectDirs,
	readSeatProjectDirs,
	readSeatTranscripts,
};
