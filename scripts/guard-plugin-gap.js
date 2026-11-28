#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { deref } = require("./lib/deref.js");
const { readPluginState, resolveConfigDir } = require("./lib/plugin-state.js");
const { readRuleText } = require("./lib/rule-text.js");
const { walkCommand } = require("./lib/walk-command.js");
const { ignoreFailure, orFallback } = require("./lib/caught.js");
const { run } = require("./lib/guard-entry.js");
const { isDeclined, readPendingConsent } = require("./lib/adopter-consent.js");
const { readStepsOwed } = require("./lib/steps-owed.js");
const { HOOKS, hookRootOf, NO_CORE_FIX } = require("./lib/adopter-skeleton.js");
const { isHookShim } = require("./lib/hook-shim.js");
const { shellQuote } = require("./lib/sh-quote.js");
const {
	predictedRefConflict,
	refConflictExplanation,
} = require("./lib/materialise-plugin.js");

/**
 * @param {ReturnType<typeof readPluginState>} state
 * @param {string} marketplace
 * @param {string} pluginName
 * @returns {string[]}
 */
function commandsFor(state, marketplace, pluginName) {
	/** @type {string[]} */
	const out = [];
	if (state.gaps.supplyBehindPin)
		out.push(
			`claude plugin marketplace add ${state.pin?.url ?? "<url>"}#${state.pin?.ref} --scope project`,
		);
	if (state.gaps.installBehindSupply) {
		out.push(
			`claude plugin install ${pluginName}@${marketplace} -y --scope project`,
		);
		out.push(
			`claude plugin update ${pluginName}@${marketplace} --scope project -y`,
		);
	}
	return out;
}

/**
 * @param {string} root
 * @param {string} pluginRoot
 * @returns {string|null}
 */
function buildOwedBlock(root, pluginRoot) {
	let owed;
	try {
		owed = readStepsOwed(root).filter((e) => !e.declined);
	} catch {
		return null;
	}
	if (owed.length === 0) return null;
	const cli = shellQuote(`${pluginRoot}/scripts/steps-owed.js`);
	const lines = [
		`${owed.length} step${owed.length === 1 ? "" : "s"} owed from a prior walk, carried forward from its migration note:`,
	];
	for (const e of owed) {
		lines.push(`  [${e.type}] (${e.tag}) ${e.text}`);
		if (e.type === "choice")
			lines.push(
				`    node ${cli} decline ${shellQuote(e.tag)} ${shellQuote(e.text)}`,
			);
		lines.push(
			`    node ${cli} clear ${shellQuote(e.tag)} ${e.type} ${shellQuote(e.text)}`,
		);
	}
	return lines.join("\n");
}

/** @param {string} root @returns {string} */
function readVersionAt(root) {
	const version = orFallback(
		() =>
			JSON.parse(
				fs.readFileSync(path.join(root, ".claude-plugin/plugin.json"), "utf8"),
			).version,
		undefined,
	);
	return typeof version === "string" ? version : path.basename(root);
}

/**
 * @param {string} root
 * @returns {{hook: string, text: string}[]}
 */
function installedHooks(root) {
	return HOOKS.flatMap((hook) => {
		try {
			return [
				{
					hook,
					text: fs.readFileSync(path.join(root, ".husky", hook), "utf8"),
				},
			];
		} catch {
			return [];
		}
	});
}

/**
 * @param {string} root
 * @param {string|null} running
 */
function hookRootsOffRunning(root, running) {
	const runningReal = running === null ? null : deref(running);
	/** @type {Map<string, string[]>} */
	const missing = new Map();
	/** @type {Map<string, string[]>} */
	const skewed = new Map();
	for (const { hook, text } of installedHooks(root)) {
		const raw = hookRootOf(text);
		if (raw === null) continue;
		const named = path.resolve(root, raw);
		if (deref(named) === runningReal) continue;
		const bucket = fs.existsSync(named) ? skewed : missing;
		if (bucket === skewed && running === null) continue;
		bucket.set(named, [...(bucket.get(named) ?? []), `.husky/${hook}`]);
	}
	return { missing, skewed };
}

