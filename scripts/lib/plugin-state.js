const fs = require("node:fs");
const path = require("node:path");
const { configDir: defaultConfigDir } = require("./config-dir.js");
const { gitOrNull } = require("./git.js");

/**
 * @typedef {{source?: string, ref?: string, url?: string, path?: string}} MarketplaceSource
 * @typedef {{enabledPlugins?: Record<string, boolean>,
 *   extraKnownMarketplaces?: Record<string, {source?: MarketplaceSource}>}} AdopterSettings
 * @typedef {Record<string, {source?: MarketplaceSource, installLocation?: string}>} KnownMarketplaces
 * @typedef {{plugins?: Record<string, {projectPath?: string, installPath?: string,
 *   version?: string, gitCommitSha?: string}[]>}} InstalledPlugins
 * @typedef {{name?: string, version?: string}} PluginManifest
 */

/**
 * @param {string} at
 * @returns {unknown}
 */
function readJsonSafe(at) {
	try {
		return JSON.parse(fs.readFileSync(at, "utf8"));
	} catch {
		return null;
	}
}

/**
 * @param {string} root
 * @returns {boolean}
 */
const shipsPlugin = (root) =>
	fs.existsSync(path.join(root, ".claude-plugin", "plugin.json"));

/**
 * @param {string} root
 * @returns {boolean}
 */
function isCoreHost(root) {
	const manifest = /** @type {PluginManifest|null} */ (
		readJsonSafe(path.join(root, ".claude-plugin", "plugin.json"))
	);
	return manifest?.name === "workflow-core";
}

/** @param {string} [configDir] */
function resolveConfigDir(configDir) {
	return configDir ?? defaultConfigDir();
}

const TAG_REF = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** @param {string|null|undefined} ref @returns {boolean} */
function isTagRef(ref) {
	return typeof ref === "string" && TAG_REF.test(ref);
}

/**
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
function sameRelease(a, b) {
	if (typeof a !== "string" || typeof b !== "string") return false;
	return a.replace(/^v/, "") === b.replace(/^v/, "");
}

/**
 * @param {AdopterSettings|null|undefined} settings
 * @param {string|null} pluginName
 * @returns {{marketplace: string|null, ref: string|null, source: MarketplaceSource|null}}
 */
function findPin(settings, pluginName) {
	const enabled = settings?.enabledPlugins ?? {};
	const raw = settings?.extraKnownMarketplaces;
	const known =
		raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	for (const key of Object.keys(enabled)) {
		const [name, marketplace] = key.split("@");
		if (
			name === pluginName &&
			marketplace &&
			Object.hasOwn(known, marketplace)
		) {
			const source = known[marketplace]?.source ?? {};
			return { marketplace, ref: source.ref ?? null, source };
		}
	}
	return { marketplace: null, ref: null, source: null };
}

/**
 * @param {string} pluginsDir
 * @param {string|null} marketplace
 * @returns {{dir: string|null, sourceType: "directory"|"git"|"unknown"}}
 */
function resolveMarketplace(pluginsDir, marketplace) {
	if (!marketplace) return { dir: null, sourceType: "unknown" };
	const fallback = path.join(pluginsDir, "marketplaces", marketplace);
	const doc = /** @type {KnownMarketplaces|null} */ (
		readJsonSafe(path.join(pluginsDir, "known_marketplaces.json"))
	);
	const entry = doc?.[marketplace];
	const src = entry?.source;
	if (src?.source === "directory")
		return {
			dir: entry?.installLocation || src.path || fallback,
			sourceType: "directory",
		};
	return { dir: entry?.installLocation || fallback, sourceType: "git" };
}

/**
 * @param {string|null} dir
 * @returns {{ref: string, kind: "tag"|"branch"}|null}
 */
function readGitRef(dir) {
	if (!dir || !fs.existsSync(path.join(dir, ".git"))) return null;
	const run = (/** @type {string[]} */ args) =>
		gitOrNull(args, {
			cwd: dir,
			// guess, workflow-core#243
			timeout: 10_000,
		})?.trim() ?? null;
	const tag = run(["describe", "--tags", "--exact-match"]);
	if (tag) return { ref: tag, kind: "tag" };
	const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
	return branch ? { ref: branch, kind: "branch" } : null;
}

/**
 * @param {string} pluginsDir
 * @param {string|null} pluginName
 * @param {string|null} marketplace
 * @param {string} root
 * @returns {{installPath: string, version: string|null, gitCommitSha: string|null}|null}
 */
function findInstallRecord(pluginsDir, pluginName, marketplace, root) {
	if (!pluginName || !marketplace) return null;
	const doc = /** @type {InstalledPlugins|null} */ (
		readJsonSafe(path.join(pluginsDir, "installed_plugins.json"))
	);
	const entries = doc?.plugins?.[`${pluginName}@${marketplace}`];
	if (!Array.isArray(entries)) return null;
	const rows = entries.filter((e) => e?.projectPath === root);
	const row = rows.at(-1);
	if (!row?.installPath) return null;
	return {
		installPath: row.installPath,
		version: row.version ?? null,
		gitCommitSha: row.gitCommitSha ?? null,
	};
}

/**
 * @param {string|null} installPath
 * @returns {{version: string}|null}
 */
