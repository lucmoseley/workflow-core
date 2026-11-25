const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { pidAlive } = require("./arbiter-proc.js");
const { escapeRe } = require("./regex-group.js");
const { parseShebang, scriptLanguage } = require("./file-reach.js");
const { readText } = require("./file-read.js");
const { isUnder, relativeUnder } = require("./is-under.js");
const { parseJsonl } = require("./jsonl.js");
const { pathKind } = require("./path-kind.js");
const { ignoreFailure } = require("./caught.js");
const {
	isNode,
	parseStanding,
	SHOWN_MAX,
	toPosix,
} = require("./read-audit-paths.js");
const { parseGitRecords, gitCallsOf } = require("./read-audit-git.js");
const { buildGitEventsReader } = require("./read-audit-git-events.js");
const { buildHanded } = require("./read-audit-handed.js");
const { isProvenance } = require("./read-audit-provenance.js");
const { buildTraceReader, findStrace } = require("./read-audit-trace.js");

const PRELOAD = path.join(__dirname, "read-audit-preload.js");

const NO_TRACER =
	"read audit: no working strace on PATH, so a test file that runs a stub, a shell or a checkout program records no pass-store row (workflow-core#4966).\n";

/**
 * @typedef {import("./read-audit-git.js").GitCall} GitCall
 * @typedef {{files: string[], absent: string[], dirs: string[],
 *   lists: Record<string, string>, trees: string[], scripts: string[],
 *   git: GitCall[]}} Reads
 * @typedef {{reads: Reads} | {doubt: string}} Audit
 */
/**
 * @typedef {{k: "self", owner: string, pid: number}
 *   | {k: "fault"}
 *   | {k: "claim", file: string}
 *   | {k: "minted", p: string}
 *   | {k: "probe", p: string, s: string}
 *   | {k: "list", p: string, id: string}
 *   | {k: "tree", p: string}
 *   | {k: "worker"}
 *   | PipedEntry
 *   | ChildEntry} Entry
 * @typedef {{k: "piped", pid: number, p: string[]|null}} PipedEntry
 * @typedef {import("./read-audit-provenance.js").Provenance} Provenance
 * @typedef {{k: "child", file: string, bin: string[], args: string[],
 *   cwd: string, prov: Provenance, pid: number|null, hands?: Hand[],
 *   events?: string|null, within?: true, trace?: string}} ChildEntry
 */

/**
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{write(s: string): unknown}} [err]
 * @returns {string|null}
 */
function install(root, env = process.env, err = process.stderr) {
	if (env.WFC_READ_AUDIT_OWNER) return null;
	sweep(os.tmpdir());
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), `${PREFIX}${process.pid}-`),
	);
	env.WFC_READ_AUDIT = dir;
	env.WFC_READ_AUDIT_ROOT = fs.realpathSync(root);
	env.WFC_READ_AUDIT_TMP = fs.realpathSync(os.tmpdir());
	const strace = findStrace(dir, env);
	if (strace) env.WFC_READ_AUDIT_STRACE = strace;
	else {
		delete env.WFC_READ_AUDIT_STRACE;
		err.write(NO_TRACER);
	}
	env.NODE_OPTIONS = [
		env.NODE_OPTIONS,
		`--import=${JSON.stringify(pathToFileURL(PRELOAD).href)}`,
	]
		.filter(Boolean)
		.join(" ");
	return dir;
}

