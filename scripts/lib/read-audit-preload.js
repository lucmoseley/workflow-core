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
 * as found and with links followed, its arguments, working directory and whether it carries this audit on,
 * and any checkout path the test writes down an untraced child's input pipe
 * once it runs. Each real git, and the git guard, is handed an event log of
 * the audit's, in which git names every process it starts
 * (lib/read-audit-git-events.js).
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
	GIT_VALUED,
	GUARD,
	EXITED,
	isNode,
	PATH_MAX,
	pairValue,
	STEERED_BY,
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
	/** `abs` with its links followed where it stands, else as given. */
	const realOrAsIs = (/** @type {string} */ abs) => {
		try {
			return realRealpathSync(abs);
		} catch {
			return abs;
		}
	};
	/** A child's working directory, its links followed where it stands. */
	const cwdOf = (/** @type {Untyped} */ opts) =>
		realOrAsIs(
			path.resolve(typeof opts?.cwd === "string" ? opts.cwd : process.cwd()),
		);
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
	const isGuardedBy = (
		/** @type {string} */ file,
		/** @type {string[]} */ bin,
		/** @type {boolean} */ audited,
	) => file === "git" && isGuard(bin[1]) && audited;
	const isGuarded = (/** @type {Untyped} */ opts) => {
		const file = String(opts?.file ?? "");
		return isGuardedBy(
			file,
			binOf(file, cwdOf(opts), opts?.envPairs),
			isAudited(opts?.envPairs),
		);
	};
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
	 * @param {(word: string) => string[]} named
	 */
	const envPaths = (name, value, named) => {
		if (name === "WFC_READ_AUDIT_ROOT") return [];
		const paths = named(
			name === "NODE_OPTIONS" ? value.split(SELF).join("") : value,
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
	 * (#4982): what it runs, which inherits the rest, its own event log
	 * names (`gitEventsOf`).
	 * @param {Untyped} opts
	 * @param {string} cwd
	 * @param {(word: string) => string[]} named
	 * @returns {Hand[]}
	 */
	const envHands = (opts, cwd, named) => {
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
			const p = envPaths(name, value, named);
			if (p.length === 0) return [];
			return [{ by: "env", name, standing: standing[name] === value, p }];
		});
	};
	/**
	 * A sync spawn's `input`; what is written to an async child's pipe later
	 * `watchInput` weighs.
	 * @param {Untyped} opts
	 * @returns {Hand[]}
	 */
	const stdinHands = (opts) => {
		const input = Array.isArray(opts?.stdio) ? opts.stdio[0]?.input : null;
		if (!ArrayBuffer.isView(input)) return [];
		const p = handed.from(cwdOf(opts), { text: true })(textOf(input));
		return p.length === 0 ? [] : [{ by: "stdin", p }];
	};
	/**
	 * A git no guard logs, whose directory — its own, or where its `-C`
	 * words move it — lies under the root with no repository of its own
	 * between: it reads the checkout's (#4982, #4997). `init` and `clone`
	 * look for none, but one asked for `--help` does, through `git help`.
	 * `--git-dir` and `GIT_DIR` name it, weighed as a word and a variable.
	 * @param {Untyped} opts
	 * @param {string} cwd
	 * @returns {Hand[]}
	 */
	const repoHands = (opts, cwd) => {
		if (path.basename(String(opts?.file ?? "")) !== "git") return [];
		const asked = gitDirOf(argvOf(opts).slice(1), cwd);
		if (asked === null || pairValue(opts?.envPairs, "GIT_DIR") !== undefined)
			return [];
		return repoHandAt(realOrAsIs(asked.at), asked.bare);
	};
	/**
	 * @param {string} at where the git looks for its repository, real path
	 * @param {boolean} bare whether that directory is the repository itself
	 * @returns {Hand[]}
	 */
	const repoHandAt = (at, bare) => {
		if (relativeUnder(root, at) === null) return [];
		if (bare) {
			const p = rel(at);
			return p === null ? [] : [{ by: "repo", p: [p] }];
		}
		for (let up = at; up !== root; up = path.dirname(up))
			if (stands(path.join(up, ".git"))) return [];
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
		const named = handed.from(cwd);
		const words = argvOf(opts).slice(1);
		return [
			...words.flatMap(
				(/** @type {string} */ word, /** @type {number} */ at) => {
					const p = named(word);
					return p.length === 0 ? [] : [{ by: "arg", at, p }];
				},
			),
			...envHands(opts, cwd, named),
			...stdinHands(opts),
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
	let gitLogs = 0;
	/**
	 * Where a git child logs each process it starts — a hook, an alias, a
	 * helper, a pager, each of which inherits every variable — on git's own
	 * event target (`GIT_TRACE2_EVENT`, git's api-trace2) (#4997): a file of
	 * this audit's, handed on; the one it already names, where that is this
	 * audit's (a git a hook ran); null where it names one of its own, so what
	 * it ran goes unlogged. No `events` for a child that is no real git and
	 * no guard.
	 * @param {Untyped} opts
	 * @returns {{opts: Untyped, events?: string|null}}
	 */
	const gitEventsOf = (opts) => {
		const file = String(opts?.file ?? "");
		if (path.basename(file) !== "git") return { opts };
		const bin = binOf(file, cwdOf(opts), opts?.envPairs);
		if (!isRealGit(file, bin) && !isGuard(bin[1])) return { opts };
		const pairs = Array.isArray(opts?.envPairs) ? opts.envPairs : [];
		const target = pairValue(pairs, GIT_EVENTS);
		if (target !== undefined) {
			const ours = path.dirname(target) === dir;
			return { opts, events: ours ? path.basename(target) : null };
		}
		const events = `${owner}.${process.pid}.${++gitLogs}.git-events`;
		const told = [...pairs, `${GIT_EVENTS}=${path.join(dir, events)}`];
		return { opts: { ...opts, envPairs: told }, events };
	};
	/**
	 * @typedef {{opts: Untyped, route: Route, hands: Hand[],
	 *   events?: string|null}} Spawn
	 */
	/**
	 * @param {Untyped} asked
	 * @returns {Spawn}
	 */
	const buildTracedSpawn = (asked) => {
		try {
			/* A tracer already following this process follows the child too,
			 * and would take the hands' lookups for reads of its own. */
			if (STRACE && isUnderTracer())
				return { opts: asked, route: { within: true }, hands: [] };
			const hands = handsOf(asked);
			const route = routeOf(asked, hands);
			const { opts, events } = gitEventsOf(asked);
			if (!route || !("trace" in route)) return { opts, route, hands, events };
			const args = buildTraceArgv(
				String(STRACE),
				path.join(dir, route.trace),
				argvOf(opts),
			);
			return {
				opts: { ...opts, file: args[0], args },
				route,
				hands,
				events,
			};
		} catch {
			// The child runs as the test spawned it, untraced, and the log is
			// marked, which the reader doubts (#4966).
			fault();
			return { opts: asked, route: null, hands: [] };
		}
	};
	/**
	 * Weigh what the test writes to an untraced child's input pipe once it
	 * runs, which no spawn option holds (#4997): each write with the end of
	 * the one before, so a path split across two is still whole.
	 * @param {Untyped} handle the pipe's end this process writes
	 * @param {number} pid
	 * @param {string} cwd
	 */
	const watchInput = (handle, pid, cwd) => {
		const named = handed.from(cwd, { text: true });
		let tail = "";
		const weigh = (/** @type {unknown[]} */ chunks) =>
			guard(() => {
				const text = tail + chunks.map(textOf).join("");
				tail = text.slice(-PATH_MAX);
				const p = named(text);
				if (p.length > 0) add({ k: "piped", pid, p });
			});
		for (const name of PIPE_WRITES) {
			const write = handle?.[name];
			if (typeof write !== "function") continue;
			handle[name] = function (
				/** @type {unknown} */ req,
				/** @type {Untyped} */ data,
				/** @type {unknown[]} */ ...rest
			) {
				/* `writev` takes each chunk with its encoding after it, unless
				 * all are buffers. */
				if (name === "writev") weigh(rest[0] ? data : data.filter(isEven));
				else weigh([data]);
				return write.call(this, req, data, ...rest);
			};
		}
	};
	/**
	 * Watch every pipe to an async child where nothing else sees its reads:
	 * no tracer follows it and it keeps no log of its own. A stream the test
	 * handed it whole (`wrap`) on a descriptor it may read carries what the
	 * audit cannot read: a doubt.
	 * @param {Untyped} asked
	 * @param {number|undefined} pid
	 * @param {Route} route
	 */
	const watchIfUnseen = (asked, pid, route) =>
		guard(() => {
			const stdio = Array.isArray(asked?.stdio) ? asked.stdio : [];
			if (typeof pid !== "number" || route || isSelfLogging(asked)) return;
			const cwd = cwdOf(asked);
			for (const [descriptor, entry] of stdio.entries())
				watchEntry(entry, descriptor, pid, cwd);
		});

	/**
	 * @param {Untyped} entry one of a spawn's `stdio`
	 * @param {number} descriptor its number in the child
	 * @param {number} pid
	 * @param {string} cwd
	 */
	const watchEntry = (entry, descriptor, pid, cwd) => {
		if (entry?.type === "pipe") watchInput(entry.handle, pid, cwd);
		const isOutput = descriptor === 1 || descriptor === 2;
		if (entry?.type === "wrap" && !isOutput) add({ k: "piped", pid, p: null });
	};
	/**
	 * The variables steering which program a child runs by name, or with
	 * what options, that differ from the environment the setup settled.
	 * @param {unknown} envPairs
	 */
	const steeredOf = (envPairs) =>
		STEERS.filter((name) => pairValue(envPairs, name) !== standing[name]);
	/**
	 * Append to a git child's event log, where it wrote one, that the git
	 * the test killed has exited: a git killed by a signal logs no end of
	 * its own.
	 * @param {string|null|undefined} events
	 * @param {unknown} pid
	 */
	const markExited = (events, pid) =>
		guard(() => {
			if (typeof events !== "string" || typeof pid !== "number") return;
			const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND;
			let at;
			try {
				at = realOpenSync(path.join(dir, events), flags);
			} catch {
				// A git that wrote no log is doubted for that by the reader.
				return;
			}
			try {
				fs.writeSync(at, `${JSON.stringify({ event: EXITED, pid })}\n`);
			} finally {
				fs.closeSync(at);
			}
		});
	/**
	 * Mark an async git child's log once it exits, where the test killed it
	 * through its handle while it still ran git. Exited on its own, a git
	 * logs its end; one that ran `git help` became `man` under the same
	 * pid, which no mark may vouch for.
	 * @param {Untyped} handle the child's process handle
	 * @param {string|null|undefined} events
	 */
	const markOnKill = (handle, events) =>
		guard(() => {
			const { kill, onexit } = handle;
			if (typeof events !== "string") return;
			if (typeof kill !== "function" || typeof onexit !== "function") return;
			let killedGit = false;
			handle.kill = function (/** @type {Untyped[]} */ ...args) {
				killedGit ||= isGitNow(handle.pid);
				return kill.apply(this, args);
			};
			handle.onexit = function (/** @type {Untyped[]} */ ...args) {
				if (killedGit) markExited(events, handle.pid);
				return onexit.apply(this, args);
			};
		});
	/** @param {unknown} pid whether that process runs a binary named git */
	const isGitNow = (pid) => {
		try {
			return path.basename(realRealpathSync(`/proc/${pid}/exe`)) === "git";
		} catch {
			// Gone, or not ours to read: no mark, so its open log doubts.
			return false;
		}
	};
	/**
	 * @param {Untyped} opts as the test spawned it
	 * @param {number|undefined} pid
	 * @param {Spawn} spawned
	 */
	const logChild = (opts, pid, { route, hands, events }) =>
		guard(() => {
			const file = String(opts?.file ?? "");
			const cwd = cwdOf(opts);
			const steered = steeredOf(opts?.envPairs);
			const bin = binOf(file, cwd, opts?.envPairs);
			const audited = isAudited(opts?.envPairs);
			add({
				k: "child",
				file,
				bin,
				args: Array.isArray(opts?.args) ? opts.args.slice(1).map(String) : [],
				cwd,
				audited,
				guarded: isGuardedBy(file, bin, audited),
				pid: pid ?? null,
				...(hands.length > 0 ? { hands } : {}),
				...(steered.length > 0 ? { steered } : {}),
				...(events === undefined ? {} : { events }),
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
			const spawned = buildTracedSpawn(args[0]);
			const out = syncSpawn.apply(this, [spawned.opts, ...args.slice(1)]);
			logChild(args[0], out?.pid, spawned);
			return out;
		};
		const Process = bindings("process_wrap").Process;
		const asyncSpawn = Process.prototype.spawn;
		/* Node through 24.18 hands the handle one options object; 24.22 hands
		 * it positional `file, args, cwd, envPairs, stdio, …`. */
		Process.prototype.spawn = function (/** @type {Untyped[]} */ ...args) {
			const [first, argv, cwd, envPairs, stdio] = args;
			const positional = typeof first === "string";
			const asked = positional
				? { file: first, args: argv, cwd, envPairs, stdio }
				: first;
			const spawned = buildTracedSpawn(asked);
			const { opts } = spawned;
			const err = asyncSpawn.apply(
				this,
				positional
					? [opts.file, opts.args, cwd, opts.envPairs, ...args.slice(4)]
					: [opts, ...args.slice(1)],
			);
			logChild(asked, this.pid, spawned);
			watchIfUnseen(asked, this.pid, spawned.route);
			markOnKill(this, spawned.events);
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

/* The variable naming git's event target (git's api-trace2). */
const GIT_EVENTS = "GIT_TRACE2_EVENT";

/* The variables that steer which program a child runs by name, or with
 * what options (#4997). */
const STEERS = [...new Set([...STEERED_BY.values()].flat())];

/* A pipe handle's writes, as Node's stream code calls them. */
const PIPE_WRITES = [
	"writeBuffer",
	"writev",
	"writeUtf8String",
	"writeLatin1String",
	"writeAsciiString",
	"writeUcs2String",
];

const isEven = (/** @type {unknown} */ _, /** @type {number} */ i) =>
	i % 2 === 0;

/**
 * A chunk as text: a string as it is, bytes as Latin-1, one character each.
 * @param {unknown} chunk
 */
function textOf(chunk) {
	if (typeof chunk === "string") return chunk;
	if (!ArrayBuffer.isView(chunk)) return "";
	const { buffer, byteOffset, byteLength } = chunk;
	return Buffer.from(buffer, byteOffset, byteLength).toString("latin1");
}

const ELF = Buffer.from("\x7fELF", "latin1");

/* The variables git reads a path from: its own, and where its configuration
 * lives (git(1), ENVIRONMENT VARIABLES; git-config(1), FILES). */
const GIT_READS = /^(GIT_.*|HOME|XDG_CONFIG_HOME)$/;

/**
 * Where a git call finds its repository: the directory it looks up from,
 * its own moved by each `-C` before the subcommand, or under `--bare` the
 * repository itself, the directory the `-C` words before it reached (git
 * sets `GIT_DIR` there); null where it looks for none.
 * @param {string[]} words the call's words after the program
 * @param {string} cwd
 * @returns {{at: string, bare: boolean}|null}
 */
function gitDirOf(words, cwd) {
	let moved = cwd;
	/** @type {string|null} */
	let bare = null;
	let at = 0;
	for (; at < words.length; at++) {
		const word = String(words[at]);
		if (!word.startsWith("-")) break;
		if (word.split("=")[0] === "--git-dir") return null;
		if (word === "--bare") bare = moved;
		if (word === "-C") moved = path.resolve(moved, words[at + 1] ?? "");
		if (GIT_VALUED.has(word)) at++;
	}
	if (makesItsOwn(words, at)) return null;
	return { at: bare ?? moved, bare: bare !== null };
}

/**
 * Whether the subcommand at `at` makes a repository rather than look for
 * one: an `init` or a `clone` not asked for `--help`.
 * @param {string[]} words
 * @param {number} at
 */
function makesItsOwn(words, at) {
	const sub = words[at];
	return (sub === "init" || sub === "clone") && !words.includes("--help");
}

/** @param {unknown} n */
function nameOf(n) {
	if (typeof n === "string") return n;
	if (Buffer.isBuffer(n)) return n.toString();
	return String(/** @type {{name?: unknown}} */ (n)?.name);
}
