const fs = require("node:fs");
const path = require("node:path");
const {
	RULES_FILE,
	REFERENCE_FILE,
	provenanceHolder,
	recordedUrlSha,
} = require("./adopter-skeleton.js");
const {
	findInstallRecord,
	isTagRef,
	releaseSha,
	resolveConfigDir,
	sameRelease,
} = require("./plugin-state.js");
const { gitOrNull, GIT_TIMEOUT_MS } = require("./git.js");
const { readText } = require("./file-read.js");

/** @typedef {{source: "url", url: string, ref: string} | {source: "directory", path: string}} PluginSource */
/** @typedef {{source: "directory", headSha: string|null, dirty: boolean|null} |
 *   {source: "url", ref: string, resolvedSha: string|null}} PluginRecord */
/** @typedef {{root: string, pluginName: string, marketplace: string,
 *   configDir?: string}} InstallKey */

/**
 * @param {string} pluginRoot
 * @returns {{headSha: string|null, dirty: boolean|null}}
 */
function readDirectoryGit(pluginRoot) {
	if (!fs.existsSync(path.join(pluginRoot, ".git")))
		return { headSha: null, dirty: null };
	const at = { cwd: pluginRoot, timeout: GIT_TIMEOUT_MS };
	const headSha = gitOrNull(["rev-parse", "HEAD"], at);
	if (headSha === null) return { headSha: null, dirty: null };
	const status = gitOrNull(["status", "--porcelain"], at);
	return {
		headSha: headSha.trim(),
		dirty: status === null ? null : status.trim().length > 0,
	};
}

/**
 * @param {InstallKey & {version: string}} at
 * @returns {string|null}
 */
function installedSha({ root, pluginName, marketplace, version, configDir }) {
	const pluginsDir = path.join(resolveConfigDir(configDir), "plugins");
	const row = findInstallRecord(
		pluginsDir,
		pluginName,
		marketplace,
		path.resolve(root),
	);
	if (row && sameRelease(row.version, version) && row.gitCommitSha)
		return row.gitCommitSha;
	return releaseSha(pluginsDir, pluginName, marketplace, version);
}

/**
 * #5826
 * @param {string} root
 * @param {string} ref
 * @returns {string|null}
 */
function recordedSha(root, ref) {
	if (!isTagRef(ref)) return null;
	/** @param {string} rel */
	const read = (rel) => {
		const text = readText(path.join(root, rel));
		return text.state === "read" ? text.data : null;
	};
	const text = provenanceHolder(read(REFERENCE_FILE), read(RULES_FILE));
	return text === null ? null : recordedUrlSha(text, ref);
}

/**
 * @param {InstallKey & {ref: string, version: string}} at
 * @returns {PluginRecord}
 */
const urlRecord = (at) => ({
	source: "url",
	ref: at.ref,
	resolvedSha: installedSha(at) ?? recordedSha(at.root, at.ref),
});

/**
 * @param {PluginSource} source
 * @param {InstallKey} at
 * @returns {PluginRecord}
 */
function readPluginRecord(source, at) {
	if (source.source === "url")
		return urlRecord({ ...at, ref: source.ref, version: source.ref });
	return { source: "directory", ...readDirectoryGit(source.path) };
}

/**
 * @param {{root: string, plugin: {name: string, version: string},
 *   marketplace: string|null,
 *   source: import("./plugin-state.js").MarketplaceSource|null}} at
 * @returns {PluginRecord|null}
 */
function readInstalledRecord({ root, plugin, marketplace, source }) {
	if (!source || !marketplace) return null;
	if (source.source === "directory")
		return typeof source.path === "string"
			? { source: "directory", ...readDirectoryGit(source.path) }
			: null;
	return urlRecord({
		root,
		pluginName: plugin.name,
		marketplace,
		ref: `v${plugin.version}`,
		version: plugin.version,
	});
}

module.exports = { readPluginRecord, readInstalledRecord };
