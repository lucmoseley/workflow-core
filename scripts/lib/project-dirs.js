/*
 * project-dirs.js — where transcripts live, across every seat: this repo's, or
 * every repo's under a given seat list.
 *
 * Shared because each seat keeps its own sessions, so a scanner reading one
 * root saw a fraction of the corpus (#375), and one session resumed on another
 * seat was counted twice (#382); a new transcript walk belongs here. The
 * every-repo listing is the retro picker's pool (#960), which reports a seat
 * it could not read (#1054).
 *
 * This repo's sessions write under more than one slug: a session in a linked
 * worktree under `.claude/worktrees/` writes under that worktree's own slug
 * (#4229), so `projectDirs()` returns those beside the main checkout's.
 */

const fs = require("node:fs");
const path = require("node:path");

const { configDirs } = require("./arbiter-store");
const { projectSlug } = require("./project-slug");
const { hostRoot } = require("./host-root.js");
const { mainCheckout } = require("./main-checkout.js");
const { configDir } = require("./config-dir.js");
const { caught } = require("./caught.js");
const { deref, realKey } = require("./deref.js");

const WORKTREES_DIR = path.join(".claude", "worktrees");

/**
 * The checkout whose slug this repo's transcripts key on: the main checkout
 * (#4236), which `hostRoot()` also names for a declared linked worktree (#4487). Where git names no common dir the host root stands, and only its
 * slug is read.
 *
 * @returns {string}
 */
function repoCheckout() {
	const root = hostRoot();
	const main = mainCheckout(root);
	return main === null ? root : deref(main);
}

/**
 * Whether a name under `projects/` is this repo's: the main checkout's slug,
 * or a worktree's under `WORKTREES_DIR`. Matched on the spelling, never on
 * `git worktree list`, because a reaped worktree's transcripts stay behind
 * (#4236).
 *
 * @param {string} root the main checkout
 * @returns {(name: string) => boolean}
 */
function repoSlugMatcher(root) {
	const main = projectSlug(root);
	const worktree = `${projectSlug(path.join(root, WORKTREES_DIR))}-`;
	return (name) => name === main || name.startsWith(worktree);
}

/**
 * Every seat's projects directories for this repo, deduped by realpath: each
 * seat's main-checkout slug first, in seat order, then each worktree slug.
 *
 * Each seat's `projects/<slug>` is a real directory (#375); the realpath
 * dedupe keeps one symlinked at another seat's from being counted twice. The
 * main slug is returned whether or not it exists, so a caller reports a seat
 * it could not read; a worktree slug only where the seat lists it.
 *
 * @param {string[]} [seats] config dirs
 * @returns {string[]}
 */
function projectDirs(seats = configDirs()) {
	const root = repoCheckout();
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
			/* The main slug above carries this seat's failure to its caller,
			 * which reports it (#1520). */
			continue;
		}
		for (const name of names.sort())
			if (name !== main && isRepo(name)) add(path.join(seat, "projects", name));
	}
	return out;
}

/**
 * The directories a one-seat corpus reader reads: `override` alone where
 * given, else those of this repo's on the current seat that exist. A seat
 * whose sessions all ran in worktrees has no main-slug directory, and that
 * is no reason to refuse (#4236); where none exists, the main slug alone, so
 * the reader reports it absent rather than reading an empty corpus.
 *
 * @param {string | undefined} [override] a directory named by flag or env
 * @param {string} [seat] the config dir to read
 * @returns {string[]}
 */
function corpusDirs(override, seat = configDir()) {
	if (override) return [override];
	const dirs = projectDirs([seat]);
	const present = dirs.filter((d) => fs.existsSync(d));
	return present.length > 0 ? present : dirs.slice(0, 1);
}

/**
 * A copy that cannot be stat'ed ranks below any that can; the caller reads or
 * stats it again and reports that failure itself.
 *
 * @param {string} file
 */
function sizeOf(file) {
	try {
		return fs.statSync(file).size;
	} catch {
		return -1;
	}
}

/**
 * One copy of each transcript name across seats' project directories — the
 * largest, which holds the most of that session. A session resumed on another
 * seat leaves a transcript of the same name under each, so a reader tallying
 * whole files would count it twice. `transcript_corpus.py`'s `one_copy_each()`.
 *
 * @param {string[]} files paths directly under any seat's project directory
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

/** @param {unknown} e  a caught error */
const errorTag = (e) => {
	const { code, message } = caught(e);
	return code || message;
};

/**
 * Every `.jsonl` directly under each directory. A directory that does not
 * exist is kept apart from one a read refused, because a machine running
 * fewer seats has no `.claude2`/`.claude3`; each caller words its own refusal
 * (#1520).
 *
 * @param {string[]} dirs
 * @returns {{ found: string[], absent: string[], unreadable: string[] }}
 *   `unreadable` entries read `<dir> (<error code>)`
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

/**
 * @typedef {{ listed: number, absent: string[], unreadable: string[] }} SeatListing
 * `listed` counts the seats whose `projects/` could be read; `absent` holds
 * each one that does not exist, `unreadable` each directory a read refused,
 * with its error code.
 */

/**
 * Every project directory under each seat's `projects/`, every repo's, deduped
 * by realpath.
 *
 * @param {string[]} seats config dirs
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
 * Every session's main log under the seats, one copy each (`oneCopyEach`).
 * A subagent's log sits a level down, under `<sessionId>/subagents/`, and is
 * not read.
 *
 * @param {string[]} seats config dirs
 * @returns {SeatListing & { files: string[] }}
 */
function readSeatTranscripts(seats) {
	const { dirs, ...listing } = readSeatProjectDirs(seats);
	/** @type {string[]} */
	const files = [];
	/* Not `listTranscripts`: a slug that is a symlink at a file is skipped
	 * here, where that would report it unreadable. */
	for (const dir of dirs) {
		let names;
		try {
			names = fs.readdirSync(dir);
		} catch (e) {
			const { code } = caught(e);
			/* A slug gone since the listing, or a symlink at a file, holds no session. */
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
 * Whether a session wrote to `seat` since `sinceMs`: a main log under its own
 * projects, a symlinked slug being another seat's.
 *
 * @param {string} seat config dir
 * @param {number} sinceMs
 * @param {string} ignoredSlug a slug whose logs are no session's
 */
function hasSeatRunSince(seat, sinceMs, ignoredSlug) {
	const projects = path.join(seat, "projects");
	let slugs;
	try {
		slugs = fs.readdirSync(projects, { withFileTypes: true });
	} catch {
		// #4060: a seat that will not list falls back to its daily read.
		return false;
	}
	return slugs.some((slug) => {
		if (!slug.isDirectory() || slug.name === ignoredSlug) return false;
		const dir = path.join(projects, slug.name);
		let names;
		try {
			names = fs.readdirSync(dir);
		} catch {
			// #4060: as above, for one slug.
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
	WORKTREES_DIR,
	hasSeatRunSince,
	corpusDirs,
	listTranscripts,
	oneCopyEach,
	projectDirs,
	readSeatProjectDirs,
	readSeatTranscripts,
};
