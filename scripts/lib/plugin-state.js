/*
 * plugin-state.js — the four-record read behind the adopter-upgrade
 * mechanism (#238, #231, #243). Shared between `scripts/check-plugin-gap.js`
 * (the SessionStart reporter), `scripts/upgrade.js` (which reads the pin the
 * same way) and `scripts/check-hook-liveness.js` (which resolves the same
 * marketplace directory), so they agree on what "behind" means without any
 * of them re-deriving it (#251 items 10 and 11).
 *
 * Pure reads: no `claude` subprocess, no network. Every accessor returns a
 * defined reading rather than throwing on an absent clone, a
 * directory-sourced global record, or an unreadable file — the caller is a
 * SessionStart hook, and a throw there is a broken session start, not a
 * reported gap.
 *
 * THE FOUR RECORDS, matching docs/agents/adopter-upgrade.md:
 *   pin            `root/.claude/settings.json` → `extraKnownMarketplaces`
 *   supply         `<configDir>/plugins/marketplaces/<marketplace>`, a git
 *                  clone rotated only by `claude plugin marketplace add`
 *   installRecord  `<configDir>/plugins/installed_plugins.json`, the row for
 *                  this `root` (`projectPath`)
 *   runningPlugin  `<installRecord.installPath>/.claude-plugin/plugin.json`
 *
 * `configDir` is a parameter everywhere (#238 user story 48): default is
 * `CLAUDE_CONFIG_DIR` then `~/.claude` (`resolveConfigDir`), the chain
 * `materialisePlugin`'s `run()` also uses, so a smoke test pointed at a
 * throwaway directory never touches the real registry.
 *
 * `isCoreHost` lives here beside the reader it uses: the one test, for the
 * report scripts and `pick-retro-sessions.js`, of whether a repo is
 * workflow-core itself rather than an adopter (#1509).
 */

const fs = require("node:fs");
const path = require("node:path");
const { configDir: defaultConfigDir } = require("./config-dir.js");
const { gitOrNull } = require("./git.js");

/**
 * The shapes of the four JSON files this module reads. They are partial by
 * construction: every field is written by the CLI, not by this repo, so a
 * field absent from a given build must narrow rather than throw (#251
 * item 14).
 *
 * @typedef {{source?: string, ref?: string, url?: string, path?: string}} MarketplaceSource
 * @typedef {{enabledPlugins?: Record<string, boolean>,
 *   extraKnownMarketplaces?: Record<string, {source?: MarketplaceSource}>}} AdopterSettings
 * @typedef {Record<string, {source?: MarketplaceSource, installLocation?: string}>} KnownMarketplaces
 * @typedef {{plugins?: Record<string, {projectPath?: string, installPath?: string,
 *   version?: string, gitCommitSha?: string}[]>}} InstalledPlugins
 * @typedef {{name?: string, version?: string}} PluginManifest
 */

/**
 * `unknown` rather than a type argument: each caller casts to the one shape
 * above that its own path expects, which is what keeps the cast auditable at
 * the call site instead of hidden here.
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
 * Whether the repo at `root` is workflow-core itself rather than an adopter:
 * its own `.claude-plugin/plugin.json` names it. An absent or unreadable
 * manifest answers false.
 * @param {string} root
 * @returns {boolean}
 */
function isCoreHost(root) {
	const manifest = /** @type {PluginManifest|null} */ (
		readJsonSafe(path.join(root, ".claude-plugin", "plugin.json"))
	);
	return manifest?.name === "workflow-core";
}

/**
 * The caller's `configDir`, else lib/config-dir.js's, which counts an empty
 * `CLAUDE_CONFIG_DIR` as set (#145, #2095).
 * @param {string} [configDir]
 */
function resolveConfigDir(configDir) {
	return configDir ?? defaultConfigDir();
}

/*
 * A pin is a FIXED TAG and nothing else (#243's edge readings). `source.ref`
 * also accepts a branch name and a SHA, and both are declined: neither names
 * a version, so neither can be compared against an installed one, and an
 * adopter carrying one has no pin to be behind. Semver-SHAPED, not full
 * semver: three numbers with an optional `v`, and one optional pre-release
 * OR build suffix, never both. A marketplace may tag with the `v` or without
 * it, so the prefix is optional (#251 item 12).
 */
const TAG_REF = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** @param {string|null|undefined} ref @returns {boolean} */
function isTagRef(ref) {
	return typeof ref === "string" && TAG_REF.test(ref);
}

/**
 * Two refs, or a ref and a bare version, naming the same release. The `v` is
 * presentational — `v1.1.8` and `1.1.8` are one tag under two spellings, and
 * comparing them literally reads a marketplace tagged without the prefix as
 * permanently behind (#251 item 12).
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
function sameRelease(a, b) {
	if (typeof a !== "string" || typeof b !== "string") return false;
	return a.replace(/^v/, "") === b.replace(/^v/, "");
}

/**
 * The adopter's declared intent for `pluginName`: `enabledPlugins`'
 * `<name>@<marketplace>` key, resolved against `extraKnownMarketplaces`.
 * `ref` is returned exactly as written — declining a branch or a SHA is
 * `readPluginState`'s job, not this one's, because `scripts/upgrade.js` reads
 * the raw source here to rewrite it (#251 item 10).
 * @param {AdopterSettings|null|undefined} settings
 * @param {string|null} pluginName
 * @returns {{marketplace: string|null, ref: string|null, source: MarketplaceSource|null}}
 */
