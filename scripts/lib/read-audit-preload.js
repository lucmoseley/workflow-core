/*
 * read-audit-preload.js — records what a test process really reads of the
 * checkout under test (#4916), for the pass store (lib/pass-store.js) to key
 * a test file's row on. lib/read-audit.js puts it on `NODE_OPTIONS` for a
 * suite run, so every vitest worker and every Node child a test spawns with
 * the environment it inherited loads it first.
 *
 * WHAT IT RECORDS, each path under `WFC_READ_AUDIT_ROOT` and outside every
 * `node_modules`: a file's content read through `fs`; a directory's listing,
 * keyed on the names it returned; a probe with what it found; a recursive walk or copy of a tree; and every child
 * process spawned, sync or not, with its program, the file that name resolves
 * to, its arguments, working directory and whether it carries this audit on.
 *
 * ATTRIBUTION is by process: vitest's forks pool gives every test file a
 * process of its own, which `claim` names; `WFC_READ_AUDIT_OWNER`, the first
 * audited process's pid, charges every child's reads to the file it
 * claimed. Each process appends its log, `<dir>/<owner>.<pid>.jsonl`; a process that
 * cannot open one leaves none, which lib/read-audit.js reads as a doubt.
 *
 * It never throws into the code it watches: a fault in a hook drops the
 * record and marks the log, which reads as a doubt too.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { relativeUnder } = require("./is-under.js");
const { listingId } = require("./listing-id.js");
const { pathKind } = require("./path-kind.js");
const SELF = require("node:url").pathToFileURL(__filename).href;

/* Loaded by `--import`, which sends the main script through the ESM loader;
 * that refuses an extension it does not know, where plain node runs it as
 * CommonJS. */
/** @typedef {{ format?: string }} LoadContext */
/** @typedef {(url: string, context: LoadContext) => unknown} NextLoad */
/* Node 22.15's sync hooks; this @types/node predates them. */
const { registerHooks } =
	/** @type {{ registerHooks: (h: { load: (url: string, context: LoadContext, next: NextLoad) => unknown }) => void }} */ (
		/** @type {unknown} */ (require("node:module"))
	);
registerHooks({
	load(url, context, next) {
		try {
			return next(url, context);
		} catch (e) {
			if (caught(e).code !== "ERR_UNKNOWN_FILE_EXTENSION") throw e;
			return next(url, { ...context, format: "commonjs" });
		}
	},
});

const DIR = process.env.WFC_READ_AUDIT;
const ROOT = process.env.WFC_READ_AUDIT_ROOT;

/* The global the audit's api hangs on, for vitest.setup.ts to claim with. */
const scope =
	/** @type {{ __wfcReadAudit?: { claim: (file: string) => void } }} */ (
		/** @type {unknown} */ (globalThis)
	);

/**
 * An `fs` function's argument or result, of whatever type that function
 * takes; also Node's internal spawn bindings, which carry no types.
 * @typedef {any} Untyped
 */

if (DIR && ROOT && !scope.__wfcReadAudit) install();

