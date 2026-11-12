/*
 * read-audit.js — the runtime read audit the pass store keys a test file's
 * row on (#4916). A path a test builds at run time — a directory listing, a
 * helper's default root — is invisible to the lexical reach.
 *
 * `install` arms it for one suite run, from vitest's globalSetup: a log
 * directory, and lib/read-audit-preload.js on `NODE_OPTIONS`, which every
 * worker and every Node child inheriting the environment loads, and names it
 * the `strace` to run a stub or a shell under, where one works here. The git
 * guard (lib/host-git-guard/git) logs each git call on this checkout's
 * repository, word for word.
 *
 * A DIRECTORY A TEST MINTS (`mkdtemp`) under the root is its own scratch:
 * no read under it is a read of the checkout.
 *
 * A GIT CALL ON THIS REPOSITORY is a read `fs` never sees, from a test's
 * scratch as from anywhere else under the root. One of the read-only
 * subcommands in `RERUN`, made from a directory under the root with no `-C`,
 * `--git-dir`, `--work-tree`, git-dir variable or `--output` steering it and
 * nothing fed to it on standard input, is kept word for word with the answer
 * the guard saw it give: the store keys it on its output run again, and only
 * where that equals what the test got (#4993). A call the guard logged begun
 * and never answered, or that answered the same words two ways, is a doubt.
 * So is one made after the suite's setup settled under a variable changing
 * git's answer (`GIT_ANSWER_VARS`) set otherwise than it was settled
 * (#5017).
 *
 * EVERY DOUBT IS NO ROW: a file whose audit is missing, faulted, shared with
 * another file, or holds a read the audit cannot see, reads as `doubt`. What
 * cannot be seen:
 * - any other git call on this repository, a worktree of it outside the root
 *   included, and a git call handed a path in the checkout, which the guard
 *   logs only where the call's own repository is this one;
 * - a Node child that left no log, or one spawned without the audit on;
 * - a worker thread: one started from a string, or handed an environment of
 *   its own, loads no preload;
 * - any other child — a shell, Python, a binary, a stub a test wrote — run
 *   from a directory under the root, or handed a path there by an argument,
 *   an environment variable, a sync spawn's input or a write to its pipe
 *   once it runs, however spelt (#4982, #4997), where no `strace` traced
 *   it. The preload traces a stub and a
 *   shell (#4966): its reads are the paths its file calls named, and only
 *   what lib/read-audit-trace.js cannot bound is a doubt. Untraced, a
 *   shell or Python child handed a checkout script to run, from outside
 *   the root, is unseen (#4790). A checkout file run as the program itself
 *   is judged by its `#!` line: a Node one's reads are in the log it left,
 *   and any other's are unseen, a shell script's among them (#4790,
 *   `Program`). The git guard alone is a read (`Program`), and the git it
 *   runs is judged as any git child. One of lib/read-audit-provenance.js's
 *   `BLIND` is seen, which reads nothing of its directory, its environment
 *   or its input (#4932);
 * - a process an untraced git child started that is not git again — a
 *   hook, an alias, a helper — off the event log git kept for it
 *   (lib/read-audit-git-events.js, #4997);
 * - a symlink, socket or other non-file, non-directory path;
 * - a link a child process makes on an absolute path a variable left at
 *   its settled value names, once a child was spawned with it: the preload
 *   looks those up again only after its own process links, moves or
 *   removes a path (#5050).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { pidAlive } = require("./arbiter-proc.js");
const { escapeRe } = require("./regex-group.js");
const { parseShebang, scriptLanguage } = require("./code-edges.js");
const { readText } = require("./file-read.js");
const { isUnder, relativeUnder } = require("./is-under.js");
const { parseJsonl } = require("./jsonl.js");
const { pathKind } = require("./path-kind.js");
const {
	GIT_ANSWER_VARS,
	GIT_EVENTS,
	GIT_VALUED,
	isNode,
	parseStanding,
	SHOWN_MAX,
	toPosix,
} = require("./read-audit-paths.js");
const { buildGitEventsReader } = require("./read-audit-git-events.js");
const { buildHanded } = require("./read-audit-handed.js");
const { isProvenance } = require("./read-audit-provenance.js");
const { buildTraceReader, findStrace } = require("./read-audit-trace.js");

const PRELOAD = path.join(__dirname, "read-audit-preload.js");

const NO_TRACER =
	"read audit: no working strace on PATH, so a test file that runs a stub, a shell or a checkout program records no pass-store row (#4966).\n";

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

/* The long options that feed a `RERUN` subcommand its standard input, which
 * a run again never has: an object list, a path list, a revision list. */
