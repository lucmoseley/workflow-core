/*
 * read-audit.js — the runtime read audit the pass store keys a test file's
 * row on (#4916). A path a test builds at run time — a directory listing, a
 * helper's default root — is invisible to the lexical reach; the audit sees
 * the read itself.
 *
 * `install` arms it for one suite run, from vitest's globalSetup: a log
 * directory, and lib/read-audit-preload.js on `NODE_OPTIONS`, which every
 * worker and every Node child inheriting the environment loads. The git
 * guard (lib/host-git-guard/git) logs each git call on this checkout's
 * repository, word for word. `readAudits` turns the logs into each test
 * file's reads after the run.
 *
 * A DIRECTORY A TEST MINTS (`mkdtemp`) under the root is its own scratch:
 * no read under it is a read of the checkout.
 *
 * A GIT CALL ON THIS REPOSITORY is a read `fs` never sees. One of the
 * read-only subcommands in `RERUN`, made from a directory under the root with
 * no `-C`, `--git-dir`, `--work-tree` or git-dir variable steering it, is
 * kept word for word: the store keys it on its output, run again.
 *
 * EVERY DOUBT IS NO ROW: a file whose audit is missing, faulted, shared with
 * another file, or holds a read the audit cannot see, reads as `doubt`, which
 * the store records no row for. What cannot be seen:
 * - any other git call on this repository, a worktree of it outside the root
 *   included;
 * - a Node child that left no log, or one spawned without the audit on;
 * - any other child — a shell, Python, a binary — run from a directory under
 *   the root, or handed an argument naming a path there, as its reads are its
 *   own. A shell or Python child handed a checkout script to run, from
 *   outside the root, is seen: the script is a read, and the lexical reach
 *   keys what it loads, as before (#4790);
 * - a symlink, socket or other non-file, non-directory path.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { isUnder } = require("./is-under.js");
const { parseJsonl } = require("./jsonl.js");
const { pathKind } = require("./path-kind.js");

const PRELOAD = path.join(__dirname, "read-audit-preload.js");

/* Subcommands that read and never write, so the store may run one again.
 * `status` is left out: it refreshes the index. */
const RERUN = new Set([
	"rev-parse",
	"ls-files",
	"ls-tree",
	"cat-file",
	"show",
	"log",
	"rev-list",
	"diff",
	"diff-tree",
	"diff-index",
	"diff-files",
	"merge-base",
	"for-each-ref",
	"show-ref",
	"describe",
	"name-rev",
	"check-ignore",
	"grep",
]);

/* git's options before the subcommand that take the next word as a value. */
const VALUED = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config-env",
	"--attr-source",
]);

/**
 * @typedef {{cwd: string, args: string[]}} GitCall
 *   a git call to run again: its directory, repo-relative, and its words
 * @typedef {{files: string[], absent: string[], dirs: string[],
 *   lists: Record<string, string>, trees: string[], scripts: string[],
 *   git: GitCall[]}} Reads
 *   repo-relative: files read or probed, paths probed and found absent,
 *   directories probed, each listed directory with its listing's id, trees
 *   walked or copied whole, the scripts a shell or Python child ran, whose
 *   own loads the lexical reach keys, and the git calls it made here
 * @typedef {{reads: Reads} | {doubt: string}} Audit
 * @typedef {Record<string, unknown>} Entry one log line
 */

/**
 * Arm the audit for a run over `root`: set the environment every worker
 * inherits. Returns the log directory, or null where this process is itself
 * under an audit (a test's nested run), whose logs are its owner's.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env] written: the three variables are set on it
 * @returns {string|null}
 */
function install(root, env = process.env) {
	if (env.WFC_READ_AUDIT_OWNER) return null;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-read-audit-"));
	env.WFC_READ_AUDIT = dir;
	env.WFC_READ_AUDIT_ROOT = fs.realpathSync(root);
	/* `--import`, not `--require`: a require'd preload resolves through the
	 * working directory's package.json, which a test may break on purpose. */
	env.NODE_OPTIONS = [
		env.NODE_OPTIONS,
		`--import=${JSON.stringify(pathToFileURL(PRELOAD).href)}`,
	]
		.filter(Boolean)
		.join(" ");
	return dir;
}