/** @param {string|null} dir */
function remove(dir) {
	if (!dir) return;
	ignoreFailure(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const PREFIX = "wfc-read-audit-";
const LOG_DIR_NAME = new RegExp(`^${escapeRe(PREFIX)}(\\d+)-`);

// guess, workflow-core#5046
const STALE_MS = 60 * 60 * 1000;

/**
 * @param {string} tmp
 * @param {number} [now]
 */
function sweep(tmp, now = Date.now()) {
	let names;
	try {
		names = fs.readdirSync(tmp);
	} catch {
		return;
	}
	for (const name of names) {
		const pid = LOG_DIR_NAME.exec(name)?.[1];
		if (pid === undefined || pidAlive(Number(pid))) continue;
		const dir = path.join(tmp, name);
		ignoreFailure(() => {
			if (now - fs.lstatSync(dir).mtimeMs > STALE_MS) remove(dir);
		});
	}
}

/**
 * @param {string} dir
 * @param {string} root
 * @param {import("./read-audit-trace.js").Clock} [clock]
 * @returns {Map<string, Audit>}
 */
function readAudits(dir, root, clock) {
	const owners = readOwners(dir);
	const real = fs.realpathSync(root);
	const readers = {
		trace: buildTraceReader(dir, real, clock),
		gitEvents: buildGitEventsReader(dir),
	};
	/** @type {Map<string, Audit>} */
	const out = new Map();
	for (const [owner, held] of owners) {
		const { logs } = held;
		const own = logs.get(Number(owner));
		const claimsIn = (/** @type {Entry[]} */ entries) =>
			entries.flatMap((e) => (e.k === "claim" ? [String(e.file)] : []));
		const claims = new Set(claimsIn(own ?? []));
		const named =
			claims.size > 0 ? claims : new Set(claimsIn([...logs.values()].flat()));
		/** @type {Audit} */
		let audit;
		if (!own) audit = { doubt: "its process left no audit log" };
		else if (claims.size === 1) audit = judge(held, real, readers);
		else audit = { doubt: "its process ran more than one test file" };
		for (const f of named)
			out.set(f, out.has(f) ? { doubt: "two processes claimed it" } : audit);
	}
	return out;
}

/**
 * @typedef {import("./read-audit-paths.js").Standing} Standing
 * @typedef {{logs: Map<number, Entry[]>, git: GitRecord[],
 *   standing: Standing}} Owner
 */
/**
 * @param {string} dir
 * @returns {Map<string, Owner>}
 */
function readOwners(dir) {
	/** @type {Map<string, Owner>} */
	const owners = new Map();
	const at = (/** @type {string} */ owner) => {
		/** @type {Owner} */
		const o = owners.get(owner) ?? {
			logs: new Map(),
			git: [],
			standing: parseStanding(""),
		};
		owners.set(owner, o);
		return o;
	};
	for (const name of fs.readdirSync(dir)) {
		const text = () => fs.readFileSync(path.join(dir, name), "utf8");
		const git = /^(\d+)\.git$/.exec(name);
		if (git)
			at(String(git[1])).git.push(
				...parseGitRecords(fs.readFileSync(path.join(dir, name))),
			);
		const standing = /^(\d+)\.standing\.json$/.exec(name);
		if (standing) at(String(standing[1])).standing = parseStanding(text());
		const log = /^(\d+)\.(\d+)\.jsonl$/.exec(name);
		if (!log) continue;
		const { rows, bad } = parseJsonl(text());
		if (bad.length > 0) rows.push({ k: "fault" });
		at(String(log[1])).logs.set(Number(log[2]), /** @type {Entry[]} */ (rows));
	}
	return owners;
}

/** @typedef {import("./read-audit-git.js").GitRecord} GitRecord */

/**
 * @param {Owner} owner
 * @param {string} root
 * @param {Readers} readers
 * @returns {Audit}
 */
function judge({ logs, git, standing }, root, readers) {
	for (const [pid, entries] of logs)
		if (entries[0]?.k !== "self" || entries.some((e) => e.k === "fault"))
			return { doubt: `the audit faulted in process ${pid}` };
	const minted = [...logs.values()]
		.flat()
		.flatMap((e) => (e.k === "minted" ? [String(e.p)] : []));
	const isScratch = (/** @type {string} */ p) => isUnder(p, minted);
	const recorded = new Set(git.map((record) => record.pid));
	const { spelt } = buildHanded(root);
	const scope = { root, isScratch, recorded, spelt };
	const calls = gitCallsOf(git, standing, root);
	if (!Array.isArray(calls)) return calls;
	const reads = buildCollector(logs, scope, readers);
	for (const entries of logs.values())
		for (const e of entries) {
			const why = reads.take(e);
			if (why) return { doubt: why };
		}
	return reads.finish(calls);
}

/**
 * @typedef {{trace: ReturnType<typeof buildTraceReader>,
 *   gitEvents: ReturnType<typeof buildGitEventsReader>}} Readers
 */

/**
 * @typedef {{root: string, isScratch: (p: string) => boolean,
 *   recorded: Set<number>, spelt: (word: string) => string[]}} Scope
 */

/**
 * @param {Map<number, Entry[]>} logs
 * @param {Scope} scope
 * @param {Readers} readers
 */
function buildCollector(logs, scope, readers) {
	const { root, isScratch } = scope;
	/** @type {Record<"file"|"dir"|"absent", Set<string>>} */
	const probed = { file: new Set(), dir: new Set(), absent: new Set() };
	/** @type {Map<string, Set<string>>} */
	const lists = new Map();
	/** @type {Set<string>} */
	const trees = new Set();
	/** @type {Set<string>} */
	const scripts = new Set();
	/** @type {Map<number, ChildEntry>} */
	const children = new Map();
	const weighed = () => null;
	/** @type {{[K in Entry["k"]]: (e: Extract<Entry, {k: K}>) => string|null}} */
	const takers = {
		self: weighed,
		fault: weighed,
		claim: weighed,
		minted: weighed,
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
		worker: () =>
			"it started a worker thread, whose reads the audit cannot see",
		piped: (e) => pipedDoubt(e, children.get(Number(e.pid)), scope),
		child: (e) => {
			if (!isProvenance(e.prov))
				return `a child (${shownChild(e)}) was logged with no verdict on what it is`;
			if (typeof e.pid === "number") children.set(e.pid, e);
			if (typeof e.trace === "string") return takeTrace(e);
			const ran = gitChildDoubt(e, readers.gitEvents);
			if (ran) return ran;
			const program = readProgram(e, root, isScratch);
			const why = childDoubt(e, program, logs, scope);
			if (!why) for (const f of childReads(e, program, root)) scripts.add(f);
			return why;
		},
	};
	/**
	 * @param {Entry} e
	 * @returns {string|null}
	 */
	const take = (e) => {
		if (!Object.hasOwn(takers, e.k))
			return `the audit logged a line of a kind it does not know (${String(e.k).slice(0, SHOWN_MAX)})`;
		if ("p" in e && typeof e.p === "string" && isScratch(e.p)) return null;
		return /** @type {(e: Entry) => string|null} */ (takers[e.k])(e);
	};
	/**
	 * @param {ChildEntry} e
	 * @returns {string|null}
	 */
	const takeTrace = (e) => {
		const got = readers.trace(String(e.trace), String(e.cwd));
		if ("doubt" in got) return `a traced child (${shownChild(e)}) ${got.doubt}`;
		for (const read of got.entries) {
			const why = take(/** @type {Entry} */ (read));
			if (why) return why;
		}
		return null;
	};
	return {
		take,
		/**
		 * @param {GitCall[]} git
		 * @returns {Audit}
		 */
		finish(git) {
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
					git,
				},
			};
		},
	};
}

