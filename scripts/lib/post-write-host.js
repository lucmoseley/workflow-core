/*
 * post-write-host.js — the production ports lib/post-write.js formats,
 * records and scans through (#2787). Each fails open on its own, so a broken
 * formatter never costs the record behind it.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { caught } = require("./caught.js");

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

/**
 * @param {string} root symlink-resolved
 * @param {(what: string, detail?: string) => void} log
 */
function buildHostPorts(root, log) {
	const biome = path.join(root, "node_modules", ".bin", "biome");
	/** @param {string} file */
	const abs = (file) => path.resolve(root, file);
	return {
		/* The path resolved as the root is — its directory physically, a
		 * symlinked leaf to its target, since Biome writes through the link —
		 * and a relative path against the root. Anything unresolvable is
		 * outside. */
		inRoot: (/** @type {string} */ file) => {
			try {
				let leaf = abs(file);
				if (fs.lstatSync(leaf).isSymbolicLink()) leaf = fs.realpathSync(leaf);
				const dir = fs.realpathSync(path.dirname(leaf));
				return `${dir}/`.startsWith(`${root}/`);
			} catch {
				return false;
			}
		},
		digest: (/** @type {string} */ file) => {
			try {
				return crypto
					.createHash("sha1")
					.update(fs.readFileSync(abs(file)))
					.digest("hex");
			} catch {
				return null;
			}
		},
		/* The binary by path, never `npx`: in a worktree there is no
		 * node_modules, and npx then FETCHES an unrelated package called biome
		 * that prints nothing and exits 0. */
		hasBiome: () => fs.existsSync(biome),
		runBiome: (/** @type {string} */ file) => {
			spawnSync(biome, ["format", "--write", "--", file], {
				cwd: root,
				stdio: "ignore",
				timeout: require("./formatters.js").WRITE_FORMAT_TIMEOUT_MS,
			});
		},
		formatOther: (/** @type {string} */ file) => {
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
		recordWrite: (
			/** @type {string} */ file,
			/** @type {string} */ session,
		) => {
			try {
				require("./arbiter-tool-record.js").recordToolWrite(file, session);
			} catch (e) {
				log(
					"the write record threw — the write went unrecorded",
					caught(e).message,
				);
			}
		},
		scanFaults: (/** @type {string} */ file) => {
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