const STDIN_OPTIONS = [
	"--stdin",
	"--annotate-stdin",
	"--parseopt",
	"--batch",
	"--exclude-existing",
];

/* A file named `-`, which git reads its standard input for: a word of its
 * own, the value stuck to a short option (`-f-`) or given to a long one
 * (`--exclude-from=-`). */
const STDIN_FILE = /^(?:-|-[^-].*-|--.+=-)$/;

/* A path naming a descriptor of the process that opens it, its standard
 * input among them, closing a word however the word spells it: bare, stuck
 * to a short option, or the value of a long one. A run again holds none of
 * the test's descriptors, so any of them counts, not standard input alone. */
const DESCRIPTOR_PATH =
	/\/(?:dev\/(?:stdin|stdout|stderr|fd\/\d+)|proc\/[^/]+\/(?:task\/[^/]+\/)?fd\/\d+)$/;

/**
 * Whether a word of a git call may feed it its standard input, or hand it
 * another descriptor of the test's by path. git takes
 * any prefix of a long option that names no other, so every prefix of one
 * in `STDIN_OPTIONS` counts, whichever subcommand it is handed to and
 * whether or not another option there shares it: a call kept is run again
 * with no input, so the doubt goes to not keeping it (#4790). A word
 * naming a descriptor by path counts however it is spelt, `.`, `..` and
 * doubled slashes folded away below a root of the word's own, so a `..`
 * folds away no more than the option the path is stuck to.
 * @param {string} word
 */
function isDescriptorFed(word) {
	if (STDIN_FILE.test(word)) return true;
	if (DESCRIPTOR_PATH.test(path.posix.normalize(`/${word}`))) return true;
	const valueAt = word.indexOf("=");
	const name = valueAt < 0 ? word : word.slice(0, valueAt);
	if (!name.startsWith("--") || name === "--") return false;
	return (
		name.startsWith("--batch") ||
		STDIN_OPTIONS.some((option) => option.startsWith(name))
	);
}

/**
 * @typedef {{cwd: string, args: string[], answer: string}} GitCall
 *   a git call to run again: its directory, repo-relative, its words, and
 *   the answer the test got, `<status>:<sha1 of stdout>`
 * @typedef {{files: string[], absent: string[], dirs: string[],
 *   lists: Record<string, string>, trees: string[], scripts: string[],
 *   git: GitCall[]}} Reads
 *   repo-relative: files read or probed, paths probed and found absent,
 *   directories probed, each listed directory with its listing's id, trees
 *   walked or copied whole, the scripts a shell child ran, and the git calls
 *   it made here
 * @typedef {{reads: Reads} | {doubt: string}} Audit
 */
/**
 * One log line, of the kinds the preload writes and a trace reads as; a
 * line of any other kind is a doubt.
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
 *   the paths a test wrote to an untraced child's pipe, or none for a
 *   stream handed whole
 * @typedef {import("./read-audit-provenance.js").Provenance} Provenance
 * @typedef {{k: "child", file: string, bin: string[], args: string[],
 *   cwd: string, prov: Provenance, pid: number|null, hands?: Hand[],
 *   events?: string|null, within?: true, trace?: string}} ChildEntry
 *   a spawn: its program's name and file (lib/read-audit-provenance.js's
 *   `Spawned`), its words after the program, its directory, what the
 *   preload found it is, and how its reads are seen
 */

/**
 * Arm the audit for a run over `root`: set the environment every worker
 * inherits. Returns the log directory, or null where this process is itself
 * under an audit (a test's nested run), whose logs are its owner's.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env] accumulator: `WFC_READ_AUDIT`,
 *   `WFC_READ_AUDIT_ROOT`, `WFC_READ_AUDIT_TMP`, `WFC_READ_AUDIT_STRACE` and `NODE_OPTIONS` are
 *   filled here
 * @param {{write(s: string): unknown}} [err] told where no tracer works
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
		// What will not go now goes at a later run's sweep, once stale (#5046).
	}
}

/* A log directory's name: the prefix, the pid of the run that made it, and
 * mkdtemp's suffix. */
