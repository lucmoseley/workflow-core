/*
 * read-audit-git.js — a git call's identity under the read audit (#5078):
 * the record the git guard (lib/host-git-guard/git) writes for each call on
 * this checkout's repository, git's own options before the subcommand, the
 * variables changing what a call answers, which calls the pass store may run
 * again, the key and answer id a row stores, and that run again.
 *
 * A GIT CALL ON THIS REPOSITORY is a read `fs` never sees. One of the
 * read-only subcommands in `RERUN`, made from a directory under the root
 * with no `-C`, `--git-dir`, `--work-tree`, git-dir variable or `--output`
 * steering it and nothing fed to it on standard input, is kept word for word
 * with the answer the guard saw it give: the store keys it on its output run
 * again, and only where that equals what the test got (#4993). A call the
 * guard logged begun and never answered, or that answered the same words two
 * ways, is a doubt. So is one made after the suite's setup settled under a
 * variable changing git's answer (`GIT_ANSWER_VARS`) set otherwise than it
 * was settled (#5017).
 *
 * The guard is the one writer and is bash, for speed; read-audit-git.test.ts
 * pins its option list, its variable loop and its record to this module.
 * lib/read-audit-preload.js loads the option walk into every audited
 * process, so this requires nothing beside Node's own modules and the libs
 * the preload loads already.
 */

const crypto = require("node:crypto");
const path = require("node:path");
const { isUnder } = require("./is-under.js");
const { GIT_EVENTS, SHOWN_MAX, toPosix } = require("./read-audit-paths.js");

/* git's options before the subcommand that take the next word as a value
 * (git.c's `handle_options`). `--exec-path` takes one only after `=`: alone
 * it prints git's exec path and exits. */
const GIT_VALUED = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config-env",
	"--attr-source",
	"--shallow-file",
]);

/**
 * Step git's own options, the words before its subcommand: the
 * subcommand's index, or the words' length where none stands. A value
 * option also steps over the next word.
 * @param {readonly unknown[]} words the call's words after `git`
 * @param {(option: string, at: number) => void} [onOption] handed each
 *   option and its index
 * @returns {number}
 */
function stepGitOptions(words, onOption) {
	let at = 0;
	while (at < words.length) {
		const word = String(words[at]);
		if (!word.startsWith("-")) break;
		onOption?.(word, at);
		at += GIT_VALUED.has(word) ? 2 : 1;
	}
	return Math.min(at, words.length);
}

/* The variables git reads a path from: its own, and where its configuration
 * lives (git(1), ENVIRONMENT VARIABLES; git-config(1), FILES). */
const GIT_READ_NAMES = "GIT_.*|HOME|XDG_CONFIG_HOME";
const GIT_READS = new RegExp(`^(${GIT_READ_NAMES})$`);

/* The variables changing what a git call answers: those, and the locale
 * and zone its messages and dates follow (#5017). The guard's loop spells
 * the same set. */
const GIT_ANSWER_VARS = new RegExp(
	`^(${GIT_READ_NAMES}|TZ|LANG|LANGUAGE|LC_.*)$`,
);

/* The variables that point git at a repository. vitest.setup.ts deletes each
 * in every test worker, so a run again goes without them too. */
const GIT_DIR_VARS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_PREFIX",
];

/**
 * @typedef {{at: number, steered: string, dir: string, pid: number,
 *   answer: string, env: Record<string, string>, args: string[]}} GitRecord
 *   one guard record, at its byte offset in the log; `answer` is empty on
 *   the record made before git ran; `env` the variables changing git's
 *   answer
 * @typedef {{cwd: string, args: string[]}} GitRun
 *   a git call to run again: its directory, repo-relative, and its words
 * @typedef {GitRun & {answer: string}} GitCall
 *   one with the answer the test got, `answerOf`'s
 * @typedef {import("./read-audit-paths.js").Standing} Standing
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
 * The key a row stores a git call under.
 * @param {GitRun} call
 */
const keyOf = ({ cwd, args }) => JSON.stringify({ cwd, args });

/**
 * A git call's answer: its exit status and the sha1 of its stdout, as the
 * guard's `sha1sum` spells it.
 * @param {number} status
 * @param {Buffer|string} stdout
 */
const answerOf = (status, stdout) =>
	`${status}:${crypto.createHash("sha1").update(stdout).digest("hex")}`;

