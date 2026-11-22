const fs = require("node:fs");
const path = require("node:path");
const { requiredGroup } = require("./regex-group.js");
const { runVerify } = require("./verify-run.js");
const { CONFIG_PATH, MIGRATIONS_DIR } = require("./workflow-core-config.js");
const { bringCoreFiles, readIfPresent } = require("./core-owned-files.js");
const { parseNote, parseSteps } = require("./migration-note.js");
const { skillDrift } = require("./skill-drift.js");
const { findPin } = require("./plugin-state.js");
const { readInstalledRecord } = require("./plugin-record.js");
const { appendStepsOwed } = require("./steps-owed.js");
const { formatConfigJson } = require("./config-json.js");
const { caught, ignoreFailure } = require("./caught.js");
const { compareVersions } = require("./compare-versions.js");
const { noop } = require("./noop.js");

/** @param {string} v @returns {[number, number, number]} */
function semver(v) {
	const [maj = 0, min = 0, pat = 0] = v
		.replace(/^v/, "")
		.split(".")
		.map((n) => Number.parseInt(n, 10));
	return [maj, min, pat];
}

/** @param {string} a @param {string} b */
const semverCompare = (a, b) => compareVersions(semver(a), semver(b));

/**
 * @param {string} root
 * @param {string} rel
 * @param {Record<string, unknown>} [fallback]
 * @returns {{path: string, json: Record<string, unknown>}}
 */
function readJson(root, rel, fallback = {}) {
	const at = path.join(root, rel);
	try {
		return { path: at, json: JSON.parse(fs.readFileSync(at, "utf8")) };
	} catch (err) {
		if (caught(err).code === "ENOENT") return { path: at, json: fallback };
		throw new Error(`${at} does not parse: ${caught(err).message}`, {
			cause: err,
		});
	}
}

/**
 * @param {string} pluginRoot
 * @returns {{tag: string, file: string, text: string}[]}
 */
function loadNotes(pluginRoot) {
	const dir = path.join(pluginRoot, MIGRATIONS_DIR);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => /^v\d+\.\d+\.\d+\.md$/.test(f))
		.map((f) => ({
			tag: f.replace(/\.md$/, ""),
			file: path.join(dir, f),
			text: fs.readFileSync(path.join(dir, f), "utf8"),
		}))
		.sort((a, b) => semverCompare(a.tag, b.tag));
}

/**
 * @param {{tag: string, text: string}} note
 * @param {{root: string, out: (line: string) => void,
 *   env?: NodeJS.ProcessEnv, verifyTimeoutMs?: number}} at
 */
function verifyPasses(note, { root, out, env, verifyTimeoutMs }) {
	const parsed = parseNote(note.text);
	if (!parsed.verify) {
		out(`cannot probe ${note.tag} (no readable Verify) — leaving it skipped`);
		return true;
	}
	const result = runVerify(parsed.verify, {
		cwd: root,
		env,
		timeout: verifyTimeoutMs,
	});
	if (result.ok || result.status !== null) return result.ok;
	out(
		`cannot probe ${note.tag} (its Verify would not run: ${result.message}) — leaving it skipped`,
	);
	return true;
}

/**
 * @param {{contract?: number, settingsKeys?: boolean, hookPaths?: boolean,
 *   labels?: boolean, ignoreBlock?: string[], roadmapMajorPin?: boolean}} residue
 * @param {{root: string, out: (line: string) => void}} at
 */
function applyResidue(residue, { root, out }) {
	if ("contract" in residue)
		applyContractResidue(residue.contract, { root, out });
	for (const key of EVERY_RUN) {
		if (residue[key]) out(`residue  ${key}: already brought current this run`);
	}
	if (residue.roadmapMajorPin) applyRoadmapMajorPinResidue({ root, out });
}

const EVERY_RUN = /** @type {const} */ ([
	"settingsKeys",
	"hookPaths",
	"labels",
	"ignoreBlock",
]);

/**
 * @param {number|undefined} contract
 * @param {{root: string, out: (line: string) => void}} at
 */
function applyContractResidue(contract, { root, out }) {
	const { path: at, json } = readJson(root, CONFIG_PATH);
	if (json.contract === contract) return;
	fs.writeFileSync(at, formatConfigJson({ ...json, contract }));
	out(`residue  contract -> ${contract}`);
}