const PREFIX = "wfc-read-audit-";
const LOG_DIR_NAME = new RegExp(`^${escapeRe(PREFIX)}(\\d+)-`);

/* How long a dead run's directory stands untouched before it is stale: a pid
 * from another pid namespace sharing the tmpdir reads as dead here. The hour
 * #5046 named, a guess, unmeasured. */
const STALE_MS = 60 * 60 * 1000;

/**
 * Remove each log directory in `tmp` a killed run left: its pid dead and
 * the directory untouched for `STALE_MS` (#5046). Never throws.
 * @param {string} tmp
 * @param {number} [now]
 */
function sweep(tmp, now = Date.now()) {
	let names;
	try {
		names = fs.readdirSync(tmp);
	} catch {
		// No tmpdir listing, nothing to sweep: the run arms as before.
		return;
	}
	for (const name of names) {
		const pid = LOG_DIR_NAME.exec(name)?.[1];
		if (pid === undefined || pidAlive(Number(pid))) continue;
		const dir = path.join(tmp, name);
		try {
			if (now - fs.lstatSync(dir).mtimeMs > STALE_MS) remove(dir);
		} catch {
			// Gone already: another run's sweep took it.
		}
	}
}

/**
 * Each audited test file's reads, off the logs in `dir`. A file absent from
 * the result was never claimed by a process of its own.
 * @param {string} dir
 * @param {string} root the root the audit was armed over
 * @param {import("./read-audit-trace.js").Clock} [clock] the wait for a
 *   trace to settle
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
 *   one owner's logs, by process; the git calls the guard logged for it;
 *   and what its suite's setup settled
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
		/* A line that will not parse is a read that may be lost: a fault. */
		const { rows, bad } = parseJsonl(text());
		if (bad.length > 0) rows.push({ k: "fault" });
		/* A kind outside `Entry`'s is doubted where it is taken. */
		at(String(log[1])).logs.set(Number(log[2]), /** @type {Entry[]} */ (rows));
	}
	return owners;
}

/**
 * @typedef {{at: number, steered: string, dir: string, pid: number,
 *   answer: string, env: Record<string, string>, args: string[]}} GitRecord
 *   one guard record, at its byte offset in the log; `answer` is empty on
 *   the record made before git ran; `env` the variables changing git's
 *   answer
 */

/**
 * The guard's records: each its field count, then that many NUL-ended
 * fields — the git-dir flag, the directory, the pid, the answer, the count
 * of `env`'s pairs and each as `name=value`, the words. Read as Latin-1,
 * one character a byte, so each record's offset is its byte's; each field
 * is then decoded as UTF-8.
 * @param {Buffer} bytes
 * @returns {GitRecord[]}
 */
function parseGitRecords(bytes) {
	const fields = bytes.toString("latin1").split("\0");
	const utf8 = (/** @type {string} */ f) =>
		Buffer.from(f, "latin1").toString("utf8");
	/** @type {GitRecord[]} */
	const out = [];
	for (let i = 0, at = 0; i < fields.length - 1; ) {
		const n = Number(fields[i]);
		const pairs = Number(fields[i + 5]);
		if (!Number.isInteger(n) || n < 5) throw new Error("a git record is torn");
		if (!Number.isInteger(pairs) || pairs < 0 || pairs > n - 5)
			throw new Error("a git record is torn");
		const [steered = "", dir = "", pid = "", answer = "", , ...rest] = fields
			.slice(i + 1, i + 1 + n)
			.map(utf8);
		out.push({
			at,
			steered,
			dir,
			pid: Number(pid),
			answer,
			env: parseEnvPairs(rest.slice(0, pairs)),
			args: rest.slice(pairs),
		});
		for (const f of fields.slice(i, i + n + 1)) at += f.length + 1;
		i += n + 1;
	}
	return out;
}

/**
 * `name=value` pairs as a record.
 * @param {string[]} pairs
 * @returns {Record<string, string>}
 */
function parseEnvPairs(pairs) {
	/** @type {Record<string, string>} */
	const env = {};
	for (const pair of pairs) {
		const eq = pair.indexOf("=");
		env[pair.slice(0, eq)] = pair.slice(eq + 1);
	}
	return env;
}