const SHELL_RUNNERS = new Set(["bash", "sh"]);
const PYTHON_RUNNERS = new Set(["python3", "python"]);

/**
 * @param {ChildEntry} e
 * @param {Program|null} program
 * @param {Map<number, Entry[]>} logs
 * @param {Scope} scope
 * @returns {string|null}
 */
function childDoubt(e, program, logs, scope) {
	const { root, isScratch } = scope;
	const shown = shownChild(e);
	const { prov } = e;
	if (prov.auditedNode || (prov.audited && program?.runs === "node")) {
		if (typeof e.pid !== "number")
			return `a Node child (${shown}) never started`;
		return logs.has(e.pid) ? null : `a Node child (${shown}) left no audit log`;
	}
	if (prov.guarded) return guardedDoubt(e, scope);
	if (e.within) return null;
	return unseenDoubt(e, program, root, isScratch);
}

/**
 * @param {ChildEntry} e
 * @param {Scope} scope
 * @returns {string|null}
 */
function guardedDoubt(e, { isScratch, recorded, spelt }) {
	const args = /** @type {string[]} */ (e.args ?? []);
	const shown = shownChild(e);
	if (args.some((a) => spelt(a).some((p) => !isScratch(p))))
		return `a git call (${shown}) was handed a path in the checkout`;
	if (recorded.has(Number(e.pid))) return null;
	const hand = handOf(e, null, isScratch);
	return hand
		? `a git call (${shown}) the guard kept no record of was handed a path in the checkout${handedBy(hand)}`
		: null;
}

/**
 * @param {ChildEntry} e
 * @param {Program|null} program
 * @param {string} root
 * @param {(p: string) => boolean} isScratch
 * @returns {string|null}
 */
function unseenDoubt(e, program, root, isScratch) {
	const file = String(e.file);
	const shown = shownChild(e);
	const cwd = String(e.cwd);
	const blind = e.prov.readsNothing;
	if (
		isUnder(cwd, [root], path.sep) &&
		!isScratch(toPosix(path.relative(root, cwd))) &&
		!blind
	)
		return `a child (${shown}) ran in the checkout`;
	const script = scriptOf(e, root);
	const hand = blind ? undefined : handOf(e, script, isScratch);
	if (hand)
		return `a child (${shown}) was handed a path in the checkout${handedBy(hand)}`;
	if (program?.runs === "other")
		return `a child (${shown}) ran a program of the checkout, whose own reads no reach holds`;
	if (program?.runs === "shell")
		return `a child (${shown}) ran a shell script of the checkout that no tracer followed, whose own reads no reach holds`;
	if (program?.runs === "node" || (script !== null && isNode(file)))
		return `a Node child (${shown}) ran without the audit`;
	if (script !== null) {
		const runner = PYTHON_RUNNERS.has(path.basename(file)) ? "Python" : "shell";
		return `a ${runner} child (${shown}) ran a checkout script that no tracer followed, whose own reads no reach holds`;
	}
	return null;
}

