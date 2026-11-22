const fs = require("node:fs");
const path = require("node:path");
const {
	findInstallRecord,
	resolveConfigDir,
	sameRelease,
} = require("./plugin-state.js");
const { gitOrNull, GIT_TIMEOUT_MS } = require("./git.js");

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
	const row = findInstallRecord(
		path.join(resolveConfigDir(configDir), "plugins"),
		pluginName,
		marketplace,
		path.resolve(root),
	);
	return row && sameRelease(row.version, version) ? row.gitCommitSha : null;
}

/**
 * @param {PluginSource} source
 * @param {InstallKey} at
 * @returns {PluginRecord}
 */
function readPluginRecord(source, at) {
	if (source.source === "url") {
		return {
			source: "url",
			ref: source.ref,
			resolvedSha: installedSha({ ...at, version: source.ref }),
		};
	}
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
	return {
		source: "url",
		ref: `v${plugin.version}`,
		resolvedSha: installedSha({
			root,
			pluginName: plugin.name,
			marketplace,
			version: plugin.version,
		}),
	};
}

module.exports = { readPluginRecord, readInstalledRecord };