/**
 * Remove the log directory. Never throws.
 * @param {string|null} dir
 */
function remove(dir) {
	if (!dir) return;
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// A leftover directory in the tmpdir costs only disk.
	}
}

/**
 * Each audited test file's reads, off the logs in `dir`. A file absent from
 * the result was never claimed by a process of its own.
 * @param {string} dir
 * @param {string} root the root the audit was armed over
 * @returns {Map<string, Audit>}
 */
function readAudits(dir, root) {
	const owners = readOwners(dir);
	const real = fs.realpathSync(root);
	/** @type {Map<string, Audit>} */
	const out = new Map();
	for (const [owner, { logs, git }] of owners) {
		const own = logs.get(Number(owner));
		const claimsIn = (/** @type {Entry[]} */ entries) =>
			entries.filter((e) => e.k === "claim").map((e) => String(e.file));
		const claims = new Set(claimsIn(own ?? []));
		const named =
			claims.size > 0 ? claims : new Set(claimsIn([...logs.values()].flat()));
		/** @type {Audit} */
		let audit;
		if (!own) audit = { doubt: "its process left no audit log" };
		else if (claims.size === 1) audit = judge(logs, git, real);
		else audit = { doubt: "its process ran more than one test file" };
		for (const f of named)
			out.set(f, out.has(f) ? { doubt: "two processes claimed it" } : audit);
	}
	return out;
}

/**
 * Each owner's logs, by process, and the git calls the guard logged for it.
 * @param {string} dir
 * @returns {Map<string, {logs: Map<number, Entry[]>, git: string[][]}>}
 */
function readOwners(dir) {
	/** @typedef {{logs: Map<number, Entry[]>, git: string[][]}} Owner */
	/** @type {Map<string, Owner>} */
	const owners = new Map();
	const at = (/** @type {string} */ owner) => {
		/** @type {Owner} */
		const o = owners.get(owner) ?? { logs: new Map(), git: [] };
		owners.set(owner, o);
		return o;
	};
	for (const name of fs.readdirSync(dir)) {
		const text = () => fs.readFileSync(path.join(dir, name), "utf8");
		const git = /^(\d+)\.git$/.exec(name);
		if (git) at(String(git[1])).git.push(...gitRecords(text()));
		const log = /^(\d+)\.(\d+)\.jsonl$/.exec(name);
		if (!log) continue;
		/* A line that will not parse is a read that may be lost: a fault. */
		const { rows, bad } = parseJsonl(text());
		if (bad.length > 0) rows.push({ k: "fault" });
		at(String(log[1])).logs.set(Number(log[2]), rows);
	}
	return owners;
}

/**
 * The guard's records: each its field count, then that many NUL-ended
 * fields — the git-dir flag, the directory, the words.
 * @param {string} text
 * @returns {string[][]}
 */
function gitRecords(text) {
	const fields = text.split("\0");
	/** @type {string[][]} */
	const out = [];
	for (let i = 0; i < fields.length - 1; ) {
		const n = Number(fields[i]);
		if (!Number.isInteger(n) || n < 2) throw new Error("a git record is torn");
		out.push(fields.slice(i + 1, i + 1 + n));
		i += n + 1;
	}
	return out;
}

/**
 * One owner's reads, or the doubt that voids them.
 * @param {Map<number, Entry[]>} logs
 * @param {string[][]} git the guard's records for this owner
 * @param {string} root real path
 * @returns {Audit}
 */
