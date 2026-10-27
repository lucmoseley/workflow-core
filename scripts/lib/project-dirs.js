/*
 * project-dirs.js — where transcripts live, across every seat: this repo's, or
 * every repo's under a given seat list.
 *
 * Shared because each seat keeps its own sessions, so a scanner reading one
 * root saw a fraction of the corpus (workflow-core#375), and one session resumed on another
 * seat was counted twice (workflow-core#382); a new transcript walk belongs here. The
 * every-repo listing is the retro picker's pool (workflow-core#960), which reports a seat
 * it could not read (workflow-core#1054).
 */

const fs = require("node:fs");
const path = require("node:path");

const { configDirs } = require("./arbiter-store");
const { slugForRepo } = require("./project-slug");
const { caught } = require("./caught.js");
const { realKey } = require("./deref.js");

/**
 * Every seat's projects directory for this repo, deduped by realpath.
 *
 * Each seat's `projects/<slug>` is a real directory (workflow-core#375); the realpath
 * dedupe keeps one symlinked at another seat's from being counted twice.
 *
 * @returns {string[]}
 */
function projectDirs() {
	const slug = slugForRepo();
	/** @type {string[]} */
	const out = [];
	const seen = new Set();
	for (const dir of configDirs()) {
		const projects = path.join(dir, "projects", slug);
		const key = realKey(projects);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(projects);
	}
	return out;
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
 * (workflow-core#1520).
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

module.exports = {
	listTranscripts,
	oneCopyEach,
	projectDirs,
	readSeatProjectDirs,
	readSeatTranscripts,
};
