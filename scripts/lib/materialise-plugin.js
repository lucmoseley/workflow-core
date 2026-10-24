/*
 * materialise-plugin.js — the `claude plugin marketplace add` → `plugin
 * install` → `plugin update` sequence that turns a url-sourced pin into an
 * actual installed plugin, shared between init-adopter.js's bootstrap step
 * (#75) and upgrade.js's re-materialise-on-upgrade step (#91, #103) (#102).
 *
 * Non-fatal by design: a failure is reported through the caller's own `out`,
 * never thrown, so a session with no `claude` on PATH, or a source it can't
 * reach, is one hand-run command short of loading rather than broken.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { cutAt } = require("./cut-at.js");
const { resolveConfigDir } = require("./plugin-state.js");
const { caught } = require("./caught.js");

/* A slow or black-holed `claude plugin` fetch has no ceiling of its own
 * (#135) — this bounds all three of materialisePlugin's calls alike. A first
 * guess, and stated as one: room for a real git clone over a slow link,
 * nothing measured against. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * A child process against the ADOPTER's tree, not this one's.
 *
 * CLAUDE_PROJECT_DIR IS OVERRIDDEN, not inherited. lib/host-root.js returns it
 * unconditionally, so a child inheriting this session's value would read and
 * WRITE the core's own tree — `check-guard-registry.js --review` refuses
 * `--root` and would re-anchor the core's registry while reporting the
 * adopter's hooks as anchored (#5).
 *
 * CLAUDE_CONFIG_DIR IS SET EXPLICITLY TOO (#117), never left to an implicit
 * `...process.env` spread. With no `configDir`, `resolveConfigDir()`
 * (`plugin-state.js`) returns exactly what the child would have inherited
 * before (#117).
 * The isolation #117 actually wants is a caller passing `configDir`
 * explicitly — a release smoke test pointed at a throwaway directory, never
 * the default.
 * @param {string} root
 * @param {[string, ...string[]]} args the binary, then its arguments
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
 * A cross-scope ref conflict the CLI is about to refuse, caught before
 * spending three calls on it (#258). A `--scope project add` is refused only
 * where the SAME name is already declared at USER scope
 * (`<configDir>/settings.json`'s own `extraKnownMarketplaces`, no `--scope`
 * flag) with a ref that differs from the one being added — no ref at all
 * counts as its own distinct value here, so declaring one where user scope
 * has none conflicts exactly as two different refs would. A same-scope ref
 * rotation (project → project, any ref to any other ref, ref to no-ref or
 * back) succeeds every time; so does a `--scope project` add under a name a
 * DIFFERENT project last touched, however stale
 * `plugins/known_marketplaces.json`'s cache of that looks. So this reads
 * user scope's settings file alone, never the cache.
 * Non-fatal to read: a missing or unparseable user-scope file, or a name it
 * doesn't declare, means no predicted conflict.
 * Only meaningful for a url-shaped `addSource` (`<url>#<ref>`, the syntax
 * `init-adopter.js` and `reconcile-plugin.js` both build); a directory
 * source carries no ref and never matches the `#` probe below.
 * A user-scope declaration of a LOCAL kind (`directory`, `file`) is refused
 * too, on the same settings file alone (#342), but no ref
 * edit repairs it, so it comes back as `existingKind` rather than as a ref
 * conflict.
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
	/* A `ref` key present but not a string is malformed data this function
	 * cannot interpret, never the genuine "tracks the default branch" state a
	 * missing key means. */
	if ("ref" in entry && typeof entry.ref !== "string") return null;
	const existingRef = typeof entry.ref === "string" ? entry.ref : null;
	return existingRef === wantedRef ? null : { existingRef, wantedRef };
}

/**
 * The core explanation shared by `materialisePlugin`'s own refusal message
 * and the SessionStart reporter's read-only prediction of the same conflict
 * (#318), repair included — each caller appends only its own close
 * (`materialisePlugin`'s "THEN run" the commands it already built, the
 * reporter's pointer to the commands above them).
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
 * Runs `claude plugin marketplace add <addSource> --scope project`, then
 * `claude plugin install <pluginId> -y --scope project`, then `claude plugin
 * update <pluginId> --scope project -y` against `root`.
 *
 * The `install` call alone is not enough to reach a rotated ref (#103):
 * `install` on a plugin already installed under `pluginId` no-ops — it
 * reports success without re-fetching, leaving the previously-installed
 * files (and their `plugin.json` version) exactly as they were, regardless
 * of what `marketplace add` just rotated the source ref to.
 * `update` is the one command that re-pulls an already-installed plugin — it
 * detects a change via `plugin.json`'s `version` field, not the git ref, so
 * a tag that ships with an unbumped `version` still leaves it a no-op. It is
 * run unconditionally, after `install`, rather than only when already
 * installed, because that avoids a second `claude` call (e.g. `plugin list`)
 * just to branch on install state — `update` on a plugin `install` just
 * placed is expected to be a harmless no-op there too.
 *
 * `update` runs in a try of its own, after `marketplace add`/`install`
 * succeed: `install`'s no-op-on-already-installed is confirmed, but
 * `update`'s exit status on a plugin with nothing to update — the case an
 * `install` just landed — is not (#103). Folding it into
 * the same try would let an unverified nonzero there turn a plugin that DID
 * materialise correctly into a reported failure. So a failed `update` comes
 * back as `updateFailed` on an otherwise-`ok: true` result, never as
 * `ok: false` — `marketplace add`/`install` are what `ok` tracks.
 *
 * Returns the argv of all three calls either way, so a caller building a
 * fix-by-hand message on failure renders it from the argv that actually ran
 * rather than reassembling it from `addSource`/`pluginId` by hand, though
 * `fixByHand`'s plain `join(" ")` is not shell-quoted.
 * `configDir` forwards to all three `run()` calls, isolating them from
 * whatever CLAUDE_CONFIG_DIR the caller's own session carries (#117) —
 * `upgrade.js` and `release-plugin.js`'s dry-run-adopter path both thread it
 * through; left unset, `run()`'s own default applies. `timeoutMs` likewise
 * forwards to all three, left unset, `run()`'s own `DEFAULT_TIMEOUT_MS`
 * default applies (#135).
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
 * The three commands `materialisePlugin` ran, joined for a fix-by-hand message.
 * @param {{marketplaceAdd: string[], pluginInstall: string[], pluginUpdate: string[]}} result
 */
function fixByHand(result) {
	return `${result.marketplaceAdd.join(" ")} && ${result.pluginInstall.join(" ")} && ${result.pluginUpdate.join(" ")}`;
}

/* `predictedRefConflict` is exported for `check-plugin-gap.js` (#318, the
 * SessionStart reporter's own read of the same conflict) and for this file's
 * own unit tests; `materialisePlugin` is the only real caller that acts on
 * it. `refConflictExplanation` is exported for the same reporter, so the two
 * messages share their core clause rather than drifting apart (#318). */
module.exports = {
	run,
	installFailure,
	materialisePlugin,
	fixByHand,
	predictedRefConflict,
	refConflictExplanation,
};
