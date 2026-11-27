const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pidAlive } = require("./arbiter-proc.js");
const { caught, ignoreFailure } = require("./caught.js");
const { escapeRe } = require("./regex-group.js");
const { writeFd } = require("./write-fd.js");

/** @typedef {"vitest" | "pytest"} RunKind */

/** @param {RunKind} kind */
function prefixOf(kind) {
	return `wfc-${kind}-`;
}

/**
 * @param {RunKind} kind
 * @param {{ tmp?: string, pid?: number }} [options]
 * @returns {string}
 */
function makeRunRoot(kind, { tmp = os.tmpdir(), pid = process.pid } = {}) {
	return fs.mkdtempSync(path.join(tmp, `${prefixOf(kind)}${pid}-`));
}

/** @param {string} root */
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
	ignoreFailure(() => {
		fs.chmodSync(dir, 0o700);
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
			if (entry.isDirectory()) openUp(path.join(dir, entry.name));
	});
}

// guess, workflow-core#5046
const STALE_MS = 60 * 60 * 1000;

/**
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