/** @param {string[]} args */
const shownCall = (args) => `git ${args.join(" ")}`.slice(0, SHOWN_MAX);

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
	return `a git call (${shownCall(args)}) ran under a variable that steers git (${apart.join(", ")})`;
}

/**
 * A guard record as a git call to run again, or the doubt it leaves where it
 * cannot be run again.
 * @param {GitRecord} record
 * @param {string} root real path
 * @returns {GitRun|string}
 */
function rerunnable({ steered, dir, args }, root) {
	const shown = shownCall(args);
	if (!isUnder(dir, [root], path.sep))
		return `a git call (${shown}) read another checkout of this repository`;
	const cwd = toPosix(path.relative(root, dir)) || ".";
	if (steered) return `a git call (${shown}) was steered by a git-dir variable`;
	let named = false;
	const sub = stepGitOptions(args, (a) => {
		if (a === "-C" || a.startsWith("--git-dir") || a.startsWith("--work-tree"))
			named = true;
	});
	if (named) return `a git call (${shown}) named its repository`;
	if (!RERUN.has(String(args[sub])))
		return `a git call (${shown}) read this repository`;
	/* `--output` sends the answer to a file, so stdout, which the answer is
	 * hashed off, holds none of it (#4993). */
	if (args.some((a) => a === "--output" || String(a).startsWith("--output=")))
		return `a git call (${shown}) wrote its answer to a file`;
	if (args.slice(sub + 1).some(isDescriptorFed))
		return `a git call (${shown}) read its standard input or another descriptor`;
	return { cwd, args };
}

/**
 * Each git call with the one answer the test got, or the doubt where one has
 * none or two.
 * @param {Iterable<GitRun & {begun: number, answers: string[]}>} calls
 * @returns {GitCall[]|{doubt: string}}
 */
function answeredCalls(calls) {
	/** @type {GitCall[]} */
	const git = [];
	for (const { cwd, args, begun, answers } of calls) {
		const shown = shownCall(args);
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
 * One owner's guard records as the git calls to run again, each with its
 * one answer, or the doubt the first that cannot be leaves.
 * @param {GitRecord[]} records
 * @param {Standing} standing the environment the suite's setup settled
 * @param {string} root real path
 * @returns {GitCall[]|{doubt: string}}
 */
function gitCallsOf(records, standing, root) {
	/** @type {Map<string, GitRun & {begun: number, answers: string[]}>} */
	const calls = new Map();
	for (const record of records) {
		const apart = setApart(record, standing);
		if (apart) return { doubt: apart };
		const call = rerunnable(record, root);
		if (typeof call === "string") return { doubt: call };
		const key = keyOf(call);
		const at = calls.get(key) ?? { ...call, begun: 0, answers: [] };
		if (record.answer === "") at.begun += 1;
		else at.answers.push(record.answer);
		calls.set(key, at);
	}
	return answeredCalls(calls.values());
}

/**
 * @typedef {(args: string[], opts: {cwd: string, env: NodeJS.ProcessEnv}) =>
 *   {error?: Error, status: number|null, stdout: Buffer|string}} SpawnGit
 *   a synchronous git spawn
 */

/**
 * A git call run again at `root`, by its key: its answer, `answerOf`'s.
 * Memoised, as many rows rest on one call. Null where its key will not
 * parse or the call will not run. A test's call ran with none of
 * `GIT_DIR_VARS` set (vitest.setup.ts), so its run again does too.
 * @param {string} root
 * @param {SpawnGit} spawnGit
 * @returns {(key: string) => string|null}
 */
function buildGitRunner(root, spawnGit) {
	/** @type {Map<string, string|null>} */
	const memo = new Map();
	const env = { ...process.env };
	for (const v of GIT_DIR_VARS) delete env[v];
	return (key) => {
		if (memo.has(key)) return memo.get(key) ?? null;
		let id = null;
		try {
			const { cwd, args } = JSON.parse(key);
			const r = spawnGit(args, { cwd: path.join(root, cwd), env });
			if (!r.error && r.status !== null) id = answerOf(r.status, r.stdout);
		} catch {
			// A key that will not parse is a call that cannot run: no id, so
			// the row resting on it is not recorded and never holds (#4916).
			id = null;
		}
		memo.set(key, id);
		return id;
	};
}

module.exports = {
	buildGitRunner,
	GIT_ANSWER_VARS,
	GIT_DIR_VARS,
	GIT_READS,
	GIT_VALUED,
	keyOf,
	parseGitRecords,
	gitCallsOf,
	stepGitOptions,
};