/**
 * One owner's reads, or the doubt that voids them.
 * @param {Owner} owner
 * @param {string} root real path
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
	const reads = buildCollector(logs, scope, readers);
	for (const record of git) {
		const why = setApart(record, standing) ?? reads.takeGit(record);
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
 * @typedef {{trace: ReturnType<typeof buildTraceReader>,
 *   gitEvents: ReturnType<typeof buildGitEventsReader>}} Readers
 *   a traced child's reads, and what a git child ran
 */

/**
 * @typedef {{root: string, isScratch: (p: string) => boolean,
 *   recorded: Set<number>, spelt: (word: string) => string[]}} Scope
 *   one owner's judging: the root's real path, a test's scratch, the pids
 *   of the git calls the guard recorded, and the repo-relative paths a word
 *   spells by the root's absolute name (lib/read-audit-handed.js)
 */

/**
 * The reads one owner's log entries add up to.
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
	/** @type {Map<string, {cwd: string, args: string[], begun: number,
	 *   answers: string[]}>} */
	const calls = new Map();
	/** @type {Map<number, ChildEntry>} */
	const children = new Map();
	/* What `judge` weighs before it takes any line. */
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
		 * @param {GitRecord} record
		 * @returns {string|null}
		 */
		takeGit(record) {
			const { answer } = record;
			const call = rerunnable(record, root);
			if (typeof call === "string") return call;
			const key = JSON.stringify(call);
			const at = calls.get(key) ?? { ...call, begun: 0, answers: [] };
			if (answer === "") at.begun += 1;
			else at.answers.push(answer);
			calls.set(key, at);
			return null;
		},
		/** @returns {Audit} */
		finish() {
			const git = answeredCalls(calls.values());
			if (!Array.isArray(git)) return git;
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

/**
 * Each git call with the one answer the test got, or the doubt where one has
 * none or two.
 * @param {Iterable<{cwd: string, args: string[], begun: number,
 *   answers: string[]}>} calls
 * @returns {GitCall[]|{doubt: string}}
 */
function answeredCalls(calls) {
	/** @type {GitCall[]} */
	const git = [];
	for (const { cwd, args, begun, answers } of calls) {
		const shown = `git ${args.join(" ")}`.slice(0, SHOWN_MAX);
		const [answer, ...rest] = answers;
		if (answer === undefined || answers.length !== begun)
			return { doubt: `a git call (${shown}) was logged without its answer` };
		if (rest.some((a) => a !== answer))
			return {
				doubt: `a git call (${shown}) answered differently within the run`,
			};
		git.push({ cwd, args, answer });
	}
	return git;
}

/**
 * The doubt a git call made after the setup settled leaves where a variable
 * changing git's answer was set, or unset, otherwise than settled; null
 * where none was, or the call was made before, as the setup's own. The
 * audit's own event target is no test's. The setup's own `GIT_CONFIG_*`
 * (vitest.setup.ts) stands in the settled environment but not in the
 * store's run again; neither changes a read-only answer.
 * @param {GitRecord} record
 * @param {Standing} standing
 * @returns {string|null}
 */
function setApart({ at, env, args }, { env: settled, gitAt }) {
	if (at < gitAt) return null;
	const names = new Set([...Object.keys(env), ...Object.keys(settled)]);
	const apart = [...names]
		.filter((v) => GIT_ANSWER_VARS.test(v) && v !== GIT_EVENTS)
		.filter((v) => env[v] !== settled[v])
		.sort();
	if (apart.length === 0) return null;
	const shown = `git ${args.join(" ")}`.slice(0, SHOWN_MAX);
	return `a git call (${shown}) ran under a variable that steers git (${apart.join(", ")})`;
}

/**
 * A guard record as a git call to run again, or the doubt it leaves where it
 * cannot be run again.
 * @param {GitRecord} record
 * @param {string} root real path
 * @returns {{cwd: string, args: string[]}|string}
 */
function rerunnable({ steered, dir, args }, root) {
	const shown = `git ${args.join(" ")}`.slice(0, SHOWN_MAX);
	if (!isUnder(dir, [root], path.sep))
		return `a git call (${shown}) read another checkout of this repository`;
	const cwd = toPosix(path.relative(root, dir)) || ".";
	if (steered) return `a git call (${shown}) was steered by a git-dir variable`;
	let i = 0;
	while (i < args.length && String(args[i]).startsWith("-")) {
		const a = String(args[i]);
		if (a === "-C" || a.startsWith("--git-dir") || a.startsWith("--work-tree"))
			return `a git call (${shown}) named its repository`;
		i += GIT_VALUED.has(a) ? 2 : 1;
	}
	if (!RERUN.has(String(args[i])))
		return `a git call (${shown}) read this repository`;
	/* `--output` sends the answer to a file, so stdout, which the answer is
	 * hashed off, holds none of it (#4993). */
	if (args.some((a) => a === "--output" || String(a).startsWith("--output=")))
		return `a git call (${shown}) wrote its answer to a file`;
	if (args.slice(i + 1).some(isDescriptorFed))
		return `a git call (${shown}) read its standard input or another descriptor`;
	return { cwd, args };
}

/* Programs that run their first non-option argument as a script. */
const SHELL_RUNNERS = new Set(["bash", "sh"]);
const PYTHON_RUNNERS = new Set(["python3", "python"]);

/**
 * Why a spawned child leaves its file's reads unknown, or null where its
 * reads are seen.
 * @param {ChildEntry} e
 * @param {Program|null} program the checkout file it ran as its program
 * @param {Map<number, Entry[]>} logs the owner's logs
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
	/* A tracer already following the process that spawned it follows it too. */
	if (e.within) return null;
	return unseenDoubt(e, program, root, isScratch);
}

