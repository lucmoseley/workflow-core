const fs = require("node:fs");
const path = require("node:path");

const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");

const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

/** @param {string} file */
function readTextOrNull(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch (err) {
		if (ABSENT_CODES.has(caught(err).code ?? "")) return null;
		throw err;
	}
}

/**
 * @param {string} dir
 * @param {string} text
 */
function parseGitFileTarget(dir, text) {
	const gitDir = /^gitdir: (.+)$/m.exec(text)?.[1]?.trim();
	return gitDir ? path.resolve(dir, gitDir) : null;
}

/** @param {string} registration */
function readRegistrationCommonDir(registration) {
	const common = readTextOrNull(path.join(registration, "commondir"));
	if (common !== null) return path.resolve(registration, common.trim());
	return path.basename(path.dirname(registration)) === "worktrees"
		? path.dirname(path.dirname(registration))
		: null;
}

/**
 * @param {string} gitDir
 * @returns {string}
 */
function readGitDirCommonDir(gitDir) {
	const common = readTextOrNull(path.join(gitDir, "commondir"));
	return common === null ? gitDir : path.resolve(gitDir, common.trim());
}

/**
 * @param {string} start
 * @returns {{top: string, common: string | null} | null}
 */
function readRepoCommonDir(start) {
	for (let dir = start; ; dir = path.dirname(dir)) {
		const dotGit = path.join(dir, ".git");
		let text;
		try {
			text = fs.readFileSync(dotGit, "utf8");
		} catch (err) {
			const { code } = caught(err);
			if (code === "EISDIR")
				return { top: dir, common: readGitDirCommonDir(dotGit) };
			if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
			if (path.dirname(dir) === dir) return null;
			continue;
		}
		const target = parseGitFileTarget(dir, text);
		return { top: dir, common: target && readGitDirCommonDir(target) };
	}
}

/** @param {string} root */
function readGitFileCommonDir(root) {
	const text = readTextOrNull(path.join(root, ".git"));
	const registration = text === null ? null : parseGitFileTarget(root, text);
	return registration && readRegistrationCommonDir(registration);
}

/**
 * @param {string} common
 * @returns {string[]}
 */
function readRegistrations(common) {
	const base = path.join(common, "worktrees");
	try {
		return fs.readdirSync(base).map((name) => path.join(base, name));
	} catch (err) {
		if (ABSENT_CODES.has(caught(err).code ?? "")) return [];
		throw err;
	}
}

/** @param {string} registration */
function readRegisteredTree(registration) {
	const gitFile = readTextOrNull(path.join(registration, "gitdir"))?.trim();
	return gitFile ? path.dirname(path.resolve(registration, gitFile)) : null;
}

/**
 * @param {string} start
 * @returns {{dir: string, text: string}|null}
 */
function readGitFile(start) {
	for (let dir = start; ; dir = path.dirname(dir)) {
		try {
			return { dir, text: fs.readFileSync(path.join(dir, ".git"), "utf8") };
		} catch (err) {
			const { code } = caught(err);
			if (code === "EISDIR") return null;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
			if (path.dirname(dir) === dir) return null;
		}
	}
}

/** @param {string} file */
function realPathOrNull(file) {
	try {
		return fs.realpathSync(file);
	} catch {
		return null;
	}
}

/** @param {string} dir */
function readRegistrationFault(dir) {
	const dotGit = path.join(dir, ".git");
	const file = readText(dotGit);
	if (file.state === "absent") return null;
	if (file.state === "unreadable")
		return caught(file.error).code === "EISDIR"
			? null
			: `${dotGit} will not read: ${file.message}`;
	const registration = parseGitFileTarget(dir, file.data);
	if (registration === null) return `${dotGit} names no registration`;
	const back = readText(path.join(registration, "gitdir"));
	if (back.state === "unreadable")
		return `its registration ${registration} will not read: ${back.message}`;
	const gitFile = back.state === "read" ? back.data.trim() : "";
	if (!gitFile) return `its registration ${registration} is gone`;
	const tree = path.dirname(path.resolve(registration, gitFile));
	return realPathOrNull(path.join(tree, ".git")) === realPathOrNull(dotGit)
		? null
		: `its registration ${registration} names ${tree}`;
}

/**
 * @param {string} dir
 * @param {(fault: string) => void} say
 * @returns {() => boolean}
 */
function registrationGate(dir, say) {
	/** @type {string|null} */
	let said = null;
	return () => {
		const fault = readRegistrationFault(dir);
		if (fault !== null && fault !== said) say(fault);
		said = fault;
		return fault === null;
	};
}

module.exports = {
	parseGitFileTarget,
	readGitDirCommonDir,
	readRepoCommonDir,
	readGitFile,
	readGitFileCommonDir,
	readRegisteredTree,
	readRegistrationCommonDir,
	readRegistrationFault,
	readRegistrations,
	registrationGate,
};
