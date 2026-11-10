/*
 * read-audit-preload.js — records what a test process really reads of the
 * checkout under test (#4916), for the pass store (lib/pass-store.js) to key
 * a test file's row on. lib/read-audit.js puts it on `NODE_OPTIONS` for a
 * suite run, so every vitest worker and every Node child a test spawns with
 * the environment it inherited loads it first.
 *
 * WHAT IT RECORDS, each path under `WFC_READ_AUDIT_ROOT` and outside every
 * `node_modules`: a file's content read through `fs`; a directory's listing,
 * with the names it returned; a probe (`stat`, `exists`, `access`, `realpath`)
 * with what it found; a recursive walk or copy of a tree; and every child
 * process spawned, sync or not, with its program, arguments, working
 * directory and whether it carries this audit on. A path that will not
 * resolve to one under the root is no read of it.
 *
 * ATTRIBUTION is by process: vitest's forks pool gives every test file a
 * process of its own, which `claim` names; `WFC_READ_AUDIT_OWNER`, the first
 * audited process's pid, carries that name to every child. Each process
 * appends its log, `<dir>/<owner>.<pid>.jsonl`, as it reads; a process that
 * cannot open one leaves none, which lib/read-audit.js reads as a doubt.
 *
 * It never throws into the code it watches: a fault in a hook drops the
 * record and marks the log, which reads as a doubt too.
 */

const fs = require("node:fs");
const path = require("node:path");
const { listingId } = require("./listing-id.js");
const SELF = require("node:url").pathToFileURL(__filename).href;

/* Loaded by `--import`, which sends the main script through the ESM loader;
 * that refuses an extension it does not know (a `typeperf.exe` stub with a
 * node shebang), where plain node runs it as CommonJS. This puts it back. */
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
			if (/** @type {any} */ (e)?.code !== "ERR_UNKNOWN_FILE_EXTENSION")
				throw e;
			return next(url, { ...context, format: "commonjs" });
		}
	},
});

const DIR = process.env.WFC_READ_AUDIT;
const ROOT = process.env.WFC_READ_AUDIT_ROOT;

if (DIR && ROOT && !(/** @type {any} */ (globalThis).__wfcReadAudit)) install();

function install() {
	const dir = /** @type {string} */ (DIR);
	const root = /** @type {string} */ (ROOT);
	const owner = process.env.WFC_READ_AUDIT_OWNER ?? String(process.pid);
	process.env.WFC_READ_AUDIT_OWNER = owner;
	/* Appended as each read happens, not at exit: vitest stops a worker
	 * without one. A process that cannot open its log records nothing and
	 * leaves none, which reads as a doubt. */
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
	const prefix = root.endsWith(path.sep) ? root : root + path.sep;

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
		const abs = path.resolve(s);
		if (abs !== root && !abs.startsWith(prefix)) return null;
		const r = abs === root ? "." : abs.slice(prefix.length);
		const posix = r.split(path.sep).join("/");
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

	/**
	 * What stands at `abs` now: file, dir, absent or other.
	 * @param {string} abs
	 */
	const kindAt = (abs) => {
		try {
			const st = realStatSync(abs);
			if (st.isFile()) return "file";
			return st.isDirectory() ? "dir" : "other";
		} catch (e) {
			const code = /** @type {{code?: string}} */ (e).code;
			return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "other";
		}
	};

	/** @param {unknown} p */
	const read = (p) =>
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

	/**
	 * Wrap `obj[name]`, calling `before(args)` ahead of it and `after(args,
	 * result)` behind a sync return.
	 * @param {any} obj
	 * @param {string} name
	 * @param {(args: any[], result?: any) => void} on
	 * @param {"sync"|"callback"|"promise"} shape
	 */
	const wrap = (obj, name, on, shape) => {
		const orig = obj?.[name];
		if (typeof orig !== "function") return;
		const wrapped = {
			/** @param {any[]} args */
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
						(/** @type {any} */ out) => {
							on(args, out);
							return out;
						},
						(/** @type {any} */ e) => {
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
					/** @type {any} */ e,
					/** @type {any} */ out,
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

	/** @param {any[]} a */
	const first = (a) => read(a[0]);
	/** @param {any[]} a @param {any} [out] */
	const listing = (a, out) => {
		const opts = a[1];
		if (opts && typeof opts === "object" && opts.recursive) tree(a[0]);
		else list(a[0], out);
	};
	/** @param {any[]} a */
	const copy = (a) => {
		const opts = a[2];
		if (opts && typeof opts === "object" && opts.recursive) tree(a[0]);
		else read(a[0]);
	};
	/** @param {any[]} a */
	const glob = (a) => {
		const opts = a[1];
		tree(
			opts && typeof opts === "object" && opts.cwd ? opts.cwd : process.cwd(),
		);
	};
	/** A directory handle lists what its reads return; one is all names. */
	/** @param {any[]} a */
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
		wrap(fs, `${name}Sync`, first, "sync");
		wrap(fs, name, first, "callback");
		wrap(fs.promises, name, first, "promise");
	}
	wrap(fs, "createReadStream", first, "sync");
	wrap(fs.realpathSync, "native", first, "sync");
	wrap(fs, "readdirSync", listing, "sync");
	wrap(fs, "readdir", listing, "callback");
	wrap(fs.promises, "readdir", listing, "promise");
	wrap(fs, "opendirSync", opendir, "sync");
	wrap(fs, "opendir", opendir, "callback");
	wrap(fs.promises, "opendir", opendir, "promise");
	/* A directory the test mints is its own scratch, not the checkout. */
	/** @param {any[]} _a @param {any} [out] */
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
	wrap(fs, "copyFileSync", first, "sync");
	wrap(fs, "copyFile", first, "callback");
	wrap(fs.promises, "copyFile", first, "promise");
	wrap(fs, "globSync", glob, "sync");
	wrap(fs, "glob", glob, "callback");
	wrap(fs.promises, "glob", glob, "sync");
	wrap(fs, "watch", first, "sync");
	wrap(fs, "watchFile", first, "sync");
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
	/** @param {any} opts @param {number|undefined} pid */
	const spawned = (opts, pid) =>
		guard(() => {
			add({
				k: "child",
				file: String(opts?.file ?? ""),
				args: Array.isArray(opts?.args) ? opts.args.slice(1).map(String) : [],
				cwd: path.resolve(
					typeof opts?.cwd === "string" ? opts.cwd : process.cwd(),
				),
				audited: audited(opts?.envPairs),
				pid: pid ?? null,
			});
		});
	const bindings = /** @type {any} */ (process).binding;
	const quiet = process.noDeprecation;
	process.noDeprecation = true;
	try {
		const sync = bindings("spawn_sync");
		const syncSpawn = sync.spawn;
		sync.spawn = function (/** @type {any} */ opts) {
			const out = syncSpawn.call(this, opts);
			spawned(opts, out?.pid);
			return out;
		};
		const Process = bindings("process_wrap").Process;
		const asyncSpawn = Process.prototype.spawn;
		Process.prototype.spawn = function (/** @type {any} */ opts) {
			const err = asyncSpawn.call(this, opts);
			spawned(opts, this.pid);
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
	/** @type {any} */ (globalThis).__wfcReadAudit = api;
}

/**
 * A listing entry's name: a string, a Buffer, or a `Dirent`.
 * @param {unknown} n
 */
function nameOf(n) {
	if (typeof n === "string") return n;
	if (Buffer.isBuffer(n)) return n.toString();
	return String(/** @type {{name?: unknown}} */ (n)?.name);
}
