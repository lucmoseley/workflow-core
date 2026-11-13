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
 * as found and with links followed, its arguments, working directory and
 * what lib/read-audit-provenance.js finds it is, and any checkout path the test writes down an untraced child's input pipe
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
 * It never throws into the code it watches: a fault in a hook marks the
 * log, which reads as a doubt too.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { caught } = require("./caught.js");
const { relativeUnder } = require("./is-under.js");
const { listingId } = require("./listing-id.js");
const { absoluteWords, buildHanded } = require("./read-audit-handed.js");
const { pathKind } = require("./path-kind.js");
const {
	GIT_EVENTS,
	EXITED,
	PATH_MAX,
	pairValue,
	parseStanding,
	repoPath,
} = require("./read-audit-paths.js");
const { GIT_READS, stepGitOptions } = require("./read-audit-git.js");
const { buildVerdictOf, GUARD } = require("./read-audit-provenance.js");
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
	 * @param {unknown} p
	 * @returns {string|null}
	 */
	const absOf = (p) => {
		if (typeof p === "string") return path.resolve(p);
		if (Buffer.isBuffer(p)) return path.resolve(p.toString());
		if (p instanceof URL && p.protocol === "file:")
			return path.resolve(decodeURIComponent(p.pathname));
		return null;
	};
	/**
	 * `p` repo-relative where it names a path under the root outside every
	 * `node_modules`, as spelt or, standing outside the root, with its links
	 * followed; else null.
	 * @param {unknown} p
	 */
	const rel = (p) => {
		const abs = absOf(p);
		if (abs === null) return null;
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

	/** @type {import("./read-audit-handed.js").Settled} */
	const settled = new Map();
	/* A path this process links, moves or removes moves where a settled one
	 * lands only where it is that path or beneath it, as spelt or with its
	 * links followed, or where its own lookup followed a link, whose hops
	 * the lookup does not keep (#5050); a child's go unseen. Every other
	 * lookup stands (#5132). The paths are the call's first two words,
	 * which over-counts a link's target and a copy's source. */
	const unsettle = (/** @type {Untyped[]} */ args) => {
		const changed = args.slice(0, 2).flatMap((arg) => {
			const abs = absOf(arg);
			if (abs === null) return [];
			const real = realOf(abs, realRealpathSync.native);
			return real === null || real === abs ? [abs] : [abs, real];
		});
		for (const [abs, real] of settled)
			if (real !== abs || changed.some((at) => relativeUnder(at, abs) !== null))
				settled.delete(abs);
	};
	/** @type {Map<string, import("./read-audit-handed.js").Settling>} */
	const settlings = new Map();
	/* A new standing environment: every lookup, and what each variable's
	 * standing value spells. */
	const resettle = () => {
		settled.clear();
		settlings.clear();
	};

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
	for (const name of ["symlink", "rename", "unlink", "rm", "rmdir", "cp"]) {
		wrap(fs, `${name}Sync`, unsettle, "sync");
		wrap(fs, name, unsettle, "callback");
		wrap(fs.promises, name, unsettle, "promise");
	}
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
	const argvOf = (/** @type {Untyped} */ opts) =>
		Array.isArray(opts?.args) ? opts.args.map(String) : [];
	/* A child a test ran under a TMPDIR of its own still holds the suite's
	 * stubs (#5072). */
	const ownTmp = realRealpathSync(os.tmpdir());
	const verdictOf = buildVerdictOf({
		root,
		tmps: [...new Set([process.env.WFC_READ_AUDIT_TMP ?? ownTmp, ownTmp])],
		realpath: realRealpathSync,
	});
	/** @typedef {import("./read-audit-provenance.js").Provenance} Provenance */
	/**
	 * What the child the test asked for is, for every test that weighs it
	 * and for its record.
	 * @param {Untyped} opts
	 * @param {string[]} bin
	 * @returns {Provenance}
	 */
	const provenanceOf = (opts, bin) =>
		verdictOf({
			file: String(opts?.file ?? ""),
			bin,
			args: argvOf(opts).slice(1),
			envPairs: opts?.envPairs,
			audited: isAudited(opts?.envPairs),
			standing,
		});
	/* A guarded git is never traced: the guard logs a call on this
	 * repository, and the reader weighs its hands where it logged none
	 * (#5015). */
	const isUntraceable = (/** @type {Provenance} */ prov) =>
		prov.guarded || prov.auditedNode;
	const handed = buildHanded(root);
	const guardDir = rel(path.dirname(GUARD));
	/* The environment every child of this run inherits untouched, as the
	 * suite's setup left it: `settle` writes it down and names the file for
	 * the processes below. */
	let standing = readStanding(process.env.WFC_READ_AUDIT_STANDING);
	const isOwner = owner === String(process.pid);
	/** A variable's value as weighed: this preload left off `NODE_OPTIONS`. */
	const namedText = (
		/** @type {string} */ name,
		/** @type {string} */ value,
	) => (name === "NODE_OPTIONS" ? value.split(SELF).join("") : value);
	/* A value moved off the standing one still answers, from the cache, the
	 * words it shares with it: a stub directory put before the standing
	 * `PATH` is looked up afresh, and the rest is not (#5139). */
	const settlingOf = (/** @type {string} */ name) => {
		const value = standing[name];
		if (value === undefined) return;
		let at = settlings.get(name);
		if (at === undefined) {
			at = { cache: settled, words: absoluteWords(namedText(name, value)) };
			settlings.set(name, at);
		}
		return at;
	};
	/**
	 * The checkout paths a variable's value names, less what the audit and
	 * the program lookup put there themselves: the root this audit was told,
	 * this preload on `NODE_OPTIONS`, and on `PATH` the git guard, which logs
	 * its own reads, and every `node_modules`, which the audit leaves out.
	 * @param {string} name
	 * @param {string} value
	 * @param {Named} named
	 */
	const envPaths = (name, value, named) => {
		if (name === "WFC_READ_AUDIT_ROOT") return [];
		const paths = named(namedText(name, value), settlingOf(name));
		if (name !== "PATH") return paths;
		return paths.filter(
			(p) => p !== guardDir && !p.split("/").includes("node_modules"),
		);
	};
	/** @typedef {import("./read-audit-handed.js").Hand} Hand */
	/** @typedef {ReturnType<ReturnType<typeof buildHanded>["from"]>} Named */
	/**
	 * Real git, and the guard that runs it, is weighed only on the variables
	 * git reads a path from itself (#4982, #5015): what it runs, which
	 * inherits the rest, its own event log names (`gitEventsOf`).
	 * @param {Untyped} opts
	 * @param {Named} named
	 * @param {Provenance} prov
	 * @returns {Hand[]}
	 */
	const envHands = (opts, named, prov) => {
		const gitOnly = prov.realGit || prov.guard;
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
	 * @param {string} base the directory it resolves a relative path against
	 * @returns {Hand[]}
	 */
	const stdinHands = (opts, base) => {
		const input = Array.isArray(opts?.stdio) ? opts.stdio[0]?.input : null;
		if (!ArrayBuffer.isView(input)) return [];
		const p = handed.from(base, { text: true })(textOf(input));
		return p.length === 0 ? [] : [{ by: "stdin", p }];
	};
	/**
	 * A git no guard logs, whose directory — its own, or where its `-C`
	 * words move it — lies under the root with no repository of its own
	 * between: it reads the checkout's (#4982, #4997). `init` and `clone`
	 * look for none, but one asked for `--help` does, through `git help`.
	 * `--git-dir` and `GIT_DIR` name it, weighed as a word and a variable.
	 * @param {Untyped} opts
	 * @param {string[]} words its words after the program
	 * @param {GitOptions} git
	 * @returns {Hand[]}
	 */
	const repoHands = (opts, words, git) => {
		const asked = gitDirOf(words, git);
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
	 * What hands a child paths in the checkout; none for a Node child that
	 * logs its own reads.
	 * @param {Untyped} opts
	 * @param {Provenance} prov
	 * @returns {Hand[]}
	 */
	const handsOf = (opts, prov) => {
		if (prov.auditedNode) return [];
		const cwd = cwdOf(opts);
		const words = argvOf(opts).slice(1);
		const git = isGitFile(opts) ? readGitOptions(words, cwd) : null;
		const base = git?.moved ?? cwd;
		const named = handed.from(base);
		return [
			...words.flatMap(
				(/** @type {string} */ word, /** @type {number} */ at) => {
					const from = git?.baseOfValue.get(at);
					const p = (from === undefined ? named : handed.from(from))(word);
					return p.length === 0 ? [] : [{ by: "arg", at, p }];
				},
			),
			...envHands(opts, named, prov),
			...stdinHands(opts, base),
			...(git ? repoHands(opts, words, git) : []),
		];
	};
	/**
	 * Whether a child stands in the checkout, runs a file there or is handed
	 * a path there.
	 * @param {string} cwd
	 * @param {Hand[]} hands
	 * @param {Provenance} prov
	 */
	const isInReach = (cwd, hands, prov) =>
		relativeUnder(root, cwd) !== null || hands.length > 0 || prov.ours;
	/**
	 * Whether the tracer can run a child in its place: a shell, a stub, or a
	 * program file of the checkout's own.
	 * @param {Untyped} opts
	 * @param {string[]} bin
	 * @param {Provenance} prov
	 */
	const isTraceable = (opts, bin, prov) => {
		const file = String(opts?.file ?? "");
		const argv = argvOf(opts);
		/* A child launching the tracer on a program of its own would be
		 * refused it under this one (#4982). */
		if (argv.includes(String(STRACE))) return false;
		/* The tracer runs the program by its name, as the spawn would: only a
		 * name the spawn passes as the program's own first word, found as a
		 * file the kernel runs with no shell's help. */
		if (opts?.envPairs?.includes?.("WFC_READ_AUDIT_UNTRACED=1")) return false;
		if (argv[0] !== file || bin.length === 0 || !isProgram(String(bin[1])))
			return false;
		if (!SHELLS.has(path.basename(file)) && !prov.stub && !prov.ours)
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
	 * @param {string[]} bin
	 * @param {Provenance} prov
	 * @returns {Route}
	 */
	const routeOf = (opts, hands, bin, prov) => {
		const cwd = cwdOf(opts);
		if (!STRACE || !isInReach(cwd, hands, prov) || isUntraceable(prov))
			return null;
		if (!isTraceable(opts, bin, prov)) return null;
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
	 * @param {Provenance} prov
	 * @returns {{opts: Untyped, events?: string|null}}
	 */
	const gitEventsOf = (opts, prov) => {
		if (!isGitFile(opts)) return { opts };
		if (!prov.realGit && !prov.guard) return { opts };
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
	 * `bin` is the spawn's program as `binOf` found it, and `prov` what that
	 * program is, each once, for every test that weighs it and for its
	 * record; `prov` is null where finding either faulted.
	 * @typedef {{opts: Untyped, bin: string[], prov: Provenance|null,
	 *   route: Route, hands: Hand[], events?: string|null}} Spawn
	 */
	/**
	 * @param {Untyped} asked
	 * @returns {Spawn}
	 */
	const buildTracedSpawn = (asked) => {
		/* A `binOf` that throws leaves `bin` empty, as for no file at all: its
		 * record is still kept, in a log the fault marks a doubt (#5009). */
		/** @type {string[]} */
		let bin = [];
		/** @type {Provenance|null} */
		let prov = null;
		let within = false;
		try {
			/* A tracer already following this process follows the child too,
			 * and would take the hands' lookups for reads of its own. */
			within = Boolean(STRACE) && isUnderTracer();
			bin = binOf(String(asked?.file ?? ""), cwdOf(asked), asked?.envPairs);
			prov = provenanceOf(asked, bin);
			if (within)
				return { opts: asked, bin, prov, route: { within: true }, hands: [] };
			const hands = handsOf(asked, prov);
			const route = routeOf(asked, hands, bin, prov);
			const { opts, events } = gitEventsOf(asked, prov);
			if (!route || !("trace" in route))
				return { opts, bin, prov, route, hands, events };
			const args = buildTraceArgv(
				String(STRACE),
				path.join(dir, route.trace),
				argvOf(opts),
			);
			return {
				opts: { ...opts, file: args[0], args },
				bin,
				prov,
				route,
				hands,
				events,
			};
		} catch {
			// The child runs as the test spawned it, untraced, and the log is
			// marked, which the reader doubts (#4966).
			fault();
			return {
				opts: asked,
				bin,
				prov,
				route: within ? { within: true } : null,
				hands: [],
			};
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
	 * no tracer follows it and it is no Node child keeping a log of its own;
	 * a guarded git is watched (#5015). A stream the test
	 * handed it whole (`wrap`) on a descriptor it may read carries what the
	 * audit cannot read: a doubt.
	 * @param {Untyped} asked
	 * @param {number|undefined} pid
	 * @param {Spawn} spawned
	 */
	const watchIfUnseen = (asked, pid, { route, prov }) =>
		guard(() => {
			const stdio = Array.isArray(asked?.stdio) ? asked.stdio : [];
			if (typeof pid !== "number" || route || prov?.auditedNode) return;
			const cwd = cwdOf(asked);
			const base = isGitFile(asked)
				? readGitOptions(argvOf(asked).slice(1), cwd).moved
				: cwd;
			for (const [descriptor, entry] of stdio.entries())
				watchEntry(entry, descriptor, pid, base);
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
				// A git that wrote no log is doubted for that by the reader (#4997).
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
	 * @param {Untyped} handle the child's process handle: Node calls only
	 *   the handle's own `kill` and `onexit`, so they are wrapped in place
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
			// Gone, or not ours to read: no mark, so its open log doubts (#4997).
			return false;
		}
	};
	/**
	 * @param {Untyped} opts as the test spawned it
	 * @param {number|undefined} pid
	 * @param {Spawn} spawned
	 */
	const logChild = (opts, pid, { bin, prov, route, hands, events }) =>
		guard(() => {
			add({
				k: "child",
				file: String(opts?.file ?? ""),
				bin,
				args: argvOf(opts).slice(1),
				cwd: cwdOf(opts),
				/* Null where finding it faulted, in a log the fault marks a doubt. */
				prov,
				pid: pid ?? null,
				...(hands.length > 0 ? { hands } : {}),
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
			watchIfUnseen(asked, this.pid, spawned);
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
		/* Only the owner writes the file the reader weighs its git calls
		 * against: a vitest a test runs under the same owner settles its own
		 * environment, which is the test's (#5017). */
		settle() {
			guard(() => {
				standing = { ...process.env };
				resettle();
				if (!isOwner) return;
				const file = path.join(dir, `${owner}.standing.json`);
				const gitAt = sizeOf(path.join(dir, `${owner}.git`));
				fs.writeFileSync(file, JSON.stringify({ env: standing, gitAt }));
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
		return parseStanding(fs.readFileSync(file, "utf8")).env;
	} catch {
		// No file to read is no settled environment (#4982).
		return {};
	}
}

/** @param {string} file its size in bytes, 0 where none stands */
function sizeOf(file) {
	try {
		return fs.statSync(file).size;
	} catch {
		// No git call logged yet (#5017).
		return 0;
	}
}

const SHELLS = new Set(["sh", "bash", "dash"]);

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

/** @param {Untyped} opts whether a child's program is named git */
function isGitFile(opts) {
	return path.basename(String(opts?.file ?? "")) === "git";
}

/**
 * @typedef {{moved: string, baseOfValue: Map<number, string>,
 *   bare: string|null, namesGitDir: boolean, sub: number}} GitOptions
 *   what a git call's options before its subcommand do: the directory each
 *   `-C` moves it to in turn (git(1), `-C`), `moved` where they end; each
 *   `-C` value's place with the directory it is read against; where
 *   `--bare` stood, the directory the `-C` words before it reached;
 *   whether `--git-dir` names its repository; the subcommand's place
 */

/**
 * @param {string[]} words the call's words after the program
 * @param {string} cwd
 * @returns {GitOptions}
 */
function readGitOptions(words, cwd) {
	let moved = cwd;
	/** @type {Map<number, string>} */
	const baseOfValue = new Map();
	/** @type {string|null} */
	let bare = null;
	let namesGitDir = false;
	const sub = stepGitOptions(words, (word, at) => {
		if (word.split("=")[0] === "--git-dir") namesGitDir = true;
		if (word === "--bare") bare = moved;
		if (word === "-C" && at + 1 < words.length) {
			baseOfValue.set(at + 1, moved);
			moved = path.resolve(moved, String(words[at + 1]));
		}
	});
	return { moved, baseOfValue, bare, namesGitDir, sub };
}

/**
 * Where a git call finds its repository: the directory it looks up from,
 * its own moved by each `-C` before the subcommand, or under `--bare` the
 * repository itself (git sets `GIT_DIR` there); null where it looks for
 * none.
 * @param {string[]} words the call's words after the program
 * @param {GitOptions} git
 * @returns {{at: string, bare: boolean}|null}
 */
function gitDirOf(words, { moved, bare, namesGitDir, sub }) {
	if (namesGitDir || makesItsOwn(words, sub)) return null;
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