/**
 * Why a git call the guard ran leaves its file's reads unknown, or null.
 * One it kept no record of is judged on what handed it the
 * checkout, as any other child (#5015).
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
 * Why a child nothing logs or traces leaves its file's reads unknown, or
 * null where it read nothing of the checkout beside the git guard a git
 * call ran through.
 * @param {ChildEntry} e
 * @param {Program|null} program the checkout file it ran as its program
 * @param {string} root real path
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
 * The first thing that handed a child a checkout path it may read unseen:
 * not the script a runner was handed to run, which is a read; not a path in
 * a test's scratch; not a standing variable handed to a program that reads
 * none.
 * @param {ChildEntry} e
 * @param {string|null} script the argument `scriptOf` found
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
 * Why what a test wrote to an untraced child's input pipe once it ran
 * leaves its file's reads unknown (#4997), or null where the child reads
 * none of its input or the paths are the test's own scratch.
 * @param {PipedEntry} e
 * @param {ChildEntry|undefined} child the child it was written to
 * @param {Scope} scope a recorded git's run again vouches for what its
 *   input fed it
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
 * Why what a git child ran leaves its file's reads unknown, off the event
 * log its spawn handed it (lib/read-audit-git-events.js), or null where it
 * ran only git, or never started.
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

/**
 * A child as a doubt quotes it.
 * @param {ChildEntry} e
 */
function shownChild(e) {
	const args = /** @type {string[]} */ (e.args ?? []);
	return `${path.basename(String(e.file))} ${args.join(" ")}`.slice(
		0,
		SHOWN_MAX,
	);
}

/**
 * The checkout script a runner child was handed to run from a file. Null
 * where it was handed none, or a program inline.
 * @param {ChildEntry} e
 * @param {string} root real path
 * @returns {string|null} the argument as given
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

/**
 * @typedef {{script: string, runs: "shell"|"node"|"guard"|"other"}} Program
 *   a checkout file a child ran as its program, repo-relative, and what runs
 *   it: a shell or Node where its `#!` line names one and the lexical reach
 *   reads the file as that language, so keys what it loads; else `other`,
 *   Python and a binary among them, whose reads no reach holds; `guard`,
 *   the git guard, which reads of the checkout only where a git directory
 *   stands, its own repository's and the call's (`rev-parse
 *   --git-common-dir`, in a child nothing logs): a path, which no tracked
 *   file's content moves. A shell script's reads are a trace's alone: the reach
 *   holds its loads, never what it opens beside itself
 */

/**
 * The checkout file a child ran as its program, outside a test's scratch
 * (#4790); null where its program is no such file. One run through a link
 * is `other`: a script finds its own directory by the path it was run as.
 * @param {ChildEntry} e
 * @param {string} root real path
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
 * The checkout scripts a child whose reads are seen ran, repo-relative, as
 * reads: the one a runner was handed, and the child's own program, any but
 * one whose reads no reach holds.
 * @param {ChildEntry} e
 * @param {Program|null} program the checkout file it ran as its program
 * @param {string} root real path
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

module.exports = { install, readAudits, remove };
