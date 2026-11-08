/*
 * post-write-host.js — the production ports lib/post-write.js formats,
 * records and scans through (#2787). Each fails open on its own, so a broken
 * formatter never costs the record behind it.
 *
 * The formatting and scan ports take the root of the tree they act in, which
 * the core passes as the session's (#4242): a linked worktree's file is
 * formatted by that worktree's Biome and config, never the host's.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { caught } = require("./caught.js");
const { readBytes } = require("./file-read.js");
const { isUnder } = require("./is-under.js");

/**
 * `fn` run from `root`, as the bash hook's `cd "$root"` ran the formatters:
 * lib/formatters.js reads its config and git from the working directory. The
 * entry is one synchronous process, so no other core sees the move.
 * @template T
 * @param {string} root
 * @param {() => T} fn
 * @returns {T}
 */
function fromRoot(root, fn) {
	const back = process.cwd();
	process.chdir(root);
	try {
		return fn();
	} finally {
		process.chdir(back);
	}
}

/** @param {string} root */
const biomeIn = (root) => path.join(root, "node_modules", ".bin", "biome");

/**
 * @param {string} _root the host's, which only the record reads, through the
 *   arbiter's own
 * @param {(what: string, detail?: string) => void} log
 * @returns {import("./post-write.js").WritePorts}
 */
function buildHostPorts(_root, log) {
	/** @param {string} root @param {string} file */
	const abs = (root, file) => path.resolve(root, file);
	return {
		/* The path resolved as the root is — its directory physically, a
		 * symlinked leaf to its target, since Biome writes through the link —
		 * and a relative path against the root. Anything unresolvable is
		 * outside. */
		inRoot: (root, file) => {
			try {
				let leaf = abs(root, file);
				if (fs.lstatSync(leaf).isSymbolicLink()) leaf = fs.realpathSync(leaf);
				const dir = fs.realpathSync(path.dirname(leaf));
				return isUnder(dir, [root]);
			} catch (e) {
				/* Outside, so nothing is formatted: a write the hook cannot
				 * place is left as written (mantahostels#103 §6). */
				if (caught(e).code !== "ENOENT")
					log(
						"the written path did not resolve — left as written",
						caught(e).message,
					);
				return false;
			}
		},
		digest: (root, file) => {
			const got = readBytes(abs(root, file));
			if (got.state === "read")
				return crypto.createHash("sha256").update(got.data).digest("hex");
			/* Null: unread before the format, no reformat is reported; unread
			 * after, one is (mantahostels#103 §6). */
			if (got.state === "unreadable")
				log("the written file did not read for its digest", got.message);
			return null;
		},
		/* The binary by path, never `npx`: in a worktree there is no
		 * node_modules, and npx then FETCHES an unrelated package called biome
		 * that prints nothing and exits 0. */
		hasBiome: (root) => fs.existsSync(biomeIn(root)),
		runBiome: (root, file) => {
			spawnSync(biomeIn(root), ["format", "--write", "--", file], {
				cwd: root,
				stdio: "ignore",
				timeout: require("./formatters.js").WRITE_FORMAT_TIMEOUT_MS,
			});
		},
		formatOther: (root, file) => {
			try {
				return fromRoot(root, () =>
					require("./formatters.js").formatWritten(file),
				);
			} catch (e) {
				log(
					"the shell or Python format threw — left as written",
					caught(e).message,
				);
				return "";
			}
		},
		recordWrite: (file, session) => {
			try {
				require("./arbiter-tool-record.js").recordToolWrite(file, session);
			} catch (e) {
				log(
					"the write record threw — the write went unrecorded",
					caught(e).message,
				);
			}
		},
		scanFaults: (root, file) => {
			try {
				return require("./write-scan.js").writeFaults(root, file);
			} catch {
				/* Swallowed (#1151): a scan that breaks a write is worse than one
				 * that misses a fault, which the commit gate and the release still
				 * judge. */
				return "";
			}
		},
	};
}

module.exports = { buildHostPorts };
