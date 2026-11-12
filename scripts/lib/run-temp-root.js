/*
 * run-temp-root.js — each vitest and pytest run's private temp root (#5083).
 *
 * A run makes one root under the real temp dir and points its workers'
 * `TMPDIR` at it, so every fixture a test makes, cleaned up or not, goes when
 * the run removes the root. The name carries the pid of the process that owns
 * it, so a wrapper's start removes the root a SIGKILLed run left.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pidAlive } = require("./arbiter-proc.js");
const { caught } = require("./caught.js");
const { escapeRe } = require("./regex-group.js");
const { writeFd } = require("./write-fd.js");

/** @typedef {"vitest" | "pytest"} RunKind */

/** @param {RunKind} kind */
function prefixOf(kind) {
	return `wfc-${kind}-`;
}

/**
 * Makes `kind`'s root for the run `pid` owns, under `tmp`.
 * @param {RunKind} kind
 * @param {{ tmp?: string, pid?: number }} [options]
 * @returns {string}
 */
function makeRunRoot(kind, { tmp = os.tmpdir(), pid = process.pid } = {}) {
	return fs.mkdtempSync(path.join(tmp, `${prefixOf(kind)}${pid}-`));
}

/**
 * Removes `root` and everything under it. A fixture left without write or
 * search permission is opened up first, since `rmSync` cannot enter it.
 * @param {string} root
 */
function removeRunRoot(root) {
	try {
		fs.rmSync(root, { recursive: true, force: true });
	} catch {
		openUp(root);
		fs.rmSync(root, { recursive: true, force: true });
	}
}

/** @param {string} dir */
function openUp(dir) {
	try {
		fs.chmodSync(dir, 0o700);
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
			if (entry.isDirectory()) openUp(path.join(dir, entry.name));
	} catch {
		/* Not ours to open; the retry names what stays. */
	}
}

/* How long a dead pid's root stands untouched before it is swept: a pid from
 * another pid namespace sharing the tmpdir reads as dead here, and a live
 * run adds to its root with every test file. The hour lib/read-audit.js's
 * sweep takes (#5046), a guess, unmeasured, well past the 14-minute suite
 * ceiling. */
const STALE_MS = 60 * 60 * 1000;

/**
 * Removes every `kind` root under `tmp` whose owning pid is dead and which
 * stood untouched for `STALE_MS`: a run killed before its own teardown.
 * Returns the roots removed.
 * @param {RunKind} kind
 * @param {{ tmp?: string, alive?: (pid: number) => boolean, now?: number, err?: { write: (s: string) => unknown } }} [options]
 * @returns {string[]}
 */
function sweepDeadRunRoots(
	kind,
	{
		tmp = os.tmpdir(),
		alive = pidAlive,
		now = Date.now(),
		err = { write: (/** @type {string} */ s) => writeFd(2, s) },
	} = {},
) {
	const owned = new RegExp(`^${escapeRe(prefixOf(kind))}(\\d+)-[^/]+$`);
	let names;
	try {
		names = fs.readdirSync(tmp);
	} catch (error) {
		/* No temp dir is nothing to sweep (#5083). */
		if (caught(error).code !== "ENOENT")
			err.write(
				`run-temp-root: ${tmp} will not list (${caught(error).message}), so no dead run's root is swept\n`,
			);
		return [];
	}
	const removed = [];
	for (const name of names) {
		const pid = owned.exec(name)?.[1];
		if (!pid || alive(Number(pid))) continue;
		const root = path.join(tmp, name);
		try {
			if (now - fs.lstatSync(root).mtimeMs <= STALE_MS) continue;
			removeRunRoot(root);
			removed.push(root);
		} catch (error) {
			err.write(
				`run-temp-root: ${root} would not go (${caught(error).message}); a dead run left it\n`,
			);
		}
	}
	return removed;
}

module.exports = { STALE_MS, makeRunRoot, removeRunRoot, sweepDeadRunRoots };
