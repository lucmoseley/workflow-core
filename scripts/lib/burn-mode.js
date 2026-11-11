/*
 * burn-mode.js — burn mode's state: the one resolver for its marker, and what
 * the switch left on the machine. Which model each layer moves to is
 * lib/model-table.js's.
 *
 * The state is one marker file per MACHINE, beside the settings files it is
 * the record for. `on` writes the model it found into it, so `off` restores
 * what was there rather than assuming the standing default (mantahostels#130).
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { caught } = require("./caught.js");
const { machineMarkerPath } = require("./machine-marker.js");
const { mapSessionModel, SESSION_DEFAULT } = require("./model-table.js");
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
 * unset or relative) reads as off, as the dispatch remap's does (#4992).
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
 * The plans' settings files, one entry per real file (#187), as the founder
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
 * The plans' models `on` found, by real settings path, from the marker; {} for
 * a marker holding no record or one that will not parse.
 * @param {string} marker
 * @returns {Record<string, string>}
 */
function readRecord(marker) {
	try {
		const model = JSON.parse(fs.readFileSync(marker, "utf8"))?.model;
		return model && typeof model === "object" ? model : {};
	} catch {
		return {};
	}
}

/**
 * Whether one plan's session model disagrees with the switch: on, a model
 * other than the burn layer's target for what `on` found there (the model it
 * holds, where the marker records none); off, the model `on` moves the default
 * to. A file that will not parse disagrees with both.
 * @param {string} file the real settings path
 * @param {boolean} on
 * @param {Record<string, string>} record the marker's record of each plan's prior model
 */
function isPlanDisagreeing(file, on, record) {
	let model;
	try {
		model = trimmed(JSON.parse(fs.readFileSync(file, "utf8"))?.model);
	} catch {
		// #3877: the script's own jq fails on this file too, so it is no plan in step.
		return true;
	}
	const session = model || SESSION_DEFAULT;
	if (!on) return session === mapSessionModel("", true);
	const basis = Object.hasOwn(record, file) ? record[file] : model;
	return session !== mapSessionModel(basis, true);
}

/**
 * Burn mode as the script left it, read off the machine so every reader sees a
 * half-flip however long ago it happened. `on` is null, with `error`, where the
 * marker cannot be placed or the plans cannot be listed.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{on: boolean|null, disagreeing: string[], error: string|null}}
 */
function readBurnState(env = process.env) {
	try {
		const marker = markerPath(env);
		const on = fs.existsSync(marker);
		const record = on ? readRecord(marker) : {};
		const disagreeing = [...readPlanFiles(env.HOME ?? "").files]
			.filter(([file]) => isPlanDisagreeing(file, on, record))
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
 *
 * stdout is always a pipe here, so it is written synchronously before the
 * exit — process.stdout.write can be cut off by process.exit on a pipe.
 */
if (require.main === module) {
	try {
		const { values, positionals } = parseArgs({
			allowPositionals: true,
			strict: true,
			options: { quiet: { type: "boolean" } },
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
		process.exit(2);
	} catch {
		process.exit(2);
	}
}
