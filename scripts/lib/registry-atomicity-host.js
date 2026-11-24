const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { caught } = require("./caught.js");
const { gitOrNull, HOOK_GIT_TIMEOUT_MS } = require("./git.js");
const { patchFiles, readGitDir, readTopLevel } = require("./git-tree.js");
const { needleDrift } = require("./needle-corpus.js");

/** @param {string[]} args */
const git = (args) => gitOrNull(args, { timeout: HOOK_GIT_TIMEOUT_MS });

/** @param {string | null} out */
const lines = (out) =>
	out === null ? null : out.split("\n").filter((l) => l !== "");

/**
 * @param {string} tree
 * @param {string} root
 * @returns {import("./registry-atomicity.js").Repo}
 */
function openRepo(tree, root) {
	/** @param {string[]} args */
	const at = (args) => git(["-C", tree, ...args]);
	/** @param {string[]} args @returns {Set<string> | null} */
	const listing = (args) => {
		const out = at(args);
		return out === null ? null : new Set(out.split("\0").filter(Boolean));
	};
	/** @type {Set<string> | null | undefined} */
	let head;
	/** @type {Set<string> | null | undefined} */
	let index;
	/** @param {string} p */
	const abs = (p) => path.resolve(root, p);
	return {
		lsCached: (spec) =>
			lines(at(["ls-files", "--full-name", "--cached", "--", spec])),
		lsOthers: (spec) =>
			lines(
				at([
					"ls-files",
					"--full-name",
					"--others",
					"--exclude-standard",
					"--",
					spec,
				]),
			),
		stagedDeletions: (spec) =>
			lines(
				at([
					"diff",
					"--cached",
					"--name-only",
					"--no-renames",
					"--diff-filter=D",
					"--",
					spec,
				]),
			),
		staged: () =>
			lines(at(["diff", "--cached", "--name-only", "--no-renames"])),
		headNames: (rel) => {
			if (head === undefined)
				head = listing([
					"ls-tree",
					"-r",
					"-z",
					"--full-tree",
					"--name-only",
					"HEAD",
				]);
			return head === null ? null : head.has(rel);
		},
		headShow: (rel) => at(["show", `HEAD:${rel}`]),
		indexNames: (rel) => {
			if (index === undefined)
				index = listing([
					"-C",
					root,
					"ls-files",
					"-z",
					"--full-name",
					"--cached",
				]);
			return index === null ? null : index.has(rel);
		},
		indexShow: (rel) => at(["show", `:${rel}`]),
		exists: (rel) => fs.existsSync(abs(rel)),
		isFile: (rel) =>
			fs.statSync(abs(rel), { throwIfNoEntry: false })?.isFile() ?? false,
		read: (rel) => {
			try {
				return fs.readFileSync(abs(rel), "utf8");
			} catch {
				return null;
			}
		},
		list: (rel) => {
			try {
				return fs.readdirSync(abs(rel));
			} catch (e) {
				if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT")
					return [];
				throw e;
			}
		},
	};
}

/**
 * @param {{ repo: import("./registry-atomicity.js").Repo, root: string,
 *   landing: string[], readLanding: ((rel: string) => string | null) | null }} at
 */
function drift({ repo, root, landing, readLanding }) {
	const readHead = (/** @type {string} */ rel) => {
		const named = repo.headNames(rel);
		if (named === false) return null;
		const body = named ? repo.headShow(rel) : null;
		if (body === null) throw new Error(`git could not read HEAD:${rel}`);
		return body;
	};
	try {
		const { broken, failOpen } = needleDrift({
			root,
			landing,
			readHead,
			readLanding,
		});
		return failOpen ? { failOpen } : { broken };
	} catch (e) {
		return { failOpen: caught(e).message.replace(/\s+/g, " ").trim() };
	}
}

/**
 * @param {string} dir
 * @param {string} file
 * @returns {Map<string, string | null> | null}
 */
function patchBodies(dir, file) {
	const files = patchFiles(dir, file);
	const top = readTopLevel(dir);
	if (!files || !top) return null;
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-registry-"));
	const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, "index") };
	/** @param {string[]} args */
	const inIndex = (args) =>
		gitOrNull(["-C", top, ...args], { timeout: HOOK_GIT_TIMEOUT_MS, env });
	try {
		if (inIndex(["read-tree", "HEAD"]) === null) return null;
		const patch = path.resolve(dir, file);
		if (inIndex(["apply", "--cached", "--unidiff-zero", patch]) === null)
			return null;
		/** @type {Map<string, string | null>} */
		const bodies = new Map();
		for (const abs of files) {
			const rel = path.relative(top, abs);
			const named = inIndex(["ls-files", "--cached", "--", `:(literal)${rel}`]);
			const body = named ? inIndex(["show", `:${rel}`]) : null;
			if (named === null || (named && body === null)) return null;
			bodies.set(abs, body);
		}
		return bodies;
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

function pluginScripts() {
	try {
		return fs.realpathSync(path.join(__dirname, ".."));
	} catch {
		return "<plugin root>/scripts";
	}
}

/**
 * @returns {import("./registry-atomicity.js").RegistryPorts}
 */
function buildHostPorts() {
	return {
		place: (dir) => {
			const root = readTopLevel(dir);
			const gitdir = root ? readGitDir(dir) : null;
			if (!root || !gitdir) return { root: null, midSequence: false };
			const has = (/** @type {string} */ p) => fs.existsSync(`${gitdir}/${p}`);
			return {
				root,
				midSequence:
					has("MERGE_HEAD") ||
					has("rebase-merge") ||
					has("rebase-apply") ||
					has("CHERRY_PICK_HEAD") ||
					has("REVERT_HEAD"),
			};
		},
		repo: openRepo,
		patchBodies,
		needleDrift: drift,
		pluginNeedles: () => {
			try {
				return fs.readFileSync(
					path.join(__dirname, "..", "guard-fire-needles.json"),
					"utf8",
				);
			} catch {
				return null;
			}
		},
		pluginScripts: pluginScripts(),
	};
}

module.exports = { buildHostPorts };
