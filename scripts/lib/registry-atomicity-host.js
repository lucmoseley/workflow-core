/*
 * registry-atomicity-host.js — the production ports the dispatcher wires into
 * the guard-registry-atomicity core, lib/registry-atomicity.js (workflow-core#2794, workflow-core#3226). Every git read
 * carries the hook's git timeout, and a timed-out read answers as an erroring
 * one: null, which the core reads as "git could not tell".
 */

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
 * One commit's reads.
 * @param {string} tree the directory the commit runs in
 * @param {string} root its top level
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
		/* --no-renames: a rename is one R entry naming the new path only,
		 * which hides the old member's disappearance (mantahostels#2685). */
		staged: () =>
			lines(at(["diff", "--cached", "--name-only", "--no-renames"])),
		/* ls-tree, never `cat-file -e`, which exits 128 for an ordinary absence
		 * and for a break alike (mantahostels#2702). --full-tree: the names are
		 * the root's wherever the commit runs. */
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
		/* `:<path>` is the stage-0 entry, its path read from the top of the
		 * working tree, so a root-relative path is right from a subdirectory. */
		indexShow: (rel) => at(["show", `:${rel}`]),
		exists: (rel) => fs.existsSync(abs(rel)),
		isFile: (rel) =>
			fs.statSync(abs(rel), { throwIfNoEntry: false })?.isFile() ?? false,
		/* Null where it will not read: callers read only paths `exists` or the
		 * disk listing has shown, so the core
		 * reads null as unreadable, logs it and allows, its stated fail-open
		 * (mantahostels#103 §6, workflow-core#4132). */
		read: (rel) => {
			try {
				return fs.readFileSync(abs(rel), "utf8");
			} catch {
				/* The core's logged allow, above. */
				return null;
			}
		},
		/* A directory that is not there holds no caller; any other read error
		 * throws, and the row refuses the commit (workflow-core#4128). */
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
 * lib/needle-corpus.js's drift over the copy this commit lands, through the
 * core's `readLanding`; HEAD is read through the commit's own Repo, the
 * listing first, since `show` cannot tell an absent path from a broken object
 * store (mantahostels#2702).
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
 * The core's patchBodies: the patch applied to HEAD in a private index, the
 * shared one untouched, as commit-paths.js builds the commit (workflow-core#2894).
 * @param {string} dir
 * @param {string} file the patch, as the command names it
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
		/* Only a refusal's or a record's text names it, so a placeholder costs
		 * a path the reader cannot paste, never a verdict (mantahostels#103 §6). */
		return "<plugin root>/scripts";
	}
}

/**
 * @returns {import("./registry-atomicity.js").RegistryPorts}
 */
function buildHostPorts() {
	return {
		/* A cwd git cannot place — inside `.git`, say — has no top level, and
		 * the core then allows, logged. Two rev-parses where one would do,
		 * each git-tree.js's shared reader (workflow-core#2883): one more spawn a commit. */
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
				/* Null, which the core logs and allows on as a needle present
				 * (mantahostels#103 §6). */
				return null;
			}
		},
		pluginScripts: pluginScripts(),
	};
}

module.exports = { buildHostPorts };
