const fs = require("node:fs");
const { caught } = require("./caught.js");
const { execGit } = require("./git.js");
const { brokenError } = require("./outcome-error.js");

/**
 * @param {string} [cwd]
 * @returns {string[]}
 */
function readMergeHeadLines(cwd) {
	let file;
	try {
		file = String(
			execGit(
				["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"],
				{
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				},
			),
		).trim();
	} catch (e) {
		throw brokenError(
			`git would not locate MERGE_HEAD: ${caught(e).message} — run \`git rev-parse --git-path MERGE_HEAD\` to see git's own error`,
		);
	}
	if (!file)
		throw brokenError(
			"git rev-parse --git-path MERGE_HEAD printed no path — run it to see git's own answer",
		);
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (caught(e).code === "ENOENT") return [];
		throw brokenError(
			`could not read MERGE_HEAD at ${file}: ${caught(e).message}`,
		);
	}
	return text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

const SHA_HEX = "[0-9a-f]{40}|[0-9a-f]{64}";
const GITHEAD_ENV = new RegExp(`^GITHEAD_(${SHA_HEX})$`);

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function githeadShas(env) {
	return Object.keys(env).flatMap((k) => {
		const m = GITHEAD_ENV.exec(k);
		return m?.[1] ? [m[1]] : [];
	});
}

/**
 * @param {string} [cwd]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function readMergingHeads(cwd, env = process.env) {
	const lines = readMergeHeadLines(cwd);
	return lines.length > 0 ? lines : githeadShas(env);
}

// #5334
const MERGE_PARENTS_ENV = "WFC_MERGE_PARENTS";

const UNREAD_PREFIX = "unread: ";

const SHA = new RegExp(`^(?:${SHA_HEX})$`);

/**
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
function withMergeParents(cwd, env) {
	const out = { ...env };
	if (out[MERGE_PARENTS_ENV] !== undefined) return out;
	try {
		out[MERGE_PARENTS_ENV] = readMergingHeads(cwd, env).join(" ");
	} catch (error) {
		out[MERGE_PARENTS_ENV] = `${UNREAD_PREFIX}${caught(error).message}`;
	}
	return out;
}

/**
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function readMergeParents(cwd, env = process.env) {
	const handed = env[MERGE_PARENTS_ENV];
	if (handed === undefined) return readMergingHeads(cwd, env);
	if (handed.startsWith(UNREAD_PREFIX))
		throw brokenError(
			`the committing checkout's merge parents would not read: ${handed.slice(UNREAD_PREFIX.length)}`,
		);
	const shas = handed.split(" ").filter(Boolean);
	if (!shas.every((s) => SHA.test(s)))
		throw brokenError(`${MERGE_PARENTS_ENV} holds no list of shas: ${handed}`);
	return shas;
}

module.exports = {
	MERGE_PARENTS_ENV,
	githeadShas,
	readMergeHeadLines,
	readMergeParents,
	readMergingHeads,
	withMergeParents,
};