/** @typedef {import("./read-audit-handed.js").Hand} Hand */

/**
 * @param {ChildEntry} e
 * @param {string|null} script
 * @param {(p: string) => boolean} isScratch
 * @returns {Hand|undefined}
 */
function handOf(e, script, isScratch) {
	const args = /** @type {string[]} */ (e.args ?? []);
	const hands = /** @type {Hand[]} */ (e.hands ?? []);
	const isEnvBlind = e.prov.readsNoVariable;
	return hands.find((hand) => {
		if (hand.by === "arg" && args[hand.at] === script) return false;
		if (hand.by === "env" && hand.standing && isEnvBlind) return false;
		return !hand.p.every(isScratch);
	});
}

/**
 * @param {PipedEntry} e
 * @param {ChildEntry|undefined} child
 * @param {Scope} scope
 * @returns {string|null}
 */
function pipedDoubt(e, child, { isScratch, recorded }) {
	if (child?.prov.guarded && recorded.has(Number(child.pid))) return null;
	if (child === undefined)
		return "a child the audit logged no spawn of was written a path in the checkout";
	if (!Array.isArray(e.p))
		return `a child (${shownChild(child)}) was handed a stream whose content the audit cannot read`;
	const paths = e.p.map(String);
	if (child.prov.readsNothing || paths.every(isScratch)) return null;
	return `a child (${shownChild(child)}) was written a path in the checkout down a pipe`;
}

/**
 * @param {ChildEntry} e
 * @param {Readers["gitEvents"]} readEvents
 * @returns {string|null}
 */
function gitChildDoubt(e, readEvents) {
	if (!("events" in e) || typeof e.pid !== "number") return null;
	const name = typeof e.events === "string" ? e.events : null;
	return readEvents(name, shownChild(e));
}

const handedBy = (/** @type {Hand} */ hand) => {
	if (hand.by === "env") return ` by its environment (${hand.name})`;
	if (hand.by === "repo")
		return " by the repository it finds from its directory";
	return hand.by === "stdin" ? " on its standard input" : "";
};

/** @param {ChildEntry} e */
function shownChild(e) {
	const args = /** @type {string[]} */ (e.args ?? []);
	return `${path.basename(String(e.file))} ${args.join(" ")}`.slice(
		0,
		SHOWN_MAX,
	);
}

/**
 * @param {ChildEntry} e
 * @param {string} root
 * @returns {string|null}
 */
function scriptOf(e, root) {
	const file = String(e.file);
	const name = path.basename(file);
	if (!SHELL_RUNNERS.has(name) && !PYTHON_RUNNERS.has(name) && !isNode(file))
		return null;
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

/** @typedef {{script: string, runs: "shell"|"node"|"guard"|"other"}} Program */

/**
 * @param {ChildEntry} e
 * @param {string} root
 * @param {(p: string) => boolean} isScratch
 * @returns {Program|null}
 */
function readProgram(e, root, isScratch) {
	const bin = Array.isArray(e.bin) ? e.bin.map(String) : [];
	const [script] = bin
		.flatMap((at) => {
			const rel = relativeUnder(root, at);
			return rel === null ? [] : [toPosix(rel)];
		})
		.filter((rel) => !isScratch(rel));
	const real = bin.at(-1);
	if (script === undefined || real === undefined) return null;
	const read = readText(real);
	if (bin[0] !== real || read.state !== "read")
		return { script, runs: "other" };
	if (e.prov.guard) return { script, runs: "guard" };
	const runner = parseShebang(read.data)?.kind;
	const language = scriptLanguage(real, read.data);
	if (runner === "shell" && language === "sh") return { script, runs: "shell" };
	if (runner === "node" && language === "js") return { script, runs: "node" };
	return { script, runs: "other" };
}

/**
 * @param {ChildEntry} e
 * @param {Program|null} program
 * @param {string} root
 * @returns {string[]}
 */
function childReads(e, program, root) {
	const script = scriptOf(e, root);
	return [
		...(script === null
			? []
			: [toPosix(path.relative(root, path.resolve(String(e.cwd), script)))]),
		...(program === null || program.runs === "other" ? [] : [program.script]),
	];
}

module.exports = { install, readAudits, remove, sweep };
