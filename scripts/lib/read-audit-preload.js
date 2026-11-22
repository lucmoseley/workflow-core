const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { caught, ignoreFailure } = require("./caught.js");
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
const {
	awaitCopied,
	buildTraceArgv,
	realOf,
} = require("./read-audit-trace.js");
const SELF = require("node:url").pathToFileURL(__filename).href;

/** @typedef {{ format?: string }} LoadContext */
/** @typedef {(url: string, context: LoadContext) => unknown} NextLoad */
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

const SETTLED = "WFC_READ_AUDIT_SETTLED";

const scope =
	/** @type {{ __wfcReadAudit?: { claim: (file: string) => void, settle: () => void } }} */ (
		/** @type {unknown} */ (globalThis)
	);

/** @typedef {any} Untyped */

if (DIR && ROOT && !scope.__wfcReadAudit) install();

function install() {
	const dir = /** @type {string} */ (DIR);
	const root = /** @type {string} */ (ROOT);
	const owner = process.env.WFC_READ_AUDIT_OWNER ?? String(process.pid);
	process.env.WFC_READ_AUDIT_OWNER = owner;
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
	const fault = () => ignoreFailure(() => add({ k: "fault" }));
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
	/** @param {unknown} p */
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
			fault();
		}
	};

	const kindAt = (/** @type {string} */ abs) => pathKind(abs, realStatSync);

	/** @param {unknown} p */
	const probe = (p) =>
		guard(() => {
			const r = rel(p);
			if (r !== null) add({ k: "probe", p: r, s: kindAt(path.join(root, r)) });
		});

	/**
	 * @param {unknown} p
	 * @param {unknown} names
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
	/** @type {import("./read-audit-trace.js").FifoIo} */
	const fifoIo = {
		openSync: fs.openSync,
		closeSync: fs.closeSync,
		unlinkSync: fs.unlinkSync,
	};

	/** @type {import("./read-audit-handed.js").Settled} */
	const settled = readSettled(process.env[SETTLED]);
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
	const resettle = () => {
		settled.clear();
		settlings.clear();
	};

	/**
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
	const realOrAsIs = (/** @type {string} */ abs) => {
		try {
			return realRealpathSync(abs);
		} catch {
			return abs;
		}
	};
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
	const ownTmp = realRealpathSync(os.tmpdir());
	const tmps = [...new Set([process.env.WFC_READ_AUDIT_TMP ?? ownTmp, ownTmp])];
	const verdictOf = buildVerdictOf({ root, tmps, realpath: realRealpathSync });
	/** @typedef {import("./read-audit-provenance.js").Provenance} Provenance */
	/**
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
	const isUntraceable = (/** @type {Provenance} */ prov) =>
		prov.guarded || prov.auditedNode;
	const handed = buildHanded(root);
	const guardDir = rel(path.dirname(GUARD));
	let standing = readStanding(process.env.WFC_READ_AUDIT_STANDING);
	const isOwner = owner === String(process.pid);
	const namedText = (
		/** @type {string} */ name,
		/** @type {string} */ value,
	) => (name === "NODE_OPTIONS" ? value.split(SELF).join("") : value);
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
	 * @param {string} name
	 * @param {string} value
	 * @param {Named} named
	 */
	const envPaths = (name, value, named) => {
		if (name === "WFC_READ_AUDIT_ROOT" || name === SETTLED) return [];
		const paths = named(namedText(name, value), settlingOf(name));
		if (name !== "PATH") return paths;
		return paths.filter(
			(p) => p !== guardDir && !p.split("/").includes("node_modules"),
		);
	};
	/** @typedef {import("./read-audit-handed.js").Hand} Hand */
	/** @typedef {ReturnType<ReturnType<typeof buildHanded>["from"]>} Named */
	/**
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
	 * @param {Untyped} opts
	 * @param {string} base
	 * @returns {Hand[]}
	 */
	const stdinHands = (opts, base) => {
		const input = Array.isArray(opts?.stdio) ? opts.stdio[0]?.input : null;
		if (!ArrayBuffer.isView(input)) return [];
		const p = handed.from(base, { text: true })(textOf(input));
		return p.length === 0 ? [] : [{ by: "stdin", p }];
	};
	/**
	 * @param {Untyped} opts
	 * @param {string[]} words
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
	 * @param {string} at
	 * @param {boolean} bare
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
	 * @param {string} cwd
	 * @param {Hand[]} hands
	 * @param {Provenance} prov
	 */
	const isInReach = (cwd, hands, prov) =>
		relativeUnder(root, cwd) !== null || hands.length > 0 || prov.ours;
	/**
	 * @param {Untyped} opts
	 * @param {string[]} bin
	 * @param {Provenance} prov
	 */
	const isTraceable = (opts, bin, prov) => {
		const file = String(opts?.file ?? "");
		const argv = argvOf(opts);
		if (argv.includes(String(STRACE))) return false;
		if (opts?.envPairs?.includes?.("WFC_READ_AUDIT_UNTRACED=1")) return false;
		if (argv[0] !== file || bin.length === 0 || !isProgram(String(bin[1])))
			return false;
		if (!SHELLS.has(path.basename(file)) && !prov.stub && !prov.ours)
			return false;
		return !(Array.isArray(opts?.stdio) && opts.stdio.length > 3);
	};
	/** @typedef {{within: true}|{trace: string}|null} Route */
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
	let handings = 0;
	let handedText = "";
	let handedFile = "";
	const isWritable = (/** @type {string} */ at) =>
		[root, ...tmps].some((under) => relativeUnder(under, at) !== null);
	/**
	 * @param {Untyped} opts
	 * @returns {Untyped}
	 */
	const withSettled = (opts) => {
		if (!isAudited(opts?.envPairs)) return opts;
		const pairs = opts.envPairs.filter(
			(/** @type {string} */ p) => !String(p).startsWith(`${SETTLED}=`),
		);
		const kept = [...settled].filter(
			([abs, real]) => !isWritable(abs) && (real === null || !isWritable(real)),
		);
		if (kept.length === 0) return { ...opts, envPairs: pairs };
		const text = JSON.stringify(kept);
		if (text !== handedText) {
			const file = path.join(
				dir,
				`${owner}.${process.pid}.${++handings}.settled.json`,
			);
			fs.writeFileSync(file, text);
			handedText = text;
			handedFile = file;
		}
		return { ...opts, envPairs: [...pairs, `${SETTLED}=${handedFile}`] };
	};
	/**
	 * @typedef {{opts: Untyped, bin: string[], prov: Provenance|null,
	 *   route: Route, hands: Hand[], events?: string|null}} Spawn
	 */
	/**
	 * @param {Untyped} asked
	 * @returns {Spawn}
	 */
	const buildTracedSpawn = (asked) => {
		/** @type {string[]} */
		let bin = [];
		/** @type {Provenance|null} */
		let prov = null;
		let within = false;
		try {
			within = Boolean(STRACE) && isUnderTracer();
			bin = binOf(String(asked?.file ?? ""), cwdOf(asked), asked?.envPairs);
			prov = provenanceOf(asked, bin);
			if (within)
				return { opts: asked, bin, prov, route: { within: true }, hands: [] };
			const hands = handsOf(asked, prov);
			const route = routeOf(asked, hands, bin, prov);
			const told = gitEventsOf(asked, prov);
			const { events } = told;
			const opts = withSettled(told.opts);
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
	 * @param {Untyped} handle
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
				if (name === "writev") weigh(rest[0] ? data : data.filter(isEven));
				else weigh([data]);
				return write.call(this, req, data, ...rest);
			};
		}
	};
	/**
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
	 * @param {Untyped} entry
	 * @param {number} descriptor
	 * @param {number} pid
	 * @param {string} cwd
	 */
	const watchEntry = (entry, descriptor, pid, cwd) => {
		if (entry?.type === "pipe") watchInput(entry.handle, pid, cwd);
		const isOutput = descriptor === 1 || descriptor === 2;
		if (entry?.type === "wrap" && !isOutput) add({ k: "piped", pid, p: null });
	};
	/**
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
				return;
			}
			try {
				fs.writeSync(at, `${JSON.stringify({ event: EXITED, pid })}\n`);
			} finally {
				fs.closeSync(at);
			}
		});
	/**
	 * @param {Untyped} handle
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
			wrapOnExit(handle, () => {
				if (killedGit) markExited(events, handle.pid);
			});
		});
	/** @param {unknown} pid */
	const isGitNow = (pid) => {
		try {
			return path.basename(realRealpathSync(`/proc/${pid}/exe`)) === "git";
		} catch {
			return false;
		}
	};
	/**
	 * @param {Untyped} opts
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
				prov,
				pid: pid ?? null,
				...(hands.length > 0 ? { hands } : {}),
				...(events === undefined ? {} : { events }),
				...route,
			});
		});
	/** @param {Spawn} spawned */
	const awaitOutput = ({ opts, route }) =>
		guard(() => {
			if (!route || !("trace" in route)) return;
			const stdio = Array.isArray(opts?.stdio) ? opts.stdio : [];
			const shared = [1, 2].filter((n) => {
				const type = stdio[n]?.type;
				return type !== undefined && type !== "pipe" && type !== "ignore";
			});
			if (shared.length > 0)
				awaitCopied(path.join(dir, route.trace), shared, fifoIo);
		});
	/**
	 * @param {Untyped} handle
	 * @param {() => void} before
	 */
	const wrapOnExit = (handle, before) => {
		const { onexit } = handle;
		handle.onexit = function (/** @type {Untyped[]} */ ...args) {
			before();
			return onexit.apply(this, args);
		};
	};
	const bindings = /** @type {Untyped} */ (process).binding;
	const quiet = process.noDeprecation;
	process.noDeprecation = true;
	try {
		const sync = bindings("spawn_sync");
		const syncSpawn = sync.spawn;
		sync.spawn = function (/** @type {Untyped[]} */ ...args) {
			const spawned = buildTracedSpawn(args[0]);
			const out = syncSpawn.apply(this, [spawned.opts, ...args.slice(1)]);
			awaitOutput(spawned);
			logChild(args[0], out?.pid, spawned);
			return out;
		};
		const Process = bindings("process_wrap").Process;
		const asyncSpawn = Process.prototype.spawn;
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
			if (typeof this.onexit === "function")
				wrapOnExit(this, () => awaitOutput(spawned));
			return err;
		};
	} catch {
		fault();
	} finally {
		process.noDeprecation = quiet;
	}

	const api = {
		/** @param {string} file */
		claim(file) {
			guard(() => {
				const r = rel(file);
				add({ k: "claim", file: r ?? String(file) });
			});
		},
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
 * @param {string|undefined} file
 * @returns {Record<string, string|undefined>}
 */
function readStanding(file) {
	if (!file) return {};
	try {
		return parseStanding(fs.readFileSync(file, "utf8")).env;
	} catch {
		return {};
	}
}

/**
 * @param {string|undefined} file
 * @returns {import("./read-audit-handed.js").Settled}
 */
function readSettled(file) {
	if (!file) return new Map();
	try {
		const pairs = JSON.parse(fs.readFileSync(file, "utf8"));
		return new Map(
			pairs.filter(
				(/** @type {unknown} */ p) =>
					Array.isArray(p) &&
					typeof p[0] === "string" &&
					(typeof p[1] === "string" || p[1] === null),
			),
		);
	} catch {
		return new Map();
	}
}

/** @param {string} file */
function sizeOf(file) {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
}

const SHELLS = new Set(["sh", "bash", "dash"]);

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

/** @param {unknown} chunk */
function textOf(chunk) {
	if (typeof chunk === "string") return chunk;
	if (!ArrayBuffer.isView(chunk)) return "";
	const { buffer, byteOffset, byteLength } = chunk;
	return Buffer.from(buffer, byteOffset, byteLength).toString("latin1");
}

const ELF = Buffer.from("\x7fELF", "latin1");

/** @param {Untyped} opts */
function isGitFile(opts) {
	return path.basename(String(opts?.file ?? "")) === "git";
}

/**
 * @typedef {{moved: string, baseOfValue: Map<number, string>,
 *   bare: string|null, namesGitDir: boolean, sub: number}} GitOptions
 */

/**
 * @param {string[]} words
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
 * @param {string[]} words
 * @param {GitOptions} git
 * @returns {{at: string, bare: boolean}|null}
 */
function gitDirOf(words, { moved, bare, namesGitDir, sub }) {
	if (namesGitDir || makesItsOwn(words, sub)) return null;
	return { at: bare ?? moved, bare: bare !== null };
}

/**
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