/** @param {{root: string, out: (line: string) => void}} at */
function applyRoadmapMajorPinResidue({ root, out }) {
	const { path: at, json: config } = readJson(root, CONFIG_PATH);
	const owed =
		!("roadmapMajorPin" in config) &&
		Array.isArray(config.modules) &&
		config.modules.includes("roadmap");
	if (!owed) return;
	const htmlPath = path.join(root, "docs/reference-roadmap.html");
	const html = readIfPresent(htmlPath);
	const docmeta = /class="docmeta">v(\d+)\.(\d+)\s*·\s*updated ([^<]+)</;
	const m = html?.match(docmeta);
	if (!m) {
		out(
			`residue  roadmapMajorPin: ${htmlPath} is missing or carries no docmeta version line — leave unset, hand-add it (that file's own "v<major>.<minor> · updated" line names the major)`,
		);
		return;
	}
	const major = Number.parseInt(requiredGroup(m, 1, docmeta), 10);
	fs.writeFileSync(at, formatConfigJson({ ...config, roadmapMajorPin: major }));
	out(`residue  roadmapMajorPin backfilled from ${htmlPath} -> ${major}`);
}

/**
 * @param {{root: string, pluginRoot: string, dryRun?: boolean,
 *   out?: (line: string) => void, ceiling?: string|null,
 *   env?: NodeJS.ProcessEnv, verifyTimeoutMs?: number,
 *   measureCore?: import("./core-context-cost.js").Measurer,
 *   labels?: import("./core-owned-files.js").Labels}} at
 * @returns {{status: 0|1|2|3, reason?: string}}
 */
function upgrade({
	root,
	pluginRoot,
	dryRun = false,
	out = noop,
	ceiling,
	env,
	verifyTimeoutMs,
	measureCore,
	labels,
}) {
	const read = readPluginManifest(pluginRoot);
	if (read.failure) return read.failure;
	const plugin = read.plugin;
	const installed = `v${plugin.version}`;

	reportForkDrift({ root, pluginRoot, out });

	const { json: settings } = readJson(root, ".claude/settings.json");
	const {
		marketplace,
		ref: pinned,
		source: pinnedSource,
	} = findPin(
		/** @type {import("./plugin-state.js").AdopterSettings} */ (settings),
		plugin.name,
	);

	refreshAdopterFiles({
		root,
		pluginRoot,
		dryRun,
		out,
		plugin,
		marketplace,
		pinnedSource,
		measureCore,
		labels,
	});

	if (pinned && semverCompare(pinned, installed) > 0) {
		return {
			status: 3,
			reason:
				`pin ${pinned} is ahead of the installed plugin ${installed} — ` +
				`install owes: re-materialise to ${pinned} (full recipe: ` +
				"scripts/lib/rule-text.sh adopter-materialise-sequence)",
		};
	}

	const { notes, probedTags, walkCeiling } = planWalk({
		root,
		pluginRoot,
		out,
		ceiling,
		env,
		verifyTimeoutMs,
		installed,
		pinned,
		pinnedSource,
	});

	if (notes.length === 0)
		return finishWithoutNotes(walkCeiling, { root, dryRun, out });

	for (const note of notes) {
		const failure = walkNote(note, {
			optional: probedTags.has(note.tag),
			root,
			dryRun,
			out,
			env,
			verifyTimeoutMs,
		});
		if (failure) return failure;
	}

	const reached = /** @type {string} */ (walkCeiling);
	if (!dryRun) advanceWalkedTo(root, reached);
	out(dryRun ? `would reach ${reached}` : `upgraded to ${reached}`);
	return { status: 0 };
}

/**
 * @param {string} pluginRoot
 * @returns {{plugin: {name: string, version: string}, failure: null} |
 *   {plugin: null, failure: {status: 2, reason: string}}}
 */
function readPluginManifest(pluginRoot) {
	try {
		return {
			plugin: JSON.parse(
				fs.readFileSync(
					path.join(pluginRoot, ".claude-plugin/plugin.json"),
					"utf8",
				),
			),
			failure: null,
		};
	} catch (err) {
		return {
			plugin: null,
			failure: {
				status: 2,
				reason: `${pluginRoot}/.claude-plugin/plugin.json: ${caught(err).message}`,
			},
		};
	}
}

/**
 * @param {{root: string, pluginRoot: string, out: (line: string) => void}} at
 */
