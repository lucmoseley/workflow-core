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
 * process spawned, sync or not, with its program, the file that name runs
 * as found and with links followed, its arguments, working directory and whether it carries this audit on.
 * A worker thread started is recorded too, as a start alone: one started
 * from a string, or handed an environment of its own, loads no preload.
 *
 * A STUB OR A SHELL IT CANNOT SEE INSIDE RUNS UNDER `strace` (#4966), where
 * lib/read-audit.js found one that works: a program in the temporary
 * directory, where a test writes its stubs, a program file of the
 * checkout's own, or `sh`, `bash` or `dash`, run in the checkout or handed
 * a path there — by an argument, an environment variable or the input of a
 * sync spawn (lib/read-audit-handed.js). No other program is traced: a
 * traced process that is killed stays until its tracer reaps it, which a
 * test of what a real program leaves running would see. A test timing
 * or signalling its child sets `WFC_READ_AUDIT_UNTRACED=1` in that child's
 * environment (#4982), which runs it untraced, so it doubts where it is in
 * reach.
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
const { buildHanded } = require("./read-audit-handed.js");
const { pathKind } = require("./path-kind.js");
const {
	buildGuardTest,
	GUARD,
	isNode,
	readRealTmpdir,
	repoPath,
} = require("./read-audit-paths.js");
const { buildTraceArgv, realOf } = require("./read-audit-trace.js");
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
const STRACE = process.env.WFC_READ_AUDIT_STRACE;

/* The global the audit's api hangs on, for vitest.setup.ts to claim with. */
const scope =
	/** @type {{ __wfcReadAudit?: { claim: (file: string) => void, settle: () => void } }} */ (
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
		// No log, which the audit's reader doubts: never a throw into the
		// process this watches (#4916).
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
			// The log will not take it: its reads are already short (#4916).
		}
	};
	/**
	 * `p` repo-relative where it names a path under the root outside every
	 * `node_modules`, as spelt or, standing outside the root, with its links
	 * followed; else null.
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
		return repoPath(
			root,
			relativeUnder(root, abs) === null
				? (realOf(abs, realRealpathSync.native) ?? abs)
				: abs,
		);
	};

	/** @param {() => void} f */
	const guard = (f) => {
		try {
			f();
		} catch {
			// A hook that faults drops its record and marks the log, which the
			// reader doubts, sooner than throw into the code it watches (#4916).
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
	const realReadFileSync = fs.readFileSync;
	const realOpenSync = fs.openSync;

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
	wrap(fs, "openAsBlob", probeFirst, "promise");
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
	const threads = require("node:worker_threads");
	threads.Worker = class Worker extends threads.Worker {
		/** @param {ConstructorParameters<typeof threads.Worker>} args */
		constructor(...args) {
			guard(() => add({ k: "worker" }));
			super(...args);
		}
	};
	require("node:module").syncBuiltinESMExports();

	/* Children: the bindings every spawn API reaches, sync and async. */
	const isAudited = (/** @type {unknown} */ envPairs) =>
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
	 * working directory, a bare one the first executable file on its `PATH`.
	 * Its path as found, then with links followed; empty where none stands
	 * there.
	 * @param {string} file
	 * @param {string} cwd
	 * @param {unknown} envPairs
	 */
	const binOf = (file, cwd, envPairs) => {
		const tries = file.includes("/")
			? [path.resolve(cwd, file)]
			: pathDirs(envPairs).map((entry) => path.resolve(cwd, entry, file));
		const hit = tries.find((abs) => kindAt(abs) === "file" && isRunnable(abs));
		return hit === undefined ? [] : [hit, realRealpathSync(hit)];
	};
	/** A child's working directory, its links followed where it stands. */
	const cwdOf = (/** @type {Untyped} */ opts) => {
		const cwd = path.resolve(
			typeof opts?.cwd === "string" ? opts.cwd : process.cwd(),
		);
		try {
			return realRealpathSync(cwd);
		} catch {
			return cwd;
		}
	};
	const stands = (/** @type {string} */ abs) => {
		try {
			realRealpathSync(abs);
			return true;
		} catch {
			return false;
		}
	};
	const isGuard = buildGuardTest(realRealpathSync);
	/* A bare `git` its PATH finds as the host git guard, known by its real
	 * file, which logs what it reads of this repository where it carries the
	 * audit. */
	const isGuarded = (/** @type {Untyped} */ opts) =>
		opts?.file === "git" &&
		isGuard(binOf(opts.file, cwdOf(opts), opts?.envPairs)[1]) &&
		isAudited(opts?.envPairs);
	/** Whether the file starts as the kernel runs one: a `#!` line, or ELF. */
	const isProgram = (/** @type {string} */ abs) => {
		const head = Buffer.alloc(4);
		const at = realOpenSync(abs, "r");
		try {
			fs.readSync(at, head, 0, 4, 0);
		} finally {
			fs.closeSync(at);
		}
		return head.toString("latin1", 0, 2) === "#!" || head.equals(ELF);
	};
	/**
	 * Whether this process already runs under one of this audit's tracers,
	 * which follows every child it spawns; a second tracer would be refused.
	 */
	const isUnderTracer = () => {
		const status = realReadFileSync("/proc/self/status", "utf8");
		const tracer = /^TracerPid:\t(\d+)$/m.exec(status)?.[1];
		if (!tracer || tracer === "0") return false;
		const words = realReadFileSync(`/proc/${tracer}/cmdline`, "utf8");
		return words.split("\0").some((w) => path.dirname(w) === dir);
	};
	let traces = 0;
	const tmp = readRealTmpdir(realRealpathSync);
	const isStub = (/** @type {string[]} */ bin) =>
		bin.some((at) => relativeUnder(tmp, at) !== null);
	/** A program file in the checkout, outside every `node_modules`. */
	const isOurs = (/** @type {string[]} */ bin) =>
		bin.some((at) => rel(at) !== null);
	const argvOf = (/** @type {Untyped} */ opts) =>
		Array.isArray(opts?.args) ? opts.args.map(String) : [];
	/** A child whose reads a log of its own holds: audited Node, guarded git. */
	const isSelfLogging = (/** @type {Untyped} */ opts) =>
		isGuarded(opts) ||
		(isNode(String(opts?.file ?? "")) && isAudited(opts?.envPairs));
	const handed = buildHanded(root);
	const guardDir = rel(path.dirname(GUARD));
	/* The environment every child of this run inherits untouched, as the
	 * suite's setup left it: `settle` writes it down and names the file for
	 * the processes below. */
	let standing = readStanding(process.env.WFC_READ_AUDIT_STANDING);
	/**
	 * The checkout paths a variable's value names, less what the audit and
	 * the program lookup put there themselves: the root this audit was told,
	 * this preload on `NODE_OPTIONS`, and on `PATH` the git guard, which logs
	 * its own reads, and every `node_modules`, which the audit leaves out.
	 * @param {string} name
	 * @param {string} value
	 * @param {string} cwd
	 */
	const envPaths = (name, value, cwd) => {
		if (name === "WFC_READ_AUDIT_ROOT") return [];
		const paths = handed.named(
			name === "NODE_OPTIONS" ? value.split(SELF).join("") : value,
			cwd,
		);
		if (name !== "PATH") return paths;
		return paths.filter(
			(p) => p !== guardDir && !p.split("/").includes("node_modules"),
		);
	};
	/** The git that is no stub: its file outside the checkout and the tmpdir. */
	const isRealGit = (/** @type {string} */ file, /** @type {string[]} */ bin) =>
		path.basename(file) === "git" &&
		bin.length > 0 &&
		!bin.some((at) => relativeUnder(root, at) !== null) &&
		!isStub(bin);
	/** @typedef {import("./read-audit-handed.js").Hand} Hand */
	/**
	 * Real git is weighed only on the variables it reads a path from itself
	 * (#4982). Residual: a hook, alias or helper git runs inherits the rest
	 * unweighed; in the checkout's repository the guard's log doubts the
	 * call, and in a fixture's the hook is the test's own file.
	 * @param {Untyped} opts
	 * @param {string} cwd
	 * @returns {Hand[]}
	 */
	const envHands = (opts, cwd) => {
		const file = String(opts?.file ?? "");
		const gitOnly = isRealGit(file, binOf(file, cwd, opts?.envPairs));
		const pairs = Array.isArray(opts?.envPairs)
			? opts.envPairs.map(String)
			: [];
		return pairs.flatMap((/** @type {string} */ pair) => {
			const eq = pair.indexOf("=");
			const name = pair.slice(0, eq);
			const value = pair.slice(eq + 1);
			if (gitOnly && !GIT_READS.test(name)) return [];
			const p = envPaths(name, value, cwd);
			if (p.length === 0) return [];
			return [{ by: "env", name, standing: standing[name] === value, p }];
		});
	};
	/**
	 * Residual (#4982): input written to a child's pipe after the spawn never
	 * passes here, and no rule sees it; only a sync spawn's `input` does.
	 * @param {Untyped} opts
	 * @param {string} cwd
	 * @returns {Hand[]}
	 */
	const stdinHands = (opts, cwd) => {
		const input = Array.isArray(opts?.stdio) ? opts.stdio[0]?.input : null;
		if (!ArrayBuffer.isView(input)) return [];
		const { buffer, byteOffset, byteLength } = input;
		const text = Buffer.from(buffer, byteOffset, byteLength).toString("latin1");
		const p = handed.named(text, cwd);
		return p.length === 0 ? [] : [{ by: "stdin", p }];
	};
	/**
	 * A git no guard logs, in a directory under the root with no repository
	 * of its own between: it reads the checkout's (#4982). `init` and `clone`
	 * make one and read none; `GIT_DIR` is weighed as a variable.
	 * @param {Untyped} opts
	 * @param {string} cwd
	 * @returns {Hand[]}
	 */
	const repoHands = (opts, cwd) => {
		const words = argvOf(opts).slice(1);
		const isGit = path.basename(String(opts?.file ?? "")) === "git";
		if (!isGit || !relativeUnder(root, cwd)) return [];
		if (words[0] === "init" || words[0] === "clone") return [];
		if (
			argvOf({ args: opts?.envPairs }).some((/** @type {string} */ p) =>
				p.startsWith("GIT_DIR="),
			)
		)
			return [];
		for (let at = cwd; at !== root; at = path.dirname(at))
			if (stands(path.join(at, ".git"))) return [];
		return [{ by: "repo", p: ["."] }];
	};
	/**
	 * What hands a child paths in the checkout; none for a child that logs
	 * its own reads.
	 * @param {Untyped} opts
	 * @returns {Hand[]}
	 */
	const handsOf = (opts) => {
		if (isSelfLogging(opts)) return [];
		const cwd = cwdOf(opts);
		const words = argvOf(opts).slice(1);
		return [
			...words.flatMap(
				(/** @type {string} */ word, /** @type {number} */ at) => {
					const p = handed.named(word, cwd);
					return p.length === 0 ? [] : [{ by: "arg", at, p }];
				},
			),
			...envHands(opts, cwd),
			...stdinHands(opts, cwd),
			...repoHands(opts, cwd),
		];
	};
	/**
	 * Whether a child stands in the checkout, runs a file there or is handed
	 * a path there.
	 * @param {Untyped} opts
	 * @param {string} cwd
	 * @param {Hand[]} hands
	 */
	const isInReach = (opts, cwd, hands) =>
		relativeUnder(root, cwd) !== null ||
		hands.length > 0 ||
		isOurs(binOf(String(opts?.file ?? ""), cwd, opts?.envPairs));
	/**
	 * Whether the tracer can run a child in its place: a shell, a stub, or a
	 * program file of the checkout's own.
	 * @param {Untyped} opts
	 * @param {string} cwd
	 */
	const isTraceable = (opts, cwd) => {
		const file = String(opts?.file ?? "");
		const argv = argvOf(opts);
		/* A child launching the tracer on a program of its own would be
		 * refused it under this one (#4982). */
		if (argv.includes(String(STRACE))) return false;
		/* The tracer runs the program by its name, as the spawn would: only a
		 * name the spawn passes as the program's own first word, found as a
		 * file the kernel runs with no shell's help. */
		if (opts?.envPairs?.includes?.("WFC_READ_AUDIT_UNTRACED=1")) return false;
		const bin = binOf(file, cwd, opts?.envPairs);
		if (argv[0] !== file || bin.length === 0 || !isProgram(String(bin[1])))
			return false;
		if (!SHELLS.has(path.basename(file)) && !isStub(bin) && !isOurs(bin))
			return false;
		/* The tracer would hold a fourth descriptor, a channel among them,
		 * open past the child: only the two outputs are kept from it. */
		return !(Array.isArray(opts?.stdio) && opts.stdio.length > 3);
	};
	/**
	 * How a child's reads will be seen: `within` where a tracer already
	 * follows this process, the trace file's name where this runs it under
	 * one of its own, else null.
	 * @typedef {{within: true}|{trace: string}|null} Route
	 */
	/**
	 * @param {Untyped} opts
	 * @param {Hand[]} hands
	 * @returns {Route}
	 */
	const routeOf = (opts, hands) => {
		const cwd = cwdOf(opts);
		if (!STRACE || !isInReach(opts, cwd, hands) || isSelfLogging(opts))
			return null;
		if (!isTraceable(opts, cwd)) return null;
		return { trace: `${owner}.${process.pid}.${++traces}.trace` };
	};
	/**
	 * @param {Untyped} opts
	 * @returns {{opts: Untyped, route: Route, hands: Hand[]}}
	 */
	const buildTracedSpawn = (opts) => {
		try {
			/* A tracer already following this process follows the child too,
			 * and would take the hands' lookups for reads of its own. */
			if (STRACE && isUnderTracer())
				return { opts, route: { within: true }, hands: [] };
			const hands = handsOf(opts);
			const route = routeOf(opts, hands);
			if (!route || !("trace" in route)) return { opts, route, hands };
			const args = buildTraceArgv(
				String(STRACE),
				path.join(dir, route.trace),
				argvOf(opts),
			);
			return { opts: { ...opts, file: args[0], args }, route, hands };
		} catch {
			// The child runs as the test spawned it, untraced, and the log is
			// marked, which the reader doubts (#4966).
			fault();
			return { opts, route: null, hands: [] };
		}
	};
	/**
	 * @param {Untyped} opts as the test spawned it
	 * @param {number|undefined} pid
	 * @param {Route} route
	 * @param {Hand[]} hands
	 */
	const logChild = (opts, pid, route, hands) =>
		guard(() => {
			const file = String(opts?.file ?? "");
			const cwd = cwdOf(opts);
			add({
				k: "child",
				file,
				bin: binOf(file, cwd, opts?.envPairs),
				args: Array.isArray(opts?.args) ? opts.args.slice(1).map(String) : [],
				cwd,
				audited: isAudited(opts?.envPairs),
				guarded: isGuarded(opts),
				pid: pid ?? null,
				...(hands.length > 0 ? { hands } : {}),
				...route,
			});
		});
	const bindings = /** @type {Untyped} */ (process).binding;
	const quiet = process.noDeprecation;
	process.noDeprecation = true;
	try {
		const sync = bindings("spawn_sync");
		const syncSpawn = sync.spawn;
		sync.spawn = function (/** @type {Untyped[]} */ ...args) {
			const { opts, route, hands } = buildTracedSpawn(args[0]);
			const out = syncSpawn.apply(this, [opts, ...args.slice(1)]);
			logChild(args[0], out?.pid, route, hands);
			return out;
		};
		const Process = bindings("process_wrap").Process;
		const asyncSpawn = Process.prototype.spawn;
		/* Node through 24.18 hands the handle one options object; 24.22 hands
		 * it positional `file, args, cwd, envPairs, stdio, …`. */
		Process.prototype.spawn = function (/** @type {Untyped[]} */ ...args) {
			const [first, argv, cwd, envPairs] = args;
			const positional = typeof first === "string";
			const asked = positional
				? { file: first, args: argv, cwd, envPairs }
				: first;
			const { opts, route, hands } = buildTracedSpawn(asked);
			const err = asyncSpawn.apply(
				this,
				positional
					? [opts.file, opts.args, ...args.slice(2)]
					: [opts, ...args.slice(1)],
			);
			logChild(asked, this.pid, route, hands);
			return err;
		};
	} catch {
		// A Node whose spawn bindings will not patch runs its children
		// unlogged: the log is marked, which the reader doubts (#4916).
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
		settle() {
			guard(() => {
				standing = { ...process.env };
				const file = path.join(dir, `${owner}.standing.json`);
				fs.writeFileSync(file, JSON.stringify(standing));
				process.env.WFC_READ_AUDIT_STANDING = file;
			});
		},
	};
	scope.__wfcReadAudit = api;
}

/**
 * The environment a suite's setup settled, off the file it wrote; none
 * where it wrote none or the file will not read.
 * @param {string|undefined} file
 * @returns {Record<string, string|undefined>}
 */
function readStanding(file) {
	if (!file) return {};
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

const SHELLS = new Set(["sh", "bash", "dash"]);

const ELF = Buffer.from("\x7fELF", "latin1");

/* The variables git reads a path from: its own, and where its configuration
 * lives (git(1), ENVIRONMENT VARIABLES; git-config(1), FILES). */
const GIT_READS = /^(GIT_.*|HOME|XDG_CONFIG_HOME)$/;

/** @param {unknown} n */
function nameOf(n) {
	if (typeof n === "string") return n;
	if (Buffer.isBuffer(n)) return n.toString();
	return String(/** @type {{name?: unknown}} */ (n)?.name);
}