/**
 * @param {string} root
 * @param {string|undefined} runningRoot
 * @returns {string|null}
 */
function buildHookRootBlock(root, runningRoot) {
	const running = runningRoot ? path.resolve(runningRoot) : null;
	const { missing, skewed } = hookRootsOffRunning(root, running);
	if (missing.size === 0 && skewed.size === 0) return null;
	const lines = [];
	for (const [named, hooks] of missing)
		lines.push(
			`FAIL: ${hooks.join(", ")} run from ${named}, which no longer exists — ` +
				"each aborts on its first script there, so this repo cannot commit.",
		);
	if (running)
		for (const [named, hooks] of skewed)
			lines.push(
				`WARN: ${hooks.join(", ")} run workflow-core ${readVersionAt(named)} (${named}), ` +
					`this session runs ${readVersionAt(running)} (${running}) — ` +
					"commits are judged by a different core than this session's guards.",
			);
	const upgrade = running
		? `node ${shellQuote(`${running}/scripts/upgrade.js`)} --root ${shellQuote(root)} --plugin-root ${shellQuote(running)}`
		: `node <installed plugin root>/scripts/upgrade.js --root ${shellQuote(root)} --plugin-root <installed plugin root>`;
	lines.push(
		"Turn them into shims with upgrade.js, which rewrites every core hook on any run, up to date or not:",
		`  ${upgrade}`,
	);
	return lines.join("\n");
}

/**
 * @param {string} root
 * @returns {string|null}
 */