function judge(logs, git, root) {
	for (const [pid, entries] of logs)
		if (entries[0]?.k !== "self" || entries.some((e) => e.k === "fault"))
			return { doubt: `the audit faulted in process ${pid}` };
	const minted = [...logs.values()]
		.flat()
		.filter((e) => e.k === "minted")
		.map((e) => String(e.p));
	const isScratch = (/** @type {string} */ p) => isUnder(p, minted);
	const reads = collector(logs, root, isScratch);
	for (const record of git) {
		const why = reads.takeGit(record);
		if (why) return { doubt: why };
	}
	for (const entries of logs.values())
		for (const e of entries) {
			const why = reads.take(e);
			if (why) return { doubt: why };
		}
	return reads.finish();
}

/**
 * The reads one owner's log entries add up to.
 * @param {Map<number, Entry[]>} logs
 * @param {string} root real path
 * @param {(p: string) => boolean} isScratch
 */
function collector(logs, root, isScratch) {
	/** @type {Record<"file"|"dir"|"absent", Set<string>>} */
	const probed = { file: new Set(), dir: new Set(), absent: new Set() };
	/** @type {Map<string, Set<string>>} */
	const lists = new Map();
	/** @type {Set<string>} */
	const trees = new Set();
	/** @type {Set<string>} */
	const scripts = new Set();
	/** @type {Map<string, GitCall>} */
	const calls = new Map();
	/** @type {Record<string, (e: Entry) => string|null>} */
	const takers = {
		probe: (e) => {
			const kind = /** @type {"file"|"dir"|"absent"} */ (String(e.s));
			if (!(kind in probed)) return `it read ${e.p}, no file or directory`;
			probed[kind].add(String(e.p));
			return null;
		},
		list: (e) => {
			const ids = lists.get(String(e.p)) ?? new Set();
			ids.add(String(e.id));
			lists.set(String(e.p), ids);
			return null;
		},
		tree: (e) => {
			trees.add(String(e.p));
			return null;
		},
		child: (e) => {
			const why = childDoubt(e, logs, root, isScratch);
			if (!why) for (const f of childReads(e, root)) scripts.add(f);
			return why;
		},
	};
	return {
		/** @param {Entry} e */
		take: (e) =>
			typeof e.p === "string" && isScratch(e.p)
				? null
				: (takers[String(e.k)]?.(e) ?? null),
		/**
		 * @param {string[]} record
		 * @returns {string|null}
		 */
		takeGit(record) {
			const call = rerunnable(record, root, isScratch);
			if (typeof call === "string") return call;
			if (call) calls.set(JSON.stringify(call), call);
			return null;
		},
		/** @returns {Audit} */
		finish() {
			/** @type {Record<string, string>} */
			const listed = {};
			for (const [p, ids] of lists) {
				if (ids.size > 1)
					return { doubt: `${p} listed differently within the run` };
				listed[p] = /** @type {string} */ ([...ids][0]);
			}
			for (const p of probed.file)
				if (probed.absent.has(p) || probed.dir.has(p))
					return { doubt: `${p} changed kind within the run` };
			return {
				reads: {
					files: [...probed.file].sort(),
					absent: [...probed.absent].sort(),
					dirs: [...probed.dir].sort(),
					lists: listed,
					trees: [...trees].sort(),
					scripts: [...scripts].sort(),
					git: [...calls.values()],
				},
			};
		},
	};
}

/**
 * A guard record as a git call to run again, null where it ran in a test's
 * own scratch, or the doubt it leaves where it cannot be run again.
 * @param {string[]} record the git-dir flag, the directory, the words
 * @param {string} root real path
 * @param {(p: string) => boolean} isScratch
 * @returns {GitCall|string|null}
 */
function rerunnable([steered, dir = "", ...args], root, isScratch) {
	const shown = `git ${args.join(" ")}`.slice(0, SHOWN_MAX);
	if (!isUnder(dir, [root], path.sep))
		return `a git call (${shown}) read another checkout of this repository`;
	const cwd = toPosix(path.relative(root, dir)) || ".";
	if (isScratch(cwd)) return null;
	if (steered) return `a git call (${shown}) was steered by a git-dir variable`;
	let i = 0;
	while (i < args.length && String(args[i]).startsWith("-")) {
		const a = String(args[i]);
		if (a === "-C" || a.startsWith("--git-dir") || a.startsWith("--work-tree"))
			return `a git call (${shown}) named its repository`;
		i += VALUED.has(a) ? 2 : 1;
	}
	if (!RERUN.has(String(args[i])))
		return `a git call (${shown}) read this repository`;
	return { cwd, args };
}