function readRunningPlugin(installPath) {
	if (!installPath) return null;
	const doc = /** @type {PluginManifest|null} */ (
		readJsonSafe(path.join(installPath, ".claude-plugin", "plugin.json"))
	);
	return typeof doc?.version === "string" ? { version: doc.version } : null;
}

/**
 * @param {string} root
 * @param {string|null} pluginName
 * @returns {{
 *   marketplace: string|null,
 *   pinRefKind: "tag"|"unfixed"|null,
 *   directorySourced: boolean,
 *   pin: {marketplace: string, ref: string, url: string|null}|null,
 * }}
 */
function readPin(root, pluginName) {
	const settings = /** @type {AdopterSettings|null} */ (
		readJsonSafe(path.join(root, ".claude", "settings.json"))
	);
	const {
		marketplace,
		ref: pinRef,
		source: pinSource,
	} = findPin(settings, pluginName);
	const directorySourced = pinSource?.source === "directory";
	/** @type {"tag" | "unfixed" | null} */
	let pinRefKind = null;
	if (pinRef !== null) pinRefKind = isTagRef(pinRef) ? "tag" : "unfixed";
	const pin =
		marketplace && pinRef && !directorySourced && pinRefKind === "tag"
			? {
					marketplace,
					ref: pinRef,
					url: typeof pinSource?.url === "string" ? pinSource.url : null,
				}
			: null;
	return { marketplace, pinRefKind, directorySourced, pin };
}

/**
 * @param {{root: string, pluginRoot: string, configDir?: string}} at
 * @returns {{
 *   pin: {marketplace: string, ref: string, url: string|null}|null,
 *   pinRefKind: "tag"|"unfixed"|null,
 *   directorySourced: boolean,
 *   supply: {dir: string|null, sourceType: "directory"|"git"|"unknown", ref: string|null, refKind: "tag"|"branch"|null},
 *   installRecord: {installPath: string, version: string|null, gitCommitSha: string|null}|null,
 *   runningPlugin: {version: string}|null,
 *   loadedVersion: string|null,
 *   installAtPin: boolean,
 *   gaps: {supplyBehindPin: boolean, installBehindSupply: boolean},
 *   materialisedNotLive: boolean,
 *   contention: string|null,
 * }}
 */
function readPluginState({ root, pluginRoot, configDir }) {
	const cfg = resolveConfigDir(configDir);
	const pluginsDir = path.join(cfg, "plugins");

	const plugin = /** @type {PluginManifest|null} */ (
		readJsonSafe(path.join(pluginRoot, ".claude-plugin", "plugin.json"))
	);
	const pluginName = plugin?.name ?? null;
	const loadedVersion =
		typeof plugin?.version === "string" ? plugin.version : null;

	const { marketplace, pinRefKind, directorySourced, pin } = readPin(
		root,
		pluginName,
	);

	const marketplaceInfo = resolveMarketplace(pluginsDir, marketplace);
	const head =
		marketplaceInfo.sourceType === "git"
			? readGitRef(marketplaceInfo.dir)
			: null;
	const supplyRef = head?.ref ?? null;

	const installRecord = findInstallRecord(
		pluginsDir,
		pluginName,
		marketplace,
		root,
	);
	const runningPlugin = readRunningPlugin(installRecord?.installPath ?? null);

	const installAtPin = !!(
		pin &&
		runningPlugin &&
		sameRelease(runningPlugin.version, pin.ref)
	);

	const supplyBehindPin =
		pin && !installAtPin
			? marketplaceInfo.sourceType !== "git" || !sameRelease(supplyRef, pin.ref)
			: false;

	const installBehindSupply = !!(pin && runningPlugin && !installAtPin);

	const materialisedNotLive = !!(
		pin &&
		!supplyBehindPin &&
		!installBehindSupply &&
		loadedVersion &&
		runningPlugin &&
		!sameRelease(loadedVersion, runningPlugin.version)
	);

	const contention =
		pin &&
		!installAtPin &&
		head?.kind === "tag" &&
		!sameRelease(head.ref, pin.ref)
			? head.ref
			: null;

	return {
		pin,
		pinRefKind,
		directorySourced,
		supply: {
			dir: marketplaceInfo.dir,
			sourceType: marketplaceInfo.sourceType,
			ref: supplyRef,
			refKind: head?.kind ?? null,
		},
		installRecord,
		runningPlugin,
		loadedVersion,
		installAtPin,
		gaps: { supplyBehindPin, installBehindSupply },
		materialisedNotLive,
		contention,
	};
}

/**
 * @param {string|undefined} configDir
 * @param {string} marketplace
 * @param {string} pluginName
 * @param {string} version
 */
function installPathFor(configDir, marketplace, pluginName, version) {
	return path.join(
		resolveConfigDir(configDir),
		"plugins",
		"cache",
		marketplace,
		pluginName,
		version.replace(/^v/, ""),
	);
}

module.exports = {
	readPluginState,
	readJsonSafe,
	isCoreHost,
	shipsPlugin,
	findPin,
	readPin,
	resolveMarketplace,
	findInstallRecord,
	readRunningPlugin,
	resolveConfigDir,
	isTagRef,
	sameRelease,
	installPathFor,
};
