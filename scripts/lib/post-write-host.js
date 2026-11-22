const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { caught } = require("./caught.js");
const { readBytes } = require("./file-read.js");
const { isUnder } = require("./is-under.js");

/**
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
 * @param {{ log: (what: string, detail?: string) => void }} env
 * @returns {import("./post-write.js").WritePorts}
 */
function buildHostPorts({ log }) {
	/** @param {string} root @param {string} file */
	const abs = (root, file) => path.resolve(root, file);
	return {
		inRoot: (root, file) => {
			try {
				let leaf = abs(root, file);
				if (fs.lstatSync(leaf).isSymbolicLink()) leaf = fs.realpathSync(leaf);
				const dir = fs.realpathSync(path.dirname(leaf));
				return isUnder(dir, [root]);
			} catch (e) {
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
			if (got.state === "unreadable")
				log("the written file did not read for its digest", got.message);
			return null;
		},
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
				return "";
			}
		},
	};
}

module.exports = { buildHostPorts };