function install() {
	const dir = /** @type {string} */ (DIR);
	const root = /** @type {string} */ (ROOT);
	const owner = process.env.WFC_READ_AUDIT_OWNER ?? String(process.pid);
	process.env.WFC_READ_AUDIT_OWNER = owner;
	/* Appended as each read happens, not at exit: vitest stops a worker
	 * without one. */
	let log;
	try {
		log = fs.openSync(path.join(dir, `${owner}.${process.pid}.jsonl`), "a");
	} catch {
		return;
	}
	const fd = log;
	/** @type {Set<string>} */
	const seen = new Set();
	/** @param {Record<string, unknown>} e */
	const add = (e) => {
		const line = JSON.stringify(e);
		if (seen.has(line)) return;
		seen.add(line);
		fs.writeSync(fd, `${line}\n`);
	};
	add({ k: "self", owner, pid: process.pid });
	const fault = () => {
		try {
			add({ k: "fault" });
		} catch {
			// The log will not take it: its reads are already short.
		}
	};
	/**
	 * `p` repo-relative where it names a path under the root outside every
	 * `node_modules`, else null.
	 * @param {unknown} p
	 */
	const rel = (p) => {
		let s;
		if (typeof p === "string") s = p;
		else if (Buffer.isBuffer(p)) s = p.toString();
		else if (p instanceof URL) {
			if (p.protocol !== "file:") return null;
			s = decodeURIComponent(p.pathname);
		} else return null;
		const r = relativeUnder(root, path.resolve(s));
		if (r === null) return null;
		const posix = (r || ".").split(path.sep).join("/");
		return posix.split("/").includes("node_modules") ? null : posix;
	};

	/** @param {() => void} f */
	const guard = (f) => {
		try {
			f();
		} catch {
			fault();
		}
	};

	/** What stands at `abs` now, through the `statSync` this does not wrap. */
	const kindAt = (/** @type {string} */ abs) => pathKind(abs, realStatSync);

	/** @param {unknown} p */
	const probe = (p) =>
		guard(() => {
			const r = rel(p);
			if (r !== null) add({ k: "probe", p: r, s: kindAt(path.join(root, r)) });
		});

	/**
	 * @param {unknown} p
	 * @param {unknown} names what the listing returned, or undefined on a fault
	 */
	const list = (p, names) =>
		guard(() => {
			const r = rel(p);
			if (r === null) return;
			if (!Array.isArray(names)) {
				add({ k: "probe", p: r, s: kindAt(path.join(root, r)) });
				return;
			}
			const flat = names.map(nameOf);
			add({ k: "list", p: r, id: listingId(flat) });
		});

	/** @param {unknown} p */
	const tree = (p) =>
		guard(() => {
			const r = rel(p);
			if (r !== null) add({ k: "tree", p: r });
		});

	const realStatSync = fs.statSync;
	const realAccessSync = fs.accessSync;
	const realRealpathSync = fs.realpathSync;

	/**
	 * Wrap `obj[name]`, calling `on(args, result)` once it returns or settles,
	 * with no result where it threw or failed.
	 * @param {Untyped} obj
	 * @param {string} name
	 * @param {(args: Untyped[], result?: Untyped) => void} on
	 * @param {"sync"|"callback"|"promise"} shape
	 */
	const wrap = (obj, name, on, shape) => {
		const orig = obj?.[name];
		if (typeof orig !== "function") return;
		const wrapped = {
			/** @param {Untyped[]} args */
			[name](...args) {
				if (shape === "sync") {
					let out;
					try {
						out = orig.apply(this, args);
					} catch (e) {
						on(args);
						throw e;
					}
					on(args, out);
					return out;
				}
				if (shape === "promise") {
					return orig.apply(this, args).then(
						(/** @type {Untyped} */ out) => {
							on(args, out);
							return out;
						},
						(/** @type {Untyped} */ e) => {
							on(args);
							throw e;
						},
					);
				}
				const cb = args.at(-1);
				if (typeof cb !== "function") {
					on(args);
					return orig.apply(this, args);
				}
				args[args.length - 1] = (
					/** @type {Untyped} */ e,
					/** @type {Untyped} */ out,
				) => {
					on(args, e ? undefined : out);
					return cb(e, out);
				};
				return orig.apply(this, args);
			},
		}[name];
		Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(orig));
		obj[name] = wrapped;
	};

	/** @param {Untyped[]} a */
	const probeFirst = (a) => probe(a[0]);
	/** @param {Untyped[]} a @param {Untyped} [out] */
	const listing = (a, out) => {
		const opts = a[1];
		if (opts && typeof opts === "object" && opts.recursive) tree(a[0]);
		else list(a[0], out);
	};
	/** @param {Untyped[]} a */
	const copy = (a) => {
		const opts = a[2];
		if (opts && typeof opts === "object" && opts.recursive) tree(a[0]);
		else probe(a[0]);
	};
	/** @param {Untyped[]} a */
	const glob = (a) => {
		const opts = a[1];
		tree(
			opts && typeof opts === "object" && opts.cwd ? opts.cwd : process.cwd(),
		);
	};
	/** A directory handle lists what its reads return; one is all names. */
	/** @param {Untyped[]} a */
	const opendir = (a) => tree(a[0]);

	const reads = [
		"readFile",
		"open",
		"access",
		"stat",
		"lstat",
		"exists",
		"realpath",
		"readlink",
	];
	for (const name of reads) {
		wrap(fs, `${name}Sync`, probeFirst, "sync");
		wrap(fs, name, probeFirst, "callback");
		wrap(fs.promises, name, probeFirst, "promise");
	}
	wrap(fs, "createReadStream", probeFirst, "sync");
	wrap(fs.realpathSync, "native", probeFirst, "sync");
	wrap(fs, "readdirSync", listing, "sync");
	wrap(fs, "readdir", listing, "callback");
	wrap(fs.promises, "readdir", listing, "promise");
	wrap(fs, "opendirSync", opendir, "sync");
	wrap(fs, "opendir", opendir, "callback");
	wrap(fs.promises, "opendir", opendir, "promise");
	/* A directory the test mints is its own scratch, not the checkout. */
	/** @param {Untyped[]} _a @param {Untyped} [out] */
	const minted = (_a, out) =>
		guard(() => {
			const r = typeof out === "string" ? rel(out) : null;
			if (r !== null) add({ k: "minted", p: r });
		});
	wrap(fs, "mkdtempSync", minted, "sync");
	wrap(fs, "mkdtemp", minted, "callback");
	wrap(fs.promises, "mkdtemp", minted, "promise");
	wrap(fs, "cpSync", copy, "sync");
	wrap(fs, "cp", copy, "callback");
	wrap(fs.promises, "cp", copy, "promise");
	wrap(fs, "copyFileSync", probeFirst, "sync");
	wrap(fs, "copyFile", probeFirst, "callback");
	wrap(fs.promises, "copyFile", probeFirst, "promise");
	wrap(fs, "globSync", glob, "sync");
	wrap(fs, "glob", glob, "callback");
	wrap(fs.promises, "glob", glob, "sync");
	wrap(fs, "watch", probeFirst, "sync");
	wrap(fs, "watchFile", probeFirst, "sync");
	require("node:module").syncBuiltinESMExports();

	/* Children: the bindings every spawn API reaches, sync and async. */
	const audited = (/** @type {unknown} */ envPairs) =>
		Array.isArray(envPairs) &&
		envPairs.includes(`WFC_READ_AUDIT=${dir}`) &&
		envPairs.includes(`WFC_READ_AUDIT_OWNER=${owner}`) &&
		envPairs.some(
			(e) =>
				typeof e === "string" &&
				e.startsWith("NODE_OPTIONS=") &&
				e.includes(SELF),
		);
	/** The directories on the `PATH` a child was handed. */
	const pathDirs = (/** @type {unknown} */ envPairs) => {
		const pairs = Array.isArray(envPairs) ? envPairs : [];
		const at = pairs.find(
			(e) => typeof e === "string" && e.startsWith("PATH="),
		);
		return String(at ?? "")
			.slice(5)
			.split(path.delimiter);
	};
	/* A bare `git` whose PATH puts the host git guard first: the guard logs
	 * what it reads of this repository. */
	const guarded = (/** @type {Untyped} */ opts) =>
		opts?.file === "git" &&
		path.basename(pathDirs(opts?.envPairs)[0] ?? "") === "host-git-guard";
	const isRunnable = (/** @type {string} */ abs) => {
		try {
			realAccessSync(abs, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	};
	/**
	 * The file a child's program name runs: a name holding a slash off its
	 * working directory, a bare one the first executable file on its `PATH`,
	 * links followed. Null where none stands there.
	 * @param {string} file
	 * @param {string} cwd
	 * @param {unknown} envPairs
	 */
	const binOf = (file, cwd, envPairs) => {
		const tries = file.includes("/")
			? [path.resolve(cwd, file)]
			: pathDirs(envPairs).map((entry) => path.resolve(cwd, entry, file));
		const hit = tries.find((abs) => kindAt(abs) === "file" && isRunnable(abs));
		return hit === undefined ? null : realRealpathSync(hit);
	};
	/** @param {Untyped} opts @param {number|undefined} pid */
	const spawned = (opts, pid) =>
		guard(() => {
			const file = String(opts?.file ?? "");
			const cwd = path.resolve(
				typeof opts?.cwd === "string" ? opts.cwd : process.cwd(),
			);
			add({
				k: "child",
				file,
				bin: binOf(file, cwd, opts?.envPairs),
				args: Array.isArray(opts?.args) ? opts.args.slice(1).map(String) : [],
				cwd,
				audited: audited(opts?.envPairs),
				guarded: guarded(opts),
				pid: pid ?? null,
			});
		});
	const bindings = /** @type {Untyped} */ (process).binding;
	const quiet = process.noDeprecation;
	process.noDeprecation = true;
	try {
		const sync = bindings("spawn_sync");
		const syncSpawn = sync.spawn;
		sync.spawn = function (/** @type {Untyped[]} */ ...args) {
			const out = syncSpawn.apply(this, args);
			spawned(args[0], out?.pid);
			return out;
		};
		const Process = bindings("process_wrap").Process;
		const asyncSpawn = Process.prototype.spawn;
		/* Node through 24.18 hands the handle one options object; 24.22 hands
		 * it positional `file, args, cwd, envPairs, stdio, …`. Every argument
		 * passes through. */
		Process.prototype.spawn = function (/** @type {Untyped[]} */ ...args) {
			const err = asyncSpawn.apply(this, args);
			const [first, argv, cwd, envPairs] = args;
			spawned(
				typeof first === "string"
					? { file: first, args: argv, cwd, envPairs }
					: first,
				this.pid,
			);
			return err;
		};
	} catch {
		fault();
	} finally {
		process.noDeprecation = quiet;
	}

	const api = {
		/** @param {string} file the test file this process runs */
		claim(file) {
			guard(() => {
				const r = rel(file);
				add({ k: "claim", file: r ?? String(file) });
			});
		},
	};
	scope.__wfcReadAudit = api;
}

/** @param {unknown} n */
function nameOf(n) {
	if (typeof n === "string") return n;
	if (Buffer.isBuffer(n)) return n.toString();
	return String(/** @type {{name?: unknown}} */ (n)?.name);
}
