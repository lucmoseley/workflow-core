/*
 * burn-mode.js — burn mode's state: the one resolver for its marker, and what
 * the switch left on the machine. What each mode writes is the routing file's,
 * through lib/model-table.js's modeSettings.
 *
 * The state is one marker file per MACHINE, beside the settings files it
 * governs. Its presence is the state.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { caught } = require("./caught.js");
const { machineMarkerPath } = require("./machine-marker.js");
const { modeSettings } = require("./model-table.js");
const { readPlanDirs } = require("./plan-dirs.js");
const { trimmed } = require("./trimmed.js");
const { writeFd } = require("./write-fd.js");

/** The marker file's name, under `~/.claude`. */
const MARKER = ".burn-mode";

/**
 * Where the marker lives. `WFC_BURN_MARKER` overrides, so a test never
 * touches the machine's real switch; otherwise `~/.claude/.burn-mode`.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 * @throws as lib/machine-marker.js's machineMarkerPath
 */
function markerPath(env = process.env) {
	return env.WFC_BURN_MARKER || machineMarkerPath(MARKER, env);
}

/**
 * Whether burn mode's marker exists now. A marker that cannot be placed (HOME
 * unset or relative) reads as off, as the dispatch remap's does (workflow-core#4992).
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
function isBurnMarkerOn(env) {
	try {
		return fs.existsSync(markerPath(env));
	} catch {
		return false;
	}
}

/**
 * The plans' settings files, one entry per real file (workflow-core#187), as the founder
 * names them, and those present that resolve to nothing, skipped: a dangling
 * or looping symlink, or one that will not read.
 * @param {string} home
 * @returns {{files: Map<string, string>, dangling: string[]}} `files`, real path to name
 */
function readPlanFiles(home) {
	const homeReal = fs.realpathSync(home);
	/** @type {Map<string, string>} */
	const files = new Map();
	/** @type {string[]} */
	const dangling = [];
	for (const dir of readPlanDirs(home)) {
		const file = path.join(dir, "settings.json");
		try {
			const real = fs.realpathSync(file);
			files.set(real, path.relative(homeReal, real));
		} catch {
			if (isPresent(file)) dangling.push(file);
		}
	}
	return { files, dangling };
}

/** @param {string} file */
function isPresent(file) {
	try {
		fs.lstatSync(file);
		return true;
	} catch {
		return false;
	}
}

/**
 * How one plan's settings depart from a mode's writes: its `model`, and each
 * `modelSettings` effort the mode writes; one fault where the file will not
 * parse (workflow-core#3877), since the script's own jq fails on it too.
 * @param {string} file the real settings path
 * @param {boolean} burn which mode to judge by
 * @returns {{model: string, faults: string[]}} the model it holds, "" for none
 */
function readPlanFaults(file, burn) {
	const want = modeSettings(burn);
	const mode = burn ? "burn" : "standard";
	let settings;
	try {
		settings = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return { model: "", faults: ["settings will not parse"] };
	}
	const model = trimmed(settings?.model);
	/** @type {string[]} */
	const faults = [];
	if (model !== want.model) faults.push(`not the ${mode} model, ${want.model}`);
	for (const [id, { effortLevel }] of Object.entries(want.modelSettings)) {
		const has = settings?.modelSettings?.[id]?.effortLevel;
		if (has !== effortLevel)
			faults.push(
				`${id} effortLevel=${has ?? "absent"}, not the ${mode} effort, ${effortLevel}`,
			);
	}
	return { model, faults };
}

/**
 * Burn mode as the script left it, read off the machine so every reader sees a
 * half-flip however long ago it happened: a plan disagrees where it departs
 * from the current mode's writes. `on` is null, with `error`, where the marker
 * cannot be placed, the plans cannot be listed or the routing file will not
 * load.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{on: boolean|null, disagreeing: string[], error: string|null}}
 */
function readBurnState(env = process.env) {
	try {
		const on = fs.existsSync(markerPath(env));
		const disagreeing = [...readPlanFiles(env.HOME ?? "").files]
			.filter(([file]) => readPlanFaults(file, on).faults.length > 0)
			.map(([, name]) => name);
		return { on, disagreeing, error: null };
	} catch (err) {
		return { on: null, disagreeing: [], error: caught(err).message };
	}
}

module.exports = {
	isBurnMarkerOn,
	markerPath,
	readBurnState,
};

/*
 * CLI mode.
 *
 *   marker            prints the marker's path; 2 where HOME is unset
 *   plans [--quiet]   prints each plan's settings file, real and NUL-ended,
 *                     warning of each that resolves to nothing unless quiet;
 *                     2 where HOME will not list
 *   report [--burn]   prints each plan with its model and how it departs from
 *                     the mode's writes; 1 where any departs, 2 where the
 *                     plans will not list or the routing file will not load
 *
 * stdout is always a pipe here, so it is written synchronously before the
 * exit — process.stdout.write can be cut off by process.exit on a pipe.
 */
if (require.main === module) {
	try {
		const { values, positionals } = parseArgs({
			allowPositionals: true,
			strict: true,
			options: { quiet: { type: "boolean" }, burn: { type: "boolean" } },
		});
		const [mode] = positionals;
		if (mode === "marker") {
			writeFd(1, `${markerPath()}\n`);
			process.exit(0);
		}
		if (mode === "plans") {
			const home = process.env.HOME ?? "";
			let listed;
			try {
				listed = readPlanFiles(home);
			} catch (err) {
				writeFd(
					2,
					`burn-mode: cannot list the plans under ${home}: ${caught(err).message}\n`,
				);
				process.exit(2);
			}
			const { files, dangling } = listed;
			for (const file of values.quiet ? [] : dangling)
				writeFd(
					2,
					`warning: skipping ${path.relative(home, file)} — it resolves to nothing\n`,
				);
			writeFd(1, [...files.keys()].map((f) => `${f}\0`).join(""));
			process.exit(0);
		}
		if (mode === "report") {
			let rows;
			try {
				rows = [...readPlanFiles(process.env.HOME ?? "").files].map(
					([file, name]) => ({
						name,
						...readPlanFaults(file, values.burn === true),
					}),
				);
			} catch (err) {
				writeFd(2, `burn-mode: ${caught(err).message}\n`);
				process.exit(2);
			}
			const width = Math.max(0, ...rows.map((r) => r.name.length));
			for (const { name, model, faults } of rows)
				writeFd(
					1,
					`  ${name.padEnd(width)} model=${model || "absent"}${faults.map((f) => `  (${f})`).join("")}\n`,
				);
			process.exit(rows.some((r) => r.faults.length > 0) ? 1 : 0);
		}
		process.exit(2);
	} catch {
		process.exit(2);
	}
}
