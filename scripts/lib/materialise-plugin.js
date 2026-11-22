const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { cutAt } = require("./cut-at.js");
const { resolveConfigDir } = require("./plugin-state.js");
const { caught } = require("./caught.js");

// guess, #135
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * @param {string} root
 * @param {[string, ...string[]]} args
 * @param {{quiet?: boolean, configDir?: string, timeoutMs?: number}} [opts]
 */
function run(root, args, { quiet = false, configDir, timeoutMs } = {}) {
	const [file, ...rest] = args;
	return execFileSync(file, rest, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", quiet ? "ignore" : "pipe"],
		timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: root,
			CLAUDE_CONFIG_DIR: resolveConfigDir(configDir),
		},
	});
}

/** @param {unknown} err */
function installFailure(err) {
	const e = caught(err);
	return cutAt(e.stderr?.trim() || e.message, "\n")[0];
}

/**
 * @param {string} configDir
 * @param {string} marketplaceName
 * @param {string} addSource
 * @returns {{existingRef: string|null, wantedRef: string}
 *   | {existingKind: "directory"|"file", wantedRef: string, settingsPath: string} | null}
 */
function predictedRefConflict(configDir, marketplaceName, addSource) {
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(addSource)) return null;
	const hashAt = addSource.indexOf("#");
	if (hashAt < 0) return null;
	const wantedRef = addSource.slice(hashAt + 1);
	if (!wantedRef) return null;
	const settingsPath = path.join(configDir, "settings.json");
	/** @type {unknown} */
	let userSettings;
	try {
		userSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	} catch {
		return null;
	}
	const entry =
		/** @type {Record<string, {source?: {source?: unknown, ref?: unknown}}>} */ (
			/** @type {{extraKnownMarketplaces?: unknown}} */ (userSettings)
				?.extraKnownMarketplaces
		)?.[marketplaceName]?.source;
	if (!entry || typeof entry !== "object") return null;
	if (entry.source === "directory" || entry.source === "file")
		return { existingKind: entry.source, wantedRef, settingsPath };
	if ("ref" in entry && typeof entry.ref !== "string") return null;
	const existingRef = typeof entry.ref === "string" ? entry.ref : null;
	return existingRef === wantedRef ? null : { existingRef, wantedRef };
}

/**
 * @param {string} marketplaceName
 * @param {NonNullable<ReturnType<typeof predictedRefConflict>>} conflict
 */
function refConflictExplanation(marketplaceName, conflict) {
	if ("existingKind" in conflict)
		return (
			`this config dir's USER-scope settings already declare "${marketplaceName}" ` +
			`as a ${conflict.existingKind} source, and the CLI refuses a --scope project ` +
			`add of a git source at ${conflict.wantedRef} under the same name (#342) — ` +
			"no add can replace a source of another kind, so remove it first: " +
			`\`claude plugin marketplace remove ${marketplaceName}\`, or, where ` +
			`that reports not found, delete extraKnownMarketplaces["${marketplaceName}"] ` +
			`from ${conflict.settingsPath} by hand`
		);
	return (
		`this config dir's USER-scope settings already declare "${marketplaceName}" ` +
		`at ref ${conflict.existingRef ?? "(none — tracks the default branch)"}, ` +
		`and the CLI refuses a --scope project add rotating it to ${conflict.wantedRef} ` +
		"under the same name (#258) — reconcile the two declarations by hand first: " +
		"edit user scope's ref to match, or re-bootstrap under an isolated --config-dir"
	);
}

/**
 * #103, #117, #135
 * @param {{root: string, claudeBin: string, addSource: string, pluginId: string, configDir?: string, timeoutMs?: number}} at
 * @returns {{ok: true, marketplaceAdd: string[], pluginInstall: string[], pluginUpdate: string[], updateFailed?: string}
 *   | {ok: false, marketplaceAdd: string[], pluginInstall: string[], pluginUpdate: string[], reason: string}}
 */
function materialisePlugin({
	root,
	claudeBin,
	addSource,
	pluginId,
	configDir,
	timeoutMs,
}) {
	/** @type {[string, ...string[]]} */
	const marketplaceAdd = [
		claudeBin,
		"plugin",
		"marketplace",
		"add",
		addSource,
		"--scope",
		"project",
	];
	/** @type {[string, ...string[]]} */
	const pluginInstall = [
		claudeBin,
		"plugin",
		"install",
		pluginId,
		"-y",
		"--scope",
		"project",
	];
	/** @type {[string, ...string[]]} */
	const pluginUpdate = [
		claudeBin,
		"plugin",
		"update",
		pluginId,
		"--scope",
		"project",
		"-y",
	];
	const marketplaceName = pluginId.slice(pluginId.lastIndexOf("@") + 1);
	if (marketplaceName) {
		const conflict = predictedRefConflict(
			resolveConfigDir(configDir),
			marketplaceName,
			addSource,
		);
		if (conflict) {
			return {
				ok: false,
				marketplaceAdd,
				pluginInstall,
				pluginUpdate,
				reason:
					`${refConflictExplanation(marketplaceName, conflict)}. The three commands ` +
					"below refuse identically until then; THEN run",
			};
		}
	}
	try {
		run(root, marketplaceAdd, { configDir, timeoutMs });
		run(root, pluginInstall, { configDir, timeoutMs });
	} catch (err) {
		return {
			ok: false,
			marketplaceAdd,
			pluginInstall,
			pluginUpdate,
			reason: installFailure(err),
		};
	}
	try {
		run(root, pluginUpdate, { configDir, timeoutMs });
		return { ok: true, marketplaceAdd, pluginInstall, pluginUpdate };
	} catch (err) {
		return {
			ok: true,
			marketplaceAdd,
			pluginInstall,
			pluginUpdate,
			updateFailed: installFailure(err),
		};
	}
}

/**
 * @param {{marketplaceAdd: string[], pluginInstall: string[], pluginUpdate: string[]}} result
 */
function fixByHand(result) {
	return `${result.marketplaceAdd.join(" ")} && ${result.pluginInstall.join(" ")} && ${result.pluginUpdate.join(" ")}`;
}

module.exports = {
	run,
	installFailure,
	materialisePlugin,
	fixByHand,
	predictedRefConflict,
	refConflictExplanation,
};
