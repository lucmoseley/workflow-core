/*
 * plugin-record.js — what the adopter's `## Plugin provenance` block records:
 * the plugin source and the commit it was installed at. Init builds it from
 * the source it was given (`readPluginRecord`), upgrade from the pin in the
 * adopter's settings and the plugin it is running (`readInstalledRecord`, #941).
 */

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
 * A directory source's own git identity. Non-fatal: no git, or any failure
 * reading it, leaves both null. A `status` failure after a good `rev-parse`
 * still returns the sha it found, dirty null rather than discarding it
 * (#108 review).
 * @param {string} pluginRoot
 * @returns {{headSha: string|null, dirty: boolean|null}}
 */
function readDirectoryGit(pluginRoot) {
	/* `.git` must be pluginRoot's OWN, not an ancestor's: `git rev-parse HEAD`
	 * alone walks up looking for a repo, so a nested directory with no git of
	 * its own would otherwise inherit an ancestor checkout's HEAD (#108
	 * review). */
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
 * The sha `plugins/installed_plugins.json` records for `root`'s own install
 * of `pluginName` — the CLI's record of what it actually installed, never the
 * marketplace clone's HEAD, which tracks a moving branch (#108 review). Null
 * unless that row is the release `version` names: another repo's row, or this
 * repo's row for another release, would name the wrong commit (#955).
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
 * What was materialised (#108). A directory source reads its own checkout.
 * A url source carries the ref passed, plus `installedSha` for that ref —
 * null on a first run before install, real on a re-run even under
 * `--no-plugin-install`, since the file, not this run's own outcome, is read
 * fresh every time.
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
 * The record of `plugin` as installed for the adopter at `root`, so an
 * upgrade's re-render names the release installed now (#941). A url or git
 * source's ref is the installed version, its sha `installedSha`'s; a
 * directory source reads its checkout, as `readPluginRecord` does. Null where
 * there is no pin, no marketplace, or a directory source with no path.
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