function buildShimBlock(root) {
	const shims = installedHooks(root)
		.filter(({ text }) => isHookShim(text))
		.map(({ hook }) => hook);
	if (shims.length === 0) return null;
	const r = spawnSync(
		process.execPath,
		[
			"-e",
			`try {
  require(${JSON.stringify(require.resolve("./lib/resolve-core.js"))}).resolveCore({ warn: () => undefined });
} catch (err) {
  process.stderr.write(err instanceof Error ? err.message : String(err));
  process.exit(1);
}`,
		],
		{ cwd: root, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
	);
	if (r.status === 0) return null;
	return [
		`FAIL: ${shims.map((hook) => `.husky/${hook}`).join(", ")} find no workflow-core to run, so this repo's commits are refused and its other hook checks do not run:`,
		`  ${r.stderr.trim()}`,
		NO_CORE_FIX,
	].join("\n");
}

/**
 * @param {string} pluginRoot
 */
function readManifest(pluginRoot) {
	try {
		return JSON.parse(
			fs.readFileSync(`${pluginRoot}/.claude-plugin/plugin.json`, "utf8"),
		);
	} catch {
		return null;
	}
}

/**
 * @param {any} state
 * @param {string} name
 * @returns {string|null}
 */
function buildMaterialisedNotLiveLine(state, name) {
	if (!state.materialisedNotLive) return null;
	return (
		`${name}: materialised but not yet live — ${state.runningPlugin?.version} is installed, this session is running ${state.loadedVersion}. ` +
		"Nothing to do: this session keeps the plugin it started with, and the next one will be current."
	);
}

/**
 * @param {string} root
 * @param {any} state
 * @param {string} name
 * @returns {string|null}
 */
function buildWalkOwedLine(root, state, name) {
	const tag = state.pin.ref;
	if (isDeclined(root, tag) || !readPendingConsent(root, tag)) return null;
	return (
		`${name}: installed at ${tag}, but its migration walk has not landed. ` +
		"Walk it in this session, from the repo root, and commit what it writes; the session-end reconciler then finds it done:\n" +
		`  ${walkCommand()}`
	);
}

/**
 * @param {any} state
 * @returns {string[]}
 */
function buildRefConflictLines(state) {
	if (!state.gaps.supplyBehindPin || typeof state.pin.url !== "string")
		return [];
	const conflict = predictedRefConflict(
		resolveConfigDir(),
		state.pin.marketplace,
		`${state.pin.url}#${state.pin.ref}`,
	);
	if (!conflict) return [];
	return [
		"",
		"This rotation is predicted to be refused: " +
			`${refConflictExplanation(state.pin.marketplace, conflict)} — then run ` +
			"the commands above.",
	];
}

/**
 * @param {boolean} supplyBehindPin
 * @returns {string[]}
 */
function buildRuleLines(supplyBehindPin) {
	/** @type {string[]} */
	const lines = [];
	ignoreFailure(() =>
		lines.push("", readRuleText("adopter-materialise-sequence")),
	);
	if (supplyBehindPin) {
		ignoreFailure(() => lines.push("", readRuleText("adopter-pin-consent")));
	}
	return lines;
}

/**
 * @param {{root: string, pluginRoot: string, runningRoot?: string}} at
 * @returns {string|null}
 */
function buildReport({ root, pluginRoot, runningRoot }) {
	const standing =
		[
			buildShimBlock(root),
			buildHookRootBlock(root, runningRoot),
			buildOwedBlock(root, pluginRoot),
		]
			.filter(Boolean)
			.join("\n\n") || null;
	/** @param {string|null} text @returns {string|null} */
	const join = (text) => {
		if (!standing) return text;
		return text ? `${text}\n\n${standing}` : standing;
	};

	const plugin = readManifest(pluginRoot);
	if (!plugin?.name) return join(null);

	const state = readPluginState({ root, pluginRoot });
	if (!state.pin) return join(null);
	if (!state.gaps.supplyBehindPin && !state.gaps.installBehindSupply)
		return join(
			buildWalkOwedLine(root, state, plugin.name) ??
				buildMaterialisedNotLiveLine(state, plugin.name),
		);
	if (isDeclined(root, state.pin.ref)) return join(null);

	const lines = [];
	const gaps = [];
	if (state.gaps.supplyBehindPin) gaps.push("supply behind pin");
	if (state.gaps.installBehindSupply) gaps.push("install behind supply");
	lines.push(
		`${plugin.name}: ${gaps.join(", ")} — pin is ${state.pin.ref}, ` +
			`supply is on ${state.supply.ref ?? "unresolved"}, ` +
			`running ${state.runningPlugin?.version ?? "unknown"}.`,
	);
	for (const cmd of commandsFor(state, state.pin.marketplace, plugin.name))
		lines.push(`  ${cmd}`);
	lines.push(...buildRefConflictLines(state));
	if (state.contention)
		lines.push(
			`The supply currently sits on ${state.contention}, not this repo's pin — rotating it moves that ref too.`,
		);
	lines.push(...buildRuleLines(state.gaps.supplyBehindPin));
	const consentCli = `${pluginRoot}/scripts/adopter-consent.js`;
	lines.push(
		"",
		"The `claude plugin` commands under the gap line above are this session's to run, not the founder's (#5230): run each bare, one per call, as printed, since the user-settings allow rules for them match only these spellings. Then record the tag accepted, so the session-end reconciler walks its migration notes:",
		`  node ${shellQuote(consentCli)} accept  ${shellQuote(root)} ${shellQuote(state.pin.ref)}`,
		"Only where the founder has said not to install this tag here, record that instead:",
		`  node ${shellQuote(consentCli)} decline ${shellQuote(root)} ${shellQuote(state.pin.ref)}`,
		"The walk need not wait for the session's exit: once the install commands have run, this walks the migration notes in this session, from the repo root; commit what it writes, and the exit's reconciler finds it done:",
		`  ${walkCommand()}`,
	);
	return join(lines.join("\n"));
}

/**
 * @typedef {{ root: string, runningRoot: string|undefined }} Ports
 */

/**
 * @param {string} _source
 * @param {Ports} io
 * @returns {import("./lib/guard-entry.js").Decision}
 */
function decide(_source, { root, runningRoot }) {
	const text = buildReport({
		root,
		pluginRoot: runningRoot ?? root,
		runningRoot,
	});
	return text ? { context: text } : null;
}

if (require.main === module)
	run({
		field: "source",
		top: true,
		event: "SessionStart",
		noun: "a session's start",
		decide,
		ports: ({ root }) => ({
			root,
			runningRoot: process.env.CLAUDE_PLUGIN_ROOT,
		}),
	});