function findPin(settings, pluginName) {
	const enabled = settings?.enabledPlugins ?? {};
	const raw = settings?.extraKnownMarketplaces;
	/* Own keys of a plain object only, as resolve-core.js reads them (#474). */
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
 * Where a marketplace's own tree lives, and what kind of source it is. A
 * `directory` source is never cloned under `plugins/marketplaces/<name>/`;
 * `installLocation` (or `source.path`) already IS the tree. Every other
 * source is fetched into that clone path, read whether or not it exists —
 * including one `known_marketplaces.json` does not mention at all, which is
 * why a missing entry reads `git` at the fallback path rather than
 * `unknown`: the clone can be sitting there regardless (#251 item 6).
 * `unknown` is left for the one case that genuinely has no tree to name, an
 * adopter with no marketplace at all.
 *
 * `scripts/check-hook-liveness.js`'s `resolveMarketplaceDir` is a thin
 * wrapper over this (#251 item 11).
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
 * The supply clone's HEAD: the tag it sits on exactly, else the branch name
 * (the broken state #238's incident describes — a clone left on `main` after
 * a hand-rotated pin). `kind` is what separates the two, because only a tag
 * can be another adopter's pin and so only a tag can be contention (#251
 * item 5). Null where the dir does not exist or is not a git checkout.
 * @param {string|null} dir
 * @returns {{ref: string, kind: "tag"|"branch"}|null}
 */
function readGitRef(dir) {
	if (!dir || !fs.existsSync(path.join(dir, ".git"))) return null;
	const run = (/** @type {string[]} */ args) =>
		gitOrNull(args, {
			cwd: dir,
			// A guess, never measured: a wedged git, not a slow one.
			timeout: 10_000,
		})?.trim() ?? null;
	const tag = run(["describe", "--tags", "--exact-match"]);
	if (tag) return { ref: tag, kind: "tag" };
	const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
	return branch ? { ref: branch, kind: "branch" } : null;
}

/**
 * The install record row for `root`, keyed `<pluginName>@<marketplace>` —
 * the last entry whose `projectPath` matches, `installed_plugins.json`
 * carrying one array entry per install/update.
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
 * The running plugin's own manifest version, read through the install
 * record's `installPath` — never `CLAUDE_PLUGIN_ROOT`, which can only answer
 * for the repo whose session is running (#238).
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
 * The adopter's pin for `pluginName`, read from its `.claude/settings.json`.
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
	/* A branch or a SHA is a ref but not a pin, so it reads as no pin at all
	 * rather than as a version this adopter could be behind (#243). */
	/** @type {"tag" | "unfixed" | null} */
	let pinRefKind = null;
	if (pinRef !== null) pinRefKind = isTagRef(pinRef) ? "tag" : "unfixed";
	const pin =
		marketplace && pinRef && !directorySourced && pinRefKind === "tag"
			? {
					marketplace,
					ref: pinRef,
					/* The real clone URL where the pin carries one, so the printed
					 * `marketplace add` is runnable rather than a template; `<url>`
					 * stays the fallback for a source naming none (#251 item 3). */
					url: typeof pinSource?.url === "string" ? pinSource.url : null,
				}
			: null;
	return { marketplace, pinRefKind, directorySourced, pin };
}

/**
 * The four-record read for one adopter root.
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

	/* Once the install matches the pin the supply's ref stops mattering to
	 * this adopter: it is read only at install time, so another adopter's
	 * tag sitting there is neither a gap nor contention (#738). */
	const installAtPin = !!(
		pin &&
		runningPlugin &&
		sameRelease(runningPlugin.version, pin.ref)
	);

	/* A directory-sourced marketplace, or one this build cannot resolve at
	 * all, can never carry the pinned tag — reads as supply behind pin
	 * (#238 user story 49) rather than a silent pass. */
	const supplyBehindPin =
		pin && !installAtPin
			? marketplaceInfo.sourceType !== "git" || !sameRelease(supplyRef, pin.ref)
			: false;

	/* Judged against the pin, never the supply's own tag: the supply either
	 * sits on the pin already or is rotated onto it first, so an install
	 * off the pin owes `install` and `update` either way (#747). */
	const installBehindSupply = !!(pin && runningPlugin && !installAtPin);

	/* Materialised but not yet live: the records on disk now agree with the
	 * pin, but this process loaded the previous bytes and will keep them
	 * until it ends (#243). Not a gap — nothing is owed but a restart. */
	const materialisedNotLive = !!(
		pin &&
		!supplyBehindPin &&
		!installBehindSupply &&
		loadedVersion &&
		runningPlugin &&
		!sameRelease(loadedVersion, runningPlugin.version)
	);

	/* Contention: the supply sits on a real, resolved TAG that is not this
	 * adopter's own pin — some other adopter's, about to move, and only while
	 * this adopter still needs the supply rotated to its pin. A clone left
	 * on a branch is this repo's own broken state, not a neighbour's pin
	 * (#251 item 5). */
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
 * Where the CLI installs `pluginName` from `marketplace` at `version` — the
 * `installPath` its install row records, known before the install lands it
 * (#736).
 * @param {string|undefined} configDir
 * @param {string} marketplace
 * @param {string} pluginName
 * @param {string} version `1.2.3` or `v1.2.3`
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

/* `findInstallRecord` and `resolveConfigDir` are exported for
 * `scripts/reconcile-plugin.js` (#247, the SessionEnd materialiser), which
 * needs the two reads separately rather than as one state record (§N7). */
module.exports = {
	readPluginState,
	/* scripts/pick-retro-sessions.js reads repo settings with it. */
	readJsonSafe,
	isCoreHost,
	findPin,
	resolveMarketplace,
	findInstallRecord,
	resolveConfigDir,
	isTagRef,
	sameRelease,
	installPathFor,
};