/* How much of a call a doubt line quotes: a guess, long enough to name the
 * call, short enough to keep the cached-run banner readable. */
const SHOWN_MAX = 200;

/* Programs that run their first non-option argument as a script. */
const SCRIPT_RUNNERS = new Set(["bash", "sh", "python3", "python"]);

/**
 * Why a spawned child leaves its file's reads unknown, or null where its
 * reads are seen.
 * @param {Entry} e
 * @param {Map<number, Entry[]>} logs
 * @param {string} root real path
 * @param {(p: string) => boolean} isScratch
 * @returns {string|null}
 */
function childDoubt(e, logs, root, isScratch) {
	const file = String(e.file);
	const name = path.basename(file);
	const args = /** @type {string[]} */ (e.args ?? []);
	const shown = `${name} ${args.join(" ")}`.slice(0, SHOWN_MAX);
	if (e.audited && isNode(file)) {
		if (typeof e.pid !== "number")
			return `a Node child (${shown}) never started`;
		return logs.has(e.pid) ? null : `a Node child (${shown}) left no audit log`;
	}
	if (e.guarded && e.audited) return null;
	const cwd = String(e.cwd);
	if (
		isUnder(cwd, [root], path.sep) &&
		!isScratch(toPosix(path.relative(root, cwd)))
	)
		return `a child (${shown}) ran in the checkout`;
	const script = scriptOf(e, root);
	if (args.some((a) => a !== script && namesCheckout(a, root, isScratch)))
		return `a child (${shown}) was handed a path in the checkout`;
	if (script !== null && isNode(file))
		return `a Node child (${shown}) ran without the audit`;
	return null;
}

/**
 * Whether an argument names a path under the root outside a test's scratch.
 * @param {string} a
 * @param {string} root real path
 * @param {(p: string) => boolean} isScratch
 */
function namesCheckout(a, root, isScratch) {
	const at = a.indexOf(root);
	if (at < 0) return false;
	const rest = a.slice(at + root.length).split(/[\s"';:]/)[0] ?? "";
	return !isScratch(rest.replace(/^\//, ""));
}

/**
 * The checkout script a runner child was handed: a read, whose own loads the
 * lexical reach keys. Null where it was handed none.
 * @param {Entry} e
 * @param {string} root real path
 * @returns {string|null} the argument as given
 */
function scriptOf(e, root) {
	const file = String(e.file);
	if (!SCRIPT_RUNNERS.has(path.basename(file)) && !isNode(file)) return null;
	const args = /** @type {string[]} */ (e.args ?? []);
	const at = args.findIndex((a) => !a.startsWith("-"));
	if (at < 0) return null;
	if (args.slice(0, at).some((a) => a === "-c" || a === "-e" || a === "--eval"))
		return null;
	const abs = path.resolve(String(e.cwd), String(args[at]));
	return isUnder(abs, [root], path.sep) && pathKind(abs) === "file"
		? String(args[at])
		: null;
}

/**
 * The checkout script a child ran, repo-relative, as a read.
 * @param {Entry} e
 * @param {string} root real path
 * @returns {string[]}
 */
function childReads(e, root) {
	const script = scriptOf(e, root);
	if (script === null) return [];
	return [toPosix(path.relative(root, path.resolve(String(e.cwd), script)))];
}

/** @param {string} p */
const toPosix = (p) => p.split(path.sep).join("/");

/** @param {string} file */
const isNode = (file) =>
	file === process.execPath || path.basename(file) === "node";

module.exports = { install, readAudits, remove };