function reportForkDrift({ root, pluginRoot, out }) {
	ignoreFailure(() => {
		for (const drift of skillDrift({ root, pluginRoot })) {
			const { name, recordedFrom, drifted, reason } = drift;
			if ("unreadable" in drift)
				out(`"${name}" is forked, but its drift goes unchecked: ${reason}`);
			if (reason) continue;
			if (drifted)
				out(
					`"${name}" is forked (recorded from ${recordedFrom}) and has drifted from the plugin's current copy — review the fork against .claude/skills/${name}/SKILL.md`,
				);
		}
	});
}

/**
 * @param {{root: string, pluginRoot: string, dryRun: boolean,
 *   out: (line: string) => void, plugin: {name: string, version: string},
 *   marketplace: string|null,
 *   pinnedSource: import("./plugin-state.js").MarketplaceSource|null,
 *   measureCore?: import("./core-context-cost.js").Measurer,
 *   labels?: import("./core-owned-files.js").Labels}} at
 */
function refreshAdopterFiles({
	root,
	pluginRoot,
	dryRun,
	out,
	plugin,
	marketplace,
	pinnedSource,
	measureCore,
	labels,
}) {
	bringCoreFiles({
		root,
		pluginRoot,
		dryRun,
		out,
		record: readInstalledRecord({
			root,
			plugin,
			marketplace,
			source: pinnedSource,
		}),
		pin:
			marketplace && pinnedSource
				? { marketplace, source: pinnedSource, plugin: plugin.name }
				: null,
		measureCore,
		labels,
	});
}

/**
 * @param {{root: string, pluginRoot: string, out: (line: string) => void,
 *   ceiling?: string|null, env?: NodeJS.ProcessEnv, verifyTimeoutMs?: number,
 *   installed: string, pinned: string|null,
 *   pinnedSource: import("./plugin-state.js").MarketplaceSource|null}} at
 * @returns {{notes: {tag: string, file: string, text: string}[],
 *   probedTags: Set<string>, walkCeiling: string|null}}
 */
function planWalk({
	root,
	pluginRoot,
	out,
	ceiling,
	env,
	verifyTimeoutMs,
	installed,
	pinned,
	pinnedSource,
}) {
	const isDirectorySourced = pinnedSource?.source === "directory";

	const walkedTo = readWalkedTo(root);
	const firstSeenFloor = isDirectorySourced ? installed : pinned;
	const lowerBound = /** @type {string} */ (walkedTo ?? firstSeenFloor);

	const bounded = ceiling !== undefined;
	const walkCeiling = ceiling === undefined ? installed : ceiling;

	const inRange =
		walkCeiling !== null && (pinned || isDirectorySourced)
			? loadNotes(pluginRoot).filter(
					(n) =>
						semverCompare(n.tag, lowerBound) > 0 &&
						semverCompare(n.tag, walkCeiling) <= 0,
				)
			: [];

	const probed = probeNotes({
		root,
		pluginRoot,
		out,
		env,
		verifyTimeoutMs,
		walkedTo,
		pinned,
		isDirectorySourced,
		lowerBound,
		walkCeiling,
	});

	const probedTags = new Set(probed.map((n) => n.tag));
	const notes = [...probed, ...inRange].sort((a, b) =>
		semverCompare(a.tag, b.tag),
	);

	if (!bounded && isDirectorySourced && walkedTo === null)
		reportDirectoryFloor(pluginRoot, installed, out);

	return { notes, probedTags, walkCeiling };
}

/** @param {string} root @returns {string|null} */
function readWalkedTo(root) {
	const { json: wfConfig } = readJson(root, CONFIG_PATH);
	return typeof (/** @type {any} */ (wfConfig).walkedTo) === "string"
		? /** @type {any} */ (wfConfig).walkedTo
		: null;
}

/**
 * @param {{root: string, pluginRoot: string, out: (line: string) => void,
 *   env?: NodeJS.ProcessEnv, verifyTimeoutMs?: number,
 *   walkedTo: string|null, pinned: string|null,
 *   isDirectorySourced: boolean, lowerBound: string,
 *   walkCeiling: string|null}} at
 * @returns {{tag: string, file: string, text: string}[]}
 */
