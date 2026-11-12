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

/**
 * Removes every `kind` root under `tmp` whose owning pid is dead: a run
 * killed before its own teardown. Returns the roots removed.
 * @param {RunKind} kind
 * @param {{ tmp?: string, alive?: (pid: number) => boolean, err?: { write: (s: string) => unknown } }} [options]
 * @returns {string[]}
 */
function sweepDeadRunRoots(
	kind,
	{ tmp = os.tmpdir(), alive = pidAlive, err = process.stderr } = {},
) {
	const owned = new RegExp(`^${prefixOf(kind)}(\\d+)-[^/]+$`);
	let names;
	try {
		names = fs.readdirSync(tmp);
	} catch {
		return [];
	}
	const removed = [];
	for (const name of names) {
		const pid = owned.exec(name)?.[1];
		if (!pid || alive(Number(pid))) continue;
		const root = path.join(tmp, name);
		try {
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

module.exports = { makeRunRoot, removeRunRoot, sweepDeadRunRoots };
