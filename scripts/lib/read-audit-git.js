const path = require("node:path");
const { GIT_VALUED } = require("./git-options.js");
const { isUnder } = require("./is-under.js");
const { GIT_EVENTS, SHOWN_MAX, toPosix } = require("./read-audit-paths.js");

/**
 * @param {readonly unknown[]} words
 * @param {(option: string, at: number) => void} [onOption]
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

const GIT_READ_NAMES = "GIT_.*|HOME|XDG_CONFIG_HOME";
const GIT_READS = new RegExp(`^(${GIT_READ_NAMES})$`);

const GIT_ANSWER_VARS = new RegExp(
	`^(${GIT_READ_NAMES}|TZ|LANG|LANGUAGE|LC_.*)$`,
);

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
 * @typedef {{cwd: string, args: string[]}} GitRun
 * @typedef {GitRun & {answer: string}} GitCall
 * @typedef {GitRun & {begun: number, answers: string[]}} GitTally
 * @typedef {import("./read-audit-paths.js").Standing} Standing
 */

/**
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

/** @param {GitRun} call */
const keyOf = ({ cwd, args }) => JSON.stringify({ cwd, args });

/**
 * @param {number} status
 * @param {Buffer|string} stdout
 */
const answerOf = (status, stdout) =>
	`${status}:${require("node:crypto").createHash("sha1").update(stdout).digest("hex")}`;

/** @param {string[]} args */
const shownCall = (args) => `git ${args.join(" ")}`.slice(0, SHOWN_MAX);

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

const STDIN_OPTIONS = [
	"--stdin",
	"--annotate-stdin",
	"--parseopt",
	"--batch",
	"--exclude-existing",
];

const STDIN_FILE = /^(?:-|-[^-].*-|--.+=-)$/;

const DESCRIPTOR_PATH =
	/\/(?:dev\/(?:stdin|stdout|stderr|fd\/\d+)|proc\/[^/]+\/(?:task\/[^/]+\/)?fd\/\d+)$/;

/** @param {string} word */
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
 * @param {GitRecord} record
 * @param {string} root
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
	if (args.some((a) => a === "--output" || String(a).startsWith("--output=")))
		return `a git call (${shown}) wrote its answer to a file`;
	if (args.slice(sub + 1).some(isDescriptorFed))
		return `a git call (${shown}) read its standard input or another descriptor`;
	return { cwd, args };
}

/**
 * @param {Iterable<GitTally>} calls
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
 * @param {GitRecord[]} records
 * @param {Standing} standing
 * @param {string} root
 * @returns {GitCall[]|{doubt: string}}
 */
function gitCallsOf(records, standing, root) {
	/** @type {Map<string, GitTally>} */
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
 */

/**
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
	keyOf,
	parseGitRecords,
	gitCallsOf,
	stepGitOptions,
};