function probeNotes({
	root,
	pluginRoot,
	out,
	env,
	verifyTimeoutMs,
	walkedTo,
	pinned,
	isDirectorySourced,
	lowerBound,
	walkCeiling,
}) {
	const pinIsTag =
		typeof pinned === "string" && /^v?\d+\.\d+\.\d+$/.test(pinned);

	const probed =
		walkedTo === null && pinIsTag && !isDirectorySourced && walkCeiling !== null
			? loadNotes(pluginRoot).filter(
					(n) =>
						semverCompare(n.tag, lowerBound) <= 0 &&
						semverCompare(n.tag, walkCeiling) <= 0 &&
						!verifyPasses(n, { root, out, env, verifyTimeoutMs }),
				)
			: [];
	if (probed.length > 0)
		out(
			`no walkedTo recorded and the pin ${lowerBound} claims ` +
				`${probed.map((n) => n.tag).join(", ")} applied, but their Verify ` +
				"fails here — applying them",
		);
	return probed;
}

/**
 * @param {string} pluginRoot
 * @param {string} installed
 * @param {(line: string) => void} out
 */
function reportDirectoryFloor(pluginRoot, installed, out) {
	const flooredPast = loadNotes(pluginRoot).filter(
		(n) => semverCompare(n.tag, installed) <= 0,
	);
	if (flooredPast.length > 0)
		out(
			`first sight of this directory-sourced install: floored at ${installed}, ` +
				`treating ${flooredPast.map((n) => n.tag).join(", ")} as already ` +
				"applied — read them by hand if this tree predates them",
		);
}

/** @param {string} root @param {string} tag */
function advanceWalkedTo(root, tag) {
	const { path: at, json: current } = readJson(root, CONFIG_PATH);
	const recorded = /** @type {{walkedTo?: unknown}} */ (current).walkedTo;
	if (typeof recorded === "string" && semverCompare(tag, recorded) <= 0) return;
	fs.writeFileSync(at, formatConfigJson({ ...current, walkedTo: tag }));
}

/**
 * @param {string|null} walkCeiling
 * @param {{root: string, dryRun: boolean, out: (line: string) => void}} at
 * @returns {{status: 0}}
 */
function finishWithoutNotes(walkCeiling, { root, dryRun, out }) {
	if (walkCeiling === null) {
		out("nothing verified");
		return { status: 0 };
	}
	if (!dryRun) advanceWalkedTo(root, walkCeiling);
	out(`up to date at ${walkCeiling}`);
	return { status: 0 };
}

/**
 * @param {{tag: string, file: string, text: string}} note
 * @param {{optional: boolean, root: string, dryRun: boolean,
 *   out: (line: string) => void, env?: NodeJS.ProcessEnv,
 *   verifyTimeoutMs?: number}} at
 * @returns {{status: 1, reason: string} | null}
 */
function walkNote(note, { optional, root, dryRun, out, env, verifyTimeoutMs }) {
	const parsed = parseNote(note.text);
	if (parsed.faults.length > 0) {
		if (!optional)
			return {
				status: 1,
				reason: `${note.file} is malformed:\n  ${parsed.faults.join("\n  ")}`,
			};
		out(
			`skipping ${note.tag} — it is malformed:\n  ${parsed.faults.join("\n  ")}`,
		);
		return null;
	}
	out(`applying ${note.tag}`);
	if (!dryRun) applyResidue(parsed.residue ?? {}, { root, out });
	const steps = parsed.sections["Manual steps"]
		? parseSteps(parsed.sections["Manual steps"])
		: [];
	if (steps.length > 0) {
		out(`manual steps for ${note.tag}:\n${parsed.sections["Manual steps"]}`);
	}
	if (dryRun) return null;
	const result = runVerify(/** @type {string} */ (parsed.verify), {
		cwd: root,
		env,
		timeout: verifyTimeoutMs,
	});
	if (!result.ok) {
		if (!optional)
			return {
				status: 1,
				reason: `${note.tag} Verify failed (\`${parsed.verify}\`)${result.suffix}:\n${result.said}`,
			};
		out(
			`${note.tag} was applied but its Verify still fails${result.suffix} — stepping over it:\n${result.said}`,
		);
		return null;
	}
	out(`verified ${note.tag}`);
	if (steps.length > 0) recordStepsOwed(root, note.tag, steps, out);
	if (!optional) advanceWalkedTo(root, note.tag);
	return null;
}

/**
 * @param {string} root
 * @param {string} tag
 * @param {ReturnType<typeof parseSteps>} steps
 * @param {(line: string) => void} out
 */
function recordStepsOwed(root, tag, steps, out) {
	appendStepsOwed(root, tag, steps);
	out("");
	out(
		`commit message body for ${tag} — paste verbatim (the permanent ` +
			"record that survives stepsOwed being cleared):",
	);
	for (const s of steps) out(`- [${s.type}] (${tag}) ${s.text}`);
}

module.exports = { upgrade };
